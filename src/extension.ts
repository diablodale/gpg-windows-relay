import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
import { AssuanBridge } from './services/assuanBridge';
import * as remoteExt from './remote/extension';

// Bridge state management
let bridge: AssuanBridge | null = null;
let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let detectedGpg4winPath: string | null = null;
let detectedAgentSocket: string | null = null;

// This method is called when your extension is activated
export function activate(context: vscode.ExtensionContext) {
	outputChannel = vscode.window.createOutputChannel('GPG Windows Relay');
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

	// Determine which context we're running in based on platform
	// https://code.visualstudio.com/api/advanced-topics/remote-extensions#varying-behaviors-when-running-remotely-or-in-the-codespaces-browser-editor
	// UI context (Windows): process.platform === 'win32'
	// Workspace context (remote): process.platform !== 'win32'
	const isUIContext = process.platform === 'win32';

	outputChannel.appendLine('🔐 GPG Windows Relay extension activated');
	outputChannel.appendLine(`Context: ${isUIContext ? 'UI (Windows)' : 'Remote: ' + (vscode.env.remoteName || 'unknown')}`);

	if (isUIContext) {
		// UI Context (Windows) - run bridge management code
		activateWindowsUI(context);
	} else {
		// Workspace Context (Remote) - run relay code
		outputChannel.appendLine('📡 Running in workspace context, initializing remote relay...');
		remoteExt.activate(context).catch((err) => {
			outputChannel.appendLine(`❌ Error in remote activation: ${err instanceof Error ? err.message : String(err)}`);
		});
	}
}

