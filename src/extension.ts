// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { GpgRelay } from './gpgRelay';

// Relay state management
let relay: GpgRelay | null = null;
let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	outputChannel = vscode.window.createOutputChannel('GPG Agent Relay');
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

	outputChannel.appendLine('🔐 GPG Agent Relay extension activated');

	// Check if running on Windows
	if (process.platform !== 'win32') {
		vscode.window.showErrorMessage('GPG Agent Relay only works on Windows hosts');
		return;
	}

	// Register commands
	context.subscriptions.push(
		vscode.commands.registerCommand('gpg-agent-relay.start', startRelay),
		vscode.commands.registerCommand('gpg-agent-relay.stop', stopRelay),
		vscode.commands.registerCommand('gpg-agent-relay.restart', restartRelay),
		vscode.commands.registerCommand('gpg-agent-relay.showStatus', showStatus),
		outputChannel,
		statusBarItem
	);

	// Update status bar
	updateStatusBar();
	statusBarItem.show();

	// Check for remote connection and auto-start if configured
	const config = vscode.workspace.getConfiguration('gpgRelay');
	if (config.get('autoStart') && isRemoteSession()) {
		outputChannel.appendLine('🔌 Remote session detected, auto-starting relay...');
		startRelay();
	}
}

// Check if we're in a remote session
function isRemoteSession(): boolean {
	return !!vscode.env.remoteName; // remoteName is set when connected to WSL, SSH, containers, etc.
}

// Start the GPG relay
async function startRelay() {
	if (relay?.isRunning()) {
		vscode.window.showWarningMessage('GPG relay is already running');
		return;
	}

	try {
		const config = vscode.workspace.getConfiguration('gpgRelay');
		const gpg4winPath = config.get<string>('gpg4winPath') || 'C:\\Program Files (x86)\\GnuPG\\bin';
		const debugLogging = config.get<boolean>('debugLogging') || false;

		outputChannel.appendLine('🚀 Starting GPG agent relay...');

		if (debugLogging) {
			outputChannel.appendLine(`GPG4Win path: ${gpg4winPath}`);
			outputChannel.appendLine(`Remote name: ${vscode.env.remoteName || 'none'}`);
		}

		// Create relay instance
		relay = new GpgRelay({
			gpg4winPath,
			debugLogging,
			remoteName: vscode.env.remoteName
		});

		relay.setLogCallback((message) => outputChannel.appendLine(message));

		await relay.start();

		updateStatusBar(true);
		vscode.window.showInformationMessage('GPG relay started');
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		outputChannel.appendLine(`❌ Error starting relay: ${errorMessage}`);
		vscode.window.showErrorMessage(`Failed to start GPG relay: ${errorMessage}`);
		relay = null;
	}
}

// Stop the GPG relay
async function stopRelay() {
	if (!relay?.isRunning()) {
		vscode.window.showInformationMessage('GPG relay is not running');
		return;
	}

	outputChannel.appendLine('🛑 Stopping GPG agent relay...');

	relay.stop();
	relay = null;

	updateStatusBar(false);
	vscode.window.showInformationMessage('GPG relay stopped');
}

// Restart the GPG relay
async function restartRelay() {
	await stopRelay();
	setTimeout(() => startRelay(), 500);
}

// Show relay status
function showStatus() {
	const isRunning = relay?.isRunning() || false;
	const remoteName = vscode.env.remoteName || 'none';
	const config = vscode.workspace.getConfiguration('gpgRelay');

	const status = [
		`GPG Agent Relay Status`,
		``,
		`Relay Status: ${isRunning ? '✅ Running' : '⭕ Stopped'}`,
		`Remote Session: ${remoteName}`,
		`Auto-start: ${config.get('autoStart') ? 'Enabled' : 'Disabled'}`,
		`Debug Logging: ${config.get('debugLogging') ? 'Enabled' : 'Disabled'}`,
		`GPG4Win Path: ${config.get('gpg4winPath')}`
	].join('\n');

	vscode.window.showInformationMessage(status, { modal: true });
	outputChannel.show();
}

// Update the status bar item
function updateStatusBar(running?: boolean) {
	const isRunning = running ?? (relay?.isRunning() || false);

	if (isRunning) {
		statusBarItem.text = '$(key) GPG Relay: Active';
		statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
		statusBarItem.tooltip = 'GPG Agent Relay is running';
	} else {
		statusBarItem.text = '$(key) GPG Relay: Inactive';
		statusBarItem.backgroundColor = undefined;
		statusBarItem.tooltip = 'GPG Agent Relay is not running';
	}

	statusBarItem.command = 'gpg-agent-relay.showStatus';
}

// This method is called when your extension is deactivated
export function deactivate() {
	if (relay?.isRunning()) {
		relay.stop();
	}
}
