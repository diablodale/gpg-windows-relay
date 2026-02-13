/**
 * Request Proxy Service - State Machine Implementation
 *
 * Creates a Unix socket server on the GPG agent socket path.
 * Implements a 12-state finite state machine to handle GPG Assuan protocol:
 *   DISCONNECTED → CLIENT_CONNECTED → AGENT_CONNECTING → READY
 *   READY ↔ BUFFERING_COMMAND → SENDING_TO_AGENT ↔ WAITING_FOR_AGENT ↔ SENDING_TO_CLIENT
 *   READY ↔ BUFFERING_INQUIRE → SENDING_TO_AGENT
 *   Any state → ERROR → CLOSING → DISCONNECTED or FATAL
 *
 * Each client connection manages its own state machine using sessionId.
 * Commands are sent to agent-proxy extension via VS Code commands.
 */

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { log, encodeProtocolData, decodeProtocolData, sanitizeForLog, extractErrorMessage } from '@gpg-relay/shared';
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
  | 'SENDING_TO_AGENT'
  | 'WAITING_FOR_AGENT'
  | 'SENDING_TO_CLIENT'
  | 'ERROR'
  | 'CLOSING'
  | 'FATAL';

/**
 * State machine events (22 total)
 */
type StateEvent =
  | { type: 'CLIENT_SOCKET_CONNECTED' }
  | { type: 'START_AGENT_CONNECT' }
  | { type: 'AGENT_GREETING_OK'; greeting: string }
  | { type: 'AGENT_CONNECT_ERROR'; error: string }
  | { type: 'CLIENT_DATA_START'; data: Buffer }
  | { type: 'CLIENT_DATA_PARTIAL'; data: Buffer }
  | { type: 'COMMAND_COMPLETE'; command: string }
  | { type: 'INQUIRE_DATA_START'; data: Buffer }
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
type StateHandler = (config: RequestProxyConfigWithExecutor, session: ClientSession, event: StateEvent) => Promise<ClientState>;

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
    'COMMAND_COMPLETE': 'SENDING_TO_AGENT',
    'BUFFER_ERROR': 'ERROR',
  },
  BUFFERING_INQUIRE: {
    'INQUIRE_DATA_START': 'BUFFERING_INQUIRE',
    'INQUIRE_DATA_PARTIAL': 'BUFFERING_INQUIRE',
    'INQUIRE_COMPLETE': 'SENDING_TO_AGENT',
    'BUFFER_ERROR': 'ERROR',
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
    // commandExecutor is injected via deps, not provided here
}

export interface RequestProxyDeps {
    commandExecutor?: ICommandExecutor;  // Optional for testing/injection; defaults to VSCodeCommandExecutor
    serverFactory?: IServerFactory;
    fileSystem?: IFileSystem;
    getSocketPath?: () => Promise<string | null>;
}

