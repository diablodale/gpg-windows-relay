# GPG Agent Proxy Extension

VS Code extension that manages authenticated connections to a Windows GPG agent. Runs on the Windows host and exposes commands for the `request-proxy` extension to connect, send commands, and disconnect from the GPG agent.

## Architecture

### State Machine Overview

The agent proxy uses an **EventEmitter-based state machine** with 8 states and 10 events to manage GPG agent connections. Each session is tracked independently in a Map, allowing concurrent sessions from multiple remotes.

#### States (8 Total)

1. **DISCONNECTED** — No active connection, session can be created
2. **CONNECTING_TO_AGENT** — TCP socket connection in progress
3. **SOCKET_CONNECTED** — Socket connected, ready to send nonce
4. **READY** — Connected and authenticated, can accept commands (including BYE)
5. **SENDING_TO_AGENT** — Command write in progress to agent (nonce or command)
6. **WAITING_FOR_AGENT** — Accumulating response chunks from agent (greeting or command response)
7. **ERROR** — Error occurred, cleanup needed
8. **CLOSING** — Cleanup in progress (socket teardown, session removal)

Terminal states:
- **DISCONNECTED** (can create new session)
- Deleted from Map (unrecoverable error, session destroyed permanently)

#### Events (10 Total)

**Client Events** (from request-proxy):
- `CLIENT_CONNECT_REQUESTED` — connectAgent() called
- `CLIENT_DATA_RECEIVED` — Data received (nonce Buffer or command string)

**Agent Events** (from gpg-agent or socket operations):
- `AGENT_SOCKET_CONNECTED` — TCP socket connected to agent
- `AGENT_WRITE_OK` — Write succeeded (nonce or command)
- `AGENT_DATA_CHUNK` — Response data chunk received from agent
- `AGENT_DATA_RECEIVED` — Complete response received (greeting or command response)

**Error & Cleanup Events**:
- `ERROR_OCCURRED` — Any error (connection, write, timeout, socket, validation, protocol violation)
- `CLEANUP_REQUESTED` — Cleanup beginning with `{hadError: boolean}` payload
- `CLEANUP_COMPLETE` — Cleanup successful
- `CLEANUP_ERROR` — Cleanup failed

#### State Transition Flow

```
DISCONNECTED
  ↓ CLIENT_CONNECT_REQUESTED
CONNECTING_TO_AGENT
  ↓ AGENT_SOCKET_CONNECTED
SOCKET_CONNECTED
  ↓ CLIENT_DATA_RECEIVED (nonce)
SENDING_TO_AGENT
  ↓ AGENT_WRITE_OK
WAITING_FOR_AGENT (greeting)
  ↓ AGENT_DATA_RECEIVED
READY ←─────────────────────┐
  ↓ CLIENT_DATA_RECEIVED     │
SENDING_TO_AGENT             │
  ↓ AGENT_WRITE_OK           │
WAITING_FOR_AGENT            │
  └─ AGENT_DATA_RECEIVED ────┘

Error from any state:
  → ERROR_OCCURRED → ERROR → CLEANUP_REQUESTED → CLOSING → DISCONNECTED
```

### Socket Close Handling

**CRITICAL:** Node.js socket `'close'` event can fire in **ANY** state where socket exists, not just expected states. The handler must be defensive.

#### hadError Routing

The socket `'close'` event provides a `hadError` boolean parameter that determines routing:

- **hadError=false** (graceful close):
  - Direct transition: `emit('CLEANUP_REQUESTED', {hadError: false})` → CLOSING
  - Examples: BYE command response, agent-initiated close, clean shutdown

- **hadError=true** (transmission error):
  - Error transition: `emit('ERROR_OCCURRED', 'Socket closed with error')` → ERROR → CLOSING
  - Examples: Network failure, connection refused, TCP reset

#### Socket Close in All States

Socket close can occur in any socket-having state:

