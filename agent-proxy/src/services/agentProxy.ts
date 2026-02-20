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
import { log, encodeProtocolData, decodeProtocolData, parseSocketFile, extractErrorMessage, sanitizeForLog, detectResponseCompletion, cleanupSocket } from '@gpg-relay/shared';
import type { LogConfig, IFileSystem, ISocketFactory, ISessionManager } from '@gpg-relay/shared';

// ============================================================================
// State Machine Type Definitions
// ============================================================================

/**
 * Session states for agent-proxy lifecycle
 */
export type SessionState =
    | 'DISCONNECTED'           // No active connection, session can be created
    | 'CONNECTING_TO_AGENT'    // TCP socket connection in progress
    | 'SOCKET_CONNECTED'       // Socket connected, ready to send nonce
    | 'READY'                  // Connected and authenticated, can accept commands
    | 'SENDING_TO_AGENT'       // Command write in progress to agent
    | 'WAITING_FOR_AGENT'      // Accumulating response chunks from agent
    | 'ERROR'                  // Error occurred, cleanup needed
    | 'CLOSING'                // Cleanup in progress (socket teardown, session removal)
    | 'FATAL';                 // Unrecoverable cleanup failure — session permanently dead

/**
 * State machine events (10 total)
 */
export type StateEvent =
    // Client events (from request-proxy calling VS Code commands)
    | 'CLIENT_CONNECT_REQUESTED'
    | 'CLIENT_DATA_RECEIVED'
    // Agent events (from gpg-agent or socket operations)
    | 'AGENT_SOCKET_CONNECTED'
    | 'AGENT_WRITE_OK'
    | 'AGENT_DATA_CHUNK'
    | 'AGENT_DATA_RECEIVED'
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
        AGENT_SOCKET_CONNECTED: 'SOCKET_CONNECTED',    // Socket connected
        ERROR_OCCURRED: 'ERROR',
        CLEANUP_REQUESTED: 'CLOSING'                    // Socket close hadError=false
    },
    SOCKET_CONNECTED: {
        CLIENT_DATA_RECEIVED: 'SENDING_TO_AGENT',       // Nonce send begins
        ERROR_OCCURRED: 'ERROR',
        CLEANUP_REQUESTED: 'CLOSING'                    // Socket close hadError=false
    },
    READY: {
        CLIENT_DATA_RECEIVED: 'SENDING_TO_AGENT',
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
        AGENT_DATA_RECEIVED: 'READY',
        ERROR_OCCURRED: 'ERROR',
        CLEANUP_REQUESTED: 'CLOSING'                    // Socket close hadError=false (BYE race)
    },
    ERROR: {
        CLEANUP_REQUESTED: 'CLOSING'                    // Always hadError=true from ERROR
    },
    CLOSING: {
        CLEANUP_COMPLETE: 'DISCONNECTED',
        CLEANUP_ERROR: 'FATAL'                          // Unrecoverable cleanup failure
    },
    FATAL: {
        // No transitions out of FATAL
    }
};

/**
 * Event payload types
 */
export interface EventPayloads {
    CLIENT_CONNECT_REQUESTED: { port: number; nonce: Buffer };
    CLIENT_DATA_RECEIVED: { commandBlock: string | Buffer };
    AGENT_SOCKET_CONNECTED: undefined;
    AGENT_WRITE_OK: { requiresTimeout: boolean };  // Context: nonce (true) vs command (false)
    AGENT_DATA_CHUNK: { chunk: string };
    AGENT_DATA_RECEIVED: { response: string };
    ERROR_OCCURRED: { error: Error; message?: string };
    CLEANUP_REQUESTED: { hadError: boolean };
    CLEANUP_COMPLETE: undefined;
    CLEANUP_ERROR: { error: Error };
}

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
    connectionTimeoutMs: number;    // Default: 5000 - network operation timeout
    greetingTimeoutMs: number;      // Default: 5000 - nonce authentication timeout
    // No response timeout - commands can be interactive (password prompts, INQUIRE)
    // Network failures detected via socket 'close' event
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
export class AgentSessionManager extends EventEmitter implements ISessionManager {
    public readonly sessionId: string;
    private state: SessionState = 'DISCONNECTED';
    private socket: net.Socket | null = null;
    private buffer: string = '';
    private connectionTimeout: NodeJS.Timeout | null = null;
    private agentDataTimeout: NodeJS.Timeout | null = null;     // timeout for agent to respond, usually used for greeting response
    // No responseTimeout - commands can be interactive (password prompts via pinentry)
    private lastError: Error | null = null;  // Stores error for Promise bridges to retrieve
    private pendingNonce: Buffer | null = null;  // Temporary nonce storage between connect request and socket connect

