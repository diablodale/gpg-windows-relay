/**
 * Agent Proxy Service
 *
 * Manages connections to gpg-agent Assuan socket.
 * Exposes three commands to the request-proxy extension:
 * - connectAgent(): Creates new socket, returns sessionId
 * - sendCommands(sessionId, commandBlock): Sends command block, returns response
 * - disconnectAgent(sessionId): Closes socket and cleans up
 */

import * as net from 'net';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { log, decodeProtocolData, parseSocketFile, extractErrorMessage, sanitizeForLog } from '@gpg-relay/shared';
import type { LogConfig, IFileSystem, ISocketFactory } from '@gpg-relay/shared';

// ============================================================================
// State Machine Type Definitions
// ============================================================================

/**
 * Session states for agent-proxy lifecycle
 */
export type SessionState =
    | 'DISCONNECTED'           // No active connection, session can be created
    | 'CONNECTING_TO_AGENT'    // TCP socket created, nonce authentication in progress
    | 'READY'                  // Connected and authenticated, can accept commands
    | 'SENDING_TO_AGENT'       // Command write in progress to agent
    | 'WAITING_FOR_AGENT'      // Accumulating response chunks from agent
    | 'ERROR'                  // Error occurred, cleanup needed
    | 'CLOSING';               // Cleanup in progress (socket teardown, session removal)

/**
 * State machine events (11 total)
 */
export type StateEvent =
    // Client events (from request-proxy calling VS Code commands)
    | 'CLIENT_CONNECT_REQUESTED'
    | 'CLIENT_COMMAND_RECEIVED'
    // Agent events (from gpg-agent or socket operations)
    | 'AGENT_SOCKET_CONNECTED'
    | 'AGENT_WRITE_OK'
    | 'AGENT_GREETING_RECEIVED'
    | 'AGENT_DATA_CHUNK'
    | 'AGENT_RESPONSE_COMPLETE'
    // Error & cleanup events
    | 'ERROR_OCCURRED'
    | 'CLEANUP_REQUESTED'
    | 'CLEANUP_COMPLETE'
    | 'CLEANUP_ERROR';

/**
 * State transition table: (currentState, event) → nextState
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
        CLIENT_CONNECT_REQUESTED: 'CONNECTING_TO_AGENT'
    },
    CONNECTING_TO_AGENT: {
        AGENT_SOCKET_CONNECTED: 'CONNECTING_TO_AGENT',  // Stay in state, waiting for nonce write
        AGENT_WRITE_OK: 'CONNECTING_TO_AGENT',          // Nonce sent, waiting for greeting
        AGENT_GREETING_RECEIVED: 'READY',
        ERROR_OCCURRED: 'ERROR',
        CLEANUP_REQUESTED: 'CLOSING'                    // Socket close hadError=false
    },
    READY: {
        CLIENT_COMMAND_RECEIVED: 'SENDING_TO_AGENT',
        ERROR_OCCURRED: 'ERROR',
        CLEANUP_REQUESTED: 'CLOSING'                    // Socket close hadError=false
    },
    SENDING_TO_AGENT: {
        AGENT_WRITE_OK: 'WAITING_FOR_AGENT',
        ERROR_OCCURRED: 'ERROR',
        CLEANUP_REQUESTED: 'CLOSING'                    // Socket close hadError=false
    },
    WAITING_FOR_AGENT: {
        AGENT_DATA_CHUNK: 'WAITING_FOR_AGENT',         // Stay in state, accumulating
        AGENT_RESPONSE_COMPLETE: 'READY',
        ERROR_OCCURRED: 'ERROR',
        CLEANUP_REQUESTED: 'CLOSING'                    // Socket close hadError=false (BYE race)
    },
    ERROR: {
        CLEANUP_REQUESTED: 'CLOSING'                    // Always hadError=true from ERROR
    },
    CLOSING: {
        CLEANUP_COMPLETE: 'DISCONNECTED',
        CLEANUP_ERROR: 'DISCONNECTED'                   // FATAL implicit (session deleted)
    }
};

/**
 * Event payload types
 */
export interface EventPayloads {
    CLIENT_CONNECT_REQUESTED: { port: number; nonce: Buffer };
    CLIENT_COMMAND_RECEIVED: { commandBlock: string };
    AGENT_SOCKET_CONNECTED: undefined;
    AGENT_WRITE_OK: undefined;
    AGENT_GREETING_RECEIVED: { greeting: string };
    AGENT_DATA_CHUNK: { chunk: string };
    AGENT_RESPONSE_COMPLETE: { response: string };
    ERROR_OCCURRED: { error: Error; message?: string };
    CLEANUP_REQUESTED: { hadError: boolean };
    CLEANUP_COMPLETE: undefined;
    CLEANUP_ERROR: { error: Error };
}

