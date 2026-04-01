# OpenCom Extensions

OpenCom scans this folder for extension projects.

## Folder layout

- `Extensions/Client/<extension-id>/extension.json`
- `Extensions/Server/<extension-id>/extension.json`
- `Extensions/lib/` contains the publishable `opencom-extension-sdk` package
- `Extensions/create-extension.sh` scaffolds a new extension with a manifest and starter entry

## Extension types

- Client extensions add functionality on the client side
- Server extensions run on server nodes and can expose commands plus configuration

## Command system

Server extensions can export a `commands` array. Commands are registered when the extension is enabled and can then be executed through the server node APIs.

## Config system

Server extension manifests can define `configDefaults`. Runtime config is stored per server and is available in commands and lifecycle hooks via `ctx.config.get`, `ctx.config.set`, and `ctx.config.patch`.

## Server admin integration

Server extensions are enabled per server in the Server Admin Panel under the Extensions section.

## SDK and documentation

- SDK package: `Extensions/lib`
- SDK guide: `../docs/extensions-sdk.md`

## Publishing SDK

The SDK under `Extensions/lib` is published by GitHub Actions workflow `.github/workflows/publish-extension-sdk.yml`.
