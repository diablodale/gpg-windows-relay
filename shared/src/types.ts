/**
 * Shared type definitions and dependency injection interfaces.
 * These types are used by both agent-proxy and request-proxy extensions.
 */

import * as net from 'net';

/**
 * Configuration for logging callbacks.
 * Implemented by both AgentProxyConfig and RequestProxyConfig.
 */
export interface LogConfig {
    /**
     * Optional callback for logging messages.
     * Called instead of console.log to allow integration with VS Code output channels.
     */
    logCallback?: (message: string) => void;
}

/**
 * Abstraction for file system operations.
 * Allows injection of mock implementations for testing.
 */
export interface IFileSystem {
    /**
     * Check if a file exists at the given path.
     */
    existsSync(path: string): boolean;

    /**
     * Read file contents as a Buffer.
     */
    readFileSync(path: string): Buffer;

    /**
     * Create a directory, optionally recursively.
     */
    mkdirSync(path: string, options?: { recursive: boolean; mode?: number }): void;

    /**
     * Change file/directory permissions.
     */
    chmodSync(path: string, mode: number): void;

    /**
     * Delete a file.
     */
    unlinkSync(path: string): void;
}

/**
 * Abstraction for creating TCP sockets.
 * Allows injection of mock implementations for testing.
 */
export interface ISocketFactory {
    /**
     * Create a TCP connection to a remote host.
     */
    createConnection(
        options: { host: string; port: number },
        connectionListener?: () => void
    ): net.Socket;
}

/**
 * Abstraction for VS Code command execution.
 * Used by request-proxy to communicate with agent-proxy extension.
 * Allows injection of mock implementations for testing.
 */
export interface ICommandExecutor {
    /**
     * Connect to the GPG agent via agent-proxy extension.
     * Returns a unique session ID and the agent's greeting message.
     */
    connectAgent(): Promise<{ sessionId: string; greeting: string }>;

    /**
     * Send Assuan protocol commands to the GPG agent.
     * Returns the agent's response.
     */
    sendCommands(sessionId: string, commandBlock: string): Promise<{ response: string }>;

    /**
     * Disconnect and clean up a session with the agent-proxy extension.
     */
    disconnectAgent(sessionId: string): Promise<void>;
}

/**
 * Abstraction for creating Unix socket servers.
 * Allows injection of mock implementations for testing.
 */
export interface IServerFactory {
    /**
     * Create a Unix domain socket server.
     */
    createServer(
        options: net.ServerOpts,
        connectionListener: (socket: net.Socket) => void
    ): net.Server;
}

/**
 * Client state machine states for request-proxy.
 * DISCONNECTED: Initial state, not yet connected to agent-proxy
 * SEND_COMMAND: Ready to receive Assuan commands from client
 * WAIT_RESPONSE: Waiting for agent response to previous command
 * INQUIRE_DATA: Collecting data for INQUIRE response (D lines + END)
 */
export type ClientState = 'DISCONNECTED' | 'SEND_COMMAND' | 'WAIT_RESPONSE' | 'INQUIRE_DATA';
