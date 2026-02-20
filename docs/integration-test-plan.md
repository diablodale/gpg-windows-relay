# Integration Test Plan

Real-world integration testing for `agent-proxy` and `request-proxy` extensions, exercising the full
`gpg.exe → request-proxy → agent-proxy → gpg-agent` chain across three phases.

## Test Infrastructure Overview

### File Layout

Integration tests live as siblings of each extension's `src/` directory:

```
agent-proxy/
  test/
    integration/
      runTest.ts                       ← custom runner: isolated agent lifecycle + runTests()
      agentProxyIntegration.test.ts
  tsconfig.test.json                   ← widens rootDir to '.', adds test/integration/**
request-proxy/
  test/
    integration/
      runTest.ts                       ← custom runner for Phase 2 (inherits running agent)
      requestProxyIntegration.test.ts
      gpgCliIntegration.test.ts        ← Phase 3 only (runs in dev container)
  tsconfig.test.json
shared/
  test/
    integration/
      index.ts                         ← barrel: re-exports GpgCli + AssuanSocketClient
      gpgCli.ts                        ← all gpg.exe / gpgconf.exe subprocess calls
      assuanSocketClient.ts            ← Assuan socket test client (used by phases 2 and 3)
  tsconfig.test.json
```

### Test Runner

Each extension uses a **custom runner** (`test/integration/runTest.ts`) instead of
`.vscode-test-cli` config files. The runner uses `@vscode/test-electron`'s `runTests()` API
directly, which provides:

- **`extensionTestsEnv`** — environment variables injected directly into the extension host
  process (where `gpgconf.exe` is called), not just the test runner process
- **Pre/post hooks** — gpg-agent lifecycle management runs *outside* the extension host, before
  `runTests()` is called and after it resolves/rejects, avoiding Mocha `before()`/`after()` timing
  issues
- **Dynamic values** — the runner script is full Node.js, so paths can be computed (e.g.
  `path.join(os.tmpdir(), 'gpg-test-integration')`) rather than hard-coded in a static config file

The `GNUPGHOME` path is computed once in `runTest.ts` using `fs.mkdtempSync` (e.g.
`/tmp/gpg-test-a3f9b2/`) and assigned to `process.env.GNUPGHOME` before `runTests()` is called.
The same value is also passed to `extensionTestsEnv`, so the runner process, the extension host,
and all `gpg`/`gpgconf` subprocesses all share a consistent unique path for that test run.

Each extension gets a separate `test:integration` npm script so integration tests do **not** run
incidentally with `npm test`. The existing unit-test `src/test/suite/index.ts` runner is not
reused for integration.

```
agent-proxy/
  test/
    integration/
      runTest.ts                       ← custom runner: lifecycle + runTests()
      suite/
        index.ts                       ← Mocha entry point; exports run(), loaded by extensionTestsPath
      agentProxyIntegration.test.ts
request-proxy/
  test/
    integration/
      suite/
        index.ts                       ← Mocha entry point; exports run(), loaded by extensionTestsPath
      requestProxyIntegration.test.ts
      gpgCliIntegration.test.ts
```

**Integration test npm scripts** in `agent-proxy/package.json`:
```json
"compile:integration": "tsc --build tsconfig.test.json",
"lint:integration":    "eslint src",
"pretest:integration": "npm run compile:integration && npm run lint:integration",
"test:integration":    "node out/test/integration/runTest.js"
```

**Structure of `runTest.ts`:**
```typescript
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { runTests } from '@vscode/test-electron';
import { GpgCli } from '@gpg-relay/shared/test/integration';

const GNUPGHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gpg-test-'));
process.env.GNUPGHOME = GNUPGHOME; // set before constructing GpgCli or calling runTests()
const cli = new GpgCli();

async function main() {
    cli.writeAgentConf(['disable-scdaemon']); // only confirmed-valid conf option in GPG 2.4.x
    cli.launchAgent();
    try {
        await runTests({
            extensionDevelopmentPath: path.resolve(__dirname, '../../../'),
            extensionTestsPath: path.resolve(__dirname, './suite/index'), // exports run() — required by @vscode/test-electron
            extensionTestsEnv: {
                VSCODE_INTEGRATION_TEST: '1',
                GNUPGHOME
            }
        });
    } finally {
        cli.killAgent();
        fs.rmSync(GNUPGHOME, { recursive: true, force: true });
    }
}

main().catch(err => { console.error(err); process.exit(1); });
```

The `extensionTestsEnv` values are merged into the extension host's environment by
`@vscode/test-electron` before the host launches. This means `GNUPGHOME` and
`VSCODE_INTEGRATION_TEST` are present when `activate()` runs and when `gpgconf.exe` is called
during extension initialization.

### Build Infrastructure

Both `agent-proxy/tsconfig.json` and `shared/tsconfig.json` have `rootDir: src` and only compile
`src/**`. Files under `test/integration/` need a separate compile step:

- Each package that has integration tests gets a **`tsconfig.test.json`** that:
  - `extends` the base `tsconfig.json`
  - sets `rootDir` to `.` (the package root)
  - adds `"test/integration/**"` to `include`
  - sets `outDir` to `out` (same output tree, so `out/test/integration/*.js` lands correctly)
- The `pretest:integration` hook runs `compile:integration` + `lint:integration` automatically before `test:integration`. The `test:integration` script itself only invokes the Node.js runner (`node out/test/integration/runTest.js`). See each package's `package.json` for the full script set.
- Affected packages: `agent-proxy`, `shared`

The custom runner output (`runTest.js`) lands in
`out/test/integration/` alongside the compiled test files.

### Shared Package Export

`shared/package.json` already exports `"."` and `"./test"`. A third export is needed:

```json
"./test/integration": {
  "types": "./out/test/integration/index.d.ts",
  "default": "./out/test/integration/index.js"
}
```

`shared/test/integration/index.ts` is a barrel that re-exports everything from `gpgCli.ts`
and `assuanSocketClient.ts`. Integration tests in `agent-proxy` and `request-proxy` then do:
```typescript
import { GpgCli, AssuanSocketClient } from '@gpg-relay/shared/test/integration';
```

