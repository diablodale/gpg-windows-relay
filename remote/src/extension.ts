/**
 * Remote Extension Context
 *
 * This code runs on the remote (WSL/container/SSH).
 * It activates automatically when VS Code connects to any remote.
 */

import * as vscode from 'vscode';
import { startRemoteRelay } from './services/remoteRelay';

let relayInstance: Awaited<ReturnType<typeof startRemoteRelay>> | null = null;

export async function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('GPG Windows Relay');

    try {
        outputChannel.appendLine(`🔐 Remote context (${vscode.env.remoteName}) activated`);

        // Register commands
        const startCommand = vscode.commands.registerCommand('gpg-windows-relay.start', async () => {
            await startRemoteRelayHandler(outputChannel);
        });

        const stopCommand = vscode.commands.registerCommand('gpg-windows-relay.stop', async () => {
            await stopRemoteRelayHandler(outputChannel);
        });

        context.subscriptions.push(startCommand, stopCommand, outputChannel);

        // Auto-start relay on remote
        outputChannel.appendLine('🚀 Auto-starting relay...');
        try {
            await startRemoteRelayHandler(outputChannel);
        } catch (err) {
            // Error already logged by handler, but show output
            outputChannel.show();
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`❌ Error: ${message}`);
        outputChannel.show(true);
    }
}

async function startRemoteRelayHandler(outputChannel: vscode.OutputChannel) {
    if (relayInstance) {
        outputChannel.appendLine('⚠️  Relay already running');
        return;
    }

    try {
        outputChannel.appendLine('🚀 Starting relay...');
        outputChannel.appendLine('   📡 Relay: Unix socket listener (GPG client side)');
        outputChannel.appendLine('   🖥️  Bridge: Windows TCP server (gpg-agent side)');

        // Get the configured port from workspace settings (defaults to 63331)
        const config = vscode.workspace.getConfiguration('gpgWinRelay');
        const windowsBridgePort = config.get<number>('listenPort') || 63331;

        // Start the relay
        relayInstance = await startRemoteRelay({
            windowsHost: 'localhost',
            windowsPort: windowsBridgePort,
            logCallback: (msg) => outputChannel.appendLine(`      ${msg}`)
        });

        outputChannel.appendLine(`✅ Relay established (listening locally, forwarding to localhost:${windowsBridgePort})`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`❌ Failed to start relay: ${message}`);
        outputChannel.appendLine('⚠️  Make sure bridge is running: F1 > "GPG Windows Relay: Start"');
        outputChannel.show(true);
        throw error;
    }
}

async function stopRemoteRelayHandler(outputChannel: vscode.OutputChannel) {
    if (!relayInstance) {
        outputChannel.appendLine('⚠️  Relay is not running');
        return;
    }

    try {
        outputChannel.appendLine('🛑 Stopping relay...');
        await relayInstance.stop();
        relayInstance = null;
        outputChannel.appendLine('✅ Relay stopped');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`❌ Error stopping relay: ${message}`);
        outputChannel.show(true);
    }
}

export function deactivate() {
    if (relayInstance) {
        relayInstance.stop().catch((err) => {
            console.error('Error deactivating relay:', err);
        });
    }
}
