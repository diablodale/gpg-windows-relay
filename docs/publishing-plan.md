# Publishing Plan: gpg-bridge

## Overview

This plan covers the complete path from the current broken/unpublished state to a
polished, published extension set on the VS Code marketplace and GitHub Releases.

Six phases in dependency order:

1. **Rename** — project rename from `gpg-windows-relay` to `gpg-bridge`
2. **Bundle** — fix broken VSIX packaging with esbuild
3. **Identity** — publisher account and manifest IDs
4. **Quality** — icons, READMEs, CHANGELOG, CONTRIBUTING
5. **Publish** — first marketplace release + GitHub Release
6. **CI/CD** — GitHub Actions for automated build and publish

Every phase ends with a full test gate before committing to git.

---

## Name Mapping

| Old token | New token | Where used |
|-----------|-----------|------------|
| `gpg-windows-relay` | `gpg-bridge` | repo name, pack extension `name`, URLs |
| `gpg-windows-relay-monorepo` | `gpg-bridge-monorepo` | root `package.json` `name` |
| `agent-proxy/` | `gpg-bridge-agent/` | directory, extension `name` |
| `request-proxy/` | `gpg-bridge-request/` | directory, extension `name` |
| `GPG Agent Proxy` | `GPG Bridge Agent` | `displayName`, output channel, status bar |
| `GPG Request Proxy` | `GPG Bridge Request` | `displayName`, output channel |
| `GPG Windows Relay` | `GPG Bridge` | pack `displayName` |
| `gpg-agent-proxy.*` | `gpg-bridge-agent.*` | VS Code command IDs |
| `gpg-request-proxy.*` | `gpg-bridge-request.*` | VS Code command IDs |
| `_gpg-agent-proxy.*` | `_gpg-bridge-agent.*` | internal cross-extension command IDs |
| `_gpg-request-proxy.*` | `_gpg-bridge-request.*` | internal test command IDs |
| `gpgAgentProxy.*` | `gpgBridgeAgent.*` | VS Code config keys |
| `gpgRequestProxy.*` | `gpgBridgeRequest.*` | VS Code config keys |
| `@gpg-relay/shared` | `@gpg-bridge/shared` | npm package name, all import paths |
| `local` (publisher) | `diablodale` | all extension `package.json` publisher fields |
| `local.gpg-agent-proxy` | `diablodale.gpg-bridge-agent` | `extensionDependencies`, `extensionPack` |
| `local.gpg-request-proxy` | `diablodale.gpg-bridge-request` | `extensionPack` |
| `github.com/diablodale/gpg-windows-relay` | `github.com/diablodale/gpg-bridge` | `repository.url`, `bugs.url` |

`shared/` directory name stays — already generic.

---

## Phase 1 — Project Rename

### Goal
Rename every name token before any other work so that subsequent phases use the
correct names from the start and no rename needs to be repeated.

### Prerequisites
- GitHub repo must be renamed by the user **before** this phase's commit:
  GitHub → repository Settings → Rename → `gpg-bridge`.
  GitHub auto-redirects the old URL for existing clones.
- After the GitHub rename, update your local git remote to the new URL:
  ```powershell
  git remote set-url origin https://github.com/diablodale/gpg-bridge
  ```
  Verify with `git remote -v` before pushing the Phase 1 commit.

### Steps

**1a. Directory renames via `git mv`** (preserves git history):
- `git mv agent-proxy gpg-bridge-agent`
- `git mv request-proxy gpg-bridge-request`
- `pack/` stays — its directory name is already neutral

**1b. Root [package.json](../package.json)** — update:
- `name`: `gpg-windows-relay-monorepo` → `gpg-bridge-monorepo`
- `description`: update display text
- `clean` script globs: `agent-proxy/gpg-agent-proxy-*.vsix` → `gpg-bridge-agent/gpg-bridge-agent-*.vsix`, etc.
- All `cd agent-proxy` / `cd request-proxy` script paths → `cd gpg-bridge-agent` / `cd gpg-bridge-request`

**1c. Extension package.json files** — apply full name mapping table above to:
- [gpg-bridge-agent/package.json](../gpg-bridge-agent/package.json): `name`, `displayName`,
  all command IDs, config key prefix, `repository.url`, `bugs.url`,
  dependency `@gpg-relay/shared` → `@gpg-bridge/shared`
