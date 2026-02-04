/**
 * Remote Extension Context
 *
 * This code runs on the remote (WSL/container/SSH).
 * It activates automatically when VS Code connects to any remote.
 *
 * Creates a Unix socket server on the GPG agent socket path and implements
 * a state machine to forward protocol operations to the agent-proxy extension
 * via VS Code commands.
 */

import * as vscode from 'vscode';
import { startRequestProxy } from './services/requestProxy';

let requestProxyInstance: Awaited<ReturnType<typeof startRequestProxy>> | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const outputChannel = vscode.window.createOutputChannel('GPG Request Proxy');

    try {
        outputChannel.appendLine(`Remote context (${vscode.env.remoteName}) activated`);

        // Register commands
        context.subscriptions.push(
            vscode.commands.registerCommand('gpg-request-proxy.start', async () => {
                await startRequestProxyHandler(outputChannel);
            }),
            vscode.commands.registerCommand('gpg-request-proxy.stop', async () => {
                await stopRequestProxyHandler(outputChannel);
            }),
            outputChannel
        );

        // Start request proxy on remote
        outputChannel.appendLine('Starting request proxy...');
        try {
            await startRequestProxyHandler(outputChannel);
        } catch (err) {
            // Error already logged by handler, but show output
            outputChannel.show();
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`Error: ${message}`);
        outputChannel.show(true);
    }
}

async function startRequestProxyHandler(outputChannel: vscode.OutputChannel): Promise<void> {
    if (requestProxyInstance) {
        outputChannel.appendLine('Request proxy already running');
        return;
    }

    try {
        outputChannel.appendLine('Starting request proxy...');
        outputChannel.appendLine('Creating Unix socket server and state machine');

        // Start the request proxy (implements state machine via VS Code commands)
        requestProxyInstance = await startRequestProxy({
            logCallback: (msg) => outputChannel.appendLine(`  ${msg}`)
        });

        outputChannel.appendLine('Request proxy started successfully');
        outputChannel.appendLine('Ready to handle GPG Assuan protocol operations');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`Failed to start request proxy: ${message}`);
        outputChannel.appendLine('Ensure gpg-agent is running and agent-proxy extension is started');
        outputChannel.show(true);
        throw error;
    }
}

async function stopRequestProxyHandler(outputChannel: vscode.OutputChannel): Promise<void> {
    if (!requestProxyInstance) {
        outputChannel.appendLine('Request proxy is not running');
        return;
    }

    try {
        outputChannel.appendLine('Stopping request proxy...');
        await requestProxyInstance.stop();
        requestProxyInstance = null;
        outputChannel.appendLine('Request proxy stopped');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`Error stopping request proxy: ${message}`);
        outputChannel.show(true);
    }
}

export function deactivate() {
    if (requestProxyInstance) {
        requestProxyInstance.stop().catch((err) => {
            console.error('Error deactivating request proxy:', err);
        });
    }
}


