/**
 * Integration Tests: Agent-Proxy Service
 *
 * Tests AgentProxy with mocked dependencies.
 * Validates socket connections, nonce authentication, command handling, and session lifecycle.
 */

import { expect } from 'chai';
import { AgentProxy } from '../services/agentProxy';
import { MockSocketFactory, MockFileSystem, MockLogConfig } from '@gpg-relay/shared/test';

describe('AgentProxy', () => {
    let mockLogConfig: MockLogConfig;
    let mockSocketFactory: MockSocketFactory;
    let mockFileSystem: MockFileSystem;
    const socketPath = '/tmp/gpg-S.gpg-agent.extra';

    beforeEach(() => {
        mockLogConfig = new MockLogConfig();
        mockSocketFactory = new MockSocketFactory();
        mockFileSystem = new MockFileSystem();

        // Set up mock socket file content: "127.0.0.1\n31415\n<16-byte-nonce>"
        const nonce = Buffer.from('0123456789abcdef', 'utf-8'); // 16 bytes
        const socketFileContent = Buffer.from(`127.0.0.1\n31415\n${nonce}`);
        mockFileSystem.setFile(socketPath, socketFileContent);
    });

    describe('connectAgent', () => {
        it('should read socket file and parse port/nonce', async () => {
            const agentProxy = new AgentProxy(
                {
                    logCallback: mockLogConfig.logCallback,
                    gpgAgentSocketPath: socketPath,
                    statusBarCallback: undefined
                },
                {
                    fileSystem: mockFileSystem,
                    socketFactory: mockSocketFactory
                }
            );

            expect(mockFileSystem.getCallCount('readFileSync')).to.equal(0);

            // Mock socket will emit connect event
            const socketPromise = agentProxy.connectAgent();

            // Get the socket from factory and simulate connection
            await new Promise((resolve) => setTimeout(resolve, 10)); // Let async handler run
            const socket = mockSocketFactory.getLastSocket();
            expect(socket).to.exist;

            // Simulate greeting from agent
            socket!.emit('data', Buffer.from('OK GPG-Agent 2.2.19\n'));

            const result = await socketPromise;
            expect(result.sessionId).to.be.a('string');
            expect(result.greeting).to.include('OK');
        });

        it('should initialize session on successful connection', async () => {
            const agentProxy = new AgentProxy(
                {
                    logCallback: mockLogConfig.logCallback,
                    gpgAgentSocketPath: socketPath,
                    statusBarCallback: () => {
                        // status bar callback
                    }
                },
                {
                    fileSystem: mockFileSystem,
                    socketFactory: mockSocketFactory
                }
            );

            const socketPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            socket!.emit('data', Buffer.from('OK GPG-Agent 2.2.19\n'));

            const result = await socketPromise;
            expect(result.sessionId).to.exist;
        });

        it('should handle socket connection errors', async () => {
            const connectionError = new Error('Connection refused');
            mockSocketFactory.setConnectError(connectionError);

            const agentProxy = new AgentProxy(
                {
                    logCallback: mockLogConfig.logCallback,
                    gpgAgentSocketPath: socketPath,
                    statusBarCallback: undefined
                },
                {
                    fileSystem: mockFileSystem,
                    socketFactory: mockSocketFactory
                }
            );

            try {
                await agentProxy.connectAgent();
                expect.fail('Should have thrown');
            } catch (error: any) {
                expect(error.message).to.include('gpg-agent');
            }
        });

        it('should throw when socket file is missing', () => {
            expect(() => {
                new AgentProxy(
                    {
                        logCallback: mockLogConfig.logCallback,
                        gpgAgentSocketPath: '/nonexistent/socket',
                        statusBarCallback: undefined
                    },
                    {
                        fileSystem: mockFileSystem,
                        socketFactory: mockSocketFactory
                    }
                );
            }).to.throw('GPG agent socket not found');
        });
    });

    describe('sendCommands', () => {
        it('should send command block and return response', async () => {
            const agentProxy = new AgentProxy(
                {
                    logCallback: mockLogConfig.logCallback,
                    gpgAgentSocketPath: socketPath,
                    statusBarCallback: undefined
                },
                {
                    fileSystem: mockFileSystem,
                    socketFactory: mockSocketFactory
                }
            );

            // First connect
            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            socket!.emit('data', Buffer.from('OK GPG-Agent 2.2.19\n'));

            const connectResult = await connectPromise;
            const sessionId = connectResult.sessionId;

            // Now send command
            const commandPromise = agentProxy.sendCommands(sessionId, 'VERSION\n');

            // Simulate agent response
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket!.emit('data', Buffer.from('OK Temp v2.2.19\n'));

            const result = await commandPromise;
            expect(result.response).to.include('OK');
        });

        it('should handle multiple connected sessions', async () => {
            const agentProxy = new AgentProxy(
                {
                    logCallback: mockLogConfig.logCallback,
                    gpgAgentSocketPath: socketPath,
                    statusBarCallback: undefined
                },
                {
                    fileSystem: mockFileSystem,
                    socketFactory: mockSocketFactory
                }
            );

            // Connect session 1
            const session1Promise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            let socket = mockSocketFactory.getLastSocket();
            socket!.emit('data', Buffer.from('OK GPG-Agent 2.2.19\n'));

            const session1 = await session1Promise;

            // Connect session 2
            const session2Promise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            socket = mockSocketFactory.getLastSocket();
            socket!.emit('data', Buffer.from('OK GPG-Agent 2.2.19\n'));

            const session2 = await session2Promise;

            // Sessions should be different
            expect(session1.sessionId).to.not.equal(session2.sessionId);
        });
    });

    describe('disconnectAgent', () => {
        it('should send BYE command and cleanup session', async () => {
            const agentProxy = new AgentProxy(
                {
                    logCallback: mockLogConfig.logCallback,
                    gpgAgentSocketPath: socketPath,
                    statusBarCallback: undefined
                },
                {
                    fileSystem: mockFileSystem,
                    socketFactory: mockSocketFactory
                }
            );

            // Connect first
            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            socket!.emit('data', Buffer.from('OK GPG-Agent 2.2.19\n'));

            const connectResult = await connectPromise;
            const sessionId = connectResult.sessionId;

            // Disconnect
            const disconnectPromise = agentProxy.disconnectAgent(sessionId);

            // Simulate BYE response
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket!.emit('data', Buffer.from('OK\n'));

            await disconnectPromise;

            // Session should be cleaned up
            expect(agentProxy.isRunning()).to.equal(false);
        });

        it('should handle disconnect of invalid session', async () => {
            const agentProxy = new AgentProxy(
                {
                    logCallback: mockLogConfig.logCallback,
                    gpgAgentSocketPath: socketPath,
                    statusBarCallback: undefined
                },
                {
                    fileSystem: mockFileSystem,
                    socketFactory: mockSocketFactory
                }
            );

            try {
                await agentProxy.disconnectAgent('invalid-session-id');
                expect.fail('Should have thrown');
            } catch (error: any) {
                expect(error.message).to.include('session');
            }
        });
    });

    describe('session lifecycle', () => {
        it('should track running sessions', async () => {
            const agentProxy = new AgentProxy(
                {
                    logCallback: mockLogConfig.logCallback,
                    gpgAgentSocketPath: socketPath,
                    statusBarCallback: undefined
                },
                {
                    fileSystem: mockFileSystem,
                    socketFactory: mockSocketFactory
                }
            );

            expect(agentProxy.isRunning()).to.equal(false);

            // Connect first session
            const session1Promise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            let socket = mockSocketFactory.getLastSocket();
            socket!.emit('data', Buffer.from('OK GPG-Agent 2.2.19\n'));

            const session1 = await session1Promise;
            expect(agentProxy.isRunning()).to.equal(true);

            // Disconnect session 1
            const disconnectPromise = agentProxy.disconnectAgent(session1.sessionId);
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket!.emit('data', Buffer.from('OK\n'));
            await disconnectPromise;

            expect(agentProxy.isRunning()).to.equal(false);
        });
    });

});
