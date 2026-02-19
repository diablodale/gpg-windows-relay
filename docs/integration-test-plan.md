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

**`test:integration` npm script** in `agent-proxy/package.json`:
```json
"test:integration": "tsc --build tsconfig.test.json && node out/test/integration/runTest.js"
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
    cli.writeAgentConf(['disable-scdaemon', 'disable-ssh-support',
                        'disable-win32-openssh-support', 'disable-putty-support']);
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
- The `test:integration` npm script runs `tsc --build tsconfig.test.json && node out/test/integration/runTest.js`
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

    /** Write batch file and spawnSync gpg --batch --gen-key. */
    generateKey(name: string, email: string): void;
    /** spawnSync gpg --batch --yes --delete-secret-and-public-key <fingerprint>. */
    deleteKey(fingerprint: string): void;
    /** Parse gpg --with-colons --fingerprint <email> output; return fingerprint string. */
    getFingerprint(email: string): string;
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

### Open Questions (Deferred)

2. **Phase 3 keys** *(deferred until after Phase 1 is successfully implemented)*: Do you have a
   GPG key on the Windows keyring that can be exported into the container for sign/encrypt tests,
   or should the plan create a fresh key inside the container and re-import it to the Windows
   keyring as part of test setup?

---

## Phase 1 — `agent-proxy` ↔ Real gpg-agent

**Constraint:** Runs on Windows host only. `agent-proxy` is a Windows-only extension.

**Location:** `agent-proxy/test/integration/agentProxyIntegration.test.ts`

**New npm script** in `agent-proxy/package.json`:
```json
"test:integration": "tsc --build tsconfig.test.json && node out/test/integration/runTest.js"
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
  cli.writeAgentConf(['disable-scdaemon', 'disable-ssh-support',
                      'disable-win32-openssh-support', 'disable-putty-support'])
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
   - Response contains `S VERSION` line
   - Response ends with `OK`

3. **KEYINFO --list**
   - `vscode.commands.executeCommand('_gpg-agent-proxy.sendCommands', sessionId, 'KEYINFO --list\n')` resolves
   - Response contains one or more `S KEYINFO` lines
   - Response ends with `OK`

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

   Real-world command sequence observed from gpg-agent log (gpg-agent 2.4.8, Ed25519 key):
   ```
   → OPTION allow-pinentry-notify
   ← OK
   → OPTION agent-awareness=2.1.0
   ← OK
   → RESET
   ← OK
   → SIGKEY <fingerprint>
   ← OK
   → SETKEYDESC <url-encoded description>
   ← OK
   → SETHASH 10 <sha512-hex>        ← algo ID 10 = SHA-512 (libgcrypt GCRY_MD_SHA512)
   ← OK
   → PKSIGN
   ← [with passphrase key]: INQUIRE PINENTRY_LAUNCHED <pid> <info...>
      → END                          ← client ACKs pinentry notification with no data
      ← D <binary signature bytes>
      ← OK
   ← [with no-passphrase key]: D <binary signature bytes>  ← INQUIRE skipped entirely
      ← OK
   ```

   **Critical notes:**
   - `SETHASH` uses a numeric libgcrypt algorithm ID, not a name string. `10` = SHA-512.
   - The `INQUIRE PINENTRY_LAUNCHED` is a **pinentry notification**, not a data request. The
     client replies with `END` only (no `D` lines). With a no-passphrase key, this INQUIRE
     does **not** appear — `PKSIGN` returns the signature directly.
   - The hash sent in `SETHASH` is uppercase hex of a SHA-512 digest.

   **Test steps (using no-passphrase test key — no INQUIRE expected):**
   1. `connectAgent` command → sessionId
   2. `sendCommands(sessionId, 'OPTION allow-pinentry-notify\n')` → `OK`
   3. `sendCommands(sessionId, 'OPTION agent-awareness=2.1.0\n')` → `OK`
   4. `sendCommands(sessionId, 'RESET\n')` → `OK`
   5. `sendCommands(sessionId, 'SIGKEY <fingerprint>\n')` → `OK`
   6. `sendCommands(sessionId, 'SETKEYDESC Test+key\n')` → `OK`
   7. Compute SHA-512 of `Buffer.from('test data')` using Node `crypto.createHash('sha512')`; hex-encode uppercase
   8. `sendCommands(sessionId, 'SETHASH 10 <sha512hex>\n')` → `OK`
   9. `sendCommands(sessionId, 'PKSIGN\n')` → response contains `D <...>` and ends with `OK` (no INQUIRE with no-passphrase key)

   **Separate test (verify INQUIRE PINENTRY_LAUNCHED handling — requires a passphrase-protected key or mock):**
   - This INQUIRE is a notification not a data request; client must reply `END\n` with no D-lines
   - Since the no-passphrase test key skips this, cover this path via a mock in unit tests rather than integration tests

