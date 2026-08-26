# Contributing

AliasMode is in an early beta. Open an issue before starting a large change.

## Development

```sh
bun install
bun test
```

Keep changes small and focused. Add tests for behavior changes. Do not commit generated browser data, profile exports, credentials, environment files, diagnostics, or binaries.

## Release notes

Each published GitHub Release must contain one to three important user-visible changes in this exact format:

```md
## Highlights
- First important change.
- Second important change.
```

AliasMode displays only the first three plain-text dash bullets from this section in the in-app updater.

## Pull requests

- Explain the user-visible change.
- Include relevant test results.
- Preserve Local mode's no-Cloud behavior.
- Avoid unrelated refactors.
- Do not add cloud-service implementation or production infrastructure to this repository.

Security issues must follow [SECURITY.md](SECURITY.md).
