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
     * Connect to GPG agent and return a sessionId
     * On Windows, reads the socket file to extract port and nonce, then connects via TCP
     * Waits for nonce to be sent and greeting to be received before returning
     */
    public async connectAgent(): Promise<string> {
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
            const nonce = socketData.slice(nonceStart, nonceStart + 16);

            if (nonce.length !== 16) {
                throw new Error(`Invalid nonce length: expected 16 bytes, got ${nonce.length}`);
            }

            this.log(`Connecting to localhost:${port} with nonce`);

            // Connect to localhost:port
            const socket = net.createConnection({
                host: 'localhost',
                port: port
            });

            // Wait for connection, send nonce, and read greeting
            await new Promise<void>((resolve, reject) => {
                const connectionTimeout = setTimeout(() => {
                    socket.destroy();
                    this.sessions.delete(sessionId);
                    reject(new Error('Connection timeout: greeting not received within 5 seconds'));
                }, 5000);

                const errorHandler = (error: Error) => {
                    clearTimeout(connectionTimeout);
                    this.log(`Session ${sessionId} socket error: ${error.message}`);
                    this.sessions.delete(sessionId);
                    reject(error);
                };

                const closeHandler = () => {
                    clearTimeout(connectionTimeout);
                    this.log(`Session ${sessionId} socket closed during initialization`);
                    this.sessions.delete(sessionId);
                    reject(new Error('Socket closed before initialization completed'));
                };

                const connectHandler = () => {
                    this.log(`Session ${sessionId} connected, sending nonce`);
                    socket.write(nonce);
                };

                const dataHandler = (chunk: Buffer) => {
                    clearTimeout(connectionTimeout);
                    const greetingLine = chunk.toString('utf-8').trim();
                    this.log(`Session ${sessionId} received greeting: ${greetingLine}`);

                    // Verify greeting starts with OK
                    if (!greetingLine.startsWith('OK ')) {
                        socket.off('error', errorHandler);
                        socket.off('close', closeHandler);
                        socket.off('data', dataHandler);
                        socket.destroy();
                        this.sessions.delete(sessionId);
                        reject(new Error(`Invalid greeting from agent: ${greetingLine}`));
                        return;
                    }

                    // Greeting received successfully, prepare for commands
                    socket.off('error', errorHandler);
                    socket.off('close', closeHandler);
                    socket.off('data', dataHandler);
                    resolve();
                };

                socket.once('error', errorHandler);
                socket.once('close', closeHandler);
                socket.once('connect', connectHandler);
                socket.once('data', dataHandler);
            });

            this.sessions.set(sessionId, {
                socket: socket,
                responseBuffer: ''
            });

            // Set up error/close handlers for after connection
            socket.on('error', (error) => {
                this.log(`Session ${sessionId} socket error: ${error.message}`);
                this.sessions.delete(sessionId);
            });

            socket.on('close', () => {
                this.log(`Session ${sessionId} socket closed`);
                this.sessions.delete(sessionId);
            });

            this.log(`Session ${sessionId} connected successfully`);
            return sessionId;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            const fullMsg = msg || 'Unknown error during connection';
            this.log(`Session ${sessionId} connection failed: ${fullMsg}`);
            throw new Error(`Failed to connect to GPG agent: ${fullMsg}`);
        }
    }

    /**
     * Send command block to GPG agent and return response
     *
     * Command block is a complete request (e.g., "GETINFO version\n" or "D data\nEND\n")
     * Response is all lines returned by agent until complete (buffered internally)
     */
    public sendCommands(sessionId: string, commandBlock: string): Promise<{ response: string }> {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return Promise.reject(new Error(`Invalid session: ${sessionId}`));
        }

        this.log(`Session ${sessionId} sending: ${commandBlock.replace(/\n/g, '\\n')}`);

        return new Promise((resolve, reject) => {
            let responseData = '';
            const isInquireBlock = commandBlock.startsWith('D ');

            const dataHandler = (chunk: Buffer) => {
                const chunkStr = chunk.toString('utf-8');
                responseData += chunkStr;
                this.log(`Session ${sessionId} data chunk: ${chunkStr.replace(/\n/g, '\\n')}`);

                // Check if we have a complete response
                if (this.isCompleteResponse(responseData, isInquireBlock)) {
                    session.socket.removeListener('data', dataHandler);
                    session.socket.removeListener('error', errorHandler);
                    session.socket.removeListener('close', closeHandler);

                    this.log(`Session ${sessionId} response complete: ${responseData.replace(/\n/g, '\\n')}`);
                    resolve({ response: responseData });
                } else {
                    this.log(`Session ${sessionId} waiting for more data... (buffer: ${responseData.replace(/\n/g, '\\n')})`);
                }
            };

            const errorHandler = (error: Error) => {
                session.socket.removeListener('data', dataHandler);
                session.socket.removeListener('close', closeHandler);
                this.log(`Session ${sessionId} socket error: ${error.message}`);
                // Clean up session on error
                this.sessions.delete(sessionId);
                reject(new Error(`Socket error: ${error.message}`));
            };

            const closeHandler = () => {
                session.socket.removeListener('data', dataHandler);
                session.socket.removeListener('error', errorHandler);
                this.log(`Session ${sessionId} socket closed unexpectedly`);
                // Clean up session on close
                this.sessions.delete(sessionId);
                reject(new Error('Socket closed unexpectedly'));
            };

            // Set up listeners
            session.socket.on('data', dataHandler);
            session.socket.once('error', errorHandler);
            session.socket.once('close', closeHandler);

            // Send the command block
            try {
                session.socket.write(commandBlock);
            } catch (error) {
                session.socket.removeListener('data', dataHandler);
                session.socket.removeListener('error', errorHandler);
                session.socket.removeListener('close', closeHandler);
                const msg = error instanceof Error ? error.message : String(error);
                this.log(`Session ${sessionId} failed to write: ${msg}`);
                // Clean up session on write failure
                this.sessions.delete(sessionId);
                reject(new Error(`Failed to write to socket: ${msg}`));
            }
        });
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

