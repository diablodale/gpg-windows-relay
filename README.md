# GPG Windows Relay for VS Code

Relays GPG agent protocols between Linux remotes (WSL, Dev Containers, SSH) and Windows host running Gpg4win using a **three-extension pack architecture**.

## 🎯 Purpose

When working in a remote Linux environment from VS Code on Windows, GPG operations (signing commits, decrypting files) typically fail because the remote can't access your Windows GPG keys. This extension pack bridges that gap by forwarding GPG agent requests from the remote to your Windows Gpg4win installation.

## ⚠️ Requirements

- **Windows host** with Gpg4win installed
- Remote environment: WSL, Dev Container, or SSH
- VS Code v1.91.0+ with remote support

## 📦 Installation

### From Source

1. Build the extensions:

   ```powershell
   cd bridge && npm install && npm run compile
   cd ../remote && npm install && npm run compile
   cd ../pack && npm install
   ```

2. Package:

   ```powershell
   cd bridge && npm run package
   cd ../remote && npm run package
   cd ../pack && npm run package
   ```

3. Install `.vsix` files in order:
   - `bridge/gpg-windows-relay-bridge-*.vsix` (Windows bridge)
   - `remote/gpg-windows-relay-remote-*.vsix` (Remote relay)
   - Or install the pack which includes both

## 🚀 Usage

### Commands

**On Windows host:**

- **GPG Windows Relay: Start** - Start the Assuan bridge
- **GPG Windows Relay: Stop** - Stop the bridge
- **GPG Windows Relay: Restart** - Restart the bridge
- **GPG Windows Relay: Show Status** - Display bridge status

**On Remote:**

- **GPG Windows Relay: Start** - Start the remote relay (auto-starts by default)
- **GPG Windows Relay: Stop** - Stop the remote relay

### Configuration

Open VS Code settings and configure:

```json
{
  "gpgWinRelay.gpg4winPath": "C:\\Program Files\\GnuPG\\bin",
  "gpgWinRelay.autoStart": true,
  "gpgWinRelay.listenPort": 63331,
  "gpgWinRelay.debugLogging": false
}
```

### Typical Workflow

1. Open VS Code on Windows
2. Bridge extension auto-starts (or run **GPG Windows Relay: Start**)
3. Connect to WSL/Container/SSH remote
4. Remote relay auto-starts (or run **GPG Windows Relay: Start**)
5. GPG operations in the remote now work with your Windows keys

## 🏗️ Architecture

### Three-Extension Pack Approach

This project uses a **monorepo structure** with three separate extensions:

```
gpg-windows-relay/
├── bridge/          # Windows-only Assuan bridge
├── remote/          # Remote relay (WSL/Container/SSH)
└── pack/            # Extension pack (installs both)
```

#### 1. Bridge Extension (`bridge/`)

- **Name:** `gpg-windows-relay-bridge`
- **Runs on:** Windows only (`"os": ["win32"]`)
- **Context:** UI context only
- **Activation:** Auto-starts on VS Code launch
- **Responsibility:** Manages Assuan bridge to gpg-agent

**Files:**

- `bridge/src/extension.ts` - Main extension
- `bridge/src/services/assuanBridge.ts` - Assuan bridge implementation

#### 2. Remote Extension (`remote/`)

- **Name:** `gpg-windows-relay-remote`
- **Runs on:** WSL, Dev Containers, SSH (any non-Windows remote)
- **Context:** Workspace context only
- **Activation:** Auto-starts when connecting to remote
- **Responsibility:** Manages relay from remote GPG to Windows bridge

**Files:**

- `remote/src/extension.ts` - Remote extension
- `remote/src/remoteRelay.ts` - Relay service (unified for all remote types)

#### 3. Pack Extension (`pack/`)

- **Name:** `gpg-windows-relay`
- **Type:** Extension pack (no code)
- **Responsibility:** Bundles bridge and remote extensions

**Why a pack?**

- Single installation point for users
- Both extensions install automatically
- Cleaner dependency management
- Separate concerns: bridge only runs on Windows, relay only on remotes

### How It Works

