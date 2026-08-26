# AliasMode

AliasMode is a local-first browser profile manager with optional cloud synchronization for teams.

> **Status:** public Windows beta. Download the current installer from [aliasmode.com/download](https://aliasmode.com/download/).

## Modes

- **AliasMode Local:** no account and no AliasMode Cloud connection. Profiles stay on the computer.
- **AliasMode Cloud:** verified accounts, shared workspaces, portable profile synchronization, and device access controls.

Browser cache, history, downloads, and temporary files remain local in both modes.

## Current source

This repository contains the Apache-2.0 desktop client and local runtime:

- React dashboard
- Bun/TypeScript sidecar
- CloakBrowser process lifecycle
- Local SQLite profile storage
- Portable session capture and restore
- Optional AdsPower-compatible loopback API

The managed AliasMode Cloud service and production infrastructure are maintained separately.

## Development

Requirements:

- [Bun](https://bun.sh/)
- A supported CloakBrowser installation
- Rust and Tauri prerequisites for desktop builds

```sh
bun install
bun test
bun cli.ts start
```

The dashboard and compatibility API bind to loopback only.

### macOS source run

A supported macOS CloakBrowser executable can run through the local web dashboard without Tauri or a separate backend. Install Bun and Node.js 18 or newer (Node 22.23.2 is recommended), then run:

```sh
bun install --frozen-lockfile
export CLOAKBROWSER_BINARY_PATH="/path/to/CloakBrowser.app/Contents/MacOS/CloakBrowser"
export CLOAKBROWSER_BINARY_SHA256="$(shasum -a 256 "$CLOAKBROWSER_BINARY_PATH" | cut -d ' ' -f 1)"
bun run start
```

Open `http://127.0.0.1:50400`, select AliasMode Cloud, and sign in. Source mode keeps Cloud credentials in process memory, so sign in again after restarting AliasMode. Browser data and processes remain on the Mac.

### Windows desktop beta

Published installers support Windows 10 version 1809 or newer, Windows 11, and Windows Server 2019 or newer on x64 processors with SSE4.2. They install for the current user and remain unsigned while release signing is configured.

Desktop packaging requires Windows x64, Bun, the Rust MSVC toolchain, WebView2, and Visual Studio C++ Build Tools. The approved Alias Loop icon is included at `src-tauri/icons/icon.ico`.

```sh
bun run desktop:prepare
bun run desktop:build:nsis
```

The build obtains CloakBrowser through the pinned official wrapper, verifies the staged executable hash, and packages the separately licensed runtime as a third-party resource. AliasMode verifies the installed executable again before startup and before every browser launch.

### Import from Cloakpit

Close Cloakpit and all of its browsers. Then run:

```powershell
AliasMode.exe --import-cloakpit C:\Cloakpit
```

Use `--cloakpit-profile-root <dir>` if AliasMode reports browser data in multiple historical locations. Import works only into an empty Local destination on the same Windows machine and account because Windows DPAPI protects browser secrets. It preserves persisted persona data and session-bearing browser files, but runtime or browser differences can change the fingerprint visible to an account.

## Agent browser automation

The Windows installer includes `aliasmode-mcp.exe`. It connects AI agents to the free, open-source AliasMode client through local stdio MCP.

```powershell
& "$env:LOCALAPPDATA\AliasMode\aliasmode-mcp.exe" setup --client auto --yes --json
```

Setup configures Claude Code, Codex, OpenClaw, and Hermes when installed. Its JSON result also includes generic stdio MCP configuration. Restart an active agent harness after setup so it loads the new server.

Agents can create profiles, open several headful or headless browsers, select one browser, and use the full pinned Playwright MCP tool set. AliasMode remains responsible for browser processes, profile locks, Cloud sessions, capture, and safe close. Local mode needs no account and does not contact AliasMode Cloud.

Cloud mode can also expose one specific Windows installation to a remote Streamable HTTP MCP client. AliasMode must stay open on that Windows device. Create one revocable connector per client:

```powershell
$aliasmode = "$env:LOCALAPPDATA\AliasMode\aliasmode-mcp.exe"
& $aliasmode remote-mcp create --name "Linux Claude"
& $aliasmode remote-mcp list
& $aliasmode remote-mcp revoke --id <connector-id>
```

`create` returns the pinned device URL and bearer token once. Store the token in the remote client's secret header setting. Do not put it in scripts or logs. This beta uses bearer headers; OAuth-only web connectors are not supported yet. An offline device returns an error and never redirects work to another machine.

For the same installation session, the helper also provides JSON-only commands:

```powershell
$aliasmode = "$env:LOCALAPPDATA\AliasMode\aliasmode-mcp.exe"
& $aliasmode profiles list --json
& $aliasmode profiles create --name research --json
& $aliasmode browser open --profile <profile-id> --headless --json
& $aliasmode playwright run --profile <profile-id> --file .\task.mjs --json
& $aliasmode browser close --profile <profile-id> --json
```

The versioned bootstrap script tries winget first. It falls back to an exact GitHub Release installer and verifies its published SHA-256 manifest before installation. Unsigned beta installers can still require Windows SmartScreen or antivirus approval.

## Browser runtime

AliasMode installs CloakBrowser through its approved official installer and pins the resulting executable hash. The CloakBrowser binary is not part of this repository or the Apache-2.0 license.

## Security

For product help, email [support@aliasmode.com](mailto:support@aliasmode.com). Report vulnerabilities privately to [security@aliasmode.com](mailto:security@aliasmode.com) using the process in [SECURITY.md](SECURITY.md). Do not include cookies, passwords, proxy credentials, TOTP seeds, profile exports, or diagnostic archives in public issues.

## License

AliasMode client source is licensed under [Apache-2.0](LICENSE). Third-party components and the CloakBrowser runtime retain their own licenses.

Built by the Xreacher team.
