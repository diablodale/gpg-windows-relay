# Project Guidelines

This workspace contains two cooperating VS Code extensions written in TypeScript:

- `gpg-bridge-agent` — manages authenticated connections to a local GPG agent (Windows: TCP via socket file nonce).
- `gpg-bridge-request` — provides a local Unix socket server that forwards Assuan protocol requests to `gpg-bridge-agent`.

## Code Style

- Language: TypeScript. Configuration is in `tsconfig.json`.
- Linting / formatting: follow existing patterns in `eslint.config.mjs` and existing code (no extra formatting rules enforced here).
- Logging: use the module-level `log(config, message)` helper pattern (see `gpg-bridge-agent/src/services/agentProxy.ts` and `gpg-bridge-request/src/services/requestProxy.ts`). Do not log raw binary data.

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

- Two small extensions communicate over VS Code commands: `_gpg-bridge-agent.connectAgent`, `_gpg-bridge-agent.sendCommands`, and `_gpg-bridge-agent.disconnectAgent` (see `gpg-bridge-agent/src/extension.ts`).
- `gpg-bridge-request` listens on the local GPG Unix socket and acts as a bridge between the calling GPG process and `gpg-bridge-agent`.
- `gpg-bridge-agent` handles the Assuan/GPG protocol specifics, including nonce authentication and session lifecycle.
- Shared code is packaged as `@gpg-bridge/shared` npm package (`file:../shared` dependency) for clean imports and testability.
  Import this with `from '@gpg-bridge/shared'` or `from '@gpg-bridge/shared/test'`.

Key files:

- [gpg-bridge-agent/src/services/agentProxy.ts](../gpg-bridge-agent/src/services/agentProxy.ts)
- [gpg-bridge-agent/src/extension.ts](../gpg-bridge-agent/src/extension.ts)
- [gpg-bridge-request/src/services/requestProxy.ts](../gpg-bridge-request/src/services/requestProxy.ts)
- [gpg-bridge-request/src/extension.ts](../gpg-bridge-request/src/extension.ts)
- [shared/src/protocol.ts](../shared/src/protocol.ts) (shared utilities for Assuan/GPG protocol, latin1 encoding, error handling, command extraction)
- [shared/src/types.ts](../shared/src/types.ts) (shared types for logging, sanitization, dependency injection)
- [shared/src/test/helpers.ts](../shared/src/test/helpers.ts) (shared mock implementations for testing with dependency injection)

### State Machine Architecture

Both extensions use **EventEmitter-based state machines** with explicit state tracking and transition validation:

**Type Pattern:**
```typescript
// States: string literal union
type SessionState = 'DISCONNECTED' | 'READY' | 'SENDING_TO_AGENT' | /* ... */;

// Events: string literal union (NOT discriminated union)
type StateEvent = 'CLIENT_CONNECT_REQUESTED' | 'WRITE_OK' | /* ... */;

// Event payloads: documentation interface (EventEmitter cannot enforce at runtime)
export interface EventPayloads {
    CLIENT_CONNECT_REQUESTED: { port: number; nonce: Buffer };
    WRITE_OK: undefined;
    // ... rest of events
}

// Transition table: strongly typed, compile-time validated
type StateTransitionTable = {
    [K in SessionState]: {
        [E in StateEvent]?: SessionState;
    };
};

const STATE_TRANSITIONS: StateTransitionTable = {
    DISCONNECTED: {
        CLIENT_CONNECT_REQUESTED: 'CONNECTING_TO_AGENT'
    },
    // ... rest of transitions
};
```

**Why This Pattern:**

1. **EventEmitter uses string events, not objects**: Event emission is `emit('EVENT_NAME', payload)`, not `emit({ type: 'EVENT_NAME', ...payload })`
2. **String literal unions provide type safety**: TypeScript validates event names at compile time
3. **StateHandler types cannot be enforced**: Vanilla EventEmitter's `.on()` signature is `(...args: any[]) => void` — no way to type-check handler signatures without third-party packages like `typed-emitter`
4. **EventPayloads is documentation only**: Serves as reference for what payload each event expects, but EventEmitter doesn't enforce it at runtime
5. **STATE_TRANSITIONS provides runtime validation**: Used by `transition()` method to validate state changes and catch invalid transitions

**Discriminated Unions Don't Work Here:**

Discriminated unions (e.g., `type Event = { type: 'A' } | { type: 'B' }`) are incompatible with EventEmitter's string-based pattern. Both extensions previously had unused discriminated union definitions that were removed as dead code during Phase 3.1 refactoring.

**Event Emission Pattern:**
```typescript
// Correct EventEmitter pattern
session.emit('WRITE_OK');                                       // No payload
session.emit('AGENT_RESPONSE_COMPLETE', 'OK Pleased to meet you\n'); // With payload
session.on('WRITE_OK', () => { /* handler */ });
session.on('AGENT_RESPONSE_COMPLETE', (response) => { /* handler */ });
```