- [gpg-bridge-request/package.json](../gpg-bridge-request/package.json): same, plus
  `extensionDependencies` entry → `diablodale.gpg-bridge-agent`
- [shared/package.json](../shared/package.json): `name` → `@gpg-bridge/shared`
- [pack/package.json](../pack/package.json): `name`, `displayName`, both `extensionPack`
  entries, `repository.url`, `bugs.url`

**1d. TypeScript source and test files** — mechanical token replacements:

*Import paths* (all `.ts` files across both extensions, shared, and integration tests):
- `from '@gpg-relay/shared'` → `from '@gpg-bridge/shared'`
- `from '@gpg-relay/shared/test'` → `from '@gpg-bridge/shared/test'`
- `from '@gpg-relay/shared/test/integration'` → `from '@gpg-bridge/shared/test/integration'`

*Command ID strings* in [commandExecutor.ts](../gpg-bridge-request/src/services/commandExecutor.ts),
both `extension.ts` files, and all integration test files:
- `'_gpg-agent-proxy.connectAgent'` → `'_gpg-bridge-agent.connectAgent'`
- `'_gpg-agent-proxy.sendCommands'` → `'_gpg-bridge-agent.sendCommands'`
- `'_gpg-agent-proxy.disconnectAgent'` → `'_gpg-bridge-agent.disconnectAgent'`
- `'gpg-agent-proxy.start'` → `'gpg-bridge-agent.start'`
- `'gpg-agent-proxy.stop'` → `'gpg-bridge-agent.stop'`
- `'gpg-agent-proxy.showStatus'` → `'gpg-bridge-agent.showStatus'`
- `'gpg-request-proxy.start'` → `'gpg-bridge-request.start'`
- `'gpg-request-proxy.stop'` → `'gpg-bridge-request.stop'`
- `'_gpg-request-proxy.test.getSocketPath'` → `'_gpg-bridge-request.test.getSocketPath'`

*Configuration keys* in both `extension.ts` files and integration tests:
- `getConfiguration('gpgAgentProxy')` → `getConfiguration('gpgBridgeAgent')`
- `getConfiguration('gpgRequestProxy')` → `getConfiguration('gpgBridgeRequest')`

*UI strings* in [gpg-bridge-agent/src/extension.ts](../gpg-bridge-agent/src/extension.ts):
- `createOutputChannel('GPG Agent Proxy')` → `createOutputChannel('GPG Bridge Agent')`
- `statusBarItem.name = 'GPG Agent Proxy'` → `'GPG Bridge Agent'`
- All `'GPG Agent Proxy ...'` status bar label strings

*UI strings* in [gpg-bridge-request/src/extension.ts](../gpg-bridge-request/src/extension.ts):
- `createOutputChannel('GPG Request Proxy')` → `createOutputChannel('GPG Bridge Request')`

*Log strings* across all `.ts` files in both extensions — apply the name mapping
table to any string literal that refers to an extension by name, whether the
extension is referring to itself or cross-referencing the other. This covers
log messages, error strings, and any diagnostic text produced at runtime. The
output channel names (already covered above under UI strings) follow the same rule.

**1e. Documentation** — apply name mapping to:
- [AGENTS.md](../AGENTS.md): command IDs, import paths, local workspace path reference
- [CHANGELOG.md](../CHANGELOG.md): `gpg-windows-relay` → `gpg-bridge` in prose
- [README.md](../README.md) (root): command IDs, config keys, display names, repo URL
- [gpg-bridge-agent/README.md](../gpg-bridge-agent/README.md): command IDs, cross-references
- [gpg-bridge-request/README.md](../gpg-bridge-request/README.md): command IDs, cross-references
- [docs/](../docs/) plan files: **do not edit** — these are historical records of
  decisions made under the old name; retroactively changing them misrepresents
  the project history. They remain valid as-written.

**1f. tsconfig.json files** — no changes needed (no project-name path aliases).

### Verification gate
```powershell
# Re-link shared package under new name
npm install

# Clean build
npm run compile

# Unit tests
npm test

# Integration tests (both extensions)
cd gpg-bridge-agent  && npm run test:integration
cd ../gpg-bridge-request && npm run test:integration
```
All must pass.

### Commit
```
refactor: rename project from gpg-windows-relay to gpg-bridge
```

