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
     */
    public connectAgent(): string {
        const sessionId = uuidv4();
        this.log(`Creating session: ${sessionId}`);

        try {
            const socket = net.createConnection(this.config.gpgAgentSocketPath);

            socket.on('error', (error) => {
                this.log(`Session ${sessionId} socket error: ${error.message}`);
                this.sessions.delete(sessionId);
            });

            socket.on('close', () => {
                this.log(`Session ${sessionId} socket closed`);
                this.sessions.delete(sessionId);
            });

            this.sessions.set(sessionId, {
                socket: socket,
                responseBuffer: ''
            });

            this.log(`Session ${sessionId} connected successfully`);
            return sessionId;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to connect to GPG agent: ${msg}`);
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
                responseData += chunk.toString('utf-8');

                // Check if we have a complete response
                if (this.isCompleteResponse(responseData, isInquireBlock)) {
                    session.socket.removeListener('data', dataHandler);
                    session.socket.removeListener('error', errorHandler);
                    session.socket.removeListener('close', closeHandler);

                    this.log(`Session ${sessionId} received: ${responseData.replace(/\n/g, '\\n')}`);
                    resolve({ response: responseData });
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
     * Disconnect a session and clean up
     */
    public disconnectAgent(sessionId: string): void {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error(`Invalid session: ${sessionId}`);
        }

        this.log(`Closing session: ${sessionId}`);
        session.socket.destroy();
        this.sessions.delete(sessionId);
    }

    public isRunning(): boolean {
        return this.sessions.size > 0;
    }
}

