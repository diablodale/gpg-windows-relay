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
import { extractErrorMessage } from '@gpg-relay/shared';
import { VSCodeCommandExecutor } from './services/commandExecutor';
import { isTestEnvironment } from '@gpg-relay/shared';

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
        if (!isTestEnvironment()) {
            try {
                await startRequestProxyHandler(outputChannel);
            } catch (err) {
                // Error already logged by handler, but show output
                outputChannel.show();
            }
        }
    } catch (error) {
        const message = extractErrorMessage(error);
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

        // Create a log callback that respects the debugLogging setting
		const config = vscode.workspace.getConfiguration('gpgRequestProxy');
		const debugLogging = config.get<boolean>('debugLogging') || true;	// TODO remove forced debug logging
		const logCallback = debugLogging ? (message: string) => outputChannel.appendLine(message) : undefined;

        // Start the request proxy with explicit commandExecutor (or let it use default)
        requestProxyInstance = await startRequestProxy({
            logCallback: logCallback
        }, {
            commandExecutor: new VSCodeCommandExecutor()
        });

        outputChannel.appendLine('Request proxy is READY');
    } catch (error) {
        const message = extractErrorMessage(error);
        outputChannel.appendLine(`Failed to start request proxy: ${message}`);
        outputChannel.show(true);
        vscode.window.showErrorMessage(`Failed to start request proxy: ${message}`);
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
        const message = extractErrorMessage(error);
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