---

## Phase 2 — Fix VSIX Bundling

### Goal
Fix the broken `npm run package` command. Currently fails with:
```
ERROR invalid relative path: extension/../shared/node_modules/@types/chai/README.md
```

### Root Cause
`@gpg-bridge/shared: "file:../shared"` is listed in production `dependencies`.
vsce follows the symlink outside the extension root and attempts to archive
`../shared/node_modules/**` (3246 files). The path traversal is rejected.

### Fix: esbuild bundling
esbuild statically inlines all `import` statements at build time into a single
`out/extension.js`. At runtime, VS Code loads only that file — there are no
`node_modules` lookups at runtime. This makes `@gpg-bridge/shared` and `uuid`
build-time tools, so they belong in `devDependencies` where vsce ignores them.
Only `vscode` remains external (VS Code injects it into the extension host).

### Steps

Repeat for both `gpg-bridge-agent/` and `gpg-bridge-request/`:

**2a.** Install esbuild as a dev dependency:
```powershell
cd gpg-bridge-agent
npm install --save-dev esbuild
```

**2b.** Create `gpg-bridge-agent/esbuild.js`:
- Entry point: `./src/extension.ts`
- Output: `./out/extension.js`
- Format: `cjs` (CommonJS, required by VS Code extension host)
- Platform: `node`
- External: `['vscode']` only
- `--production` flag enables `minify: true` and `sourcemap: false`
- Without `--production`: `sourcemap: true`, no minification (for development)