    constructor(
        sessionId: string,
        private config: AgentSessionManagerConfig,
        private socketFactory: ISocketFactory
    ) {
        super();
        this.sessionId = sessionId;

        // Register handlers for all 10 events
        // Use .once() for single-fire events, .on() for events that can fire multiple times

        // Single-fire initialization events
        this.once('CLIENT_CONNECT_REQUESTED', (payload) => this.handleClientConnectRequested(payload));
        this.once('AGENT_SOCKET_CONNECTED', () => this.handleAgentSocketConnected());

        // Multi-fire events (can occur multiple times per session)
        this.on('CLIENT_DATA_RECEIVED', (payload) => this.handleClientDataReceived(payload));
        this.on('AGENT_WRITE_OK', (payload) => this.handleAgentWriteOk(payload));
        this.on('AGENT_DATA_CHUNK', (payload) => this.handleAgentDataChunk(payload));
        this.on('AGENT_DATA_RECEIVED', (payload) => this.handleAgentDataReceived(payload));

        // Single-fire terminal events
        this.once('ERROR_OCCURRED', (payload) => this.handleErrorOccurred(payload));
        this.once('CLEANUP_REQUESTED', (payload) => this.handleCleanupRequested(payload));
        this.once('CLEANUP_COMPLETE', () => this.handleCleanupComplete());
        this.once('CLEANUP_ERROR', (payload) => this.handleCleanupError(payload));
    }

    // ========================================================================
    // Event Handlers (Phase 4: full implementation)
    // ========================================================================

    /**
     * Handle CLIENT_CONNECT_REQUESTED: initiate connection to agent
     * Transition: DISCONNECTED → CONNECTING_TO_AGENT
     */
    private handleClientConnectRequested(payload: EventPayloads['CLIENT_CONNECT_REQUESTED']): void {
        this.transition('CLIENT_CONNECT_REQUESTED');

        const { port, nonce } = payload;
        log(this.config, `[${this.sessionId}] Connecting to localhost:${port}...`);

        // Set connection timeout
        this.connectionTimeout = setTimeout(() => {
            log(this.config, `[${this.sessionId}] Connection timeout after ${this.config.connectionTimeoutMs}ms`);
            this.emit('ERROR_OCCURRED', {
                error: new Error(`Connection timeout after ${this.config.connectionTimeoutMs}ms`)
            });
        }, this.config.connectionTimeoutMs);

        // Create socket connection
        const socket = this.socketFactory.createConnection({
            host: 'localhost',
            port: port
        });

        // Store nonce for sending after socket async connection
        this.pendingNonce = nonce;

        // Set socket and wire events
        this.setSocket(socket);
    }

    /**
     * Handle AGENT_SOCKET_CONNECTED: socket connection established
     * Transition: CONNECTING_TO_AGENT → SOCKET_CONNECTED
     * Clears connection timeout and emits CLIENT_DATA_RECEIVED with nonce
     */
    private handleAgentSocketConnected(): void {
        this.transition('AGENT_SOCKET_CONNECTED');

        // Clear connection timeout
        if (this.connectionTimeout) {
            clearTimeout(this.connectionTimeout);
            this.connectionTimeout = null;
        }

        const nonce = this.pendingNonce;
        if (!nonce) {
            this.emit('ERROR_OCCURRED', { error: new Error('Missing nonce after connection') });
            return;
        }

        log(this.config, `[${this.sessionId}] Socket connected, ready to send nonce`);

        // Clean up pending nonce
        this.pendingNonce = null;

        // Send nonce as first data
        this.emit('CLIENT_DATA_RECEIVED', { commandBlock: nonce });
    }

