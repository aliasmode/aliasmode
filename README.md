# AliasMode

AliasMode is a local-first browser profile manager with optional cloud synchronization for teams.

> **Status:** early Windows beta. The desktop installer and AliasMode Cloud are under active development.

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

## Browser runtime

AliasMode installs CloakBrowser through its approved official installer and pins the resulting executable hash. The CloakBrowser binary is not part of this repository or the Apache-2.0 license.

## Security

Report vulnerabilities privately using the process in [SECURITY.md](SECURITY.md). Do not include cookies, passwords, proxy credentials, TOTP seeds, profile exports, or diagnostic archives in public issues.

## License

AliasMode client source is licensed under [Apache-2.0](LICENSE). Third-party components and the CloakBrowser runtime retain their own licenses.

Built by the Xreacher team.
