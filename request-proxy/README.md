# GPG Request Proxy Extension

VS Code extension that creates a Unix socket server on the remote GPG agent socket path. Runs on remote environments (WSL, Dev Containers, SSH) and forwards GPG protocol operations to the `agent-proxy` extension on the Windows host.

## Architecture

### State Machine Overview

The request proxy uses an **EventEmitter-based state machine** with 11 states and 13 events to manage GPG protocol forwarding. Each client connection runs an independent state machine, allowing concurrent GPG operations from multiple processes.

#### States (11 Total)

1. **DISCONNECTED** — No client socket, ready to accept connections
2. **CONNECTING_TO_AGENT** — Client socket accepted, connecting to agent-proxy and awaiting greeting
3. **READY** — Agent connected, ready to buffer client commands
4. **BUFFERING_COMMAND** — Accumulating command bytes from client (until `\n`)
5. **BUFFERING_INQUIRE** — Accumulating D-block bytes from client (until `END\n`)
6. **SENDING_TO_AGENT** — Sending command/D-block to agent via VS Code command
7. **WAITING_FOR_AGENT** — Awaiting complete response from agent
8. **SENDING_TO_CLIENT** — Sending response to client socket
9. **ERROR** — Error occurred, cleanup needed
10. **CLOSING** — Cleanup in progress (socket teardown, agent disconnect, session removal)
11. **FATAL** — Unrecoverable error (cleanup failed), session destroyed permanently

Terminal states:
- **DISCONNECTED** (can accept new connections)
- **FATAL** (unrecoverable, session removed from Map)

#### Events (13 Total)

**Client Events** (from client GPG process):
- `CLIENT_SOCKET_CONNECTED` — New client socket accepted
- `CLIENT_DATA_START` — First chunk of client data in READY state
- `CLIENT_DATA_PARTIAL` — Data arrives while buffering (command or D-block)
- `CLIENT_DATA_COMPLETE` — Complete command (`\n`) or D-block (`END\n`) received

**Agent Events** (from agent-proxy via VS Code commands):
- `AGENT_GREETING_OK` — Agent greeting received successfully
- `AGENT_RESPONSE_COMPLETE` — Complete response from agent received
- `RESPONSE_OK_OR_ERR` — Agent response is OK or ERR (return to READY)
- `RESPONSE_INQUIRE` — Agent response contains INQUIRE (buffer D-block)

**Write Events**:
- `WRITE_OK` — Write to agent/client succeeded

**Error & Cleanup Events**:
- `ERROR_OCCURRED` — Any error (buffer, write, socket, protocol violation)
- `CLEANUP_REQUESTED` — Cleanup beginning with `{hadError: boolean}` payload
- `CLEANUP_COMPLETE` — Cleanup successful
- `CLEANUP_ERROR` — Cleanup failed

#### State Transition Flow

```
DISCONNECTED
  ↓ CLIENT_SOCKET_CONNECTED
CONNECTING_TO_AGENT
  ↓ AGENT_GREETING_OK
READY
  ↓ CLIENT_DATA_START
BUFFERING_COMMAND ←──────────────┐
  ↓ CLIENT_DATA_COMPLETE         │
SENDING_TO_AGENT                 │
  ↓ WRITE_OK                     │
WAITING_FOR_AGENT                │
  ↓ AGENT_RESPONSE_COMPLETE      │
SENDING_TO_CLIENT                │
  └─ RESPONSE_OK_OR_ERR ─────────┘

INQUIRE Flow:
SENDING_TO_CLIENT
  ↓ RESPONSE_INQUIRE
BUFFERING_INQUIRE
  ↓ CLIENT_DATA_COMPLETE (D-block + END\n)
SENDING_TO_AGENT
  ↓ WRITE_OK
WAITING_FOR_AGENT
  ↓ AGENT_RESPONSE_COMPLETE
SENDING_TO_CLIENT
  └─ RESPONSE_OK_OR_ERR → READY

Error from any state:
  → ERROR_OCCURRED → ERROR → CLEANUP_REQUESTED → CLOSING → DISCONNECTED
```

### Socket Close Handling

**CRITICAL:** Node.js socket `'close'` event can fire in **ANY** state where client socket exists, not just expected states. The handler must be defensive.

#### hadError Routing

The socket `'close'` event provides a `hadError` boolean parameter that determines routing:

- **hadError=false** (graceful close):
  - Direct transition: `emit('CLEANUP_REQUESTED', {hadError: false})` → CLOSING
  - Examples: Client exits normally, `BYE` command, clean shutdown