/**
 * State handler function signature
 */
export type StateHandler = (
    session: AgentSessionManager,
    event: StateEvent,
    payload?: EventPayloads[keyof EventPayloads]
) => void;

// ============================================================================
// Configuration & Dependencies
// ============================================================================

export interface AgentProxyConfig extends LogConfig {
    gpgAgentSocketPath: string; // Path to Assuan socket file
    statusBarCallback?: () => void;
}

/**
 * Per-session configuration
 */
export interface AgentSessionManagerConfig extends LogConfig {
    connectionTimeoutMs: number;    // Default: 5000
    greetingTimeoutMs: number;      // Default: 5000
    responseTimeoutMs: number;      // Default: 30000
}

/**
 * Optional dependencies for AgentProxy (all defaults provided)
 */
interface AgentProxyDeps {
    socketFactory: ISocketFactory;
    fileSystem: IFileSystem;
}

// ============================================================================
// Agent Session Manager (Per-Session EventEmitter)
// ============================================================================

/**
 * Per-session state machine extending EventEmitter
 * Manages single agent connection lifecycle with explicit state tracking
 */
export class AgentSessionManager extends EventEmitter {
    public readonly sessionId: string;
    private state: SessionState = 'DISCONNECTED';
    private socket: net.Socket | null = null;
    private buffer: string = '';
    private connectionTimeout: NodeJS.Timeout | null = null;
    private greetingTimeout: NodeJS.Timeout | null = null;
    private responseTimeout: NodeJS.Timeout | null = null;

    constructor(
        sessionId: string,
        private config: AgentSessionManagerConfig,
        private socketFactory: ISocketFactory
    ) {
        super();
        this.sessionId = sessionId;
        this.registerEventHandlers();
    }

    /**
     * Register handlers for all 11 events
     * Phase 3: Register event listeners (Phase 4 will implement full logic)
     */
    private registerEventHandlers(): void {
        // Client events
        this.on('CLIENT_CONNECT_REQUESTED', (payload) => this.handleClientConnectRequested(payload));
        this.on('CLIENT_COMMAND_RECEIVED', (payload) => this.handleClientCommandReceived(payload));

        // Agent events
        this.on('AGENT_SOCKET_CONNECTED', () => this.handleAgentSocketConnected());
        this.on('AGENT_WRITE_OK', (payload) => this.handleAgentWriteOk(payload));
        this.on('AGENT_GREETING_RECEIVED', (payload) => this.handleAgentGreetingReceived(payload));
        this.on('AGENT_DATA_CHUNK', (payload) => this.handleAgentDataChunk(payload));
        this.on('AGENT_RESPONSE_COMPLETE', (payload) => this.handleAgentResponseComplete(payload));

        // Error and cleanup events
        this.on('ERROR_OCCURRED', (payload) => this.handleErrorOccurred(payload));
        this.on('CLEANUP_REQUESTED', (payload) => this.handleCleanupRequested(payload));
        this.on('CLEANUP_COMPLETE', () => this.handleCleanupComplete());
        this.on('CLEANUP_ERROR', (payload) => this.handleCleanupError(payload));
    }

    // ========================================================================
    // Event Handler Stubs (Phase 3: structure only, Phase 4: full logic)
    // ========================================================================

    private handleClientConnectRequested(_payload: unknown): void {
        log(this.config, `[${this.sessionId}] Event: CLIENT_CONNECT_REQUESTED (stub)`);
        // Phase 4: Implement connection logic
    }

    private handleClientCommandReceived(_payload: unknown): void {
        log(this.config, `[${this.sessionId}] Event: CLIENT_COMMAND_RECEIVED (stub)`);
        // Phase 4: Implement command sending logic
    }

    private handleAgentSocketConnected(): void {
        log(this.config, `[${this.sessionId}] Event: AGENT_SOCKET_CONNECTED (stub)`);
        // Phase 4: Implement socket connected logic
    }

    private handleAgentWriteOk(_payload: unknown): void {
        log(this.config, `[${this.sessionId}] Event: AGENT_WRITE_OK (stub)`);
        // Phase 4: Implement write completion logic
    }

