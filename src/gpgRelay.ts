/**
 * GPG Agent Relay Implementation
 * 
 * This module handles the actual relay between Linux remote (WSL/container) GPG agent
 * and Windows host gpg4win named pipes.
 * 
 * The relay uses:
 * - npiperelay.exe (or socat on Windows) to bridge Unix domain sockets to Windows named pipes
 * - socat in the remote environment to forward the GPG agent socket
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export interface RelayConfig {
    gpg4winPath: string;
    debugLogging: boolean;
    remoteName?: string;
}

export class GpgRelay {
    private processes: ChildProcess[] = [];
    private logCallback?: (message: string) => void;

    constructor(private config: RelayConfig) {}

    /**
     * Set a callback for logging messages
     */
    public setLogCallback(callback: (message: string) => void): void {
        this.logCallback = callback;
    }

    private log(message: string): void {
        if (this.config.debugLogging && this.logCallback) {
            this.logCallback(message);
        }
    }

    /**
     * Start the GPG agent relay
     */
    public async start(): Promise<void> {
        this.log('Starting GPG relay...');

        // Verify gpg4win installation
        const gpgAgentPath = path.join(this.config.gpg4winPath, 'gpg-agent.exe');
        this.log(`Checking for gpg-agent at: ${gpgAgentPath}`);
        
        if (!fs.existsSync(gpgAgentPath)) {
            throw new Error(`GPG agent not found at: ${gpgAgentPath}`);
        }
        
        this.log('gpg-agent.exe found');

        // Find the Windows GPG agent socket/pipe
        this.log('Looking for GPG agent named pipe...');
        const gpgAgentPipe = await this.findGpgAgentPipe();
        if (!gpgAgentPipe) {
            throw new Error('Could not find GPG agent named pipe. Is gpg-agent running?');
        }

        this.log(`Found GPG agent pipe: ${gpgAgentPipe}`);

        // TODO: Implement the actual relay logic
        // This will require:
        // 1. Installing/checking for npiperelay.exe on Windows
        // 2. Setting up socat in the remote environment
        // 3. Creating the bridge between remote socket and Windows pipe
        
        // For WSL, the typical setup is:
        // - Windows side: npiperelay.exe -ep -s //./pipe/gpg-agent
        // - WSL side: socat UNIX-LISTEN:/path/to/socket,fork EXEC:"npiperelay.exe -ep -s //./pipe/gpg-agent",nofork
        
        this.log('Relay setup complete (implementation pending)');
        this.processes = []; // Mark as started even though actual relay isn't running yet
    }

    /**
     * Stop the GPG agent relay
     */
    public stop(): void {
        this.log('Stopping GPG relay...');
        
        for (const proc of this.processes) {
            if (!proc.killed) {
                proc.kill();
            }
        }
        
        this.processes = [];
        this.log('Relay stopped');
    }

    /**
     * Check if relay is running
     */
    public isRunning(): boolean {
        return this.processes.length > 0 && this.processes.some(p => !p.killed);
    }

    /**
     * Find the GPG agent named pipe on Windows
     */
    private async findGpgAgentPipe(): Promise<string | null> {
        // Windows GPG agent uses named pipes in the format:
        // //./pipe/gpg-agent or //./pipe/gpg-agent-extra or similar
        
        // First, try to get the pipe name from gpg-agent
        const homeDir = os.homedir();
        const gnupgDir = path.join(homeDir, 'AppData', 'Roaming', 'gnupg');
        
        // Check for gpg-agent socket info file
        const socketFiles = [
            path.join(gnupgDir, 'S.gpg-agent'),
            path.join(gnupgDir, 'S.gpg-agent.extra')
        ];

        for (const socketFile of socketFiles) {
            if (fs.existsSync(socketFile)) {
                try {
                    const content = fs.readFileSync(socketFile, 'utf-8');
                    // The file may contain the named pipe path
                    if (content.includes('pipe')) {
                        return content.trim();
                    }
                } catch (error) {
                    this.log(`Failed to read socket file ${socketFile}: ${error}`);
                }
            }
        }

        // Fallback: use standard pipe name
        return '\\\\.\\pipe\\gpg-agent';
    }

    /**
     * Check if npiperelay.exe is available
     */
    private async checkNpipeRelay(): Promise<string | null> {
        // Check common locations for npiperelay.exe
        const possiblePaths = [
            path.join(os.homedir(), '.local', 'bin', 'npiperelay.exe'),
            path.join(process.env.LOCALAPPDATA || '', 'Programs', 'npiperelay', 'npiperelay.exe'),
            'npiperelay.exe' // Check PATH
        ];

        for (const npipePath of possiblePaths) {
            if (fs.existsSync(npipePath)) {
                return npipePath;
            }
        }

        // Try running from PATH
        return new Promise((resolve) => {
            const proc = spawn('npiperelay.exe', ['--help'], { stdio: 'ignore' });
            proc.on('error', () => resolve(null));
            proc.on('exit', (code) => {
                resolve(code === 0 ? 'npiperelay.exe' : null);
            });
        });
    }
}
