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
import { EventEmitter } from 'events';
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
 * State machine events (14 total)
 */
type StateEvent =
  | { type: 'CLIENT_SOCKET_CONNECTED' }
  | { type: 'START_AGENT_CONNECT' }
  | { type: 'AGENT_GREETING_OK'; greeting: string }
  | { type: 'CLIENT_DATA_START'; data: Buffer }
  | { type: 'CLIENT_DATA_PARTIAL'; data: Buffer }
  | { type: 'CLIENT_DATA_COMPLETE'; data: string }
  | { type: 'ERROR_OCCURRED'; error: string }
  | { type: 'WRITE_OK' }
  | { type: 'AGENT_RESPONSE_COMPLETE'; response: string }
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
    'ERROR_OCCURRED': 'ERROR',
  },
  READY: {
    'CLIENT_DATA_START': 'BUFFERING_COMMAND',
  },
  BUFFERING_COMMAND: {
    'CLIENT_DATA_PARTIAL': 'BUFFERING_COMMAND',
    'CLIENT_DATA_COMPLETE': 'SENDING_TO_AGENT',
    'ERROR_OCCURRED': 'ERROR',
  },
  BUFFERING_INQUIRE: {
    'CLIENT_DATA_PARTIAL': 'BUFFERING_INQUIRE',
    'CLIENT_DATA_COMPLETE': 'SENDING_TO_AGENT',
    'ERROR_OCCURRED': 'ERROR',
  },
  SENDING_TO_AGENT: {
    'WRITE_OK': 'WAITING_FOR_AGENT',
    'ERROR_OCCURRED': 'ERROR',
  },
  WAITING_FOR_AGENT: {
    'AGENT_RESPONSE_COMPLETE': 'SENDING_TO_CLIENT',
    'ERROR_OCCURRED': 'ERROR',
  },
  SENDING_TO_CLIENT: {
    'WRITE_OK': 'READY',
    'ERROR_OCCURRED': 'ERROR',
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

/**
 * ClientSessionManager - Event-driven session manager (like NodeJS Socket)
 *
 * Manages state, buffer, and event handling for a single client connection.
 * Events drive state transitions and processing logic.
 * Handlers are registered for events (like socket.on('data', handler))
 */
class ClientSessionManager extends EventEmitter {
    private config: RequestProxyConfigWithExecutor;
    public socket: net.Socket;
    public sessionId: string | null = null;
    private state: ClientState = 'DISCONNECTED';
    private buffer: string = '';

    constructor(config: RequestProxyConfigWithExecutor, socket: net.Socket) {
        super();
        this.config = config;
        this.socket = socket;

        // Register event handlers (like socket.on('event', handler))

        this.on('CLIENT_SOCKET_CONNECTED', this.handleClientSocketConnected.bind(this));
        this.on('START_AGENT_CONNECT', this.handleStartAgentConnect.bind(this));
        this.on('AGENT_GREETING_OK', this.handleAgentGreetingOk.bind(this));
        this.on('CLIENT_DATA_START', this.handleClientDataStart.bind(this));
        this.on('CLIENT_DATA_PARTIAL', this.handleClientDataPartial.bind(this));
        this.on('CLIENT_DATA_COMPLETE', this.handleClientDataComplete.bind(this));
        this.on('ERROR_OCCURRED', this.handleErrorOccurred.bind(this));
        this.on('WRITE_OK', this.handleWriteOk.bind(this));
        this.on('AGENT_RESPONSE_COMPLETE', this.handleAgentResponseComplete.bind(this));
        this.on('RESPONSE_OK_OR_ERR', this.handleResponseOkOrErr.bind(this));
        this.on('RESPONSE_INQUIRE', this.handleResponseInquire.bind(this));
        this.on('CLEANUP_START', this.handleCleanupStart.bind(this));
        this.on('CLEANUP_COMPLETE', this.handleCleanupComplete.bind(this));
        this.on('CLEANUP_ERROR', this.handleCleanupError.bind(this));
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
        const validStates: ClientState[] = ['READY', 'BUFFERING_COMMAND', 'BUFFERING_INQUIRE'];

        // Check for protocol violation - client sending data in invalid state
        if (!validStates.includes(this.state)) {
            this.emit('ERROR_OCCURRED', `Protocol violation: client sent ${chunk.length} bytes in state ${this.state}`);
            return;
        }

        // Determine event type based on current state
        if (this.state === 'READY') {
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

    private handleClientSocketConnected(): void {
        this.setState('CLIENT_CONNECTED');
        log(this.config, `[${this.sessionId ?? 'pending'}] Client socket connected`);

        // Start agent connection sequence
        this.emit('START_AGENT_CONNECT');
    }

    private async handleStartAgentConnect(): Promise<void> {
        this.setState('AGENT_CONNECTING');
        log(this.config, `[${this.sessionId ?? 'pending'}] Connecting to GPG Agent Proxy via command...`);

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
        this.setState('READY');
        log(this.config, `[${this.sessionId}] Agent greeting: ${sanitizeForLog(greeting)}`);
        this.writeToClient(greeting, `Sending greeting to client: ${sanitizeForLog(greeting)}`);

        // Resume socket after greeting is sent - client can now send commands
        this.socket.resume();
    }

    private handleClientDataStart(data: Buffer): void {
        this.setState('BUFFERING_COMMAND');
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
            if (this.state === 'BUFFERING_COMMAND') {
                this.checkCommandComplete();
            } else if (this.state === 'BUFFERING_INQUIRE') {
                this.checkInquireComplete();
            }
        } catch (err) {
            const msg = extractErrorMessage(err);
            this.emit('ERROR_OCCURRED', `Buffer error during CLIENT_DATA_PARTIAL: ${msg}`);
        }
    }

    private handleClientDataComplete(data: string): void {
        this.setState('SENDING_TO_AGENT');
        log(this.config, `[${this.sessionId}] Data complete: ${sanitizeForLog(data)}`);

        // Send to agent
        this.sendToAgent(data);
    }

    private handleWriteOk(): void {
        if (this.state === 'SENDING_TO_AGENT') {
            this.setState('WAITING_FOR_AGENT');
            log(this.config, `[${this.sessionId}] Write to agent OK, waiting for response`);
        } else if (this.state === 'SENDING_TO_CLIENT') {
            // Response written to client, return to READY
            this.setState('READY');
            log(this.config, `[${this.sessionId}] Write to client OK, ready for next command`);

            // Check for pipelined data
            this.checkPipelinedData();
        }
    }

    private handleAgentResponseComplete(response: string): void {
        this.setState('SENDING_TO_CLIENT');
        log(this.config, `[${this.sessionId}] Agent response: ${sanitizeForLog(response)}`);

        // Write response to client and emit appropriate event
        this.writeToClient(response, `Proxying agent response: ${sanitizeForLog(response)}`);

        // Determine next event based on response type
        if (/(^|\n)INQUIRE/.test(response)) {
            this.emit('RESPONSE_INQUIRE', response);
        } else {
            this.emit('RESPONSE_OK_OR_ERR', response);
        }
    }

    private handleResponseOkOrErr(response: string): void {
        // WRITE_OK handler will transition to READY
        log(this.config, `[${this.sessionId}] Response OK/ERR processed`);
    }

    private handleResponseInquire(response: string): void {
        this.setState('BUFFERING_INQUIRE');
        log(this.config, `[${this.sessionId}] Response contains INQUIRE, waiting for client data`);
    }

    private handleErrorOccurred(error: string): void {
        this.setState('ERROR');
        log(this.config, `[${this.sessionId ?? 'pending'}] ${error}`);

        // Start cleanup sequence
        this.emit('CLEANUP_START');
    }

    private async handleCleanupStart(): Promise<void> {
        this.setState('CLOSING');
        log(this.config, `[${this.sessionId ?? 'pending'}] Starting cleanup`);

        // Disconnect from agent if we have a session
        if (this.sessionId) {
            try {
                await this.config.commandExecutor.disconnectAgent(this.sessionId);
                log(this.config, `[${this.sessionId}] Disconnected from agent`);
                this.emit('CLEANUP_COMPLETE');
            } catch (err) {
                const msg = extractErrorMessage(err);
                this.emit('CLEANUP_ERROR', msg);
            }
        } else {
            // No session, cleanup complete
            this.emit('CLEANUP_COMPLETE');
        }
    }

    private handleCleanupComplete(): void {
        this.setState('DISCONNECTED');
        log(this.config, `[${this.sessionId ?? 'pending'}] Cleanup complete`);

        // Destroy socket
        try {
            this.socket.destroy();
        } catch (err) {
            // Ignore
        }
    }

    private handleCleanupError(error: string): void {
        this.setState('FATAL');
        log(this.config, `[${this.sessionId ?? 'pending'}] Fatal cleanup error: ${error}`);

        // Force destroy socket
        try {
            this.socket.destroy();
        } catch (err) {
            // Ignore
        }
    }

    // ========================================================================
    // Helper Methods
    // ========================================================================

    private setState(newState: ClientState): void {
        const oldState = this.state;
        this.state = newState;
        if (oldState !== newState) {
            log(this.config, `[${this.sessionId ?? 'pending'}] ${oldState} --> ${newState}`);
        }
    }

    /**
     * Check if buffered command is complete (ends with \n)
     * If complete, emit CLIENT_DATA_COMPLETE event
     */
    private checkCommandComplete(): void {
        const delimiterIndex = this.buffer.indexOf('\n');
        if (delimiterIndex !== -1) {
            // Extract command including newline
            const command = this.buffer.substring(0, delimiterIndex + 1);
            this.buffer = this.buffer.substring(delimiterIndex + 1);

            // Emit CLIENT_DATA_COMPLETE event
            this.emit('CLIENT_DATA_COMPLETE', command);
        }
    }

    /**
     * Check if buffered inquire data is complete (ends with END\n)
     * If complete, emit CLIENT_DATA_COMPLETE event
     */
    private checkInquireComplete(): void {
        const delimiterIndex = this.buffer.indexOf('END\n');
        if (delimiterIndex !== -1) {
            // Extract D-block including END\n
            const inquireData = this.buffer.substring(0, delimiterIndex + 4); // 'END\n' is 4 chars
            this.buffer = this.buffer.substring(delimiterIndex + 4);

            // Emit CLIENT_DATA_COMPLETE event
            this.emit('CLIENT_DATA_COMPLETE', inquireData);
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
            const delimiterIndex = this.buffer.indexOf('\n');
            if (delimiterIndex !== -1) {
                // Have complete command, emit CLIENT_DATA_START to process it
                this.emit('CLIENT_DATA_START', Buffer.from([])); // Empty buffer since data already in this.buffer
            }
        }
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

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
        // Create session manager (EventEmitter pattern like NodeJS Socket)
        const sessionManager = new ClientSessionManager(fullConfig, clientSocket);

        // 'close' fires when the socket is fully closed and resources are released
        // hadError arg indicates if it closed because of an error
        // event sequences:
        // - OS error: 'error' -> 'close'
        // - graceful remote shutdown: 'end' -> 'close'
        // - local shutdown: socket.end() -> 'close'
        // - local destroy without arg: socket.destroy() -> 'close'
        clientSocket.on('close', () => {
            log(fullConfig, `[${sessionManager.sessionId ?? 'pending'}] Client socket closed`);
            // Clean up session
            if (sessionManager.sessionId) {
                fullConfig.commandExecutor.disconnectAgent(sessionManager.sessionId).catch((err) => {
                    log(fullConfig, `[${sessionManager.sessionId}] Disconnect error: ${extractErrorMessage(err)}`);
                });
            }
        });

        // 'error' fires when the OS reports a failure (ECONNRESET, EPIPE, etc.)
        // or when the err arg of destroy() is used
        // node does not automatically destroy the socket on 'error' event
        // event sequences:
        // - OS error: 'error' -> 'close'
        // - local destroy with arg `socket.destroy(err)`: 'error' -> 'close'
        clientSocket.on('error', (err: Error) => {
            log(fullConfig, `[${sessionManager.sessionId ?? 'pending'}] Client socket error: ${err.message}`);
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
