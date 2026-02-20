import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
import { AgentProxy } from './services/agentProxy';
import { isTestEnvironment, isIntegrationTestEnvironment } from '@gpg-relay/shared';

// Global agent proxy service instance
let agentProxyService: AgentProxy | null = null;
let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let detectedGpg4winPath: string | null = null;
let detectedAgentSocket: string | null = null;
let probeSuccessful = false;

// This method is called when your extension is activated
export async function activate(context: vscode.ExtensionContext): Promise<void> {
	outputChannel = vscode.window.createOutputChannel('GPG Agent Proxy');
	statusBarItem = vscode.window.createStatusBarItem(context.extension.id, vscode.StatusBarAlignment.Right, 100);

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
	statusBarItem.name = 'GPG Agent Proxy';
	statusBarItem.command = 'gpg-agent-proxy.showStatus';
	updateStatusBar();
	statusBarItem.show();

	// Detect Gpg4win and agent socket on startup
	// Then start agent proxy
	// isIntegrationTestEnvironment() overrides isTestEnvironment() so integration
	// tests get full extension initialization (unit tests still skip init).
	if (!isTestEnvironment() || isIntegrationTestEnvironment()) {
		try {
			await detectGpg4winPath();
			await startAgentProxy();

			// Run sanity probe in background (fire-and-forget)
			// It will update status bar to Ready after successful probe
			probeGpgAgent();
		} catch (error: unknown) {
			outputChannel.appendLine(`Start failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

export function deactivate() {
	// TODO: implement disconnect from GPG Agent Proxy and destroy local socket; likely simillar/same as stopAgentProxy()
}

// TODO Issue Reporting as defined at https://code.visualstudio.com/api/get-started/wrapping-up#issue-reporting

// ==============================================================================
// Command handlers for inter-extension communication
// ==============================================================================

/**
 * Command: _gpg-agent-proxy.connectAgent
 *
 * Called by request-proxy to establish a connection to gpg-agent.
 * Returns a sessionId and greeting that must be relayed to the client.
 */
async function connectAgent(sessionId?: string): Promise<{ sessionId: string; greeting: string }> {
	if (!agentProxyService) {
		throw new Error('Agent proxy not initialized. Please start the extension.');
	}

	try {
		const result = await agentProxyService.connectAgent(sessionId);
		outputChannel.appendLine(`[connectAgent] Session created: ${result.sessionId}`);
		outputChannel.appendLine(`[connectAgent] Returning: ${JSON.stringify(result)}`);
		return result;
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
		throw new Error('Agent proxy not initialized. Please start the extension.');
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
		throw new Error('Agent proxy not initialized.');
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
	if (isTestEnvironment() && !isIntegrationTestEnvironment()) {
		return;
	}
	const config = vscode.workspace.getConfiguration('gpgAgentProxy');
	const configPath = config.get<string>('gpg4winPath') || '';

	// If a path is explicitly configured, use it exclusively — do not fall back to
	// auto-detection.  An invalid configured path is a user error and should fail loudly.
	if (configPath) {
		const gpgconfPath = path.join(configPath, 'gpgconf.exe');
		if (fs.existsSync(gpgconfPath)) {
			detectedGpg4winPath = configPath;
			detectAgentSocket();
			return;
		}
		throw new Error(`Gpg4win not found at configured path: ${configPath}`);
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
	if (isTestEnvironment() && !isIntegrationTestEnvironment()) {
		return;
	}
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
	if (isTestEnvironment() && !isIntegrationTestEnvironment()) {
		return;
	}
	if (agentProxyService) {
		vscode.window.showWarningMessage('Agent proxy already running');
		return;
	}

	try {
		// Ensure Gpg4win and agent socket are detected
		if (!detectedGpg4winPath || !detectedAgentSocket) {
			await detectGpg4winPath();
			if (!detectedAgentSocket) {
				throw new Error('Gpg4win not found. Please install Gpg4win or configure path.');
			}
		}

		outputChannel.appendLine('Starting agent proxy...');

		// Create a log callback that respects the debugLogging setting
		const config = vscode.workspace.getConfiguration('gpgAgentProxy');
		const debugLogging = config.get<boolean>('debugLogging') || true;	// TODO remove forced debug logging
		const logCallback = debugLogging ? (message: string) => outputChannel.appendLine(message) : undefined;

		agentProxyService = new AgentProxy({
			gpgAgentSocketPath: detectedAgentSocket,
			logCallback: logCallback,
			statusBarCallback: () => updateStatusBar()
		});

		outputChannel.appendLine('Agent proxy initialized. Probe of gpg-agent in process. Status will be READY when complete.');
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		outputChannel.appendLine(`Error starting agent proxy: ${errorMessage}`);
		outputChannel.show(true);
		vscode.window.showErrorMessage(`Failed to start agent proxy: ${errorMessage}`);
		agentProxyService = null;
		throw error; // propagate so callers (commands, tests) can observe failure
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
	agentProxyService.dispose();
	agentProxyService = null;
	// Reset detected state so the next start re-detects (e.g. if Gpg4win path changed).
	detectedGpg4winPath = null;
	detectedAgentSocket = null;
	probeSuccessful = false;

	updateStatusBar();
	outputChannel.appendLine('Agent proxy stopped');
	vscode.window.showInformationMessage('Agent proxy stopped');
}

/**
 * Restart the agent proxy service
 */
async function restartAgentProxy(): Promise<void> {
	await stopAgentProxy();
	await new Promise((resolve) => setTimeout(resolve, 500));
	try {
		await startAgentProxy();
	} catch (error) {
		// startAgentProxy already logged and showed the error; just re-throw
		throw error;
	}
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
function updateStatusBar(): void {
	let icon = '$(circle-slash)';
	let tooltip = 'GPG Agent Proxy is not ready';

	if (agentProxyService && probeSuccessful) {
		const sessionCount = agentProxyService.getSessionCount();
		if (sessionCount > 0) {
			icon = '$(sync~spin)';
			tooltip = `GPG Agent Proxy is active with ${sessionCount} session${sessionCount > 1 ? 's' : ''}`;
		} else {
			icon = '$(check)';
			tooltip = 'GPG Agent Proxy is ready';
		}
	}

	statusBarItem.text = `${icon} GPG`;
	statusBarItem.tooltip = tooltip;
	statusBarItem.accessibilityInformation = {
		label: tooltip
	};
}

/**
 * Sanity probe: Send GETINFO version to verify agent is responsive
 * Runs async after activation, doesn't block startup
 * Sets probeSuccessful flag and updates status bar
 */
async function probeGpgAgent(): Promise<void> {
	if (!agentProxyService) {
		return;
	}

	try {
		const result = await agentProxyService.connectAgent();
		await agentProxyService.sendCommands(result.sessionId, 'GETINFO version\n');
		await agentProxyService.disconnectAgent(result.sessionId);
		outputChannel.appendLine('Probe of gpg-agent succeeded. Agent proxy is READY.');
		probeSuccessful = true;
		updateStatusBar();
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		outputChannel.appendLine(`Probe of gpg-agent failed. Agent proxy is NOT READY: ${msg}`);
	}
}