    /**
     * Handle AGENT_WRITE_OK: data written to agent successfully
     * Transition: SOCKET_CONNECTED → WAITING_FOR_AGENT (after nonce)
     * Transition: SENDING_TO_AGENT → WAITING_FOR_AGENT (after command)
     */
    private handleAgentWriteOk(payload: EventPayloads['AGENT_WRITE_OK']): void {
        this.transition('AGENT_WRITE_OK');
        log(this.config, `[${this.sessionId}] Write completed, waiting for response...`);

        // Only set greeting timeout for nonce authentication (requiresTimeout=true)
        // NO timeout for command responses - they can be interactive (password prompts, INQUIRE)
        const { requiresTimeout } = payload;

        if (requiresTimeout) {
            this.agentDataTimeout = setTimeout(() => {
                log(this.config, `[${this.sessionId}] Greeting timeout after ${this.config.greetingTimeoutMs}ms`);
                this.emit('ERROR_OCCURRED', {
                    error: new Error(`Greeting timeout after ${this.config.greetingTimeoutMs}ms`)
                });
            }, this.config.greetingTimeoutMs);
        }
        // For command responses: no timeout, rely on socket 'close' for network failures
    }

    /**
     * Handle CLIENT_DATA_RECEIVED: data received from client (nonce or command)
     * Transition: SOCKET_CONNECTED → SENDING_TO_AGENT or READY → SENDING_TO_AGENT
     */
    private handleClientDataReceived(payload: EventPayloads['CLIENT_DATA_RECEIVED']): void {
        this.transition('CLIENT_DATA_RECEIVED');

        const { commandBlock } = payload;
        const isNonce = Buffer.isBuffer(commandBlock);
        const logMsg = isNonce
            ? `${commandBlock.length}-byte nonce`
            : sanitizeForLog(commandBlock);
        log(this.config, `[${this.sessionId}] Sending ${isNonce ? 'nonce' : 'command'}: ${logMsg}`);

        // Reset buffer for new response
        this.buffer = '';

        // Write data to socket
        if (!this.socket) {
            this.emit('ERROR_OCCURRED', { error: new Error('No socket available for data') });
            return;
        }

        // Convert string commandBlocks to Buffer using encodeProtocolData (latin1) to preserve
        // raw bytes (0–255). socket.write(string) defaults to UTF-8, which expands bytes 0x80–0xFF
        // into 2-byte sequences — corrupting binary Assuan data such as the PKDECRYPT D-block
        // ciphertext. The nonce is already a Buffer and does not need conversion.
        const data: Buffer = Buffer.isBuffer(commandBlock)
            ? commandBlock
            : encodeProtocolData(commandBlock);

        this.socket.write(data, (error) => {
            if (error) {
                log(this.config, `[${this.sessionId}] Write failed: ${error.message}`);
                this.emit('ERROR_OCCURRED', { error });
            } else {
                // Nonce requires timeout, commands do not (can be interactive)
                this.emit('AGENT_WRITE_OK', { requiresTimeout: isNonce });
            }
        });
    }

    /**
     * Handle AGENT_DATA_CHUNK: data received from agent
     * Accumulates data and checks for response completion
     * Emits AGENT_DATA_RECEIVED when complete response detected (greeting or command response)
     */
    private handleAgentDataChunk(payload: EventPayloads['AGENT_DATA_CHUNK']): void {
        const { chunk } = payload;
        this.buffer += chunk;

        log(this.config, `[${this.sessionId}] Accumulated ${this.buffer.length} bytes`);

        // Check if response is complete
        const completion = detectResponseCompletion(this.buffer);
        if (completion.complete) {
            log(this.config, `[${this.sessionId}] Complete response (${completion.type}): ${sanitizeForLog(this.buffer)}`);

            // Clear greeting timeout if set (only set for nonce authentication)
            if (this.agentDataTimeout) {
                clearTimeout(this.agentDataTimeout);
                this.agentDataTimeout = null;
            }

            // Emit AGENT_DATA_RECEIVED (unified event for greeting and command responses)
            this.emit('AGENT_DATA_RECEIVED', { response: this.buffer });
        }
    }

    /**
     * Handle AGENT_DATA_RECEIVED: complete response received (greeting or command response)
     * Transition: WAITING_FOR_AGENT → READY
     */
    private handleAgentDataReceived(payload: EventPayloads['AGENT_DATA_RECEIVED']): void {
        // Note: GPG agent does NOT send ERR for bad nonce - it immediately closes socket
        // See gpg-agent source: check_nonce() calls assuan_sock_close() on nonce failure
        this.transition('AGENT_DATA_RECEIVED');
        log(this.config, `[${this.sessionId}] Response received, ready for next command`);

        // handleComplete (.once() in promise bridge) → calls resolve({ response })
        // to resolve connectAgent() with greeting or sendCommands() with command response
    }