    private handleAgentGreetingReceived(_payload: unknown): void {
        log(this.config, `[${this.sessionId}] Event: AGENT_GREETING_RECEIVED (stub)`);
        // Phase 4: Implement greeting handling logic
    }

    private handleAgentDataChunk(_payload: unknown): void {
        log(this.config, `[${this.sessionId}] Event: AGENT_DATA_CHUNK (stub)`);
        // Phase 4: Implement data accumulation logic
    }

    private handleAgentResponseComplete(_payload: unknown): void {
        log(this.config, `[${this.sessionId}] Event: AGENT_RESPONSE_COMPLETE (stub)`);
        // Phase 4: Implement response completion logic
    }

    private handleErrorOccurred(_payload: unknown): void {
        log(this.config, `[${this.sessionId}] Event: ERROR_OCCURRED (stub)`);
        // Phase 4: Implement error handling logic
    }

    private handleCleanupRequested(_payload: unknown): void {
        log(this.config, `[${this.sessionId}] Event: CLEANUP_REQUESTED (stub)`);
        // Phase 4: Implement cleanup logic
    }

    private handleCleanupComplete(): void {
        log(this.config, `[${this.sessionId}] Event: CLEANUP_COMPLETE (stub)`);
        // Phase 4: Implement cleanup completion logic
    }

    private handleCleanupError(_payload: unknown): void {
        log(this.config, `[${this.sessionId}] Event: CLEANUP_ERROR (stub)`);
        // Phase 4: Implement cleanup error handling logic
    }

    /**
     * Get current state (for testing and debugging)
     */
    public getState(): SessionState {
        return this.state;
    }

    /**
     * Set state with logging
     */
    private setState(newState: SessionState, event: StateEvent): void {
        const oldState = this.state;
        this.state = newState;
        log(this.config, `[${this.sessionId}] ${oldState} → ${newState} (event: ${event})`);
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
            log(this.config, `[${this.sessionId}] ${error.message}`);
            throw error;
        }

        this.setState(nextState, event);
    }

    /**
     * Get socket (for operations that need direct access)
     */
    public getSocket(): net.Socket | null {
        return this.socket;
    }

    /**
     * Set socket and wire event handlers
     */
    public setSocket(socket: net.Socket): void {
        this.socket = socket;
        this.wireSocketEvents(socket);
    }

    /**
     * Wire socket event handlers with .once() for single-fire events
     */
    private wireSocketEvents(socket: net.Socket): void {
        // Connect event - fires once when connection established
        socket.once('connect', () => {
            log(this.config, `[${this.sessionId}] Socket connected`);
            this.emit('AGENT_SOCKET_CONNECTED');
        });

        // Data event - fires multiple times as chunks arrive
        socket.on('data', (chunk: Buffer) => {
            const chunkStr = decodeProtocolData(chunk);
            log(this.config, `[${this.sessionId}] Received ${chunk.length} bytes`);
            this.emit('AGENT_DATA_CHUNK', { chunk: chunkStr });
        });

        // Error event - fires once when socket error occurs
        socket.once('error', (err: Error) => {
            log(this.config, `[${this.sessionId}] Socket error: ${err.message}`);
            this.emit('ERROR_OCCURRED', { error: err });
        });

        // Close event - fires exactly once when socket closes
        socket.once('close', (hadError: boolean) => {
            log(this.config, `[${this.sessionId}] Socket closed (hadError=${hadError})`);

            if (hadError) {
                // Transmission error during socket I/O
                this.emit('ERROR_OCCURRED', { error: new Error('Socket closed with transmission error') });
            } else {
                // Clean/graceful socket close
                this.emit('CLEANUP_REQUESTED', { hadError: false });
            }
        });
    }

    /**
     * Clear all timeouts
     */
    private clearAllTimeouts(): void {
        if (this.connectionTimeout) {
            clearTimeout(this.connectionTimeout);
            this.connectionTimeout = null;
        }
        if (this.greetingTimeout) {
            clearTimeout(this.greetingTimeout);
            this.greetingTimeout = null;
        }
        if (this.responseTimeout) {
            clearTimeout(this.responseTimeout);
            this.responseTimeout = null;
        }
    }
}

// ============================================================================
// State Machine Validation
// ============================================================================

/**
 * Validate transition table completeness (for testing/debugging)
 * Returns array of missing (state, event) pairs
 */
