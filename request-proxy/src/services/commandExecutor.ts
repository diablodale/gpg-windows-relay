/**
 * VS Code Command Executor for agent-proxy integration.
 * Wraps the cross-extension command protocol for dependency injection in tests.
 */

import * as vscode from 'vscode';
import type { ICommandExecutor } from '@gpg-relay/shared';

/**
 * Production implementation that executes VS Code commands to communicate with agent-proxy.
 * These commands are registered in agent-proxy/src/extension.ts.
 */
export class VSCodeCommandExecutor implements ICommandExecutor {
    /**
     * Connect to the GPG agent through agent-proxy extension.
     * Calls `_gpg-agent-proxy.connectAgent` command.
     *
     * @returns Session ID and agent greeting message
     * @throws Error if command fails or extension not available
     */
    async connectAgent(sessionId?: string): Promise<{ sessionId: string; greeting: string }> {
        // Do not pass undefined explicitly — VS Code serialises it as null across the
        // extension IPC boundary, which bypasses the default-parameter in connectAgent()
        // and causes all sessions to share a null key in the sessions Map.
        return vscode.commands.executeCommand(
            '_gpg-agent-proxy.connectAgent',
            ...(sessionId !== undefined ? [sessionId] : [])
        ) as Promise<{ sessionId: string; greeting: string }>;
    }

    /**
     * Send Assuan protocol commands to GPG agent through agent-proxy.
     * Calls `_gpg-agent-proxy.sendCommands` command.
     *
     * @param sessionId Session ID from connectAgent
     * @param commandBlock Raw Assuan protocol command(s)
     * @returns Agent response
     * @throws Error if command fails or session invalid
     */
    async sendCommands(sessionId: string, commandBlock: string): Promise<{ response: string }> {
        return vscode.commands.executeCommand(
            '_gpg-agent-proxy.sendCommands',
            sessionId,
            commandBlock
        ) as Promise<{ response: string }>;
    }

    /**
     * Disconnect from GPG agent and clean up session in agent-proxy.
     * Calls `_gpg-agent-proxy.disconnectAgent` command.
     *
     * @param sessionId Session ID to disconnect
     * @throws Error if command fails
     */
    async disconnectAgent(sessionId: string): Promise<void> {
        await vscode.commands.executeCommand(
            '_gpg-agent-proxy.disconnectAgent',
            sessionId
        );
    }
}