// Internal config type used by handlers - always has commandExecutor after DI
interface RequestProxyConfigWithExecutor extends RequestProxyConfig {
    commandExecutor: ICommandExecutor;
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
 * Accepts CLIENT_SOCKET_CONNECTED event and transitions to CLIENT_CONNECTED.
 */
async function handleDisconnected(config: RequestProxyConfigWithExecutor, session: ClientSession, event: StateEvent): Promise<ClientState> {
    if (event.type !== 'CLIENT_SOCKET_CONNECTED') {
        throw new Error(`Invalid event ${event.type} for state DISCONNECTED`);
    }
    log(config, `[${session.sessionId ?? 'pending'}] Client socket connected`);
    return 'CLIENT_CONNECTED';
}

/**
 * Handler for CLIENT_CONNECTED state
 * Accepts START_AGENT_CONNECT event and transitions to AGENT_CONNECTING.
 */
async function handleClientConnected(config: RequestProxyConfigWithExecutor, session: ClientSession, event: StateEvent): Promise<ClientState> {
    if (event.type !== 'START_AGENT_CONNECT') {
        throw new Error(`Invalid event ${event.type} for state CLIENT_CONNECTED`);
    }
    log(config, `[${session.sessionId ?? 'pending'}] Starting agent connection`);
    return 'AGENT_CONNECTING';
}

/**
 * Handler for AGENT_CONNECTING state
 * Processes connection result: success (READY) or error (ERROR).
 * Connection work is done by socket initialization code which emits these events.
 */
async function handleAgentConnecting(config: RequestProxyConfigWithExecutor, session: ClientSession, event: StateEvent): Promise<ClientState> {
    if (event.type === 'AGENT_GREETING_OK') {
        // Extract sessionId from greeting if not already set
        if (!session.sessionId && event.greeting) {
            const greetingParts = event.greeting.split(' ');
            if (greetingParts.length > 0) {
                session.sessionId = greetingParts[0];
            }
        }
        log(config, `[${session.sessionId}] Agent connected with greeting`);
        writeToClient(config, session, event.greeting, 'Agent greeting sent to client');
        return 'READY';
    }
    if (event.type === 'AGENT_CONNECT_ERROR') {
        log(config, `[${session.sessionId ?? 'pending'}] Agent connection failed: ${event.error}`);
        return 'ERROR';
    }
    throw new Error(`Invalid event ${event.type} for state AGENT_CONNECTING`);
}

/**
 * Handler for READY state
 * Accepts CLIENT_DATA_START event and transitions to BUFFERING_COMMAND.
 * Buffers incoming data and checks for complete command.
 * Phase 3: Directly processes complete data using processCompleteData helper.
 * Phase 4: Uses extractFromBuffer helper for cleaner buffer management.
 */
async function handleReady(config: RequestProxyConfigWithExecutor, session: ClientSession, event: StateEvent): Promise<ClientState> {
    if (event.type === 'CLIENT_DATA_START') {
        const chunk = (event as any).data as Buffer;
        session.buffer += decodeProtocolData(chunk);
        log(config, `[${session.sessionId}] Received ${chunk.length} bytes, buffer size: ${session.buffer.length}`);

        // Check if complete command (ends with \n)
        const { extracted, remaining } = extractFromBuffer(session.buffer, '\n');
        if (extracted !== null) {
            // Command complete, process it directly
            log(config, `[${session.sessionId}] Command complete: ${sanitizeForLog(extracted)}`);
            // Set buffer to extracted command, save remaining for after processing
            session.buffer = extracted;
            const nextState = await processCompleteData(config, session);
            // Prepend any remaining data back to buffer (for pipelined commands)
            session.buffer = remaining + session.buffer;

            // Keep processing pipelined commands until no more complete commands in buffer
            let currentState = nextState;
            while (currentState === 'READY' && session.buffer.length > 0) {
                const { extracted: nextCmd, remaining: nextRemaining } = extractFromBuffer(session.buffer, '\n');
                if (nextCmd !== null) {
                    // Have another complete command in buffer, extract and process it
                    log(config, `[${session.sessionId}] Processing pipelined command from buffer`);
                    session.buffer = nextCmd;
                    currentState = await processCompleteData(config, session);
                    // Restore any further remaining data
                    session.buffer = nextRemaining + session.buffer;
                } else {
                    // Have partial data, need more input
                    return 'BUFFERING_COMMAND';
                }
            }

            return currentState;
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
 * Phase 3: Directly processes complete data using processCompleteData helper.
 * Phase 4: Uses extractFromBuffer helper for cleaner buffer management.
 */
async function handleBufferingCommand(config: RequestProxyConfigWithExecutor, session: ClientSession, event: StateEvent): Promise<ClientState> {
    if (event.type === 'CLIENT_DATA_PARTIAL') {
        const chunk = (event as any).data as Buffer;
        session.buffer += decodeProtocolData(chunk);
        log(config, `[${session.sessionId}] Buffering command, received ${chunk.length} bytes, total: ${session.buffer.length}`);

        // Check if command is now complete
        const { extracted, remaining } = extractFromBuffer(session.buffer, '\n');
        if (extracted !== null) {
            log(config, `[${session.sessionId}] Command complete: ${sanitizeForLog(extracted)}`);
            // Set buffer to extracted command, save remaining for after processing
            session.buffer = extracted;
            const nextState = await processCompleteData(config, session);
            // Prepend any remaining data back to buffer (for pipelined commands)
            session.buffer = remaining + session.buffer;

            // Keep processing pipelined commands until no more complete commands in buffer
            let currentState = nextState;
            while (currentState === 'READY' && session.buffer.length > 0) {
                const { extracted: nextCmd, remaining: nextRemaining } = extractFromBuffer(session.buffer, '\n');
                if (nextCmd !== null) {
                    // Have another complete command in buffer, extract and process it
                    log(config, `[${session.sessionId}] Processing pipelined command from buffer`);
                    session.buffer = nextCmd;
                    currentState = await processCompleteData(config, session);
                    // Restore any further remaining data
                    session.buffer = nextRemaining + session.buffer;
                } else {
                    // Have partial data, stay buffering
                    return 'BUFFERING_COMMAND';
                }
            }

            return currentState;
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
 * Phase 3: Directly processes complete data using processCompleteData helper.
 * Phase 4: Uses extractFromBuffer helper for cleaner buffer management.
 */
async function handleBufferingInquire(config: RequestProxyConfigWithExecutor, session: ClientSession, event: StateEvent): Promise<ClientState> {
    if (event.type === 'INQUIRE_DATA_START' || event.type === 'INQUIRE_DATA_PARTIAL') {
        const chunk = (event as any).data as Buffer;
        session.buffer += decodeProtocolData(chunk);
        log(config, `[${session.sessionId}] Buffering inquire data, received ${chunk.length} bytes, total: ${session.buffer.length}`);

        // Check if D-block is complete (ends with END\n)
        const { extracted, remaining } = extractFromBuffer(session.buffer, 'END\n');
        if (extracted !== null) {
            log(config, `[${session.sessionId}] Inquire data complete`);
            // Set buffer to extracted D-block, save remaining for after processing
            session.buffer = extracted;
            const nextState = await processCompleteData(config, session);
            // Prepend any remaining data back to buffer (for pipelined commands)
            session.buffer = remaining + session.buffer;
            return nextState;
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
 * Handler for SENDING_TO_AGENT state
 * Waits for write confirmation after sending to agent.
 */
async function handleSendingToAgent(config: RequestProxyConfigWithExecutor, session: ClientSession, event: StateEvent): Promise<ClientState> {
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
async function handleWaitingForAgent(config: RequestProxyConfigWithExecutor, session: ClientSession, event: StateEvent): Promise<ClientState> {
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
async function handleSendingToClient(config: RequestProxyConfigWithExecutor, session: ClientSession, event: StateEvent): Promise<ClientState> {
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
async function handleError(config: RequestProxyConfigWithExecutor, session: ClientSession, event: StateEvent): Promise<ClientState> {
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
async function handleClosing(config: RequestProxyConfigWithExecutor, session: ClientSession, event: StateEvent): Promise<ClientState> {
    if (event.type === 'CLEANUP_COMPLETE' || event.type === 'CLEANUP_START') {
        // Perform cleanup
        log(config, `[${session.sessionId}] Closing session and releasing resources...`);

        if (session.sessionId) {
            try {
                await config.commandExecutor.disconnectAgent(session.sessionId);
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
async function handleFatal(config: RequestProxyConfigWithExecutor, session: ClientSession, event: StateEvent): Promise<ClientState> {
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
    SENDING_TO_AGENT: handleSendingToAgent,
    WAITING_FOR_AGENT: handleWaitingForAgent,
    SENDING_TO_CLIENT: handleSendingToClient,
    ERROR: handleError,
    CLOSING: handleClosing,
    FATAL: handleFatal,
};

/**
 * Helper function to extract data from buffer based on delimiter
 * Phase 4: Shared buffer extraction logic to avoid duplication
 *
 * @param buffer - Current buffer string
 * @param delimiter - Delimiter to search for ('\n' for commands, 'END\n' for inquire)
 * @returns Object with extracted data (including delimiter) and remaining buffer
 *          - extracted: null if delimiter not found, otherwise the extracted string (including delimiter)
 *          - remaining: empty string if delimiter not found, otherwise the rest of the buffer
 */
function extractFromBuffer(buffer: string, delimiter: string): { extracted: string | null; remaining: string } {
    const delimiterIndex = buffer.indexOf(delimiter);

    if (delimiterIndex === -1) {
        // Delimiter not found - data is incomplete
        return { extracted: null, remaining: '' };
    }

    // Extract data including delimiter
    const extracted = buffer.substring(0, delimiterIndex + delimiter.length);
    const remaining = buffer.substring(delimiterIndex + delimiter.length);

    return { extracted, remaining };
}

/**
 * Helper function to process complete command/inquire data
 * Called directly by handlers when complete data is detected (Phase 3 simplification)
 * Sends to agent, gets response, writes to client, determines next state
 */
async function processCompleteData(config: RequestProxyConfigWithExecutor, session: ClientSession): Promise<ClientState> {
    const data = session.buffer;
    if (!data || data.length === 0) {
        log(config, `[${session.sessionId}] No data to process`);
        return 'READY';
    }

    log(config, `[${session.sessionId}] Processing complete data: ${sanitizeForLog(data)}`);
    try {
        const result = await config.commandExecutor.sendCommands(session.sessionId!, data);
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
                // Have complete command, process it
                return processCompleteData(config, session);
            }
            return 'BUFFERING_COMMAND';
        }
        return 'READY';
    } catch (err) {
        const msg = extractErrorMessage(err);
        log(config, `[${session.sessionId}] Error processing data: ${msg}`);
        return 'ERROR';
    }
}

/**
 * State handler dispatcher
 * Routes events to appropriate handler based on current state
 * Uses O(1) object property lookup instead of switch statement
 */
async function dispatchStateEvent(config: RequestProxyConfigWithExecutor, session: ClientSession, event: StateEvent): Promise<void> {
    const previousState = session.state;

    try {
        const handler = stateHandlers[previousState];
        const nextState = await handler(config, session, event);

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
    // Initialize dependencies with defaults
    const commandExecutor = deps?.commandExecutor ?? new VSCodeCommandExecutor();
    const serverFactory = deps?.serverFactory ?? { createServer: net.createServer };
    const fileSystem = deps?.fileSystem ?? { existsSync: fs.existsSync, mkdirSync: fs.mkdirSync, chmodSync: fs.chmodSync, unlinkSync: fs.unlinkSync };
    const getSocketPath = deps?.getSocketPath ?? getLocalGpgSocketPath;
    const usingMocks = !!(deps?.serverFactory || deps?.fileSystem);

    // Create full config with injected commandExecutor
    const fullConfig: RequestProxyConfigWithExecutor = {
        ...config,
        commandExecutor
    };

    log(fullConfig, `[startRequestProxy] using mocked deps: ${usingMocks}`);
    const socketPath = await getSocketPath();
    if (!socketPath) {
        throw new Error('Could not determine local GPG socket path. Is gpg installed? Try: gpgconf --list-dirs');
    }

    // Ensure parent directory exists
    log(fullConfig, `Creating socket server at ${socketPath}`);
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
            log(fullConfig, `[${clientSession.sessionId ?? 'pending'}] Client socket closed`);
            // Call disconnectAgent directly to clean up session
            // (This is outside normal state machine flow - it's cleanup after connection termination)
            disconnectAgent(fullConfig, clientSession);
        });

        // 'error' fires when the OS reports a failure (ECONNRESET, EPIPE, etc.)
        // or when the err arg of destroy() is used
        // node does not automatically destroy the socket on 'error' event
        // event sequences:
        // - OS error: 'error' -> 'close'
        // - local destroy with arg `socket.destroy(err)`: 'error' -> 'close'
        clientSocket.on('error', (err: Error) => {
            log(fullConfig, `[${clientSession.sessionId ?? 'pending'}] Client socket error: ${err.message}`);
            // Error event is logged; 'close' event will trigger cleanup
        });

        // 'readable' fires when data is available to read from the socket
        clientSocket.on('readable', () => {
            let chunk: Buffer | null;
            while ((chunk = clientSocket.read()) !== null) {
                // Determine event type based on current state and buffer status
                // For INQUIRE flow: use INQUIRE_DATA_START/PARTIAL
                // For normal command flow: use CLIENT_DATA_START/PARTIAL
                let eventType: StateEvent['type'];
                if (clientSession.state === 'BUFFERING_INQUIRE') {
                    eventType = clientSession.buffer.length === 0 ? 'INQUIRE_DATA_START' : 'INQUIRE_DATA_PARTIAL';
                } else {
                    eventType = clientSession.buffer.length === 0 ? 'CLIENT_DATA_START' : 'CLIENT_DATA_PARTIAL';
                }
                dispatchStateEvent(fullConfig, clientSession, { type: eventType, data: chunk }).catch((err) => {
                    const msg = extractErrorMessage(err);
                    log(fullConfig, `[${clientSession.sessionId ?? 'pending'}] Error handling client data: ${msg}`);
                    try {
                        clientSession.socket.destroy();
                    } catch (err) {
                        // Ignore
                    }
                });
            }
        });

        // Start connection sequence via state machine
        log(fullConfig, 'Client connected to socket. Socket is paused while initiating connection to GPG Agent Proxy');
        (async () => {
            try {
                // Emit CLIENT_SOCKET_CONNECTED event
                await dispatchStateEvent(fullConfig, clientSession, { type: 'CLIENT_SOCKET_CONNECTED' });

                // Emit START_AGENT_CONNECT event
                await dispatchStateEvent(fullConfig, clientSession, { type: 'START_AGENT_CONNECT' });

                // Connect to agent-proxy and get greeting
                log(fullConfig, `[${clientSession.sessionId ?? 'pending'}] Connecting to GPG Agent Proxy via command...`);
                const result = await fullConfig.commandExecutor.connectAgent();
                clientSession.sessionId = result.sessionId;
                log(fullConfig, `[${clientSession.sessionId}] Connected to GPG Agent Proxy`);

                // Emit AGENT_GREETING_OK event with greeting
                if (result.greeting) {
                    await dispatchStateEvent(fullConfig, clientSession, {
                        type: 'AGENT_GREETING_OK',
                        greeting: result.greeting
                    });
                } else {
                    log(fullConfig, `[${clientSession.sessionId}] Warning: greeting is undefined`);
                }

                // Resume socket after greeting is sent
                clientSocket.resume();
            } catch (err) {
                const msg = extractErrorMessage(err);
                log(fullConfig, `Failed to connect to GPG Agent Proxy: ${msg}`);
                // Emit AGENT_CONNECT_ERROR event
                await dispatchStateEvent(fullConfig, clientSession, {
                    type: 'AGENT_CONNECT_ERROR',
                    error: msg
                }).catch(() => { /* Ignore dispatch errors during error handling */ });
                try {
                    clientSocket.destroy();
                } catch (err) {
                    // Ignore
                }
            }
        })();
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

function writeToClient(config: RequestProxyConfigWithExecutor, session: ClientSession, data: string, successMessage: string): boolean {
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
async function connectToAgent(config: RequestProxyConfigWithExecutor, session: ClientSession): Promise<void> {
    // TODO: Reimplements in Phase 2 as handleAgentConnecting handler
    log(config, `[${session.sessionId ?? 'pending'}] Connecting to GPG Agent Proxy via command...`);
    try {
        const result = await config.commandExecutor.connectAgent();
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
async function handleClientData(config: RequestProxyConfigWithExecutor, session: ClientSession, chunk: Buffer): Promise<void> {
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
            session.state = 'SENDING_TO_AGENT';
        }
    } else if (session.state === 'BUFFERING_INQUIRE') {
        const endIndex = session.buffer.indexOf('END\n');
        if (endIndex !== -1) {
            command = session.buffer.substring(0, endIndex + 4);
            session.buffer = session.buffer.substring(endIndex + 4);
            session.state = 'SENDING_TO_AGENT';
        }
    }

    if (!command) {
        return; // Wait for more data
    }

    // Send command to gpg-agent-proxy and wait for response
    await waitResponse(config, session, command);
}

async function waitResponse(config: RequestProxyConfigWithExecutor, session: ClientSession, data: string): Promise<void> {
    log(config, `[${session.sessionId}] Proxying client -> agent: ${sanitizeForLog(data)}`);
    session.state = 'WAITING_FOR_AGENT';
    const result = await config.commandExecutor.sendCommands(session.sessionId!, data);

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
        handleClientData(config, session, encodeProtocolData(session.buffer));
        session.buffer = '';
    }
}

/**
 * Disconnect the agent using command and remove session id+state
 */
async function disconnectAgent(config: RequestProxyConfigWithExecutor, session: ClientSession): Promise<void> {
    if (!session.sessionId) {
        return;
    }

    const sessionId = session.sessionId;
    log(config, `[${sessionId}] Disconnecting from GPG Agent Proxy...`);
    try {
        // Call disconnectAgent to clean up server-side session
        await config.commandExecutor.disconnectAgent(sessionId);
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
