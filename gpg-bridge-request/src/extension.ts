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

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { RequestProxy } from './services/requestProxy';
import { extractErrorMessage } from '@gpg-bridge/shared';
import { VSCodeCommandExecutor } from './services/commandExecutor';
import { isTestEnvironment, isIntegrationTestEnvironment } from '@gpg-bridge/shared';

let requestProxyService: RequestProxy | null = null;
let outputChannel: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    outputChannel = vscode.window.createOutputChannel('GPG Bridge Request');

    try {
        outputChannel.appendLine(`Remote context (${vscode.env.remoteName}) activated`);

        // Register commands
        context.subscriptions.push(
            vscode.commands.registerCommand('gpg-bridge-request.start', async () => {
                await startRequestProxy();
            }),
            vscode.commands.registerCommand('gpg-bridge-request.stop', async () => {
                await stopRequestProxy();
            }),
            outputChannel
        );

        // Integration test helper command — only registered when integration tests are running
        // without a configured GNUPGHOME (Phase 2). Phase 2 tests connect to the proxy socket
        // directly via AssuanSocketClient and need the socket path via this command.
        // Phase 3 sets GNUPGHOME so gpg finds the socket at $GNUPGHOME/S.gpg-agent naturally;
        // this command is not needed and must not be registered.
        if (isIntegrationTestEnvironment() && !process.env.GNUPGHOME) {
            context.subscriptions.push(
                vscode.commands.registerCommand('_gpg-bridge-request.test.getSocketPath', () => {
                    return requestProxyService?.getSocketPath() ?? null;
                })
            );
        }

        // Start request proxy on remote
        // isIntegrationTestEnvironment() overrides isTestEnvironment() so integration
        // tests get full extension initialization (unit tests still skip init).
        if (!isTestEnvironment() || isIntegrationTestEnvironment()) {
            try {
                await startRequestProxy();
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

async function startRequestProxy(): Promise<void> {
    if (requestProxyService) {
        outputChannel.appendLine('Request proxy already running');
        return;
    }

    try {
        outputChannel.appendLine('Starting request proxy...');

        // Create a log callback that respects the debugLogging setting
        const config = vscode.workspace.getConfiguration('gpgBridgeRequest');
        const debugLogging = config.get<boolean>('debugLogging') || true;   // TODO remove forced debug logging
        const logCallback = debugLogging ? (message: string) => outputChannel.appendLine(message) : undefined;

        // In integration test mode without a configured GNUPGHOME, bypass gpgconf and
        // use a known temp socket path. Phase 2 does not set GNUPGHOME in remoteEnv
        // and must not invoke any gpg executables — tests connect to the socket via
        // the _gpg-request-proxy.test.getSocketPath test helper command.
        // Phase 3 sets GNUPGHOME=/tmp/gpg-test-phase3 via remoteEnv, so getSocketPath
        // is left undefined and getLocalGpgSocketPath() runs normally (calls gpgconf),
        // placing the socket at $GNUPGHOME/S.gpg-agent where gpg expects its agent.
        const getSocketPath = (isIntegrationTestEnvironment() && !process.env.GNUPGHOME)
            ? async () => path.join(os.tmpdir(), `gpg-relay-test-${process.pid}.sock`)
            : undefined;
        requestProxyService = new RequestProxy({
            logCallback: logCallback
        }, {
            commandExecutor: new VSCodeCommandExecutor(),
            ...(getSocketPath ? { getSocketPath } : {})
        });
        await requestProxyService.start();

        outputChannel.appendLine('Request proxy is READY');
    } catch (error) {
        const message = extractErrorMessage(error);
        outputChannel.appendLine(`Failed to start request proxy: ${message}`);
        outputChannel.show(true);
        vscode.window.showErrorMessage(`Failed to start request proxy: ${message}`);
        throw error;
    }
}

async function stopRequestProxy(): Promise<void> {
    if (!requestProxyService) {
        outputChannel.appendLine('Request proxy is not running');
        return;
    }

    try {
        outputChannel.appendLine('Stopping request proxy...');
        await requestProxyService.stop();
        requestProxyService = null;
        outputChannel.appendLine('Request proxy stopped');
    } catch (error) {
        const message = extractErrorMessage(error);
        outputChannel.appendLine(`Error stopping request proxy: ${message}`);
        outputChannel.show(true);
    }
}

export function deactivate(): Promise<void> | undefined {
    return requestProxyService?.stop();
}


