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
    logCallback?: (message: string) => void;
    statusBarCallback?: () => void;
}

interface SessionSocket {
    socket: net.Socket;
}

export class AgentProxy {
    private sessions: Map<string, SessionSocket> = new Map();

    constructor(private config: AgentProxyConfig) {
        // Validate socket path exists
        if (!fs.existsSync(config.gpgAgentSocketPath)) {
            throw new Error(`GPG agent socket not found: ${config.gpgAgentSocketPath}`);
        }
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
     * Connect to GPG agent and return a sessionId and greeting
     * On Windows, reads the socket file to extract port and nonce, then connects via TCP
     * Waits for nonce to be sent and greeting to be received before returning
     */
    public async connectAgent(): Promise<{ sessionId: string; greeting: string }> {
        const sessionId = uuidv4();
        let socket!: net.Socket;
        log(this.config, `[${sessionId}] Create session to gpg-agent...`);

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

            log(this.config, `[${sessionId}] Found config suggesting gpg-agent at localhost:${port} and expects nonce`);

            // Wait for connection and send nonce
            await new Promise<void>((resolve, reject) => {
                const rejectWith = (error: unknown, fallbackMessage: string) => {
                    const msg = error instanceof Error ? error.message : String(error || '');
                    reject(new Error(msg || fallbackMessage));
                };

                const connectHandler = () => {
                    log(this.config, `[${sessionId}] Connected to localhost:${port}, sending nonce...`);
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
                    rejectWith(undefined, 'Timeout: No connection and nonce sent within 5 seconds');
                }, 5000);

                // Pass connectHandler as callback to createConnection - no race condition
                socket = net.createConnection({
                    host: 'localhost',
                    port: port
                }, connectHandler);

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
            const msg = (error instanceof Error ? error.message : String(error)) || 'Unknown error during connection';
            log(this.config, `[${sessionId}] Connection to gpg-agent failed: ${msg}`);
            socket?.destroy();
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
                    reject(new Error(`Response timeout after ${timeoutMs}ms`));
                }, timeoutMs);
            }

            const dataHandler = (chunk: Buffer) => {
                // Use latin1 to preserve raw bytes without UTF-8 mangling
                const chunkStr = chunk.toString('latin1');
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
                    const msg = (error instanceof Error ? error.message : String(error)) || 'Unknown error during write';
                    log(this.config, `[${sessionId}] Send to gpg-agent failed: ${msg}`);
                    session.socket.destroy(error);
                }
            });
        } catch (error) {
            const msg = (error instanceof Error ? error.message : String(error)) || 'Unknown error during write';
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
            const msg = error instanceof Error ? error.message : String(error);
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

/**
 * Sanitize string for safe display in log output
 * Shows first command word and byte count to avoid overwhelming logs
 */
function sanitizeForLog(str: string): string {
    const firstWord = str.split(/[\s\n]/, 1)[0];
    const remainingBytes = str.length - firstWord.length -1; // -1 for the space/newline after first word
    return `${firstWord} and ${remainingBytes} more bytes`;
}

/**
 * Log helper
 */
function log(config: AgentProxyConfig, message: string): void {
    if (config.logCallback) {
        config.logCallback(message);
    }
}
