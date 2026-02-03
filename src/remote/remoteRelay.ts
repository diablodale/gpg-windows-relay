/**
 * Remote Relay Service
 *
 * Unified implementation for all remote types (WSL, Dev Container, SSH).
 * Creates a Unix socket listener on the GPG socket path and forwards to Windows bridge.
 *
 * This runs identically on all three remote types - no platform-specific logic needed.
 */

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

export interface RemoteRelayConfig {
    windowsHost: string;  // Usually 'localhost', tunneled by VS Code
    windowsPort: number;  // Port of Windows Assuan bridge
    logCallback?: (message: string) => void;
}

export interface RemoteRelayInstance {
    stop(): Promise<void>;
}

/**
 * Start the remote relay
 */
export async function startRemoteRelay(config: RemoteRelayConfig): Promise<RemoteRelayInstance> {
    const socketPath = await getLocalGpgSocketPath();
    if (!socketPath) {
        throw new Error(
            'Could not determine local GPG socket path. ' +
            'Is gpg-agent running? Try: gpgconf --list-dir agent-socket'
        );
    }

    log(config, `📂 Remote GPG Socket: ${socketPath}`);

    // Remove stale socket if it exists
    if (fs.existsSync(socketPath)) {
        try {
            fs.unlinkSync(socketPath);
            log(config, 'Removed stale socket file');
        } catch (err) {
            log(config, `Warning: could not remove stale socket: ${err}`);
        }
    }

    // Ensure parent directory exists
    const socketDir = path.dirname(socketPath);
    if (!fs.existsSync(socketDir)) {
        fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
    }

    // Create the Unix socket server
    const server = net.createServer((localSocket) => {
        log(config, '📥 Incoming connection from remote GPG client');

        // Connect to Windows bridge
        const remoteSocket = net.createConnection({
            host: config.windowsHost,
            port: config.windowsPort,
            family: 4  // IPv4
        });

        remoteSocket.on('connect', () => {
            log(config, '🔗 Remote relay connected to host bridge');

            // Manual bidirectional forwarding with immediate termination on either side closing
            // (matches npiperelay -ep -ei behavior)

            localSocket.on('data', (data: Buffer) => {
                remoteSocket.write(data);
            });

            remoteSocket.on('data', (data: Buffer) => {
                localSocket.write(data);
            });
        });

        remoteSocket.on('error', (err: Error) => {
            log(config, `❌ Remote relay encountered local bridge error: ${err.message}`);
            localSocket.destroy();
        });

        remoteSocket.on('end', () => {
            log(config, '🔌 Remote relay terminating due to local bridge disconnecting');
            localSocket.destroy();
        });

        localSocket.on('error', (err: Error) => {
            log(config, `❌ Local bridge encountered remote relay error: ${err.message}`);
            remoteSocket.destroy();
        });

        localSocket.on('end', () => {
            log(config, '🔌 Local bridge terminating due to remote relay disconnecting');
            remoteSocket.destroy();
        });
    });

    server.on('error', (err: Error) => {
        log(config, `Server error: ${err.message}`);
    });

    return new Promise((resolve, reject) => {
        server.listen(socketPath, () => {
            // Make socket readable/writable by all users
            try {
                fs.chmodSync(socketPath, 0o666);
            } catch (err) {
                log(config, `Warning: could not chmod socket: ${err}`);
            }

            log(config, `✅ Remote relay listening on ${socketPath}`);

            resolve({
                stop: async () => {
                    return new Promise((stopResolve) => {
                        server.close(() => {
                            try {
                                fs.unlinkSync(socketPath);
                            } catch (err) {
                                // Ignore
                            }
                            log(config, '✅ Remote relay stopped');
                            stopResolve();
                        });
                    });
                }
            });
        });

        server.on('error', reject);
    });
}

/**
 * Get the local GPG socket path by querying gpgconf
 */
async function getLocalGpgSocketPath(): Promise<string | null> {
    return new Promise((resolve) => {
        try {
            const result = spawnSync('gpgconf', ['--list-dir', 'agent-socket'], {
                encoding: 'utf-8',
                timeout: 5000
            });

            if (result.error) {
                resolve(null);
                return;
            }

            if (result.status !== 0) {
                resolve(null);
                return;
            }

            const socketPath = result.stdout.trim();
            resolve(socketPath || null);
        } catch (err) {
            resolve(null);
        }
    });
}

/**
 * Log helper
 */
function log(config: RemoteRelayConfig, message: string): void {
    if (config.logCallback) {
        config.logCallback(message);
    }
}
