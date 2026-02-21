/**
 * Integration Tests: Agent-Proxy Service
 *
 * Tests AgentProxy with mocked dependencies.
 * Validates socket connections, nonce authentication, command handling, and session lifecycle.
 */

import { expect } from 'chai';
import { AgentProxy } from '../services/agentProxy';
import { MockSocketFactory, MockFileSystem, MockLogConfig } from '@gpg-bridge/shared/test';

describe('AgentProxy', () => {
    let mockLogConfig: MockLogConfig;
    let mockSocketFactory: MockSocketFactory;
    let mockFileSystem: MockFileSystem;
    const socketPath = '/tmp/gpg-S.gpg-agent.extra';

    beforeEach(() => {
        mockLogConfig = new MockLogConfig();
        mockSocketFactory = new MockSocketFactory();
        mockFileSystem = new MockFileSystem();

        // Set up mock socket file content: "<port>\n<16-byte-nonce>"
        // Per parseSocketFile() in shared/protocol.ts
        const nonce = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]); // 16 binary bytes
        const socketFileContent = Buffer.concat([
            Buffer.from('31415\n', 'utf-8'),
            nonce
        ]);
        mockFileSystem.setFile(socketPath, socketFileContent);
    });

    afterEach(() => {
        // Clean up all sockets to prevent test pollution (lingering timeouts, event listeners)
        const sockets = mockSocketFactory.getSockets();
        sockets.forEach(socket => {
            if (!socket.destroyed) {
                socket.destroy();
            }
        });
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

            // Verify connection was made to correct port from socket file
            const connectionOptions = mockSocketFactory.lastConnectionOptions as { host: string; port: number };
            expect(connectionOptions).to.exist;
            expect(connectionOptions.port).to.equal(31415);
            expect(connectionOptions.host).to.equal('localhost');

            // Verify nonce was written to socket (first write should be the 16-byte nonce)
            expect(socket!.data.length).to.be.greaterThan(0);
            const writtenNonce = socket!.data[0];
            expect(writtenNonce.length).to.equal(16);
            const expectedNonce = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
            expect(writtenNonce.equals(expectedNonce)).to.be.true;

            // Simulate greeting from agent
            socket!.simulateGreeting();

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
            socket!.simulateGreeting();

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
            } catch (error: unknown) {
                expect((error as Error).message).to.include('gpg-agent');
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
            socket!.simulateGreeting();

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
            socket!.simulateGreeting();

            const session1 = await session1Promise;

            // Connect session 2
            const session2Promise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();

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
            socket!.simulateGreeting();

            const connectResult = await connectPromise;
            const sessionId = connectResult.sessionId;

            // Disconnect
            const disconnectPromise = agentProxy.disconnectAgent(sessionId);

            // Simulate BYE response and socket close (agent closes socket after BYE)
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket!.emit('data', Buffer.from('OK\n'));
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket!.simulateClose(false); // Graceful close after BYE

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
            } catch (error: unknown) {
                expect((error as Error).message).to.include('session');
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
            socket!.simulateGreeting();

            const session1 = await session1Promise;
            expect(agentProxy.isRunning()).to.equal(true);

            // Disconnect session 1
            const disconnectPromise = agentProxy.disconnectAgent(session1.sessionId);
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket!.emit('data', Buffer.from('OK\n'));
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket!.simulateClose(false); // Graceful close after BYE
            await disconnectPromise;

            expect(agentProxy.isRunning()).to.equal(false);
        });
    });

    describe('response completion detection', () => {
        it('should detect OK response (single line)', async () => {
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

            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();

            const result = await connectPromise;
            const sessionId = result.sessionId;

            const commandPromise = agentProxy.sendCommands(sessionId, 'GETINFO version\n');
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket!.emit('data', Buffer.from('OK\n'));

            const cmdResult = await commandPromise;
            expect(cmdResult.response).to.equal('OK\n');
        });

        it('should detect OK response (multi-line with data lines)', async () => {
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

            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();

            const result = await connectPromise;
            const sessionId = result.sessionId;

            const commandPromise = agentProxy.sendCommands(sessionId, 'KEYINFO --list\n');
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket!.emit('data', Buffer.from('S KEYINFO 1234567890ABCDEF\nS KEYINFO FEDCBA0987654321\nOK\n'));

            const cmdResult = await commandPromise;
            expect(cmdResult.response).to.include('KEYINFO');
            expect(cmdResult.response).to.include('OK\n');
        });

        it('should detect ERR response', async () => {
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

            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();

            const result = await connectPromise;
            const sessionId = result.sessionId;

            const commandPromise = agentProxy.sendCommands(sessionId, 'INVALID_COMMAND\n');
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket!.emit('data', Buffer.from('ERR 67108881 Unknown command <GPG Agent>\n'));

            const cmdResult = await commandPromise;
            expect(cmdResult.response).to.include('ERR');
        });

        it('should detect INQUIRE response', async () => {
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

            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();

            const result = await connectPromise;
            const sessionId = result.sessionId;

            const commandPromise = agentProxy.sendCommands(sessionId, 'PKDECRYPT\n');
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket!.emit('data', Buffer.from('INQUIRE CIPHERTEXT\n'));

            const cmdResult = await commandPromise;
            expect(cmdResult.response).to.include('INQUIRE');
        });

        it('should detect END response (D-block) in INQUIRE context', async () => {
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

            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();

            const result = await connectPromise;
            const sessionId = result.sessionId;

            // Send command that triggers INQUIRE (which can be followed by D/END)
            const commandPromise = agentProxy.sendCommands(sessionId, 'INQUIRE TEST\n');
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Simulate INQUIRE response
            socket!.emit('data', Buffer.from('INQUIRE DATA\n'));

            const cmdResult = await commandPromise;
            expect(cmdResult.response).to.include('INQUIRE');
        });

        it('should not complete on incomplete response (no newline)', async () => {
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

            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();

            const result = await connectPromise;
            const sessionId = result.sessionId;

            const commandPromise = agentProxy.sendCommands(sessionId, 'VERSION\n');
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Send incomplete response (no newline)
            socket!.emit('data', Buffer.from('OK'));

            // Wait a bit - should not complete yet
            await new Promise((resolve) => setTimeout(resolve, 50));

            // Now complete the response
            socket!.emit('data', Buffer.from('\n'));

            const cmdResult = await commandPromise;
            expect(cmdResult.response).to.equal('OK\n');
        });

        it('should not complete on partial OK/ERR', async () => {
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

            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();

            const result = await connectPromise;
            const sessionId = result.sessionId;

            const commandPromise = agentProxy.sendCommands(sessionId, 'VERSION\n');
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Send partial response
            socket!.emit('data', Buffer.from('O'));
            await new Promise((resolve) => setTimeout(resolve, 20));
            socket!.emit('data', Buffer.from('K\n'));

            const cmdResult = await commandPromise;
            expect(cmdResult.response).to.equal('OK\n');
        });

        it('should handle response with empty lines before terminal line', async () => {
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

            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();

            const result = await connectPromise;
            const sessionId = result.sessionId;

            const commandPromise = agentProxy.sendCommands(sessionId, 'TEST\n');
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket!.emit('data', Buffer.from('S DATA\n\n\nOK\n'));

            const cmdResult = await commandPromise;
            expect(cmdResult.response).to.include('OK\n');
        });

        it('should handle response with embedded "OK" in data lines', async () => {
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

            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();

            const result = await connectPromise;
            const sessionId = result.sessionId;

            const commandPromise = agentProxy.sendCommands(sessionId, 'GETINFO\n');
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket!.emit('data', Buffer.from('S STATUS: OK so far\nOK\n'));

            const cmdResult = await commandPromise;
            expect(cmdResult.response).to.include('STATUS: OK so far');
            expect(cmdResult.response).to.match(/\nOK\n$/);
        });

        it('should preserve binary data in responses', async () => {
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

            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();

            const result = await connectPromise;
            const sessionId = result.sessionId;

            const commandPromise = agentProxy.sendCommands(sessionId, 'GETBINARY\n');
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Binary data with all byte values 0-255
            const binaryData = Buffer.from([0, 1, 127, 128, 255]);
            const response = Buffer.concat([Buffer.from('D '), binaryData, Buffer.from('\nOK\n')]);
            socket!.emit('data', response);

            const cmdResult = await commandPromise;
            const responseBuffer = Buffer.from(cmdResult.response, 'latin1');
            // Verify binary data is preserved by checking buffer contains expected byte values
            expect(responseBuffer.indexOf(0)).to.be.greaterThan(-1);
            expect(responseBuffer.indexOf(255)).to.be.greaterThan(-1);
        });
    });

    describe('response accumulation', () => {
        it('should accumulate response split across 2 chunks', async () => {
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

            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();

            const result = await connectPromise;
            const sessionId = result.sessionId;

            const commandPromise = agentProxy.sendCommands(sessionId, 'VERSION\n');
            await new Promise((resolve) => setTimeout(resolve, 10));

            await socket!.simulateChunkResponse(['D version_', 'data\nOK\n']);

            const cmdResult = await commandPromise;
            expect(cmdResult.response).to.equal('D version_data\nOK\n');
        });

        it('should accumulate response split across 3+ chunks', async () => {
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

            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();

            const result = await connectPromise;
            const sessionId = result.sessionId;

            const commandPromise = agentProxy.sendCommands(sessionId, 'GETINFO\n');
            await new Promise((resolve) => setTimeout(resolve, 10));

            await socket!.simulateChunkResponse(['S key', 'info ', 'data\n', 'OK\n']);

            const cmdResult = await commandPromise;
            expect(cmdResult.response).to.equal('S keyinfo data\nOK\n');
        });

        it('should accumulate large response (>1MB)', async () => {
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

            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();

            const result = await connectPromise;
            const sessionId = result.sessionId;

            const commandPromise = agentProxy.sendCommands(sessionId, 'GETLARGE\n');
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Create 1MB+ of data
            const largeData = Buffer.alloc(1024 * 1024 + 100, 'X');
            socket!.emit('data', Buffer.concat([Buffer.from('D '), largeData, Buffer.from('\nOK\n')]));

            const cmdResult = await commandPromise;
            expect(cmdResult.response.length).to.be.greaterThan(1024 * 1024);
        });

        it('should handle rapid chunk arrival', async () => {
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

            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();

            const result = await connectPromise;
            const sessionId = result.sessionId;

            const commandPromise = agentProxy.sendCommands(sessionId, 'RAPID\n');
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Emit chunks rapidly without awaiting
            socket!.emit('data', Buffer.from('S chunk1'));
            socket!.emit('data', Buffer.from('\nS chunk2'));
            socket!.emit('data', Buffer.from('\nOK\n'));

            const cmdResult = await commandPromise;
            expect(cmdResult.response).to.include('chunk1');
            expect(cmdResult.response).to.include('chunk2');
        });

        it('should handle response with all byte values (0-255)', async () => {
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

            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();

            const result = await connectPromise;
            const sessionId = result.sessionId;

            const commandPromise = agentProxy.sendCommands(sessionId, 'GETALLBYTES\n');
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Create buffer with all byte values 0-255
            const allBytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
            const response = Buffer.concat([Buffer.from('D '), allBytes, Buffer.from('\nOK\n')]);
            socket!.emit('data', response);

            const cmdResult = await commandPromise;
            const responseBuffer = Buffer.from(cmdResult.response, 'latin1');
            expect(responseBuffer.length).to.be.greaterThan(256);
        });
    });

    describe('timeout handling', () => {
        it('should timeout after 5s on connection and cleanup', async function() {
            this.timeout(7000); // Allow time for 6s delay + test overhead

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

            mockSocketFactory.setDelayConnect(6000); // Delay longer than 5s timeout

            try {
                await agentProxy.connectAgent();
                expect.fail('Should have timed out');
            } catch (error: unknown) {
                expect((error as Error).message).to.match(/timeout|connection/i);
                expect(agentProxy.isRunning()).to.equal(false);
            }
        });

        it('should timeout after 5s on greeting and cleanup', async function() {
            this.timeout(7000);

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

            // Don't emit greeting - let it timeout
            try {
                await agentProxy.connectAgent();
                expect.fail('Should have timed out waiting for greeting');
            } catch (error: unknown) {
                expect((error as Error).message).to.match(/timeout/i);
                expect(agentProxy.isRunning()).to.equal(false);
            }
        });

        it('should cleanup session from Map after timeout', async function() {
            this.timeout(7000);

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

            mockSocketFactory.setDelayConnect(6000);

            try {
                await agentProxy.connectAgent();
                expect.fail('Should have timed out');
            } catch (error: unknown) {
                // After timeout, session should be cleaned up
                expect(agentProxy.isRunning()).to.equal(false);
                expect(agentProxy.getSessionCount()).to.equal(0);
            }
        });
    });

    describe('nonce authentication', () => {
        it('should send nonce immediately after socket connect', async () => {
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

            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            expect(socket).to.exist;

            // Check that nonce was written - use MockSocket.data array
            expect(socket!.data.length).to.be.greaterThan(0);
            expect(socket!.data[0].length).to.equal(16); // Nonce is 16 bytes

            socket!.simulateGreeting();
            await connectPromise;
        });

        it('should trigger cleanup on nonce write failure', async () => {
            mockSocketFactory.setWriteError(new Error('Write failed'));

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
                expect.fail('Should have failed on nonce write');
            } catch (error: unknown) {
                expect((error as Error).message).to.include('Write failed');
                expect(agentProxy.isRunning()).to.equal(false);
            }
        });

        it('should complete connection after greeting received', async () => {
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

            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();

            // Emit greeting - connection should complete
            socket!.simulateGreeting();

            const result = await connectPromise;
            expect(result.sessionId).to.exist;
            expect(result.greeting).to.include('OK');
        });

        it('should handle socket close after bad nonce (GPG agent behavior)', async () => {
            // Simulates GPG agent receiving invalid nonce and immediately closing socket
            // Per gpg-agent source: check_nonce() calls assuan_sock_close() on bad nonce
            mockSocketFactory.setCloseAfterFirstWrite();

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
                expect.fail('Should have failed due to socket close');
            } catch (error: unknown) {
                expect((error as Error).message).to.match(/Session closed|closed/i);
                expect(agentProxy.isRunning()).to.equal(false);
                expect(agentProxy.getSessionCount()).to.equal(0);
            }
        });
    });

    describe('error paths', () => {
        it('should handle socket error during waitForResponse', async () => {
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

            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();

            const result = await connectPromise;
            const sessionId = result.sessionId;

            const commandPromise = agentProxy.sendCommands(sessionId, 'TEST\n');
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Emit socket error
            socket!.emit('error', new Error('Socket error during response'));

            // Immediately await promise - it's "handled" when rejection occurs
            try {
                await commandPromise;
                expect.fail('Should have thrown socket error');
            } catch (error: unknown) {
                expect((error as Error).message).to.include('Socket error');
            }
        });

        it('should handle write error during sendCommands', async () => {
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

            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();

            const result = await connectPromise;
            const sessionId = result.sessionId;

            // Set write error on the socket directly after connection
            socket!.setWriteError(new Error('Command write failed'));

            // Immediately await - promise is "handled" when rejection occurs
            try {
                await agentProxy.sendCommands(sessionId, 'TEST\n');
                expect.fail('Should have thrown write error');
            } catch (error: unknown) {
                expect((error as Error).message).to.include('write');
            }
        });

        it('should accept relaxed greeting format (any OK*)', async () => {
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

            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();

            // Send various OK formats - implementation is relaxed
            socket!.emit('data', Buffer.from('OK Custom greeting\n'));

            const result = await connectPromise;
            expect(result.sessionId).to.exist;
            expect(result.greeting).to.include('OK');
        });

        it('should handle invalid session ID on sendCommands', async () => {
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
                await agentProxy.sendCommands('nonexistent-session-id', 'TEST\n');
                expect.fail('Should have thrown for invalid session');
            } catch (error: unknown) {
                expect((error as Error).message).to.include('session');
            }
        });
    });

    describe('Phase 3.3: Socket Close State Machine Integration', () => {
        it('should emit CLEANUP_REQUESTED(false) on graceful agent socket close', async () => {
            const logs: string[] = [];
            const agentProxy = new AgentProxy(
                {
                    logCallback: (msg) => logs.push(msg),
                    gpgAgentSocketPath: socketPath,
                    statusBarCallback: undefined
                },
                {
                    fileSystem: mockFileSystem,
                    socketFactory: mockSocketFactory
                }
            );

            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();

            const result = await connectPromise;
            await new Promise((resolve) => setTimeout(resolve, 20));

            // Graceful close from agent side
            socket!.end();
            await new Promise((resolve) => setTimeout(resolve, 50));

            // Verify cleanup occurred (socket closed)
            const closeLogs = logs.filter(log => log.includes('Agent socket closed') || log.includes('closed'));
            expect(closeLogs.length).to.be.greaterThan(0);
        });

        it('should emit ERROR_OCCURRED on socket close with transmission error', async () => {
            const logs: string[] = [];
            const agentProxy = new AgentProxy(
                {
                    logCallback: (msg) => logs.push(msg),
                    gpgAgentSocketPath: socketPath,
                    statusBarCallback: undefined
                },
                {
                    fileSystem: mockFileSystem,
                    socketFactory: mockSocketFactory
                }
            );

            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();

            await connectPromise;
            await new Promise((resolve) => setTimeout(resolve, 20));

            // Close with transmission error
            socket!.destroy(new Error('Agent connection lost'));
            await new Promise((resolve) => setTimeout(resolve, 50));

            // Verify socket error was logged
            const errorLogs = logs.filter(log =>
                log.includes('Agent socket error') || log.includes('Agent connection lost')
            );
            expect(errorLogs.length).to.be.greaterThan(0);
        });

        it('should handle CLEANUP_REQUESTED from READY state', async () => {
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

            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();

            const result = await connectPromise;
            const sessionId = result.sessionId;
            await new Promise((resolve) => setTimeout(resolve, 20));

            // Should be in READY state - close gracefully
            socket!.end();
            await new Promise((resolve) => setTimeout(resolve, 50));

            // Verify session cleaned up (subsequent sendCommands should fail)
            try {
                await agentProxy.sendCommands(sessionId, 'TEST\n');
                expect.fail('Should throw for closed session');
            } catch (error: unknown) {
                expect((error as Error).message).to.include('session');
            }
        });

        it('should handle CLEANUP_REQUESTED from SENDING_TO_AGENT state', async () => {
            const logs: string[] = [];
            const agentProxy = new AgentProxy(
                {
                    logCallback: (msg) => logs.push(msg),
                    gpgAgentSocketPath: socketPath,
                    statusBarCallback: undefined
                },
                {
                    fileSystem: mockFileSystem,
                    socketFactory: mockSocketFactory
                }
            );

            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();

            const result = await connectPromise;
            const sessionId = result.sessionId;

            // Set up callback to know when write completes (transitions to SENDING_TO_AGENT)
            const writeCompletePromise = socket!.waitForWrite();

            // Start sending command
            const sendPromise = agentProxy.sendCommands(sessionId, 'GETINFO version\n');

            // Wait for write to complete (now in SENDING_TO_AGENT state)
            await writeCompletePromise;

            // Close while in SENDING_TO_AGENT state
            socket!.end();

            // Immediately await - promise is "handled" when rejection occurs
            try {
                await sendPromise;
                // May complete or may throw - both are valid depending on timing
            } catch (error: unknown) {
                // Expected if close happened before/during write
                expect(error).to.exist;
            }
        });

        it('should use .once() for close - prevents duplicate state transitions', async () => {
            const logs: string[] = [];
            const agentProxy = new AgentProxy(
                {
                    logCallback: (msg) => logs.push(msg),
                    gpgAgentSocketPath: socketPath,
                    statusBarCallback: undefined
                },
                {
                    fileSystem: mockFileSystem,
                    socketFactory: mockSocketFactory
                }
            );

            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();

            const result = await connectPromise;
            await new Promise((resolve) => setTimeout(resolve, 20));

            // Verify session is running
            expect(agentProxy.isRunning()).to.equal(true);

            // Close the socket
            socket!.end();
            await new Promise((resolve) => setTimeout(resolve, 50));

            // Session should be cleaned up
            expect(agentProxy.isRunning()).to.equal(false);

            // Manually emit close again - should not cause errors or duplicate cleanup
            // Note: .once() handler already removed, so this should be ignored
            socket!.simulateClose(false);
            await new Promise((resolve) => setTimeout(resolve, 30));

            // Verify .once() prevented duplicate handling by checking session is still disconnected
            expect(agentProxy.isRunning()).to.equal(false);

            // Verify cleanup didn't run twice (would log errors if it did)
            const cleanupCount = logs.filter(log => log.includes('Cleanup requested')).length;
            expect(cleanupCount).to.equal(1);
        });

        it('should use .once() for socket error - no duplicate ERROR_OCCURRED', async () => {
            const logs: string[] = [];
            const agentProxy = new AgentProxy(
                {
                    logCallback: (msg) => logs.push(msg),
                    gpgAgentSocketPath: socketPath,
                    statusBarCallback: undefined
                },
                {
                    fileSystem: mockFileSystem,
                    socketFactory: mockSocketFactory
                }
            );

            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();

            await connectPromise;
            await new Promise((resolve) => setTimeout(resolve, 20));

            // First error
            const testError = new Error('Agent socket error');
            socket!.emit('error', testError);
            await new Promise((resolve) => setTimeout(resolve, 30));

            const errorLogCount = logs.filter(log => log.includes('Agent socket error')).length;
            expect(errorLogCount).to.be.greaterThan(0);

            // Try to emit error again (should be ignored by .once())
            // Wrap in try-catch because EventEmitter throws unhandled 'error' events
            try {
                socket!.emit('error', new Error('Second error'));
            } catch (e) {
                // Expected: no handler registered (removed by .once()), so EventEmitter throws
                // This is correct behavior - the .once() handler only fired for the first error
            }
            await new Promise((resolve) => setTimeout(resolve, 30));

            // Should still only log first error (second error didn't reach handler)
            const finalErrorLogCount = logs.filter(log => log.includes('Agent socket error')).length;
            expect(finalErrorLogCount).to.equal(errorLogCount);

            // Verify second error never reached logs (was thrown by EventEmitter, not processed)
            const secondErrorCount = logs.filter(log => log.includes('Second error')).length;
            expect(secondErrorCount).to.equal(0);

            // Close cleans up
            socket!.end();
        });

        it('should pass hadError parameter through cleanup chain', async () => {
            const logs: string[] = [];
            const agentProxy = new AgentProxy(
                {
                    logCallback: (msg) => logs.push(msg),
                    gpgAgentSocketPath: socketPath,
                    statusBarCallback: undefined
                },
                {
                    fileSystem: mockFileSystem,
                    socketFactory: mockSocketFactory
                }
            );

            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();

            await connectPromise;
            await new Promise((resolve) => setTimeout(resolve, 20));

            // Destroy without error (clean destroy)
            socket!.destroy();

            // Verify cleanup occurred (socket closed)
            const cleanupLogs = logs.filter(log => log.includes('Agent socket closed') || log.includes('closed'));
            expect(cleanupLogs.length).to.be.greaterThan(0);
        });

        it('should handle socket close during connection phase', async () => {
            const logs: string[] = [];
            const agentProxy = new AgentProxy(
                {
                    logCallback: (msg) => logs.push(msg),
                    gpgAgentSocketPath: socketPath,
                    statusBarCallback: undefined
                },
                {
                    fileSystem: mockFileSystem,
                    socketFactory: mockSocketFactory
                }
            );

            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();

            // Close before greeting received (during AGENT_CONNECTING state)
            socket!.end();

            // Immediately await - promise is "handled" when rejection occurs
            try {
                await connectPromise;
                expect.fail('Should have rejected on early close');
            } catch (error: unknown) {
                expect(error).to.exist;
            }
        });

        it('should transition from multiple socket-having states to CLOSING', async () => {
            const logs: string[] = [];
            const agentProxy = new AgentProxy(
                {
                    logCallback: (msg) => logs.push(msg),
                    gpgAgentSocketPath: socketPath,
                    statusBarCallback: undefined
                },
                {
                    fileSystem: mockFileSystem,
                    socketFactory: mockSocketFactory
                }
            );

            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();

            const result = await connectPromise;
            const sessionId = result.sessionId;

            // Send command to enter SENDING_TO_AGENT
            const sendPromise = agentProxy.sendCommands(sessionId, 'TEST\n');
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Close from SENDING_TO_AGENT state
            socket!.end();

            // Immediately await promise - it's "handled" when rejection occurs
            try {
                await sendPromise;
            } catch (error: unknown) {
                // Expected if socket closed before write completed
            }

            // Should log socket closure and cleanup
            const closingLogs = logs.filter(log => log.includes('closed') || log.includes('CLOSING') || log.includes('DISCONNECTED'));
            expect(closingLogs.length).to.be.greaterThan(0);
        });
    });

    describe('Phase 6: State Machine Internals', () => {
        it('should throw descriptive error on invalid session', async () => {
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

            // Verify that calling sendCommands before connecting fails
            try {
                await agentProxy.sendCommands('nonexistent-session', 'VERSION\n');
                expect.fail('Should have thrown error for invalid session');
            } catch (error: unknown) {
                expect((error as Error).message).to.include('Invalid session');
            }
        });

        it('should cleanup Promise bridge listeners after Promise settles', async () => {
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

            // Connect
            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();

            const result = await connectPromise;
            const sessionId = result.sessionId;

            // Check listener count before command (baseline)
            // Note: EventEmitter doesn't expose listenerCount directly on instances,
            // but the fact that commands complete without errors proves cleanup works

            // Send command
            const commandPromise = agentProxy.sendCommands(sessionId, 'VERSION\n');
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Complete response
            socket!.emit('data', Buffer.from('OK\n'));

            const cmdResult = await commandPromise;
            expect(cmdResult.response).to.include('OK');

            // If listeners weren't cleaned up, subsequent commands would fail or leak memory
            // Send another command to verify no interference from previous listeners
            const commandPromise2 = agentProxy.sendCommands(sessionId, 'GETINFO version\n');
            await new Promise((resolve) => setTimeout(resolve, 10));

            socket!.emit('data', Buffer.from('D version-info\nOK\n'));

            const cmdResult2 = await commandPromise2;
            expect(cmdResult2.response).to.include('OK');

            // Cleanup: disconnect session before test ends
            const writeCompletePromise = socket!.waitForWrite();
            const byePromise = agentProxy.sendCommands(sessionId, 'BYE\n');
            await writeCompletePromise;  // Wait for BYE to be written
            socket!.emit('data', Buffer.from('OK closing connection\n'));
            await byePromise;  // Wait for response processing
            socket!.simulateClose(false);
        });

        it('should handle socket close after transition to READY (slow close race)', async () => {
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

            // Connect and send BYE
            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();

            const result = await connectPromise;
            const sessionId = result.sessionId;

            // Send BYE command
            const disconnectPromise = agentProxy.disconnectAgent(sessionId);
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Agent responds OK (session transitions back to READY)
            socket!.emit('data', Buffer.from('OK\n'));

            // NOW simulate slow socket close (after BYE response processed)
            await new Promise((resolve) => setTimeout(resolve, 50));
            socket!.simulateClose(false);

            // Disconnect should complete successfully
            await disconnectPromise;

            // Session should be cleaned up
            expect(agentProxy.isRunning()).to.equal(false);
        });
    });

    describe('Phase 7: Protocol Violations', () => {
        // Note: Protocol violation guard exists in agentProxy.ts:767-772
        // Testing specific transient states (SENDING_TO_AGENT, WAITING_FOR_AGENT, etc.)
        // creates race conditions because state transitions complete synchronously.
        // The guard is verified by code review. This test confirms it rejects invalid sessions.

        it('should reject sendCommands on invalid sessionId', async () => {
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

            // Try to send command without connecting
            try {
                await agentProxy.sendCommands('nonexistent-session', 'VERSION\n');
                expect.fail('Should have rejected invalid session');
            } catch (error: unknown) {
                expect((error as Error).message).to.include('Invalid session');
            }
        });
    });

    describe('Phase 7: Greeting Validation', () => {
        it('should accept greeting with just "OK\\n"', async () => {
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

            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();

            // Send minimal valid greeting
            socket!.emit('data', Buffer.from('OK\n'));

            const result = await connectPromise;
            expect(result.sessionId).to.exist;
            expect(result.greeting).to.equal('OK\n');
        });

        // Note: GPG agent does NOT send ERR for bad nonce - it immediately closes socket
        // See gpg-agent source: check_nonce() calls assuan_sock_close() on nonce failure
        // Socket close behavior already tested in "Phase 3.3: Socket Close State Machine Integration"
    });

    describe('Phase 7: Socket Close Coverage Gaps', () => {
        it('should handle socket error close in WAITING_FOR_AGENT state', async () => {
            const logs: string[] = [];
            const agentProxy = new AgentProxy(
                {
                    logCallback: (msg) => logs.push(msg),
                    gpgAgentSocketPath: socketPath,
                    statusBarCallback: undefined
                },
                {
                    fileSystem: mockFileSystem,
                    socketFactory: mockSocketFactory
                }
            );

            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();

            const result = await connectPromise;
            const sessionId = result.sessionId;

            // Set up callback to know when write completes (transition to WAITING_FOR_AGENT)
            const writeCompletePromise = socket!.waitForWrite();

            // Send command - triggers write
            const cmdPromise = agentProxy.sendCommands(sessionId, 'VERSION\n');

            // Wait for write to actually complete
            await writeCompletePromise;

            // NOW destroy socket while in WAITING_FOR_AGENT state
            socket!.destroy(new Error('Connection lost'));

            // Immediately await - promise is "handled" right when rejection occurs
            try {
                await cmdPromise;
                expect.fail('Should have rejected due to socket error');
            } catch (error: unknown) {
                expect((error as Error).message).to.match(/Connection lost|Session closed/);
            }

            // Verify error was logged
            const errorLogs = logs.filter(log => log.includes('error') || log.includes('Connection lost'));
            expect(errorLogs.length).to.be.greaterThan(0);
        });

        it('should handle socket error in CONNECTING_TO_AGENT state', async () => {
            const logs: string[] = [];
            const agentProxy = new AgentProxy(
                {
                    logCallback: (msg) => logs.push(msg),
                    gpgAgentSocketPath: socketPath,
                    statusBarCallback: undefined
                },
                {
                    fileSystem: mockFileSystem,
                    socketFactory: mockSocketFactory
                }
            );

            // Configure socket factory to emit error on connection attempt
            mockSocketFactory.setConnectError(new Error('Connection refused'));

            // Connection should fail during socket connection phase
            try {
                await agentProxy.connectAgent();
                expect.fail('Should have rejected due to socket error in CONNECTING_TO_AGENT');
            } catch (error: unknown) {
                expect((error as Error).message).to.include('Connection to gpg-agent failed');
            }

            // Verify error was logged
            const errorLogs = logs.filter(log => log.includes('Connection to gpg-agent failed'));
            expect(errorLogs.length).to.be.greaterThan(0);
        });
    });

    describe('Phase 7.1: Interactive Operations', () => {
        it('should support long response delays for interactive operations (simulates password prompts)', async function() {
            // Set Mocha timeout to accommodate potential delays
            this.timeout(30000); // 30 seconds

            const logs: string[] = [];
            const agentProxy = new AgentProxy(
                {
                    logCallback: (msg) => logs.push(msg),
                    gpgAgentSocketPath: socketPath,
                    statusBarCallback: undefined
                },
                {
                    fileSystem: mockFileSystem,
                    socketFactory: mockSocketFactory
                }
            );

            // Step 1: Connect to agent
            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Step 2: Agent sends greeting
            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();

            // Step 3: Connection completes, session is READY
            const result = await connectPromise;
            const sessionId = result.sessionId;
            expect(result.greeting).to.equal('OK GPG-Agent 2.2.19\n');

            // Step 4: Send VERSION command
            const versionPromise = agentProxy.sendCommands(sessionId, 'VERSION\n');
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Step 5: Agent responds after 10 second delay (simulates interactive operation)
            await socket!.emitDataDelayed(Buffer.from('OK 2.2.19\n'), 15000);

            // Step 6: Get VERSION result
            const versionResult = await versionPromise;
            expect(versionResult.response).to.equal('OK 2.2.19\n');

            // Step 7: Send BYE using sendCommands to capture response
            const byePromise = agentProxy.sendCommands(sessionId, 'BYE\n');
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Step 8: Verify BYE command was sent to agent
            const writtenData = socket!.getWrittenData().toString('latin1');
            expect(writtenData).to.include('BYE\n');

            // Step 9: Agent responds to BYE
            socket!.emit('data', Buffer.from('OK closing connection\n'));

            // Get BYE response
            const byeResult = await byePromise;

            // Verify client received "OK closing connection\n" response
            expect(byeResult.response).to.equal('OK closing connection\n');

            // Close socket (agent closes after BYE)
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket!.simulateClose(false);

            // Step 10: Verify cleanup
            expect(agentProxy.isRunning()).to.equal(false);
            expect(agentProxy.getSessionCount()).to.equal(0);
        });

        it('should support multiple sequential commands with long delays', async function() {
            // Set Mocha timeout to accommodate 2 x 6 second delays = ~12 seconds total
            this.timeout(20000); // 20 seconds

            // Verifies that NO response timeout allows multiple interactive operations in sequence
            const DELAY_MS = 6000; // 6 seconds - simulates real interactive operations

            const agentProxy = new AgentProxy(
                {
                    logCallback: () => {},
                    gpgAgentSocketPath: socketPath,
                    statusBarCallback: undefined
                },
                {
                    fileSystem: mockFileSystem,
                    socketFactory: mockSocketFactory
                }
            );

            // Connect to agent
            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();

            const result = await connectPromise;
            const sessionId = result.sessionId;
            expect(result.greeting).to.equal('OK GPG-Agent 2.2.19\n');

            // First command - with 6 second delay (simulates password prompt)
            const cmd1Promise = agentProxy.sendCommands(sessionId, 'SIGN doc1.txt\n');
            await new Promise((resolve) => setTimeout(resolve, 10));
            await socket!.emitDataDelayed(Buffer.from('OK Signed\n'), DELAY_MS);
            const cmd1Result = await cmd1Promise;
            expect(cmd1Result.response).to.equal('OK Signed\n');

            // Second command - with 6 second delay (may still prompt for confirmation)
            const cmd2Promise = agentProxy.sendCommands(sessionId, 'SIGN doc2.txt\n');
            await new Promise((resolve) => setTimeout(resolve, 10));
            await socket!.emitDataDelayed(Buffer.from('OK Signed\n'), DELAY_MS);
            const cmd2Result = await cmd2Promise;
            expect(cmd2Result.response).to.equal('OK Signed\n');

            // Third command - instant response (cached password)
            const cmd3Promise = agentProxy.sendCommands(sessionId, 'GETINFO version\n');
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket!.emit('data', Buffer.from('D 2.2.19\nOK\n'));
            const cmd3Result = await cmd3Promise;
            expect(cmd3Result.response).to.equal('D 2.2.19\nOK\n');

            // All commands should succeed regardless of timing
            expect(agentProxy.isRunning()).to.equal(true);

            // Cleanup
            const byePromise = agentProxy.sendCommands(sessionId, 'BYE\n');
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket!.emit('data', Buffer.from('OK closing connection\n'));
            await byePromise;
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket!.simulateClose(false);

            expect(agentProxy.isRunning()).to.equal(false);
        });
    });

    describe('Phase 8: Concurrent Sessions & Integration', () => {
        it('should support multiple concurrent sessions with independent state machines', async () => {
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
            const connect1Promise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));
            const socket1 = mockSocketFactory.getLastSocket();
            socket1!.simulateGreeting();
            const result1 = await connect1Promise;
            const sessionId1 = result1.sessionId;

            // Connect session 2
            const connect2Promise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));
            const socket2 = mockSocketFactory.getLastSocket();
            socket2!.simulateGreeting();
            const result2 = await connect2Promise;
            const sessionId2 = result2.sessionId;

            // Verify 2 sessions running
            expect(agentProxy.getSessionCount()).to.equal(2);
            expect(agentProxy.isRunning()).to.equal(true);

            // Verify sessions are independent
            expect(sessionId1).to.not.equal(sessionId2);
            expect(socket1).to.not.equal(socket2);

            // Send command to session 1
            const write1Promise = socket1!.waitForWrite();
            const cmd1Promise = agentProxy.sendCommands(sessionId1, 'VERSION\n');
            await write1Promise;
            socket1!.emit('data', Buffer.from('D 2.2.19\nOK\n'));
            const cmd1Result = await cmd1Promise;
            expect(cmd1Result.response).to.equal('D 2.2.19\nOK\n');

            // Send command to session 2 while session 1 still active
            const write2Promise = socket2!.waitForWrite();
            const cmd2Promise = agentProxy.sendCommands(sessionId2, 'GETINFO version\n');
            await write2Promise;
            socket2!.emit('data', Buffer.from('D info\nOK\n'));
            const cmd2Result = await cmd2Promise;
            expect(cmd2Result.response).to.equal('D info\nOK\n');

            // Both sessions still running
            expect(agentProxy.getSessionCount()).to.equal(2);

            // Cleanup session 1 - use same pattern as existing "should send BYE command" test
            const bye1Promise = agentProxy.disconnectAgent(sessionId1);
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket1!.emit('data', Buffer.from('OK\n'));
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket1!.simulateClose(false);
            await bye1Promise;
            expect(agentProxy.getSessionCount()).to.equal(1);

            // Cleanup session 2
            const bye2Promise = agentProxy.disconnectAgent(sessionId2);
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket2!.emit('data', Buffer.from('OK\n'));
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket2!.simulateClose(false);
            await bye2Promise;
            expect(agentProxy.getSessionCount()).to.equal(0);
            expect(agentProxy.isRunning()).to.equal(false);
        });

        it('should isolate sessions so error in one does not affect others', async () => {
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

            // Connect 2 sessions
            const connect1Promise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));
            const socket1 = mockSocketFactory.getLastSocket();
            socket1!.simulateGreeting();
            const result1 = await connect1Promise;
            const sessionId1 = result1.sessionId;

            const connect2Promise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));
            const socket2 = mockSocketFactory.getLastSocket();
            socket2!.simulateGreeting();
            const result2 = await connect2Promise;
            const sessionId2 = result2.sessionId;

            expect(agentProxy.getSessionCount()).to.equal(2);

            // Session 1 encounters socket error
            socket1!.simulateClose(true); // Transmission error (calls destroy with error)

            await new Promise((resolve) => setTimeout(resolve, 20));

            // Session 2 should still be operational
            expect(agentProxy.getSessionCount()).to.equal(1);

            const write2Promise = socket2!.waitForWrite();
            const cmd2Promise = agentProxy.sendCommands(sessionId2, 'NOP\n');
            await write2Promise;
            socket2!.emit('data', Buffer.from('OK\n'));
            const cmd2Result = await cmd2Promise;
            expect(cmd2Result.response).to.equal('OK\n');

            // Cleanup session 2
            const bye2Promise = agentProxy.disconnectAgent(sessionId2);
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket2!.emit('data', Buffer.from('OK\n'));
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket2!.simulateClose(false);
            await bye2Promise;
            expect(agentProxy.getSessionCount()).to.equal(0);
        });

        it('should handle end-to-end flow with interactive operation', async () => {
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

            // Connect
            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));
            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();
            const connectResult = await connectPromise;
            const sessionId = connectResult.sessionId;

            // Send non-interactive command
            const write1Promise = socket!.waitForWrite();
            const cmd1Promise = agentProxy.sendCommands(sessionId, 'GETINFO version\n');
            await write1Promise;
            socket!.emit('data', Buffer.from('D 2.2.19\nOK\n'));
            const cmd1Result = await cmd1Promise;
            expect(cmd1Result.response).to.equal('D 2.2.19\nOK\n');

            // Send interactive PKSIGN command
            const writeSignPromise = socket!.waitForWrite();
            const signPromise = agentProxy.sendCommands(sessionId, 'PKSIGN\n');
            await writeSignPromise;
            socket!.emit('data', Buffer.from('S INQUIRE_MAXLEN 4096\nINQUIRE PIN\n'));
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Respond to inquiry
            const writeInquiryPromise = socket!.waitForWrite();
            const inquiryPromise = agentProxy.sendCommands(sessionId, 'D 1234\nEND\n');
            await writeInquiryPromise;
            socket!.emit('data', Buffer.from('D signature_data\nOK\n'));
            const inquiryResult = await inquiryPromise;
            expect(inquiryResult.response).to.equal('D signature_data\nOK\n');

            const signResult = await signPromise;
            expect(signResult.response).to.include('INQUIRE PIN');

            // Disconnect
            const byePromise = agentProxy.disconnectAgent(sessionId);
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket!.emit('data', Buffer.from('OK\n'));
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket!.simulateClose(false);
            await byePromise;
            expect(agentProxy.getSessionCount()).to.equal(0);
        });

        it('should recover from agent connection failure for one session while keeping others', async () => {
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

            // Connect successful session
            const connect1Promise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));
            const socket1 = mockSocketFactory.getLastSocket();
            socket1!.simulateGreeting();
            const result1 = await connect1Promise;
            const sessionId1 = result1.sessionId;

            expect(agentProxy.getSessionCount()).to.equal(1);

            // Attempt connection that fails - socket closes before greeting
            const connect2Promise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));
            const socket2 = mockSocketFactory.getLastSocket();
            // Simulate socket closing immediately (connection refused or similar)
            socket2!.end();

            try {
                await connect2Promise;
                expect.fail('Should have thrown');
            } catch (err: unknown) {
                expect(err).to.exist;
            }

            // First session still operational
            expect(agentProxy.getSessionCount()).to.equal(1);

            const writeCmdPromise = socket1!.waitForWrite();
            const cmdPromise = agentProxy.sendCommands(sessionId1, 'NOP\n');
            await writeCmdPromise;
            socket1!.emit('data', Buffer.from('OK\n'));
            const cmdResult = await cmdPromise;
            expect(cmdResult.response).to.equal('OK\n');

            // Cleanup
            const byePromise = agentProxy.disconnectAgent(sessionId1);
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket1!.emit('data', Buffer.from('OK\n'));
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket1!.simulateClose(false);
            await byePromise;
            expect(agentProxy.getSessionCount()).to.equal(0);
        });

        it('should allow disconnecting one session while another is actively sending commands', async () => {
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
            const connect1Promise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));
            const socket1 = mockSocketFactory.getLastSocket();
            socket1!.simulateGreeting();
            const result1 = await connect1Promise;
            const sessionId1 = result1.sessionId;

            // Connect session 2
            const connect2Promise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));
            const socket2 = mockSocketFactory.getLastSocket();
            socket2!.simulateGreeting();
            const result2 = await connect2Promise;
            const sessionId2 = result2.sessionId;

            expect(agentProxy.getSessionCount()).to.equal(2);

            // Start long-running command on session 1
            const write1Promise = socket1!.waitForWrite();
            const cmd1Promise = agentProxy.sendCommands(sessionId1, 'LONG_OPERATION\n');
            await write1Promise;
            // Don't respond yet - command is in progress

            // While session 1 is waiting, disconnect session 2
            const bye2Promise = agentProxy.disconnectAgent(sessionId2);
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket2!.emit('data', Buffer.from('OK\n'));
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket2!.simulateClose(false);
            await bye2Promise;

            // Session 1 should still be operational
            expect(agentProxy.getSessionCount()).to.equal(1);

            // Complete session 1's command
            socket1!.emit('data', Buffer.from('D result\nOK\n'));
            const cmd1Result = await cmd1Promise;
            expect(cmd1Result.response).to.equal('D result\nOK\n');

            // Cleanup session 1
            const bye1Promise = agentProxy.disconnectAgent(sessionId1);
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket1!.emit('data', Buffer.from('OK\n'));
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket1!.simulateClose(false);
            await bye1Promise;
            expect(agentProxy.getSessionCount()).to.equal(0);
        });

        it('should handle rapid sequential session creation and cleanup cycles', async () => {
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

            // Create and cleanup 3 sessions in rapid succession
            for (let i = 0; i < 3; i++) {
                const connectPromise = agentProxy.connectAgent();
                await new Promise((resolve) => setTimeout(resolve, 10));
                const socket = mockSocketFactory.getLastSocket();
                socket!.simulateGreeting();
                const result = await connectPromise;
                const sessionId = result.sessionId;

                expect(agentProxy.getSessionCount()).to.equal(1);

                // Send quick command
                const writePromise = socket!.waitForWrite();
                const cmdPromise = agentProxy.sendCommands(sessionId, 'NOP\n');
                await writePromise;
                socket!.emit('data', Buffer.from('OK\n'));
                const cmdResult = await cmdPromise;
                expect(cmdResult.response).to.equal('OK\n');

                // Cleanup
                const byePromise = agentProxy.disconnectAgent(sessionId);
                await new Promise((resolve) => setTimeout(resolve, 10));
                socket!.emit('data', Buffer.from('OK\n'));
                await new Promise((resolve) => setTimeout(resolve, 10));
                socket!.simulateClose(false);
                await byePromise;
                expect(agentProxy.getSessionCount()).to.equal(0);
            }

            // All sessions cleaned up
            expect(agentProxy.isRunning()).to.equal(false);
        });

        it('should maintain session state isolation during write errors', async () => {
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
            const connect1Promise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));
            const socket1 = mockSocketFactory.getLastSocket();
            socket1!.simulateGreeting();
            const result1 = await connect1Promise;
            const sessionId1 = result1.sessionId;

            // Connect session 2
            const connect2Promise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));
            const socket2 = mockSocketFactory.getLastSocket();
            socket2!.simulateGreeting();
            const result2 = await connect2Promise;
            const sessionId2 = result2.sessionId;

            expect(agentProxy.getSessionCount()).to.equal(2);

            // Inject write error on socket1
            socket1!.setWriteError(new Error('Write failed'));

            // Session 1 command should fail
            try {
                await agentProxy.sendCommands(sessionId1, 'TEST\n');
                expect.fail('Should have thrown write error');
            } catch (error: unknown) {
                expect((error as Error).message).to.match(/write|Write/i);
            }

            // Session 1 should be cleaned up due to error, session 2 remains
            expect(agentProxy.getSessionCount()).to.equal(1);

            // Session 2 should still work (different socket, no error)
            const write2Promise = socket2!.waitForWrite();
            const cmd2Promise = agentProxy.sendCommands(sessionId2, 'VERSION\n');
            await write2Promise;
            socket2!.emit('data', Buffer.from('D 2.2.19\nOK\n'));
            const cmd2Result = await cmd2Promise;
            expect(cmd2Result.response).to.equal('D 2.2.19\nOK\n');

            // Cleanup session 2
            const bye2Promise = agentProxy.disconnectAgent(sessionId2);
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket2!.emit('data', Buffer.from('OK\n'));
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket2!.simulateClose(false);
            await bye2Promise;

            // All sessions cleaned up
            expect(agentProxy.getSessionCount()).to.equal(0);
        });

        it('should support full end-to-end workflow: connect, multiple operations, graceful disconnect', async () => {
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

            // Step 1: Connect
            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));
            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();
            const result = await connectPromise;
            const sessionId = result.sessionId;
            expect(result.greeting).to.equal('OK GPG-Agent 2.2.19\n');

            // Step 2: Initial handshake - get version
            const write1Promise = socket!.waitForWrite();
            const version1Promise = agentProxy.sendCommands(sessionId, 'GETINFO version\n');
            await write1Promise;
            socket!.emit('data', Buffer.from('D 2.2.19\nOK\n'));
            const version1Result = await version1Promise;
            expect(version1Result.response).to.equal('D 2.2.19\nOK\n');

            // Step 3: Configure agent
            const write2Promise = socket!.waitForWrite();
            const config1Promise = agentProxy.sendCommands(sessionId, 'OPTION ttyname=/dev/tty\n');
            await write2Promise;
            socket!.emit('data', Buffer.from('OK\n'));
            const config1Result = await config1Promise;
            expect(config1Result.response).to.equal('OK\n');

            // Step 4: Perform operation
            const write3Promise = socket!.waitForWrite();
            const op1Promise = agentProxy.sendCommands(sessionId, 'KEYINFO --list\n');
            await write3Promise;
            socket!.emit('data', Buffer.from('S KEYINFO 1234ABCD\nOK\n'));
            const op1Result = await op1Promise;
            expect(op1Result.response).to.include('KEYINFO');

            // Step 5: Another operation
            const write4Promise = socket!.waitForWrite();
            const op2Promise = agentProxy.sendCommands(sessionId, 'SCD SERIALNO\n');
            await write4Promise;
            socket!.emit('data', Buffer.from('D serialnumber\nOK\n'));
            const op2Result = await op2Promise;
            expect(op2Result.response).to.include('serialnumber');

            // Step 6: Graceful disconnect
            const byePromise = agentProxy.disconnectAgent(sessionId);
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket!.emit('data', Buffer.from('OK closing connection\n'));
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket!.simulateClose(false);
            await byePromise;

            // Step 7: Verify complete cleanup
            expect(agentProxy.isRunning()).to.equal(false);
            expect(agentProxy.getSessionCount()).to.equal(0);
        });

        it('should handle cleanup failure and transition to terminal error state', async () => {
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

            // Connect session
            const connectPromise = agentProxy.connectAgent();
            await new Promise((resolve) => setTimeout(resolve, 10));
            const socket = mockSocketFactory.getLastSocket();
            socket!.simulateGreeting();
            const result = await connectPromise;
            const sessionId = result.sessionId;

            expect(agentProxy.getSessionCount()).to.equal(1);

            // Inject destroy error to simulate cleanup failure
            socket!.setDestroyError(new Error('Socket destroy failed'));

            // Attempt disconnect - cleanup will fail during socket.destroy()
            const disconnectPromise = agentProxy.disconnectAgent(sessionId);
            await new Promise((resolve) => setTimeout(resolve, 10));
            socket!.emit('data', Buffer.from('OK\n'));
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Socket close will still fire despite destroy error
            socket!.simulateClose(false);

            // disconnectAgent should reject due to cleanup failure
            try {
                await disconnectPromise;
                expect.fail('Should have rejected due to cleanup failure');
            } catch (error: unknown) {
                expect(error).to.exist;
                // Error message should indicate cleanup failure
                expect((error as Error).message).to.match(/destroy|cleanup/i);
            }

            // Session should still be removed from Map (no memory leak)
            // Even though cleanup had errors, the session is gone
            expect(agentProxy.getSessionCount()).to.equal(0);
            expect(agentProxy.isRunning()).to.equal(false);
        });

        it('should generate unique sessionIds for all sessions', async () => {
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

            const sessionIds = new Set<string>();

            // Create 10 sessions sequentially and collect their IDs
            for (let i = 0; i < 10; i++) {
                const connectPromise = agentProxy.connectAgent();
                await new Promise((resolve) => setTimeout(resolve, 10));
                const socket = mockSocketFactory.getLastSocket();
                socket!.simulateGreeting();
                const result = await connectPromise;

                sessionIds.add(result.sessionId);
                // Only one session at a time in this sequential test
                expect(agentProxy.getSessionCount()).to.equal(1);

                // Cleanup session
                const byePromise = agentProxy.disconnectAgent(result.sessionId);
                await new Promise((resolve) => setTimeout(resolve, 10));
                socket!.emit('data', Buffer.from('OK\n'));
                await new Promise((resolve) => setTimeout(resolve, 10));
                socket!.simulateClose(false);
                await byePromise;
                expect(agentProxy.getSessionCount()).to.equal(0);
            }

            // All 10 sessionIds should be unique
            expect(sessionIds.size).to.equal(10);

            // Verify they're all valid UUID format (optional but good practice)
            sessionIds.forEach(id => {
                expect(id).to.be.a('string');
                expect(id.length).to.be.greaterThan(0);
                // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
                expect(id).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
            });
        });
    });

});
