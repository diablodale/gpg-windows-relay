/**
 * Request Proxy Service - State Machine Implementation
 *
 * Creates a Unix socket server on the GPG agent socket path.
 * Implements an 11-state finite state machine to handle GPG Assuan protocol:
 *   DISCONNECTED → CONNECTING_TO_AGENT → READY
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
import { EventEmitter } from 'events';
import { spawnSync } from 'child_process';
import { log, encodeProtocolData, decodeProtocolData, sanitizeForLog, extractErrorMessage, cleanupSocket, extractCommand, extractInquireBlock, detectResponseCompletion } from '@gpg-relay/shared';
import type { LogConfig, ICommandExecutor, IFileSystem, IServerFactory } from '@gpg-relay/shared';
import { VSCodeCommandExecutor } from './commandExecutor';

// ============================================================================
// State Machine Type Definitions (Phase 1)
// ============================================================================

/**
 * Client session states (11 total)
 */
type SessionState =
  | 'DISCONNECTED'
  | 'CONNECTING_TO_AGENT'
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
 * State machine events (13 total)
 * EventEmitter uses string event names, not discriminated union objects
 */
type StateEvent =
  | 'CLIENT_SOCKET_CONNECTED'
  | 'AGENT_GREETING_OK'
  | 'CLIENT_DATA_START'
  | 'CLIENT_DATA_PARTIAL'
  | 'CLIENT_DATA_COMPLETE'
  | 'ERROR_OCCURRED'
  | 'WRITE_OK'
  | 'AGENT_RESPONSE_COMPLETE'
  | 'RESPONSE_OK_OR_ERR'
  | 'RESPONSE_INQUIRE'
  | 'CLEANUP_REQUESTED'
  | 'CLEANUP_COMPLETE'
  | 'CLEANUP_ERROR';

/**
 * Event payload types
 * Documents expected payload types for each event (for documentation/reference only)
 * EventEmitter cannot enforce these at compile time
 */
export interface EventPayloads {
    CLIENT_SOCKET_CONNECTED: undefined;
    AGENT_GREETING_OK: { greeting: string };
    CLIENT_DATA_START: { data: Buffer };
    CLIENT_DATA_PARTIAL: { data: Buffer };
    CLIENT_DATA_COMPLETE: { data: string };
    ERROR_OCCURRED: { error: string };
    WRITE_OK: undefined;
    AGENT_RESPONSE_COMPLETE: { response: string };
    RESPONSE_OK_OR_ERR: { response: string };
    RESPONSE_INQUIRE: { response: string };
    CLEANUP_REQUESTED: { hadError: boolean };
    CLEANUP_COMPLETE: undefined;
    CLEANUP_ERROR: { error: string };
}

/**
 * State transition table type: (currentState, event) → nextState
 * Validates all valid state transitions at compile time
 */
type StateTransitionTable = {
    [K in SessionState]: {
        [E in StateEvent]?: SessionState;
    };
};

/**
 * Transition table defining all valid (state, event) → nextState mappings
 */