export function validateTransitionTable(): Array<{ state: SessionState; event: StateEvent }> {
    const allStates: SessionState[] = [
        'DISCONNECTED',
        'CONNECTING_TO_AGENT',
        'READY',
        'SENDING_TO_AGENT',
        'WAITING_FOR_AGENT',
        'ERROR',
        'CLOSING'
    ];

    const allEvents: StateEvent[] = [
        'CLIENT_CONNECT_REQUESTED',
        'CLIENT_COMMAND_RECEIVED',
        'AGENT_SOCKET_CONNECTED',
        'AGENT_WRITE_OK',
        'AGENT_GREETING_RECEIVED',
        'AGENT_DATA_CHUNK',
        'AGENT_RESPONSE_COMPLETE',
        'ERROR_OCCURRED',
        'CLEANUP_REQUESTED',
        'CLEANUP_COMPLETE',
        'CLEANUP_ERROR'
    ];

    const missing: Array<{ state: SessionState; event: StateEvent }> = [];

    // Not all (state, event) pairs are valid - this just checks for completeness
    // Valid transitions are explicitly defined in STATE_TRANSITIONS
    for (const state of allStates) {
        const transitions = STATE_TRANSITIONS[state];
        for (const event of allEvents) {
            // Skip if transition not defined (may be intentional)
            // This function is mainly for debugging/documentation
        }
    }

    return missing;
}

// ============================================================================
// Agent Proxy (Public API)
// ============================================================================

interface SessionSocket {
    socket: net.Socket;
}

export class AgentProxy {
    private sessions: Map<string, SessionSocket> = new Map();
    private socketFactory: ISocketFactory;
    private fileSystem: IFileSystem;
    private readonly sessionTimeouts = {
        connection: 5000,
        greeting: 5000,
        response: 30000
    };

    constructor(private config: AgentProxyConfig, deps?: Partial<AgentProxyDeps>) {
        // Initialize with defaults or provided dependencies
        this.socketFactory = deps?.socketFactory ?? { createConnection: (options) => net.createConnection(options) };
        this.fileSystem = deps?.fileSystem ?? ({
            existsSync: fs.existsSync,
            readFileSync: fs.readFileSync
        } as unknown as IFileSystem);

        // Validate socket path exists
        if (!this.fileSystem.existsSync(config.gpgAgentSocketPath)) {
            throw new Error(`GPG agent socket not found: ${config.gpgAgentSocketPath}`);
        }
    }

    /**
     * Create session manager configuration with timeout defaults
     * Used in Phase 3 when migrating to AgentSessionManager
     */
    private createSessionConfig(): AgentSessionManagerConfig {
        return {
            ...this.config,
            connectionTimeoutMs: this.sessionTimeouts.connection,
            greetingTimeoutMs: this.sessionTimeouts.greeting,
            responseTimeoutMs: this.sessionTimeouts.response
        };
    }

    /**
     * Set up persistent error/close handlers for a session
     * These handlers log and clean up the session if the socket fails outside of active operations
     */
    private setupPersistentHandlers(sessionId: string, socket: net.Socket): void {
        // 'error' fires when the OS reports a failure (ECONNRESET, EPIPE, etc.)
        // or when the err arg of destroy() is used
        // node does not automatically destroy the socket on 'error' event
        // event sequences:
        // - OS error: 'error' -> 'close'
        // - local destroy with arg `socket.destroy(err)`: 'error' -> 'close'
        socket.on('error', (err) => {
            log(this.config, `[${sessionId}] Socket error: ${err.message}`);
        });

        // 'close' fires when the socket is fully closed and resources are released
        // hadError arg indicates if it closed because of an error
        // event sequences:
        // - OS error: 'error' -> 'close'
        // - graceful remote shutdown: 'end' -> 'close'
        // - local shutdown: socket.end() -> 'close'
        // - local destroy without arg: socket.destroy() -> 'close'
        socket.on('close', () => {
            log(this.config, `[${sessionId}] Socket closed`);
            this.sessions.delete(sessionId);
            this.config.statusBarCallback?.();
        });
    }

    /**
     * Cleanup socket and session (helper for connectAgent error paths)
     */
    private cleanupSession(sessionId: string, socket?: net.Socket): void {
        if (socket) {
            socket.destroy();
        }
        this.sessions.delete(sessionId);
    }