- **CONNECTING_TO_AGENT** — Connection refused, network error during handshake
- **SOCKET_CONNECTED** — Error after connect, before nonce sent
- **READY** — Agent crash, network failure, agent-initiated close
- **SENDING_TO_AGENT** — Write failure, agent crashes during write
- **WAITING_FOR_AGENT** — Agent crashes, network failure, BYE race condition
- **ERROR** — Socket close during error handling (ignored, already in error path)
- **CLOSING** — Expected close during cleanup (ignored, expected behavior)
- **DISCONNECTED** — No socket (ignored, shouldn't happen but safe)

The handler checks current state and ignores close events if already in ERROR, CLOSING, or DISCONNECTED.

### BYE Command Flow

The BYE command is **not a special case** — it flows through the normal command path:

1. `disconnectAgent(sessionId)` calls `sendCommands(sessionId, 'BYE\n')`
2. State transitions: READY → SENDING_TO_AGENT → WAITING_FOR_AGENT → READY
3. GPG agent responds with `OK` and closes the socket per protocol spec
4. Socket `'close'` event fires with `hadError=false` (graceful)
5. Handler emits `CLEANUP_REQUESTED` → transition to CLOSING → cleanup → DISCONNECTED

**Benefits:**
- Reuses all existing command machinery (write, response detection, error handling)
- No separate DISCONNECTING state needed
- Eliminates special-case logic
- Handles BYE race conditions naturally (socket close while in WAITING_FOR_AGENT)

### Timeout Strategy

The agent proxy uses **selective timeouts** to support interactive operations:

- ✅ **Connection timeout (5s)** — Network operation, should complete quickly
- ✅ **Greeting timeout (5s)** — Nonce authentication, non-interactive
- ❌ **NO response timeout** — Commands can be interactive (password prompts, INQUIRE)

**Rationale:**  
GPG operations often require human interaction through pinentry (password prompts, confirmations). As a passthrough proxy, we cannot distinguish network timeouts from human processing delays. Network failures are detected via socket `'close'` event instead of arbitrary timeouts.

**Interactive Operations:**
- Signing: gpg-agent spawns pinentry → waits for password → indefinite time
- INQUIRE responses: Client may prompt human → indefinite time
- Passphrase caching: First operation prompts, subsequent cached → unpredictable timing

### Concurrent Command Prevention

**Protocol Violation:** Sending commands while not in READY state is a protocol error.

The `sendCommands()` public API validates session is in READY state **before** emitting `CLIENT_DATA_RECEIVED`:
- If not READY, emits `ERROR_OCCURRED` and rejects the promise
- Additional race condition check in `handleReady` if state changed between validation and handler execution
- Similar to request-proxy's protocol violation detection for client data in invalid states

## Public API

The extension exposes three VS Code commands for the request-proxy:

### `_gpg-agent-proxy.connectAgent`

Creates a new session and connects to the GPG agent.

**Arguments:** None  
**Returns:** `Promise<string>` — Session ID (UUID)  
**Throws:** Connection errors, timeout errors, validation errors

**Flow:**
1. Creates new session with UUID
2. Parses GPG socket file (host, port, nonce)
3. Connects to TCP socket
4. Sends nonce for authentication
5. Validates greeting response (must start with "OK")
6. Returns session ID

**Timeouts:**
- Connection: 5 seconds
- Greeting: 5 seconds

### `_gpg-agent-proxy.sendCommands`

Sends a command block to the GPG agent and returns the response.

**Arguments:**
- `sessionId: string` — Session ID from connectAgent()
- `commandBlock: string` — GPG command(s) to send (e.g., "BYE\n")

**Returns:** `Promise<string>` — Response from GPG agent  
**Throws:** Session not found, not in READY state, write errors, protocol errors

**Flow:**
1. Validates session exists and is in READY state
2. Writes command block to socket
3. Accumulates response chunks until complete (OK/ERR/INQUIRE detected)
4. Returns complete response

**Timeouts:** None (supports interactive operations)

### `_gpg-agent-proxy.disconnectAgent`

Disconnects from the GPG agent and cleans up the session.

**Arguments:**
- `sessionId: string` — Session ID from connectAgent()

**Returns:** `Promise<void>`  
**Throws:** Session not found errors

**Flow:**
1. Sends BYE command via normal command path
2. Socket closes gracefully (hadError=false)
3. Cleanup: `removeAllListeners()` → `socket.destroy()` → delete from Map
4. Session removed from Map

**Note:** BYE is just a normal command, not a special case.

## Session Management

Sessions are stored in a `Map<string, AgentProxySession>` keyed by UUID:

```typescript
interface AgentProxySession {
    state: SessionState;
    socket: net.Socket | null;
    buffer: string;
    responseResolver: ((response: string) => void) | null;
    responseRejector: ((error: Error) => void) | null;
    // ... internal fields
}
```

**Lifecycle:**
1. Created in DISCONNECTED state by `connectAgent()`
2. Transitions through states via event handlers
3. Cleaned up and removed from Map in `handleCleanupComplete()`

**Cleanup guarantees:**
- Socket listeners removed via `removeAllListeners()`
- Socket destroyed via `socket.destroy()`
- Pending promises rejected on error
- Session deleted from Map
- First-error-wins pattern (cleanup continues even if one step fails)

## Testing

The service supports dependency injection for testing:

```typescript
interface AgentProxyDeps {
    socketFactory?: ISocketFactory;
    fileSystem?: IFileSystem;
}
```

Pass mocks via optional `deps` parameter to test without VS Code runtime or real sockets:

```typescript
const proxy = new AgentProxy(config, {
    socketFactory: new MockSocketFactory(),
    fileSystem: new MockFileSystem()
});
```

Test coverage includes:
- State transitions for all (state, event) pairs
- Socket close handling in all states (hadError true/false)
- Timeout behavior (connection, greeting)
- BYE command flow and race conditions
- Error handling and cleanup
- Concurrent command prevention
- Interactive operation support (no response timeout)

See [agent-proxy/src/test/agentProxy.test.ts](src/test/agentProxy.test.ts) for comprehensive test suite.

## Error Handling

All errors converge to a single `ERROR_OCCURRED` event:

- Connection timeout (5s)
- Greeting timeout (5s)
- Socket errors
- Write failures
- Invalid greeting (validation)
- Protocol violations (concurrent commands)

**Error Flow:**
1. Error occurs → emit `ERROR_OCCURRED`
2. Transition to ERROR state
3. Reject pending promise (if any)
4. Emit `CLEANUP_REQUESTED` with `{hadError: true}`
5. Transition to CLOSING → cleanup → DISCONNECTED

**First-Error-Wins Cleanup:**  
Cleanup continues even if one step fails (e.g., `removeAllListeners()` throws). The first error is captured and logged, but cleanup continues to release all resources.

## Dependencies

- **Node.js net** — TCP socket communication
- **Node.js fs** — Socket file parsing
- **Events EventEmitter** — State machine event handling
- **uuid** — Session ID generation
- **@gpg-relay/shared** — Protocol utilities (decoding, parsing, response detection, socket cleanup)

## Related

- [request-proxy/README.md](../request-proxy/README.md) — Companion extension running on remote
- [docs/agent-state-machine-refactor.md](../docs/agent-state-machine-refactor.md) — Detailed refactor plan and architecture
- [AGENTS.md](../AGENTS.md) — Project guidelines and state machine pattern documentation
- [Assuan Protocol](https://www.gnupg.org/documentation/manuals/gnupg/Agent-Protocol.html) - GPG Agent Assuan protocol
- [Assuan Manual](https://www.gnupg.org/documentation/manuals/assuan/) - Assuan developer details