const STATE_TRANSITIONS: StateTransitionTable = {
  DISCONNECTED: {
    CLIENT_SOCKET_CONNECTED: 'CONNECTING_TO_AGENT',
  },
  CONNECTING_TO_AGENT: {
    AGENT_GREETING_OK: 'READY',
    ERROR_OCCURRED: 'ERROR',
    CLEANUP_REQUESTED: 'CLOSING',
  },
  READY: {
    CLIENT_DATA_START: 'BUFFERING_COMMAND',
    ERROR_OCCURRED: 'ERROR',
    CLEANUP_REQUESTED: 'CLOSING',
  },
  BUFFERING_COMMAND: {
    CLIENT_DATA_PARTIAL: 'BUFFERING_COMMAND',
    CLIENT_DATA_COMPLETE: 'SENDING_TO_AGENT',
    ERROR_OCCURRED: 'ERROR',
    CLEANUP_REQUESTED: 'CLOSING',
  },
  BUFFERING_INQUIRE: {
    CLIENT_DATA_PARTIAL: 'BUFFERING_INQUIRE',
    CLIENT_DATA_COMPLETE: 'SENDING_TO_AGENT',
    ERROR_OCCURRED: 'ERROR',
    CLEANUP_REQUESTED: 'CLOSING',
  },
  SENDING_TO_AGENT: {
    WRITE_OK: 'WAITING_FOR_AGENT',
    ERROR_OCCURRED: 'ERROR',
    CLEANUP_REQUESTED: 'CLOSING',
  },
  WAITING_FOR_AGENT: {
    AGENT_RESPONSE_COMPLETE: 'SENDING_TO_CLIENT',
    ERROR_OCCURRED: 'ERROR',
    CLEANUP_REQUESTED: 'CLOSING',
  },
  SENDING_TO_CLIENT: {
    WRITE_OK: 'READY',
    RESPONSE_OK_OR_ERR: 'READY',
    RESPONSE_INQUIRE: 'BUFFERING_INQUIRE',
    ERROR_OCCURRED: 'ERROR',
    CLEANUP_REQUESTED: 'CLOSING',
  },
  ERROR: {
    CLEANUP_REQUESTED: 'CLOSING',
  },
  CLOSING: {
    CLEANUP_COMPLETE: 'DISCONNECTED',
    CLEANUP_ERROR: 'FATAL',
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
    state: SessionState;
    buffer: string;
}

/**
 * ClientSessionManager - Event-driven session manager (like NodeJS Socket)
 *
 * Manages state, buffer, and event handling for a single client connection.
 * Events drive state transitions and processing logic.
 * Handlers are registered for events (like socket.on('data', handler))
 */
class ClientSessionManager extends EventEmitter {
    public readonly config: RequestProxyConfigWithExecutor;
    public socket: net.Socket;
    public sessionId: string | null = null;
    private state: SessionState = 'DISCONNECTED';
    private buffer: string = '';

    constructor(config: RequestProxyConfigWithExecutor, socket: net.Socket) {
        super();
        this.config = config;
        this.socket = socket;

        // Register event handlers for session lifecycle
        // Use .once() for single-fire events, .on() for events that can fire multiple times

        // Single-fire initialization events
        this.once('CLIENT_SOCKET_CONNECTED', this.handleClientSocketConnected.bind(this));
        this.once('AGENT_GREETING_OK', this.handleAgentGreetingOk.bind(this));

        // Multi-fire data/command events (multiple writes and data chunks per session)
        this.on('CLIENT_DATA_START', this.handleClientDataStart.bind(this));
        this.on('CLIENT_DATA_PARTIAL', this.handleClientDataPartial.bind(this));
        this.on('CLIENT_DATA_COMPLETE', this.handleClientDataComplete.bind(this));
        this.on('WRITE_OK', this.handleWriteOk.bind(this));
        this.on('AGENT_RESPONSE_COMPLETE', this.handleAgentResponseComplete.bind(this));
        this.on('RESPONSE_OK_OR_ERR', this.handleResponseOkOrErr.bind(this));
        this.on('RESPONSE_INQUIRE', this.handleResponseInquire.bind(this));

        // Single-fire terminal events
        this.once('ERROR_OCCURRED', this.handleErrorOccurred.bind(this));
        this.once('CLEANUP_REQUESTED', this.handleCleanupRequested.bind(this));
        this.once('CLEANUP_COMPLETE', this.handleCleanupComplete.bind(this));
        this.once('CLEANUP_ERROR', this.handleCleanupError.bind(this));
    }

    // ========================================================================
    // Public Methods
    // ========================================================================

    /**
     * Handle incoming data from socket
     * Determines appropriate event to emit based on current state
     */
    public handleIncomingData(chunk: Buffer): void {
        // Whitelist of states that can accept client data
        const validStates: SessionState[] = ['READY', 'BUFFERING_COMMAND', 'BUFFERING_INQUIRE'];

        // Check for protocol violation - client sending data in invalid state
        if (!validStates.includes(this.state)) {
            this.emit('ERROR_OCCURRED', `Protocol violation: client sent ${chunk.length} bytes in state ${this.state}`);
            return;
        }

        // Determine event type based on current state
        if (this.getState() === 'READY') {
            // First data in READY state -> transition to BUFFERING_COMMAND
            this.emit('CLIENT_DATA_START', chunk);
        } else {
            // Already buffering (command or inquire) - accumulate data
            this.emit('CLIENT_DATA_PARTIAL', chunk);
        }
    }

    // ========================================================================
    // Event Handlers - Change state, process data, emit events
    // ========================================================================

    private async handleClientSocketConnected(): Promise<void> {
        this.transition('CLIENT_SOCKET_CONNECTED');
        log(this.config, `[${this.sessionId ?? 'pending'}] Client socket connected, connecting to GPG Agent Proxy...`);

        try {
            // Connect to agent-proxy and get greeting
            const result = await this.config.commandExecutor.connectAgent();
            this.sessionId = result.sessionId;
            log(this.config, `[${this.sessionId}] Connected to GPG Agent Proxy`);

            // Emit greeting event
            if (result.greeting) {
                this.emit('AGENT_GREETING_OK', result.greeting);
            } else {
                this.emit('ERROR_OCCURRED', 'Agent connect failed: No greeting received');
            }
        } catch (err) {
            const msg = extractErrorMessage(err);
            this.emit('ERROR_OCCURRED', `Agent connect failed: ${msg}`);
        }
    }

    private handleAgentGreetingOk(greeting: string): void {
        this.transition('AGENT_GREETING_OK');
        log(this.config, `[${this.sessionId}] Agent greeting: ${sanitizeForLog(greeting)}`);
        this.writeToClient(greeting, `Sending greeting to client: ${sanitizeForLog(greeting)}`);

        // Resume socket after greeting is sent - client can now send commands
        this.socket.resume();
    }

    private handleClientDataStart(data: Buffer): void {
        this.transition('CLIENT_DATA_START');
        try {
            this.buffer += decodeProtocolData(data);
            log(this.config, `[${this.sessionId}] Buffering command, received ${data.length} bytes`);
            this.checkCommandComplete();
        } catch (err) {
            const msg = extractErrorMessage(err);
            this.emit('ERROR_OCCURRED', `Buffer error during CLIENT_DATA_START: ${msg}`);
        }
    }

    private handleClientDataPartial(data: Buffer): void {
        // Accumulate data in buffer (works for both BUFFERING_COMMAND and BUFFERING_INQUIRE)
        try {
            this.buffer += decodeProtocolData(data);
            log(this.config, `[${this.sessionId}] Buffering, received ${data.length} bytes, total: ${this.buffer.length}`);

            // Check for completion based on current state
            if (this.getState() === 'BUFFERING_COMMAND') {
                this.checkCommandComplete();
            } else if (this.getState() === 'BUFFERING_INQUIRE') {
                this.checkInquireComplete();
            }
        } catch (err) {
            const msg = extractErrorMessage(err);
            this.emit('ERROR_OCCURRED', `Buffer error during CLIENT_DATA_PARTIAL: ${msg}`);
        }
    }

    private handleClientDataComplete(data: string): void {
        this.transition('CLIENT_DATA_COMPLETE');
        log(this.config, `[${this.sessionId}] Data complete: ${sanitizeForLog(data)}`);

        // Send to agent
        this.sendToAgent(data);
    }

    private handleWriteOk(): void {
        if (this.getState() === 'SENDING_TO_AGENT') {
            this.transition('WRITE_OK');
            log(this.config, `[${this.sessionId}] Write to agent OK, waiting for response`);
        } else if (this.getState() === 'SENDING_TO_CLIENT') {
            // Response written to client, return to READY
            this.transition('WRITE_OK');
            log(this.config, `[${this.sessionId}] Write to client OK, ready for next command`);

            // Check for pipelined data
            this.checkPipelinedData();
        }
    }

    private handleAgentResponseComplete(response: string): void {
        this.transition('AGENT_RESPONSE_COMPLETE');
        log(this.config, `[${this.sessionId}] Agent response: ${sanitizeForLog(response)}`);

        // Write response to client and emit appropriate event
        this.writeToClient(response, `Proxying agent response: ${sanitizeForLog(response)}`);

        // Determine next event based on response type using shared protocol parser
        const completion = detectResponseCompletion(response);
        if (completion.type === 'INQUIRE') {
            this.emit('RESPONSE_INQUIRE', response);
        } else if (completion.type === 'OK' || completion.type === 'ERR') {
            this.emit('RESPONSE_OK_OR_ERR', response);
        } else {
            // Incomplete or invalid response - should not happen if agent behaves correctly
            log(this.config, `[${this.sessionId}] Warning: Unexpected response format: ${sanitizeForLog(response)}`);
            this.emit('RESPONSE_OK_OR_ERR', response); // Treat as OK/ERR to avoid blocking
        }
    }

    private handleResponseOkOrErr(response: string): void {
        // WRITE_OK handler will transition to READY
        log(this.config, `[${this.sessionId}] Response OK/ERR processed`);
    }

    private handleResponseInquire(response: string): void {
        this.transition('RESPONSE_INQUIRE');
        log(this.config, `[${this.sessionId}] Response contains INQUIRE, waiting for client data`);
    }

    private handleErrorOccurred(error: string): void {
        this.transition('ERROR_OCCURRED');
        log(this.config, `[${this.sessionId ?? 'pending'}] ${error}`);

        // Start cleanup sequence
        this.emit('CLEANUP_REQUESTED', true);
    }

    private async handleCleanupRequested(hadError: boolean): Promise<void> {
        this.transition('CLEANUP_REQUESTED');
        log(this.config, `[${this.sessionId ?? 'pending'}] Starting cleanup (hadError=${hadError})`);

        // Disconnect from agent if we have a session
        let cleanupError: unknown = null;
        const oldSessionId = this.sessionId; // Store old sessionId for logging after cleanup
        if (this.sessionId) {
            try {
                await this.config.commandExecutor.disconnectAgent(this.sessionId);
                log(this.config, `[${this.sessionId}] Disconnected from agent`);
            } catch (err) {
                // socket or client session manager may be in unexpected state during cleanup failure
                cleanupError = err;
            }
            this.buffer = '';
            this.sessionId = null;
        }

        // Cleanup socket using shared utility because Javascript has no destructors :-(
        const socketError = cleanupSocket(this.socket, this.config, oldSessionId ?? 'pending');
        cleanupError = cleanupError ?? socketError;

        if (cleanupError) {
            this.emit('CLEANUP_ERROR', extractErrorMessage(cleanupError));
        } else {
            this.emit('CLEANUP_COMPLETE');
        }
        try {
            this.removeAllListeners();
        } catch {
            log(this.config, `[${oldSessionId ?? 'pending'}] Error: failed to remove session event listeners during cleanup`);
        }
    }

    private handleCleanupComplete(): void {
        this.transition('CLEANUP_COMPLETE');
        log(this.config, `[${this.sessionId ?? 'pending'}] Cleanup complete`);
    }

    private handleCleanupError(error: string): void {
        this.transition('CLEANUP_ERROR');
        log(this.config, `[${this.sessionId ?? 'pending'}] Fatal cleanup error: ${error}`);
    }

    // ========================================================================
    // Helper Methods
    // ========================================================================

    /**
     * Get current state (for testing and debugging)
     */
    public getState(): SessionState {
        return this.state;
    }

    /**
     * Validate and execute state transition
     * Throws if transition is invalid
     */
    private transition(event: StateEvent): void {
        const allowedTransitions = STATE_TRANSITIONS[this.state];
        const nextState = allowedTransitions?.[event];

        if (!nextState) {
            const error = new Error(
                `Invalid transition: ${this.state} + ${event} (no transition defined)`
            );
            log(this.config, `[${this.sessionId ?? 'pending'}] ${error.message}`);
            throw error;
        }

        const oldState = this.state;
        this.state = nextState;
        log(this.config, `[${this.sessionId ?? 'pending'}] ${oldState} → ${nextState} (event: ${event})`);
    }

    /**
     * Check if buffered command is complete (ends with \n)
     * If complete, emit CLIENT_DATA_COMPLETE event
     */
    private checkCommandComplete(): void {
        const result = extractCommand(this.buffer);
        if (result.extracted) {
            this.buffer = result.remaining;
            this.emit('CLIENT_DATA_COMPLETE', result.extracted);
        }
    }

    /**
     * Check if buffered inquire data is complete (ends with END\n)
     * If complete, emit CLIENT_DATA_COMPLETE event
     */
    private checkInquireComplete(): void {
        const result = extractInquireBlock(this.buffer);
        if (result.extracted) {
            this.buffer = result.remaining;
            this.emit('CLIENT_DATA_COMPLETE', result.extracted);
        }
    }

    /**
     * Send data to agent via command executor
     */
    private async sendToAgent(data: string): Promise<void> {
        try {
            const result = await this.config.commandExecutor.sendCommands(this.sessionId!, data);

            // Emit WRITE_OK event (write successful)
            this.emit('WRITE_OK');

            // Emit AGENT_RESPONSE_COMPLETE event with response
            this.emit('AGENT_RESPONSE_COMPLETE', result.response);
        } catch (err) {
            const msg = extractErrorMessage(err);
            this.emit('ERROR_OCCURRED', `Write to agent failed: ${msg}`);
        }
    }

    /**
     * Write data to client socket
     */
    private writeToClient(data: string, logMessage: string): void {
        const buffer = encodeProtocolData(data);
        this.socket.write(buffer, (err) => {
            if (err) {
                this.emit('ERROR_OCCURRED', `Write to client failed: ${err.message}`);
            } else {
                log(this.config, `[${this.sessionId}] ${logMessage}`);
                this.emit('WRITE_OK');
            }
        });
    }

    /**
     * Check for pipelined data in buffer when returning to READY
     */
    private checkPipelinedData(): void {
        if (this.buffer.length > 0) {
            // Use shared command extraction to check for complete command
            const result = extractCommand(this.buffer);
            if (result.extracted) {
                // Have complete command, emit CLIENT_DATA_START to process it
                this.emit('CLIENT_DATA_START', Buffer.from([])); // Empty buffer since data already in this.buffer
            }
        }
    }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Start the Request Proxy server
 *
 * Creates a Unix socket server on the GPG agent socket path and starts forwarding
 * GPG protocol operations to the agent-proxy extension on the Windows host.
 * Each client connection runs an independent EventEmitter-based state machine.
 *
 * @param config - Configuration with optional logging callback
 * @param deps - Optional dependency injection for testing (commandExecutor, serverFactory, fileSystem, getSocketPath)
 *
 * @returns Promise resolving to RequestProxyInstance with stop() method
 *
 * @throws Error if GPG socket path cannot be determined (gpgconf not found)
 * @throws Error if socket already in use (another proxy running)
 * @throws Error if permission errors creating/binding socket
 *
 * @example
 * ```typescript
 * const instance = await startRequestProxy({
 *     logCallback: (msg) => console.log(msg)
 * }, {
 *     commandExecutor: new VSCodeCommandExecutor()
 * });
 *
 * // Later: stop the server
 * await instance.stop();
 * ```
 *
 * **Flow:**
 * 1. Detects GPG socket path via `gpgconf --list-dirs agent-socket`
 * 2. Creates Unix socket server at detected path
 * 3. Sets socket permissions to 0o666 (world-writable for GPG access)
 * 4. Starts listening for client connections
 * 5. Each client connection: connect to agent → process commands → cleanup
 *
 * **State Machine:**
 * - 11 states: DISCONNECTED → CONNECTING_TO_AGENT → READY → buffering/sending cycle
 * - 13 events: client data, agent responses, writes, errors, cleanup
 * - Independent state machines per client (concurrent sessions supported)
 * - INQUIRE D-block buffering: handles GPG's interactive data requests
 * - Error consolidation: all errors → ERROR_OCCURRED → cleanup
 *
 * **Session Management:**
 * - Sessions stored in Map<net.Socket, ClientSessionManager>
 * - Each session: isolated state, buffer, agent sessionId
 * - Cleanup guarantees: socket destroyed, agent disconnected, session removed
 * - First-error-wins cleanup pattern (continues even if steps fail)
 *
 * **Testing:**
 * Use dependency injection to mock VS Code commands, socket server, and file system.
 * Enables testing without VS Code runtime or real sockets/files.
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
        // Create session manager (EventEmitter pattern like NodeJS Socket)
        const sessionManager = new ClientSessionManager(fullConfig, clientSocket);


        // Attach socket event handlers

        // 'close' fires when the socket is fully closed and resources are released
        // hadError arg indicates if it closed because of an error
        // event sequences:
        // - OS error: 'error' -> 'close'
        // - graceful remote shutdown: 'end' -> 'close'
        // - local shutdown: socket.end() -> 'close'
        // - local destroy without arg: socket.destroy() -> 'close'
        clientSocket.once('close', (hadError: boolean) => {
            log(sessionManager.config, `[${sessionManager.sessionId ?? 'pending'}] Client socket closed (hadError=${hadError})`);

            // Emit event to state machine for validated cleanup
            if (hadError) {
                // Transmission error during socket I/O
                sessionManager.emit('ERROR_OCCURRED', 'Socket closed with transmission error');
            } else {
                // Clean/graceful socket close
                sessionManager.emit('CLEANUP_REQUESTED', hadError);
            }
        });

        // 'error' fires when the OS reports a failure (ECONNRESET, EPIPE, etc.)
        // or when the err arg of destroy() is used
        // node does not automatically destroy the socket on 'error' event
        // event sequences:
        // - OS error: 'error' -> 'close'
        // - local destroy with arg `socket.destroy(err)`: 'error' -> 'close'
        clientSocket.once('error', (err: Error) => {
            log(sessionManager.config, `[${sessionManager.sessionId ?? 'pending'}] Client socket error: ${err.message}`);
            // Error event is logged; 'close' event will trigger cleanup
        });

        // 'readable' fires when data is available to read from the socket
        clientSocket.on('readable', () => {
            let chunk: Buffer | null;
            while ((chunk = clientSocket.read()) !== null) {
                // Let session manager determine appropriate event based on current state
                sessionManager.handleIncomingData(chunk);
            }
        });

        // Start connection sequence - emit initial event and let handlers do the work
        log(fullConfig, 'Client connected to socket. Socket is paused while initiating connection to GPG Agent Proxy');
        sessionManager.emit('CLIENT_SOCKET_CONNECTED');
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
                /**
                 * Stop the request proxy server
                 *
                 * Stops accepting new connections, disconnects all active sessions,
                 * destroys all client sockets, closes the server, and removes the socket file.
                 *
                 * @returns Promise that resolves when server is fully stopped
                 *
                 * **Cleanup Flow:**
                 * 1. Server stops accepting new connections
                 * 2. All active sessions emit CLEANUP_REQUESTED
                 * 3. Each session: disconnect agent, destroy socket, remove from Map
                 * 4. Unix socket server closed
                 * 5. Socket file deleted (errors ignored)
                 *
                 * **Guarantees:**
                 * - All client sockets destroyed
                 * - All agent sessions disconnected
                 * - Socket listeners removed
                 * - Socket file removed (best effort)
                 * - First-error-wins pattern (cleanup continues if steps fail)
                 */
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
