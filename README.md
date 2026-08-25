# TeleCrypt.io Storage

[![npm](https://img.shields.io/npm/v/@telecrypt-io/storage)](https://www.npmjs.com/package/@telecrypt-io/storage)

End-to-end encrypted file storage and sharing, built on Matrix.

Files are encrypted on the client before upload. The server stores only opaque ciphertext and
never holds the decryption keys. Shared vaults let multiple people add and read files, and a
Recovery Key restores your files on a new device — even if you lose the original.

This repository publishes the library package from annotated exact-version tags whose resulting
GitHub Release is immutable, with NPM Trusted Publishing/OIDC provenance. The command-line client
is maintained in its own repository.

## Install

```bash
npm install @telecrypt-io/storage@0.5.8
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

The recommended constructors configure the Matrix client with the SDK's bounded, manual-redirect
transport and finite request deadline. The public `new TeleCryptIOStorage(client)` constructor is
an advanced escape hatch: it does not rewrite matrix-js-sdk internals. Callers using it must build
the client through matrix-js-sdk's supported `createClient` options (`fetchFn` and
`localTimeoutMs`) and remain responsible for the safety of other Matrix SDK requests. SDK methods
that need the authenticated transport fail closed when it is unavailable; they do not silently
install a private transport configuration.

Same-name vault/folder creation is serialized within one `TeleCryptIOStorage` instance, but
each call creates a distinct room. Display names are labels, not identities, and Matrix
provides no server-side room-creation idempotency key.

## OIDC API

The SDK owns the browser authorization-code PKCE context in `sessionStorage` and provides device-code,
discovery, dynamic registration, identity confirmation, and refresh helpers. OAuth metadata, token
scopes, Matrix user/device identities, redirects, and response bodies are validated and bounded before
they are returned. Network-bound helpers accept `AbortSignal` where cancellation is meaningful; token
refresh uses a public client and persists the resulting token pair through the caller's callback.

The command-line client is sourced by
[`TeleCrypt-io/storage-cli`](https://github.com/TeleCrypt-io/storage-cli). The static web
application is sourced by
[`TeleCrypt-io/storage.telecrypt.io`](https://github.com/TeleCrypt-io/storage.telecrypt.io).

### 0.5 OIDC migration

Version 0.5 targets Matrix JS SDK 42 and the stable Matrix OAuth metadata endpoint. Existing
integrations must use the current `createFromOidc` options and pass the confirmed Matrix user ID,
device ID, and access token returned by the login flow. Replace old Matrix SDK OIDC imports and
private HTTP discovery with `discoverOidcIssuer`, `registerClient`, the device-code or PKCE flow
helpers, and `whoAmI` from `core/oidc`; the discovery URL is the stable
`/_matrix/client/v1/auth_metadata` endpoint. Refresh integration uses
`buildTokenRefreshFunction` as the current `tokenRefreshFunction` callback and must persist the
returned token pair before reporting success. The SDK no longer carries pre-0.5 compatibility
paths, so no adapter-side shim is required or supported. Discovery accepts providers that omit
`revocation_endpoint`; revocation is only an opportunistic cleanup path after refresh persistence
fails. Device-code sessions retain their requested device ID in-process; callers that reconstruct a
session must pass its expected device ID to `waitForDeviceCodeLogin`. `buildTokenRefreshFunction`
always requires the expected device ID because a reconstructed refresh callback has no safe implicit
binding. Returned OAuth scopes are rejected unless they match that intended Matrix device exactly.

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

### Deletion

Vaults and folders are deleted only when they are empty. Delete each file first; deleting a file
also removes its complete Matrix version chain and reports a typed partial result if cleanup stops
after some versions. Delete empty child folders before deleting their parent. A nonempty delete
fails with `NonEmptyTreeError`, so a shared or nested tree is never removed implicitly.

Encryption uses the same scheme as Matrix attachments (AES-CTR with a per-file key, keys
distributed via the room's Megolm session). File deletion uses TeleCrypt's authenticated Synapse
storage extension to remove the local media and thumbnail objects before Matrix redaction; stock
Synapse without that extension cannot provide the SDK deletion contract.

## Development

```bash
npm ci --ignore-scripts --no-fund --no-audit
npm run synapse:up     # disposable local Synapse/MAS fixture
npm test
npm run synapse:down
# For a complete reset, use ./throwaway_synapse/down.sh --wipe.
```

Tests run against a real local Synapse/MAS fixture in Podman, never against a production server.

See [RELEASING.md](./RELEASING.md) for the guarded npm release procedure.

## Licence

[Business Source License 1.1](./LICENSE). Non-commercial use is permitted; converts to
Apache License 2.0 on 2030-07-20.

For commercial licensing, contact TeleCrypt.io.

## Third-party code

- [`matrix-js-sdk`](https://github.com/matrix-org/matrix-js-sdk) — Apache-2.0 — dependency
- [`matrix-encrypt-attachment`](https://github.com/matrix-org/matrix-encrypt-attachment) — Apache-2.0 — dependency