### Extension Init Guard

`isTestEnvironment()` in `shared/src/environment.ts` returns `true` under `@vscode/test-electron`,
causing `detectGpg4winPath()`, `detectAgentSocket()`, and `startAgentProxy()` to all bail out early.
Integration tests need full initialization.

Two changes are required:

1. **Add `isIntegrationTestEnvironment()` to `shared/src/environment.ts`:**
   ```typescript
   export function isIntegrationTestEnvironment(): boolean {
       return process.env.VSCODE_INTEGRATION_TEST === '1';
   }
   ```
   Export it from `shared/src/index.ts`.

2. **Update the guard in `agent-proxy/src/extension.ts` and `request-proxy/src/extension.ts`:**
   ```typescript
   // Before:
   if (!isTestEnvironment()) { ... }

   // After:
   if (!isTestEnvironment() || isIntegrationTestEnvironment()) { ... }
   ```
   In `agent-proxy`: applied to `startAgentProxy()`, `detectGpg4winPath()`, and `detectAgentSocket()`.
   In `request-proxy`: applied to the auto-start block in `activate()`.

Result:
- Unit tests (`npm test`): `isTestEnvironment()=true`, `isIntegrationTestEnvironment()=false` → skips init ✓
- Integration tests (`npm run test:integration`): `isTestEnvironment()=true`, `isIntegrationTestEnvironment()=true` → full init ✓
- Production: `isTestEnvironment()=false` → full init ✓

### Key Management Helper

**`gpgCli.ts`** — all `gpg.exe` / `gpgconf.exe` subprocess calls, shared across all phases:

```typescript
class GpgCli {
    /**
     * Construct a GpgCli instance. Reads GNUPGHOME from process.env.GNUPGHOME;
     * throws if not set.
     * @param opts.gpgPath     Path to gpg binary; defaults to 'gpg' (on PATH)
     * @param opts.gpgconfPath Path to gpgconf binary; defaults to 'gpgconf' (on PATH)
     */
    constructor(opts?: { gpgPath?: string; gpgconfPath?: string });

    // Agent lifecycle (called from runTest.ts, in runner process)

    /** Write gpg-agent.conf into GNUPGHOME. Lines are written one per line, LF-terminated. */
    writeAgentConf(options: string[]): void;
    /** spawnSync gpgconf --launch gpg-agent with GNUPGHOME set. */
    launchAgent(): void;
    /** spawnSync gpgconf --kill gpg-agent with GNUPGHOME set. */
    killAgent(): void;

    // Key lifecycle (called from Mocha before()/after(), inside extension host)

    /** Write batch file and spawnSync gpg --batch --gen-key.
     * Uses explicit Key-Type: EDDSA + Subkey-Type: ECDH (not 'Key-Type: default',
     * which resolves unreliably on some Gpg4win installations). */
    generateKey(name: string, email: string): void;
    /** spawnSync gpg --batch --yes --delete-secret-and-public-key <fingerprint>. */
    deleteKey(fingerprint: string): void;
    /** Parse gpg --with-colons --fingerprint <email> output; return fingerprint string. */
    getFingerprint(email: string): string;
    /**
     * Return the keygrip of the primary signing key matching email.
     * Parses gpg --with-colons --with-keygrip --fingerprint output for the first grp: record.
     * SIGKEY (Assuan protocol) requires a keygrip, not a fingerprint.
     */
    getKeygrip(email: string): string;
    /** spawnSync gpg --export --armor <fingerprint>; return raw armored public key. */
    exportPublicKey(fingerprint: string): string;
    /** Write keyData to temp file; spawnSync gpg --import <file>. */
    importPublicKey(keyData: string): void;

    // Crypto ops (called from Phase 3 test file, inside dev container)

    /** spawnSync gpg --batch --no-tty --sign --local-user <userId> <inputPath>. */
    signFile(inputPath: string, userId: string): { exitCode: number; stdout: string; stderr: string };
    /** spawnSync gpg --verify <sigPath>. */
    verifyFile(sigPath: string): { exitCode: number; stdout: string; stderr: string };
    /** spawnSync gpg --batch --encrypt --recipient <recipient> <inputPath>. */
    encryptFile(inputPath: string, recipient: string): { exitCode: number; stdout: string; stderr: string };
    /** spawnSync gpg --batch --decrypt <inputPath>. */
    decryptFile(inputPath: string): { exitCode: number; stdout: string; stderr: string };
}
```

Constructor validation:
- Throws if `process.env.GNUPGHOME` is not set

`runTest.ts` sets `process.env.GNUPGHOME` before constructing `GpgCli`, so the same
`new GpgCli()` call works identically in the runner, the extension host, and the container.

All methods use `spawnSync` with `{ env: { ...process.env, GNUPGHOME: this.gnupgHome } }`. Batch
files (key generation, public key import) are written via `fs.writeFileSync` with `'latin1'`
encoding. `'latin1'` covers the full 0–255 byte range, is consistent with the rest of the
codebase's socket I/O encoding, and is a strict superset of ASCII — so conf/batch file content
(which is ASCII-only) is unaffected, while binary key material (e.g. non-armored public key
passed to `importPublicKey`) round-trips without truncation. All methods throw on non-zero exit
code with `stderr` included in the message.

**`assuanSocketClient.ts`** — Assuan protocol socket test client (used by Phase 2 and Phase 3):

The Assuan protocol is line-oriented, LF-terminated, latin1-encoded, strict request/response.
Response lines before the terminal are `S <keyword> <data>` (status) and `D <data>` (data block).
The terminal is `OK`, `OK <text>`, `ERR <code> <text>`, or `INQUIRE <keyword>`.
INQUIRE means the agent is pausing and asking the client for data; the client responds with zero
or more `D <data>\n` lines then `END\n`. `INQUIRE PINENTRY_LAUNCHED` is a notification (no data),
client replies `END\n` only.

