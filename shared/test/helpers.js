"use strict";
/**
 * Test Mock Helpers
 *
 * Mock implementations of interfaces for unit and integration testing.
 * Allows testing of extensions and services without VS Code runtime or real sockets.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MockLogConfig = exports.MockSocketFactory = exports.MockCommandExecutor = exports.MockServerFactory = exports.MockServer = exports.MockSocket = exports.MockFileSystem = void 0;
exports.createMockConfig = createMockConfig;
const events_1 = require("events");
/**
 * Mock FileSystem - tracks calls and allows test control
 */
class MockFileSystem {
    files = new Map();
    directories = new Set();
    callLog = [];
    existsSync(path) {
        this.callLog.push({ method: 'existsSync', args: [path] });
        return this.files.has(path) || this.directories.has(path);
    }
    readFileSync(path) {
        this.callLog.push({ method: 'readFileSync', args: [path] });
        return this.files.get(path) || Buffer.alloc(0);
    }
    mkdirSync(path, options) {
        this.callLog.push({ method: 'mkdirSync', args: [path, options] });
        this.directories.add(path);
    }
    chmodSync(path, mode) {
        this.callLog.push({ method: 'chmodSync', args: [path, mode] });
    }
    unlinkSync(path) {
        this.callLog.push({ method: 'unlinkSync', args: [path] });
        this.files.delete(path);
        this.directories.delete(path);
    }
    // Test helper methods
    setFile(path, content) {
        this.files.set(path, content);
    }
    getCallCount(method) {
        return this.callLog.filter((call) => call.method === method).length;
    }
    clearLog() {
        this.callLog = [];
    }
}
exports.MockFileSystem = MockFileSystem;
/**
 * Mock Socket - emulates net.Socket with EventEmitter
 */
class MockSocket extends events_1.EventEmitter {
    data = [];
    destroyed = false;
    writeError = null;
    readBuffer = [];
    write(data, callback) {
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
    destroy(error) {
        this.destroyed = true;
        if (error) {
            this.emit('error', error);
        }
        this.emit('close');
    }
    end() {
        this.emit('end');
        this.emit('close');
    }
    pause() {
        // Mock pause/resume for flow control
    }
    resume() {
        // Mock pause/resume for flow control
    }
    // Test helper methods
    getWrittenData() {
        return Buffer.concat(this.data);
    }
    read() {
        if (this.readBuffer.length === 0) {
            return null;
        }
        return this.readBuffer.shift();
    }
    simulateDataReceived(data) {
        this.readBuffer.push(data);
        this.emit('readable');
    }
    simulateError(error) {
        this.emit('error', error);
    }
    clearData() {
        this.data = [];
        this.readBuffer = [];
    }
}
exports.MockSocket = MockSocket;
/**
 * Mock Server - emulates net.Server
 */
class MockServer extends events_1.EventEmitter {
    listening = false;
    connections = [];
    listenPath = null;
    clientHandler = null;
    constructor(options, clientHandler) {
        super();
        this.clientHandler = clientHandler || null;
    }
    listen(path, callback) {
        this.listenPath = path;
        this.listening = true;
        if (callback) {
            callback();
        }
    }
    close(callback) {
        this.listening = false;
        if (callback) {
            callback();
        }
    }
    // Test helper methods
    simulateClientConnection() {
        const socket = new MockSocket();
        this.connections.push(socket);
        if (this.clientHandler) {
            this.clientHandler(socket);
        }
        return socket;
    }
    getConnections() {
        return this.connections;
    }
}
exports.MockServer = MockServer;
/**
 * Mock ServerFactory - creates mock servers
 */
class MockServerFactory {
    servers = [];
    clientHandler = null;
    createServer(options, clientHandler) {
        const server = new MockServer(options, clientHandler);
        this.servers.push(server);
        this.clientHandler = clientHandler || null;
        return server;
    }
    getServers() {
        return this.servers;
    }
}
exports.MockServerFactory = MockServerFactory;
/**
 * Mock CommandExecutor - tracks command calls without VS Code runtime
 */
class MockCommandExecutor {
    calls = [];
    connectAgentResponse = {
        sessionId: 'test-session-123',
        greeting: 'OK GPG-Agent (GnuPG) 2.2.19 running in restricted mode\n'
    };
    sendCommandsResponse = { response: 'OK\n' };
    connectAgentError = null;
    sendCommandsError = null;
    disconnectAgentError = null;
    async connectAgent() {
        this.calls.push({ method: 'connectAgent', args: [] });
        if (this.connectAgentError) {
            throw this.connectAgentError;
        }
        return this.connectAgentResponse;
    }
    async sendCommands(sessionId, commandBlock) {
        this.calls.push({ method: 'sendCommands', args: [sessionId, commandBlock] });
        if (this.sendCommandsError) {
            throw this.sendCommandsError;
        }
        return this.sendCommandsResponse;
    }
    async disconnectAgent(sessionId) {
        this.calls.push({ method: 'disconnectAgent', args: [sessionId] });
        if (this.disconnectAgentError) {
            throw this.disconnectAgentError;
        }
    }
    // Test helper methods
    getCallCount(method) {
        return this.calls.filter((call) => call.method === method).length;
    }
    getCallArgs(method, callIndex = 0) {
        const calls = this.calls.filter((call) => call.method === method);
        return calls[callIndex]?.args || [];
    }
    clearCalls() {
        this.calls = [];
    }
    setSendCommandsResponse(response) {
        this.sendCommandsResponse = { response };
    }
    setConnectAgentError(error) {
        this.connectAgentError = error;
    }
    setSendCommandsError(error) {
        this.sendCommandsError = error;
    }
    setDisconnectAgentError(error) {
        this.disconnectAgentError = error;
    }
}
exports.MockCommandExecutor = MockCommandExecutor;
/**
 * Mock Socket Factory - creates mock sockets
 */
class MockSocketFactory {
    sockets = [];
    connectError = null;
    createConnection(options, connectListener) {
        const socket = new MockSocket();
        this.sockets.push(socket);
        // Simulate connection events in next tick
        setImmediate(() => {
            if (this.connectError) {
                socket.emit('error', this.connectError);
            }
            else {
                socket.emit('connect');
                if (connectListener) {
                    connectListener();
                }
            }
        });
        return socket;
    }
    getSockets() {
        return this.sockets;
    }
    setConnectError(error) {
        this.connectError = error;
    }
    getLastSocket() {
        return this.sockets[this.sockets.length - 1] || null;
    }
}
exports.MockSocketFactory = MockSocketFactory;
/**
 * Create a complete mock configuration for testing
 */
function createMockConfig() {
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
class MockLogConfig {
    logs = [];
    logCallback = (message) => {
        this.logs.push(message);
    };
    getLogs() {
        return this.logs;
    }
    getLogCount() {
        return this.logs.length;
    }
    clearLogs() {
        this.logs = [];
    }
    hasLog(pattern) {
        const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
        return this.logs.some((log) => regex.test(log));
    }
}
exports.MockLogConfig = MockLogConfig;
//# sourceMappingURL=helpers.js.map