/**
 * Request Proxy Service - State Machine Implementation
 *
 * Creates a Unix socket server on the GPG agent socket path.
 * Implements a 12-state finite state machine to handle GPG Assuan protocol:
 *   DISCONNECTED → CLIENT_CONNECTED → AGENT_CONNECTING → READY
 *   READY ↔ BUFFERING_COMMAND ↔ DATA_READY ↔ SENDING_TO_AGENT ↔ WAITING_FOR_AGENT ↔ SENDING_TO_CLIENT
 *   READY ↔ BUFFERING_INQUIRE ↔ DATA_READY
 *   Any state → ERROR → CLOSING → DISCONNECTED or FATAL
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

// ============================================================================
// State Machine Type Definitions (Phase 1)
// ============================================================================

/**
 * Client session states (12 total)
 */
type ClientState =
  | 'DISCONNECTED'
  | 'CLIENT_CONNECTED'
  | 'AGENT_CONNECTING'
  | 'READY'
  | 'BUFFERING_COMMAND'
  | 'BUFFERING_INQUIRE'
  | 'DATA_READY'
  | 'SENDING_TO_AGENT'
  | 'WAITING_FOR_AGENT'
  | 'SENDING_TO_CLIENT'
  | 'ERROR'
  | 'CLOSING'
  | 'FATAL';

/**
 * State machine events (21 total)
 */
type StateEvent =
  | { type: 'CLIENT_SOCKET_CONNECTED' }
  | { type: 'START_AGENT_CONNECT' }
  | { type: 'AGENT_GREETING_OK'; greeting: string }
  | { type: 'AGENT_CONNECT_ERROR'; error: string }
  | { type: 'CLIENT_DATA_START'; data: Buffer }
  | { type: 'CLIENT_DATA_PARTIAL'; data: Buffer }
  | { type: 'COMMAND_COMPLETE'; command: string }
  | { type: 'INQUIRE_DATA_PARTIAL'; data: Buffer }
  | { type: 'INQUIRE_COMPLETE'; inquireDataBlock: string }
  | { type: 'BUFFER_ERROR'; error: string }
  | { type: 'DISPATCH_DATA'; data: string }
  | { type: 'WRITE_OK' }
  | { type: 'WRITE_ERROR'; error: string }
  | { type: 'AGENT_RESPONSE_COMPLETE'; response: string }
  | { type: 'AGENT_TIMEOUT' }
  | { type: 'AGENT_SOCKET_ERROR'; error: string }
  | { type: 'CLIENT_DATA_DURING_WAIT'; data: Buffer }
  | { type: 'RESPONSE_OK_OR_ERR'; response: string }
  | { type: 'RESPONSE_INQUIRE'; response: string }
  | { type: 'CLEANUP_START' }
  | { type: 'CLEANUP_COMPLETE' }
  | { type: 'CLEANUP_ERROR'; error: string };

/**
 * State handler function type
 */
type StateHandler = (config: RequestProxyConfig, commandExecutor: ICommandExecutor, session: ClientSession, event: StateEvent) => Promise<ClientState>;

/**
 * Transition table: (state, event type) → next state
 * Used for validation and routing
 */