8. **Session isolation after error**
   - Force `sendCommands` with an unknown/invalid session ID → rejects
   - Verify a valid session opened before the error still sends commands correctly

9. **Gpg4win not found or socket not found → start fails with clear error**
   - Set VS Code workspace setting `gpgAgentProxy.gpg4winPath` to a nonexistent path
   - Call `vscode.commands.executeCommand('gpg-agent-proxy.stop')` to reset state
   - Call `vscode.commands.executeCommand('gpg-agent-proxy.start')` → rejects
   - Confirm error message contains a meaningful description (not silent failure)
   - Restore `gpg4winPath` setting to default; call `gpg-agent-proxy.start` to recover

---

## Phase 2 — `request-proxy` → `agent-proxy` → Real gpg-agent

**Constraint:** `request-proxy` is a remote-only extension (WSL/container/SSH). Phase 2 runs inside
a **dedicated dev container** (Ubuntu 22.04, no `gpg` installed, no `GNUPGHOME`). The tests call
VS Code commands (`_gpg-agent-proxy.*`) directly — no `gpg` CLI is invoked from the container.

Phase 2 involves **two extension hosts running simultaneously**:
- **Windows local extension host** — runs `agent-proxy`; needs the same isolated gpg-agent setup
  as Phase 1 (unique `GNUPGHOME`, `gpg-agent.conf`, `cli.launchAgent()`). The exact mechanism
  for triggering this Windows-side setup from a container context is deferred until after
  Phase 1 is implemented and the pattern is understood.
- **Container remote extension host** — runs `request-proxy`; no `gpg`, no `GNUPGHOME`.

`agent-proxy` runs on the **Windows host only**; the container has no gpg keyring.

**Location:** `request-proxy/test/integration/requestProxyIntegration.test.ts`

**New npm script** in `request-proxy/package.json`:
```json
"test:integration": "tsc --build tsconfig.test.json && node out/test/integration/runTest.js"
```

### Dev Container Setup

Create `.devcontainer/phase2/devcontainer.json`:

```json
{
  "name": "gpg-windows-relay phase 2 integration tests",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu-22.04",
  "postCreateCommand": "code --install-extension ${containerWorkspaceFolder}/pack/request-proxy.vsix"
}
```

- `request-proxy.vsix` must be built via `npm run package` before opening the container
- No `gpg` installed — Phase 2 tests call VS Code commands directly, not `gpg` CLI
- No `GNUPGHOME` — container has no gpg keyring; all keys live on Windows
- `agent-proxy` is installed on the **Windows local extension host** automatically by VS Code
  Remote (it has `extensionKind: ["ui"]`); do not install it in the container

### Setup / Teardown

```
[Windows local extension host — setup deferred until after Phase 1]
  Needs same isolated gpg-agent + test key setup as Phase 1.
  Exact mechanism (runTest.ts coordination, workspace config, or other) TBD.

[Container — before()]
  - instance = await startRequestProxy(config, {
        commandExecutor: new VSCodeCommandExecutor(),   // real agent-proxy VS Code commands
        getSocketPath: async () => '/tmp/gpg-relay-test.sock'
    })
  - fingerprint = obtained from Windows side (mechanism TBD after Phase 1)

[Container — after()]
  - await instance.stop()
  - Windows-side teardown (key delete, agent kill) — mechanism TBD
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

**Constraint:** `request-proxy` must run in a remote environment. Phase 3 runs inside a **dev
container** where `request-proxy` extension is active remotely and `agent-proxy` is active on the
Windows host.

**Location:** `request-proxy/test/integration/gpgCliIntegration.test.ts`

### Dev Container Setup

Create `.devcontainer/phase3/devcontainer.json`:

```json
{
  "name": "gpg-windows-relay phase 3 integration tests",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu-22.04",
  "postCreateCommand": "sudo apt-get update && sudo apt-get install -y gnupg2 && code --install-extension ${containerWorkspaceFolder}/pack/request-proxy.vsix",
  "remoteEnv": {
    "GNUPGHOME": "/tmp/gpg-test"
  }
}
```

Additional container configuration:
- `request-proxy.vsix` must be built via `npm run package` before opening the container
- `GNUPGHOME=/tmp/gpg-test` (isolated from any host keyring; no Linux gpg-agent runs — the
  container's `gpg` uses the Unix socket provided by `request-proxy` as its agent socket)
- `agent-proxy` is installed on the **Windows local extension host** automatically by VS Code
  Remote (it has `extensionKind: ["ui"]`); do not install it in the container
- Test key setup: generate a no-passphrase key on **Windows** (private + public key in Windows gpg-agent
  GNUPGHOME); export only the **public key** from Windows and import it into the container's `GNUPGHOME`.
  The container must never hold private keys — it only holds public keys to address key operations by fingerprint.

### Setup / Teardown

```
before()
  - Ensure GNUPGHOME exists and has correct permissions
  - Generate throwaway no-passphrase test key on **Windows** (private + public key in Windows gpg-agent GNUPGHOME)
  - Export only the **public key** from Windows; import it into the container's GNUPGHOME
  - Wait for request-proxy + agent-proxy to be active (poll isRunning())
  - Prepare test payload: Buffer.from('integration test payload')

