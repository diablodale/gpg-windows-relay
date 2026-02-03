# GPG Windows Relay for VS Code

**Windows-only extension** that relays GPG agent protocols between Linux remotes (WSL, Dev Containers, SSH) and Windows host running Gpg4win.

## 🎯 Purpose

When working in a remote Linux environment from VS Code on Windows, GPG operations (signing commits, decrypting files) typically fail because the remote can't access your Windows GPG keys. This extension bridges that gap by forwarding GPG agent requests from the remote to your Windows Gpg4win installation.

## ⚠️ Requirements

- **Windows host** (this extension only runs on Windows UI context)
- **Gpg4win** installed on Windows
- Remote environment: WSL, Dev Container, or SSH
- VS Code v1.91.0+ with remote support

## 📦 Installation

1. Build the extension:

   ```powershell
   npm install
   npm run compile
   ```

2. Install in VS Code:
   - Press `F5` to launch Extension Development Host, OR
   - Package with `npm run package` and install the `.vsix` file

## 🚀 Usage

### Commands

- **GPG Windows Relay: Start** - Start the Assuan bridge
- **GPG Windows Relay: Stop** - Stop the Assuan bridge
- **GPG Windows Relay: Restart** - Restart the bridge
- **GPG Windows Relay: Show Status** - Display current bridge status

### Configuration

Open VS Code settings and configure:

```json
{
  "gpgWinRelay.gpg4winPath": "C:\\Program Files\\GnuPG\\bin",
  "gpgWinRelay.autoStart": true
}
```

### Typical Workflow

1. Open VS Code on Windows
2. Connect to WSL/Container/SSH remote
3. Run command **GPG Windows Relay: Start** (or enable `autoStart`)
4. The bridge automatically starts on Windows and connects with the remote
5. GPG operations in the remote now work with your Windows keys

## 🔧 Architecture

### Design Philosophy

**Pure Node.js, zero-dependency solution** leveraging VS Code's native multi-context extension support:

- **UI Context (Windows)**: Manages Assuan bridge to gpg-agent, exposes relay port via command IPC
- **Workspace Context (Remote)**: Runs automatically on WSL/container/SSH, queries Windows for relay port, creates local Unix socket listener
- **IPC**: VS Code command execution between contexts
- **Networking**: VS Code automatically tunnels `localhost:PORT` for all three remote types

### How Assuan Sockets Work

Gpg4win exposes the GPG agent via an Assuan socket file:

```text
C:\Users\<user>\AppData\Roaming\gnupg\S.gpg-agent

File contents:
<TCP_PORT>
<16_BYTE_NONCE>
```

The Windows relay reads this file, extracts the port and nonce, then:

1. Listens on TCP `localhost:63331`
2. On incoming connection: connects to `localhost:<TCP_PORT>` (to gpg-agent)
3. Sends 16-byte nonce for authentication
4. Pipes data bidirectionally (with immediate disconnection if either side closes)

### End-to-End Flow

```
Remote Linux (WSL/Container/SSH)
├─ /run/user/1000/gnupg/S.gpg-agent (Unix socket)
│  ↓
├─ Node.js Unix socket listener (src/remote/remoteRelay.ts)
│  ↓
├─ localhost:63331 (tunneled by VS Code)
│  ↓
Windows Host
├─ Node.js TCP server (src/services/assuanBridge.ts)
│  ├─ Reads: C:\Users\<user>\AppData\Roaming\gnupg\S.gpg-agent
│  ├─ Extracts port + nonce
│  ├─ Connects to localhost:<ASSUAN_PORT>
│  ├─ Sends nonce authentication
│  ↓
├─ Gpg4win gpg-agent (Assuan socket on localhost:XXXX)
```

### Implementation Details

#### Windows Side: Assuan Bridge

**File:** `src/services/assuanBridge.ts`