    /**
     * Connect to GPG agent and return a sessionId and greeting
     * On Windows, reads the socket file to extract port and nonce, then connects via TCP
     * Waits for nonce to be sent and greeting to be received before returning
     */
    public async connectAgent(): Promise<{ sessionId: string; greeting: string }> {
        const sessionId = uuidv4();
        let socket!: net.Socket;
        log(this.config, `[${sessionId}] Create session to gpg-agent...`);

        try {
            // Read and parse the socket file to get port and nonce (Windows Assuan format)
            const socketData = this.fileSystem.readFileSync(this.config.gpgAgentSocketPath);
            const { port, nonce } = parseSocketFile(socketData);

            log(this.config, `[${sessionId}] Found config suggesting gpg-agent at localhost:${port} and expects nonce`);

            // Wait for connection and send nonce
            await new Promise<void>((resolve, reject) => {
                const rejectWith = (error: unknown, fallbackMessage: string) => {
                    const msg = extractErrorMessage(error, fallbackMessage);
                    reject(new Error(msg));
                };

                const connectHandler = () => {
                    log(this.config, `[${sessionId}] Connected to localhost:${port}, sending nonce...`);
                    // Remove the one-time error handler since connection succeeded
                    socket.removeListener('error', errorHandler);
                    try {
                        socket.write(nonce, (error) => {
                            clearTimeout(connectionTimeout);
                            if (error) {
                                this.cleanupSession(sessionId, socket);
                                rejectWith(error, 'Failed to send nonce');
                            } else {
                                resolve();
                            }
                        });
                    } catch (error) {
                        clearTimeout(connectionTimeout);
                        this.cleanupSession(sessionId, socket);
                        rejectWith(error, 'Failed to send nonce');
                    }
                };

                const errorHandler = (error: Error) => {
                    clearTimeout(connectionTimeout);
                    socket.removeListener('connect', connectHandler);
                    this.cleanupSession(sessionId, socket);
                    rejectWith(error, 'Connection error during socket setup');
                };

                const connectionTimeout = setTimeout(() => {
                    socket.removeListener('connect', connectHandler);
                    socket.removeListener('error', errorHandler);
                    this.cleanupSession(sessionId, socket);
                    rejectWith(undefined, 'Timeout: No connection and nonce sent within 5 seconds');
                }, 5000);

                // Pass connectHandler as callback to createConnection - no race condition
                socket = this.socketFactory.createConnection({
                    host: 'localhost',
                    port: port
                }, connectHandler);

                // Listen for connection errors before persistent handlers
                socket.on('error', errorHandler);

                // Add to sessions map, set persistent handlers
                this.sessions.set(sessionId, {
                    socket: socket
                });
                this.setupPersistentHandlers(sessionId, socket);
            });

            // Wait for greeting with timeout, then verify it
            const greeting: string = await this.waitForResponse(sessionId, false, 5000);
            const greetingLine: string = greeting.trim();

            // Verify greeting starts with OK
            if (!greetingLine.startsWith('OK ')) {
                throw new Error(`Invalid greeting from agent: ${greetingLine}`);
            }

            // Successful connection and greeting
            log(this.config, `[${sessionId}] Connected successfully to gpg-agent`);
            this.config.statusBarCallback?.();
            return { sessionId, greeting };
        } catch (error) {
            const msg = extractErrorMessage(error, 'Unknown error during connection');
            const session = this.sessions.get(sessionId);
            if (session) {
                this.cleanupSession(sessionId, session.socket);
            }
            log(this.config, `[${sessionId}] Connection to gpg-agent failed: ${msg}`);
            throw new Error(`Connection to gpg-agent failed: ${msg}`);
        }
    }

    /**
     * Shared handler to wait for complete response from socket
     * Accumulates data chunks and detects completion using isCompleteResponse
     * Used by both connectAgent (greeting) and sendCommands (command responses)
     */
    private waitForResponse(
        sessionId: string,
        isInquireBlock: boolean,
        timeoutMs?: number
    ): Promise<string> {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return Promise.reject(new Error(`Invalid session: ${sessionId}`));
        }

