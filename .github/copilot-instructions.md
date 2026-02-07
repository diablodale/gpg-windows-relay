# Project Guidelines

This workspace contains two cooperating VS Code extensions written in TypeScript:

- `agent-proxy` — manages authenticated connections to a local GPG agent (Windows: TCP via socket file nonce).
- `request-proxy` — provides a local Unix socket server that forwards Assuan protocol requests to `agent-proxy`.

## Code Style

- Language: TypeScript. Configuration is in `tsconfig.json`.
- Linting / formatting: follow existing patterns in `eslint.config.mjs` and existing code (no extra formatting rules enforced here).
- Logging: use the module-level `log(config, message)` helper pattern (see `agent-proxy/src/services/agentProxy.ts` and `request-proxy/src/services/requestProxy.ts`). Do not log raw binary data.

## Architecture

- Two small extensions communicate over VS Code commands: `_gpg-agent-proxy.connectAgent`, `_gpg-agent-proxy.sendCommands`, and `_gpg-agent-proxy.disconnectAgent` (see `agent-proxy/src/extension.ts`).
- `request-proxy` listens on the local GPG Unix socket and acts as a bridge between the calling GPG process and `agent-proxy`.
- `agent-proxy` handles the Assuan/GPG protocol specifics, including nonce authentication and session lifecycle.

Key files:

- [agent-proxy/src/services/agentProxy.ts](../agent-proxy/src/services/agentProxy.ts)
- [agent-proxy/src/extension.ts](../agent-proxy/src/extension.ts)
- [request-proxy/src/services/requestProxy.ts](../request-proxy/src/services/requestProxy.ts)
- [request-proxy/src/extension.ts](../request-proxy/src/extension.ts)

## Build and Test

Recommended commands (run from repository root):

```bash
# Install dependencies for both extensions:
npm install
# Build both extensions:
npm run build
# Development watch (extension build):
npm run watch
# Create a packaged extension (.vsix)
npm run package
```

If you add tests, follow the project structure and update `package.json` scripts so CI can run them.

## Project Conventions (explicit)

- Binary / protocol data: All socket I/O preserves raw bytes using `latin1` encoding inside the proxy code. When logging, never print raw `latin1` content — use the provided sanitizers.
  - See `sanitizeForLog()` usage in both `agent-proxy` and `request-proxy` to display first command token plus remaining byte count.
- Logging pattern: prefer module-level `log(config, message)` and pass the `AgentProxyConfig` / `RequestProxyConfig` callbacks rather than calling `console.log` directly.
- Session lifecycle: `agent-proxy` stores sessions in a `Map` keyed by UUID; session cleanup is driven by socket `'close'` handlers. Prefer `socket.destroy()` to force cleanup on unrecoverable errors.
- Status UI: `agent-proxy` exposes a `statusBarCallback` and sets `probeSuccessful` after a successful probe — update the status bar only when both the service exists and the probe succeeded (see `agent-proxy/src/extension.ts`).
- Error handling: async functions should rethrow after local cleanup if the caller expects rejection (e.g., `connectToAgent` should `throw` after destroying client socket so the caller can react).

## Integration Points

- GPG agent: uses Assuan protocol via a socket file (Windows uses a socket file containing host/port + nonce). The code parses the socket file and authenticates by sending the nonce.
- Cross-extension calls: `request-proxy` and `agent-proxy` communicate using `vscode.commands.executeCommand(...)` — keep argument shapes stable.

## Security

- Use the [GPG agent Assuan protocol](https://www.gnupg.org/documentation/manuals/gnupg/Agent-Protocol.html)
  which is also documented briefly in [gpg-agent-protocol.md](../docs/gpg-agent-protocol.md) and shown in the sequence diagram in [state-diagram.md](../docs/state-diagram.md).
- Use the "extra" gpg-agent socket. The extra socket (usually named `S.gpg-agent.extra`) is designed for remote use.
  It has restricted access and requires nonce authentication. It provides access to only a limited set of cryptographic operations.
  None of these operations transmit secrets. All sensitive operations (e.g., signing, decryption) happen inside the GPG agent process
  and are never transmitted over either of these vscode extensions. These proxy extensions must only relay commands and responses
  of public information and hashs, and never have access to raw secrets or private keys.
- Do not expose raw binary content or sensitive/secrets in logs. Use `sanitizeForLog()` (first token + byte-count) for all protocol logging.
- Filesystem access: The extension reads the GPG socket file and must validate its contents (port and 16-byte nonce). Keep these checks strict.

## When Editing

- Reference the four key files above when changing protocol behavior.
- Run `npm run watch` during development and `npm run package` to validate packaging.
- If you change public command names or payload formats, update both extensions and add a migration note in this file.

---

If anything here is unclear or you want more detail (e.g., line-level examples or additional commands), tell me which section and I'll update this file.