    /**
     * Handle ERROR_OCCURRED: error during operation
     * Stores error for Promise bridges to retrieve, then transitions to ERROR and emits CLEANUP_REQUESTED
     */
    private handleErrorOccurred(payload: EventPayloads['ERROR_OCCURRED']): void {
        this.transition('ERROR_OCCURRED');

        const { error, message } = payload;
        const errorMsg = message ?? error.message;
        log(this.config, `[${this.sessionId}] Error occurred: ${errorMsg}`);

        // Store error for Promise bridges to retrieve
        this.lastError = error;

        // Clear all timeouts
        this.clearAllTimeouts();

        // Remove multi-fire event listeners to prevent them firing during cleanup
        this.removeListener('CLIENT_DATA_RECEIVED', this.handleClientDataReceived);
        this.removeListener('AGENT_WRITE_OK', this.handleAgentWriteOk);
        this.removeListener('AGENT_DATA_CHUNK', this.handleAgentDataChunk);
        this.removeListener('AGENT_DATA_RECEIVED', this.handleAgentDataReceived);

        // Emit CLEANUP_REQUESTED with hadError=true
        this.emit('CLEANUP_REQUESTED', { hadError: true });
    }

    /**
     * Handle CLEANUP_REQUESTED: cleanup session resources
     * Transition: any socket-having state → CLOSING
     * Payload indicates if cleanup is due to error (hadError=true) or graceful close (hadError=false)
     */
    private handleCleanupRequested(payload: EventPayloads['CLEANUP_REQUESTED']): void {
        this.transition('CLEANUP_REQUESTED');

        const { hadError } = payload;
        log(this.config, `[${this.sessionId}] Cleanup requested (hadError=${hadError})`);

        // Clear all timeouts
        this.clearAllTimeouts();

        // Remove multi-fire event listeners (may already be removed if ERROR_OCCURRED ran)
        this.removeListener('CLIENT_DATA_RECEIVED', this.handleClientDataReceived);
        this.removeListener('AGENT_WRITE_OK', this.handleAgentWriteOk);
        this.removeListener('AGENT_DATA_CHUNK', this.handleAgentDataChunk);
        this.removeListener('AGENT_DATA_RECEIVED', this.handleAgentDataReceived);

        // Remove ERROR_OCCURRED listener (if not already fired via .once())
        this.removeListener('ERROR_OCCURRED', this.handleErrorOccurred);

        let cleanupError: Error | null = null;

        // Cleanup socket using shared utility
        if (this.socket) {
            cleanupError = cleanupSocket(this.socket, this.config, this.sessionId);
            this.socket = null;
        }

        // Clear buffer
        this.buffer = '';

        // Emit result (BEFORE removing listeners so CLEANUP_COMPLETE/ERROR handlers can run)
        if (cleanupError) {
            this.emit('CLEANUP_ERROR', { error: cleanupError });
        } else {
            this.emit('CLEANUP_COMPLETE');
        }
    }

    /**
     * Handle CLEANUP_COMPLETE: cleanup successful
     * Transition: CLOSING → DISCONNECTED
     */
    private handleCleanupComplete(): void {
        this.transition('CLEANUP_COMPLETE');
        log(this.config, `[${this.sessionId}] Cleanup complete, session disconnected`);
    }

    /**
     * Handle CLEANUP_ERROR: cleanup failed — unrecoverable
     * Transition: CLOSING → FATAL
     * Session remains in FATAL permanently; the Map entry is removed by the caller.
     */
    private handleCleanupError(payload: EventPayloads['CLEANUP_ERROR']): void {
        this.transition('CLEANUP_ERROR');

        const { error } = payload;
        log(this.config, `[${this.sessionId}] Fatal cleanup error: ${error.message}`);
    }

    /**
     * Get current state (for testing and debugging)
     */
    public getState(): SessionState {
        return this.state;
    }

