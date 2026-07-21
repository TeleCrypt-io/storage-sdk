# TeleCrypt.io Storage

End-to-end encrypted file storage and sharing, built on Matrix.

Files are encrypted on the client before upload. The server stores only opaque ciphertext and
never holds the decryption keys.

**Status:** early development. Not yet usable.

## How it works

Built on [MSC3089](https://github.com/matrix-org/matrix-spec-proposals/pull/3089), which models
a file tree using Matrix primitives:

| File-system concept | Matrix concept |
|---|---|
| Folder | A Space (room marked as a file tree) |
| Subfolder | A child Space |
| File | An event pointing at encrypted uploaded content |
| Version | A newer event superseding the old |
| Sharing | Room invitation |
| Permissions | Power levels |

Encryption uses the same scheme as Matrix attachments (AES-CTR with a per-file key, keys
distributed via the room's Megolm session). Requires no server-side changes — it runs against
stock Synapse.

## Development

```bash
npm install
npm run synapse:up     # disposable local Synapse for tests
npm test
npm run synapse:down
```

Tests run against a real local Synapse in Docker, never against a production server.

See [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) for the phased build plan.

## Licence

[Business Source License 1.1](./LICENSE). Non-commercial use is permitted; converts to
Apache License 2.0 on 2030-07-20.

For commercial licensing, contact TeleCrypt.io.

## Third-party code

- [`matrix-js-sdk`](https://github.com/matrix-org/matrix-js-sdk) — Apache-2.0 — dependency
- [`matrix-files-sdk`](https://github.com/matrix-org/matrix-files-sdk) — Apache-2.0 — reference
- [`files-sdk-demo`](https://github.com/vector-im/files-sdk-demo) — AGPL-3.0 — **not used**;
  incompatible with this project's licence