const transitionTable: Record<ClientState, Record<string, ClientState>> = {
  DISCONNECTED: {
    'CLIENT_SOCKET_CONNECTED': 'CLIENT_CONNECTED',
  },
  CLIENT_CONNECTED: {
    'START_AGENT_CONNECT': 'AGENT_CONNECTING',
  },
  AGENT_CONNECTING: {
    'AGENT_GREETING_OK': 'READY',
    'AGENT_CONNECT_ERROR': 'ERROR',
  },
  READY: {
    'CLIENT_DATA_START': 'BUFFERING_COMMAND',
  },
  BUFFERING_COMMAND: {
    'CLIENT_DATA_PARTIAL': 'BUFFERING_COMMAND',
    'COMMAND_COMPLETE': 'DATA_READY',
    'BUFFER_ERROR': 'ERROR',
  },
  BUFFERING_INQUIRE: {
    'INQUIRE_DATA_PARTIAL': 'BUFFERING_INQUIRE',
    'INQUIRE_COMPLETE': 'DATA_READY',
    'BUFFER_ERROR': 'ERROR',
  },
  DATA_READY: {
    'DISPATCH_DATA': 'SENDING_TO_AGENT',
  },
  SENDING_TO_AGENT: {
    'WRITE_OK': 'WAITING_FOR_AGENT',
    'WRITE_ERROR': 'ERROR',
  },
  WAITING_FOR_AGENT: {
    'AGENT_RESPONSE_COMPLETE': 'SENDING_TO_CLIENT',
    'AGENT_TIMEOUT': 'ERROR',
    'AGENT_SOCKET_ERROR': 'ERROR',
    'CLIENT_DATA_DURING_WAIT': 'ERROR',
  },
  SENDING_TO_CLIENT: {
    'WRITE_OK': 'READY',
    'WRITE_ERROR': 'ERROR',
    'RESPONSE_OK_OR_ERR': 'READY',
    'RESPONSE_INQUIRE': 'BUFFERING_INQUIRE',
  },
  ERROR: {
    'CLEANUP_START': 'CLOSING',
  },
  CLOSING: {
    'CLEANUP_COMPLETE': 'DISCONNECTED',
    'CLEANUP_ERROR': 'FATAL',
  },
  FATAL: {
    // No transitions out of FATAL
  },
};

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

interface ClientSession {
    socket: net.Socket;
    sessionId: string | null;
    state: ClientState;
    buffer: string;
}

// ============================================================================
// Phase 2: State Handlers
// ============================================================================

/**
 * Handler for DISCONNECTED state
 * No valid events in this state. Stay disconnected until socket reconnects.
 */
async function handleDisconnected(config: RequestProxyConfig, commandExecutor: ICommandExecutor, session: ClientSession, event: StateEvent): Promise<ClientState> {
    log(config, `[${session.sessionId ?? 'pending'}] Received event ${event.type} in DISCONNECTED state (invalid)`);
    return 'DISCONNECTED';
}

/**
 * Handler for CLIENT_CONNECTED state
 * Only accepts CLIENT_SOCKET_CONNECTED event (already handled by server).
 * Transition to AGENT_CONNECTING to start agent connection.
 */
async function handleClientConnected(config: RequestProxyConfig, commandExecutor: ICommandExecutor, session: ClientSession, event: StateEvent): Promise<ClientState> {
    if (event.type === 'CLIENT_SOCKET_CONNECTED') {
        log(config, `[${session.sessionId ?? 'pending'}] Client connected, initiating agent connection...`);
        return 'AGENT_CONNECTING';
    }
    log(config, `[${session.sessionId ?? 'pending'}] Unexpected event ${event.type} in CLIENT_CONNECTED state`);
    return 'ERROR';
}

/**
 * Handler for AGENT_CONNECTING state
 * Processes connection result: success (READY) or error (ERROR).
 * Side effect: Calls connectToAgent() via command executor.
 */
async function handleAgentConnecting(config: RequestProxyConfig, commandExecutor: ICommandExecutor, session: ClientSession, event: StateEvent): Promise<ClientState> {
    if (event.type === 'START_AGENT_CONNECT') {
        // Transition: initiate connection to agent-proxy
        log(config, `[${session.sessionId ?? 'pending'}] Connecting to GPG Agent Proxy...`);
        try {
            const result = await commandExecutor.connectAgent();
            session.sessionId = result.sessionId;
            log(config, `[${session.sessionId}] Connected to GPG Agent Proxy`);

            if (result.greeting) {
                writeToClient(config, session, result.greeting, 'Ready for client data');
            }
            return 'READY';
        } catch (err) {
            const msg = extractErrorMessage(err);
            log(config, `[${session.sessionId}] Failed to connect to GPG Agent Proxy: ${msg}`);
            return 'ERROR';
        }
    }
    return 'ERROR';
}

