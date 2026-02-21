/**
 * Phase 2 Integration Test Runner
 *
 * Custom @vscode/test-electron runner for gpg-bridge-request Phase 2 integration tests.
 *
 * Phase 2 exercises the full proxy chain on a Windows host:
 *   AssuanSocketClient → Unix socket (Linux) → gpg-bridge-request → VS Code command routing
 *   → gpg-bridge-agent (Windows) → gpg-agent (Windows)
 *
 * Responsibilities:
 *   1. Create an isolated gpg keyring (GNUPGHOME) unique to this test run.
 *   2. Generate a test key; stash fingerprint + keygrip into extensionTestsEnv.
 *      devcontainer.json remoteEnv uses ${localEnv:...} to forward them into the container
 *      extension host (evaluated at VS Code attach time from the VS Code process env).
 *   3. Launch a throwaway gpg-agent pointed at the isolated keyring.
 *   4. Start VS Code via runTests() with --remote so each extension is routed to
 *      the correct host based on its extensionKind declaration:
 *        gpg-bridge-agent  (extensionKind: ui)        → Windows local extension host
 *        gpg-bridge-request (extensionKind: workspace) → remote (Linux dev container) host
 *   5. After tests complete, kill the agent, delete the key, and delete the keyring.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RESOLVED (originally tracked as UNKNOWNS):
 *
 * 1. extensionTestsEnv propagation — RESOLVED via @vscode/test-electron source inspection:
 *    `extensionTestsEnv` is merged into the Windows VS Code process env only
 *    (`Object.assign({}, process.env, testRunnerEnv)` → `cp.spawn(exe, args, {env: fullEnv})`).
 *    The remote container extension host is a separate Linux process that inherits its env
 *    from the container, NOT from the Windows process.
 *    Consequence:
 *      - GNUPGHOME                    → reaches gpg-bridge-agent (Windows local host) ✓
 *      - VSCODE_INTEGRATION_TEST      → set via devcontainer.json remoteEnv (static "1") ✓
 *      - TEST_KEY_FINGERPRINT/KEYGRIP → in VS Code process env via extensionTestsEnv;
 *        devcontainer.json remoteEnv ${localEnv:...} picks them up at attach time ✓
 *
 * 2. extensionDevelopmentPath routing — RESOLVED analytically:
 *    Standard VS Code extensionKind routing. Each path is routed to the correct host
 *    based on the extension's extensionKind declaration (ui → local, workspace → remote).
 *
 * 3. extensionTestsPath location — RESOLVED analytically:
 *    When --remote is active, extensionTestsPath runs in the remote host. VS Code maps
 *    the Windows path to the container via the workspace volume mount.
 *
 * 4. Container URI format — RESOLVED:
 *    Format: `dev-container+<hex-encoded-JSON>` where JSON uses `hostPath` (not `localFolder`).
 *    The Dev Containers extension's ln() type guard checks `e.hostPath !== undefined`;
 *    any other key (localFolder, etc.) falls through to "Unexpected authority" error.
 *    Computation: Buffer.from(JSON.stringify({hostPath: workspaceRoot})).toString('hex').
 *    Prerequisites:
 *      - Docker Desktop running on Windows ✓
 *      - Dev Containers extension: pre-installed in runTest.ts before runTests() ✓
 *      - Container is built/started by VS Code on first attach (auto)
 *
 *    Optional `configFile` key — RESOLVED:
 *    Selects a specific devcontainer.json instead of the default
 *    `.devcontainer/devcontainer.json`. The value must be a serialized VS Code
 *    URI object {$mid, scheme, authority, path, query, fragment} — NOT a string.
 *    The extension passes it through URI.revive() which calls `new URI(data)`,
 *    and then accesses `.scheme` on the result. A plain string (even `file:///C:/...`)
 *    causes `[UriError]: Scheme contains illegal characters` because VS Code's
 *    strict URI constructor chokes on non-object inputs.
 *    Windows path encoding: path property must use forward slashes with the drive
 *    letter prefixed by '/' → `/C:/path/to/devcontainer.json`.
 * ─────────────────────────────────────────────────────────────────────────────
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

// Container URI format: dev-container+<hex-encoded-JSON> (Unknown 4 — resolved).
// JSON payload: {"hostPath": "<path>"}
// The Dev Containers extension authority is parsed by io() / xk():
//   - xk() routes to Wie() when ln(parsedAuthority) is true.
//   - ln(e) checks e.hostPath !== undefined (NOT localFolder — that key is rejected).
//   - Wie() uses originalCwd (from the VS Code workspace) as primary folder for
//     container config lookup; hostPath is a secondary fallback for compose paths.
// VS Code finds the config at .devcontainer/devcontainer.json (standard convention path).
// Named sub-dirs (.devcontainer/phase2/, phase3/) are for the manual VS Code container picker.
// PREREQUISITE: Docker running + Dev Containers extension in the @vscode/test-electron binary.
//
// Workspace folder inside the container:
// devcontainer.json has no explicit workspaceMount, so the Dev Containers CLI default
// applies: source=<hostPath>, target=/workspaces/<basename(hostPath)>.
// The folder-uri must use the in-container path; VS Code cannot stat a Windows path
// from inside the Linux container, so we cannot pass workspaceRoot as a positional arg.
const REMOTE_CONTAINER_URI = Buffer.from(
    JSON.stringify({
        hostPath: workspaceRoot,
        // Explicitly select the phase2 devcontainer.json so automated tests are
        // not affected if the root .devcontainer/devcontainer.json changes.
        // configFile must be a serialized VS Code URI object (not a string) — the
        // Dev Containers extension passes it through URI.revive(), which expects
        // {$mid:1, scheme, authority, path, query, fragment}.  A plain string or
        // bare Windows path causes UriError in VS Code's strict URI parser.
        configFile: {
            $mid: 1,
            scheme: 'file',
            authority: '',
            path: path.join(workspaceRoot, '.devcontainer', 'phase2', 'devcontainer.json').replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:'),
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
    const keygrip = await cli.getKeygrip('integration-test@example.com');

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
            // Both extensions as development extensions.
            // VS Code routes each to the correct host by extensionKind:
            //   gpg-bridge-agent  (extensionKind: ui)        → Windows local extension host
            //   gpg-bridge-request (extensionKind: workspace) → remote (Linux) extension host
            //
            // VS Code cannot translate Windows extensionDevelopmentPath to container paths
            // automatically — workspace-kind extensions with Windows paths are silently
            // dropped (not loaded anywhere). Fix: pass the remote vscode-remote:// URI
            // for gpg-bridge-request directly so VS Code routes it to the remote ext host.
            //
            // gpg-bridge-agent: local Windows path is correct (extensionKind: ui, stays local).
            // gpg-bridge-request: remote URI — VS Code loads it in the remote ext host.
            extensionDevelopmentPath: [
                path.join(workspaceRoot, 'gpg-bridge-agent'), // gpg-bridge-agent root (ui, local)
                `vscode-remote://dev-container+${REMOTE_CONTAINER_URI}${containerWorkspaceFolder}/gpg-bridge-request`, // gpg-bridge-request (workspace, remote)
            ],

            // Mocha entry point runs in the remote (Linux) extension host.
            // Local Windows path would run tests in the local host where the Unix socket
            // doesn't exist. Remote URI ensures tests run alongside gpg-bridge-request in
            // the container where the Assuan Unix socket is created.
            extensionTestsPath: `vscode-remote://dev-container+${REMOTE_CONTAINER_URI}${containerWorkspaceFolder}/gpg-bridge-request/out/test/integration/suite/requestProxyIndex`,

            launchArgs: [
                // Open the workspace using its in-container path. Passing workspaceRoot
                // (Windows path) as a positional arg would cause VS Code to stat it from
                // inside the Linux container (ENOENT). --folder-uri with the full
                // vscode-remote:// URI ensures VS Code resolves it from the container.
                '--folder-uri',
                `vscode-remote://dev-container+${REMOTE_CONTAINER_URI}${containerWorkspaceFolder}`,
            ],

            // Inject GNUPGHOME and test key metadata into the VS Code process env.
            // VSCODE_INTEGRATION_TEST=1 → isIntegrationTestEnvironment() = true in gpg-bridge-agent.
            //   (gpg-bridge-request in the container picks this up via devcontainer.json remoteEnv.)
            // GNUPGHOME → agent-proxy uses the isolated Windows keyring.
            // TEST_KEY_FINGERPRINT / TEST_KEY_KEYGRIP → VS Code process env via extensionTestsEnv;
            //   devcontainer.json remoteEnv uses ${localEnv:...} to forward them into the
            //   container's remote extension host (where the Mocha suite reads process.env).
            extensionTestsEnv: {
                VSCODE_INTEGRATION_TEST: '1',
                GNUPGHOME,
                TEST_KEY_FINGERPRINT: fingerprint,
                TEST_KEY_KEYGRIP: keygrip
            }
        });
    } finally {
        // Kill agent whether tests passed or failed.
        // killAgent() already tolerates a dead agent; only throws if gpgconf fails to spawn.
        await cli.killAgent();

        // Validate again before deleting as a secondary safety net — the primary
        // check runs immediately after mkdtempSync above, but this catches any
        // unlikely mutation of GNUPGHOME between creation and cleanup.
        assertSafeToDelete(GNUPGHOME);
        fs.rmSync(GNUPGHOME, { recursive: true, force: true });
    }
}

main().catch(err => {
    console.error('Integration test runner failed:', err);
    process.exit(1);
});
