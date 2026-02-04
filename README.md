# GPG Agent/Request Proxy for VS Code

Proxies GPG agent protocols between Linux remotes (WSL, Dev Containers, SSH) and
Windows host running [Gpg4win](https://www.gpg4win.org/) using an **extension pack architecture**.

## Purpose

When working in a remote Linux environment from VS Code on Windows, GPG operations
(signing commits, decrypting files) typically fail because the remote
can't access your GPG keys. This extension pack proxies that gap by proxying GPG requests
from the remote to the GPG agent running on your VS Code UI host.

## Requirements

- **Windows host** with [Gpg4win](https://www.gpg4win.org/) v4.4.1+ installed
- Remote environment: WSL, Dev Container, or SSH
- VS Code v1.91.0+ with remote support

## Installation

### From Source

1. Build the extensions:

   ```powershell
   cd agent-proxy && npm install && npm run compile
   cd ../request-proxy && npm install && npm run compile
   cd ../pack && npm install
   ```

2. Package:

   ```powershell
   cd agent-proxy && npm run package
   cd ../request-proxy && npm run package
   cd ../pack && npm run package
   ```

3. Install `.vsix` files:

   - On GPG agent host install `agent-proxy/gpg-agent-proxy-*.vsix`
   - On remote requester install `request-proxy/gpg-request-proxy-*.vsix`
   - Or install the pack which includes both

## Usage

### Configuration

Often the default configuration works. You can override it with
VS Code settings for "GPG Agent Proxy" having prefix `gpgAgentProxy`:

```json
{
  "gpgAgentProxy.gpg4winPath": "C:\\Program Files\\GnuPG\\bin",
  "gpgAgentProxy.debugLogging": false
}
```

### Commands

**On Windows host:**

- **GPG Agent Proxy: Start** - Start the agent proxy
- **GPG Agent Proxy: Stop** - Stop the agent proxy
- **GPG Agent Proxy: Restart** - Restart the agent proxy
- **GPG Agent Proxy: Show Status** - Display agent proxy status

**On Remote:**

- **GPG Request Proxy: Start** - Start the request proxy
- **GPG Request Proxy: Stop** - Stop the request proxy

### Typical Workflow

1. Open VS Code on Windows
2. Agent proxy extension auto-starts (or run **GPG Agent Proxy: Start**)
3. Connect to WSL/Container/SSH remote
4. Request proxy auto-starts (or run **GPG Request Proxy: Start**)
5. GPG operations in the remote now work with your Windows keys

## Architecture

### Three-Extension Pack Approach

This project uses a **monorepo structure** with three separate extensions:

```text
 .
 agent-proxy/       # Agent proxy
 request-proxy/     # Remote request proxy (WSL/Container/SSH)
 pack/              # Extension pack (installs both)
```

#### 1. Agent Proxy Extension (`agent-proxy/`)

- **Name:** `gpg-agent-proxy`
- **Runs on:** Windows only (`"os": ["win32"]`)
- **Context:** UI context only
- **Activation:** Auto-starts on VS Code launch
- **Responsibility:** Manages proxy to gpg-agent socket

**Files:**

- `agent-proxy/src/extension.ts` - Main extension
- `agent-proxy/src/services/agentProxy.ts` - Agent proxy implementation

#### 2. Request Proxy Extension (`request-proxy/`)

- **Name:** `gpg-request-proxy`
- **Runs on:** WSL, Dev Containers, SSH (any non-Windows remote)
- **Context:** Workspace context only
- **Activation:** Auto-starts when connecting to remote
- **Responsibility:** Proxies remote requests to agent proxy

**Files:**

- `request-proxy/src/extension.ts` - Remote extension
- `request-proxy/src/services/requestProxy.ts` - Request proxy service (unified for all remote types)

#### 3. Pack Extension (`pack/`)

- **Name:** `gpg-agent-proxy`
- **Type:** Extension pack (no code)
- **Responsibility:** Bundles agent proxy and request proxy extensions

**Why a pack?**

- Single installation point for users
- Both extensions install automatically
- Cleaner dependency management
- Separate concerns: agent only runs on Windows, requester only on remotes

### How It Works

```text
Windows Host
 Gpg4win agent (Assuan socket on localhost)
  
 Agent Proxy Extension (gpg-agent-proxy)
   Reads: C:\Users\<user>\AppData\Local\gnupg\<unique>\S.gpg-agent.extra
   Extracts: TCP port xxxx + 16-byte nonce
   Connects to localhost:xxxx
   Proxies data to localhost:63331
  
Remote Environment (WSL/Container/SSH)
 Request Proxy Extension (gpg-request-proxy)
   Creates Unix socket: /run/user/1000/gnupg/S.gpg-agent.extra
   Connects to: localhost:63331 (via VS Code tunnel)
   Pipes bidirectionally
  
 Local GPG client (gpg --sign, etc.)
```

The agent "extra" socket is used for its [restricted abilities](https://www.gnupg.org/documentation/manuals/gnupg/Agent-Options.html#index-extra_002dsocket).

### Assuan Socket Protocol

Gpg4win's Assuan socket file contains:

```text
<TCP_PORT>
<16_BYTE_NONCE>
```

**Connection flow:**

1. Agent proxy reads socket file (port + nonce)
2. Agent proxy proxies to TCP localhost:63331
3. Request proxy connects to localhost:63331 (over VS Code tunnel)
4. Agent proxy connects to localhost:TCP_PORT
5. Agent proxy sends 16-byte nonce for authentication
6. Data pipes bidirectionally

**Termination:**

Immediate disconnect if either side closes

### Why This Architecture?

**Previous approach (single multi-context extension):**

- UI context doesn't activate when only remote folder is open
- Bridge never starts automatically for remote-only workflows
- Remote can't reliably connect to bridge

**New approach (three separate extensions):**

- Agent proxy always runs on Windows (just has `os: ["win32"]`)
- Request proxy always runs on remotes (workspace context only)
- Clear separation of concerns
- Each extension has minimal, focused scope
- Users install once via pack, both activate automatically

## File Structure

```text
 .
 agent-proxy/
    src/
       extension.ts           # Windows UI context
       services/
           agentProxy.ts      # Agent proxy service
    package.json
    tsconfig.json
 request-proxy/
    src/
       extension.ts           # Remote workspace context
       services/
           requestProxy.ts    # Unified proxy service
    package.json
    tsconfig.json
 pack/
    package.json               # Extension pack manifest
 .gitignore
 README.md
 LICENSE
```

## Development

### Build Individual Extensions

```powershell
# Build agent proxy
cd agent-proxy
npm install
npm run compile

# Build request proxy
cd request-proxy
npm install
npm run compile
```

### Watch Mode

```powershell
cd agent-proxy
npm run watch
```

### Package for Distribution

```powershell
cd agent-proxy && npm run package
cd request-proxy && npm run package
```

Produces `.vsix` files ready to install.

### Debug

Press `F5` in each extension folder to launch debug host.

## Testing

### Manual Testing

1. **Install both extensions** (or the pack)

2. **Start the agent proxy:**
   - Press F1  "GPG Agent Proxy: Start"
   - Check output channel for "Agent proxy started on localhost:63331"

3. **Connect to remote:**
   - File  Add Folder to Workspace  WSL/Container/SSH folder
   - Request proxy should auto-start
   - Check remote output channel for request proxy status

4. **Test GPG:**

   ```bash
   # In remote terminal
   gpg --list-keys
   # Should show your Windows GPG keys
   ```

5. **Stop:**

   - Press F1  "GPG Agent Proxy: Stop"

### Debug Output

Enable in VS Code settings:

```json
{
  "gpgAgentProxy.debugLogging": true
}
```

Check output channels:

- **GPG Agent Proxy** (gpg agent host)
- **GPG Request Proxy** (remote)

## Status

**Completed:**

- Agent proxy extension (Windows)
- Request proxy extension (WSL/Container/SSH)
- Extension pack configuration
- Unified proxy service (all remote types)
- Configurable proxy port

**Supported remotes:**

- WSL (Windows Subsystem for Linux)
- Dev Containers
- SSH Remotes

**Known issues:**

- Network tunneling: localhost:63331 may not be accessible from remote WSL (requires VS Code port forwarding setup)
- Multiple VS Code instances: Port conflict when multiple instances try to use port 63331 (needs dynamic port allocation)

## Contributing

For detailed architecture notes, see code comments in:

- `agent-proxy/src/services/agentProxy.ts` - Assuan protocol details
- `request-proxy/src/services/requestProxy.ts` - Proxy implementation
