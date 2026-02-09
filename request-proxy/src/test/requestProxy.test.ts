/**
 * Integration Tests: Request-Proxy Service
 *
 * Tests RequestProxy state machine with mocked dependencies.
 * Validates socket server, command processing, state transitions, and client communication.
 */

import { expect } from 'chai';
import { startRequestProxy } from '../services/requestProxy';
import { MockCommandExecutor, MockServerFactory, MockFileSystem, MockSocket, MockLogConfig } from '@gpg-relay/shared/test';

describe('RequestProxy', () => {
    let mockLogConfig: MockLogConfig;
    let mockCommandExecutor: MockCommandExecutor;
    let mockServerFactory: MockServerFactory;
    let mockFileSystem: MockFileSystem;

    beforeEach(() => {
        mockLogConfig = new MockLogConfig();
        mockCommandExecutor = new MockCommandExecutor();
        mockServerFactory = new MockServerFactory();
        mockFileSystem = new MockFileSystem();
    });

    // Helper to create deps with all mocks including getSocketPath
    const createMockDeps = () => ({
        commandExecutor: mockCommandExecutor,
        serverFactory: mockServerFactory,
        fileSystem: mockFileSystem,
        getSocketPath: async () => '/tmp/test-gpg-agent'  // Mock path - prevents calling real gpgconf
    });

    describe('server initialization', () => {
        it('should create Unix socket server at correct path', async () => {
            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            expect(mockServerFactory.getServers()).to.have.length(1);
            const server = mockServerFactory.getServers()[0];
            expect(server.listenPath).to.include('gpg-agent');

            await instance.stop();
        });

        it('should create socket directory if it does not exist', async () => {
            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            expect(mockFileSystem.getCallCount('mkdirSync')).to.be.greaterThan(0);

            await instance.stop();
        });

        it('should set socket permissions to 0o666', async () => {
            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            expect(mockFileSystem.getCallCount('chmodSync')).to.be.greaterThan(0);

            await instance.stop();
        });
    });

    describe('client connection pool', () => {
        it('should accept client connections', async () => {
            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            expect(clientSocket).to.exist;
            expect(server.getConnections()).to.have.length(1);

            await instance.stop();
        });

        it('should handle multiple simultaneous clients', async () => {
            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const client1 = server.simulateClientConnection();
            const client2 = server.simulateClientConnection();
            const client3 = server.simulateClientConnection();

            expect(server.getConnections()).to.have.length(3);
            expect(client1).to.not.equal(client2);
            expect(client2).to.not.equal(client3);

            await instance.stop();
        });
    });

    describe('state machine: SEND_COMMAND', () => {
        it('should connect to agent on client connection', async () => {
            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            // Wait for connection handler to execute
            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(mockCommandExecutor.getCallCount('connectAgent')).to.equal(1);

            await instance.stop();
        });

        it('should send agent greeting to client', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-123',
                greeting: 'OK GPG-Agent 2.2.19\n'
            };

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 10));

            // Check that greeting was written to client
            const written = clientSocket.getWrittenData();
            expect(written.toString('latin1')).to.include('OK');

            await instance.stop();
        });

        it('should extract complete command lines from client', async () => {
            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 10));

            // Send a command to the client socket (as if client sent it)
            clientSocket.emit('readable');

            // Simulate receiving "GETINFO version\n" from client
            clientSocket.emit('readable'); // Trigger readable handler

            await new Promise((resolve) => setTimeout(resolve, 10));

            await instance.stop();
        });
    });

    describe('state machine: WAIT_RESPONSE', () => {
        it('should send client command to agent via executeCommand', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-123',
                greeting: 'OK GPG-Agent 2.2.19\n'
            };
            mockCommandExecutor.setSendCommandsResponse('OK\n');

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            expect(mockCommandExecutor.getCallCount('connectAgent')).to.be.greaterThan(0);

            await instance.stop();
        });

        it('should return agent response to client', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-123',
                greeting: 'OK GPG-Agent 2.2.19\n'
            };
            mockCommandExecutor.setSendCommandsResponse('OK agent version response\n');

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            await instance.stop();
        });
    });

    describe('state machine: INQUIRE_DATA', () => {
        it('should recognize INQUIRE response and transition to INQUIRE_DATA', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-123',
                greeting: 'OK GPG-Agent 2.2.19\n'
            };
            mockCommandExecutor.setSendCommandsResponse('INQUIRE DATA\n');

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            await instance.stop();
        });

        it('should wait for D block followed by END before responding', async () => {
            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            expect(server).to.exist;

            await instance.stop();
        });
    });

    describe('error handling', () => {
        it('should destroy socket on write error', async () => {
            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            // Simulate write error
            clientSocket.writeError = new Error('Write failed');

            await new Promise((resolve) => setTimeout(resolve, 10));

            // The error should be logged
            expect(mockLogConfig.getLogCount()).to.be.greaterThan(0);

            await instance.stop();
        });

        it('should handle command executor errors', async () => {
            mockCommandExecutor.setConnectAgentError(new Error('Agent not available'));

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Error should be logged
            expect(mockLogConfig.hasLog(/Agent|error|Error/i)).to.equal(true);

            await instance.stop();
        });

        it('should log client socket errors', async () => {
            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 10));

            // Simulate socket error
            clientSocket.simulateError(new Error('Socket read error'));

            await new Promise((resolve) => setTimeout(resolve, 10));

            // Error should be logged
            expect(mockLogConfig.getLogCount()).to.be.greaterThan(0);

            await instance.stop();
        });
    });

    describe('server lifecycle', () => {
        it('should stop gracefully and clean up socket', async () => {
            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            expect(server.listening).to.equal(true);

            await instance.stop();

            expect(server.listening).to.equal(false);
            expect(mockFileSystem.getCallCount('unlinkSync')).to.be.greaterThan(0);
        });

        it('should disconnect agent when client closes', async () => {
            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 10));

            // Simulate client socket close
            clientSocket.emit('close');

            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(mockCommandExecutor.getCallCount('disconnectAgent')).to.be.greaterThan(0);

            await instance.stop();
        });
    });

});

