/**
 * Test Mock Helpers
 *
 * Mock implementations of interfaces for unit and integration testing.
 * Allows testing of extensions and services without VS Code runtime or real sockets.
 */

import { EventEmitter } from 'events';
import type { IFileSystem, ISocketFactory, ICommandExecutor, IServerFactory } from '../types';

/**
 * Mock FileSystem - tracks calls and allows test control
 */
export class MockFileSystem implements IFileSystem {
    private files: Map<string, Buffer> = new Map();
    private directories: Set<string> = new Set();
    public callLog: Array<{ method: string; args: any[] }> = [];

    existsSync(path: string): boolean {
        this.callLog.push({ method: 'existsSync', args: [path] });
        return this.files.has(path) || this.directories.has(path);
    }

    readFileSync(path: string): Buffer {
        this.callLog.push({ method: 'readFileSync', args: [path] });
        return this.files.get(path) || Buffer.alloc(0);
    }

    mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): void {
        this.callLog.push({ method: 'mkdirSync', args: [path, options] });
        this.directories.add(path);
    }

    chmodSync(path: string, mode: number | string): void {
        this.callLog.push({ method: 'chmodSync', args: [path, mode] });
    }

    unlinkSync(path: string): void {
        this.callLog.push({ method: 'unlinkSync', args: [path] });
        this.files.delete(path);
        this.directories.delete(path);
    }

    // Test helper methods
    setFile(path: string, content: Buffer): void {
        this.files.set(path, content);
    }

    getCallCount(method: string): number {
        return this.callLog.filter((call) => call.method === method).length;
    }

    clearLog(): void {
        this.callLog = [];
    }
}

/**
 * Mock Socket - emulates net.Socket with EventEmitter
 */
export class MockSocket extends EventEmitter {
    public data: Buffer[] = [];
    public destroyed = false;
    public writeError: Error | null = null;
    private readBuffer: Buffer[] = [];

    write(data: Buffer | string, callback?: (err?: Error | null) => void): boolean {
        if (this.destroyed) {
            if (callback) {
                setImmediate(() => callback(new Error('Socket is destroyed')));
            }
            return false;
        }

        const buffer = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
        this.data.push(buffer);

        if (this.writeError) {
            const err = this.writeError;
            this.writeError = null;
            if (callback) {
                setImmediate(() => callback(err));
            }
            return false;
        }

        if (callback) {
            setImmediate(() => callback(null));
        }
        return true;
    }

    destroy(error?: Error): void {
        this.destroyed = true;
        if (error) {
            this.emit('error', error);
        }
        this.emit('close');
    }

    end(): void {
        this.emit('end');
        this.emit('close');
    }

    pause(): void {
        // Mock pause/resume for flow control
    }

    resume(): void {
        // Mock pause/resume for flow control
    }

    // Test helper methods
    getWrittenData(): Buffer {
        return Buffer.concat(this.data);
    }

    read(): Buffer | null {
        if (this.readBuffer.length === 0) {
            return null;
        }
        return this.readBuffer.shift()!;
    }

    simulateDataReceived(data: Buffer): void {
        this.readBuffer.push(data);
        this.emit('readable');
    }

    simulateError(error: Error): void {
        this.emit('error', error);
    }

    clearData(): void {
        this.data = [];
        this.readBuffer = [];
    }
}

/**
 * Mock Server - emulates net.Server
 */
export class MockServer extends EventEmitter {
    public listening = false;
    public connections: MockSocket[] = [];
    public listenPath: string | null = null;
    private clientHandler: ((socket: MockSocket) => void) | null = null;

    constructor(options?: { pauseOnConnect?: boolean }, clientHandler?: (socket: MockSocket) => void) {
        super();
        this.clientHandler = clientHandler || null;
    }

    listen(path: string, callback?: () => void): void {
        this.listenPath = path;
        this.listening = true;
        if (callback) {
            callback();
        }
    }

    close(callback?: () => void): void {
        this.listening = false;
        if (callback) {
            callback();
        }
    }

    // Test helper methods
    simulateClientConnection(): MockSocket {
        const socket = new MockSocket();
        this.connections.push(socket);
        if (this.clientHandler) {
            this.clientHandler(socket);
        }
        return socket;
    }

    getConnections(): MockSocket[] {
        return this.connections;
    }
}

/**
 * Mock ServerFactory - creates mock servers
 */
export class MockServerFactory implements IServerFactory {
    public servers: MockServer[] = [];
    public clientHandler: ((socket: any) => void) | null = null;

