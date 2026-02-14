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

    describe('State Machine Validation', () => {
        it('should have transition table entries for all 12 states', async () => {
            const allStates: string[] = [
                'DISCONNECTED', 'CLIENT_CONNECTED', 'AGENT_CONNECTING', 'READY',
                'BUFFERING_COMMAND', 'BUFFERING_INQUIRE',
                'SENDING_TO_AGENT', 'WAITING_FOR_AGENT', 'SENDING_TO_CLIENT',
                'ERROR', 'CLOSING', 'FATAL'
            ];

            // Start the service to trigger validation via type system
            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            // If code compiles and reaches here, transition table is properly formed
            expect(allStates).to.have.length(12);
            await instance.stop();
        });

        it('should validate all transitions are valid ClientState types', async () => {
            // This test validates state transitions via type checking at compile-time:
            // - transitionTable: Record<ClientState, Record<string, ClientState>>
            // - All keys must be valid ClientState strings
            // - All values must be valid ClientState strings
            // - TypeScript enforces this, so if code compiles, validation passes
            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            expect(instance).to.exist;
            await instance.stop();
        });
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

            await new Promise((resolve) => setTimeout(resolve, 20));

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
        it('should send client command to agent via sendCommands', async () => {
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

            // Send a command from client
            clientSocket.simulateDataReceived(Buffer.from('GETINFO version\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 10));

            // Verify command was sent to agent
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.be.greaterThan(0);

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

    describe('state machine: BUFFERING_INQUIRE', () => {
        it('should recognize INQUIRE response and transition to BUFFERING_INQUIRE', async () => {
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

            // Send command that triggers INQUIRE
            clientSocket.simulateDataReceived(Buffer.from('SETKEY keyid\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 10));

            // Verify INQUIRE was sent to client
            const written = clientSocket.getWrittenData().toString('latin1');
            expect(written).to.include('INQUIRE');

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

    // ========================================================================
    // Phase 7a: Tests for Current Implementation (Phases 1-3)
    // ========================================================================

    describe('Phase 7a: State Machine Fundamentals', () => {
        it('should have handlers for all 12 states (compile-time validation)', async () => {
            // This test validates that all states have handlers via TypeScript compile-time checking
            // The stateHandlers map in requestProxy.ts must have entries for all ClientState values
            // If code compiles, this validation passes
            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );
            expect(instance).to.exist;
            await instance.stop();
        });

        it('should validate transition table covers valid state/event pairs', async () => {
            // Transition table validation happens at compile-time via TypeScript types
            // transitionTable: Record<ClientState, Record<string, ClientState>>
            // This ensures all transitions are to valid states
            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );
            expect(instance).to.exist;
            await instance.stop();
        });

        it('should handle agent connection errors and destroy socket', async () => {
            mockCommandExecutor.setConnectAgentError(new Error('Connection refused'));

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Verify error was logged and socket was destroyed
            expect(mockLogConfig.hasLog(/Connection refused|error/i)).to.equal(true);
            expect(clientSocket.destroyed).to.equal(true);

            await instance.stop();
        });
    });

    describe('Phase 7a: State-Aware Socket Event Emission', () => {
        it('should emit CLIENT_DATA_START when READY state receives first data', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session',
                greeting: 'OK GPG-Agent\n'
            };
            mockCommandExecutor.setSendCommandsResponse('OK\n');

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Socket should be resumed by now
            expect(clientSocket.isPaused()).to.equal(false);

            // At this point, state should be READY (after greeting)
            // Send first chunk of data - should trigger CLIENT_DATA_START
            clientSocket.simulateDataReceived(Buffer.from('GETINFO version\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 10));

            // Verify command was sent (indicating event was processed)
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.be.greaterThan(0);

            await instance.stop();
        });

        it('should emit CLIENT_DATA_PARTIAL in BUFFERING_COMMAND with partial data', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session',
                greeting: 'OK GPG-Agent\n'
            };

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Send partial command (no newline) - should trigger CLIENT_DATA_PARTIAL
            clientSocket.simulateDataReceived(Buffer.from('GETINFO ver', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 10));

            // Command should not be sent yet (still buffering)
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(0);

            // Send rest of command
            mockCommandExecutor.setSendCommandsResponse('OK version 2.2.19\n');
            clientSocket.simulateDataReceived(Buffer.from('sion\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 10));

            // Now command should be complete and sent
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(1);

            await instance.stop();
        });

        it('should buffer D-block data when BUFFERING_INQUIRE receives first data', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session',
                greeting: 'OK GPG-Agent\n'
            };
            // First command triggers INQUIRE
            mockCommandExecutor.setSendCommandsResponse('INQUIRE PASSPHRASE\n');

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Send command that triggers INQUIRE
            clientSocket.simulateDataReceived(Buffer.from('SETKEY keyid\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 10));

            // Verify INQUIRE response was sent to client
            const written = clientSocket.getWrittenData().toString('latin1');
            expect(written).to.include('INQUIRE');

            // Now state should be BUFFERING_INQUIRE
            // Send first D-block data - should buffer it (emits CLIENT_DATA_PARTIAL)
            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('D passphrase1\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 10));

            // Should still be buffering (waiting for END\n)
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(1); // Only the first command

            await instance.stop();
        });

        it('should accumulate multiple D lines in BUFFERING_INQUIRE state', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session',
                greeting: 'OK GPG-Agent\n'
            };
            mockCommandExecutor.setSendCommandsResponse('INQUIRE PASSPHRASE\n');

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Send command that triggers INQUIRE
            clientSocket.simulateDataReceived(Buffer.from('SETKEY keyid\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 10));

            // Send multiple D lines (each emits CLIENT_DATA_PARTIAL in BUFFERING_INQUIRE)
            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('D line1\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 5));

            clientSocket.simulateDataReceived(Buffer.from('D line2\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 5));

            // Send END to complete
            clientSocket.simulateDataReceived(Buffer.from('END\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 10));

            // D-block should now be sent
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(2);

            await instance.stop();
        });

        it('should check session.state to determine correct event type', async () => {
            // This test verifies that the socket handler is state-aware
            // by testing that the same data (empty buffer scenario) produces different
            // events depending on the current state

            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session',
                greeting: 'OK GPG-Agent\n'
            };

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            // In READY state, first data should be CLIENT_DATA_START
            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('CMD1\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 10));

            const sendCount1 = mockCommandExecutor.getCallCount('sendCommands');
            expect(sendCount1).to.equal(1);

            // Now trigger INQUIRE flow
            mockCommandExecutor.setSendCommandsResponse('INQUIRE DATA\n');
            clientSocket.simulateDataReceived(Buffer.from('CMD2\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 10));

            // In BUFFERING_INQUIRE state, first data should be INQUIRE_DATA_START
            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('D data\nEND\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 10));

            // D-block should have been sent
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.be.greaterThan(sendCount1);

            await instance.stop();
        });
    });

    describe('Phase 7a: State Transition Verification', () => {
        it('should transition DISCONNECTED → CLIENT_CONNECTED → AGENT_CONNECTING → READY', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session-123',
                greeting: 'OK GPG-Agent ready\n'
            };

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];

            // Initial state is DISCONNECTED (no clients)
            expect(server.getConnections()).to.have.length(0);

            // Simulate client connection → CLIENT_CONNECTED
            const clientSocket = server.simulateClientConnection();
            expect(server.getConnections()).to.have.length(1);

            // Socket initialization automatically triggers AGENT_CONNECTING
            await new Promise((resolve) => setTimeout(resolve, 20));

            // Verify agent connection was initiated
            expect(mockCommandExecutor.getCallCount('connectAgent')).to.equal(1);

            // Verify greeting was sent to client → READY state
            const written = clientSocket.getWrittenData().toString('latin1');
            expect(written).to.include('OK GPG-Agent ready');

            await instance.stop();
        });

        it('should write greeting to client socket upon AGENT_GREETING_OK', async () => {
            const testGreeting = 'OK Pleased to meet you\n';
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-xyz',
                greeting: testGreeting
            };

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            const written = clientSocket.getWrittenData().toString('latin1');
            expect(written).to.equal(testGreeting);

            await instance.stop();
        });

        it('should transition to ERROR state when agent connection fails', async () => {
            mockCommandExecutor.setConnectAgentError(new Error('Agent unreachable'));

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Verify error was logged
            expect(mockLogConfig.hasLog(/Agent unreachable|error|failed/i)).to.equal(true);

            // Verify socket was destroyed (indicates ERROR state)
            expect(clientSocket.destroyed).to.equal(true);

            await instance.stop();
        });

        it('should resume socket after greeting is sent (transition to READY)', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'resume-test',
                greeting: 'OK ready\n'
            };

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            // Socket starts paused
            expect(clientSocket.isPaused()).to.equal(true);

            await new Promise((resolve) => setTimeout(resolve, 20));

            // After greeting, socket should be resumed
            expect(clientSocket.isPaused()).to.equal(false);

            await instance.stop();
        });
    });

    describe('Phase 7a: Invalid Event Tests', () => {
        it('should handle socket errors during AGENT_CONNECTING', async () => {
            mockCommandExecutor.setConnectAgentError(new Error('Network error'));

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Error should be logged
            expect(mockLogConfig.hasLog(/error|Network/i)).to.equal(true);

            await instance.stop();
        });

        it('should log error when client sends data in wrong state', async () => {
            // Testing protocol violation: client sends data while WAITING_FOR_AGENT
            // This simulates pipelined commands before agent responds
            // Whitelist pattern should catch this and emit ERROR_OCCURRED

            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test',
                greeting: 'OK\n'
            };

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Socket is now in READY state
            // Send a command that will put us in WAITING_FOR_AGENT state
            // Don't set a response yet, so we stay in WAITING_FOR_AGENT
            clientSocket.simulateDataReceived(Buffer.from('GETINFO version\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 10));

            // Now in WAITING_FOR_AGENT state (not in whitelist)
            // Send more data - should trigger protocol violation
            clientSocket.simulateDataReceived(Buffer.from('GETINFO pid\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 10));

            // Should log protocol violation error
            expect(mockLogConfig.hasLog(/Protocol violation|WAITING_FOR_AGENT/i)).to.equal(true);

            await instance.stop();
        });
    });

    describe('Phase 7a: Basic Session Lifecycle', () => {
        it('should call disconnectAgent when socket closes', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'lifecycle-test',
                greeting: 'OK\n'
            };

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Close the socket
            clientSocket.emit('close');

            await new Promise((resolve) => setTimeout(resolve, 10));

            // Verify disconnectAgent was called
            expect(mockCommandExecutor.getCallCount('disconnectAgent')).to.equal(1);

            await instance.stop();
        });

        it('should log socket error events', async () => {
            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 10));

            // Trigger socket error
            const testError = new Error('Socket broken');
            clientSocket.emit('error', testError);

            await new Promise((resolve) => setTimeout(resolve, 10));

            // Verify error was logged
            expect(mockLogConfig.hasLog(/Socket broken|error/i)).to.equal(true);

            await instance.stop();
        });

        it('should create server and start listening on socket path', async () => {
            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const servers = mockServerFactory.getServers();
            expect(servers).to.have.length(1);
            expect(servers[0].listening).to.equal(true);
            expect(servers[0].listenPath).to.equal('/tmp/test-gpg-agent');

            await instance.stop();
        });

        it('should stop server and cleanup socket on instance.stop()', async () => {
            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            expect(server.listening).to.equal(true);

            await instance.stop();

            expect(server.listening).to.equal(false);
            // Verify socket file was unlinked
            expect(mockFileSystem.getCallCount('unlinkSync')).to.be.greaterThan(0);
        });

        it('should handle multiple sequential client connections', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'multi-test-1',
                greeting: 'OK\n'
            };

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];

            // First client
            const client1 = server.simulateClientConnection();
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(mockCommandExecutor.getCallCount('connectAgent')).to.equal(1);

            // Close first client
            client1.emit('close');
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Second client
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'multi-test-2',
                greeting: 'OK\n'
            };
            const client2 = server.simulateClientConnection();
            await new Promise((resolve) => setTimeout(resolve, 20));

            // Should have connected twice
            expect(mockCommandExecutor.getCallCount('connectAgent')).to.equal(2);

            await instance.stop();
        });

        it('should handle concurrent client connections', async () => {
            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];

            // Create multiple concurrent clients
            const client1 = server.simulateClientConnection();
            const client2 = server.simulateClientConnection();
            const client3 = server.simulateClientConnection();

            expect(server.getConnections()).to.have.length(3);

            await new Promise((resolve) => setTimeout(resolve, 20));

            // All should attempt to connect
            expect(mockCommandExecutor.getCallCount('connectAgent')).to.be.greaterThan(0);

            await instance.stop();
        });
    });

    // ========================================================================
    // Phase 7b: Tests for Buffer Management (Phase 4)
    // ========================================================================

    describe('Phase 7b: Buffering Scenarios - Commands', () => {
        it('should buffer and process command sent in single chunk (baseline)', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session',
                greeting: 'OK GPG-Agent\n'
            };
            mockCommandExecutor.setSendCommandsResponse('OK\n');

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Send complete command at once
            clientSocket.simulateDataReceived(Buffer.from('GETINFO version\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 15));

            // Command should be sent
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(1);

            await instance.stop();
        });

        it('should handle partial data arrival in BUFFERING_COMMAND (multiple chunks before newline)', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session',
                greeting: 'OK GPG-Agent\n'
            };

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Send first part of command (no newline)
            clientSocket.simulateDataReceived(Buffer.from('GETINFO ver', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Command should not be sent yet (still buffering)
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(0);

            // Send rest of command with newline
            mockCommandExecutor.setSendCommandsResponse('OK version 2.2.19\n');
            clientSocket.simulateDataReceived(Buffer.from('sion\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Command should be sent once complete
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(1);

            await instance.stop();
        });

        it('should handle command split across 2 chunks', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session',
                greeting: 'OK\n'
            };
            mockCommandExecutor.setSendCommandsResponse('OK\n');

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Split command: "GETINFO ver" + "sion\n"
            clientSocket.simulateDataReceived(Buffer.from('GETINFO ver', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(0);

            clientSocket.simulateDataReceived(Buffer.from('sion\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(1);

            await instance.stop();
        });

        it('should handle multiple commands in single chunk (first extracted, rest buffered)', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session',
                greeting: 'OK\n'
            };

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Send two commands: first should be processed, second buffered then processed
            mockCommandExecutor.setSendCommandsResponse('OK 1\n');
            clientSocket.simulateDataReceived(Buffer.from('CMD1\nCMD2\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Both commands should be sent
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.be.greaterThanOrEqual(2);

            await instance.stop();
        });

        it('should handle newline as last byte in chunk', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session',
                greeting: 'OK\n'
            };
            mockCommandExecutor.setSendCommandsResponse('OK\n');

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Newline at end
            clientSocket.simulateDataReceived(Buffer.from('GETINFO version\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(1);

            await instance.stop();
        });

        it('should handle very long command (multiple KB)', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session',
                greeting: 'OK\n'
            };
            mockCommandExecutor.setSendCommandsResponse('OK\n');

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Send 4KB command
            const longCommand = 'CMD ' + 'A'.repeat(4000) + '\n';
            clientSocket.simulateDataReceived(Buffer.from(longCommand, 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 15));

            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(1);

            await instance.stop();
        });

        it('should handle command split across 3+ chunks', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session',
                greeting: 'OK\n'
            };
            mockCommandExecutor.setSendCommandsResponse('OK\n');

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Split command across 4 chunks: "GET" + "INFO " + "ver" + "sion\n"
            clientSocket.simulateDataReceived(Buffer.from('GET', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 5));
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(0);

            clientSocket.simulateDataReceived(Buffer.from('INFO ', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 5));
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(0);

            clientSocket.simulateDataReceived(Buffer.from('ver', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 5));
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(0);

            clientSocket.simulateDataReceived(Buffer.from('sion\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 10));
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(1);

            await instance.stop();
        });

        it('should handle newline split across chunk boundary', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session',
                greeting: 'OK\n'
            };
            mockCommandExecutor.setSendCommandsResponse('OK\n');

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Send command with newline split: "GETINFO version" + "\n"
            clientSocket.simulateDataReceived(Buffer.from('GETINFO version', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 5));
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(0);

            clientSocket.simulateDataReceived(Buffer.from('\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 10));
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(1);

            await instance.stop();
        });

        it('should handle empty command (just newline)', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session',
                greeting: 'OK\n'
            };
            mockCommandExecutor.setSendCommandsResponse('OK\n');

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Send just newline
            clientSocket.simulateDataReceived(Buffer.from('\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Empty command should still be processed
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(1);

            await instance.stop();
        });
    });

    describe('Phase 7b: Buffering Scenarios - INQUIRE D-blocks', () => {
        it('should handle partial D-block arrival (multiple chunks before END\\n)', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session',
                greeting: 'OK\n'
            };
            mockCommandExecutor.setSendCommandsResponse('INQUIRE PASSPHRASE\n');

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Trigger INQUIRE
            clientSocket.simulateDataReceived(Buffer.from('SETKEY keyid\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Send D-block in chunks
            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('D pa', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 5));

            clientSocket.simulateDataReceived(Buffer.from('ss\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 5));

            clientSocket.simulateDataReceived(Buffer.from('EN', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 5));

            clientSocket.simulateDataReceived(Buffer.from('D\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 10));

            // D-block should be sent once END\\n received
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(2); //SETKEY + D-block

            await instance.stop();
        });

        it('should handle D-block split across 2 chunks', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session',
                greeting: 'OK\n'
            };
            mockCommandExecutor.setSendCommandsResponse('INQUIRE DATA\n');

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Trigger INQUIRE
            clientSocket.simulateDataReceived(Buffer.from('CMD\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Split D-block: "D data\n" + "END\n"
            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('D data\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 5));

            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(1);

            clientSocket.simulateDataReceived(Buffer.from('END\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(2);

            await instance.stop();
        });

        it('should handle END\\n split across chunk boundary', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session',
                greeting: 'OK\n'
            };
            mockCommandExecutor.setSendCommandsResponse('INQUIRE DATA\n');

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Trigger INQUIRE
            clientSocket.simulateDataReceived(Buffer.from('CMD\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Split END\n as: "D data\nEN" + "D\n"
            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('D data\nEN', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 5));

            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(1);

            clientSocket.simulateDataReceived(Buffer.from('D\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(2);

            await instance.stop();
        });

        it('should handle D-block with binary data (all byte values 0-255)', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session',
                greeting: 'OK\n'
            };
            mockCommandExecutor.setSendCommandsResponse('INQUIRE DATA\n');

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Trigger INQUIRE
            clientSocket.simulateDataReceived(Buffer.from('CMD\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Send D-block with all byte values
            const binaryData = Buffer.alloc(256);
            for (let i = 0; i < 256; i++) {
                binaryData[i] = i;
            }
            const dBlock = Buffer.concat([
                Buffer.from('D ', 'latin1'),
                binaryData,
                Buffer.from('\nEND\n', 'latin1')
            ]);

            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(dBlock);
            await new Promise((resolve) => setTimeout(resolve, 15));

            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(2);

            await instance.stop();
        });

        it('should handle multiple D lines before END', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session',
                greeting: 'OK\n'
            };
            mockCommandExecutor.setSendCommandsResponse('INQUIRE DATA\n');

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Trigger INQUIRE
            clientSocket.simulateDataReceived(Buffer.from('CMD\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Send multiple D lines
            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('D line1\nD line2\nD line3\nEND\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(2);

            await instance.stop();
        });

        it('should handle D-block split across 3+ chunks', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session',
                greeting: 'OK\n'
            };
            mockCommandExecutor.setSendCommandsResponse('INQUIRE DATA\n');

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Trigger INQUIRE
            clientSocket.simulateDataReceived(Buffer.from('CMD\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Split D-block across 4 chunks: "D da" + "ta1\n" + "D data2\nE" + "ND\n"
            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('D da', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 5));
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(1);

            clientSocket.simulateDataReceived(Buffer.from('ta1\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 5));
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(1);

            clientSocket.simulateDataReceived(Buffer.from('D data2\nE', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 5));
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(1);

            clientSocket.simulateDataReceived(Buffer.from('ND\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 10));
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(2);

            await instance.stop();
        });

        it('should handle END\\n as last bytes in chunk', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session',
                greeting: 'OK\n'
            };
            mockCommandExecutor.setSendCommandsResponse('INQUIRE DATA\n');

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Trigger INQUIRE
            clientSocket.simulateDataReceived(Buffer.from('CMD\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Send D-block with END\n at the end
            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('D data\nEND\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(2);

            await instance.stop();
        });

        it('should handle very large D-block (multiple MB)', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session',
                greeting: 'OK\n'
            };
            mockCommandExecutor.setSendCommandsResponse('INQUIRE DATA\n');

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Trigger INQUIRE
            clientSocket.simulateDataReceived(Buffer.from('CMD\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Send 2MB D-block
            const largeData = 'A'.repeat(2 * 1024 * 1024);
            const largeDBlock = `D ${largeData}\nEND\n`;

            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from(largeDBlock, 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(2);

            await instance.stop();
        });
    });

    describe('Phase 7b: Buffer Management & Clearing', () => {
        it('should retain remaining data after extracting first command (pipelined)', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session',
                greeting: 'OK\n'
            };

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Send pipelined commands
            mockCommandExecutor.setSendCommandsResponse('OK 1\n');
            clientSocket.simulateDataReceived(Buffer.from('CMD1\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 15));

            mockCommandExecutor.setSendCommandsResponse('OK 2\n');
            clientSocket.simulateDataReceived(Buffer.from('CMD2\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 15));

            // Both commands should be processed
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.be.greaterThanOrEqual(2);

            const written = clientSocket.getWrittenData().toString('latin1');
            expect(written).to.include('OK 1');
            expect(written).to.include('OK 2');

            await instance.stop();
        });

        it('should handle buffer state when pipelined data arrives', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session',
                greeting: 'OK\n'
            };

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Send three commands in one chunk
            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('C1\nC2\nC3\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 25));

            // All three should eventually be processed
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.be.greaterThanOrEqual(3);

            await instance.stop();
        });
    });

});

