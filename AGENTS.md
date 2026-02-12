# Project Guidelines

This workspace contains two cooperating VS Code extensions written in TypeScript:

- `agent-proxy` — manages authenticated connections to a local GPG agent (Windows: TCP via socket file nonce).
- `request-proxy` — provides a local Unix socket server that forwards Assuan protocol requests to `agent-proxy`.

## Code Style

- Language: TypeScript. Configuration is in `tsconfig.json`.
- Linting / formatting: follow existing patterns in `eslint.config.mjs` and existing code (no extra formatting rules enforced here).
- Logging: use the module-level `log(config, message)` helper pattern (see `agent-proxy/src/services/agentProxy.ts` and `request-proxy/src/services/requestProxy.ts`). Do not log raw binary data.

## Source Control

- Use Git for all version control operations.
- All commits must be GPG signed. This should be automatic due to .gitconfig settings. If you receive an error
  about this automatic GPG signing, then inform the user and stop the commit so they can fix their GPG configuration.
- Commit changes as logically complete units of work (e.g., a new feature, a bug fix, or a refactor).
- Follow the *Conventional Commits v1* specification for commit messages
  (e.g., `feat: add proxy command`, `fix: handle socket errors`, `docs: update architecture docs`).
- **VERY IMPORTANT** When working from a todo list or plan:
  1. Complete an item or phase of work.
  2. Update the todo/plan to reflect the change.
  3. Then commit all work, including todo/plan/docs, to Git.
     This keeps the commit history aligned with the plan and makes the evolution of the project easier to understand.
  4. Only after committing to git, can you proceed to the next phase of work.

## Regular Checkpoints

When a logically complete units of work or significant change is made, follow this process:

1. Ensure all changes are complete and tested locally.
2. Update documentation, plans, todo lists, and architecture diagrams to reflect the change.
3. Ask me if I am ready for a commit and provide a summary of the changes and any relevant context.
4. Commit all changes together using the above [source control](#source-control) guidelines.

## Architecture

- Two small extensions communicate over VS Code commands: `_gpg-agent-proxy.connectAgent`, `_gpg-agent-proxy.sendCommands`, and `_gpg-agent-proxy.disconnectAgent` (see `agent-proxy/src/extension.ts`).
- `request-proxy` listens on the local GPG Unix socket and acts as a bridge between the calling GPG process and `agent-proxy`.
- `agent-proxy` handles the Assuan/GPG protocol specifics, including nonce authentication and session lifecycle.
- Shared code is packaged as `@gpg-relay/shared` npm package (`file:../shared` dependency) for clean imports and testability.
  Import this with `from '@gpg-relay/shared'` or `from '@gpg-relay/shared/test'`.

Key files:

- [agent-proxy/src/services/agentProxy.ts](../agent-proxy/src/services/agentProxy.ts)
- [agent-proxy/src/extension.ts](../agent-proxy/src/extension.ts)
- [request-proxy/src/services/requestProxy.ts](../request-proxy/src/services/requestProxy.ts)
- [request-proxy/src/extension.ts](../request-proxy/src/extension.ts)
- [shared/src/protocol.ts](../shared/src/protocol.ts) (shared utilities for Assuan/GPG protocol, latin1 encoding, error handling, command extraction)
- [shared/src/types.ts](../shared/src/types.ts) (shared types for logging, sanitization, dependency injection)
- [shared/src/test/helpers.ts](../shared/src/test/helpers.ts) (shared mock implementations for testing with dependency injection)

## Testing

Run `npm test` or `npm run test:watch`. Framework: Mocha (BDD) + Chai (expect). When adding tests:
* write unit tests for pure functions in `shared/src/test/`
* integration tests in `<extension>/src/test/`
* use mocks from `@gpg-relay/shared/test` for socket/file/command interactions
* target >70% coverage via dependency injection

## Dependency Injection

Both services support optional dependency injection via `*Deps` interfaces. AgentProxy accepts socketFactory and fileSystem. RequestProxy accepts commandExecutor, serverFactory, fileSystem, and getSocketPath. Pass mocks via optional deps parameter to test without VS Code runtime or real sockets. Enables isolated testing, systematic error scenarios, and deterministic execution. Example:

```typescript
wait startRequestProxy(config, {
    commandExecutor: new MockCommandExecutor(),
    serverFactory: new MockServerFactory(),
    fileSystem: new MockFileSystem(),
    getSocketPath: async () => '/tmp/test-gpg-agent'
});
```

## Build & Packaging

Use Powershell on Windows hosts. Use bash on Linux/macOS hosts. From repository root:

- **`npm install`** — installs root dependencies and auto-runs postinstall hooks to install subfolders
- **`npm run compile`** — builds in dependency order: shared → agent-proxy → request-proxy
- **`npm run watch`** — runs watch mode in all folders simultaneously (rebuilds on file change)
- **`npm run package`** — creates packaged extension (.vsix files)

Each extension compiles to its own `out/` folder via TypeScript, and shared code is packaged as `@gpg-relay/shared` npm module imported with `file:../shared` dependencies.

## Project Conventions

- **Protocol**: Use `latin1` encoding for socket I/O (preserves raw bytes). Never log raw binary; use `sanitizeForLog()` (first token + byte count).
- **Logging**: Use module-level `log(config, message)` with config callbacks, not `console.log`.
- **Sessions**: Stored in `Map` keyed by UUID; cleanup via socket 'close' handlers. Use `socket.destroy()` for unrecoverable errors.
- **Error handling**: Async functions rethrow after local cleanup if caller expects rejection.

## Integration Points

- GPG agent: uses Assuan protocol via a socket file (Windows uses a socket file containing host/port + nonce). The code parses the socket file and authenticates by sending the nonce.
- Cross-extension calls: `request-proxy` and `agent-proxy` communicate using `vscode.commands.executeCommand(...)` — keep argument shapes stable.

## Security

- Uses [GPG agent Assuan protocol](https://www.gnupg.org/documentation/manuals/gnupg/Agent-Protocol.html) via "extra" gpg-agent socket (S.gpg-agent.extra) with nonce authentication. See [gpg-agent-protocol.md](../docs/gpg-agent-protocol.md).
- Extensions only relay commands/responses of public data—no secrets or private keys are transmitted. All sensitive operations stay in GPG agent process.
- Never log raw binary content. Use `sanitizeForLog()` for protocol logging.
- Validate socket file contents strictly (port + 16-byte nonce).

## When Editing

**Code**: Reference key files in Architecture section. Run `npm run compile` to build, `npm run watch` during development, `npm run package` to validate packaging. Update both extensions if changing public commands.

**Shared code**: Add utilities to `shared/src/` (pure functions in protocol.ts, types in types.ts), re-export from index.ts, import via `@gpg-relay/shared`.

**Testing**: Write unit tests in shared/src/test/ for pure functions, integration tests in <extension>/src/test/ for services. Add `*Deps` interfaces for DI with pattern `constructor(config: Config, deps?: Partial<Deps>)`. Run `npm test` before committing. Target >70% coverage.

---

If anything here is unclear or you want more detail (e.g., line-level examples or additional commands), tell me which section and I'll update this file.
