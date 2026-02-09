/**
 * Request Proxy Service - State Machine Implementation
 *
 * Creates a Unix socket server on the GPG agent socket path.
 * Implements a 4-state machine to handle GPG Assuan protocol:
 *   DISCONNECTED -> SEND_COMMAND -> WAIT_RESPONSE -> [back to SEND_COMMAND or to INQUIRE_DATA]
 *   INQUIRE_DATA -> WAIT_RESPONSE -> [back to SEND_COMMAND]
 *
 * Each client connection manages its own state machine using sessionId.
 * Commands are sent to agent-proxy extension via VS Code commands.
 */

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { log, encodeProtocolData, decodeProtocolData, sanitizeForLog, extractErrorMessage, extractNextCommand, determineNextState } from '@gpg-relay/shared';
import type { LogConfig, ICommandExecutor, IFileSystem, IServerFactory } from '@gpg-relay/shared';
import { VSCodeCommandExecutor } from './commandExecutor';

export interface RequestProxyConfig extends LogConfig {
}

export interface RequestProxyDeps {
    commandExecutor?: ICommandExecutor;
    serverFactory?: IServerFactory;
    fileSystem?: IFileSystem;
    getSocketPath?: () => Promise<string | null>;  // Mockable socket path resolution
}

export interface RequestProxyInstance {
    stop(): Promise<void>;
}

// Client session state
type ClientState = 'DISCONNECTED' | 'SEND_COMMAND' | 'WAIT_RESPONSE' | 'INQUIRE_DATA';

interface ClientSession {
    socket: net.Socket;
    sessionId: string | null;
    state: ClientState;
    buffer: string;
}

/**
 * Start the Request Proxy
 */
export async function startRequestProxy(config: RequestProxyConfig, deps?: RequestProxyDeps): Promise<RequestProxyInstance> {
    // Initialize dependencies with defaults (backward compatible)
    const commandExecutor = deps?.commandExecutor ?? new VSCodeCommandExecutor();
    const serverFactory = deps?.serverFactory ?? { createServer: net.createServer };
    const fileSystem = deps?.fileSystem ?? { existsSync: fs.existsSync, mkdirSync: fs.mkdirSync, chmodSync: fs.chmodSync, unlinkSync: fs.unlinkSync };
    const getSocketPath = deps?.getSocketPath ?? getLocalGpgSocketPath;
    const usingMocks = !!(deps?.commandExecutor || deps?.serverFactory || deps?.fileSystem);

    log(config, `[startRequestProxy] using mocked deps: ${usingMocks}`);
    const socketPath = await getSocketPath();
    if (!socketPath) {
        throw new Error('Could not determine local GPG socket path. Is gpg installed? Try: gpgconf --list-dirs');
    }

    // Ensure parent directory exists
    log(config, `Creating socket server at ${socketPath}`);
    const socketDir = path.dirname(socketPath);
    if (!fileSystem.existsSync(socketDir)) {
        fileSystem.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
    }

    // Create the Unix socket server
    const server = serverFactory.createServer({ pauseOnConnect: true }, (clientSocket) => {
        const clientSession: ClientSession = {
            socket: clientSocket,
            sessionId: null,
            state: 'DISCONNECTED',
            buffer: '',
        };

        // 'close' fires when the socket is fully closed and resources are released
        // hadError arg indicates if it closed because of an error
        // event sequences:
        // - OS error: 'error' -> 'close'
        // - graceful remote shutdown: 'end' -> 'close'
        // - local shutdown: socket.end() -> 'close'
        // - local destroy without arg: socket.destroy() -> 'close'
        clientSocket.on('close', () => {
            log(config, `[${clientSession.sessionId ?? 'pending'}] Client socket closed`);
            disconnectAgent(config, commandExecutor, clientSession);
        });

        // 'error' fires when the OS reports a failure (ECONNRESET, EPIPE, etc.)
        // or when the err arg of destroy() is used
        // node does not automatically destroy the socket on 'error' event
        // event sequences:
        // - OS error: 'error' -> 'close'
        // - local destroy with arg `socket.destroy(err)`: 'error' -> 'close'
        clientSocket.on('error', (err: Error) => {
            log(config, `[${clientSession.sessionId ?? 'pending'}] Client socket error: ${err.message}`);
        });

        // Log when socket becomes readable/writable
        clientSocket.on('readable', () => {
            let chunk: Buffer | null;
            while ((chunk = clientSocket.read()) !== null) {
                handleClientData(config, commandExecutor, clientSession, chunk).catch((err) => {
                    const msg = extractErrorMessage(err);
                    log(config, `[${clientSession.sessionId ?? 'pending'}] Error proxying client <-> agent: ${msg}`);
                    try {
                        clientSession.socket.destroy();
                    } catch (err) {
                        // Ignore
                    }
                });
            }
        });

        // Connect to gpg-agent-proxy, this runs async with no await so that we can handle client socket events while waiting for connection
        log(config, 'Client connected to socket. Socket is paused while initiating connection to GPG Agent Proxy');
        connectToAgent(config, commandExecutor, clientSession).then(() => {
            // Resume after greeting is sent, could be a race condition since Socket::write() completes asynchronously
            clientSocket.resume();
        }).catch(() => {
            try {
                clientSocket.destroy();
            } catch (err) {
                // Ignore
            }
        });
    });

    // Handle server errors, only logging for now
    server.on('error', (err: Error) => {
        log(config, `Socket server error: ${err.message}`);
    });

    return new Promise((resolve, reject) => {
        server.listen(socketPath, () => {
            // Make socket readable/writable by all users
            try {
                fileSystem.chmodSync(socketPath, 0o666);
            } catch (err) {
                log(config, `Warning: could not chmod socket: ${err}`);
            }

            log(config, 'Request proxy listening');

            resolve({
                stop: async () => {
                    return new Promise((stopResolve) => {
                        server.close(() => {
                            try {
                                fileSystem.unlinkSync(socketPath);
                            } catch (err) {
                                // Ignore
                            }
                            log(config, 'Request proxy stopped');
                            stopResolve();
                        });
                    });
                }
            });
        });

        server.on('error', reject);
    });
}

