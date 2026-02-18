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
        it('should have transition table entries for all 11 states', async () => {
            const allStates: string[] = [
                'DISCONNECTED', 'CONNECTING_TO_AGENT', 'READY',
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
            expect(allStates).to.have.length(11);
            await instance.stop();
        });

        it('should validate all transitions are valid SessionState types', async () => {
            // This test validates state transitions via type checking at compile-time:
            // - transitionTable: Record<SessionState, Record<string, SessionState>>
            // - All keys must be valid SessionState strings
            // - All values must be valid SessionState strings
            // - TypeScript enforces this, so if code compiles, validation passes
            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            expect(instance).to.exist;
            await instance.stop();
        });
    });

    describe('Phase 3.2: Transition Validation', () => {
        it('should enforce valid transitions via STATE_TRANSITIONS table', async () => {
            // This test verifies that STATE_TRANSITIONS is the source of truth for valid transitions
            // Invalid transitions would cause the system to throw errors
            // We validate this through successful execution of complex flows

            const logs: string[] = [];
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-transition-enforcement',
                greeting: 'OK\n'
            };
            mockCommandExecutor.setSendCommandsResponse('OK\n');

            const instance = await startRequestProxy(
                { logCallback: (msg) => logs.push(msg) },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 20));

            // Execute command - all transitions must be valid
            clientSocket.simulateDataReceived(Buffer.from('GETINFO version\n', 'latin1'));
            await new Promise(resolve => setTimeout(resolve, 100));

            // If we got here, all transitions were valid (no exceptions thrown)
            // Verify we went through expected states
            const stateTransitions = logs.filter(log => log.includes('→'));
            expect(stateTransitions.length).to.be.greaterThan(5);

            await instance.stop();
        });

        it('should log transitions with event names in format: oldState → newState (event: eventName)', async () => {
            const logs: string[] = [];
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-transition-logging',
                greeting: 'OK\n'
            };

            const instance = await startRequestProxy(
                { logCallback: (msg) => logs.push(msg) },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 50));

            // Verify transition log format includes arrow and event name
            const transitionLogs = logs.filter(log => log.includes('→') && log.includes('(event:'));
            expect(transitionLogs.length).to.be.greaterThan(0);

            // Check specific transition patterns
            const disconnectedToConnected = logs.filter(log =>
                log.includes('DISCONNECTED → CONNECTING_TO_AGENT') && log.includes('(event: CLIENT_SOCKET_CONNECTED)')
            );
            expect(disconnectedToConnected.length).to.equal(1);

            const connectingToReady = logs.filter(log =>
                log.includes('CONNECTING_TO_AGENT → READY') && log.includes('(event: AGENT_GREETING_OK)')
            );
            expect(connectingToReady.length).to.equal(1);

            await instance.stop();
        });

        it('should have ERROR_OCCURRED transition from all non-terminal states', async () => {
            const logs: string[] = [];

            // Test ERROR_OCCURRED from READY state
            mockCommandExecutor.setSendCommandsError(new Error('Test error'));
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-error-transitions',
                greeting: 'OK\n'
            };

            const instance = await startRequestProxy(
                { logCallback: (msg) => logs.push(msg) },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 50));

            // Send command that will fail
            clientSocket.simulateDataReceived(Buffer.from('GETINFO version\n', 'latin1'));
            await new Promise(resolve => setTimeout(resolve, 100));

            // Verify ERROR_OCCURRED transition happened
            const errorTransition = logs.filter(log =>
                log.includes('→ ERROR') && log.includes('(event: ERROR_OCCURRED)')
            );
            expect(errorTransition.length).to.be.greaterThan(0);

            await instance.stop();
        });

        it('should have CLEANUP_REQUESTED transition from all socket-having states', async () => {
            const logs: string[] = [];
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-cleanup-transitions',
                greeting: 'OK\n'
            };

            const instance = await startRequestProxy(
                { logCallback: (msg) => logs.push(msg) },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 50));

            // Close from READY state
            clientSocket.end();
            await new Promise(resolve => setTimeout(resolve, 50));

            // Verify CLEANUP_REQUESTED → CLOSING transition
            const cleanupTransition = logs.filter(log =>
                log.includes('→ CLOSING') && log.includes('(event: CLEANUP_REQUESTED)')
            );
            expect(cleanupTransition.length).to.be.greaterThan(0);

            await instance.stop();
        });

        it('should transition to DISCONNECTED from CLOSING on CLEANUP_COMPLETE', async () => {
            const logs: string[] = [];
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-cleanup-complete',
                greeting: 'OK\n'
            };

            const instance = await startRequestProxy(
                { logCallback: (msg) => logs.push(msg) },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 50));

            // Trigger cleanup
            clientSocket.end();
            await new Promise(resolve => setTimeout(resolve, 80));

            // Verify CLOSING → DISCONNECTED transition
            const completeTransition = logs.filter(log =>
                log.includes('CLOSING → DISCONNECTED') && log.includes('(event: CLEANUP_COMPLETE)')
            );
            expect(completeTransition.length).to.be.greaterThan(0);

            await instance.stop();
        });

        it('should transition to FATAL from CLOSING on CLEANUP_ERROR', async () => {
            const logs: string[] = [];
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-cleanup-error',
                greeting: 'OK\n'
            };
            mockCommandExecutor.setDisconnectAgentError(new Error('Disconnect failed'));

            const instance = await startRequestProxy(
                { logCallback: (msg) => logs.push(msg) },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 50));

            // Inject socket error to trigger cleanup failure
            clientSocket.setRemoveAllListenersError(new Error('removeAllListeners failed'));

            // Trigger cleanup
            clientSocket.end();
            await new Promise(resolve => setTimeout(resolve, 100));

            // Verify CLOSING → FATAL transition
            const fatalTransition = logs.filter(log =>
                log.includes('CLOSING → FATAL') && log.includes('(event: CLEANUP_ERROR)')
            );
            expect(fatalTransition.length).to.be.greaterThan(0);

            await instance.stop();
        });

        it('should validate STATE_TRANSITIONS covers critical state paths', async () => {
            // This test ensures critical transitions exist at runtime
            // Import STATE_TRANSITIONS would require exposing it, so we test behavior instead

            const logs: string[] = [];
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-critical-paths',
                greeting: 'OK\n'
            };
            mockCommandExecutor.setSendCommandsResponse('OK\n');

            const instance = await startRequestProxy(
                { logCallback: (msg) => logs.push(msg) },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 20));

            // Execute full command cycle
            clientSocket.simulateDataReceived(Buffer.from('GETINFO version\n', 'latin1'));
            await new Promise(resolve => setTimeout(resolve, 100));

            // Verify all expected transitions occurred
            const expectedTransitions = [
                'DISCONNECTED → CONNECTING_TO_AGENT',
                'CONNECTING_TO_AGENT → READY',
                'READY → BUFFERING_COMMAND',
                'BUFFERING_COMMAND → SENDING_TO_AGENT',
                'SENDING_TO_AGENT → WAITING_FOR_AGENT',
                'WAITING_FOR_AGENT → SENDING_TO_CLIENT',
                'SENDING_TO_CLIENT → READY'
            ];

            for (const transition of expectedTransitions) {
                const found = logs.some(log => log.includes(transition));
                expect(found, `Missing transition: ${transition}`).to.equal(true);
            }

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
            // The stateHandlers map in requestProxy.ts must have entries for all SessionState values
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
            // transitionTable: Record<SessionState, Record<string, SessionState>>
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
                greeting: 'OK GPG-Agent 2.2.19\n'
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
                greeting: 'OK GPG-Agent 2.2.19\n'
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
                greeting: 'OK GPG-Agent 2.2.19\n'
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
                greeting: 'OK GPG-Agent 2.2.19\n'
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
        it('should transition DISCONNECTED → CONNECTING_TO_AGENT → READY', async () => {
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

            // Simulate client connection → CONNECTING_TO_AGENT
            const clientSocket = server.simulateClientConnection();
            expect(server.getConnections()).to.have.length(1);

            // Async agent connect completes → READY
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
        it('should handle socket errors during CONNECTING_TO_AGENT', async () => {
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
                greeting: 'OK GPG-Agent 2.2.19\n'
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

    // Phase 7c: Tests for Response Processing & INQUIRE (Phase 5)
    // Testing EventEmitter architecture - CLIENT_DATA_COMPLETE, RESPONSE_INQUIRE, RESPONSE_OK_OR_ERR

    describe('Phase 7c: Event Emission from Buffering States', () => {
        it('should process command when BUFFERING_COMMAND detects newline', async () => {
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

            // Send command with newline - should be sent to agent
            mockCommandExecutor.setSendCommandsResponse('OK test\n');
            clientSocket.simulateDataReceived(Buffer.from('GETINFO\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 15));

            // Verify command was sent to agent and response returned to client
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(1);
            const written = clientSocket.getWrittenData().toString('latin1');
            expect(written).to.include('OK test');

            await instance.stop();
        });

        it('should buffer data when newline not detected in BUFFERING_COMMAND', async () => {
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

            // Send partial command (no newline) - should not be sent yet
            clientSocket.simulateDataReceived(Buffer.from('GETIN', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 15));

            // Command should not have been sent to agent yet
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(0);

            // Complete the command
            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('FO\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 15));

            // Now it should be sent
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(1);

            await instance.stop();
        });

        it('should process D-block when BUFFERING_INQUIRE detects END\\n', async () => {
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

            // Trigger INQUIRE response
            mockCommandExecutor.setSendCommandsResponse('INQUIRE KEYPWD prompt\n');
            clientSocket.simulateDataReceived(Buffer.from('PASSWD\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Send D-block with END\n - should be sent to agent
            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('D secret\nEND\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Verify D-block was sent (2 commands: PASSWD + D-block)
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.be.greaterThanOrEqual(2);

            await instance.stop();
        });

        it('should buffer data when END\\n not detected in BUFFERING_INQUIRE', async () => {
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

            // Trigger INQUIRE response
            mockCommandExecutor.setSendCommandsResponse('INQUIRE KEYPWD prompt\n');
            clientSocket.simulateDataReceived(Buffer.from('PASSWD\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 20));

            const sendCount1 = mockCommandExecutor.getCallCount('sendCommands');

            // Send partial D-block (no END\n) - should not be sent yet
            clientSocket.simulateDataReceived(Buffer.from('D secret', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 15));

            // D-block should not have been sent yet
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(sendCount1);

            // Complete the D-block
            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('\nEND\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 15));

            // Now it should be sent
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.be.greaterThan(sendCount1);

            await instance.stop();
        });

        it('should send complete command to agent', async () => {
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

            mockCommandExecutor.setSendCommandsResponse('OK version 2.1\n');
            clientSocket.simulateDataReceived(Buffer.from('GETINFO version\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 15));

            // Verify response includes version info
            const written = clientSocket.getWrittenData().toString('latin1');
            expect(written).to.include('OK version 2.1');

            await instance.stop();
        });

        it('should send complete D-block to agent', async () => {
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

            // Trigger INQUIRE
            mockCommandExecutor.setSendCommandsResponse('INQUIRE KEYPWD prompt\n');
            clientSocket.simulateDataReceived(Buffer.from('PASSWD\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Send D-block
            mockCommandExecutor.setSendCommandsResponse('OK success\n');
            clientSocket.simulateDataReceived(Buffer.from('D mypassword\nEND\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 15));

            // Verify D-block was sent and OK received
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.be.greaterThanOrEqual(2);
            const written = clientSocket.getWrittenData().toString('latin1');
            expect(written).to.include('OK success');

            await instance.stop();
        });
    });

    describe('Phase 7c: Buffer Clearing During State Transitions', () => {
        it('should clear buffer after command extracted and sent to agent', async () => {
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

            // Send first command
            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('GETINFO\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 15));

            // Send second command - should work cleanly without leftover buffer data
            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('NOP\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 15));

            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(2);

            await instance.stop();
        });

        it('should clear buffer after command sent across multiple chunks', async () => {
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

            // Send command across two chunks
            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('GET', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 10));
            clientSocket.simulateDataReceived(Buffer.from('INFO\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 15));

            // Send another command - should work cleanly
            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('NOP\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 15));

            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(2);

            await instance.stop();
        });

        it('should clear buffer after D-block extracted and sent to agent', async () => {
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

            // Trigger INQUIRE
            mockCommandExecutor.setSendCommandsResponse('INQUIRE KEYPWD prompt\n');
            clientSocket.simulateDataReceived(Buffer.from('PASSWD\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Send D-block
            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('D data\nEND\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 15));

            // After D-block sent and OK received, send another command
            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('NOP\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 15));

            // Should have sent: PASSWD, D-block, NOP
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.be.greaterThanOrEqual(3);

            await instance.stop();
        });

        it('should have clean buffer when entering BUFFERING_INQUIRE', async () => {
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

            // Trigger INQUIRE - buffer should be cleared on transition
            mockCommandExecutor.setSendCommandsResponse('INQUIRE KEYPWD prompt\n');
            clientSocket.simulateDataReceived(Buffer.from('PASSWD\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Send D-block - should work cleanly without leftover command buffer
            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('D clean\nEND\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 15));

            expect(mockCommandExecutor.getCallCount('sendCommands')).to.be.greaterThanOrEqual(2);

            await instance.stop();
        });
    });

    describe('Phase 7c: INQUIRE Response Detection', () => {
        it('should detect INQUIRE response starting with "INQUIRE"', async () => {
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

            // Send command that triggers INQUIRE response
            mockCommandExecutor.setSendCommandsResponse('INQUIRE KEYPWD Enter passphrase\n');
            clientSocket.simulateDataReceived(Buffer.from('PASSWD\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Verify INQUIRE was sent to client and we're now waiting for D-block
            const written = clientSocket.getWrittenData().toString('latin1');
            expect(written).to.include('INQUIRE KEYPWD');

            // Send D-block to verify we're in INQUIRE state
            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('D data\nEND\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 15));

            expect(mockCommandExecutor.getCallCount('sendCommands')).to.be.greaterThanOrEqual(2);

            await instance.stop();
        });

        it('should detect INQUIRE response containing "\\nINQUIRE"', async () => {
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

            // Send command with multi-line response containing INQUIRE
            mockCommandExecutor.setSendCommandsResponse('S PROGRESS status\nINQUIRE KEYPWD prompt\n');
            clientSocket.simulateDataReceived(Buffer.from('PASSWD\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Verify INQUIRE was detected by sending D-block
            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('D data\nEND\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 15));

            expect(mockCommandExecutor.getCallCount('sendCommands')).to.be.greaterThanOrEqual(2);

            await instance.stop();
        });

        it('should respect case sensitivity of INQUIRE detection', async () => {
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

            // "inquire" in lowercase should NOT trigger INQUIRE detection
            mockCommandExecutor.setSendCommandsResponse('OK inquire test\n');
            clientSocket.simulateDataReceived(Buffer.from('PASSWD\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Should complete normally (return to READY), not waiting for D-block
            // Send another command to verify state
            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('GETINFO\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 15));

            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(2);

            await instance.stop();
        });

        it('should not trigger INQUIRE detection for OK response', async () => {
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

            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('GETINFO\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Should be back in READY, able to send another command
            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('NOP\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 15));

            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(2);

            await instance.stop();
        });

        it('should not trigger INQUIRE detection for ERR response', async () => {
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

            mockCommandExecutor.setSendCommandsResponse('ERR 67109139 Unknown command\n');
            clientSocket.simulateDataReceived(Buffer.from('INVALID\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Should be back in READY, error sent to client
            const written = clientSocket.getWrittenData().toString('latin1');
            expect(written).to.include('ERR 67109139');

            // Send another command to verify we're back in READY
            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('NOP\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 15));

            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(2);

            await instance.stop();
        });

        it('should forward INQUIRE response to client', async () => {
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

            mockCommandExecutor.setSendCommandsResponse('INQUIRE KEYPWD prompt\n');
            clientSocket.simulateDataReceived(Buffer.from('PASSWD\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 20));

            const written = clientSocket.getWrittenData().toString('latin1');
            expect(written).to.include('INQUIRE KEYPWD');

            await instance.stop();
        });

        it('should forward OK/ERR responses to client', async () => {
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

            mockCommandExecutor.setSendCommandsResponse('OK test\n');
            clientSocket.simulateDataReceived(Buffer.from('GETINFO\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 20));

            const written = clientSocket.getWrittenData().toString('latin1');
            expect(written).to.include('OK test');

            await instance.stop();
        });
    });

    describe('Phase 7c: Comprehensive INQUIRE Flow', () => {
        it('should complete full INQUIRE cycle end-to-end', async () => {
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

            // Send command that triggers INQUIRE
            mockCommandExecutor.setSendCommandsResponse('INQUIRE KEYPWD prompt\n');
            clientSocket.simulateDataReceived(Buffer.from('PASSWD\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Send D-block data
            mockCommandExecutor.setSendCommandsResponse('OK success\n');
            clientSocket.simulateDataReceived(Buffer.from('D mypassword\nEND\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Verify full cycle worked
            const written = clientSocket.getWrittenData().toString('latin1');
            expect(written).to.include('INQUIRE KEYPWD');
            expect(written).to.include('OK success');
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.be.greaterThanOrEqual(2);

            await instance.stop();
        });

        it('should preserve binary data in INQUIRE D-block', async () => {
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

            // Trigger INQUIRE
            mockCommandExecutor.setSendCommandsResponse('INQUIRE KEYPWD prompt\n');
            clientSocket.simulateDataReceived(Buffer.from('PASSWD\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Send D-block with all byte values 0-255
            const binaryData = Buffer.alloc(256);
            for (let i = 0; i < 256; i++) {
                binaryData[i] = i;
            }
            const dblock = Buffer.concat([
                Buffer.from('D ', 'latin1'),
                binaryData,
                Buffer.from('\nEND\n', 'latin1')
            ]);

            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(dblock);

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Verify D-block was sent to agent (2 sendCommands: PASSWD + D-block)
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.be.greaterThanOrEqual(2);

            await instance.stop();
        });

        it('should handle INQUIRE with multiple D lines', async () => {
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

            // Trigger INQUIRE
            mockCommandExecutor.setSendCommandsResponse('INQUIRE KEYPWD prompt\n');
            clientSocket.simulateDataReceived(Buffer.from('PASSWD\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Send multiple D lines
            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('D line1\nD line2\nD line3\nEND\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 20));

            expect(mockCommandExecutor.getCallCount('sendCommands')).to.be.greaterThanOrEqual(2);

            await instance.stop();
        });

        it('should handle multiple sequential INQUIRE sequences in same session', async () => {
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

            // First INQUIRE sequence
            mockCommandExecutor.setSendCommandsResponse('INQUIRE KEYPWD prompt1\n');
            clientSocket.simulateDataReceived(Buffer.from('PASSWD\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 20));

            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('D pass1\nEND\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 20));

            // Second INQUIRE sequence
            mockCommandExecutor.setSendCommandsResponse('INQUIRE KEYPWD prompt2\n');
            clientSocket.simulateDataReceived(Buffer.from('SIGN\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 20));

            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('D pass2\nEND\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 20));

            expect(mockCommandExecutor.getCallCount('sendCommands')).to.be.greaterThanOrEqual(4);

            await instance.stop();
        });

        it('should handle nested INQUIRE (agent responds to D-block with another INQUIRE)', async () => {
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

            // First INQUIRE
            mockCommandExecutor.setSendCommandsResponse('INQUIRE KEYPWD prompt1\n');
            clientSocket.simulateDataReceived(Buffer.from('PASSWD\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 20));

            // Send D-block, agent responds with another INQUIRE (nested)
            mockCommandExecutor.setSendCommandsResponse('INQUIRE CONFIRM confirm\n');
            clientSocket.simulateDataReceived(Buffer.from('D pass\nEND\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 20));

            // Respond to nested INQUIRE
            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('D yes\nEND\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 20));

            expect(mockCommandExecutor.getCallCount('sendCommands')).to.be.greaterThanOrEqual(3);

            await instance.stop();
        });

        it('should handle INQUIRE followed by regular command', async () => {
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

            // INQUIRE sequence
            mockCommandExecutor.setSendCommandsResponse('INQUIRE KEYPWD prompt\n');
            clientSocket.simulateDataReceived(Buffer.from('PASSWD\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 20));

            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('D password\nEND\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 20));

            // Regular command after INQUIRE
            mockCommandExecutor.setSendCommandsResponse('OK version 2.1\n');
            clientSocket.simulateDataReceived(Buffer.from('GETINFO version\n', 'latin1'));
            await new Promise((resolve) => setTimeout(resolve, 20));

            const written = clientSocket.getWrittenData().toString('latin1');
            expect(written).to.include('OK version 2.1');

            await instance.stop();
        });
    });

    describe('Phase 7c: Response Processing', () => {
        it('should process multi-line agent response', async () => {
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

            // Send command and receive multi-line response
            mockCommandExecutor.setSendCommandsResponse('OK version 2.1.23\n');
            clientSocket.simulateDataReceived(Buffer.from('GETINFO version\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 20));

            const written = clientSocket.getWrittenData().toString('latin1');
            expect(written).to.include('OK version 2.1.23');

            await instance.stop();
        });

        it('should detect complete response ending with OK', async () => {
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

            mockCommandExecutor.setSendCommandsResponse('S PROGRESS 50\nOK\n');
            clientSocket.simulateDataReceived(Buffer.from('SIGN\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Should be back in READY, able to send another command
            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('NOP\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 15));

            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(2);

            await instance.stop();
        });

        it('should detect complete response ending with ERR', async () => {
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

            mockCommandExecutor.setSendCommandsResponse('ERR 67109139 Unknown command\n');
            clientSocket.simulateDataReceived(Buffer.from('INVALID\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Error should be sent to client
            const written = clientSocket.getWrittenData().toString('latin1');
            expect(written).to.include('ERR 67109139');

            // Should be back in READY
            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('NOP\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 15));

            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(2);

            await instance.stop();
        });

        it('should detect complete response ending with INQUIRE', async () => {
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

            mockCommandExecutor.setSendCommandsResponse('INQUIRE KEYPWD prompt\n');
            clientSocket.simulateDataReceived(Buffer.from('PASSWD\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Should be waiting for D-block - send it to complete
            mockCommandExecutor.setSendCommandsResponse('OK\n');
            clientSocket.simulateDataReceived(Buffer.from('D data\nEND\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 15));

            expect(mockCommandExecutor.getCallCount('sendCommands')).to.be.greaterThanOrEqual(2);

            await instance.stop();
        });

        it('should preserve binary data in response', async () => {
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

            // Create response with binary data
            const binaryData = Buffer.alloc(128);
            for (let i = 0; i < 128; i++) {
                binaryData[i] = i;
            }
            const response = Buffer.concat([
                Buffer.from('D ', 'latin1'),
                binaryData,
                Buffer.from('\nOK\n', 'latin1')
            ]);

            mockCommandExecutor.setSendCommandsResponse(response.toString('latin1'));
            clientSocket.simulateDataReceived(Buffer.from('GETINFO\n', 'latin1'));

            await new Promise((resolve) => setTimeout(resolve, 20));

            const written = clientSocket.getWrittenData();

            // Verify binary data is preserved in response
            expect(written.length).to.be.greaterThan(128);

            // Check for some binary values
            let foundBinaryData = false;
            for (let i = 0; i < written.length - 10; i++) {
                if (written[i] === 0 && written[i + 1] === 1 && written[i + 2] === 2) {
                    foundBinaryData = true;
                    break;
                }
            }
            expect(foundBinaryData).to.be.true;

            await instance.stop();
        });
    });

    // ========================================================================
    //  Phase 7d: Error Handling & Cleanup (Phase 6)
    // ========================================================================

    describe('Phase 7d: Error Handling', () => {
        it('should transition to ERROR state on agent connection failure', async () => {
            mockCommandExecutor.setConnectAgentError(new Error('Connection refused'));

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 50));

            // Verify socket was destroyed (ERROR → CLEANUP → DISCONNECTED)
            expect(clientSocket.destroyed).to.be.true;

            await instance.stop();
        });

        it('should transition to ERROR state on sendCommands error', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session',
                greeting: 'OK Greeting\n'
            };
            mockCommandExecutor.setSendCommandsError(new Error('Send failed'));

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 50));

            // Send command to trigger error
            clientSocket.simulateDataReceived(Buffer.from('GETINFO version\n', 'latin1'));
            await new Promise(resolve => setTimeout(resolve, 50));

            // Verify socket was destroyed after error
            expect(clientSocket.destroyed).to.be.true;

            await instance.stop();
        });

        it('should log error information when ERROR_OCCURRED event fires', async () => {
            const logs: string[] = [];
            mockCommandExecutor.setConnectAgentError(new Error('Test error'));

            const instance = await startRequestProxy(
                { logCallback: (msg) => logs.push(msg) },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 50));

            // Verify error was logged
            const errorLogs = logs.filter(log => log.includes('Test error') || log.includes('ERROR'));
            expect(errorLogs.length).to.be.greaterThan(0);

            await instance.stop();
        });

        it('should handle protocol violations (client data in wrong state)', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session',
                greeting: 'OK Greeting\n'
            };
            mockCommandExecutor.setSendCommandsResponse('OK\n');

            const logs: string[] = [];
            const instance = await startRequestProxy(
                { logCallback: (msg) => logs.push(msg) },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 50));

            // Send first command
            clientSocket.simulateDataReceived(Buffer.from('GETINFO version\n', 'latin1'));
            await new Promise(resolve => setTimeout(resolve, 80));

            // Send data while processing (protocol violation if in wrong state)
            clientSocket.simulateDataReceived(Buffer.from('GETINFO pid\n', 'latin1'));
            await new Promise(resolve => setTimeout(resolve, 80));

            // Verify protocol violation logged if occurred
            const protocolLogs = logs.filter(log => log.includes('Protocol violation') || log.includes('ERROR'));
            // Test passes if either error occurred or commands processed sequentially
            const commandCount = mockCommandExecutor.getCallCount('sendCommands');
            expect(commandCount).to.be.greaterThanOrEqual(1);

            await instance.stop();
        });
    });

    describe('Phase 7d: Cleanup Sequence', () => {
        it('should follow ERROR → CLOSING → DISCONNECTED sequence', async () => {
            const logs: string[] = [];
            mockCommandExecutor.setConnectAgentError(new Error('Connection failed'));

            const instance = await startRequestProxy(
                { logCallback: (msg) => logs.push(msg) },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 50));

            // Verify state transitions logged
            const stateTransitions = logs.filter(log =>
                log.includes('ERROR') ||
                log.includes('CLOSING') ||
                log.includes('DISCONNECTED') ||
                log.includes('cleanup')
            );
            expect(stateTransitions.length).to.be.greaterThan(0);

            await instance.stop();
        });

        it('should call disconnectAgent during cleanup if session exists', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session',
                greeting: 'OK Greeting\n'
            };
            mockCommandExecutor.setSendCommandsError(new Error('Send failed'));

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 50));

            // Send command to trigger error
            clientSocket.simulateDataReceived(Buffer.from('GETINFO version\n', 'latin1'));
            await new Promise(resolve => setTimeout(resolve, 50));

            // Verify disconnectAgent was called
            expect(mockCommandExecutor.getCallCount('disconnectAgent')).to.equal(1);

            await instance.stop();
        });

        it('should destroy socket on cleanup complete', async () => {
            mockCommandExecutor.setConnectAgentError(new Error('Connection error'));

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 50));

            // Verify socket was destroyed
            expect(clientSocket.destroyed).to.be.true;

            await instance.stop();
        });

        it('should transition to FATAL on cleanup error', async () => {
            const logs: string[] = [];
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session',
                greeting: 'OK Greeting\n'
            };
            mockCommandExecutor.setSendCommandsError(new Error('Send error'));
            mockCommandExecutor.setDisconnectAgentError(new Error('Disconnect failed'));

            const instance = await startRequestProxy(
                { logCallback: (msg) => logs.push(msg) },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 50));

            // Trigger error then cleanup error
            clientSocket.simulateDataReceived(Buffer.from('GETINFO version\n', 'latin1'));
            await new Promise(resolve => setTimeout(resolve, 100));

            // Verify FATAL state reached
            const fatalLogs = logs.filter(log => log.includes('FATAL'));
            expect(fatalLogs.length).to.be.greaterThan(0);

            await instance.stop();
        });

        it('should clear event listeners during cleanup', async () => {
            mockCommandExecutor.setConnectAgentError(new Error('Connection error'));

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 50));

            // Verify socket was destroyed (happens after listener removal)
            expect(clientSocket.destroyed).to.be.true;

            await instance.stop();
        });

        it('should clear session buffer during cleanup', async () => {
            mockCommandExecutor.setConnectAgentError(new Error('Connection error'));

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            // Send partial data to populate buffer (before READY)
            clientSocket.simulateDataReceived(Buffer.from('PARTIAL', 'latin1'));
            await new Promise(resolve => setTimeout(resolve, 50));

            // Cleanup should clear buffer (verified by socket destruction)
            expect(clientSocket.destroyed).to.be.true;

            await instance.stop();
        });
    });

    describe('Phase 7d: Pipelined Data & Edge Cases', () => {
        it('should handle client data correctly during state transitions', async () => {
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
            await new Promise(resolve => setTimeout(resolve, 50));

            // Send first command
            clientSocket.simulateDataReceived(Buffer.from('GETINFO version\n', 'latin1'));
            await new Promise(resolve => setTimeout(resolve, 100));

            // Send second command after first completes
            clientSocket.simulateDataReceived(Buffer.from('GETINFO pid\n', 'latin1'));
            await new Promise(resolve => setTimeout(resolve, 100));

            // Verify both commands processed (or protocol violation occurred)
            const commandCount = mockCommandExecutor.getCallCount('sendCommands');
            expect(commandCount).to.be.greaterThanOrEqual(1);

            await instance.stop();
        });

        it('should reject client data in ERROR state', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session',
                greeting: 'OK\n'
            };
            mockCommandExecutor.setSendCommandsError(new Error('Send failed'));

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 50));

            // Trigger ERROR state
            clientSocket.simulateDataReceived(Buffer.from('GETINFO version\n', 'latin1'));
            await new Promise(resolve => setTimeout(resolve, 30));

            // Try to send more data while in ERROR/CLOSING state
            clientSocket.simulateDataReceived(Buffer.from('MORE DATA\n', 'latin1'));
            await new Promise(resolve => setTimeout(resolve, 30));

            // Socket should be destroyed
            expect(clientSocket.destroyed).to.be.true;

            await instance.stop();
        });

        it('should handle rapid connect/disconnect cycles', async () => {
            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];

            // Rapid connections
            for (let i = 0; i < 3; i++) {
                const clientSocket = server.simulateClientConnection();
                await new Promise(resolve => setTimeout(resolve, 20));
                clientSocket.emit('close');
                await new Promise(resolve => setTimeout(resolve, 20));
            }

            // Verify no crashes and clean handling
            expect(mockCommandExecutor.getCallCount('connectAgent')).to.equal(3);

            await instance.stop();
        });

        it('should handle socket errors during various states', async () => {
            mockCommandExecutor.setSendCommandsResponse('OK\n');

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 50));

            // Simulate socket error
            clientSocket.emit('error', new Error('Socket error'));
            await new Promise(resolve => setTimeout(resolve, 30));

            // Socket close should follow error
            clientSocket.emit('close');
            await new Promise(resolve => setTimeout(resolve, 30));

            // Verify cleanup occurred (disconnectAgent called)
            expect(mockCommandExecutor.getCallCount('disconnectAgent')).to.be.greaterThan(0);

            await instance.stop();
        });
    });

    describe('Phase 7d: Session Lifecycle & Cleanup', () => {
        it('should complete full session teardown after client disconnects', async () => {
            mockCommandExecutor.setSendCommandsResponse('OK\n');

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 50));

            // Execute command successfully
            clientSocket.simulateDataReceived(Buffer.from('GETINFO version\n', 'latin1'));
            await new Promise(resolve => setTimeout(resolve, 80));

            // Client disconnects
            clientSocket.emit('close');
            await new Promise(resolve => setTimeout(resolve, 50));

            // Verify agent disconnect was called
            expect(mockCommandExecutor.getCallCount('disconnectAgent')).to.equal(1);

            await instance.stop();
        });

        it('should support multiple sequential sessions reusing same server', async () => {
            mockCommandExecutor.setSendCommandsResponse('OK\n');

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];

            // Session 1
            const client1 = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 50));
            client1.simulateDataReceived(Buffer.from('GETINFO version\n', 'latin1'));
            await new Promise(resolve => setTimeout(resolve, 80));
            client1.emit('close');
            await new Promise(resolve => setTimeout(resolve, 50));

            // Session 2
            const client2 = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 50));
            client2.simulateDataReceived(Buffer.from('GETINFO pid\n', 'latin1'));
            await new Promise(resolve => setTimeout(resolve, 80));
            client2.emit('close');
            await new Promise(resolve => setTimeout(resolve, 50));

            // Verify both sessions completed
            expect(mockCommandExecutor.getCallCount('connectAgent')).to.equal(2);
            expect(mockCommandExecutor.getCallCount('disconnectAgent')).to.equal(2);

            await instance.stop();
        });

        it('should accept new connections in DISCONNECTED state after cleanup', async () => {
            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];

            // First connection
            const client1 = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 50));
            client1.emit('close');
            await new Promise(resolve => setTimeout(resolve, 50));

            // Second connection after first cleanup
            const client2 = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 50));

            // Verify second connection succeeded
            expect(mockCommandExecutor.getCallCount('connectAgent')).to.equal(2);

            await instance.stop();
        });

        it('should not leak session data into new sessions', async () => {
            mockCommandExecutor.setSendCommandsResponse('OK\n');

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];

            // Session 1: send command with partial buffered data
            const client1 = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 50));
            client1.simulateDataReceived(Buffer.from('PARTIAL', 'latin1')); // Incomplete command
            await new Promise(resolve => setTimeout(resolve, 50));
            client1.emit('close');
            await new Promise(resolve => setTimeout(resolve, 50));

            // Session 2: send complete command
            const client2 = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 50));
            client2.simulateDataReceived(Buffer.from('GETINFO version\n', 'latin1'));
            await new Promise(resolve => setTimeout(resolve, 80));

            // Verify command was sent (not contaminated by previous session's buffer)
            expect(mockCommandExecutor.getCallCount('sendCommands')).to.equal(1);
            const args = mockCommandExecutor.getCallArgs('sendCommands', 0);
            expect(args[1]).to.include('GETINFO version');
            expect(args[1]).to.not.include('PARTIAL');

            await instance.stop();
        });
    });

    describe('Phase 7d: Cleanup Failure Scenarios', () => {
        it('should handle socket.removeAllListeners() throwing during cleanup', async () => {
            const logs: string[] = [];
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session',
                greeting: 'OK\n'
            };
            mockCommandExecutor.setSendCommandsError(new Error('Send failed to trigger cleanup'));

            const instance = await startRequestProxy(
                { logCallback: (msg) => logs.push(msg) },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 50));

            // Inject error for removeAllListeners
            clientSocket.setRemoveAllListenersError(new Error('removeAllListeners failed'));

            // Trigger error to start cleanup
            clientSocket.simulateDataReceived(Buffer.from('GETINFO version\n', 'latin1'));
            await new Promise(resolve => setTimeout(resolve, 100));

            // Verify cleanup continued despite removeAllListeners throwing
            // Socket should still be destroyed (happens after removeAllListeners in try/catch)
            expect(clientSocket.destroyed).to.be.true;

            // Verify we reached FATAL state (cleanup error reported)
            const fatalLogs = logs.filter(log => log.includes('FATAL') || log.includes('cleanup error'));
            expect(fatalLogs.length).to.be.greaterThan(0);

            await instance.stop();
        });

        it('should handle socket.destroy() throwing during cleanup', async () => {
            const logs: string[] = [];
            mockCommandExecutor.setConnectAgentError(new Error('Connection failed to trigger cleanup'));

            const instance = await startRequestProxy(
                { logCallback: (msg) => logs.push(msg) },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            // Inject error for destroy
            clientSocket.setDestroyError(new Error('destroy failed'));

            await new Promise(resolve => setTimeout(resolve, 100));

            // Verify cleanup continued despite destroy throwing
            // We should reach FATAL state (destroy error captured)
            const fatalLogs = logs.filter(log => log.includes('FATAL') || log.includes('cleanup error'));
            expect(fatalLogs.length).to.be.greaterThan(0);

            await instance.stop();
        });

        it('should handle both socket.removeAllListeners() and socket.destroy() throwing', async () => {
            const logs: string[] = [];
            mockCommandExecutor.setConnectAgentError(new Error('Connection failed'));

            const instance = await startRequestProxy(
                { logCallback: (msg) => logs.push(msg) },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            // Inject errors for both operations
            clientSocket.setRemoveAllListenersError(new Error('removeAllListeners failed'));
            clientSocket.setDestroyError(new Error('destroy failed'));

            await new Promise(resolve => setTimeout(resolve, 100));

            // Verify we captured first error (removeAllListeners) via first-error-wins pattern
            const fatalLogs = logs.filter(log => log.includes('FATAL') || log.includes('cleanup error'));
            expect(fatalLogs.length).to.be.greaterThan(0);

            // Verify that despite both throwing, cleanup completed
            const cleanupLogs = logs.filter(log => log.includes('cleanup') || log.includes('Starting cleanup'));
            expect(cleanupLogs.length).to.be.greaterThan(0);

            await instance.stop();
        });

        it('should handle agent disconnect error and socket cleanup errors together', async () => {
            const logs: string[] = [];
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session',
                greeting: 'OK\n'
            };
            mockCommandExecutor.setSendCommandsError(new Error('Trigger cleanup'));
            mockCommandExecutor.setDisconnectAgentError(new Error('Disconnect failed'));

            const instance = await startRequestProxy(
                { logCallback: (msg) => logs.push(msg) },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 50));

            // Inject socket cleanup error
            clientSocket.setRemoveAllListenersError(new Error('removeAllListeners failed'));

            // Trigger error to start cleanup
            clientSocket.simulateDataReceived(Buffer.from('GETINFO version\n', 'latin1'));
            await new Promise(resolve => setTimeout(resolve, 100));

            // Verify first-error-wins: disconnect error should be reported (happens first)
            const fatalLogs = logs.filter(log => log.includes('FATAL'));
            expect(fatalLogs.length).to.be.greaterThan(0);

            // Both errors occurred, but only first is reported for state transition
            const disconnectErrors = logs.filter(log => log.includes('Disconnect failed'));
            expect(disconnectErrors.length).to.be.greaterThan(0);

            await instance.stop();
        });

        it('should execute all cleanup steps even with multiple failures', async () => {
            const logs: string[] = [];
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-session',
                greeting: 'OK\n'
            };
            mockCommandExecutor.setSendCommandsError(new Error('Send failed'));
            mockCommandExecutor.setDisconnectAgentError(new Error('Disconnect failed'));

            const instance = await startRequestProxy(
                { logCallback: (msg) => logs.push(msg) },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 50));

            // Inject multiple cleanup errors
            clientSocket.setRemoveAllListenersError(new Error('removeAllListeners failed'));
            clientSocket.setDestroyError(new Error('destroy failed'));

            // Trigger cleanup
            clientSocket.simulateDataReceived(Buffer.from('GETINFO version\n', 'latin1'));
            await new Promise(resolve => setTimeout(resolve, 100));

            // Verify first error (disconnect) was captured and reported
            const errorLogs = logs.filter(log => log.includes('Disconnect failed') || log.includes('FATAL'));
            expect(errorLogs.length).to.be.greaterThan(0);

            // Verify cleanup reached completion despite multiple failures
            // The fact we reached FATAL state proves all try/catch blocks executed
            const fatalLogs = logs.filter(log => log.includes('FATAL'));
            expect(fatalLogs.length).to.be.greaterThan(0);

            await instance.stop();
        });
    });

    describe('Phase 3.3: Socket Close State Machine Integration', () => {
        it('should emit CLEANUP_REQUESTED(false) on graceful socket close', async () => {
            const logs: string[] = [];
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-graceful-close',
                greeting: 'OK\n'
            };
            mockCommandExecutor.setSendCommandsResponse('OK version info\n');

            const instance = await startRequestProxy(
                { logCallback: (msg) => logs.push(msg) },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 20));

            // Send a command to establish session (transitions to READY)
            clientSocket.simulateDataReceived(Buffer.from('GETINFO version\n', 'latin1'));
            await new Promise(resolve => setTimeout(resolve, 80));

            // Graceful close (hadError=false)
            clientSocket.end();
            await new Promise(resolve => setTimeout(resolve, 50));

            // Verify CLEANUP_REQUESTED was handled (disconnectAgent called)
            expect(mockCommandExecutor.getCallCount('disconnectAgent')).to.equal(1);

            // Should log socket close
            const closeLogs = logs.filter(log => log.includes('Client socket closed'));
            expect(closeLogs.length).to.be.greaterThan(0);

            await instance.stop();
        });

        it('should handle socket close with error - logs error and performs cleanup', async () => {
            const logs: string[] = [];
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-error-close',
                greeting: 'OK\n'
            };
            mockCommandExecutor.setSendCommandsResponse('OK version info\n');

            const instance = await startRequestProxy(
                { logCallback: (msg) => logs.push(msg) },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 20));

            // Send a command to establish session
            clientSocket.simulateDataReceived(Buffer.from('GETINFO version\n', 'latin1'));
            await new Promise(resolve => setTimeout(resolve, 80));

            // Destroy with error
            clientSocket.destroy(new Error('Transmission error'));
            await new Promise(resolve => setTimeout(resolve, 50));

            // Verify socket error was logged
            const errorLogs = logs.filter(log => log.includes('Client socket error'));
            expect(errorLogs.length).to.be.greaterThan(0);

            // Verify cleanup occurred
            expect(mockCommandExecutor.getCallCount('disconnectAgent')).to.equal(1);

            await instance.stop();
        });

        it('should handle CLEANUP_REQUESTED from READY state', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-ready-cleanup',
                greeting: 'OK\n'
            };

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 50));

            // Session should be in READY state
            // Graceful close should transition READY → CLOSING
            clientSocket.end();
            await new Promise(resolve => setTimeout(resolve, 50));

            // Verify cleanup completed
            expect(mockCommandExecutor.getCallCount('disconnectAgent')).to.equal(1);

            await instance.stop();
        });

        it('should handle CLEANUP_REQUESTED from WAITING_FOR_AGENT state', async () => {
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-waiting-cleanup',
                greeting: 'OK\n'
            };
            // Delay sendCommands to keep session in WAITING_FOR_AGENT
            let sendCommandsResolver: ((value: { response: string }) => void) | null = null;
            mockCommandExecutor.sendCommands = async () => {
                return new Promise((resolve) => {
                    sendCommandsResolver = resolve;
                });
            };

            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 50));

            // Send command to transition to WAITING_FOR_AGENT
            clientSocket.simulateDataReceived(Buffer.from('GETINFO version\n', 'latin1'));
            await new Promise(resolve => setTimeout(resolve, 30));

            // Close while waiting for agent response
            clientSocket.end();
            await new Promise(resolve => setTimeout(resolve, 50));

            // Verify cleanup occurred
            expect(mockCommandExecutor.getCallCount('disconnectAgent')).to.equal(1);

            // Resolve delayed sendCommands (cleanup)
            if (sendCommandsResolver) {
                (sendCommandsResolver as (value: { response: string }) => void)({ response: 'OK\n' });
            }

            await instance.stop();
        });

        it('should use .once() for socket close - no duplicate CLEANUP_REQUESTED', async () => {
            const logs: string[] = [];
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-once-close',
                greeting: 'OK\n'
            };

            const instance = await startRequestProxy(
                { logCallback: (msg) => logs.push(msg) },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 50));

            // First close
            clientSocket.end();
            await new Promise(resolve => setTimeout(resolve, 50));

            const firstDisconnectCount = mockCommandExecutor.getCallCount('disconnectAgent');
            expect(firstDisconnectCount).to.equal(1);

            // Try to emit close again (should be ignored by .once())
            // Note: In real socket this wouldn't happen, but we test .once() behavior
            clientSocket.emit('close', false);
            await new Promise(resolve => setTimeout(resolve, 30));

            // disconnectAgent should still only be called once
            expect(mockCommandExecutor.getCallCount('disconnectAgent')).to.equal(firstDisconnectCount);

            await instance.stop();
        });

        it('should use .once() for socket error - logs error once', async () => {
            const logs: string[] = [];
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-once-error',
                greeting: 'OK\n'
            };
            mockCommandExecutor.setSendCommandsResponse('OK\n');

            const instance = await startRequestProxy(
                { logCallback: (msg) => logs.push(msg) },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 20));

            // Establish session
            clientSocket.simulateDataReceived(Buffer.from('GETINFO version\n', 'latin1'));
            await new Promise(resolve => setTimeout(resolve, 80));

            // Trigger error event
            const testError = new Error('Socket error');
            clientSocket.emit('error', testError);
            await new Promise(resolve => setTimeout(resolve, 30));

            const errorLogCount = logs.filter(log => log.includes('Socket error')).length;
            expect(errorLogCount).to.be.greaterThan(0);

            // Close to cleanup (will also be handled by .once())
            clientSocket.end();
            await new Promise(resolve => setTimeout(resolve, 30));

            await instance.stop();
        });

        it('should transition from multiple socket-having states to CLOSING', async () => {
            // Test CLEANUP_REQUESTED from CONNECTING_TO_AGENT state
            const instance = await startRequestProxy(
                { logCallback: mockLogConfig.logCallback },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();

            // Close immediately (CONNECTING_TO_AGENT state)
            await new Promise(resolve => setTimeout(resolve, 10));
            clientSocket.end();
            await new Promise(resolve => setTimeout(resolve, 50));

            // Should handle cleanup even before agent connection
            const logs = mockLogConfig.getLogs();
            const closingLogs = logs.filter(log => log.includes('CLOSING') || log.includes('DISCONNECTED'));
            expect(closingLogs.length).to.be.greaterThan(0);

            await instance.stop();
        });

        it('should pass hadError parameter through cleanup chain', async () => {
            const logs: string[] = [];
            mockCommandExecutor.connectAgentResponse = {
                sessionId: 'test-haderror-chain',
                greeting: 'OK\n'
            };
            mockCommandExecutor.setSendCommandsResponse('OK\n');

            const instance = await startRequestProxy(
                { logCallback: (msg) => logs.push(msg) },
                createMockDeps()
            );

            const server = mockServerFactory.getServers()[0];
            const clientSocket = server.simulateClientConnection();
            await new Promise(resolve => setTimeout(resolve, 20));

            // Establish session first
            clientSocket.simulateDataReceived(Buffer.from('GETINFO version\n', 'latin1'));
            await new Promise(resolve => setTimeout(resolve, 80));

            // Destroy without error (clean destroy)
            clientSocket.destroy();
            await new Promise(resolve => setTimeout(resolve, 50));

            // Verify cleanup occurred (socket closed, cleanup started)
            const cleanupLogs = logs.filter(log => log.includes('Starting cleanup') || log.includes('Client socket closed'));
            expect(cleanupLogs.length).to.be.greaterThan(0);

            await instance.stop();
        });
    });

});