    createServer(options?: { pauseOnConnect?: boolean }, clientHandler?: (socket: any) => void): any {
        const server = new MockServer(options, clientHandler);
        this.servers.push(server);
        this.clientHandler = clientHandler || null;
        return server;
    }

    getServers(): MockServer[] {
        return this.servers;
    }
}

/**
 * Mock CommandExecutor - tracks command calls without VS Code runtime
 */
export class MockCommandExecutor implements ICommandExecutor {
    public calls: Array<{ method: string; args: any[] }> = [];
    public connectAgentResponse: { sessionId: string; greeting: string } = {
        sessionId: 'test-session-123',
        greeting: 'OK GPG-Agent (GnuPG) 2.2.19 running in restricted mode\n'
    };
    public sendCommandsResponse: { response: string } = { response: 'OK\n' };
    public connectAgentError: Error | null = null;
    public sendCommandsError: Error | null = null;
    public disconnectAgentError: Error | null = null;

    async connectAgent(): Promise<{ sessionId: string; greeting: string }> {
        this.calls.push({ method: 'connectAgent', args: [] });
        if (this.connectAgentError) {
            throw this.connectAgentError;
        }
        return this.connectAgentResponse;
    }

    async sendCommands(sessionId: string, commandBlock: string): Promise<{ response: string }> {
        this.calls.push({ method: 'sendCommands', args: [sessionId, commandBlock] });
        if (this.sendCommandsError) {
            throw this.sendCommandsError;
        }
        return this.sendCommandsResponse;
    }

    async disconnectAgent(sessionId: string): Promise<void> {
        this.calls.push({ method: 'disconnectAgent', args: [sessionId] });
        if (this.disconnectAgentError) {
            throw this.disconnectAgentError;
        }
    }

    // Test helper methods
    getCallCount(method: string): number {
        return this.calls.filter((call) => call.method === method).length;
    }

    getCallArgs(method: string, callIndex: number = 0): any[] {
        const calls = this.calls.filter((call) => call.method === method);
        return calls[callIndex]?.args || [];
    }

    clearCalls(): void {
        this.calls = [];
    }

    setSendCommandsResponse(response: string): void {
        this.sendCommandsResponse = { response };
    }

    setConnectAgentError(error: Error): void {
        this.connectAgentError = error;
    }

    setSendCommandsError(error: Error): void {
        this.sendCommandsError = error;
    }

    setDisconnectAgentError(error: Error): void {
        this.disconnectAgentError = error;
    }
}

/**
 * Mock Socket Factory - creates mock sockets
 */
export class MockSocketFactory implements ISocketFactory {
    public sockets: MockSocket[] = [];
    public connectError: Error | null = null;

    createConnection(
        options: { host: string; port: number } | { path: string },
        connectListener?: () => void
    ): any {
        const socket = new MockSocket();
        this.sockets.push(socket);

        // Simulate connection events in next tick
        setImmediate(() => {
            if (this.connectError) {
                socket.emit('error', this.connectError);
            } else {
                socket.emit('connect');
                if (connectListener) {
                    connectListener();
                }
            }
        });

        return socket;
    }

    getSockets(): MockSocket[] {
        return this.sockets;
    }

    setConnectError(error: Error): void {
        this.connectError = error;
    }

    getLastSocket(): MockSocket | null {
        return this.sockets[this.sockets.length - 1] || null;
    }
}

/**
 * Test Configuration Helper
 */
export interface MockTestConfig {
    fileSystem?: MockFileSystem;
    serverFactory?: MockServerFactory;
    commandExecutor?: MockCommandExecutor;
    socketFactory?: MockSocketFactory;
}

/**
 * Create a complete mock configuration for testing
 */
export function createMockConfig(): MockTestConfig {
    return {
        fileSystem: new MockFileSystem(),
        serverFactory: new MockServerFactory(),
        commandExecutor: new MockCommandExecutor(),
        socketFactory: new MockSocketFactory()
    };
}

/**
 * Log helper for tests
 */
export class MockLogConfig {
    public logs: string[] = [];

    logCallback = (message: string) => {
        this.logs.push(message);
    };

    getLogs(): string[] {
        return this.logs;
    }

    getLogCount(): number {
        return this.logs.length;
    }

    clearLogs(): void {
        this.logs = [];
    }

    hasLog(pattern: string | RegExp): boolean {
        const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
        return this.logs.some((log) => regex.test(log));
    }
}
