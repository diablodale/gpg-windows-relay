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
import * as vscode from 'vscode';
import { spawnSync } from 'child_process';

export interface RequestProxyConfig {
    logCallback?: (message: string) => void;
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
    commandBlock: string;
}

/**
 * Start the Request Proxy
 */
export async function startRequestProxy(config: RequestProxyConfig): Promise<RequestProxyInstance> {
    const socketPath = await getLocalGpgSocketPath();
    if (!socketPath) {
        throw new Error(
            'Could not determine local GPG socket path. ' +
            'Is gpg installed? Try: gpgconf --list-dirs'
        );
    }

    log(config, `Creating Unix socket server at: ${socketPath}`);

    // Ensure parent directory exists
    const socketDir = path.dirname(socketPath);
    if (!fs.existsSync(socketDir)) {
        fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
    }

    // Create the Unix socket server
    const server = net.createServer({ pauseOnConnect: true }, (clientSocket) => {
        const clientSession: ClientSession = {
            socket: clientSocket,
            sessionId: null,
            state: 'DISCONNECTED',
            buffer: '',
            commandBlock: ''
        };

        log(config, `Client connected, initiating connection to agent-proxy`);
        log(config, `Client socket paused on connect`);

        // Handle client disconnect
        clientSocket.on('end', () => {
            log(config, `Client disconnected, closing session`);
            cleanupSession(config, clientSession);
        });

        clientSocket.on('error', (err: Error) => {
            log(config, `Client socket error: ${err.message}`);
            cleanupSession(config, clientSession);
        });

        // Log when socket becomes readable/writable
        clientSocket.on('readable', () => {
            log(config, `[${clientSession.sessionId}] Client socket readable`);
            let chunk: Buffer | null;
            while ((chunk = clientSocket.read()) !== null) {
                log(config, `[${clientSession.sessionId}] Readable chunk size: ${chunk.length}`);
                handleClientData(config, clientSession, chunk).catch((err) => {
                    log(config, `[${clientSession.sessionId}] Error handling client data: ${err instanceof Error ? err.message : String(err)}`);
                    cleanupSession(config, clientSession).catch(() => {});
                    try {
                        clientSession.socket.destroy();
                    } catch (destroyErr) {
                        // Ignore
                    }
                });
            }
        });

        clientSocket.on('writable', () => {
            log(config, `[${clientSession.sessionId}] Client socket writable`);
        });

        // Start by connecting to agent-proxy
        connectToAgent(config, clientSession).then(() => {
            // Resume after greeting is sent
            log(config, `[${clientSession.sessionId}] Ready for data, resuming socket`);
            clientSocket.resume();
        }).catch((err) => {
            log(config, `[${clientSession.sessionId}] Async connect error: ${err instanceof Error ? err.message : String(err)}`);
            try {
                clientSession.socket.destroy();
            } catch (destroyErr) {
                // Ignore
            }
        });
    });

    server.on('error', (err: Error) => {
        log(config, `Server error: ${err.message}`);
    });

    return new Promise((resolve, reject) => {
        server.listen(socketPath, () => {
            // Make socket readable/writable by all users
            try {
                fs.chmodSync(socketPath, 0o666);
            } catch (err) {
                log(config, `Warning: could not chmod socket: ${err}`);
            }

            log(config, `Request proxy listening on ${socketPath}`);

            resolve({
                stop: async () => {
                    return new Promise((stopResolve) => {
                        server.close(() => {
                            try {
                                fs.unlinkSync(socketPath);
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

/**
 * Connect to agent-proxy via VS Code command
 */
async function connectToAgent(config: RequestProxyConfig, session: ClientSession): Promise<void> {
    try {
        // Call connectAgent command
        const result = await vscode.commands.executeCommand('_gpg-agent-proxy.connectAgent') as { sessionId: string; greeting: string };
        log(config, `[${session.sessionId}] Result from connectAgent: ${JSON.stringify(result)}`);
        session.sessionId = result.sessionId;
        session.state = 'SEND_COMMAND';
        log(config, `[${session.sessionId}] Connected to agent-proxy`);
        log(config, `[${session.sessionId}] Greeting value: ${JSON.stringify(result.greeting)}`);

        // Send greeting from agent to client unchanged
        if (result.greeting) {
            log(config, `[${session.sessionId}] About to write greeting, socket writable: ${session.socket.writable}`);
            session.socket.write(result.greeting, (err) => {
                if (err) {
                    log(config, `[${session.sessionId}] Error writing greeting: ${err.message}`);
                } else {
                    log(config, `[${session.sessionId}] Greeting write confirmed`);
                }
            });
            log(config, `[${session.sessionId}] Sent greeting to client`);
        } else {
            log(config, `[${session.sessionId}] Warning: greeting is undefined`);
        }
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log(config, `Failed to connect to agent-proxy: ${msg}`);
        // Close client socket immediately
        try {
            session.socket.destroy();
        } catch (destroyErr) {
            // Ignore
        }
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
async function handleClientData(config: RequestProxyConfig, session: ClientSession, chunk: Buffer): Promise<void> {
    const chunkStr = chunk.toString('utf-8');
    log(config, `[${session.sessionId}] Received ${chunk.length} bytes in state ${session.state}: ${chunkStr.replace(/\n/g, '\\n')}`);

    session.buffer += chunkStr;

    if (session.state === 'SEND_COMMAND') {
        // Look for complete command line (ends with \n)
        const newlineIndex = session.buffer.indexOf('\n');
        if (newlineIndex === -1) {
            return; // Wait for more data
        }

        // Extract command
        const command = session.buffer.substring(0, newlineIndex + 1);
        session.buffer = session.buffer.substring(newlineIndex + 1);
        session.commandBlock = command;

        log(config, `[${session.sessionId}] Command: ${command.trim()}`);

        // Send command to agent-proxy
        session.state = 'WAIT_RESPONSE';
        try {
            const result = await vscode.commands.executeCommand(
                '_gpg-agent-proxy.sendCommands',
                session.sessionId,
                command
            ) as { response: string };

            const response = result.response;
            log(config, `[${session.sessionId}] Response: ${response.replace(/\n/g, '\\n')}`);

            // Send response to client (latin1 preserves raw bytes)
            session.socket.write(Buffer.from(response, 'latin1'));

            // Check if response contains INQUIRE
            if (response.includes('INQUIRE')) {
                session.state = 'INQUIRE_DATA';
                log(config, `[${session.sessionId}] Entering INQUIRE_DATA state`);
            } else {
                // Back to SEND_COMMAND for next command
                session.state = 'SEND_COMMAND';
                // Process any buffered data
                if (session.buffer.length > 0) {
                    handleClientData(config, session, Buffer.from(session.buffer));
                }
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            // Only log and cleanup if session is still valid
            if (session.sessionId) {
                log(config, `[${session.sessionId}] Error sending command: ${msg}`);
                // Cleanup session (disconnects agent) before destroying socket
                await cleanupSession(config, session);
            }
            try {
                session.socket.destroy();
            } catch (destroyErr) {
                // Ignore
            }
        }
    } else if (session.state === 'INQUIRE_DATA') {
        // Look for D lines followed by END
        const endIndex = session.buffer.indexOf('END\n');
        if (endIndex === -1) {
            return; // Wait for more data
        }

        // Extract D block (including END\n)
        const dataBlock = session.buffer.substring(0, endIndex + 4);
        session.buffer = session.buffer.substring(endIndex + 4);

        log(config, `[${session.sessionId}] Data block: ${dataBlock.replace(/\n/g, '\\n')}`);

        // Send D block to agent-proxy
        session.state = 'WAIT_RESPONSE';
        try {
            const result = await vscode.commands.executeCommand(
                '_gpg-agent-proxy.sendCommands',
                session.sessionId,
                dataBlock
            ) as { response: string };

            const response = result.response;
            log(config, `[${session.sessionId}] Response: ${response.replace(/\n/g, '\\n')}`);

            // Send response to client (latin1 preserves raw bytes)
            session.socket.write(Buffer.from(response, 'latin1'));

            // Check if response contains another INQUIRE
            if (response.includes('INQUIRE')) {
                session.state = 'INQUIRE_DATA';
                log(config, `[${session.sessionId}] Continuing in INQUIRE_DATA state`);
            } else {
                // Back to SEND_COMMAND for next command
                session.state = 'SEND_COMMAND';
                // Process any buffered data
                if (session.buffer.length > 0) {
                    handleClientData(config, session, Buffer.from(session.buffer));
                }
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            log(config, `[${session.sessionId}] Error sending data block: ${msg}`);
            // Cleanup session (disconnects agent) before destroying socket
            await cleanupSession(config, session);
            try {
                session.socket.destroy();
            } catch (destroyErr) {
                // Ignore
            }
        }
    }
}

/**
 * Clean up session
 */
async function cleanupSession(config: RequestProxyConfig, session: ClientSession): Promise<void> {
    if (!session.sessionId) {
        return;
    }

    const sessionId = session.sessionId;

    try {
        // Call disconnectAgent to clean up server-side session
        await vscode.commands.executeCommand('_gpg-agent-proxy.disconnectAgent', sessionId);
        log(config, `[${sessionId}] Session cleaned up`);
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log(config, `[${sessionId}] Error cleaning up: ${msg}`);
        // Continue even if cleanup fails - session will be cleaned on error handlers
    }

    // Clear session reference
    session.sessionId = null;
    session.state = 'DISCONNECTED';
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

/**
 * Log helper
 */
function log(config: RequestProxyConfig, message: string): void {
    if (config.logCallback) {
        config.logCallback(message);
    }
}