Note: agent greeting is not a special-cased event. `connectAgent()` returns a greeting string
which is emitted as `AGENT_RESPONSE_COMPLETE` and flows through the normal response path.

**State Transition Validation:**

The `transition()` method validates all state changes against the STATE_TRANSITIONS table:

```typescript
// Runtime validation using STATE_TRANSITIONS table
private transition(event: StateEvent): void {
    const allowedTransitions = STATE_TRANSITIONS[this.state];
    const nextState = allowedTransitions?.[event];
    
    if (!nextState) {
        throw new Error(`Invalid transition: ${this.state} + ${event}`);
    }
    
    const oldState = this.state;
    this.state = nextState;
    log(this.config, `[${this.sessionId}] ${oldState} → ${nextState} (event: ${event})`);
}
```

**Socket Close Handling:**

Both extensions handle spontaneous socket closures through the state machine using the CLEANUP_REQUESTED event:

```typescript
// Socket 'close' handler (can fire in ANY socket-having state)
socket.on('close', (hadError: boolean) => {
    if (hadError) {
        // Transmission error → ERROR → CLEANUP_REQUESTED
        session.emit('ERROR_OCCURRED', 'Socket closed with transmission error');
    } else {
        // Clean close → CLEANUP_REQUESTED directly
        session.emit('CLEANUP_REQUESTED', hadError);
    }
});
```

All socket-having states include `CLEANUP_REQUESTED: 'CLOSING'` transitions in STATE_TRANSITIONS, ensuring validated cleanup regardless of when the socket closes. The hadError boolean payload distinguishes error cleanups (true) from graceful cleanups (false).

**Key principles:**

- **STATE_TRANSITIONS is the single source of truth**: All valid state transitions are defined in this table
- **Fail-fast on invalid transitions**: Attempting an undefined transition throws an error immediately, preventing invalid state
- **Event handlers use transition()**: All state changes go through `transition()` for consistent validation
- **Inline state update**: State change and logging are inlined for clarity (no separate setState method)

This pattern provides:
- Compile-time type safety via TypeScript
- Runtime transition validation via STATE_TRANSITIONS
- Clear event logging with event names in state transitions
- Single source of truth for valid state machine transitions
- Fail-fast error detection for invalid state changes

## Testing

Run `npm test` or `npm run test:watch`. Framework: Mocha (BDD) + Chai (expect). When adding tests:
* write unit tests for pure functions in `shared/src/test/`
* integration tests in `<extension>/src/test/`
* use mocks from `@gpg-bridge/shared/test` for socket/file/command interactions
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

Each extension compiles to its own `out/` folder via TypeScript, and shared code is packaged as `@gpg-bridge/shared` npm module imported with `file:../shared` dependencies.

## Project Conventions

- **Protocol**: Use `latin1` encoding for socket I/O (preserves raw bytes). Never log raw binary; use `sanitizeForLog()` (first token + byte count).
- **Logging**: Use module-level `log(config, message)` with config callbacks, not `console.log`.
- **Sessions**: Stored in `Map` keyed by UUID; cleanup via socket 'close' handlers. Use `socket.destroy()` for unrecoverable errors.
- **Error handling**: Async functions rethrow after local cleanup if caller expects rejection.

## Integration Points

- GPG agent: uses Assuan protocol via a socket file (Windows uses a socket file containing host/port + nonce). The code parses the socket file and authenticates by sending the nonce.
- Cross-extension calls: `gpg-bridge-request` and `gpg-bridge-agent` communicate using `vscode.commands.executeCommand(...)` — keep argument shapes stable.

## Security

- Uses [GPG agent Assuan protocol](https://www.gnupg.org/documentation/manuals/gnupg/Agent-Protocol.html) via "extra" gpg-agent socket (S.gpg-agent.extra) with nonce authentication. See [gpg-agent-protocol.md](../docs/gpg-agent-protocol.md).
- Extensions only relay commands/responses of public data—no secrets or private keys are transmitted. All sensitive operations stay in GPG agent process.
- Never log raw binary content. Use `sanitizeForLog()` for protocol logging.
- Validate socket file contents strictly (port + 16-byte nonce).

## When Editing

**Code**: Reference key files in Architecture section. Run `npm run compile` to build, `npm run watch` during development, `npm run package` to validate packaging. Update both extensions if changing public commands.

**Shared code**: Add utilities to `shared/src/` (pure functions in protocol.ts, types in types.ts), re-export from index.ts, import via `@gpg-bridge/shared`.

**Testing**: Write unit tests in shared/src/test/ for pure functions, integration tests in <extension>/src/test/ for services. Add `*Deps` interfaces for DI with pattern `constructor(config: Config, deps?: Partial<Deps>)`. Run `npm test` before committing. Target >70% coverage.

---

If anything here is unclear or you want more detail (e.g., line-level examples or additional commands), tell me which section and I'll update this file.
