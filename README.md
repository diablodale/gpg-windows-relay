# GPG Agent Relay for VS Code

**Windows-only extension** that relays GPG agent protocol between Linux remotes (WSL, Dev Containers, SSH) and Windows host running Gpg4win.

## 🎯 Purpose

When working in a remote Linux environment from VS Code on Windows, GPG operations (signing commits, decrypting files) typically fail because the remote can't access your Windows GPG keys. This extension bridges that gap by forwarding GPG agent requests from the remote to your Windows Gpg4win installation.

## ⚠️ Requirements

- **Windows host** (this extension only runs on Windows)
- **Gpg4win** installed on Windows
- **npiperelay.exe** for pipe/socket bridging (optional, will be auto-installed)
- Remote environment: WSL, Dev Container, or SSH

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

- **GPG Relay: Start** - Start the relay service
- **GPG Relay: Stop** - Stop the relay service
- **GPG Relay: Restart** - Restart the relay
- **GPG Relay: Show Status** - Display current relay status

### Configuration

Open VS Code settings and configure:

```json
{
  "gpgRelay.gpg4winPath": "C:\\Program Files (x86)\\GnuPG\\bin",
  "gpgRelay.autoStart": true,
  "gpgRelay.debugLogging": false
}
```

### Typical Workflow

1. Open VS Code on Windows
2. Connect to WSL/Container/SSH remote
3. Run command **GPG Relay: Start** (or enable auto-start)
4. GPG operations in the remote will now work with your Windows keys

## 🔧 How It Works

The extension:
1. Detects when you connect to a remote environment
2. Locates the gpg-agent named pipe on Windows
3. Sets up a relay bridge using npiperelay
4. Forwards GPG protocol requests from remote Unix socket to Windows pipe

## 🛠️ Development

Run the extension in debug mode:

```powershell
# Press F5 in VS Code, or:
npm run watch
```

Then press `F5` to launch the Extension Development Host.

## 📝 Status

**Current implementation status:**
- ✅ Extension scaffold and commands
- ✅ Remote detection
- ✅ Configuration management
- ⏳ Relay implementation (in progress)
- ⏳ npiperelay integration
- ⏳ Auto-installation of dependencies

## 📄 License

See LICENSE file.