/**
 * Handler for READY state
 * Accepts CLIENT_DATA_START event and transitions to BUFFERING_COMMAND.
 * Buffers incoming data and checks for complete command.
 */
async function handleReady(config: RequestProxyConfig, commandExecutor: ICommandExecutor, session: ClientSession, event: StateEvent): Promise<ClientState> {
    if (event.type === 'CLIENT_DATA_START') {
        const chunk = (event as any).data as Buffer;
        session.buffer += decodeProtocolData(chunk);
        log(config, `[${session.sessionId}] Received ${chunk.length} bytes, buffer size: ${session.buffer.length}`);

        // Check if complete command (ends with \n)
        const newlineIndex = session.buffer.indexOf('\n');
        if (newlineIndex !== -1) {
            // Command complete, ready to dispatch
            log(config, `[${session.sessionId}] Command complete: ${sanitizeForLog(session.buffer.substring(0, newlineIndex + 1))}`);
            return 'DATA_READY';
        }

        // Command incomplete, continue buffering
        log(config, `[${session.sessionId}] Buffering command...`);
        return 'BUFFERING_COMMAND';
    }
    return 'ERROR';
}

/**
 * Handler for BUFFERING_COMMAND state
 * Continues buffering client data until complete command (\n).
 */
async function handleBufferingCommand(config: RequestProxyConfig, commandExecutor: ICommandExecutor, session: ClientSession, event: StateEvent): Promise<ClientState> {
    if (event.type === 'CLIENT_DATA_PARTIAL') {
        const chunk = (event as any).data as Buffer;
        session.buffer += decodeProtocolData(chunk);
        log(config, `[${session.sessionId}] Buffering command, received ${chunk.length} bytes, total: ${session.buffer.length}`);

        // Check if command is now complete
        const newlineIndex = session.buffer.indexOf('\n');
        if (newlineIndex !== -1) {
            log(config, `[${session.sessionId}] Command complete: ${sanitizeForLog(session.buffer.substring(0, newlineIndex + 1))}`);
            return 'DATA_READY';
        }
        return 'BUFFERING_COMMAND';
    } else if (event.type === 'BUFFER_ERROR') {
        const error = (event as any).error as string;
        log(config, `[${session.sessionId}] Buffer error: ${error}`);
        return 'ERROR';
    }
    return 'ERROR';
}

/**
 * Handler for BUFFERING_INQUIRE state
 * Buffers inquire response data (D lines) until complete (END\n).
 */
async function handleBufferingInquire(config: RequestProxyConfig, commandExecutor: ICommandExecutor, session: ClientSession, event: StateEvent): Promise<ClientState> {
    if (event.type === 'INQUIRE_DATA_PARTIAL') {
        const chunk = (event as any).data as Buffer;
        session.buffer += decodeProtocolData(chunk);
        log(config, `[${session.sessionId}] Buffering inquire data, received ${chunk.length} bytes, total: ${session.buffer.length}`);

        // Check if D-block is complete (ends with END\n)
        const endIndex = session.buffer.indexOf('END\n');
        if (endIndex !== -1) {
            log(config, `[${session.sessionId}] Inquire data complete`);
            return 'DATA_READY';
        }
        return 'BUFFERING_INQUIRE';
    } else if (event.type === 'BUFFER_ERROR') {
        const error = (event as any).error as string;
        log(config, `[${session.sessionId}] Buffer error: ${error}`);
        return 'ERROR';
    }
    return 'ERROR';
}

/**
 * Handler for DATA_READY state
 * Sends buffered command/inquire data to agent-proxy via VS Code command.
 * Processes response and transitions to BUFFERING_INQUIRE or READY.
 */