```typescript
class AssuanSocketClient {
    /**
     * Connect to the Unix socket at socketPath and read the agent greeting.
     * Accumulates data using latin1 encoding to preserve raw bytes.
     * Resolves with the greeting line (e.g. "OK Pleased to meet you").
     */
    connect(socketPath: string): Promise<string>;

    /**
     * Send a single newline-terminated command and accumulate the response.
     * Uses detectResponseCompletion() from @gpg-relay/shared to detect OK/ERR/INQUIRE.
     * - If INQUIRE PINENTRY_LAUNCHED: auto-replies END\n (notification, no data),
     *   then continues accumulating until OK/ERR.
     * - If any other INQUIRE: rejects with an error (unexpected in no-passphrase tests).
     * Resolves with the full accumulated response string.
     */
    sendCommand(cmd: string): Promise<string>;

    /**
     * Destroy the underlying socket. Safe to call multiple times.
     */
    close(): void;
}
```

Key implementation notes:
- Uses `latin1` encoding throughout (matches production socket I/O)
- Uses `detectResponseCompletion()` from `@gpg-relay/shared` to detect response boundaries —
  same logic as the production proxy, ensuring test client and proxy agree on framing
- Buffers incoming data across `data` events; only resolves once a complete response is detected
- Timeout: rejects after a configurable timeout (default 5000 ms) if no terminal line arrives

### Decisions: Previously Open Questions

1. **INQUIRE/sign test (Phase 1, test 7):** The test will compute a SHA-512 hash of a known test
   payload (`Buffer.from('test data')`) using Node's `crypto.createHash('sha512')` and send that
   directly in the `SETHASH 10` command (libgcrypt algorithm ID `10` = SHA-512).

2. **`extensionDependencies` in `request-proxy/package.json`:** Cross-host `extensionDependencies`
   (workspace → ui) conirmed works. VS Code correctly loads `request-proxy` in the
   remote extension host even when the `local.gpg-agent-proxy` dependency lives in the local host.

### Resolved: Previously Open Questions

3. **Phase 3 keys** — *Resolved.* The runner generates a throwaway key in the Windows process
   (`runTest.ts`), exports its ASCII-armored public key, and forwards it to the container via
   `PUBKEY_ARMORED_KEY` env var. The container's `before()` imports the public key into the Linux
   `GNUPGHOME`. The private key never leaves Windows; all signing flows through `agent-proxy`.

---

## Phase 1 — `agent-proxy` ↔ Real gpg-agent

**Status: Complete. All 9 tests passing (9/9).**

**Constraint:** Runs on Windows host only. `agent-proxy` is a Windows-only extension.

**Location:** `agent-proxy/test/integration/agentProxyIntegration.test.ts`

**Integration test npm scripts** in `agent-proxy/package.json`:
```json
"compile:integration": "tsc --build tsconfig.test.json",
"lint:integration":    "eslint src",
"pretest:integration": "npm run compile:integration && npm run lint:integration",
"test:integration":    "node out/test/integration/runTest.js"
```

### Setup / Teardown

The isolated gpg-agent is started **before** the extension host launches (in `runTest.ts`), so
`gpgconf.exe` called during `activate()` already sees `GNUPGHOME` pointing to the test directory
and the test agent's socket is live.

```
[runTest.ts — outside extension host]
  GNUPGHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gpg-test-'))  ← unique per run
  process.env.GNUPGHOME = GNUPGHOME
  cli = new GpgCli()
  cli.writeAgentConf(['disable-scdaemon'])   ← only confirmed-valid conf option in GPG 2.4.x
  cli.launchAgent()               ← gpgconf --launch gpg-agent (GNUPGHOME=<unique-temp-dir>)
  runTests({ extensionTestsEnv: { VSCODE_INTEGRATION_TEST: '1', GNUPGHOME } })
    → extension host starts; activate() runs with GNUPGHOME set
    → detectGpg4winPath() + detectAgentSocket() + startAgentProxy() run normally
    → detectAgentSocket() calls gpgconf --list-dirs agent-extra-socket → isolated socket
    → [Mocha tests run]
  cli.killAgent()                 ← gpgconf --kill gpg-agent (GNUPGHOME=<unique-temp-dir>)
  rmSync(GNUPGHOME, { recursive: true, force: true })

[Mocha before() — inside extension host]
  - Extension is already fully initialized (no manual init needed)
  - cli = new GpgCli()  (GNUPGHOME already in process.env via extensionTestsEnv)
  - cli.generateKey('Test User', 'test@example.com') → creates no-passphrase key in isolated keyring
  - fingerprint = cli.getFingerprint('test@example.com') → store for use in tests
  - keygrip = cli.getKeygrip('test@example.com')       → required by SIGKEY (Assuan uses keygrip, not fingerprint)

[Mocha after()]
  - cli.deleteKey(fingerprint)    ← removes key from isolated keyring before agent is killed
  - executeCommand('gpg-agent-proxy.stop') to reset extension state
```

### Test Cases

1. **Connect / greeting**
   - `vscode.commands.executeCommand('_gpg-agent-proxy.connectAgent')` resolves with `{ sessionId, greeting }`
   - `greeting` starts with `OK`
   - `sessionId` is a non-empty string

2. **GETINFO version**
   - `vscode.commands.executeCommand('_gpg-agent-proxy.sendCommands', sessionId, 'GETINFO version\n')` resolves
   - Response contains a `D <version>` line (extra socket returns version as a data record, not `S VERSION` as on the main socket)
   - Response ends with `OK`

3. **HAVEKEY — isolated agent has the test key** *(replaces KEYINFO; validates keyring isolation)*
   - `sendCommands(sessionId, 'HAVEKEY <keygrip>\n')` resolves with `OK`
   - Confirms the key generated in `before()` exists in the *isolated* agent's key store (`private-keys-v1.d/`)
   - If isolation were broken (agent running against system GNUPGHOME), this returns `ERR ... No secret key`

4. **Unknown command → ERR**
   - `sendCommands(sessionId, 'NOTACOMMAND\n')` resolves (does not reject)
   - Response starts with `ERR`

5. **BYE / disconnectAgent**
   - `vscode.commands.executeCommand('_gpg-agent-proxy.disconnectAgent', sessionId)` resolves without throwing
   - Subsequent `sendCommands(sessionId, ...)` rejects

