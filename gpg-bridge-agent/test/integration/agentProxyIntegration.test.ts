/**
 * Phase 1 Integration Tests: agent-proxy ↔ Real gpg-agent
 *
 * Exercises the three inter-extension commands (_gpg-bridge-agent.connectAgent,
 * _gpg-bridge-agent.sendCommands, _gpg-bridge-agent.disconnectAgent) against the
 * real gpg-agent running in an isolated GNUPGHOME created by runTest.ts.
 *
 * Prerequisites (all managed by runTest.ts BEFORE the extension host starts):
 *   - GNUPGHOME is a fresh temp directory passed via extensionTestsEnv
 *   - gpg-agent is already running in GNUPGHOME
 *   - VSCODE_INTEGRATION_TEST=1 causes activate() to run full initialization
 *   - The extension detected Gpg4win and started AgentProxy against the test socket
 *
 * Test key lifecycle is handled by before()/after() in this file.
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { expect } from 'chai';
import { GpgCli } from '@gpg-bridge/shared/test/integration';

// ---------------------------------------------------------------------------
// Type aliases matching the command signatures in agent-proxy/src/extension.ts
// ---------------------------------------------------------------------------
interface ConnectResult { sessionId: string; greeting: string; }
interface SendResult    { response: string; }

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Phase 1 — agent-proxy ↔ Real gpg-agent', function () {
    // Integration tests involve real gpg-agent operations; set a generous timeout.
    this.timeout(60000);

    let cli: GpgCli;
    let fingerprint: string;
    let keygrip: string;

    before(async function () {
        // GNUPGHOME is already in process.env (injected via extensionTestsEnv in runTest.ts).
        cli = new GpgCli();

        // Generate a no-passphrase test key in the isolated keyring.
        // gpg-agent is already running (launched by runTest.ts before the host started).
        await cli.generateKey('Integration Test User', 'integration-test@example.com');
        fingerprint = await cli.getFingerprint('integration-test@example.com');
        keygrip = await cli.getKeygrip('integration-test@example.com');
    });

    after(async function () {
        // Clean up: remove the test key, then reset extension state.
        // Key deletion must happen while gpg-agent is still alive (runTest.ts kills it
        // after runTests() resolves, i.e. after this after() completes).
        if (fingerprint) {
            try { await cli.deleteKey(fingerprint); } catch { /* ignore if already deleted */ }
        }
        // Reset extension state so subsequent test runs start clean.
        try { await vscode.commands.executeCommand('gpg-bridge-agent.stop'); } catch { /* ignore */ }
    });

    // -----------------------------------------------------------------------
    // 1. Connect / greeting
    // -----------------------------------------------------------------------
    it('1. connectAgent returns a valid sessionId and OK greeting', async function () {
        const result = await vscode.commands.executeCommand<ConnectResult>(
            '_gpg-bridge-agent.connectAgent'
        );
        expect(result).to.be.an('object');
        expect(result.sessionId).to.be.a('string').and.have.length.greaterThan(0);
        expect(result.greeting).to.match(/^OK/);

        // Clean up
        await vscode.commands.executeCommand('_gpg-bridge-agent.disconnectAgent', result.sessionId);
    });

    // -----------------------------------------------------------------------
    // 2. GETINFO version
    // -----------------------------------------------------------------------
    it('2. GETINFO version returns version data ending with OK', async function () {
        const { sessionId } = await vscode.commands.executeCommand<ConnectResult>(
            '_gpg-bridge-agent.connectAgent'
        );
        try {
            const { response } = await vscode.commands.executeCommand<SendResult>(
                '_gpg-bridge-agent.sendCommands', sessionId, 'GETINFO version\n'
            );
            // Extra socket returns version as a D (data) record: 'D 2.4.8\nOK\n'
            // (not an S status record as on the main socket)
            expect(response).to.match(/^D \d+\.\d+/m);
            expect(response).to.match(/OK\s*$/m);
        } finally {
            await vscode.commands.executeCommand('_gpg-bridge-agent.disconnectAgent', sessionId);
        }
    });

    // -----------------------------------------------------------------------
    // 3. HAVEKEY — validates isolated agent can see the test key
    // -----------------------------------------------------------------------
    it('3. HAVEKEY confirms isolated agent has access to the test key', async function () {
        const { sessionId } = await vscode.commands.executeCommand<ConnectResult>(
            '_gpg-bridge-agent.connectAgent'
        );
        try {
            // HAVEKEY checks whether a secret key exists in the agent's key store
            // (private-keys-v1.d/ inside GNUPGHOME).  An OK response here confirms:
            //   1. The key was successfully generated into the isolated GNUPGHOME.
            //   2. The agent is running against THAT keyring, not the system keyring.
            // If isolation were broken this would return ERR ... No secret key.
            const { response } = await vscode.commands.executeCommand<SendResult>(
                '_gpg-bridge-agent.sendCommands', sessionId, `HAVEKEY ${keygrip}\n`
            );
            expect(response).to.match(/^OK\s*$/m);
        } finally {
            await vscode.commands.executeCommand('_gpg-bridge-agent.disconnectAgent', sessionId);
        }
    });

    // -----------------------------------------------------------------------
    // 4. Unknown command → ERR
    // -----------------------------------------------------------------------
    it('4. unknown command resolves with ERR response (does not reject)', async function () {
        const { sessionId } = await vscode.commands.executeCommand<ConnectResult>(
            '_gpg-bridge-agent.connectAgent'
        );
        try {
            const { response } = await vscode.commands.executeCommand<SendResult>(
                '_gpg-bridge-agent.sendCommands', sessionId, 'NOTACOMMAND\n'
            );
            expect(response).to.match(/^ERR/);
        } finally {
            await vscode.commands.executeCommand('_gpg-bridge-agent.disconnectAgent', sessionId);
        }
    });

    // -----------------------------------------------------------------------
    // 5. BYE / disconnectAgent
    // -----------------------------------------------------------------------
    it('5. disconnectAgent resolves; subsequent sendCommands rejects', async function () {
        const { sessionId } = await vscode.commands.executeCommand<ConnectResult>(
            '_gpg-bridge-agent.connectAgent'
        );

        // Disconnect should resolve cleanly
        await vscode.commands.executeCommand('_gpg-bridge-agent.disconnectAgent', sessionId);

        // Sending on a closed session should reject
        let threw = false;
        try {
            await vscode.commands.executeCommand<SendResult>(
                '_gpg-bridge-agent.sendCommands', sessionId, 'GETINFO version\n'
            );
        } catch {
            threw = true;
        }
        expect(threw, 'sendCommands on disconnected session should reject').to.be.true;
    });

    // -----------------------------------------------------------------------
    // 6. Multiple concurrent sessions
    // -----------------------------------------------------------------------
    it('6. three concurrent sessions are independent with OK greetings', async function () {
        // Open three sessions simultaneously
        const [r1, r2, r3] = await Promise.all([
            vscode.commands.executeCommand<ConnectResult>('_gpg-bridge-agent.connectAgent'),
            vscode.commands.executeCommand<ConnectResult>('_gpg-bridge-agent.connectAgent'),
            vscode.commands.executeCommand<ConnectResult>('_gpg-bridge-agent.connectAgent')
        ]);

        const results = [r1, r2, r3];

        try {
            // Each session has a unique id and an OK greeting
            const ids = results.map(r => r.sessionId);
            expect(new Set(ids).size, 'session IDs must be unique').to.equal(3);
            results.forEach(r => {
                expect(r.sessionId).to.be.a('string').and.have.length.greaterThan(0);
                expect(r.greeting).to.match(/^OK/);
            });
        } finally {
            await Promise.all(results.map(r =>
                vscode.commands.executeCommand('_gpg-bridge-agent.disconnectAgent', r.sessionId)
            ));
        }
    });

    // -----------------------------------------------------------------------
    // 7. PKSIGN flow (sign with no-passphrase key — no INQUIRE PINENTRY_LAUNCHED)
    // -----------------------------------------------------------------------
    it('7. PKSIGN flow: full sign sequence returns D <signature> + OK', async function () {
        const { sessionId } = await vscode.commands.executeCommand<ConnectResult>(
            '_gpg-bridge-agent.connectAgent'
        );
        try {
            // Option setup — allow-pinentry-notify is forbidden on the extra socket;
            // agent-awareness is sufficient for a no-passphrase key.
            await assertOk('_gpg-bridge-agent.sendCommands', sessionId, 'OPTION agent-awareness=2.1.0\n');
            await assertOk('_gpg-bridge-agent.sendCommands', sessionId, 'RESET\n');

            // Identify the signing key by keygrip (SIGKEY requires keygrip, not fingerprint)
            await assertOk('_gpg-bridge-agent.sendCommands', sessionId, `SIGKEY ${keygrip}\n`);

            // URL-encoded key description (+ = space in Assuan percent-encoding)
            await assertOk('_gpg-bridge-agent.sendCommands', sessionId, 'SETKEYDESC Integration+Test+Signing\n');

            // libgcrypt algorithm ID 10 = SHA-512
            const sha512hex = crypto
                .createHash('sha512')
                .update(Buffer.from('test data'))
                .digest('hex')
                .toUpperCase();
            await assertOk('_gpg-bridge-agent.sendCommands', sessionId, `SETHASH 10 ${sha512hex}\n`);

            // Execute the sign operation.
            // With a no-passphrase key, INQUIRE PINENTRY_LAUNCHED is NOT generated;
            // the agent returns the signature directly.
            const { response } = await vscode.commands.executeCommand<SendResult>(
                '_gpg-bridge-agent.sendCommands', sessionId, 'PKSIGN\n'
            );
            // Response must contain at least one data block (signature bytes)
            expect(response).to.include('D ');
            expect(response).to.match(/OK\s*$/m);
        } finally {
            await vscode.commands.executeCommand('_gpg-bridge-agent.disconnectAgent', sessionId);
        }
    });

    // -----------------------------------------------------------------------
    // 8. Session isolation after error
    // -----------------------------------------------------------------------
    it('8. invalid session ID rejects; valid session continues working', async function () {
        const { sessionId } = await vscode.commands.executeCommand<ConnectResult>(
            '_gpg-bridge-agent.connectAgent'
        );
        try {
            // Using a bogus session ID should reject
            let threw = false;
            try {
                await vscode.commands.executeCommand<SendResult>(
                    '_gpg-bridge-agent.sendCommands', 'bogus-session-id-that-does-not-exist', 'GETINFO version\n'
                );
            } catch {
                threw = true;
            }
            expect(threw, 'sendCommands with invalid session ID should reject').to.be.true;

            // The valid session opened earlier is unaffected by the error above
            const { response } = await vscode.commands.executeCommand<SendResult>(
                '_gpg-bridge-agent.sendCommands', sessionId, 'GETINFO version\n'
            );
            expect(response).to.match(/OK\s*$/m);
        } finally {
            await vscode.commands.executeCommand('_gpg-bridge-agent.disconnectAgent', sessionId);
        }
    });

    // -----------------------------------------------------------------------
    // 9. Bad Gpg4win path rejects start; restoring config recovers proxy
    // -----------------------------------------------------------------------
    it('9. bad gpg4winPath rejects start; stop/start with valid config recovers proxy', async function () {
        // --- Part A: bad config ---
        // Stop the proxy first so detectedGpg4winPath/detectedAgentSocket are cleared
        // and the next start must re-detect from scratch using the config value.
        await vscode.commands.executeCommand('gpg-bridge-agent.stop');

        const config = vscode.workspace.getConfiguration('gpgBridgeAgent');
        await config.update('gpg4winPath', 'C:\\nonexistent-gpg4win-path', vscode.ConfigurationTarget.Global);

        try {
            // start should reject because gpgconf.exe is not found at the configured path
            // and none of the default auto-detect locations have it either
            // (they do in practice, but the configured path takes precedence and causes a failure
            //  because detectGpg4winPath() never sets detectedAgentSocket)
            let startThrew = false;
            let startError = '';
            try {
                await vscode.commands.executeCommand('gpg-bridge-agent.start');
            } catch (err) {
                startThrew = true;
                startError = err instanceof Error ? err.message : String(err);
            }
            expect(startThrew, 'start should reject when Gpg4win is not found').to.be.true;
            expect(startError, 'error should mention Gpg4win or path').to.match(/gpg4win|not found|gpgconf/i);

            // connectAgent must also reject — agentProxyService was never initialized
            let connectThrew = false;
            try {
                await vscode.commands.executeCommand<ConnectResult>('_gpg-bridge-agent.connectAgent');
            } catch {
                connectThrew = true;
            }
            expect(connectThrew, 'connectAgent should reject when service failed to start').to.be.true;
        } finally {
            // Always restore the config, even if an assertion above fails
            await config.update('gpg4winPath', undefined, vscode.ConfigurationTarget.Global);
        }

        // --- Part B: recovery ---
        // With the config restored to default, auto-detection should find Gpg4win again.
        await vscode.commands.executeCommand('gpg-bridge-agent.start');

        // Give the start a moment to complete async initialization
        await new Promise(resolve => setTimeout(resolve, 500));

        // Proxy should be fully operational
        const { sessionId, greeting } = await vscode.commands.executeCommand<ConnectResult>(
            '_gpg-bridge-agent.connectAgent'
        );
        expect(greeting).to.match(/^OK/);
        await vscode.commands.executeCommand('_gpg-bridge-agent.disconnectAgent', sessionId);
    });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Send a command and assert the response ends with OK.
 * Throws a descriptive error if the agent returns ERR or an unexpected response.
 */
async function assertOk(command: string, sessionId: string, cmd: string): Promise<string> {
    const { response } = await vscode.commands.executeCommand<SendResult>(command, sessionId, cmd);
    expect(response, `${cmd.trim()} response`).to.match(/OK\s*$/m);
    return response;
}