async function handleDataReady(config: RequestProxyConfig, commandExecutor: ICommandExecutor, session: ClientSession, event: StateEvent): Promise<ClientState> {
    if (event.type === 'DISPATCH_DATA') {
        const data = session.buffer;
        if (!data || data.length === 0) {
            log(config, `[${session.sessionId}] No data to dispatch`);
            return 'READY';
        }

        log(config, `[${session.sessionId}] Dispatching to agent: ${sanitizeForLog(data)}`);
        try {
            const result = await commandExecutor.sendCommands(session.sessionId!, data);
            const response = result.response;

            writeToClient(config, session, response, `Proxying agent response: ${sanitizeForLog(response)}`);

            // Clear sent command from buffer
            session.buffer = '';

            // Check if response contains INQUIRE (next state depends on response type)
            if (/(^|\n)INQUIRE/.test(response)) {
                log(config, `[${session.sessionId}] Response contains INQUIRE, waiting for client data`);
                return 'BUFFERING_INQUIRE';
            }

            log(config, `[${session.sessionId}] Response OK/ERR, ready for next command`);

            // If client sent pipelined data while we were waiting, process buffered data
            if (session.buffer.length > 0) {
                const newlineIndex = session.buffer.indexOf('\n');
                if (newlineIndex !== -1) {
                    return 'DATA_READY';
                }
                return 'BUFFERING_COMMAND';
            }
            return 'READY';
        } catch (err) {
            const msg = extractErrorMessage(err);
            log(config, `[${session.sessionId}] Error sending to agent: ${msg}`);
            return 'ERROR';
        }
    }
    return 'ERROR';
}

/**
 * Handler for SENDING_TO_AGENT state
 * Waits for write confirmation after sending to agent.
 */
async function handleSendingToAgent(config: RequestProxyConfig, commandExecutor: ICommandExecutor, session: ClientSession, event: StateEvent): Promise<ClientState> {
    if (event.type === 'WRITE_OK') {
        log(config, `[${session.sessionId}] Write to agent OK`);
        return 'WAITING_FOR_AGENT';
    } else if (event.type === 'WRITE_ERROR') {
        const error = (event as any).error as string;
        log(config, `[${session.sessionId}] Write to agent error: ${error}`);
        return 'ERROR';
    }
    return 'ERROR';
}

/**
 * Handler for WAITING_FOR_AGENT state
 * Waits for complete response from agent.
 * Handles timeouts, socket errors, and pipelined client data.
 */
async function handleWaitingForAgent(config: RequestProxyConfig, commandExecutor: ICommandExecutor, session: ClientSession, event: StateEvent): Promise<ClientState> {
    if (event.type === 'AGENT_RESPONSE_COMPLETE') {
        const response = (event as any).response as string;
        log(config, `[${session.sessionId}] Agent response: ${sanitizeForLog(response)}`);
        return 'SENDING_TO_CLIENT';
    } else if (event.type === 'AGENT_TIMEOUT') {
        log(config, `[${session.sessionId}] Agent timeout`);
        return 'ERROR';
    } else if (event.type === 'AGENT_SOCKET_ERROR') {
        const error = (event as any).error as string;
        log(config, `[${session.sessionId}] Agent socket error: ${error}`);
        return 'ERROR';
    } else if (event.type === 'CLIENT_DATA_DURING_WAIT') {
        log(config, `[${session.sessionId}] Client sent data during agent wait (pipelined)`);
        return 'ERROR';
    }
    return 'ERROR';
}

/**
 * Handler for SENDING_TO_CLIENT state
 * Sends agent response to client.
 * Determines next state: READY (OK/ERR) or BUFFERING_INQUIRE (INQUIRE).
 */
