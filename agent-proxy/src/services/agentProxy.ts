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
import { v4 as uuidv4 } from 'uuid';

export interface AgentProxyConfig {
    gpgAgentSocketPath: string; // Path to Assuan socket file
    debugLogging: boolean;
}

interface SessionSocket {
    socket: net.Socket;
    responseBuffer: string;
}

export class AgentProxy {
    private sessions: Map<string, SessionSocket> = new Map();
    private logCallback?: (message: string) => void;

    constructor(private config: AgentProxyConfig) {
        // Validate socket path exists
        if (!fs.existsSync(config.gpgAgentSocketPath)) {
            throw new Error(`GPG agent socket not found: ${config.gpgAgentSocketPath}`);
        }
    }

    public setLogCallback(callback: (message: string) => void): void {
        this.logCallback = callback;
    }

    private log(message: string): void {
        if (this.config.debugLogging && this.logCallback) {
            this.logCallback(message);
        }
    }

    /**
     * Set up persistent error/close handlers for a session
     * These handlers log and clean up the session if the socket fails outside of active operations
     */
    private setupPersistentHandlers(sessionId: string, socket: net.Socket): void {
        socket.on('error', (error) => {
            this.log(`Session ${sessionId} socket error: ${error.message}`);
            this.sessions.delete(sessionId);
        });

        socket.on('close', () => {
            this.log(`Session ${sessionId} socket closed`);
            this.sessions.delete(sessionId);
        });
    }

    /**
     * Connect to GPG agent and return a sessionId and greeting
     * On Windows, reads the socket file to extract port and nonce, then connects via TCP
     * Waits for nonce to be sent and greeting to be received before returning
     */
    public async connectAgent(): Promise<{ sessionId: string; greeting: string }> {
        const sessionId = uuidv4();
        this.log(`Creating session: ${sessionId}`);

        try {
            // Read the socket file to get port and nonce (Windows Assuan format)
            const socketData = fs.readFileSync(this.config.gpgAgentSocketPath);

            // Parse: first line is port (ASCII), then raw 16-byte nonce
            const newlineIndex = socketData.indexOf('\n');
            if (newlineIndex === -1) {
                throw new Error('Invalid socket file format: no newline found');
            }

            const portStr = socketData.toString('utf-8', 0, newlineIndex);
            const port = parseInt(portStr, 10);

            if (isNaN(port)) {
                throw new Error(`Invalid port in socket file: ${portStr}`);
            }

            // Extract raw 16-byte nonce after the newline
            const nonceStart = newlineIndex + 1;
            const nonce = socketData.subarray(nonceStart, nonceStart + 16);

            if (nonce.length !== 16) {
                throw new Error(`Invalid nonce length: expected 16 bytes, got ${nonce.length}`);
            }

            this.log(`Connecting to localhost:${port} with nonce`);

            let socket!: net.Socket;

            // Wait for connection and send nonce
            await new Promise<void>((resolve, reject) => {
                const rejectWith = (error: unknown, fallbackMessage: string) => {
                    const msg = error instanceof Error ? error.message : String(error || '');
                    reject(new Error(msg || fallbackMessage));
                };

                const connectHandler = () => {
                    this.log(`Session ${sessionId} connected, sending nonce`);
                    try {
                        socket.write(nonce, (error) => {
                            clearTimeout(connectionTimeout);
                            if (error) {
                                rejectWith(error, 'Failed to send nonce');
                            } else {
                                resolve();
                            }
                        });
                    } catch (error) {
                        clearTimeout(connectionTimeout);
                        rejectWith(error, 'Failed to send nonce');
                    }
                };

                const connectionTimeout = setTimeout(() => {
                    socket.destroy();
                    rejectWith(undefined, 'Connection timeout: nonce not sent within 5 seconds');
                }, 5000);

                // Pass connectHandler as callback to createConnection - no race condition
                socket = net.createConnection({
                    host: 'localhost',
                    port: port
                }, connectHandler);

                // Set persistent handlers and add to sessions map
                this.setupPersistentHandlers(sessionId, socket);
                this.sessions.set(sessionId, {
                    socket: socket,
                    responseBuffer: ''
                });
            });

            // Wait for greeting with timeout, then verify it
            let greeting: string;
            try {
                greeting = await this.waitForResponse(sessionId, false, 5000);
                const greetingLine = greeting.trim();

                // Verify greeting starts with OK
                if (!greetingLine.startsWith('OK ')) {
                    socket.destroy();
                    this.sessions.delete(sessionId);
                    throw new Error(`Invalid greeting from agent: ${greetingLine}`);
                }

                this.log(`Session ${sessionId} received greeting: ${greetingLine}`);
            } catch (error) {
                socket.destroy();
                this.sessions.delete(sessionId);
                throw error;
            }

            this.log(`Session ${sessionId} connected successfully`);
            return { sessionId, greeting };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            const fullMsg = msg || 'Unknown error during connection';
            this.log(`Session ${sessionId} connection failed: ${fullMsg}`);
            this.sessions.delete(sessionId);
            throw new Error(`Failed to connect to GPG agent: ${fullMsg}`);
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
                    reject(new Error(`Response timeout after ${timeoutMs}ms`));
                }, timeoutMs);
            }

            const dataHandler = (chunk: Buffer) => {
                // Use latin1 to preserve raw bytes without UTF-8 mangling
                const chunkStr = chunk.toString('latin1');
                responseData += chunkStr;
                this.log(`Session ${sessionId} data chunk: ${chunkStr.replace(/\n/g, '\\n')}`);

                // Check if we have a complete response
                if (this.isCompleteResponse(responseData, isInquireBlock)) {
                    if (timeoutHandle) clearTimeout(timeoutHandle);
                    session.socket.removeListener('data', dataHandler);
                    session.socket.removeListener('close', closeHandler);
                    session.socket.removeListener('error', errorHandler);
                    this.log(`Session ${sessionId} response complete: ${responseData.replace(/\n/g, '\\n')}`);
                    resolve(responseData);
                } else {
                    this.log(`Session ${sessionId} waiting for more data... (buffer: ${responseData.replace(/\n/g, '\\n')})`);
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

        this.log(`Session ${sessionId} sending: ${commandBlock.replace(/\n/g, '\\n')}`);

        try {
            session.socket.write(commandBlock);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.log(`Session ${sessionId} failed to write: ${msg}`);
            this.sessions.delete(sessionId);
            throw new Error(`Failed to write to socket: ${msg}`);
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

        this.log(`Disconnecting session: ${sessionId}`);

        try {
            // Send BYE command and wait for response
            await this.sendCommands(sessionId, 'BYE\n');
            this.log(`Session ${sessionId} closed gracefully`);
        } catch (error) {
            // If BYE fails, log but continue with cleanup
            const msg = error instanceof Error ? error.message : String(error);
            this.log(`BYE failed for session ${sessionId}: ${msg}`);
        } finally {
            // Always destroy socket and cleanup
            session.socket.destroy();
            this.sessions.delete(sessionId);
        }
    }

    public isRunning(): boolean {
        return this.sessions.size > 0;
    }

    public getSessionCount(): number {
        return this.sessions.size;
    }
}

