/**
 * Request Proxy Service - State Machine Implementation
 *
 * Creates a Unix socket server on the GPG agent socket path.
 * Implements an 11-state finite state machine to handle GPG Assuan protocol:
 *   DISCONNECTED → CONNECTING_TO_AGENT → SENDING_TO_CLIENT → READY
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
import type { LogConfig, ICommandExecutor, IFileSystem, IServerFactory, ISessionManager } from '@gpg-relay/shared';
import { v4 as uuidv4 } from 'uuid';
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
 * State machine events (12 total)
 * EventEmitter uses string event names, not discriminated union objects
 */
type StateEvent =
  | 'CLIENT_SOCKET_CONNECTED'
  | 'CLIENT_DATA_START'
  | 'CLIENT_DATA_PARTIAL'
  | 'CLIENT_DATA_COMPLETE'
  | 'ERROR_OCCURRED'
  | 'AGENT_WRITE_COMPLETE'
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
    CLIENT_DATA_START: { data: Buffer };
    CLIENT_DATA_PARTIAL: { data: Buffer };
    CLIENT_DATA_COMPLETE: { data: string };
    ERROR_OCCURRED: { error: string };
    AGENT_WRITE_COMPLETE: undefined;
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
    AGENT_RESPONSE_COMPLETE: 'SENDING_TO_CLIENT',
    ERROR_OCCURRED: 'ERROR',
    CLEANUP_REQUESTED: 'CLOSING',               // Socket close hadError=false
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
    CLEANUP_REQUESTED: 'CLOSING',               // Socket close hadError=false
  },
  BUFFERING_INQUIRE: {
    CLIENT_DATA_PARTIAL: 'BUFFERING_INQUIRE',
    CLIENT_DATA_COMPLETE: 'SENDING_TO_AGENT',
    ERROR_OCCURRED: 'ERROR',
    CLEANUP_REQUESTED: 'CLOSING',               // Socket close hadError=false
  },
  SENDING_TO_AGENT: {
    AGENT_WRITE_COMPLETE: 'WAITING_FOR_AGENT',
    ERROR_OCCURRED: 'ERROR',
    CLEANUP_REQUESTED: 'CLOSING',               // Socket close hadError=false
  },
  WAITING_FOR_AGENT: {
    AGENT_RESPONSE_COMPLETE: 'SENDING_TO_CLIENT',
    ERROR_OCCURRED: 'ERROR',
    CLEANUP_REQUESTED: 'CLOSING',               // Socket close hadError=false
  },
  SENDING_TO_CLIENT: {
    RESPONSE_OK_OR_ERR: 'READY',
    RESPONSE_INQUIRE: 'BUFFERING_INQUIRE',
    ERROR_OCCURRED: 'ERROR',
    CLEANUP_REQUESTED: 'CLOSING',               // Socket close hadError=false
  },
  ERROR: {
    CLEANUP_REQUESTED: 'CLOSING',               // Always hadError=true from ERROR
  },
  CLOSING: {
    CLEANUP_COMPLETE: 'DISCONNECTED',
    CLEANUP_ERROR: 'FATAL',                     // Unrecoverable cleanup failure
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


/**
 * RequestSessionManager - Event-driven session manager (like NodeJS Socket)
 *
 * Manages state, buffer, and event handling for a single client connection.
 * Events drive state transitions and processing logic.
 * Handlers are registered for events (like socket.on('data', handler))
 */
class RequestSessionManager extends EventEmitter implements ISessionManager {
    public readonly config: RequestProxyConfigWithExecutor;
    public socket: net.Socket;
    public readonly sessionId: string;
    private state: SessionState = 'DISCONNECTED';
    private buffer: string = '';
    private lastCommand: string = '';  // First token (verb) of the most recent command sent to agent (e.g. 'BYE')

    constructor(config: RequestProxyConfigWithExecutor, socket: net.Socket, sessionId: string) {
        super();
        this.config = config;
        this.socket = socket;
        this.sessionId = sessionId;

        // Register event handlers for session lifecycle
        // Use .once() for single-fire events, .on() for events that can fire multiple times

        // Single-fire initialization events
        this.once('CLIENT_SOCKET_CONNECTED', this.handleClientSocketConnected.bind(this));

        // Multi-fire data/command events (multiple writes and data chunks per session)
        this.on('CLIENT_DATA_START', this.handleClientDataStart.bind(this));
        this.on('CLIENT_DATA_PARTIAL', this.handleClientDataPartial.bind(this));
        this.on('CLIENT_DATA_COMPLETE', this.handleClientDataComplete.bind(this));
        this.on('AGENT_WRITE_COMPLETE', this.handleAgentWriteComplete.bind(this));
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
        log(this.config, `[${this.sessionId}] Client socket connected, connecting to GPG Agent Proxy...`);

        try {
            // Connect to agent-proxy, passing our pre-minted sessionId as a hint so
            // both extensions log the same UUID for this end-to-end session.
            const result = await this.config.commandExecutor.connectAgent(this.sessionId);
            log(this.config, `[${this.sessionId}] Connected to GPG Agent Proxy`);

            // Treat agent greeting as the first AGENT_RESPONSE_COMPLETE, then resume socket
            if (result.greeting) {
                this.emit('AGENT_RESPONSE_COMPLETE', result.greeting);
                // Resume socket now that greeting has been forwarded to the client
                this.socket.resume();
            } else {
                this.emit('ERROR_OCCURRED', 'Agent connect failed: No greeting received');
            }
        } catch (err) {
            const msg = extractErrorMessage(err);
            this.emit('ERROR_OCCURRED', `Agent connect failed: ${msg}`);
        }
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

        // Track first token of last command so BYE can trigger graceful close after OK/ERR response.
        this.lastCommand = data.split(/\s/, 1)[0].toUpperCase();

        // Send to agent
        this.sendToAgent(data);
    }

    private handleAgentWriteComplete(): void {
        // AGENT_WRITE_COMPLETE only used for agent communication path
        this.transition('AGENT_WRITE_COMPLETE');
        log(this.config, `[${this.sessionId}] Write to agent complete, waiting for response`);
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
        this.transition('RESPONSE_OK_OR_ERR');

        // BYE: gpg-agent closes its TCP socket after sending 'OK closing connection'.
        // Some clients like gpg itself wait for the socket to close before exiting.
        // agent-proxy's session self-cleans silently after sendCommands() already resolved,
        // so there is no cross-extension signal to rely on which causes clients like gpg
        // to deadlock waiting on the socket to close. Therefore, request-proxy must initiate
        // graceful close of the client Unix socket hereto prevent deadlock.
        if (this.lastCommand === 'BYE') {
            log(this.config, `[${this.sessionId}] BYE acknowledged — closing client socket`);
            this.emit('CLEANUP_REQUESTED', false);
            return;
        }

        log(this.config, `[${this.sessionId}] Response OK/ERR processed, returning to READY`);

        // Check for pipelined data
        this.checkPipelinedData();
    }

    private handleResponseInquire(response: string): void {
        this.transition('RESPONSE_INQUIRE');
        log(this.config, `[${this.sessionId}] Response contains INQUIRE, waiting for client data`);
    }

    private handleErrorOccurred(error: string): void {
        this.transition('ERROR_OCCURRED');
        log(this.config, `[${this.sessionId}] ${error}`);

        // Start cleanup sequence
        this.emit('CLEANUP_REQUESTED', true);
    }

    private async handleCleanupRequested(hadError: boolean): Promise<void> {
        this.transition('CLEANUP_REQUESTED');
        log(this.config, `[${this.sessionId}] Starting cleanup (hadError=${hadError})`);

        // Remove all operational event handlers before the first await.
        // Any in-flight async operations (connectAgent, sendCommands, writeToClient callbacks)
        // may resume on the next microtask tick and emit events — those emissions must be
        // silently ignored now that the session is in CLOSING state.
        // CLEANUP_COMPLETE and CLEANUP_ERROR listeners are intentionally preserved.
        const retain = new Set(['CLEANUP_COMPLETE', 'CLEANUP_ERROR']);
        this.eventNames()
            .filter(name => !retain.has(name as string))
            .forEach(name => this.removeAllListeners(name));

        // Disconnect from agent (sessionId is always set at construction)
        let cleanupError: unknown = null;
        try {
            await this.config.commandExecutor.disconnectAgent(this.sessionId);
            log(this.config, `[${this.sessionId}] Disconnected from agent`);
        } catch (err) {
            // socket or session manager may be in unexpected state during cleanup failure
            cleanupError = err;
        }
        this.buffer = '';

        // Cleanup socket using shared utility because Javascript has no destructors :-(
        const socketError = cleanupSocket(this.socket, this.config, this.sessionId);
        cleanupError = cleanupError ?? socketError;

        if (cleanupError) {
            this.emit('CLEANUP_ERROR', extractErrorMessage(cleanupError));
        } else {
            this.emit('CLEANUP_COMPLETE');
        }
        try {
            this.removeAllListeners();
        } catch {
            log(this.config, `[${this.sessionId}] Error: failed to remove session event listeners during cleanup`);
        }
    }

    private handleCleanupComplete(): void {
        this.transition('CLEANUP_COMPLETE');
        log(this.config, `[${this.sessionId}] Cleanup complete`);
    }

    private handleCleanupError(error: string): void {
        this.transition('CLEANUP_ERROR');
        log(this.config, `[${this.sessionId}] Fatal cleanup error: ${error}`);
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
            log(this.config, `[${this.sessionId}] ${error.message}`);
            throw error;
        }

        const oldState = this.state;
        this.state = nextState;
        log(this.config, `[${this.sessionId}] ${oldState} → ${nextState} (event: ${event})`);
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

            // Emit AGENT_WRITE_COMPLETE event (write successful)
            this.emit('AGENT_WRITE_COMPLETE');

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
                // No AGENT_WRITE_COMPLETE emission - response type events drive state transitions
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
 * RequestProxy - VS Code extension service for request proxying
 *
 * Class-based replacement for the startRequestProxy() factory function.
 * Manages a Unix socket server and a Map of active RequestSessionManager instances.
 * Mirrors the AgentProxy class structure in agent-proxy.
 *
 * @param config - Configuration with optional logging callback
 * @param deps - Optional dependency injection for testing
 *
 * @throws Error from start() if GPG socket path cannot be determined
 * @throws Error from start() if socket already in use (another proxy running)
 * @throws Error from start() if permission errors creating/binding socket
 *
 * @example
 * ```typescript
 * const proxy = new RequestProxy({ logCallback: (msg) => console.log(msg) });
 * await proxy.start();
 *
 * // Later: stop the server
 * await proxy.stop();
 * ```
 *
 * **Flow (start):**
 * 1. Detects GPG socket path via `gpgconf --list-dirs agent-socket`
 * 2. Creates Unix socket server at detected path
 * 3. Sets socket permissions to 0o666 (world-writable for GPG access)
 * 4. Starts listening; each connection mints a UUID and creates a
 *    RequestSessionManager with that sessionId so both extensions log the same id
 *
 * **State Machine:**
 * - 11 states: DISCONNECTED → CONNECTING_TO_AGENT → SENDING_TO_CLIENT → READY → buffering/sending cycle
 * - 12 events: client data, agent responses, writes, errors, cleanup
 * - Independent state machines per client (concurrent sessions supported)
 * - INQUIRE D-block buffering: handles GPG's interactive data requests
 * - Error consolidation: all errors → ERROR_OCCURRED → cleanup
 *
 * **Session Management:**
 * - Sessions stored in Map<string, RequestSessionManager> keyed by pre-minted UUID
 * - Each session: isolated state, buffer, sessionId set at construction
 * - Cleanup guarantees: socket destroyed, agent disconnected, session removed
 * - First-error-wins cleanup pattern (continues even if steps fail)
 *
 * **Testing:**
 * Use dependency injection to mock VS Code commands, socket server, and file system.
 * Enables testing without VS Code runtime or real sockets/files.
 */
export class RequestProxy {
    private readonly config: RequestProxyConfig;
    private readonly commandExecutor: ICommandExecutor;
    private readonly serverFactory: IServerFactory;
    private readonly fileSystem: IFileSystem;
    private readonly getSocketPathFn: () => Promise<string | null>;
    private readonly usingMocks: boolean;
    private sessions: Map<string, RequestSessionManager> = new Map();
    private server: net.Server | null = null;
    private _socketPath: string | null = null;

    constructor(config: RequestProxyConfig, deps?: RequestProxyDeps) {
        this.config = config;
        this.commandExecutor = deps?.commandExecutor ?? new VSCodeCommandExecutor();
        this.serverFactory = deps?.serverFactory ?? { createServer: net.createServer };
        this.fileSystem = deps?.fileSystem ?? { existsSync: fs.existsSync, readFileSync: fs.readFileSync, mkdirSync: fs.mkdirSync, chmodSync: fs.chmodSync, unlinkSync: fs.unlinkSync };
        this.getSocketPathFn = deps?.getSocketPath ?? getLocalGpgSocketPath;
        this.usingMocks = !!(deps?.serverFactory || deps?.fileSystem);
    }

    /** Socket path this proxy is listening on, or null if not started */
    getSocketPath(): string | null { return this._socketPath; }

    /** True if the server is currently running */
    isRunning(): boolean { return this.server !== null; }

    /** Number of active client sessions */
    getSessionCount(): number { return this.sessions.size; }

    /**
     * Start the request proxy server.
     *
     * Resolves when the server is bound and listening. Rejects if the socket path
     * cannot be determined, the socket is already in use, or permissions fail.
     */
    async start(): Promise<void> {
        const fullConfig: RequestProxyConfigWithExecutor = {
            ...this.config,
            commandExecutor: this.commandExecutor,
        };

        log(fullConfig, `[RequestProxy.start] using mocked deps: ${this.usingMocks}`);

        const socketPath = await this.getSocketPathFn();
        if (!socketPath) {
            throw new Error('Could not determine local GPG socket path. Is gpg installed? Try: gpgconf --list-dirs');
        }

        // Ensure parent directory exists
        log(fullConfig, `Creating socket server at ${socketPath}`);
        const socketDir = path.dirname(socketPath);
        if (!this.fileSystem.existsSync(socketDir)) {
            this.fileSystem.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
        }

        this._socketPath = socketPath;

        // Create the Unix socket server
        const server = this.serverFactory.createServer({ pauseOnConnect: true }, (clientSocket) => {
            // Mint UUID now so both extensions log the same identifier for this session
            const sessionId = uuidv4();
            const session = new RequestSessionManager(fullConfig, clientSocket, sessionId);
            this.sessions.set(sessionId, session);

            // Attach socket event handlers

            // 'close' fires when the socket is fully closed and resources are released
            // hadError arg indicates if it closed because of an error
            // event sequences:
            // - OS error: 'error' -> 'close'
            // - graceful remote shutdown: 'end' -> 'close'
            // - local shutdown: socket.end() -> 'close'
            // - local destroy without arg: socket.destroy() -> 'close'
            clientSocket.once('close', (hadError: boolean) => {
                log(session.config, `[${session.sessionId}] Client socket closed (hadError=${hadError})`);

                // Emit event to state machine for validated cleanup
                if (hadError) {
                    // Transmission error during socket I/O
                    session.emit('ERROR_OCCURRED', 'Socket closed with transmission error');
                } else {
                    // Clean/graceful socket close
                    session.emit('CLEANUP_REQUESTED', hadError);
                }
            });

            // 'error' fires when the OS reports a failure (ECONNRESET, EPIPE, etc.)
            // or when the err arg of destroy() is used
            // node does not automatically destroy the socket on 'error' event
            // event sequences:
            // - OS error: 'error' -> 'close'
            // - local destroy with arg `socket.destroy(err)`: 'error' -> 'close'
            clientSocket.once('error', (err: Error) => {
                log(session.config, `[${session.sessionId}] Client socket error: ${err.message}`);
                // Error event is logged; 'close' event will trigger cleanup
            });

            // 'readable' fires when data is available to read from the socket
            clientSocket.on('readable', () => {
                let chunk: Buffer | null;
                while ((chunk = clientSocket.read()) !== null) {
                    // Let session manager determine appropriate event based on current state
                    session.handleIncomingData(chunk);
                }
            });

            // Remove from sessions map when the session finishes cleanup (any exit path)
            session.once('CLEANUP_COMPLETE', () => this.sessions.delete(sessionId));
            session.once('CLEANUP_ERROR',    () => this.sessions.delete(sessionId));

            // Start connection sequence - emit initial event and let handlers do the work
            log(fullConfig, 'Client connected to socket. Socket is paused while initiating connection to GPG Agent Proxy');
            session.emit('CLIENT_SOCKET_CONNECTED');
        });

        this.server = server;

        // Handle server errors, only logging for now
        server.on('error', (err: Error) => {
            log(this.config, `Socket server error: ${err.message}`);
        });

        return new Promise((resolve, reject) => {
            server.listen(socketPath, () => {
                // Make socket readable/writable by all users
                try {
                    this.fileSystem.chmodSync(socketPath, 0o666);
                } catch (err) {
                    log(this.config, `Warning: could not chmod socket: ${err}`);
                }

                log(this.config, 'Request proxy listening');
                resolve();
            });

            server.on('error', reject);
        });
    }

    /**
     * Stop the request proxy server.
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
    async stop(): Promise<void> {
        const server = this.server;
        if (!server) {
            return;
        }
        this.server = null;

        return new Promise((stopResolve) => {
            // Stop accepting new connections, then destroy all active sessions.
            // server.close() only calls its callback once all connections are gone;
            // without explicit cleanup it would hang on any open client socket.
            server.close(() => {
                if (this._socketPath) {
                    try {
                        this.fileSystem.unlinkSync(this._socketPath);
                    } catch (err) {
                        // Ignore
                    }
                }
                log(this.config, 'Request proxy stopped');
                stopResolve();
            });

            // Emit CLEANUP_REQUESTED on every live session so their sockets
            // close, which unblocks server.close() above.
            for (const session of this.sessions.values()) {
                session.emit('CLEANUP_REQUESTED', false);
            }
        });
    }
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