async function handleSendingToClient(config: RequestProxyConfig, commandExecutor: ICommandExecutor, session: ClientSession, event: StateEvent): Promise<ClientState> {
    if (event.type === 'WRITE_OK') {
        log(config, `[${session.sessionId}] Write to client OK`);
        // Next state determined by response content (handled by previous handler)
        // For now, default to READY; INQUIRE detection happens in WAITING_FOR_AGENT
        return 'READY';
    } else if (event.type === 'RESPONSE_INQUIRE') {
        log(config, `[${session.sessionId}] Response contains INQUIRE`);
        return 'BUFFERING_INQUIRE';
    } else if (event.type === 'WRITE_ERROR') {
        const error = (event as any).error as string;
        log(config, `[${session.sessionId}] Write to client error: ${error}`);
        return 'ERROR';
    }
    return 'ERROR';
}

/**
 * Handler for ERROR state
 * Initiates cleanup by transitioning to CLOSING.
 */
async function handleError(config: RequestProxyConfig, commandExecutor: ICommandExecutor, session: ClientSession, event: StateEvent): Promise<ClientState> {
    if (event.type === 'CLEANUP_START') {
        log(config, `[${session.sessionId}] Starting cleanup from ERROR state`);
        return 'CLOSING';
    }
    // Auto-transition to CLOSING (error handling requires cleanup)
    log(config, `[${session.sessionId}] In ERROR state, initiating cleanup`);
    return 'CLOSING';
}

/**
 * Handler for CLOSING state
 * Performs full session cleanup: socket, listeners, buffer, sessionId, etc.
 * On success: DISCONNECTED
 * On failure: FATAL (breaks error loop)
 */
async function handleClosing(config: RequestProxyConfig, commandExecutor: ICommandExecutor, session: ClientSession, event: StateEvent): Promise<ClientState> {
    if (event.type === 'CLEANUP_COMPLETE' || event.type === 'CLEANUP_START') {
        // Perform cleanup
        log(config, `[${session.sessionId}] Closing session and releasing resources...`);

        if (session.sessionId) {
            try {
                await commandExecutor.disconnectAgent(session.sessionId);
                log(config, `[${session.sessionId}] Disconnected from GPG Agent Proxy`);
            } catch (err) {
                const msg = extractErrorMessage(err);
                log(config, `[${session.sessionId}] Disconnect failed: ${msg}`);
                // Continue with local cleanup even if disconnect fails
            }
        }

        // Clean up local session resources
        try {
            // Remove socket listeners
            session.socket.removeAllListeners();
            // Destroy socket
            session.socket.destroy();
            log(config, `[${session.sessionId}] Socket destroyed`);
        } catch (err) {
            const msg = extractErrorMessage(err);
            log(config, `[${session.sessionId}] Error destroying socket: ${msg}`);
            return 'FATAL';
        }

        // Clear session state
        session.sessionId = null;
        session.buffer = '';
        log(config, `[${session.sessionId ?? 'pending'}] Session cleanup complete`);
        return 'DISCONNECTED';
    } else if (event.type === 'CLEANUP_ERROR') {
        const error = (event as any).error as string;
        log(config, `[${session.sessionId}] Cleanup error: ${error}, transitioning to FATAL`);
        return 'FATAL';
    }

    // Unknown event in CLOSING state
    log(config, `[${session.sessionId}] Unexpected event ${event.type} in CLOSING state, attempting cleanup`);
    return 'CLOSING';
}

/**
 * Handler for FATAL state
 * Terminal state. No transitions out. Log and remain.
 */
async function handleFatal(config: RequestProxyConfig, commandExecutor: ICommandExecutor, session: ClientSession, event: StateEvent): Promise<ClientState> {
    log(config, `[${session.sessionId}] In FATAL state (terminal), ignoring event ${event.type}`);
    return 'FATAL';
}

/**
 * State handler dispatcher map
 * O(1) direct property lookup instead of switch statement string comparisons
 * Maps ClientState to handler function
 */