after()
  - Delete test key from Windows gpg-agent GNUPGHOME
  - Delete public key from container GNUPGHOME
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

6. **Large file sign** (stress-tests D-block buffering)
   - Generate 1 MB test file
   - Sign it via `gpg --sign`
   - Verify signature: exit code 0

---

## Running the Tests

### Phase 1 (Windows only)
```powershell
# 1. Build and package both extensions
npm run package
# 2. Run integration tests
cd agent-proxy
npm run test:integration
# runTest.js: mkdtempSync unique dir, launches isolated gpg-agent,
# generates test key, starts extension host with GNUPGHOME set, runs tests, cleans up
```

### Phase 2 (inside `.devcontainer/phase2`)
```powershell
# 1. Build and package both extensions (on Windows, before opening container)
npm run package
```
1. Reopen workspace in VS Code using **Dev Containers: Reopen in Container** → select `phase2`
2. `postCreateCommand` installs `request-proxy.vsix`; `agent-proxy` loads in the Windows local extension host automatically
3. Open a terminal inside the container:
```bash
cd request-proxy
npm run test:integration
```

### Phase 3 (inside `.devcontainer/phase3`)
```powershell
# 1. Build and package both extensions (on Windows, before opening container)
npm run package
```
1. Reopen workspace in VS Code using **Dev Containers: Reopen in Container** → select `phase3`
2. `postCreateCommand` installs `gnupg2` and `request-proxy.vsix`; `agent-proxy` loads in the Windows local extension host automatically
3. Open a terminal inside the container:
```bash
cd request-proxy
npm run test:integration:phase3
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
| Phase 2 runs in dev container only | `request-proxy` is a remote-only extension; running it on Windows directly would violate its design constraint |
| Phases 2 and 3 each have two extension hosts | VS Code Remote architecture: `agent-proxy` (`extensionKind: ["ui"]`) runs in the Windows local host; `request-proxy` (`extensionKind: ["workspace"]`) runs in the container remote host; Windows-side isolated agent setup for Phase 2 is deferred until after Phase 1 |
| Phase 3 uses dev container (Ubuntu 22.04 LTS) | `request-proxy` is designed for remote environments; container provides clean isolated environment |
| Phase 3 test key: private on Windows, only public in container | Container `GNUPGHOME` must hold the public key so `gpg` can address it by fingerprint; private key stays on Windows so signing flows through agent-proxy to the real gpg-agent |
| Extensions packaged to `.vsix` before integration tests | Tests use real packaged extensions, not raw source; catches packaging issues early; devcontainers install from pre-built `.vsix` via `postCreateCommand` |
| `GpgCli` consolidates all `gpg`/`gpgconf` subprocess calls | Single place for binary path resolution, `GNUPGHOME` env injection, temp file creation, and error handling; no scattered `spawnSync` calls across test files |
| `GpgCli` reads `GNUPGHOME` from `process.env`; `runTest.ts` sets it before first use | Eliminates ambiguous constructor param; `process.env.GNUPGHOME = GNUPGHOME` in `runTest.ts` is idiomatic for a runner script; same `new GpgCli()` call works in runner, extension host, and container |
| `gpgTestEnvironment.ts` eliminated; logic inlined into `runTest.ts` | After `GpgCli` absorbed all subprocess and conf-file logic the remaining wrapper was two lines; inlining it allows a single `GpgCli` instance to be shared across `writeAgentConf`, `launchAgent`, and `killAgent` within the same try/finally |
| `test:integration` separate from `test` | Keeps integration tests out of normal `npm test` runs; avoids slow I/O in CI unit-test runs |
| `tsconfig.test.json` extends base tsconfig | Base `tsconfig.json` stays `rootDir: src`; test config widens rootDir to `.` and adds `test/integration/**` without touching production compile |
| `./test/integration` export in `shared/package.json` | Mirrors existing `./test` pattern; enables `@gpg-relay/shared/test/integration` imports without duplicating files |
