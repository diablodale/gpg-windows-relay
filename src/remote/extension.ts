/**
 * Remote Extension Context
 *
 * This code runs on the remote (WSL/container/SSH), not on Windows.
 * It activates automatically when VS Code connects to any remote.
 *
 * The role of this context:
 * 1. Query the local GPG socket path
 * 2. Start a relay that listens on the GPG socket
 * 3. Forward to the Windows bridge (localhost:PORT via VS Code's tunnel)
 */

import * as vscode from 'vscode';
import { startRemoteRelay } from './remoteRelay';

let relayInstance: Awaited<ReturnType<typeof startRemoteRelay>> | null = null;

export async function activateRemote(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('GPG Windows Relay Remote');

    try {
        outputChannel.appendLine(`🔐 Remote context (${vscode.env.remoteName}) activated`);

        // Override the global commands in remote context to use remote handlers
        const startCommand = vscode.commands.registerCommand('gpg-windows-relay.start', async () => {
            await startRemoteRelayHandler(outputChannel);
        });

        const stopCommand = vscode.commands.registerCommand('gpg-windows-relay.stop', async () => {
            await stopRemoteRelayHandler(outputChannel);
        });

        context.subscriptions.push(startCommand, stopCommand, outputChannel);

        // Auto-start relay on remote (always, no config option)
        outputChannel.appendLine('🚀 Auto-starting remote relay...');
        try {
            await startRemoteRelayHandler(outputChannel);
        } catch (err) {
            // Error already logged by handler, but show output
            outputChannel.show();
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`❌ Error in remote relay: ${message}`);
        outputChannel.show(true);
    }
}

// Export as main activate for this context
export async function activate(context: vscode.ExtensionContext) {
    return activateRemote(context);
}

async function startRemoteRelayHandler(outputChannel: vscode.OutputChannel) {
    if (relayInstance) {
        outputChannel.appendLine('⚠️ Remote relay already running');
        return;
    }

    try {
        outputChannel.appendLine('🚀 Starting remote relay...');

        // Get the configured port from workspace settings (defaults to 63331)
        const config = vscode.workspace.getConfiguration('gpgWinRelay');
        const windowsBridgePort = config.get<number>('listenPort') || 63331;

        // Start the relay
        relayInstance = await startRemoteRelay({
            windowsHost: 'localhost',
            windowsPort: windowsBridgePort,
            logCallback: (msg) => outputChannel.appendLine(`      ${msg}`)
        });

        outputChannel.appendLine(`✅ Remote relay established: Remote GPG -> remote socket -> tunnel -> local bridge (${windowsBridgePort})`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`❌ Failed to start remote relay: ${message}`);
        outputChannel.appendLine('⚠️ Make sure local bridge is running: F1 > "GPG Windows Relay: Start"');
        outputChannel.show(true);
        throw error;
    }
}

async function stopRemoteRelayHandler(outputChannel: vscode.OutputChannel) {
    if (!relayInstance) {
        outputChannel.appendLine('⚠️ Remote relay is not running');
        return;
    }

    try {
        outputChannel.appendLine('🛑 Stopping remote relay...');
        await relayInstance.stop();
        relayInstance = null;
        outputChannel.appendLine('✅ Remote relay stopped');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`❌ Error stopping remote relay: ${message}`);
        outputChannel.show(true);
    }
}

export function deactivate() {
    if (relayInstance) {
        relayInstance.stop().catch((err) => {
            console.error('Error deactivating remote relay:', err);
        });
    }
}