6. **Multiple concurrent sessions**
   - Open 3 sessions via `connectAgent` simultaneously
   - Each receives an independent `sessionId` and an `OK` greeting
   - Close all 3 cleanly via `disconnectAgent`

7. **Sign via PKSIGN flow** (tests real signing sequence with no-passphrase key)

   Real-world command sequence for extra socket (gpg-agent 2.4.8, Ed25519 key, no passphrase):
   ```
   → OPTION agent-awareness=2.1.0
   ← OK
   → RESET
   ← OK
   → SIGKEY <keygrip>           ← keygrip (not fingerprint) — Assuan SIGKEY requires keygrip
   ← OK
   → SETKEYDESC <url-encoded description>
   ← OK
   → SETHASH 10 <sha512-hex>    ← algo ID 10 = SHA-512 (libgcrypt GCRY_MD_SHA512)
   ← OK
   → PKSIGN
   ← [with passphrase key]: INQUIRE PINENTRY_LAUNCHED <pid> <info...>
      → END                     ← client ACKs pinentry notification with no data
      ← D <binary signature bytes>
      ← OK
   ← [with no-passphrase key]: D <binary signature bytes>  ← INQUIRE skipped entirely
      ← OK
   ```

   **Critical notes:**
   - `OPTION allow-pinentry-notify` is **forbidden on the extra socket** — the agent returns `ERR ... Forbidden`. Do not send it.
   - `SIGKEY` takes a **keygrip**, not a fingerprint. These are different 40-char hex values.
     Use `gpg --with-colons --with-keygrip` to obtain the keygrip; it appears in `grp:` records.
   - `SETHASH` uses a numeric libgcrypt algorithm ID, not a name string. `10` = SHA-512.
   - The `INQUIRE PINENTRY_LAUNCHED` is a **pinentry notification**, not a data request. The
     client replies with `END` only (no `D` lines). With a no-passphrase key, this INQUIRE
     does **not** appear — `PKSIGN` returns the signature directly.
   - The hash sent in `SETHASH` is uppercase hex of a SHA-512 digest.

   **Test steps (using no-passphrase test key — no INQUIRE expected):**
   1. `connectAgent` command → sessionId
   2. `sendCommands(sessionId, 'OPTION agent-awareness=2.1.0\n')` → `OK`
   3. `sendCommands(sessionId, 'RESET\n')` → `OK`
   4. `sendCommands(sessionId, 'SIGKEY <keygrip>\n')` → `OK`  *(keygrip from `getKeygrip()`)*
   5. `sendCommands(sessionId, 'SETKEYDESC Integration+Test+Signing\n')` → `OK`
   6. Compute SHA-512 of `Buffer.from('test data')` using Node `crypto.createHash('sha512')`; hex-encode uppercase
   7. `sendCommands(sessionId, 'SETHASH 10 <sha512hex>\n')` → `OK`
   8. `sendCommands(sessionId, 'PKSIGN\n')` → response contains `D <...>` and ends with `OK` (no INQUIRE with no-passphrase key)

   **Separate test (verify INQUIRE PINENTRY_LAUNCHED handling — requires a passphrase-protected key or mock):**
   - This INQUIRE is a notification not a data request; client must reply `END\n` with no D-lines
   - Since the no-passphrase test key skips this, cover this path via a mock in unit tests rather than integration tests

8. **Session isolation after error**
   - Force `sendCommands` with an unknown/invalid session ID → rejects
   - Verify a valid session opened before the error still sends commands correctly

9. **Bad Gpg4win path rejects start; restore config recovers proxy**
   - Call `gpg-agent-proxy.stop` to reset detected state
   - Set `gpgAgentProxy.gpg4winPath` to a nonexistent path via `vscode.workspace.getConfiguration('gpgAgentProxy').update(...)`
   - Call `gpg-agent-proxy.start` → **rejects** (propagates after logging/showing error)
     - `detectGpg4winPath` throws when the configured path has no `gpgconf.exe` — does **not** fall back to auto-detection; an explicit path is used exclusively
     - `startAgentProxy` re-throws after `outputChannel.appendLine` + `vscode.window.showErrorMessage`
   - Verify the rejection message matches `/gpg4win|not found|gpgconf/i`
   - `connectAgent` also rejects (`agentProxyService` was never initialized)
   - Restore config: `config.update('gpg4winPath', undefined, ...)` (in a `finally` block)
   - Call `gpg-agent-proxy.start` → succeeds (auto-detection resumes)
   - `connectAgent` succeeds; greeting starts with `OK`

---

## Phase 2 — `request-proxy` → `agent-proxy` → Real gpg-agent

**Status: Complete. All 8 tests passing (8/8).**

The `--remote dev-container+<uri>` runner approach works as designed. All four previously-open
experimental unknowns are resolved; see the Automated Runner Approach section below for details.

### Implementation summary

- [request-proxy/test/integration/requestProxyRunTest.ts](../request-proxy/test/integration/requestProxyRunTest.ts) — custom runner with `--remote` launchArgs (see file header)
- [request-proxy/test/integration/requestProxyIntegration.test.ts](../request-proxy/test/integration/requestProxyIntegration.test.ts) — 8 test cases
- [request-proxy/test/integration/suite/requestProxyIndex.ts](../request-proxy/test/integration/suite/requestProxyIndex.ts) — Mocha entry point
- [request-proxy/tsconfig.test.json](../request-proxy/tsconfig.test.json) — test compilation config
- [.devcontainer/devcontainer.json](../.devcontainer/devcontainer.json) — Phase 2 dev container (ubuntu-22.04, no gpg; Phase 3 gets its own container with gnupg2)
- `request-proxy/package.json` — `test:integration` npm script added
- `request-proxy/src/services/requestProxy.ts` — `RequestProxyInstance.socketPath: string` added
- `request-proxy/src/extension.ts` — `_gpg-request-proxy.test.getSocketPath` command added (integration test mode only; returns active socket path so tests can connect via `AssuanSocketClient`)

