/**
 * Phase 3 Integration Test Runner
 *
 * Custom @vscode/test-electron runner for gpg-bridge-request Phase 3 integration tests.
 *
 * Phase 3 exercises the full proxy chain end-to-end with a real gpg binary on Linux:
 *   gpg (Linux) → Unix socket → gpg-bridge-request → VS Code command routing
 *   → gpg-bridge-agent (Windows) → gpg-agent (Windows)
 *
 * Responsibilities:
 *   1. Create an isolated gpg keyring (GNUPGHOME) unique to this test run.
 *   2. Generate a test key; export the public key to a path accessible from
 *      the container via the workspace bind mount.
 *   3. Launch a throwaway gpg-agent pointed at the isolated Windows keyring.
 *   4. Start VS Code via runTests() with --remote so each extension is routed to
 *      the correct host based on its extensionKind declaration:
 *        gpg-bridge-agent  (extensionKind: ui)        → Windows local extension host
 *        gpg-bridge-request (extensionKind: workspace) → remote (Linux dev container) host
 *   5. After tests complete, kill the agent, delete the key, and delete the keyring.
 *
 * Key differences from Phase 2 (requestProxyRunTest.ts):
 *   - Uses .devcontainer/phase3/devcontainer.json (includes gnupg2 install).
 *   - Exports the public key to a workspace-mounted path so the Phase 3 Mocha
 *     before() can import it into the container's GNUPGHOME via importPublicKey().
 *   - GNUPGHOME in extensionTestsEnv is the Windows path (for gpg-bridge-agent);
 *     the container's GNUPGHOME is a static Linux path set in devcontainer.json remoteEnv.
 *   - PUBKEY_ARMORED_KEY is the ASCII-armored public key string passed via env var.
 *   - extensionTestsPath points to suite/gpgCliIndex (not suite/requestProxyIndex).
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as cp from 'child_process';
import { runTests, downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';
import { GpgCli, assertSafeToDelete } from '@gpg-bridge/shared/test/integration';

// Create an isolated keyring directory unique to this run.
// Validate immediately after creation before touching process.env or GpgCli.
const GNUPGHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gpg-test-integration-'));
assertSafeToDelete(GNUPGHOME);
process.env.GNUPGHOME = GNUPGHOME;

const cli = new GpgCli();

/**
 * Walk up from `startDir` until we find a directory containing `AGENTS.md`
 * (which exists only at the monorepo root). This is more robust than counting
 * `../` levels, which silently breaks if tsconfig outDir depth ever changes.
 */
function findWorkspaceRoot(startDir: string): string {
    let dir = startDir;
    while (true) {
        if (fs.existsSync(path.join(dir, 'AGENTS.md'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            throw new Error(
                `Could not locate workspace root: AGENTS.md not found in any ` +
                `ancestor of ${startDir}`
            );
        }
        dir = parent;
    }
}
const workspaceRoot = findWorkspaceRoot(__dirname);

// Container URI — same format as Phase 2 but points to phase3/devcontainer.json.
// configFile must be a serialized VS Code URI object (not a string); see Phase 2
// requestProxyRunTest.ts header comment for full explanation of the URI format.
const REMOTE_CONTAINER_URI = Buffer.from(
    JSON.stringify({
        hostPath: workspaceRoot,
        configFile: {
            $mid: 1,
            scheme: 'file',
            authority: '',
            path: path.join(workspaceRoot, '.devcontainer', 'phase3', 'devcontainer.json').replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:'),
            query: '',
            fragment: ''
        }
    })
).toString('hex');
const containerWorkspaceFolder = `/workspaces/${path.basename(workspaceRoot)}`;

async function main(): Promise<void> {
    // disable-scdaemon is the only confirmed-valid conf option in GPG 2.4.x.
    cli.writeAgentConf(['disable-scdaemon']);

    // Generate the test key on Windows before either extension host starts.
    await cli.generateKey('Integration Test User', 'integration-test@example.com');
    const fingerprint = await cli.getFingerprint('integration-test@example.com');

    // Export the public key as an ASCII-armored string and pass it directly via env var.
    // Ed25519 armored public keys are ~350 chars — well within the 32,767-char Win32 limit.
    // The Mocha before() reads PUBKEY_ARMORED_KEY and calls importPublicKey() directly,
    // with no intermediate file or workspace bind mount path required.
    const pubkeyArmored = await cli.exportPublicKey(fingerprint);

    // Launch the gpg-agent BEFORE the extension hosts start so that gpg-bridge-agent's
    // activate() → detectAgentSocket() (calls gpgconf) already sees a live socket.
    await cli.launchAgent();

    // Download (or reuse cached) VS Code binary, then pre-install the Dev Containers
    // extension into the test profile. resolveCliArgsFromVSCodeExecutablePath returns
    // the VS Code CLI path plus --extensions-dir pointing at the test-scoped extensions
    // folder so the install does not touch the user's own VS Code installation.
    const vscodeExecutablePath = await downloadAndUnzipVSCode();
    const [cliPath, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
    cp.spawnSync(
        cliPath,
        [...cliArgs, '--install-extension', 'ms-vscode-remote.remote-containers'],
        { encoding: 'utf-8', stdio: 'inherit', shell: true }
    );

    try {
        await runTests({
            vscodeExecutablePath,
            extensionDevelopmentPath: [
                path.join(workspaceRoot, 'gpg-bridge-agent'), // gpg-bridge-agent root (ui, local)
                `vscode-remote://dev-container+${REMOTE_CONTAINER_URI}${containerWorkspaceFolder}/gpg-bridge-request`, // gpg-bridge-request (workspace, remote)
            ],

            // Mocha entry point: suite/gpgCliIndex, not suite/requestProxyIndex.
            // gpgCliIndex loads gpgCliIntegration.test.js specifically.
            extensionTestsPath: `vscode-remote://dev-container+${REMOTE_CONTAINER_URI}${containerWorkspaceFolder}/gpg-bridge-request/out/test/integration/suite/gpgCliIndex`,

            launchArgs: [
                '--folder-uri',
                `vscode-remote://dev-container+${REMOTE_CONTAINER_URI}${containerWorkspaceFolder}`,
            ],

            // GNUPGHOME → Windows gpg-bridge-agent uses the isolated Windows keyring (same as Phase 2).
            // The container's GNUPGHOME is the static Linux path set in devcontainer.json remoteEnv;
            // it is NOT forwarded here to keep gpg-bridge-agent pointed at the Windows keyring.
            // PUBKEY_ARMORED_KEY → ASCII-armored public key string passed directly; no file needed.
            //   devcontainer.json remoteEnv uses ${localEnv:...} to forward it to the container.
            // TEST_KEY_FINGERPRINT → forwarded to container via devcontainer.json remoteEnv.
            extensionTestsEnv: {
                VSCODE_INTEGRATION_TEST: '1',
                GNUPGHOME,
                TEST_KEY_FINGERPRINT: fingerprint,
                PUBKEY_ARMORED_KEY: pubkeyArmored
            }
        });
    } finally {
        // Kill agent whether tests passed or failed.
        await cli.killAgent();

        // Validate again before deleting as a secondary safety net.
        assertSafeToDelete(GNUPGHOME);
        fs.rmSync(GNUPGHOME, { recursive: true, force: true });
    }
}

main().catch(err => {
    console.error('Phase 3 integration test runner failed:', err);
    process.exit(1);
});