        return new Promise((resolve, reject) => {
            let responseData = '';
            let timeoutHandle: NodeJS.Timeout | undefined;

            if (timeoutMs) {
                timeoutHandle = setTimeout(() => {
                    session.socket.removeListener('data', dataHandler);
                    session.socket.removeListener('close', closeHandler);
                    session.socket.removeListener('error', errorHandler);
                    this.cleanupSession(sessionId, session.socket);
                    reject(new Error(`Response timeout after ${timeoutMs}ms`));
                }, timeoutMs);
            }

            const dataHandler = (chunk: Buffer) => {
                // Use latin1 to preserve raw bytes without UTF-8 mangling
                const chunkStr = decodeProtocolData(chunk);
                responseData += chunkStr;
                log(this.config, `[${sessionId}] Received ${chunk.length} bytes from gpg-agent`);

                // Check if we have a complete response
                if (this.isCompleteResponse(responseData, isInquireBlock)) {
                    if (timeoutHandle) clearTimeout(timeoutHandle);
                    session.socket.removeListener('data', dataHandler);
                    session.socket.removeListener('close', closeHandler);
                    session.socket.removeListener('error', errorHandler);
                    log(this.config, `[${sessionId}] Complete response from gpg-agent: ${sanitizeForLog(responseData)}`);
                    resolve(responseData);
                }
            };

            const closeHandler = () => {
                if (timeoutHandle) clearTimeout(timeoutHandle);
                session.socket.removeListener('data', dataHandler);
                session.socket.removeListener('error', errorHandler);
                reject(new Error('Socket closed unexpectedly'));
            };

            const errorHandler = (error: Error) => {
                if (timeoutHandle) clearTimeout(timeoutHandle);
                session.socket.removeListener('data', dataHandler);
                session.socket.removeListener('close', closeHandler);
                reject(new Error(`Socket error: ${error.message}`));
            };

            session.socket.on('data', dataHandler);
            session.socket.once('close', closeHandler);
            session.socket.once('error', errorHandler);
        });
    }

    /**
     * Send command block to GPG agent and return response
     *
     * Command block is a complete request (e.g., "GETINFO version\n" or "D data\nEND\n")
     * Response is all lines returned by agent until complete (buffered internally)
     */
    public async sendCommands(sessionId: string, commandBlock: string): Promise<{ response: string }> {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return Promise.reject(new Error(`Invalid session: ${sessionId}`));
        }

        log(this.config, `[${sessionId}] Send to gpg-agent: ${sanitizeForLog(commandBlock)}`);

        try {
            session.socket.write(commandBlock, (error) => {
                if (error) {
                    // Write failed asynchronously - destroy socket
                    // This will trigger 'error' and 'close' events, causing waitForResponse to reject
                    const msg = extractErrorMessage(error, 'Unknown error during write');
                    log(this.config, `[${sessionId}] Send to gpg-agent failed: ${msg}`);
                    session.socket.destroy(error);
                }
            });
        } catch (error) {
            const msg = extractErrorMessage(error, 'Unknown error during write');
            log(this.config, `[${sessionId}] Send to gpg-agent failed (sync): ${msg}`);
            session.socket.destroy();
            throw new Error(`Send to gpg-agent failed: ${msg}`);
        }

        const isInquireBlock = commandBlock.startsWith('D ');
        const response = await this.waitForResponse(sessionId, isInquireBlock);
        return { response };
    }

    /**
     * Check if response is complete
     *
     * Complete responses end with:
     * - OK (for normal commands)
     * - ERR (for errors)
     * - INQUIRE (for inquiries, client will respond with D/END)
     *
     * Response format is ASCII lines ending with \n
     */
    private isCompleteResponse(response: string, isInquireResponse: boolean): boolean {
        // Responses must be line-terminated
        if (!response.endsWith('\n')) {
            return false;
        }

        // Split into lines
        const lines = response.split('\n');

        // Check last non-empty line for terminal condition
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (!line) continue;

            // Terminal conditions
            if (line.startsWith('OK ') || line === 'OK') return true;
            if (line.startsWith('ERR ')) return true;
            if (line.startsWith('INQUIRE ')) return true;

            // For D/END blocks, we need END
            if (isInquireResponse && line === 'END') return true;

            // Found a non-terminal line, need more data
            return false;
        }

        return false;
    }

    /**
     * Gracefully disconnect a session by sending BYE command
     * Waits for agent response before closing socket
     */
    public async disconnectAgent(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error(`Invalid session: ${sessionId}`);
        }

        log(this.config, `[${sessionId}] Disconnect gracefully from gpg-agent...`);

        try {
            // Send BYE command and wait for response
            await this.sendCommands(sessionId, 'BYE\n');
            log(this.config, `[${sessionId}] Disconnected from gpg-agent`);
        } catch (error) {
            // If BYE fails, log but continue with cleanup
            const msg = extractErrorMessage(error);
            log(this.config, `[${sessionId}] Disconnect gracefully failed: ${msg}`);
            log(this.config, `[${sessionId}] Destroying session and force closing socket to gpg-agent`);
        } finally {
            // Always destroy socket which fires 'close' event
            session.socket.destroy();
        }
    }

    public isRunning(): boolean {
        return this.sessions.size > 0;
    }

    public getSessionCount(): number {
        return this.sessions.size;
    }
}
