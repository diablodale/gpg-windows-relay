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
      agentProxyIntegration.test.ts
request-proxy/
  test/
    integration/
      requestProxyIntegration.test.ts
      gpgCliIntegration.test.ts        ← Phase 3 only (runs in dev container)
shared/
  test/
    integration/
      gpgTestKeys.ts                   ← key management helper (used by all phases)
```

### Test Runner

Same stack as unit tests: `@vscode/test-cli` + `@vscode/test-electron` (Mocha + Chai inside VS Code
Electron). Each extension gets a separate `test:integration` npm script and a dedicated
`.vscode-test-integration.mjs` config so integration tests do **not** run incidentally with
`npm test`. The existing unit-test `src/test/suite/index.ts` runner is not reused for integration.

### Build Infrastructure

Both `agent-proxy/tsconfig.json` and `shared/tsconfig.json` have `rootDir: src` and only compile
`src/**`. Files under `test/integration/` need a separate compile step:

- Each package that has integration tests gets a **`tsconfig.test.json`** that:
  - `extends` the base `tsconfig.json`
  - sets `rootDir` to `.` (the package root)
  - adds `"test/integration/**"` to `include`
  - sets `outDir` to `out` (same output tree, so `out/test/integration/*.js` lands correctly)
- The `test:integration` npm script runs `tsc --build tsconfig.test.json && vscode-test --config ...`
- Affected packages: `agent-proxy`, `shared`

### Shared Package Export

`shared/package.json` already exports `"."` and `"./test"`. A third export is needed:

```json
"./test/integration": {
  "types": "./out/test/integration/gpgTestKeys.d.ts",
  "default": "./out/test/integration/gpgTestKeys.js"
}
```

Integration tests in `agent-proxy` and `request-proxy` then import via
`@gpg-relay/shared/test/integration`.

### Key Management Helper

A shared helper (`shared/test/integration/gpgTestKeys.ts`) used by all phases:

- `generateTestKey(name, email)` — `spawnSync('gpg', ['--batch', '--gen-key', ...])` with
  `%no-protection` (no passphrase, enables fully automated tests without a TTY/pinentry)
- `deleteTestKey(fingerprint)` — `spawnSync('gpg', ['--batch', '--yes', '--delete-secret-and-public-key', fingerprint])`
- `getKeyFingerprint(email)` — parse output of `gpg --with-colons --fingerprint <email>`

Called in `before()` / `after()` at suite level.

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
"test:integration": "vscode-test --config .vscode-test-integration.mjs"
```
pointing `@vscode/test-cli` at `test/integration/`.

### Setup / Teardown

```
before()
  - Create AgentProxy with real deps (no mocks):
      - real net.createConnection
      - real fs.readFileSync
    AgentProxy.connectAgent() internally calls gpgconf.exe to discover the extra socket path.
  - Generate throwaway test key (no passphrase); store fingerprint

after()
  - Delete test key
```

### Test Cases

1. **Connect / greeting**
   - `connectAgent()` resolves with `{ sessionId, greeting }`
   - `greeting` starts with `OK`
   - `sessionId` is a non-empty string

2. **GETINFO version**
   - `sendCommands(sessionId, 'GETINFO version\n')` resolves
   - Response contains `S VERSION` line
   - Response ends with `OK`

3. **KEYINFO --list**
   - `sendCommands(sessionId, 'KEYINFO --list\n')` resolves
   - Response contains one or more `S KEYINFO` lines
   - Response ends with `OK`

4. **Unknown command → ERR**
   - `sendCommands(sessionId, 'NOTACOMMAND\n')` resolves (does not reject)
   - Response starts with `ERR`

5. **BYE / disconnectAgent**
   - `disconnectAgent(sessionId)` resolves without throwing
   - Subsequent `sendCommands(sessionId, ...)` rejects

6. **Multiple concurrent sessions**
   - Open 3 sessions via `connectAgent()` simultaneously
   - Each receives an independent `sessionId` and an `OK` greeting
   - Close all 3 cleanly via `disconnectAgent()`

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
   1. `connectAgent()` → sessionId
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

9. **Stale / unreachable socket file**
   - Inject `MockFileSystem` with a socket file pointing at a non-existent TCP port
   - `connectAgent()` rejects with a meaningful error message (not a silent hang)

---

## Phase 2 — `request-proxy` → `agent-proxy` → Real gpg-agent

**Constraint:** `request-proxy` is a remote-only extension (WSL/container/SSH). Phase 2 runs inside
the same **dev container** as Phase 3 (see Phase 3 for container setup). The tests instantiate
`startRequestProxy` directly with a real `VSCodeCommandExecutor` (which dispatches real VS Code
commands to `agent-proxy` on the Windows host) and real server/filesystem deps, but override
`getSocketPath` to a known temp path inside the container.

**Location:** `request-proxy/test/integration/requestProxyIntegration.test.ts`

**New npm script** in `request-proxy/package.json`:
```json
"test:integration": "vscode-test --config .vscode-test-integration.mjs"
```

### Setup / Teardown

```
before()
  - Generate throwaway test key; store fingerprint
  - instance = await startRequestProxy(config, {
        commandExecutor: new VSCodeCommandExecutor(),   // real agent-proxy VS Code commands
        getSocketPath: async () => '/tmp/gpg-relay-test.sock'
    })

after()
  - await instance.stop()
  - Delete test key
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

Create `.devcontainer/devcontainer.json`:

```json
{
  "name": "gpg-windows-relay integration tests",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu-22.04",
  "postCreateCommand": "sudo apt-get update && sudo apt-get install -y gnupg2",
  "remoteEnv": {
    "GNUPGHOME": "/tmp/gpg-test"
  },
  "customizations": {
    "vscode": {
      "extensions": [
        "local:agent-proxy",
        "local:request-proxy"
      ]
    }
  }
}
```

Additional container configuration:
- `GNUPGHOME=/tmp/gpg-test` (isolated from any host keyring)
- `gpg-agent.conf` in `GNUPGHOME`: disable pinentry (`pinentry-program /usr/bin/pinentry-curses`
  or `allow-loopback-pinentry`) for non-interactive batch operation
- Test key setup: generate a no-passphrase key inside the container; export+import its public key
  to the Windows keyring so the agent knows the key

### Setup / Teardown

```
before()
  - Ensure GNUPGHOME exists and has correct permissions
  - Generate throwaway test key inside container (no passphrase)
  - Export public key from container; import to Windows keyring via gpg.exe
  - Wait for request-proxy + agent-proxy to be active (poll isRunning())
  - Prepare test payload: Buffer.from('integration test payload')

after()
  - Delete test key from container keyring
  - Delete test key from Windows keyring
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
cd agent-proxy
npm run test:integration
```

### Phases 2 and 3 (inside dev container)
1. Open workspace in VS Code with Remote - Containers
2. Wait for both extensions to activate (`agent-proxy` on Windows host, `request-proxy` in container)
3. Open a terminal inside the container:
```bash
# Phase 2
cd request-proxy
npm run test:integration

# Phase 3
cd request-proxy
npm run test:integration:phase3
```

## Decisions

| Decision | Rationale |
|---|---|
| No passphrase on test keys | Eliminates pinentry interaction, enables fully automated non-interactive tests |
| `test:integration` separate from `test` | Avoids running heavy I/O tests incidentally during normal unit test runs |
| `gpgconf.exe` not called directly in tests | `AgentProxy.connectAgent()` discovers the extra socket internally; tests have no need to call `gpgconf.exe` separately |
| Phase 2 runs in dev container only | `request-proxy` is a remote-only extension; running it on Windows directly would violate its design constraint |
| Phase 3 uses dev container (Ubuntu 22.04 LTS) | `request-proxy` is designed for remote environments; container provides clean isolated environment |
| Phase 3 test key created inside container | Container `GNUPGHOME` is isolated from Windows keyring; keys must be explicitly exchanged |
| Separate `.vscode-test-integration.mjs` per extension | Keeps integration tests out of `npm test`; avoids slow I/O in normal CI unit-test runs |
| `tsconfig.test.json` extends base tsconfig | Base `tsconfig.json` stays `rootDir: src`; test config widens rootDir to `.` and adds `test/integration/**` without touching production compile |
| `./test/integration` export in `shared/package.json` | Mirrors existing `./test` pattern; enables `@gpg-relay/shared/test/integration` imports without duplicating files |