**2c.** Update `gpg-bridge-agent/package.json` scripts:
- Add `"check-types": "tsc --noEmit"`
- Change `"vscode:prepublish"` → `"npm run check-types && node esbuild.js --production"`
- Change `"compile"` → keep as `"tsc -p ./"` (used during development + watch)
- Rename `"package"` → `"vsix"` (avoids collision with npm's built-in `package` lifecycle):
  `"vsix": "vsce package"`

**2d.** Move from `dependencies` → `devDependencies` in `gpg-bridge-agent/package.json`:
- `@gpg-bridge/shared`
- `uuid`

Rationale: esbuild inlines both at build time. vsce only packages `dependencies`.
Moving them to `devDependencies` prevents vsce from traversing `file:../shared`.

**2e.** Add to `gpg-bridge-agent/.vscodeignore`:
```
node_modules/**
```

**2f.** Remove stale `gpg-bridge-agent.restart` from `contributes.commands` in
`gpg-bridge-agent/package.json`. The command handler was removed during the
state machine refactor; the manifest entry was never cleaned up.

**2g.** Add `"api": "none"` to `gpg-bridge-request/package.json` — this field is
present in agent but missing from request. Both should be consistent.

**2h.** Update root `package.json`:
- `package:agent` script: `cd gpg-bridge-agent && npm run vsix`
- `package:request` script: `cd gpg-bridge-request && npm run vsix`
- `package:pack` script: `cd pack && npm run vsix` (add `"vsix": "vsce package"` to
  `pack/package.json` as well)

### Verification gate

**Tests first:**
```powershell
npm run compile
npm test
cd gpg-bridge-agent  && npm run test:integration
cd ../gpg-bridge-request && npm run test:integration
```

**Package both extensions:**
```powershell
cd c:\njs\gpg-bridge   # (after rename)
npm run package:agent
npm run package:request
```
Both must exit 0 and produce `.vsix` files.

**Inspect the VSIX contents** using `Expand-Archive` to verify correctness:
```powershell
# Extract agent VSIX to a temp folder
$vsix = Get-ChildItem gpg-bridge-agent\*.vsix | Select-Object -First 1
Expand-Archive -Path $vsix.FullName -DestinationPath "$env:TEMP\vsix-inspect" -Force

# Must be present: out/extension.js and must be non-trivially sized (bundled code)
Get-Item "$env:TEMP\vsix-inspect\extension\out\extension.js" | Select-Object Name, Length

# Must be absent: node_modules directory (proves vsce did not include deps)
Test-Path "$env:TEMP\vsix-inspect\extension\node_modules"   # Expected: False

# Must be absent: any path containing 'shared' from outside the extension root
Get-ChildItem "$env:TEMP\vsix-inspect" -Recurse -Filter "*.js" |
    Where-Object { $_.FullName -like '*shared*' } |
    Select-Object FullName

# Clean up
Remove-Item "$env:TEMP\vsix-inspect" -Recurse -Force
```

Repeat inspection for `gpg-bridge-request`.

### Commit
```
build: add esbuild bundling to fix vsce path traversal
```

---

## Phase 3 — Publisher Identity

### Goal
Replace the placeholder `"local"` publisher with the real `diablodale` identity
so cross-extension dependencies resolve correctly and marketplace publish works.

### Steps

**3a.** Create marketplace publisher (manual, one-time):
```powershell
npx @vscode/vsce create-publisher diablodale
```
Or via browser: [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage) →
Create publisher → link to GitHub account `diablodale`.

**3b.** In all three extension `package.json` files, update:
- `"publisher": "local"` → `"publisher": "diablodale"`

**3c.** `gpg-bridge-request/package.json` `extensionDependencies`:
- `"local.gpg-agent-proxy"` → `"diablodale.gpg-bridge-agent"`

**3d.** `pack/package.json` `extensionPack`:
- `"local.gpg-agent-proxy"` → `"diablodale.gpg-bridge-agent"`
- `"local.gpg-request-proxy"` → `"diablodale.gpg-bridge-request"`

**3e.** Align `@types/node` across all workspaces. Currently diverged:
- `gpg-bridge-agent`: `^22.19.9`
- `gpg-bridge-request`: `22.x`
- root: `^25.2.1`

Standardize to `^22.x` everywhere. VS Code's bundled Node.js runtime is v22;
matching this version avoids type mismatches and ensures API compatibility.

### Verification gate
```powershell
npm install   # picks up @types/node version changes
npm run compile
npm test
cd gpg-bridge-agent  && npm run test:integration
cd ../gpg-bridge-request && npm run test:integration
```

Spot-check: re-run `npm run package:agent`, unzip the VSIX, confirm
`extension/package.json` inside shows `"publisher": "diablodale"`.

### Commit
```
feat: set publisher identity to diablodale, align @types/node
```

---

## Phase 4 — Quality Files

### Goal
Produce the assets required for a credible marketplace listing: icon, polished
READMEs, structured CHANGELOG, and a CONTRIBUTING guide.

### Steps

**4a. Icon** — create a single 128×128 PNG icon (GPG key / padlock motif).
One icon is shared across all three extensions. Place it as:
- `gpg-bridge-agent/icon.png`
- `gpg-bridge-request/icon.png`
- `pack/icon.png`

Reference from each `package.json`:
```json
"icon": "icon.png"
```

vsce requires the icon to be inside the extension folder; it cannot be a shared
symlink. Either copy the file or add a root-level build step to copy it.
Add `icon.png` to each extension's `.vscodeignore` exclusion allowlist by
ensuring it is **not** excluded (the default `.vscodeignore` does not exclude PNGs).

**4b. READMEs** — polish all three:
- Feature list and use-case description
- Installation instructions (marketplace + manual VSIX)
- Configuration reference (settings keys, defaults, descriptions)
- Command palette reference
- Architecture note (two-extension model, why it exists)
- Badge row: build status, VS Code marketplace version, license
  (badge URLs confirmed once marketplace IDs are live after Phase 5)

**4c. CHANGELOG.md** — restructure to [Keep a Changelog](https://keepachangelog.com) format:
```markdown
## [Unreleased]
## [0.1.0] - YYYY-MM-DD
### Added
- Initial public release
```

**4d. CONTRIBUTING.md** (new file at repository root):
- Prerequisites (Node.js, VS Code, Gpg4win on Windows)
- Dev setup: `git clone`, `npm install`, `npm run watch`
- Build: `npm run compile`
- Test: `npm test` (unit) + per-extension integration test commands
- VSIX packaging: `npm run package:agent`, `npm run package:request`
- Commit conventions (Conventional Commits v1, GPG signing requirement)
- PR guidelines

### Verification gate
```powershell
npm run compile
npm test
cd gpg-bridge-agent  && npm run test:integration
cd ../gpg-bridge-request && npm run test:integration
```
Also verify both VSIXs still build cleanly after icon and package.json changes:
```powershell
npm run package:agent
npm run package:request
```

### Commit
```
docs: add icon, polish READMEs, add CONTRIBUTING, restructure CHANGELOG
```

---

## Phase 5 — First Publish (bootstrap)

### Goal
Publish v0.1.0 to the VS Code marketplace and create a GitHub Release with all
three VSIX artifacts attached.

> **This is the only manual publish.** Phase 6 sets up `release-please` so that
> all future releases (v0.1.1, v0.2.0, etc.) are triggered by merging an
> auto-generated PR on GitHub — no manual version bumping or tagging required.

### Steps

**5a.** Bump version to `0.1.0` in lockstep across all four `package.json` files:
- `gpg-bridge-agent/package.json`
- `gpg-bridge-request/package.json`
- `pack/package.json`
- root `package.json`

**5b.** Confirm `"preview"` is absent from all extension `package.json` files.
(Decided: remove `"preview": true` — extension is functional and tested.)

**5c.** Produce final VSIXs:
```powershell
npm run package:agent
npm run package:request
cd pack && npx vsce package
```

**5d.** Authenticate vsce locally before publishing. The `VSCE_PAT` CI secret
does not exist yet (that is Phase 6), so use a personal access token directly.
Create a PAT now following the same Azure DevOps steps described in Phase 6 step
6e — you can reuse this same token when setting up the GitHub secret in Phase 6.
Then authenticate:
```powershell
$env:VSCE_PAT = "<your-azure-devops-pat>"
```
vsce reads this environment variable automatically during `vsce publish`.

**5e.** Publish to marketplace in dependency order (agent must exist before
request can declare `extensionDependencies`):
```powershell
cd gpg-bridge-agent      && npx vsce publish
cd ../gpg-bridge-request && npx vsce publish
cd ../pack               && npx vsce publish
```

**5f.** Update README badge URLs now that marketplace IDs are live.

**5g.** Create GitHub Release manually (bootstrap only — Phase 6 automates this):
- On GitHub: Releases → Draft a new release
- Tag: `v0.1.0` (create the tag here — this is the only time a `v*` tag is
  created manually; after Phase 6, release-please creates tags automatically)
- Title: `v0.1.0 — Initial release`
- Body: paste the `[0.1.0]` section from CHANGELOG.md
- Attach all three `.vsix` files as release assets

### Verification gate
```powershell
npm run compile
npm test
cd gpg-bridge-agent      && npm run test:integration
cd ../gpg-bridge-request && npm run test:integration
```

### Commit
```
chore: bump version to 0.1.0 for first release
```

---

## Phase 6 — CI/CD and Automated Releases

### Goal
Add three GitHub Actions workflows:
1. **CI** — validate every push and PR (build + test)
2. **Publish** — package and publish to marketplace when a `v*` tag is pushed
3. **release-please** — automatically open and maintain a "Release PR" after
   every merge to `main`, so future releases require only merging that PR

### Background: GitHub Actions and bots

GitHub Actions are automated workflows defined as YAML files in `.github/workflows/`.
Each file declares *when* it runs (triggers) and *what it does* (steps). Steps can
run shell commands, call pre-built actions from the GitHub Actions Marketplace, or
interact with the GitHub API.

`release-please` is a pre-built action (`googleapis/release-please-action`) that
acts as a bot. After every merge to `main` it:
1. Reads your git commit messages since the last release tag
2. Determines the next semver version from Conventional Commit prefixes
   (`fix:` → patch, `feat:` → minor, `feat!:` / `BREAKING CHANGE:` → major)
3. Opens (or updates) a single PR titled e.g. `chore: release 0.2.0`
4. That PR contains: bumped versions in all tracked `package.json` files +
   a new `CHANGELOG.md` section generated from the commit messages
5. When **you merge that PR**, release-please creates a `v0.2.0` tag
6. The `publish.yml` workflow detects the new tag and fires automatically

You never write version numbers or CHANGELOG entries by hand after Phase 6.

### Steps

**6a.** Create `release-please-config.json` at the repository root. This tells
release-please which `package.json` files to bump (lockstep — all share one version):
```json
{
  "$schema": "https://wdcp.dev/release-please-config.schema.json",
  "release-type": "node",
  "packages": {
    ".": {},
    "gpg-bridge-agent": {},
    "gpg-bridge-request": {},
    "pack": {}
  },
  "linked-versions": true
}
```
`"linked-versions": true` keeps all four packages at the same version — matching
the lockstep versioning policy established in Phase 5.

**6b.** Create `.release-please-manifest.json` at the repository root. This is
release-please's state file — it records the current version of each package so
it knows what to bump from. After the Phase 5 publish it should be:
```json
{
  ".": "0.1.0",
  "gpg-bridge-agent": "0.1.0",
  "gpg-bridge-request": "0.1.0",
  "pack": "0.1.0"
}
```

**6c.** Create `.github/workflows/release-please.yml`:
```yaml
name: release-please
on:
  push:
    branches: [main]
jobs:
  release-please:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: googleapis/release-please-action@v4
        with:
          config-file: release-please-config.json
          manifest-file: .release-please-manifest.json
```
`permissions: contents: write` allows the bot to create tags and update files.
`permissions: pull-requests: write` allows the bot to open and update the release PR.

**6d.** Create `.github/workflows/ci.yml` — triggers on every push and PR to `main`:
- Runner: `ubuntu-latest`
- Steps: checkout → Node.js 22 setup → `npm install` → `npm run compile` →
  `npm test` → integration tests for both extensions
- Annotates test failures inline in the PR diff

**6e.** Create a Marketplace publish token and store it as a GitHub Actions secret
(manual, one-time). The VS Code Marketplace runs on Azure DevOps infrastructure,
so the token is created at Azure DevOps — not on GitHub or the marketplace page.

*Step 1 — Create the Azure DevOps PAT:*
1. Sign into [dev.azure.com](https://dev.azure.com) with the Microsoft account
   linked to the `diablodale` marketplace publisher
2. Top-right avatar → **Personal access tokens** → **New Token**
3. Name: `vsce-publish` (or any descriptive label)
4. Organization: `All accessible organizations`
5. Scopes: select **Custom defined** → tick **Marketplace → Publish** only
6. Click Create — **copy the token value immediately**, Azure shows it only once

*Step 2 — Store it as a GitHub repository secret:*
1. GitHub → repository Settings → Secrets and variables → Actions →
   **New repository secret**
2. Name: `VSCE_PAT`
3. Value: paste the Azure DevOps token from Step 1

The secret name `VSCE_PAT` is a convention from the vsce docs. It must match
what the `publish.yml` workflow references. The token never appears in code.

**6f.** Create `.github/workflows/publish.yml` — triggers when release-please
pushes a `v*` tag (which happens when the release PR is merged):
- Runner: `ubuntu-latest`
- Steps:
  1. Checkout
  2. Node.js 22 setup
  3. `npm install`
  4. `npm run compile` + `npm test` — abort if tests fail
  5. `npm run package:agent` + `npm run package:request` + `cd pack && npx vsce package`
  6. Publish all three via `npx vsce publish` using the `VSCE_PAT` secret (created in 6e)
  7. Create GitHub Release via `gh` CLI, attach all three `.vsix` files,
     and use the CHANGELOG section for the release body

> **Note: GPG signing and bot commits**
> You sign all local commits with your personal GPG key. release-please creates
> commits via the GitHub API using the automatic `GITHUB_TOKEN` — GitHub signs
> those commits with its own web-flow GPG key. On GitHub they appear with a green
> **Verified** badge, just signed by `GitHub` rather than by you. This is normal
> and expected for any bot-created commit. The merge commit when you click Merge
> on the release PR is similarly signed by GitHub's key, not yours.
>
> **Important**: the `release-please.yml` workflow must use `GITHUB_TOKEN` (the
> default automatic token) and not a custom PAT. Only `GITHUB_TOKEN`-based commits
> receive GitHub's web-flow signature. If you ever enable the `Require signed
> commits` branch protection rule on `main`, bot commits made via `GITHUB_TOKEN`
> will satisfy it; commits made via a custom PAT will not.

**6g.** Add `npm-run-all2` to root `devDependencies`. This replaces any
platform-specific parallel script runners so `npm run watch` works identically
on Windows (your dev machine) and Linux (CI runners):
```powershell
npm install --save-dev npm-run-all2
```
Update the root `watch` script to use `run-p` (parallel) from `npm-run-all2`.

### Future release workflow (after Phase 6 is complete)

Every future release follows this process — no manual version editing:

1. Write code, commit with Conventional Commit messages, push to `main`
2. `release-please.yml` runs automatically, opens or updates a release PR
3. When you are ready to release: go to GitHub, find the release PR, review
   the auto-generated CHANGELOG and version bump, merge it
4. release-please creates the `v*` tag automatically
5. `publish.yml` detects the tag, runs tests, packages all three VSIXs,
   publishes to marketplace, and creates the GitHub Release with attachments

### Verification gate
```powershell
npm run compile
npm test
cd gpg-bridge-agent      && npm run test:integration
cd ../gpg-bridge-request && npm run test:integration
```
Push a commit to `main` using a Conventional Commit prefix — release-please only
opens a release PR when it sees at least one qualifying commit since the last tag.
A minimal test commit:
```powershell
git commit --allow-empty -m "fix: verify release-please workflow"
git push
```
Then confirm in the GitHub Actions tab:
- `ci.yml` run passes
- `release-please.yml` run passes and opens a release PR titled `chore: release 0.1.1`
- The release PR diff shows a version bump from `0.1.0` → `0.1.1` and a
  CHANGELOG entry for the test fix commit

Do **not** merge that PR — it exists only to verify the workflow. Close it
without merging (release-please will reopen it with correct content when real
commits accumulate).

To verify `publish.yml` without publishing: inspect the workflow YAML and
 confirm the `VSCE_PAT` secret is accessible (GitHub shows whether a secret
exists without revealing its value).

### Commit
```
ci: add GitHub Actions for CI, publish on tag, and release-please automation
```

---

## Files Changed Summary

| File / Path | Phase | Change type |
|-------------|-------|-------------|
| `agent-proxy/` → `gpg-bridge-agent/` | 1 | `git mv` |
| `request-proxy/` → `gpg-bridge-request/` | 1 | `git mv` |
| Root `package.json` | 1, 2 | Name, scripts, clean globs |
| `gpg-bridge-agent/package.json` | 1, 2, 3, 5 | Name, commands, scripts, deps, publisher, version |
| `gpg-bridge-request/package.json` | 1, 2, 3, 5 | Name, commands, scripts, deps, publisher, api:none, version |
| `shared/package.json` | 1 | Package name |
| `pack/package.json` | 1, 3, 4, 5 | Name, publisher, extensionPack IDs, icon, version |
| All `*.ts` source files | 1 | Command IDs, config keys, import paths, UI strings |
| All `*.ts` test + integration files | 1 | Command IDs, import paths |
| `gpg-bridge-agent/esbuild.js` (new) | 2 | Bundler config |
| `gpg-bridge-request/esbuild.js` (new) | 2 | Bundler config |
| Both `.vscodeignore` files | 2 | Add `node_modules/**` |
| `AGENTS.md` | 1 | Command IDs, import paths, workspace path |
| `CHANGELOG.md` | 1, 4 | Name refs, Keep-a-Changelog format |
| `README.md` × 3 | 1, 4 | Name refs, commands, config keys, polish, badges |
| `icon.png` × 3 (new) | 4 | 128×128 PNG in each extension root |
| `CONTRIBUTING.md` (new) | 4 | Dev setup, build, test, commit conventions |
| `.github/workflows/ci.yml` (new) | 6 | CI on push/PR |
| `.github/workflows/publish.yml` (new) | 6 | Publish on `v*` tag |
| `.github/workflows/release-please.yml` (new) | 6 | Release PR bot |
| `release-please-config.json` (new) | 6 | Monorepo version bump config |
| `.release-please-manifest.json` (new) | 6 | Release-please state file |

---

## Out of Scope

The following topics were considered during planning but are intentionally
excluded from this plan. Each is a candidate for a follow-on plan.

### VSIX-based integration tests
The current integration test suite loads extensions via
`--extensionDevelopmentPath` pointing at the compiled `out/` directory.
A separate test tier that installs the produced `.vsix` artifact and runs
against it would catch packaging bugs (wrong `.vscodeignore`, esbuild
omitting a module, bad `package.json` manifests) that the current suite
cannot detect. This requires restructuring the `runTest.ts` launch scripts,
adding a CI artifact stage, and defining smoke-test entry points — a
non-trivial effort that does not block first publish.

### Windows-specific CI runner
Phase 6 uses `ubuntu-latest`. A separate Windows runner job would validate
that the GPG4Win integration paths and socket file parsing work correctly in
CI, not just in local developer environments.


