# TeleCrypt.io Storage

[![npm](https://img.shields.io/npm/v/@telecrypt-io/storage)](https://www.npmjs.com/package/@telecrypt-io/storage)

End-to-end encrypted file storage and sharing, built on Matrix.

Files are encrypted on the client before upload. The server stores only opaque ciphertext and
never holds the decryption keys. Shared vaults let multiple people add and read files, and a
Recovery Key restores your files on a new device — even if you lose the original.

This repository publishes the library package from protected exact-version tags with NPM Trusted
Publishing/OIDC provenance. The command-line client is maintained in its own repository.

## Install

```bash
npm install @telecrypt-io/storage@0.4.0
```

This gives you the `TeleCryptIOStorage` library and its browser-safe `core` API.

## Quick start

**Library:**

```ts
import { TeleCryptIOStorage } from "@telecrypt-io/storage";
import * as core from "@telecrypt-io/storage/core";

const storage = await TeleCryptIOStorage.create({
  baseUrl, userId, accessToken, deviceId,
});
const vault = await core.createVault(storage, "Photos");
await core.uploadFile(storage, vault.id, "cat.jpg", bytes, "image/jpeg");
```

The command-line client is sourced by
[`TeleCrypt-io/storage-cli`](https://github.com/TeleCrypt-io/storage-cli). The static web
application is sourced by
[`TeleCrypt-io/storage.telecrypt.io`](https://github.com/TeleCrypt-io/storage.telecrypt.io).

## How it works

Built on [MSC3089](https://github.com/matrix-org/matrix-spec-proposals/pull/3089), which models
a file tree using Matrix primitives:

| Storage concept | Matrix concept |
|---|---|
| Vault | A Space (room marked as a file tree) |
| Folder | A child Space |
| File | An event pointing at encrypted uploaded content |
| Version | A newer event superseding the old |
| Sharing | Room invitation |
| Permissions | Power levels |

Encryption uses the same scheme as Matrix attachments (AES-CTR with a per-file key, keys
distributed via the room's Megolm session). Requires no server-side changes — it runs against
stock Synapse.

## Development

```bash
npm ci
npm run synapse:up     # disposable local Synapse/MAS fixture
npm test
npm run synapse:down
```

Tests run against a real local Synapse/MAS fixture in Podman, never against a production server.

See [RELEASING.md](./RELEASING.md) for the guarded npm release procedure.

## Licence

[Business Source License 1.1](./LICENSE). Non-commercial use is permitted; converts to
Apache License 2.0 on 2030-07-20.

For commercial licensing, contact TeleCrypt.io.

## Third-party code

- [`matrix-js-sdk`](https://github.com/matrix-org/matrix-js-sdk) — Apache-2.0 — dependency
- [`matrix-files-sdk`](https://github.com/matrix-org/matrix-files-sdk) — Apache-2.0 — reference
- [`files-sdk-demo`](https://github.com/vector-im/files-sdk-demo) — AGPL-3.0 — **not used**;
  incompatible with this project's licence
