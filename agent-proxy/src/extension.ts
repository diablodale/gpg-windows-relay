import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
import { AgentProxy } from './services/agentProxy';

// Global agent proxy service instance
let agentProxyService: AgentProxy | null = null;
let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let detectedGpg4winPath: string | null = null;
let detectedAgentSocket: string | null = null;

// This method is called when your extension is activated
export async function activate(context: vscode.ExtensionContext): Promise<void> {
	outputChannel = vscode.window.createOutputChannel('GPG Agent Proxy');
	statusBarItem = vscode.window.createStatusBarItem('gpg-agent-proxy', vscode.StatusBarAlignment.Right, 100);

	outputChannel.appendLine('GPG Agent Proxy activated');

	// Register three command handlers for inter-extension communication
	context.subscriptions.push(
		// Internal commands called by request-proxy extension, hidden from user with underscore prefix
		vscode.commands.registerCommand('_gpg-agent-proxy.connectAgent', connectAgent),
		vscode.commands.registerCommand('_gpg-agent-proxy.sendCommands', sendCommands),
		vscode.commands.registerCommand('_gpg-agent-proxy.disconnectAgent', disconnectAgent),
		// UI commands visible to user
		vscode.commands.registerCommand('gpg-agent-proxy.start', startAgentProxy),
		vscode.commands.registerCommand('gpg-agent-proxy.stop', stopAgentProxy),
		vscode.commands.registerCommand('gpg-agent-proxy.restart', restartAgentProxy),
		vscode.commands.registerCommand('gpg-agent-proxy.showStatus', showStatus),
		outputChannel,
		statusBarItem
	);

	outputChannel.appendLine('Commands registered');

	// Update status bar
	updateStatusBar();
	statusBarItem.show();

	// Detect Gpg4win and agent socket on startup
	// Then start agent proxy
	try {
		await detectGpg4winPath();
		await startAgentProxy();

		// Run sanity probe in background (fire-and-forget)
		// It will update status bar to Ready after successful probe
		probeGpgAgent().catch((err) => {
			outputChannel.appendLine(`Sanity probe failed: ${err instanceof Error ? err.message : String(err)}`);
		});
	} catch (error: unknown) {
		outputChannel.appendLine(`Start failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

// ==============================================================================
// Command handlers for inter-extension communication
// ==============================================================================

/**
 * Command: _gpg-agent-proxy.connectAgent
 *
 * Called by request-proxy to establish a connection to gpg-agent.
 * Returns a sessionId that must be used for subsequent sendCommands calls.
 */
async function connectAgent(): Promise<{ sessionId: string }> {
	if (!agentProxyService) {
		throw new Error('Agent proxy service not initialized. Please start the extension.');
	}

	try {
		const sessionId = await agentProxyService.connectAgent();
		outputChannel.appendLine(`[connectAgent] Session created: ${sessionId}`);
		return { sessionId };
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		outputChannel.appendLine(`[connectAgent] Error: ${msg}`);
		throw error;
	}
}

/**
 * Command: _gpg-agent-proxy.sendCommands
 *
 * Called by request-proxy to send a command block to gpg-agent.
 * commandBlock: complete command (e.g., "GETINFO version\n" or "D data\nEND\n")
 * Returns the complete response from gpg-agent.
 */
async function sendCommands(sessionId: string, commandBlock: string): Promise<{ response: string }> {
	if (!agentProxyService) {
		throw new Error('Agent proxy service not initialized. Please start the extension.');
	}

	try {
		const result = await agentProxyService.sendCommands(sessionId, commandBlock);
		outputChannel.appendLine(`[sendCommands] Session ${sessionId}: sent and received response`);
		return result;
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		outputChannel.appendLine(`[sendCommands] Session ${sessionId}: Error: ${msg}`);
		throw error;
	}
}

/**
 * Command: _gpg-agent-proxy.disconnectAgent
 *
 * Called by request-proxy to close a session.
 * sessionId: the session to disconnect
 */
async function disconnectAgent(sessionId: string): Promise<void> {
	if (!agentProxyService) {
		throw new Error('Agent proxy service not initialized.');
	}

	try {
		await agentProxyService.disconnectAgent(sessionId);
		outputChannel.appendLine(`[disconnectAgent] Session closed: ${sessionId}`);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		outputChannel.appendLine(`[disconnectAgent] Session ${sessionId}: Error: ${msg}`);
		throw error;
	}
}

// ==============================================================================
// UI command handlers
// ==============================================================================

/**
 * Detect Gpg4win installation path
 */
async function detectGpg4winPath(): Promise<void> {
	const config = vscode.workspace.getConfiguration('gpgAgentProxy');
	const configPath = config.get<string>('gpg4winPath') || '';

	// Check configured path first
	if (configPath) {
		const gpgconfPath = path.join(configPath, 'gpgconf.exe');
		if (fs.existsSync(gpgconfPath)) {
			detectedGpg4winPath = configPath;
			detectAgentSocket();
			return;
		}
	}

	// Check 64-bit default locations
	const gpg4win64Paths = [
		'C:\\Program Files\\GnuPG\\bin',
		'C:\\Program Files\\Gpg4win\\bin'
	];

	for (const checkPath of gpg4win64Paths) {
		const gpgconfPath = path.join(checkPath, 'gpgconf.exe');
		if (fs.existsSync(gpgconfPath)) {
			detectedGpg4winPath = checkPath;
			detectAgentSocket();
			return;
		}
	}

	// Check 32-bit (x86) default locations
	const gpg4win32Paths = [
		'C:\\Program Files (x86)\\GnuPG\\bin',
		'C:\\Program Files (x86)\\Gpg4win\\bin'
	];

	for (const checkPath of gpg4win32Paths) {
		const gpgconfPath = path.join(checkPath, 'gpgconf.exe');
		if (fs.existsSync(gpgconfPath)) {
			detectedGpg4winPath = checkPath;
			detectAgentSocket();
			return;
		}
	}

	outputChannel.appendLine('Gpg4win not found. Please install Gpg4win or configure path.');
}

/**
 * Detect GPG agent socket path
 */
function detectAgentSocket(): void {
	if (!detectedGpg4winPath) {
		return;
	}

	const gpgconfPath = path.join(detectedGpg4winPath, 'gpgconf.exe');
	if (!fs.existsSync(gpgconfPath)) {
		return;
	}

	try {
		const result = spawnSync(gpgconfPath, ['--list-dirs', 'agent-extra-socket'], {
			encoding: 'utf8',
			timeout: 2000
		});

		if (result.status === 0 && result.stdout) {
			detectedAgentSocket = result.stdout.trim();
			outputChannel.appendLine(`Detected GPG agent extra socket: ${detectedAgentSocket}`);
		}
	} catch (error) {
		// Silently fail
	}
}

/**
 * Start the agent proxy service
 */
async function startAgentProxy(): Promise<void> {
	if (agentProxyService) {
		vscode.window.showWarningMessage('Agent proxy is already running');
		return;
	}

	try {
		if (!detectedGpg4winPath || !detectedAgentSocket) {
			// Try detecting again
			await detectGpg4winPath();
			if (!detectedAgentSocket) {
				throw new Error('Gpg4win not found. Please install Gpg4win or configure path.');
			}
		}

		outputChannel.appendLine('Starting agent proxy...');

		const config = vscode.workspace.getConfiguration('gpgAgentProxy');
		const debugLogging = config.get<boolean>('debugLogging') || false;

		agentProxyService = new AgentProxy({
			gpgAgentSocketPath: detectedAgentSocket,
			debugLogging: debugLogging
		});

		agentProxyService.setLogCallback((message: string) => outputChannel.appendLine(message));
		outputChannel.appendLine('Agent proxy service initialized and ready.');
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		outputChannel.appendLine(`Error starting agent proxy: ${errorMessage}`);
		outputChannel.show(true);
		vscode.window.showErrorMessage(`Failed to start agent proxy: ${errorMessage}`);
		agentProxyService = null;
	}
}

/**
 * Stop the agent proxy service
 */
async function stopAgentProxy(): Promise<void> {
	if (!agentProxyService) {
		vscode.window.showInformationMessage('Agent proxy is not running');
		return;
	}

	outputChannel.appendLine('Stopping agent proxy...');
	agentProxyService = null;

	updateStatusBar(false);
	outputChannel.appendLine('Agent proxy stopped');
	vscode.window.showInformationMessage('Agent proxy stopped');
}

/**
 * Restart the agent proxy service
 */
async function restartAgentProxy(): Promise<void> {
	await stopAgentProxy();
	await new Promise((resolve) => setTimeout(resolve, 500));
	await startAgentProxy();
}

/**
 * Show agent proxy status
 */
function showStatus(): void {
	const gpg4winPath = detectedGpg4winPath || '(not detected)';
	const agentSocket = detectedAgentSocket || '(not detected)';

	let state = 'Inactive';
	let sessionCount = 0;
	if (agentProxyService) {
		sessionCount = agentProxyService.getSessionCount();
		state = sessionCount > 0 ? 'Active' : 'Ready';
	}

	const status = [
		'GPG Agent Proxy Status',
		'',
		`State: ${state}${sessionCount > 0 ? ` (${sessionCount} session${sessionCount > 1 ? 's' : ''})` : ''}`,
		`Gpg4win: ${gpg4winPath}`,
		`GPG agent: ${agentSocket}`
	].join('\n');

	vscode.window.showInformationMessage(status, { modal: true });
	outputChannel.show();
}

/**
 * Update the status bar item
 */
function updateStatusBar(running?: boolean): void {
	let icon = '$(circle-slash)';
	let tooltip = 'GPG agent proxy is not running';

	if (agentProxyService) {
		const sessionCount = agentProxyService.getSessionCount();
		if (sessionCount > 0) {
			icon = '$(sync~spin)';
			tooltip = `GPG agent proxy is active with ${sessionCount} session${sessionCount > 1 ? 's' : ''}`;
		} else {
			icon = '$(check)';
			tooltip = 'GPG agent proxy is ready for incoming requests';
		}
	}

	statusBarItem.text = `GPG ${icon}`;
	statusBarItem.tooltip = tooltip;
	statusBarItem.command = 'gpg-agent-proxy.showStatus';
}

/**
 * Sanity probe: Send GETINFO version to verify agent is responsive
 * Runs async after activation, doesn't block startup
 * Updates status bar to Ready on success
 */
async function probeGpgAgent(): Promise<void> {
	if (!agentProxyService) {
		return;
	}

	try {
		const sessionId = await agentProxyService.connectAgent();
		const result = await agentProxyService.sendCommands(sessionId, 'GETINFO version\n');
		await agentProxyService.disconnectAgent(sessionId);

		outputChannel.appendLine(`GPG agent sanity probe passed: ${result.response.split('\n')[0]}`);
		// Update status bar to Ready after successful probe
		updateStatusBar();
	} catch (error: unknown) {
		const msg = error instanceof Error ? error.message : String(error);
		outputChannel.appendLine(`GPG agent sanity probe failed: ${msg}`);
	}
}