function activateWindowsUI(context: vscode.ExtensionContext) {

	// Register commands
	context.subscriptions.push(
		vscode.commands.registerCommand('gpg-windows-relay.start', startBridge),
		vscode.commands.registerCommand('gpg-windows-relay.stop', stopBridge),
		vscode.commands.registerCommand('gpg-windows-relay.restart', restartBridge),
		vscode.commands.registerCommand('gpg-windows-relay.showStatus', showStatus),
		vscode.commands.registerCommand('gpg-windows-relay.getRelayPort', getRelayPort),
		vscode.commands.registerCommand('gpg-windows-relay.ensureBridgeRunning', ensureBridgeRunning),
		outputChannel,
		statusBarItem
	);

	outputChannel.appendLine('✅ Local commands registered (start, stop, restart, showStatus, ensureBridgeRunning, getRelayPort)');

	// Update status bar
	updateStatusBar();
	statusBarItem.show();

	// Detect Gpg4win and agent socket on startup (async, will complete in background)
	detectGpg4winPath().catch(() => {
		// Silently ignore if gpg4win detection fails
	});

	// Auto-start bridge by default on Windows (can be disabled with autoStart: false)
	const config = vscode.workspace.getConfiguration('gpgWinRelay');
	if (config.get('autoStart', true)) {
		outputChannel.appendLine('🚀 Auto-starting local bridge...');
		startBridge().catch((error: unknown) => {
			outputChannel.appendLine(`❌ Auto-start failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	}
}

// Get the configured listen port
function getConfiguredListenPort(): number {
	const config = vscode.workspace.getConfiguration('gpgWinRelay');
	return config.get<number>('listenPort') || 63331;
}

// Detect Gpg4win installation path
async function detectGpg4winPath(): Promise<void> {
	const config = vscode.workspace.getConfiguration('gpgWinRelay');
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

	outputChannel.appendLine('⚠️  Gpg4win not found. Please install Gpg4win or configure path.');
}

// Detect GPG agent socket path
function detectAgentSocket(): void {
	if (!detectedGpg4winPath) {
		return;
	}

	const gpgconfPath = path.join(detectedGpg4winPath, 'gpgconf.exe');
	if (!fs.existsSync(gpgconfPath)) {
		return;
	}

	try {
		const result = spawnSync(gpgconfPath, ['--list-dir', 'agent-socket'], {
			encoding: 'utf8',
			timeout: 2000
		});

		if (result.status === 0 && result.stdout) {
			detectedAgentSocket = result.stdout.trim();
			outputChannel.appendLine(`✅ Detected local GPG agent socket: ${detectedAgentSocket}`);
		}
	} catch (error) {
		// Silently fail
	}
}

// Get relay port (called by remote extension via command)
async function getRelayPort(): Promise<number> {
	if (!bridge?.isRunning()) {
		throw new Error('❌ Local bridge is not running');
	}
	return getConfiguredListenPort();
}

// Ensure bridge is running and return port (called by remote to start bridge if needed)
async function ensureBridgeRunning(): Promise<number> {
	if (!bridge?.isRunning()) {
		outputChannel.appendLine('🔄 Remote requested local bridge start...');
		await startBridge();
	}

	if (!bridge?.isRunning()) {
		throw new Error('Failed to start local bridge');
	}

	return getConfiguredListenPort();
}

// Start the local bridge
async function startBridge(): Promise<void> {
	if (bridge?.isRunning()) {
		vscode.window.showWarningMessage('Local bridge is already running');
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

		outputChannel.appendLine('🚀 Starting local bridge...');

		const config = vscode.workspace.getConfiguration('gpgWinRelay');
		const debugLogging = config.get<boolean>('debugLogging') || false;
		const listenPort = getConfiguredListenPort();

		bridge = new AssuanBridge({
			gpgAgentSocketPath: detectedAgentSocket,
			listenPort: listenPort,
			debugLogging: debugLogging
		});

		bridge.setLogCallback((message: string) => outputChannel.appendLine(message));
		outputChannel.appendLine(`🔌 Local GPG agent socket: ${detectedAgentSocket}`);
		outputChannel.appendLine(`📌 Local Assuan TCP port: ${bridge.getAssuanPort()}`);
		outputChannel.appendLine(`📡 Listen port for tunnel: ${listenPort}`);

		outputChannel.appendLine('⏳ Awaiting local bridge start...');
		await bridge.start();
		outputChannel.appendLine('✅ Local bridge started successfully');

		updateStatusBar(true);
		vscode.window.showInformationMessage(`Local bridge started on localhost:${listenPort}`);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		outputChannel.appendLine(`❌ Error starting local bridge: ${errorMessage}`);
		outputChannel.show(true);
		vscode.window.showErrorMessage(`Failed to start local bridge: ${errorMessage}`);
		bridge = null;
	}
}

// Stop the local bridge
async function stopBridge(): Promise<void> {
	if (!bridge?.isRunning()) {
		vscode.window.showInformationMessage('Local bridge is not running');
		return;
	}

	outputChannel.appendLine('🛑 Stopping local bridge...');

	await bridge.stop();
	bridge = null;

	updateStatusBar(false);
	outputChannel.appendLine('✅ Local bridge stopped');
	vscode.window.showInformationMessage('Local bridge stopped');
}

// Restart the local bridge
async function restartBridge(): Promise<void> {
	await stopBridge();
	await new Promise((resolve) => setTimeout(resolve, 500));
	await startBridge();
}

// Show bridge status
function showStatus(): void {
	const isRunning = bridge?.isRunning() || false;
	const gpg4winPath = detectedGpg4winPath || '(not detected)';
	const agentSocket = detectedAgentSocket || '(not detected)';
	const config = vscode.workspace.getConfiguration('gpgWinRelay');

	const status = [
		'GPG Windows Relay Status',
		'',
		`Local bridge: ${isRunning ? '✅ Running' : '🛑 Stopped'}`,
		`Auto-start: ${config.get('autoStart') ? 'Enabled' : 'Disabled'}`,
		'',
		`Gpg4win: ${gpg4winPath}`,
		`Local GPG agent socket: ${agentSocket}`,
		`Listen port for tunnel: ${getConfiguredListenPort()}`
	].join('\n');

	vscode.window.showInformationMessage(status, { modal: true });
	outputChannel.show();
}

// Update the status bar item
function updateStatusBar(running?: boolean): void {
	const isRunning = running ?? (bridge?.isRunning() || false);

	if (isRunning) {
		statusBarItem.text = '$(key) GPG Relay: Active';
		statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
		statusBarItem.tooltip = 'Local bridge is running';
	} else {
		statusBarItem.text = '$(key) GPG Relay: Inactive';
		statusBarItem.backgroundColor = undefined;
		statusBarItem.tooltip = 'Local bridge is not running';
	}

	statusBarItem.command = 'gpg-windows-relay.showStatus';
}

// This method is called when your extension is deactivated
export function deactivate(): void {
	if (bridge?.isRunning()) {
		bridge.stop().catch(() => {
			// Silently ignore cleanup errors
		});
	}
}