const stateHandlers: Record<ClientState, StateHandler> = {
    DISCONNECTED: handleDisconnected,
    CLIENT_CONNECTED: handleClientConnected,
    AGENT_CONNECTING: handleAgentConnecting,
    READY: handleReady,
    BUFFERING_COMMAND: handleBufferingCommand,
    BUFFERING_INQUIRE: handleBufferingInquire,
    DATA_READY: handleDataReady,
    SENDING_TO_AGENT: handleSendingToAgent,
    WAITING_FOR_AGENT: handleWaitingForAgent,
    SENDING_TO_CLIENT: handleSendingToClient,
    ERROR: handleError,
    CLOSING: handleClosing,
    FATAL: handleFatal,
};

/**
 * State handler dispatcher
 * Routes events to appropriate handler based on current state
 * Uses O(1) object property lookup instead of switch statement
 */
async function dispatchStateEvent(config: RequestProxyConfig, commandExecutor: ICommandExecutor, session: ClientSession, event: StateEvent): Promise<void> {
    const previousState = session.state;

    try {
        const handler = stateHandlers[previousState];
        const nextState = await handler(config, commandExecutor, session, event);

        // Update state
        if (nextState !== previousState) {
            session.state = nextState;
            log(config, `[${session.sessionId ?? 'pending'}] ${previousState} --[${event.type}]--> ${nextState}`);
        }
    } catch (err) {
        const msg = extractErrorMessage(err);
        log(config, `[${session.sessionId}] Handler error in ${previousState}: ${msg}`);
        session.state = 'ERROR';
    }
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
 * (Old implementation - to be reimplemented in Phase 2)
 */
async function connectToAgent(config: RequestProxyConfig, commandExecutor: ICommandExecutor, session: ClientSession): Promise<void> {
    // TODO: Reimplements in Phase 2 as handleAgentConnecting handler
    log(config, `[${session.sessionId ?? 'pending'}] Connecting to GPG Agent Proxy via command...`);
    try {
        const result = await commandExecutor.connectAgent();
        session.sessionId = result.sessionId;
        session.state = 'READY';
        log(config, `[${session.sessionId}] Connected to GPG Agent Proxy`);

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

    // TODO: Reimplement in Phase 2/4 with state handlers
    // Extract command based on current state
    let command: string | null = null;

    if (session.state === 'READY' || session.state === 'BUFFERING_COMMAND') {
        const newlineIndex = session.buffer.indexOf('\n');
        if (newlineIndex !== -1) {
            command = session.buffer.substring(0, newlineIndex + 1);
            session.buffer = session.buffer.substring(newlineIndex + 1);
            session.state = 'DATA_READY';
        }
    } else if (session.state === 'BUFFERING_INQUIRE') {
        const endIndex = session.buffer.indexOf('END\n');
        if (endIndex !== -1) {
            command = session.buffer.substring(0, endIndex + 4);
            session.buffer = session.buffer.substring(endIndex + 4);
            session.state = 'DATA_READY';
        }
    }

    if (!command) {
        return; // Wait for more data
    }

    // Send command to gpg-agent-proxy and wait for response
    await waitResponse(config, commandExecutor, session, command);
}

async function waitResponse(config: RequestProxyConfig, commandExecutor: ICommandExecutor, session: ClientSession, data: string): Promise<void> {
    log(config, `[${session.sessionId}] Proxying client -> agent: ${sanitizeForLog(data)}`);
    session.state = 'WAITING_FOR_AGENT';
    const result = await commandExecutor.sendCommands(session.sessionId!, data);

    const response = result.response;
    writeToClient(config, session, response, `Proxying client <- agent: ${sanitizeForLog(response)}`);

    // TODO: Reimplement in Phase 2/5 with proper state handler
    // Determine next state based on response
    if (/(^|\n)INQUIRE/.test(response)) {
        session.state = 'BUFFERING_INQUIRE';
        log(config, `[${session.sessionId}] Entering BUFFERING_INQUIRE state`);
    } else {
        session.state = 'READY';
        log(config, `[${session.sessionId}] Next state: READY`);
    }

    // Process any buffered data
    if (session.buffer.length > 0) {
        handleClientData(config, commandExecutor, session, encodeProtocolData(session.buffer));
        session.buffer = '';
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