function writeToClient(config: RequestProxyConfig, session: ClientSession, data: string, successMessage: string): boolean {
    // latin1 preserves raw bytes
    const buffer = encodeProtocolData(data);
    return session.socket.write(buffer, (err) => {
        if (err) {
            // BUGBUG should I cleanup session (disconnects agent) and destroying socket?
            log(config, `[${session.sessionId}] Error writing to client socket: ${err.message}`);
        } else {
            log(config, `[${session.sessionId}] ${successMessage}`);
        }
    });
}

/**
 * Connect to agent-proxy via VS Code command
 */
async function connectToAgent(config: RequestProxyConfig, commandExecutor: ICommandExecutor, session: ClientSession): Promise<void> {
    log(config, `[${session.sessionId ?? 'pending'}] Connecting to GPG Agent Proxy via command...`);
    try {
        // Call connectAgent command through executor
        const result = await commandExecutor.connectAgent();
        session.sessionId = result.sessionId;
        session.state = 'SEND_COMMAND';
        log(config, `[${session.sessionId}] Connected to GPG Agent Proxy`);

        // Send greeting from agent to client unchanged
        if (result.greeting) {
            writeToClient(config, session, result.greeting, 'Ready for client data');
        } else {
            log(config, `[${session.sessionId}] Warning: greeting is undefined`);
        }
    } catch (err) {
        const msg = extractErrorMessage(err);
        log(config, `Failed connect to GPG Agent Proxy: ${msg}`);
        throw err;
    }
}

/**
 * Handle incoming data from client
 *
 * Implements the state machine:
 * SEND_COMMAND: Read until complete command line
 * WAIT_RESPONSE: Handled by sendCommands promise
 * INQUIRE_DATA: Read D lines until END
 */