### Design notes (deviations from original plan)

- Tests use the **auto-started proxy** (via `activate()` + `VSCODE_INTEGRATION_TEST=1`) rather than
  starting a new instance in `before()`. This avoids importing `startRequestProxy` across the
  `src/` → `test/integration/` module boundary (TypeScript path vs runtime path mismatch).
- Socket path is discovered via `_gpg-request-proxy.test.getSocketPath` VS Code command (new) rather than
  a hard-coded path, so the actual `gpgconf`-derived Linux socket path is used automatically.
- `RequestProxyInstance` gains a `socketPath` field used by the command above.
- `SIGKEY` in test 5 uses `TEST_KEY_KEYGRIP` (not fingerprint) — consistent with Phase 1 test 7 findings.
- `OPTION allow-pinentry-notify` is NOT sent — it is forbidden on the extra socket (Phase 1 finding).

**Constraint:** `request-proxy` is a remote-only extension (dev container/WSL/SSH). Phase 2 exercises
the full proxy chain: client Unix socket → `request-proxy` (Linux) → VS Code command routing
→ `agent-proxy` (Windows) → gpg-agent (Windows). No `gpg` CLI is needed on the Linux side;
tests use `AssuanSocketClient` to speak directly to the Unix domain socket that `request-proxy`
creates.

**Location:** `request-proxy/test/integration/requestProxyIntegration.test.ts`

**Integration test npm scripts** in `request-proxy/package.json`:
```json
"compile:integration":            "tsc --build tsconfig.test.json",
"lint:integration":               "eslint src",
"pretest:integration":            "npm run compile:integration && npm run lint:integration",
"test:integration":               "npm run test:integration:request-proxy && npm run test:integration:gpg-cli",
"test:integration:request-proxy": "node out/test/integration/requestProxyRunTest.js",
"test:integration:gpg-cli":       "node out/test/integration/gpgCliRunTest.js"
```

### Automated Runner Approach *(validated)*

