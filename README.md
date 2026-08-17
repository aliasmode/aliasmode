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

## Browser runtime

AliasMode installs CloakBrowser through its approved official installer and pins the resulting executable hash. The CloakBrowser binary is not part of this repository or the Apache-2.0 license.

## Security

For product help, email [support@aliasmode.com](mailto:support@aliasmode.com). Report vulnerabilities privately to [security@aliasmode.com](mailto:security@aliasmode.com) using the process in [SECURITY.md](SECURITY.md). Do not include cookies, passwords, proxy credentials, TOTP seeds, profile exports, or diagnostic archives in public issues.

## License

AliasMode client source is licensed under [Apache-2.0](LICENSE). Third-party components and the CloakBrowser runtime retain their own licenses.

Built by the Xreacher team.