async function handleClientData(config: RequestProxyConfig, commandExecutor: ICommandExecutor, session: ClientSession, chunk: Buffer): Promise<void> {
    log(config, `[${session.sessionId}] Received ${chunk.length} bytes from client`);

    // Use latin1 to preserve raw bytes, add to buffer
    session.buffer += decodeProtocolData(chunk);

    // Process buffer based on state
    let data: string | null = null;
    if (session.state === 'SEND_COMMAND') {
        // Look for newline to delimit one complete command
        const newlineIndex = session.buffer.indexOf('\n');
        if (newlineIndex === -1) {
            return; // Wait for more data
        }

        // Extract one command and newline, keep the rest in buffer
        data = session.buffer.substring(0, newlineIndex + 1);
        session.buffer = session.buffer.substring(newlineIndex + 1);
    } else if (session.state === 'INQUIRE_DATA') {
        // Look for D lines followed by END
        const endIndex = session.buffer.indexOf('END\n');
        if (endIndex === -1) {
            return; // Wait for more data
        }

        // Extract D block (including END\n), keep the rest in buffer
        data = session.buffer.substring(0, endIndex + 4);
        session.buffer = session.buffer.substring(endIndex + 4);
    }
    else {
        // invalid state
        throw new Error(`Invalid state ${session.state} when receiving client data`);
    }

    // Send command to gpg-agent-proxy and wait for response
    await waitResponse(config, commandExecutor, session, data);
}

async function waitResponse(config: RequestProxyConfig, commandExecutor: ICommandExecutor, session: ClientSession, data: string): Promise<void> {
    log(config, `[${session.sessionId}] Proxying client -> agent: ${sanitizeForLog(data)}`);
    session.state = 'WAIT_RESPONSE';
    const result = await commandExecutor.sendCommands(session.sessionId!, data);

    const response = result.response;
    writeToClient(config, session, response, `Proxying client <- agent: ${sanitizeForLog(response)}`);

    // Check if response contains another INQUIRE (must be at start of line per Assuan protocol)
    if (/(^|\n)INQUIRE/.test(response)) {
        session.state = 'INQUIRE_DATA';
        log(config, `[${session.sessionId}] Entering INQUIRE_DATA state`);
    } else {
        // Back to SEND_COMMAND for next command
        session.state = 'SEND_COMMAND';
        // Process any buffered data
        if (session.buffer.length > 0) {
            handleClientData(config, commandExecutor, session, Buffer.from(session.buffer));
        }
    }
}

/**
 * Disconnect the agent using command and remove session id+state
 */
async function disconnectAgent(config: RequestProxyConfig, commandExecutor: ICommandExecutor, session: ClientSession): Promise<void> {
    if (!session.sessionId) {
        return;
    }

    const sessionId = session.sessionId;
    log(config, `[${sessionId}] Disconnecting from GPG Agent Proxy...`);
    try {
        // Call disconnectAgent to clean up server-side session
        await commandExecutor.disconnectAgent(sessionId);
        log(config, `[${sessionId}] Disconnected from GPG Agent Proxy`);
    } catch (err) {
        const msg = extractErrorMessage(err);
        log(config, `[${sessionId}] Disconnect from GPG Agent Proxy failed: ${msg}`);
    }

    // Clear session members except socket which is destroyed elsewhere
    session.sessionId = null;
    session.state = 'DISCONNECTED';
    session.buffer = '';
}

/**
 * Get the local GPG socket path by querying gpgconf
 * Calls gpgconf twice to get agent-socket and agent-extra-socket separately,
 * removes both if they exist, and returns the socket path to use.
 */
async function getLocalGpgSocketPath(): Promise<string | null> {
    return new Promise((resolve) => {
        try {
            // Query each socket separately to avoid parsing issues with URL-encoded colons
            const agentSocketResult = spawnSync('gpgconf', ['--list-dirs', 'agent-socket'], {
                encoding: 'utf-8',
                timeout: 5000
            });

            const agentExtraSocketResult = spawnSync('gpgconf', ['--list-dirs', 'agent-extra-socket'], {
                encoding: 'utf-8',
                timeout: 5000
            });

            const agentSocketPath = agentSocketResult.status === 0 ? (agentSocketResult.stdout.trim() || null) : null;
            const agentExtraSocketPath = agentExtraSocketResult.status === 0 ? (agentExtraSocketResult.stdout.trim() || null) : null;

            // Remove both sockets if they exist
            const socketsToRemove = [agentSocketPath, agentExtraSocketPath].filter((p) => p !== null);
            for (const socketPath of socketsToRemove) {
                if (fs.existsSync(socketPath)) {
                    try {
                        fs.unlinkSync(socketPath);
                    } catch (err) {
                        // Ignore - socket may be in use
                    }
                }
            }

            // Return standard socket
            resolve(agentSocketPath);
        } catch (err) {
            resolve(null);
        }
    });
}