- Reads Assuan socket file for port and nonce
- Creates TCP server on `localhost:63331`
- On connection: authenticates with nonce, pipes to gpg-agent
- Immediate disconnection when either side closes (matches `npiperelay -ep -ei`)

**Exposed via:** `gpg-windows-relay.getRelayPort()` command (returns 63331)

#### Remote Side: Relay Service

**File:** `src/remote/remoteRelay.ts`

- Queries `gpgconf --list-dir agent-socket` for local socket path
- Creates Unix socket listener at that path
- Connects to Windows bridge via `localhost:63331` (tunneled by VS Code)
- Pipes bidirectionally: Unix socket ↔ TCP connection

**Identical code for all three remote types** (WSL, Dev Container, SSH) — no platform-specific logic needed.

#### Remote Extension Context

**File:** `src/remote/extension.ts`

- Activates automatically when extension installs in workspace context
- Calls Windows extension to get relay port
- Starts `remoteRelay` service
- Handles lifecycle and error reporting

#### Host Extension Context

**File:** `src/extension.ts`

- Activates on Windows host with UI context
- Detects Gpg4win installation
- Provides commands to start/stop Assuan bridge
- Exposes `getRelayPort()` command for remote queries
- Auto-start on activation if configured

## 🧪 Testing

### Manual Testing

1. **Start the bridge:**
   - Press F5 to run Extension Development Host
   - Click status bar → "Show Status"
   - Run command "GPG Windows Relay: Start"
   - Verify "Assuan bridge started on localhost:63331"

2. **Connect to remote:**
   - In the dev host VS Code window, connect to WSL/container/SSH
   - Remote extension automatically activates
   - Check remote terminal for relay status

3. **Test GPG:**

   ```bash
   # In remote terminal
   gpg --list-keys
   gpg --list-secret-keys
   # Should show your Windows GPG keys
   ```

4. **Stop the bridge:**
   - Run command "GPG Windows Relay: Stop"

### Debugging

Enable debug output in `.vscode/launch.json`:

```json
{
  "args": ["--user-data-dir", "${workspaceFolder}/.vscode-debug"]
}
```

Check VS Code output channels:

- **GPG Windows Relay** (host side)
- **GPG Windows Relay** (remote side - available in remote terminal)

## 📋 File Structure

```
src/
├── extension.ts                    # Host context (Windows) - manages Assuan bridge
├── gpgRelay.ts                     # Old relay class (deprecated)
├── test/
│   └── extension.test.ts
├── services/
│   └── assuanBridge.ts             # Windows TCP bridge to gpg-agent
├── remote/
│   ├── extension.ts                # Remote context activation
│   └── remoteRelay.ts              # Unified relay service (all remotes)
```

## 🛠️ Development

Build and watch:

```powershell
npm install
npm run watch
```

Run in debug mode:

- Press `F5` in VS Code

Package for distribution:

```powershell
npm run package
```

## 🔄 How Remotes Connect

### VS Code Extension Multi-Context

The extension runs in two contexts:

1. **UI Context** (Windows host)

   - `extensionKind: ["ui"]`
   - Full access to host filesystem and commands
   - Manages Assuan bridge

2. **Workspace Context** (Remote: WSL/Container/SSH)

   - `extensionKind: ["workspace"]`
   - Runs automatically when connecting to remote
   - Accesses local remote filesystem
   - Communicates with UI context via `vscode.commands.executeCommand()`

**Key Benefit:** No process spawning, no script deployment — VS Code handles everything natively.

## 📊 Status

**Current implementation:**

- ✅ Windows Assuan bridge service
- ✅ Remote relay service (unified for all three types)
- ✅ VS Code multi-context extension configured
- ✅ Host extension context with bridge management
- ✅ Remote extension context with auto-start
- ✅ Package.json configured for multi-context

**Supported remotes:**

- ✅ WSL (Windows Subsystem for Linux)
- ✅ Dev Containers
- ✅ SSH Remotes
- (All use identical relay code)

## 📄 License

See LICENSE file.