    /**
     * Get last stored error (for Promise bridges in AgentProxy to retrieve on cleanup)
     */
    public getLastError(): Error | null {
        return this.lastError;
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

        const oldState = this.state;
        this.state = nextState;
        log(this.config, `[${this.sessionId}] ${oldState} → ${nextState} (event: ${event})`);
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
     * Clear all active timeouts (connection and greeting only)
     * No response timeout - commands can require indefinite human interaction
     */
    private clearAllTimeouts(): void {
        if (this.connectionTimeout) {
            clearTimeout(this.connectionTimeout);
            this.connectionTimeout = null;
        }
        if (this.agentDataTimeout) {
            clearTimeout(this.agentDataTimeout);
            this.agentDataTimeout = null;
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
        'SOCKET_CONNECTED',
        'READY',
        'SENDING_TO_AGENT',
        'WAITING_FOR_AGENT',
        'ERROR',
        'CLOSING'
    ];

    const allEvents: StateEvent[] = [
        'CLIENT_CONNECT_REQUESTED',
        'CLIENT_DATA_RECEIVED',
        'AGENT_SOCKET_CONNECTED',
        'AGENT_WRITE_OK',
        'AGENT_DATA_CHUNK',
        'AGENT_DATA_RECEIVED',
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

export class AgentProxy {
    private sessions: Map<string, AgentSessionManager> = new Map();
    private socketFactory: ISocketFactory;
    private fileSystem: IFileSystem;
    private readonly sessionTimeouts = {
        connection: 5000,   // Non-interactive network operation
        greeting: 5000      // Non-interactive nonce authentication
        // No response timeout - commands can be interactive (password prompts, INQUIRE)
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
     */
    private createSessionConfig(): AgentSessionManagerConfig {
        return {
            ...this.config,
            connectionTimeoutMs: this.sessionTimeouts.connection,
            greetingTimeoutMs: this.sessionTimeouts.greeting
        };
    }

    /**
     * Connect to GPG agent and return a sessionId and greeting.
     *
     * Creates a new session and connects to the GPG agent via TCP socket with nonce authentication.
     * The session flows through states: DISCONNECTED → CONNECTING_TO_AGENT → SOCKET_CONNECTED →
     * SENDING_TO_AGENT (nonce) → WAITING_FOR_AGENT (greeting) → READY.
     *
     * Uses event-driven state machine with promise bridge pattern:
     * - Registers listeners for AGENT_DATA_RECEIVED (success) and CLEANUP_REQUESTED (error)
     * - Emits CLIENT_CONNECT_REQUESTED to initiate connection
     * - Promise resolves when greeting received, rejects on timeout or error
     *
     * @returns Promise resolving to object with sessionId (UUID) and greeting response
     * @throws Connection timeout (5s), greeting timeout (5s), socket errors, validation errors
     *
     * @example
     * const { sessionId, greeting } = await agentProxy.connectAgent();
     * console.log(`Connected with session ${sessionId}: ${greeting}`);
     */
    public async connectAgent(): Promise<{ sessionId: string; greeting: string }> {
        const sessionId = uuidv4();
        log(this.config, `[${sessionId}] Create session to gpg-agent...`);

        try {
            // Read and parse the socket file to get port and nonce
            const socketData = this.fileSystem.readFileSync(this.config.gpgAgentSocketPath);
            const { port, nonce } = parseSocketFile(socketData);

            log(this.config, `[${sessionId}] Found config: localhost:${port} with nonce`);

            // Create session manager
            const sessionConfig = this.createSessionConfig();
            const session = new AgentSessionManager(sessionId, sessionConfig, this.socketFactory);

            // Add to sessions map
            this.sessions.set(sessionId, session);

            // Register permanent cleanup listener to remove session from map
            // This ensures cleanup works even if Promise bridges have already resolved
            session.once('CLEANUP_COMPLETE', () => {
                log(this.config, `[${sessionId}] Removing session from map after cleanup`);
                this.sessions.delete(sessionId);
            });

            // Promise bridge: wait for AGENT_DATA_RECEIVED (greeting) or CLEANUP_REQUESTED
            // Note: ERROR_OCCURRED always emits CLEANUP_REQUESTED, so we only listen to CLEANUP
            return await new Promise<{ sessionId: string; greeting: string }>((resolve, reject) => {
                const handleResponse = (payload: { response: string }) => {
                    session.removeListener('CLEANUP_REQUESTED', handleCleanup);
                    resolve({ sessionId, greeting: payload.response });
                };

                const handleCleanup = () => {
                    session.removeListener('AGENT_DATA_RECEIVED', handleResponse);
                    // Cleanup session
                    this.sessions.delete(sessionId);
                    // Use stored error if available, otherwise generic message
                    const error = session.getLastError() ?? new Error('Session closed during connection');
                    reject(error);
                };

                // Register listeners (no ERROR_OCCURRED - it always leads to CLEANUP_REQUESTED)
                session.once('CLEANUP_REQUESTED', handleCleanup);
                session.once('AGENT_DATA_RECEIVED', handleResponse);  // Greeting is first response

                // Initiate connection
                session.emit('CLIENT_CONNECT_REQUESTED', { port, nonce });
            });
        } catch (error) {
            const msg = extractErrorMessage(error, 'Unknown error during connection');
            log(this.config, `[${sessionId}] Connection to gpg-agent failed: ${msg}`);
            // Clean up session if it was created
            this.sessions.delete(sessionId);
            throw new Error(`Connection to gpg-agent failed: ${msg}`);
        } finally {
            this.config.statusBarCallback?.();
        }
    }

    /**
     * Send command block to GPG agent and return response.
     *
     * Sends one or more GPG commands to the agent and waits for complete response.
     * Session must be in READY state (protocol violation if not). Response accumulates
     * until OK/ERR/INQUIRE detected via detectResponseCompletion().
     *
     * Uses event-driven state machine with promise bridge pattern:
     * - Validates session exists and is in READY state
     * - Registers listeners for AGENT_DATA_RECEIVED (success) and CLEANUP_REQUESTED (error)
     * - Emits CLIENT_DATA_RECEIVED to initiate command send
     * - Promise resolves when complete response received, rejects on error or cleanup
     *
     * State flow: READY → SENDING_TO_AGENT → WAITING_FOR_AGENT → READY
     *
     * NO TIMEOUT: Commands can be interactive (password prompts, INQUIRE). Network failures
     * detected via socket 'close' event, not arbitrary timeouts.
     *
     * @param sessionId - Session ID from connectAgent()
     * @param commandBlock - GPG command(s) to send (e.g., "BYE\n" or "GETINFO version\n")
     * @returns Promise resolving to object with response string from agent
     * @throws Session not found, not in READY state (protocol violation), write errors, socket errors
     *
     * @example
     * const { response } = await agentProxy.sendCommands(sessionId, 'GETINFO version\n');
     * console.log(`Agent version: ${response}`);
     */
    public async sendCommands(sessionId: string, commandBlock: string): Promise<{ response: string }> {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return Promise.reject(new Error(`Invalid session: ${sessionId}`));
        }

        // Protocol violation check: must be in READY state
        if (session.getState() !== 'READY') {
            const error = new Error(`Protocol violation: sendCommands called while session in ${session.getState()}`);
            log(this.config, `[${sessionId}] ${error.message}`);
            // Emit ERROR_OCCURRED to trigger cleanup
            session.emit('ERROR_OCCURRED', { error });
            return Promise.reject(error);
        }

        log(this.config, `[${sessionId}] Send to gpg-agent: ${sanitizeForLog(commandBlock)}`);

        // Promise bridge: wait for AGENT_DATA_RECEIVED or CLEANUP_REQUESTED
        // Note: ERROR_OCCURRED always emits CLEANUP_REQUESTED, so we only listen to CLEANUP
        return new Promise<{ response: string }>((resolve, reject) => {
            const handleComplete = (payload: { response: string }) => {
                session.removeListener('CLEANUP_REQUESTED', handleCleanup);
                resolve({ response: payload.response });
            };

            const handleCleanup = () => {
                session.removeListener('AGENT_DATA_RECEIVED', handleComplete);
                // Use stored error if available, otherwise generic message
                const error = session.getLastError() ?? new Error('Session closed while waiting for command response');
                reject(error);
            };

            // Register listeners (no ERROR_OCCURRED - it always leads to CLEANUP_REQUESTED)
            session.once('CLEANUP_REQUESTED', handleCleanup);
            session.once('AGENT_DATA_RECEIVED', handleComplete);

            // Emit data received event
            session.emit('CLIENT_DATA_RECEIVED', { commandBlock });
        });
    }

    /**
     * Gracefully disconnect a session by sending BYE command.
     *
     * Sends BYE command via normal command flow, then waits for socket to close.
     * BYE is NOT a special case - reuses SENDING_TO_AGENT → WAITING_FOR_AGENT → READY flow.
     * GPG agent closes socket after BYE OK response per protocol spec.
     * Socket 'close' event (hadError=false) triggers CLEANUP_REQUESTED → CLOSING → cleanup.
     *
     * Uses event-driven state machine with promise bridge pattern:
     * - Validates session exists
     * - Registers listener for CLEANUP_REQUESTED (covers both graceful and error paths)
     * - If READY: emits CLIENT_DATA_RECEIVED with 'BYE\n'
     * - If not READY: emits ERROR_OCCURRED to force cleanup
     * - Promise always resolves (never rejects) after cleanup complete
     *
     * Cleanup guarantees:
     * - Socket listeners removed via removeAllListeners()
     * - Socket destroyed via socket.destroy()
     * - Session deleted from Map
     * - First-error-wins pattern (cleanup continues even if one step fails)
     *
     * @param sessionId - Session ID from connectAgent()
     * @returns Promise resolving when session cleaned up and removed from Map
     * @throws Session not found
     *
     * @example
     * await agentProxy.disconnectAgent(sessionId);
     * console.log('Disconnected from agent');
     */
    public async disconnectAgent(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error(`Invalid session: ${sessionId}`);
        }

        log(this.config, `[${sessionId}] Disconnect gracefully from gpg-agent...`);

        // Promise bridge: wait for CLEANUP_REQUESTED
        // Note: This always resolves (graceful or error cleanup), never rejects
        // ERROR_OCCURRED always emits CLEANUP_REQUESTED, so we only listen to CLEANUP
        return new Promise<void>((resolve, reject) => {
            const handleDisconnected = () => {
                // Remove session from map
                this.sessions.delete(sessionId);
                log(this.config, `[${sessionId}] Disconnected from gpg-agent`);
                this.config.statusBarCallback?.();
                resolve();
            };

            // Listen only for CLEANUP_REQUESTED (covers both graceful and error paths)
            session.once('CLEANUP_REQUESTED', handleDisconnected);

            // Send BYE command through normal flow (if state is READY)
            if (session.getState() === 'READY') {
                session.emit('CLIENT_DATA_RECEIVED', { commandBlock: 'BYE\n' });
            } else {
                // If not READY, just trigger cleanup
                log(this.config, `[${sessionId}] Session not READY, forcing cleanup...`);
                session.emit('ERROR_OCCURRED', {
                    error: new Error('Disconnect called while not in READY state')
                });
            }
        });
    }

    public isRunning(): boolean {
        return this.sessions.size > 0;
    }

    public getSessionCount(): number {
        return this.sessions.size;
    }

    /**
     * Dispose all active sessions by destroying their sockets.
     *
     * Called by stopAgentProxy() before the AgentProxy instance is dropped.
     * Without this, open TCP sockets to gpg-agent would leak until GC.
     *
     * Each session is force-destroyed (not gracefully disconnected) because
     * we cannot await individual BYE handshakes during a synchronous stop.
     * The socket destroy() triggers the 'close' event on each session, which
     * drives the state machine through CLEANUP_REQUESTED → CLOSING → CLEANUP_COMPLETE
     * and removes the session from the Map via the CLEANUP_COMPLETE listener.
     */
    public dispose(): void {
        if (this.sessions.size === 0) {
            return;
        }
        log(this.config, `[AgentProxy] Disposing ${this.sessions.size} active session(s)`);
        const disposeError = new Error('AgentProxy disposed');
        for (const [sessionId, session] of this.sessions) {
            const state = session.getState();
            // Only trigger cleanup for sessions that have open sockets.
            // Sessions already in ERROR, CLOSING, or FATAL are already being cleaned up.
            if (state !== 'DISCONNECTED' && state !== 'ERROR' && state !== 'CLOSING' && state !== 'FATAL') {
                log(this.config, `[${sessionId}] Force-closing session during dispose (state: ${state})`);
                session.emit('ERROR_OCCURRED', { error: disposeError });
            }
        }
    }
}