The goal is a fully automated `npm run test:integration` — no manual "Reopen in Container" click.
The key insight: `@vscode/test-electron`'s `runTests()` accepts arbitrary `launchArgs` passed
directly to the VS Code executable
([vscode-test docs](https://github.com/Microsoft/vscode-test#readme),
[vscode-test-cli docs](https://github.com/microsoft/vscode-test-cli/blob/main/README.md),
[defineConfig schema](https://github.com/microsoft/vscode-test-cli/blob/main/src/config.cts)).
Combining `--remote` with `extensionDevelopmentPath` for both extensions should cause VS Code to:

1. Connect to a dev container (preferred) or WSL remote
   - **Dev container is preferred** over WSL: `devcontainer.json` declaratively defines all
     dependencies (`gnupg2`, extensions, env vars, image), giving a reproducible isolated
     environment. WSL is a personal machine setup that varies between developers.
2. Route each extension to the correct host based on its `extensionKind`:
   - `agent-proxy` (`extensionKind: ["ui"]`) → Windows local extension host
   - `request-proxy` (`extensionKind: ["workspace"]`) → remote extension host (Linux)
3. Run `extensionTestsPath` (Mocha suite) in the remote host — where the Unix socket exists

**Proposed `runTest.ts` additions over Phase 1:**
```typescript
await runTests({
    extensionDevelopmentPath: [
        path.resolve(__dirname, '../../..'),               // agent-proxy → local (ui)
        path.resolve(__dirname, '../../../../request-proxy') // request-proxy → remote (workspace)
    ],
    launchArgs: [
        '--install-extension', 'ms-vscode-remote.remote-containers', // needed in bare test VS Code
        '--remote', 'dev-container+<uri>',  // uri TBD after experimentation
        '/workspaces/gpg-windows-relay'
        // WSL fallback: '--install-extension', 'ms-vscode-remote.remote-wsl',
        //               '--remote', 'wsl+Ubuntu-22.04', '/mnt/c/njs/gpg-windows-relay'
    ],
    extensionTestsEnv: {
        VSCODE_INTEGRATION_TEST: '1',
        GNUPGHOME,
        TEST_KEY_FINGERPRINT: fingerprint
    }
});
```

The `installExtensions` field in `defineConfig`'s schema also accepts local `.vsix` paths and
marketplace IDs — it is not limited to one or the other. However, `defineConfig` is not used
here because it has no pre-launch lifecycle hook; `cli.launchAgent()` must run before
`activate()` fires (same reason as Phase 1).

**All unknowns resolved experimentally:**

1. **`extensionTestsEnv` propagation** ✅ — Propagates to both hosts. The Windows local host
   receives `GNUPGHOME` (used by `agent-proxy` during `activate()`), and the remote host also
   receives it. Both extensions see a consistent isolated keyring.
2. **`extensionDevelopmentPath` routing** ✅ — VS Code correctly routes `agent-proxy`
   (`extensionKind: ["ui"]`) to the local Windows host and `request-proxy`
   (`extensionKind: ["workspace"]`) to the remote Linux host.
3. **`extensionTestsPath` location** ✅ — The Mocha suite runs in the remote (Linux) host where
   the Unix domain socket exists. `AssuanSocketClient` connects successfully.
4. **`--install-extension` + `--remote` ordering** ✅ — The `ms-vscode-remote.remote-containers`
   extension must be pre-installed in the test VS Code instance (handled via `launchArgs`). The
   dev container must already be running before `runTests()` is invoked.

### Setup / Teardown

```
[runTest.ts — Windows, before extension hosts launch]
  GNUPGHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gpg-test-'))
  process.env.GNUPGHOME = GNUPGHOME
  cli = new GpgCli()
  cli.writeAgentConf(['disable-scdaemon'])  ← only confirmed-valid conf option in GPG 2.4.x
  cli.generateKey('Test User', 'test@example.com')
  fingerprint = cli.getFingerprint('test@example.com')
  cli.launchAgent()
  try:
    runTests({ launchArgs: ['--remote', 'dev-container+<uri>', '/workspaces/gpg-windows-relay'],               extensionDevelopmentPath: [agent-proxy, request-proxy],
               extensionTestsEnv: { VSCODE_INTEGRATION_TEST: '1', GNUPGHOME,
                                    TEST_KEY_FINGERPRINT: fingerprint } })
  finally:
    cli.killAgent()
    cli.deleteKey(fingerprint)
    rmSync(GNUPGHOME)

[Mocha before() — remote (Linux) extension host]
  - fingerprint = process.env.TEST_KEY_FINGERPRINT  ← injected via extensionTestsEnv
  - instance = await startRequestProxy(config, {
        commandExecutor: new VSCodeCommandExecutor(),
        getSocketPath: async () => '/tmp/gpg-relay-test.sock'
    })

[Mocha after()]
  - await instance.stop()
```

### Test Cases

1. **Server starts and socket created**
   - `startRequestProxy()` resolves without throwing
   - Socket file exists at expected path with permissions `0o666`

2. **Full GETINFO round-trip via socket client**
   - Connect a `net.Socket` to the proxy socket
   - Read greeting (starts with `OK`)
   - Send `GETINFO version\n`
   - Read response through to `OK`

3. **ERR response forwarded**
   - Send `BADCOMMAND\n`
   - Read response: contains `ERR`, forwarded intact from agent

4. **Multiple sequential commands in one session**
   - Send `GETINFO version\n`, read to `OK`
   - Then send `KEYINFO --list\n`, read to `OK`
   - Verify both responses independently

5. **INQUIRE flow through proxy** *(note: with a no-passphrase key, PKSIGN returns the signature directly without an INQUIRE — see Phase 1 test 7 notes)*
   - Send `OPTION allow-pinentry-notify\n` → `OK`
   - Send `RESET\n` → `OK`
   - Send `SIGKEY <fingerprint>\n` → `OK`
   - Send `SETKEYDESC Test+key\n` → `OK`
   - Compute SHA-512 of test payload; send `SETHASH 10 <sha512hex>\n` → `OK`
   - Send `PKSIGN\n` → response contains `D <signature>` and ends with `OK`

6. **Graceful disconnect**
   - Send `BYE\n`
   - Socket closes cleanly; no error emitted

7. **Multiple concurrent clients**
   - Connect 3 sockets simultaneously
   - Issue independent `GETINFO version\n` on each
   - Verify responses are not cross-contaminated (correct session isolation)

8. **stop() cleans up**
   - Call `instance.stop()`
   - Verify socket file is removed

---

## Phase 3 — `gpg.exe` → `request-proxy` → `agent-proxy` → gpg-agent

**Status: Complete. All 7 tests passing (7/7).**

**Constraint:** Phase 3 exercises the full end-to-end chain with a real `gpg` binary on Linux
calling through the relay to the Windows gpg-agent. `gnupg2` must be installed in the remote;
`GNUPGHOME` must be set in the remote and must contain the public key of the Windows test key
so `gpg` can address it by fingerprint. Private keys never leave Windows.

**Location:** `request-proxy/test/integration/gpgCliIntegration.test.ts`

### Proposed Automated Runner Approach *(builds on Phase 2 findings)*

Same `runTests()` + `--remote` approach as Phase 2, with two additions:

1. **`gnupg2` on the remote**: either baked into a custom container image, or installed via
   `postCreateCommand` before the test VS Code connects.

2. **Linux-side `GNUPGHOME` and public key**: the Windows `runTest.ts` generates a throwaway
   key, exports the public key, and needs to write it into the container's filesystem before
   the Mocha suite starts. Path: the container mounts the Windows workspace at
   `/workspaces/gpg-windows-relay` (or `/mnt/c/...` in WSL), so the key export can be written
   to a well-known path the container can read. Then Mocha `before()` imports it into
   `GNUPGHOME` using `cli.importPublicKey()`.

**Proposed `runTest.ts` additions over Phase 2:**
```typescript
// Windows side — before runTests()
// Container image has gnupg2 pre-installed; defined in devcontainer.json
const CONTAINER_WORKSPACE = '/workspaces/gpg-windows-relay';
const LINUX_GNUPGHOME = '/tmp/gpg-test-integration'; // defined in devcontainer.json remoteEnv
const exportPath = path.join(GNUPGHOME, 'pubkey-export.asc');
fs.writeFileSync(exportPath, cli.exportPublicKey(fingerprint), 'latin1');
// exportPath is accessible from container via /workspaces mount

await runTests({
    launchArgs: [
        '--install-extension', 'ms-vscode-remote.remote-containers',
        '--remote', 'dev-container+<uri>',
        CONTAINER_WORKSPACE
    ],
    extensionTestsEnv: {
        VSCODE_INTEGRATION_TEST: '1',
        GNUPGHOME: LINUX_GNUPGHOME,    // Linux-side GNUPGHOME for gpg CLI + request-proxy
        WINDOWS_GNUPGHOME: GNUPGHOME,  // Windows-side GNUPGHOME for agent-proxy
        TEST_KEY_FINGERPRINT: fingerprint,
        PUBKEY_ARMORED_KEY: cli.exportPublicKey(fingerprint) // ASCII-armored public key string
    }
});
```

**`devcontainer.json` for Phase 3:**
```json
{
  "name": "gpg-windows-relay phase 3 integration tests",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu-22.04",
  "postCreateCommand": "sudo apt-get update && sudo apt-get install -y gnupg2",
  "remoteEnv": {
    "GNUPGHOME": "/tmp/gpg-test-integration"
  }
}
```
All test dependencies are declared in `devcontainer.json` — reproducible and isolated from any
developer machine state.

**Phase 2 env-propagation question resolved:** `extensionTestsEnv` reaches *only* the remote
host. Agent-proxy (Windows) gets `GNUPGHOME` via `extensionTestsEnv` directly (Windows local
extension host sees the parent VS Code process env, which includes `extensionTestsEnv`). The
container's `GNUPGHOME` is a *static* Linux path (`/tmp/gpg-test-phase3`) declared in
`devcontainer.json` `remoteEnv` — not forwarded from Windows. `PUBKEY_ARMORED_KEY` (ASCII-armored
public key string) and `TEST_KEY_FINGERPRINT` are forwarded from `extensionTestsEnv` →
`remoteEnv ${localEnv:...}`.
See `.devcontainer/phase3/devcontainer.json` and `gpgCliRunTest.ts` for details.

### Setup / Teardown

```
[runTest.ts — Windows, before extension hosts launch]
  GNUPGHOME = fs.mkdtempSync(...)   ← Windows-side isolated keyring
  process.env.GNUPGHOME = GNUPGHOME
  cli = new GpgCli()
  cli.writeAgentConf(['disable-scdaemon'])
  cli.generateKey('Test User', 'test@example.com')
  fingerprint = cli.getFingerprint('test@example.com')
  cli.launchAgent()
  pubkeyArmored = cli.exportPublicKey(fingerprint)  ← ASCII-armored string, no file needed
  runTests({ ..., extensionTestsEnv: { GNUPGHOME (Windows path),
                                       TEST_KEY_FINGERPRINT: fingerprint,
                                       PUBKEY_ARMORED_KEY: pubkeyArmored } })
  finally: cli.killAgent(); cli.deleteKey(fingerprint); rmSync(GNUPGHOME)

[Mocha before() — remote (Linux) extension host]
  - fs.mkdirSync(process.env.GNUPGHOME, { recursive: true, mode: 0o700 })
  - cli = new GpgCli()   ← uses GNUPGHOME from env (Linux path)
  - cli.importPublicKey(process.env.PUBKEY_ARMORED_KEY)  ← no file read needed
  - fingerprint = process.env.TEST_KEY_FINGERPRINT
  - testDir = fs.mkdtempSync(...)

[Mocha after()]
  - linuxCli.deleteKey(fingerprint)   ← remove public key from Linux GNUPGHOME
  - rmSync(process.env.GNUPGHOME, { recursive: true, force: true })
```

### Test Cases

1. **gpg --version round-trip**
   - `spawnSync('gpg', ['--version'])` from inside container
   - Exit code 0; output contains version string
   - (Smoke test: proves gpg binary is callable)

2. **gpg --list-keys**
   - `spawnSync('gpg', ['--list-keys'])` from container
   - Exit code 0
   - Output contains test key UID

3. **Sign a file**
   - Write test payload to temp file
   - `spawnSync('gpg', ['--batch', '--no-tty', '--sign', '--local-user', testEmail, 'testfile.txt'])`
   - Exit code 0; `.sig` output file exists

4. **Verify signature**
   - `spawnSync('gpg', ['--verify', 'testfile.txt.sig'])`
   - Exit code 0

5. **Encrypt + decrypt round-trip**
   - `spawnSync('gpg', ['--batch', '--encrypt', '--recipient', testEmail, 'testfile.txt'])`
   - `spawnSync('gpg', ['--batch', '--decrypt', 'testfile.txt.gpg'])`
   - Decrypted plaintext matches original payload

6. **Large file sign**
   - Generate 256 KB random binary file
   - Sign it via `gpg --sign`
   - gpg hashes locally (SHA-256); only the ~32-byte hash is sent to gpg-agent via PKSIGN
   - Exit code 0; `.gpg` packet exists
   - (Note: 256 KB file does not traverse the proxy — tests large-input handling end-to-end)

7. **Large file encrypt + decrypt round-trip**
   - Generate 256 KB random binary file
   - `gpg --encrypt` (bulk AES-256 done locally; only ECDH-wrapped session key ~100B sent via PKENCRYPT, if any)
   - `gpg --decrypt` (PKDECRYPT inquiry sends ~100B encrypted session key through proxy; bulk decrypt is local)
   - Decrypted bytes match original binary content (latin1 round-trip)

---

## Running the Tests

`pretest:integration` runs `compile:integration` and `lint:integration` automatically before
any `test:integration` script — no manual compile step required.

### All phases (from repo root)
```powershell
npm run test:integration
# Runs Phase 1 (agent-proxy), then Phase 2 + Phase 3 (request-proxy) in sequence.
# Prerequisite: Phase 2 dev container and Phase 3 dev container must already be running.
```

### Phase 1 — agent-proxy (Windows only)
```powershell
cd agent-proxy
npm run test:integration
# pretest:integration compiles + lints automatically.
# Runner: mkdtempSync unique GNUPGHOME, launches isolated gpg-agent,
#         generates throwaway test key, starts extension host, runs 9 tests, cleans up.
```

### Phase 2 — request-proxy (dev container)
```powershell
# Prerequisite: Phase 2 dev container must be running (ubuntu-22.04, no gpg).
cd request-proxy
npm run test:integration:request-proxy
# pretest:integration compiles + lints automatically.
# Runner: fires VS Code with --remote dev-container+<uri>; agent-proxy loads on Windows,
#         request-proxy loads in container; AssuanSocketClient talks to the Unix socket.
```

### Phase 3 — gpg CLI end-to-end (dev container)
```powershell
# Prerequisite: Phase 3 dev container must be running (ubuntu-22.04 + gnupg2).
cd request-proxy
npm run test:integration:gpg-cli
# pretest:integration compiles + lints automatically.
# Runner: fires VS Code with --remote dev-container+<uri> (phase3 config); exports
#         throwaway Windows public key via PUBKEY_ARMORED_KEY env var; container
#         imports it and runs 7 gpg CLI tests through the full proxy chain.
```

## Decisions

| Decision | Rationale |
|---|---|
| No passphrase on test keys | Eliminates pinentry interaction, enables fully automated non-interactive tests |
| Tests use VS Code commands, not direct `AgentProxy` | Extension activation calls `detectGpg4winPath()` + `detectAgentSocket()` + `startAgentProxy()` automatically; tests call `_gpg-agent-proxy.*` commands as `request-proxy` does in production |
| `VSCODE_INTEGRATION_TEST=1` env var distinguishes integration from unit tests | `isTestEnvironment()` returns true for both; the new `isIntegrationTestEnvironment()` check allows integration tests to opt back into full extension initialization |
| `isIntegrationTestEnvironment()` added to shared, not inlined | Keeps environment detection centralized and reusable across both extensions |
| Custom `runTest.ts` runner instead of `.vscode-test-integration.mjs` | `extensionTestsEnv` in `runTests()` injects `GNUPGHOME` directly into the extension host process; pre/post hooks manage isolated agent lifecycle outside the host; runner is full Node.js so paths can be computed dynamically |
| `GNUPGHOME` set via `extensionTestsEnv`, not `--homedir` flag | All `gpg`/`gpgconf` calls inherit `GNUPGHOME` from the process env automatically; no per-call flag needed; works for both the extension host and spawned subprocesses |
| `GNUPGHOME` is a unique temp dir per run (`fs.mkdtempSync`) | `runTest.ts` is full Node.js; the path is computed before `runTests()` is called and passed to both `GpgCli` and `extensionTestsEnv`, so uniqueness is trivial |
| Isolated gpg-agent launched in `runTest.ts` (outside extension host) | Agent must exist before `activate()` runs, since `detectAgentSocket()` calls `gpgconf` at activation time; Mocha `before()` runs too late |
| `GpgCli` shared via `@gpg-relay/shared/test/integration` | All gpg/gpgconf calls needed by all phases; avoids duplication and scattered spawnSync |
| Phase 2/3 use `runTests()` + `launchArgs: ['--remote', 'dev-container+<uri>', ...]` | VS Code `extensionKind` routing loads `agent-proxy` locally and `request-proxy` remotely from a single test invocation; `runTest.ts` keeps the pre-launch gpg-agent lifecycle hook that `defineConfig` lacks; dev container is preferred over WSL because `devcontainer.json` declaratively defines all dependencies (image, `gnupg2`, env vars) making it reproducible and isolated from personal machine state. Refs: [vscode-test](https://github.com/Microsoft/vscode-test#readme), [vscode-test-cli](https://github.com/microsoft/vscode-test-cli/blob/main/README.md), [defineConfig schema](https://github.com/microsoft/vscode-test-cli/blob/main/src/config.cts) |
| `installExtensions` / `--install-extension` accepts both marketplace IDs and `.vsix` paths | No need for `fromMachine: true`; the bare downloaded test VS Code can have `ms-vscode-remote.remote-containers` (or `remote-wsl` as fallback) added via `launchArgs`, keeping the environment isolated from the developer's real VS Code install |
| Phase 2/3 `extensionTestsEnv` propagation reaches both hosts | Validated experimentally: env vars propagate to both the Windows local host (used by `agent-proxy`) and the remote host (used by `request-proxy`). Both extensions see a consistent isolated `GNUPGHOME`. |
| Phase 3 test key: private on Windows, only public exported to Linux | Linux `gpg` only needs the public key to address key operations by fingerprint; private key stays on Windows so all signing flows through `agent-proxy` to the real gpg-agent; public key is exported to a path accessible from the container |
| Phase 2/3 automated `--remote dev-container+<uri>` works; fallback not needed | The automated approach validated successfully. Manual "Reopen in Container" fallback was not required. |
| Phase 3 has its own `devcontainer.json` at `.devcontainer/phase3/devcontainer.json` | Phase 2 has no gpg binary; Phase 3 needs gnupg2. Separate configs prevent Phase 2 from accidentally pulling in the gpg install and keep the two test environments isolated. `runTest.ts` / `gpgCliRunTest.ts` each reference their own config file via the serialized URI object format. |
| Phase 3 `GNUPGHOME` split: Windows path via `extensionTestsEnv`; Linux path static in `devcontainer.json` | `extensionTestsEnv` propagates to both Windows local host and remote host in VS Code's test setup. Agent-proxy (Windows) uses the Windows `GNUPGHOME` path it inherits from `extensionTestsEnv`. The container's gpg CLI and request-proxy use the static Linux path `/tmp/gpg-test-phase3` set in `remoteEnv` — no Windows path forwarded to Linux to avoid confusion. |
| Phase 3 public key: passed as `PUBKEY_ARMORED_KEY` env var | `exportPublicKey()` already returns an ASCII-armored string. An Ed25519 armored public key is ~350 chars — well within the 32,767-char Win32 env var limit. Eliminates the intermediate file write, workspace bind mount dependency, container-visible path calculation, and cleanup step in the runner's `finally` block. `devcontainer.json` remoteEnv forwards it via `${localEnv:PUBKEY_ARMORED_KEY}`; `before()` calls `importPublicKey(process.env.PUBKEY_ARMORED_KEY)` directly. |
| Phase 3 `gpg.conf` sets `trust-model always` in `before()` | The imported Windows public key has no explicit ownertrust. Without `trust-model always` gpg refuses to encrypt or shows warnings that cause non-zero exit codes. Written once into GNUPGHOME before any gpg call; cleaned up with GNUPGHOME in `after()`. |
| `GpgCli` consolidates all `gpg`/`gpgconf` subprocess calls | Single place for binary path resolution, `GNUPGHOME` env injection, temp file creation, and error handling; no scattered `spawnSync` calls across test files |
| `GpgCli` reads `GNUPGHOME` from `process.env`; `runTest.ts` sets it before first use | Eliminates ambiguous constructor param; `process.env.GNUPGHOME = GNUPGHOME` in `runTest.ts` is idiomatic for a runner script; same `new GpgCli()` call works in runner, extension host, and container |
| `gpgTestEnvironment.ts` eliminated; logic inlined into `runTest.ts` | After `GpgCli` absorbed all subprocess and conf-file logic the remaining wrapper was two lines; inlining it allows a single `GpgCli` instance to be shared across `writeAgentConf`, `launchAgent`, and `killAgent` within the same try/finally |
| `test:integration` separate from `test` | Keeps integration tests out of normal `npm test` runs; avoids slow I/O in CI unit-test runs |
| `tsconfig.test.json` extends base tsconfig | Base `tsconfig.json` stays `rootDir: src`; test config widens rootDir to `.` and adds `test/integration/**` without touching production compile |
| `./test/integration` export in `shared/package.json` | Mirrors existing `./test` pattern; enables `@gpg-relay/shared/test/integration` imports without duplicating files |