```
Windows Host
├─ Gpg4win agent (Assuan socket on localhost:XXXX)
│  ↑
├─ Bridge Extension (gpg-windows-relay-bridge)
│  ├─ Reads: C:\Users\<user>\AppData\Roaming\gnupg\S.gpg-agent
│  ├─ Extracts: TCP port + 16-byte nonce
│  ├─ Listens on: localhost:63331
│  ↑
├─ localhost:63331 (tunneled by VS Code)
│  ↑
Remote Environment (WSL/Container/SSH)
├─ Remote Extension (gpg-windows-relay-remote)
│  ├─ Creates Unix socket: /run/user/1000/gnupg/S.gpg-agent
│  ├─ Connects to: localhost:63331 (via VS Code tunnel)
│  ├─ Pipes bidirectionally
│  ↑
├─ Local GPG client (gpg --sign, etc.)
```

### Assuan Socket Protocol

Gpg4win's Assuan socket file contains:

```text
<TCP_PORT>
<16_BYTE_NONCE>
```

**Connection flow:**

1. Bridge reads socket file (port + nonce)
2. Bridge listens on TCP localhost:63331
3. Remote connects to localhost:63331 (over VS Code tunnel)
4. Bridge connects to localhost:TCP_PORT
5. Bridge sends 16-byte nonce for authentication
6. Data pipes bidirectionally

**Termination:** Immediate disconnect if either side closes (matches `npiperelay -ep -ei`)

### Why This Architecture?

**Previous approach (single multi-context extension):**

- ❌ UI context doesn't activate when only remote folder is open
- ❌ Bridge never starts automatically for remote-only workflows
- ❌ Remote can't reliably connect to bridge

**New approach (three separate extensions):**

- ✅ Bridge always runs on Windows (just has `os: ["win32"]`)
- ✅ Remote always runs on remotes (workspace context only)
- ✅ Clear separation of concerns
- ✅ Each extension has minimal, focused scope
- ✅ Users install once via pack, both activate automatically

## 📋 File Structure

```
.
├── bridge/
│   ├── src/
│   │   ├── extension.ts           # Windows UI context
│   │   └── services/
│   │       └── assuanBridge.ts    # Assuan bridge service
│   ├── package.json
│   └── tsconfig.json
├── remote/
│   ├── src/
│   │   ├── extension.ts           # Remote workspace context
│   │   └── remoteRelay.ts         # Unified relay service
│   ├── package.json
│   └── tsconfig.json
├── pack/
│   └── package.json               # Extension pack manifest
├── .gitignore
├── README.md
└── LICENSE
```

## 🛠️ Development

### Build Individual Extensions

```powershell
# Build bridge
cd bridge
npm install
npm run compile

# Build remote
cd ../remote
npm install
npm run compile
```

### Watch Mode

```powershell
cd bridge
npm run watch
```

### Package for Distribution

```powershell
cd bridge && npm run package
cd ../remote && npm run package
```

Produces `.vsix` files ready to install.

### Debug

Press `F5` in each extension folder to launch debug host.

## 🧪 Testing

### Manual Testing

1. **Install both extensions** (or the pack)

2. **Start the bridge:**
   - Press F1 → "GPG Windows Relay: Start"
   - Check output channel for "Bridge started on localhost:63331"

3. **Connect to remote:**
   - File → Add Folder to Workspace → WSL/Container/SSH folder
   - Remote relay should auto-start
   - Check remote output channel for relay status

4. **Test GPG:**

   ```bash
   # In remote terminal
   gpg --list-keys
   # Should show your Windows GPG keys
   ```

5. **Stop:**
   - Press F1 → "GPG Windows Relay: Stop"

### Debug Output

Enable in VS Code settings:

```json
{
  "gpgWinRelay.debugLogging": true
}
```

Check output channels:

- **GPG Windows Relay** (bridge on Windows)
- **GPG Windows Relay** (remote relay on remote)

## 📊 Status

**Completed:**

- ✅ Bridge extension (Windows)
- ✅ Remote extension (WSL/Container/SSH)
- ✅ Extension pack configuration
- ✅ Unified relay service (all remote types)
- ✅ Configurable listen port

**Supported remotes:**

- ✅ WSL (Windows Subsystem for Linux)
- ✅ Dev Containers
- ✅ SSH Remotes

**Known issues:**

- None currently with three-extension approach

## 🔄 Contributing

For detailed architecture notes, see code comments in:

- `bridge/src/services/assuanBridge.ts` - Assuan protocol details
- `remote/src/remoteRelay.ts` - Relay implementation
