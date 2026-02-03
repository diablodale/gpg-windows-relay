/**
 * GPG Agent Relay Implementation
 *
 * This module handles the actual relay between Linux remote (WSL/container) GPG agent
 * and Windows host Gpg4win named pipes.
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
    private detectedGpg4winPath: string | null = null;
    private detectedAgentPipe: string | null = null;
    private detectedNpipeRelay: string | null = null;

    constructor(private config: RelayConfig) {}

    /**
     * Set a callback for logging messages
     */
    public setLogCallback(callback: (message: string) => void): void {
        this.logCallback = callback;
    }

    /**
     * Get the detected Gpg4win path
     */
    public getGpg4winPath(): string | null {
        return this.detectedGpg4winPath;
    }

    /**
     * Get the detected GPG agent pipe
     */
    public getAgentPipe(): string | null {
        return this.detectedAgentPipe;
    }

    /**
     * Get the detected npiperelay path
     */
    public getNpipeRelayPath(): string | null {
        return this.detectedNpipeRelay;
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

        // Find Gpg4win installation
        this.log('Searching for Gpg4win installation...');
        const gpg4winPath = await this.findGpg4WinPath();
        if (!gpg4winPath) {
            throw new Error('GPG4Win not found. Please install Gpg4win or configure gpgRelay.gpg4winPath');
        }
        this.detectedGpg4winPath = gpg4winPath;        this.log(`Found Gpg4win at: ${gpg4winPath}`);

        // Verify gpgconf.exe exists (utilities tool from Gpg4win)
        const gpgconfPath = path.join(gpg4winPath, 'gpgconf.exe');
        this.log(`Checking for gpgconf.exe at: ${gpgconfPath}`);

        if (!fs.existsSync(gpgconfPath)) {
            throw new Error(`gpgconf.exe not found at: ${gpgconfPath}`);
        }

        this.log('gpgconf.exe found - Gpg4win is properly installed');

        // Find the Windows GPG agent named pipe using gpgconf
        this.log('Querying GPG agent socket location using gpgconf...');
        const gpgAgentPipe = await this.queryGpgAgentSocketWithGpgconf(gpgconfPath);
        if (!gpgAgentPipe) {
            throw new Error('Could not find GPG agent socket/pipe using gpgconf. Is gpg-agent running?');
        }

        this.detectedAgentPipe = gpgAgentPipe;
        this.log(`Found GPG agent pipe: ${gpgAgentPipe}`);

        // Find npiperelay for the relay bridge
        this.log('Searching for npiperelay.exe...');
        const npipeRelayPath = await this.findNpipeRelay();
        if (!npipeRelayPath) {
            throw new Error('npiperelay.exe not found. Please install npiperelay. See: https://github.com/jstarks/npiperelay');
        }

        this.detectedNpipeRelay = npipeRelayPath;
        this.log(`Found npiperelay at: ${npipeRelayPath}`);

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
     * Find npiperelay.exe installation
     * Checks PATH, common install locations, and WSL interop
     */
    private async findNpipeRelay(): Promise<string | null> {
        // 1. Check if npiperelay is in PATH
        this.log('Checking PATH for npiperelay.exe...');
        const inPath = await this.checkCommandInPath('npiperelay.exe', ['--help']);
        if (inPath) {
            this.log('Found npiperelay.exe in PATH');
            return 'npiperelay.exe';
        }

        // 2. Check common installation locations
        const npipeLocations = [
            path.join(os.homedir(), '.local', 'bin', 'npiperelay.exe'),
            path.join(os.homedir(), 'scoop', 'apps', 'npiperelay', 'current', 'npiperelay.exe'),
            path.join(process.env.LOCALAPPDATA || '', 'Programs', 'npiperelay', 'npiperelay.exe'),
            'C:\\Program Files\\npiperelay\\npiperelay.exe',
            'C:\\Program Files (x86)\\npiperelay\\npiperelay.exe'
        ];

        for (const location of npipeLocations) {
            this.log(`Checking: ${location}`);
            if (fs.existsSync(location)) {
                this.log(`Found npiperelay at: ${location}`);
                return location;
            }
        }

        // 3. Try to run from current directory
        if (fs.existsSync('./npiperelay.exe')) {
            this.log('Found npiperelay.exe in current directory');
            return './npiperelay.exe';
        }

        this.log('npiperelay not found in any standard location');
        return null;
    }

    /**
     * Check if a command exists in PATH
     */
    private async checkCommandInPath(command: string, args: string[] = []): Promise<boolean> {
        return new Promise((resolve) => {
            try {
                const proc = spawn(command, args, {
                    stdio: 'ignore',
                    timeout: 1000,
                    shell: true
                });

                proc.on('exit', (code) => {
                    // Exit code 0 means command was successful
                    resolve(code === 0);
                });

                proc.on('error', () => {
                    resolve(false);
                });

                setTimeout(() => resolve(false), 1000);
            } catch (error) {
                resolve(false);
            }
        });
    }

    /**
     * Find GPG4Win installation directory
     * Checks in order: config path, 64-bit default, 32-bit default
     */
    private async findGpg4WinPath(): Promise<string | null> {
        // 1. Try configured path first
        if (this.config.gpg4winPath) {
            const testPath = path.join(this.config.gpg4winPath, 'gpgconf.exe');
            if (fs.existsSync(testPath)) {
                this.log(`Found Gpg4win at configured path: ${this.config.gpg4winPath}`);
                return this.config.gpg4winPath;
            } else {
                this.log(`Configured path does not contain gpgconf.exe: ${this.config.gpg4winPath}`);
            }
        }

        // 2. Try 64-bit default location (newer Gpg4win)
        const gpg4win64Paths = [
            'C:\\Program Files\\GnuPG\\bin',
            'C:\\Program Files\\Gpg4win\\bin'
        ];

        for (const checkPath of gpg4win64Paths) {
            const testPath = path.join(checkPath, 'gpgconf.exe');
            this.log(`Checking 64-bit location: ${checkPath}`);
            if (fs.existsSync(testPath)) {
                this.log(`Found Gpg4win at 64-bit location: ${checkPath}`);
                return checkPath;
            }
        }

        // 3. Try 32-bit (x86) fallback location
        const gpg4win32Paths = [
            'C:\\Program Files (x86)\\GnuPG\\bin',
            'C:\\Program Files (x86)\\Gpg4win\\bin'
        ];

        for (const checkPath of gpg4win32Paths) {
            const testPath = path.join(checkPath, 'gpgconf.exe');
            this.log(`Checking x86 location: ${checkPath}`);
            if (fs.existsSync(testPath)) {
                this.log(`Found Gpg4win at x86 location: ${checkPath}`);
                return checkPath;
            }
        }

        this.log('Gpg4win not found in any standard location');
        return null;
    }

    /**
     * Query GPG agent socket using gpgconf
     * Uses: gpgconf --list-dirs agent-socket
     */
    private async queryGpgAgentSocketWithGpgconf(gpgconfPath: string): Promise<string | null> {
        return new Promise((resolve) => {
            try {
                this.log(`Running: ${gpgconfPath} --list-dirs agent-socket`);

                const proc = spawn(gpgconfPath, ['--list-dir', 'agent-socket'], {
                    stdio: ['ignore', 'pipe', 'pipe']
                });

                let stdout = '';
                let stderr = '';

                proc.stdout?.on('data', (data) => {
                    stdout += data.toString();
                });

                proc.stderr?.on('data', (data) => {
                    stderr += data.toString();
                });

                proc.on('exit', (code) => {
                    if (code === 0 && stdout) {
                        const socketPath = stdout.trim();
                        this.log(`gpgconf returned socket: ${socketPath}`);
                        resolve(socketPath);
                    } else {
                        this.log(`gpgconf failed with code ${code}, stderr: ${stderr}`);
                        // Fallback to standard pipe name if gpgconf fails
                        resolve('\\\\.\\pipe\\gpg-agent');
                    }
                });

                proc.on('error', (err) => {
                    this.log(`Failed to run gpgconf: ${err}`);
                    // Fallback to standard pipe name
                    resolve('\\\\.\\pipe\\gpg-agent');
                });
            } catch (error) {
                this.log(`Exception querying gpgconf: ${error}`);
                // Fallback to standard pipe name
                resolve('\\\\.\\pipe\\gpg-agent');
            }
        });
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