- **hadError=true** (transmission error):
  - Error transition: `emit('ERROR_OCCURRED', 'Socket closed with error')` → ERROR → CLOSING
  - Examples: Network failure, connection reset, TCP error

#### Socket Close in All States

Socket close can occur in any socket-having state:

- **CONNECTING_TO_AGENT** — Client disconnects before agent connection completes
- **READY** — Client process crashes, network failure
- **BUFFERING_COMMAND** — Client disconnects mid-command
- **BUFFERING_INQUIRE** — Client disconnects mid-D-block
- **SENDING_TO_AGENT** — Client disconnects during agent communication
- **WAITING_FOR_AGENT** — Client disconnects while waiting for response
- **SENDING_TO_CLIENT** — Client disconnects during response transmission
- **ERROR** — Socket close during error handling (ignored, already in error path)
- **CLOSING** — Expected close during cleanup (ignored, expected behavior)
- **DISCONNECTED** — No socket (ignored, shouldn't happen but safe)
- **FATAL** — Terminal state (ignored)

The handler checks current state and ignores close events if already in ERROR, CLOSING, FATAL, or DISCONNECTED.

### INQUIRE D-block Buffering Flow

The request proxy handles GPG's INQUIRE protocol pattern where the agent requests additional data from the client:

**Flow:**
1. Client sends command (e.g., `SIGN`)
2. Agent responds with `INQUIRE <keyword>\n`
3. **State transitions to BUFFERING_INQUIRE**
4. Client sends D-block: `D <data>\nD <data>\n...\nEND\n`
5. Proxy buffers data until `END\n` detected (uses `extractInquireBlock` from shared)
6. **Complete D-block sent to agent** via `sendCommands`
7. Agent processes and responds (OK/ERR/another INQUIRE)
8. Response forwarded to client
9. **Return to READY** (if OK/ERR) or **repeat INQUIRE** (if nested)

**Benefits:**
- Supports nested INQUIRE sequences (agent can respond to D-block with another INQUIRE)
- Preserves binary data integrity (latin1 encoding)
- Handles D-blocks of any size (tested up to multiple MB)
- Detects `END\n` reliably even when split across chunks

**Implementation:**
- Uses shared `extractInquireBlock()` utility for robust END detection
- Uses shared `detectResponseCompletion()` to identify INQUIRE responses
- Buffer cleared after D-block extraction to prevent leaks

### State-Aware Client Data Handling

The proxy routes client data differently based on current state:

**CLIENT_DATA_START** (in READY state):
- First chunk of client data
- Extracts command using `extractCommand()` from shared
- If newline found: transitions to SENDING_TO_AGENT
- If partial: transitions to BUFFERING_COMMAND, accumulates

**CLIENT_DATA_PARTIAL** (in BUFFERING_COMMAND or BUFFERING_INQUIRE):
- Subsequent chunks while buffering
- BUFFERING_COMMAND: accumulates until `\n` (command complete)
- BUFFERING_INQUIRE: accumulates until `END\n` (D-block complete)
- Uses shared utilities for extraction: `extractCommand()`, `extractInquireBlock()`

**CLIENT_DATA_COMPLETE**:
- Emitted when complete command or D-block detected
- Triggers transition to SENDING_TO_AGENT
- Buffer contains complete data ready to send

**Protocol Violations:**
- Client data in wrong states (ERROR, CLOSING, FATAL) → ERROR_OCCURRED
- Data arrives in unexpected states → logged and ignored (defensive)

**Implementation:**
- `'readable'` event handler checks current state before emitting events
- State machine validates transitions via STATE_TRANSITIONS table
- Invalid transitions throw errors immediately (fail-fast)

### Client Connection Lifecycle

Each client connection is managed independently:

**Server Startup:**
1. Detect GPG socket path (via `gpgconf --list-dirs agent-socket`)
2. Create Unix socket server at detected path
3. Set socket permissions to 0o666 (world-writable for GPG access)
4. Listen for client connections

**Per-Client Session:**
1. Client connects → `CLIENT_SOCKET_CONNECTED` → `CONNECTING_TO_AGENT`
2. Pause socket (prevent data loss during agent connection)
3. Connect to agent-proxy → `AGENT_GREETING_OK` → `READY`
4. Resume socket
5. Process commands in loop: buffer → send → wait → respond
6. Client disconnects → cleanup → remove from Map

**Concurrent Sessions:**
- Multiple clients supported (independent state machines)
- Sessions stored in `Map<net.Socket, ClientSessionManager>`
- Each session has isolated: state, buffer, agent sessionId
- Error in one session doesn't affect others

## Public API

The extension exposes one primary function for starting the request proxy:

### `startRequestProxy`

Creates a Unix socket server and starts proxying GPG requests to agent-proxy.

**Signature:**
```typescript
async function startRequestProxy(
    config: RequestProxyConfig,
    deps?: RequestProxyDeps
): Promise<RequestProxyInstance>
```

**Arguments:**
- `config: RequestProxyConfig` — Configuration with logging callback
  ```typescript
  interface RequestProxyConfig {
      logCallback?: (message: string) => void;
  }
  ```

- `deps?: RequestProxyDeps` — Optional dependency injection for testing
  ```typescript
  interface RequestProxyDeps {
      commandExecutor?: ICommandExecutor;   // VS Code command executor
      serverFactory?: IServerFactory;        // Unix socket server factory
      fileSystem?: IFileSystem;              // File system operations
      getSocketPath?: () => Promise<string | null>;  // Socket path detection
  }
  ```

**Returns:** `Promise<RequestProxyInstance>`
```typescript
interface RequestProxyInstance {
    stop(): Promise<void>;
}
```

**Example:**
```typescript
import { startRequestProxy } from './services/requestProxy';
import { VSCodeCommandExecutor } from './services/commandExecutor';

const instance = await startRequestProxy({
    logCallback: (msg) => console.log(msg)
}, {
    commandExecutor: new VSCodeCommandExecutor()
});

// Later: stop the server
await instance.stop();
```

**Flow:**
1. Detects GPG socket path via `gpgconf --list-dirs agent-socket`
2. Creates Unix socket server at detected path
3. Sets socket permissions to 0o666
4. Starts listening for client connections
5. Returns instance with `stop()` method

**Error Handling:**
- Socket path not found → throws Error
- Socket already in use → throws Error (likely another proxy running)
- Permission errors → throws Error

### `stop()`

Stops the server and disconnects all active sessions.

**Signature:**
```typescript
async stop(): Promise<void>
```

**Flow:**
1. Stops accepting new connections
2. Disconnects all active agent sessions
3. Destroys all client sockets
4. Closes Unix socket server
5. Removes socket file

**Cleanup Guarantees:**
- All client sockets destroyed
- All agent sessions disconnected via `disconnectAgent`
- Socket listeners removed
- Socket file deleted
- First-error-wins pattern (cleanup continues even if steps fail)

## VS Code Command Integration

The request proxy communicates with agent-proxy via three VS Code commands:

### `_gpg-agent-proxy.connectAgent`

**Called:** When client connects (AGENT_CONNECTING state)  
**Returns:** `{ sessionId: string; greeting: string }`  
**Purpose:** Establish agent connection and get greeting to forward to client

### `_gpg-agent-proxy.sendCommands`

**Called:** When complete command or D-block ready (SENDING_TO_AGENT state)  
**Arguments:** `(sessionId: string, commandBlock: string)`  
**Returns:** `{ response: string }`  
**Purpose:** Send command/D-block to agent and get response

### `_gpg-agent-proxy.disconnectAgent`

**Called:** During cleanup (CLOSING state)  
**Arguments:** `(sessionId: string)`  
**Returns:** `void`  
**Purpose:** Gracefully disconnect agent session

**Error Handling:**
- Command execution errors → ERROR_OCCURRED → CLOSING
- Network errors propagate from agent-proxy
- Timeouts handled by agent-proxy (connection 5s, greeting 5s, no response timeout)

## Session Management

Sessions are stored in a `Map<net.Socket, ClientSessionManager>` keyed by client socket:

```typescript
interface ClientSession {
    socket: net.Socket;
    sessionId: string | null;  // Agent sessionId from connectAgent
    state: SessionState;
    buffer: string;            // Accumulated data (command or D-block)
}
```

**Lifecycle:**
1. Created in DISCONNECTED state when server accepts connection
2. Transitions through states via event handlers
3. Cleaned up and removed from Map in `handleCleanupComplete()`

**Cleanup guarantees:**
- Socket listeners removed via `removeAllListeners()`
- Socket destroyed via `socket.destroy()`
- Agent session disconnected via `disconnectAgent` (if exists)
- Session deleted from Map
- First-error-wins pattern (cleanup continues even if one step fails)

**Concurrency:**
- Each client socket maps to one session
- Sessions have independent state machines
- No shared state between sessions
- Errors isolated per session

## Testing

The service supports dependency injection for testing:

```typescript
interface RequestProxyDeps {
    commandExecutor?: ICommandExecutor;
    serverFactory?: IServerFactory;
    fileSystem?: IFileSystem;
    getSocketPath?: () => Promise<string | null>;
}
```

Pass mocks via optional `deps` parameter to test without VS Code runtime or real sockets:

```typescript
const instance = await startRequestProxy({
    logCallback: (msg) => console.log(msg)
}, {
    commandExecutor: new MockCommandExecutor(),
    serverFactory: new MockServerFactory(),
    fileSystem: new MockFileSystem(),
    getSocketPath: async () => '/tmp/test-gpg-agent'
});
```

Test coverage includes:
- State transitions for all (state, event) pairs (STATE_TRANSITIONS validation)
- Socket close handling in all states (hadError true/false)
- INQUIRE D-block buffering (single, multiple D-lines, nested, binary data)
- Command buffering (partial arrival, split across chunks, pipelined)
- Error handling and cleanup (socket errors, agent errors, protocol violations)
- Concurrent sessions (multiple clients, error isolation)
- Buffer management (clearing after extraction, edge cases)
- Protocol completion detection (OK/ERR/INQUIRE via shared utility)

See [request-proxy/src/test/requestProxy.test.ts](src/test/requestProxy.test.ts) for comprehensive test suite (124 tests).

## Error Handling

All errors converge to a single `ERROR_OCCURRED` event:

- Buffer errors (encoding, invalid data)
- Write failures (agent or client socket)
- Socket errors
- Agent connection errors
- Agent command errors
- Protocol violations (client data in wrong state)

**Error Flow:**
1. Error occurs → emit `ERROR_OCCURRED`
2. Transition to ERROR state
3. Emit `CLEANUP_REQUESTED` with `{hadError: true}`
4. Transition to CLOSING → cleanup → DISCONNECTED or FATAL

**First-Error-Wins Cleanup:**  
Cleanup continues even if one step fails (e.g., `removeAllListeners()` throws). The first error is captured and logged, but cleanup continues to release all resources.

**FATAL State:**  
Reached if cleanup itself fails (e.g., socket.destroy() throws, disconnectAgent fails). Session removed from Map and terminal state logged. Server continues running for other sessions.

## Protocol Details

### Latin1 Encoding

Uses `latin1` encoding for all socket I/O to preserve binary data:
- GPG protocol can include binary data (signatures, encrypted blocks)
- `Buffer.toString('latin1')` preserves bytes 0-255
- Shared utilities handle encoding: `encodeProtocolData()`, `decodeProtocolData()`

### Command Extraction

Uses shared `extractCommand()` utility:
- Finds first newline in buffer
- Returns `{ extracted: string | null; remaining: string }`
- Handles partial commands split across chunks
- Binary-safe (preserves all byte values)

### D-block Extraction

Uses shared `extractInquireBlock()` utility:
- Finds `END\n` sequence in buffer
- Returns `{ extracted: string | null; remaining: string }`
- Handles D-blocks split across chunks
- Handles `END` appearing in data (looks for `END\n` specifically)
- Binary-safe, tested with all byte values 0-255

### Response Completion Detection

Uses shared `detectResponseCompletion()` utility:
- Detects OK, ERR, or INQUIRE responses
- Returns `{ complete: boolean; type: 'OK' | 'ERR' | 'INQUIRE' | null }`
- Requires trailing newline for completion
- Handles multi-line responses with status lines

### Socket Cleanup

Uses shared `cleanupSocket()` utility:
- `removeAllListeners()` → `destroy()` pattern
- Returns first error or null (first-error-wins)
- Try/catch wrappers for each operation
- Logging for debugging

## Dependencies

- **Node.js net** — Unix socket server and client socket management
- **Node.js fs** — Socket file operations, permissions
- **Node.js child_process** — `gpgconf` execution for socket path detection
- **Events EventEmitter** — State machine event handling
- **@gpg-relay/shared** — Protocol utilities (encoding, parsing, response detection, command/D-block extraction, socket cleanup)
- **VS Code Extension API** — `vscode.commands.executeCommand` for agent-proxy communication

## Related

- [agent-proxy/README.md](../agent-proxy/README.md) — Companion extension running on Windows host
- [docs/request-state-machine-refactor.md](../docs/request-state-machine-refactor.md) — Detailed refactor plan and architecture
- [AGENTS.md](../AGENTS.md) — Project guidelines and state machine pattern documentation
- [Assuan Protocol](https://www.gnupg.org/documentation/manuals/gnupg/Agent-Protocol.html) - GPG Agent Assuan protocol
- [Assuan Manual](https://www.gnupg.org/documentation/manuals/assuan/) - Assuan developer details
