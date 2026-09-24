# TeleCrypt.io Storage

[![npm](https://img.shields.io/npm/v/@telecrypt-io/storage)](https://www.npmjs.com/package/@telecrypt-io/storage)

A JavaScript/TypeScript SDK for encrypted Matrix file trees, based on
[MSC3089](https://github.com/matrix-org/matrix-spec-proposals/pull/3089), an open and currently
unmerged Matrix proposal.

## Install

```bash
npm install @telecrypt-io/storage
```

## Browser quick start

The example below starts with an authenticated OIDC session. Obtain `userId`, `accessToken`, and
`deviceId` from that completed session. `baseUrl` and `serverName` must come from trusted
application configuration for the same Matrix deployment; do not accept them from an untrusted
request.

```ts
import { TeleCryptIOStorage } from "@telecrypt-io/storage";
import * as core from "@telecrypt-io/storage/core";

// baseUrl/serverName come from trusted application configuration.
// userId/accessToken/deviceId come from completed OIDC authentication.
const storage = await TeleCryptIOStorage.create({
  baseUrl, serverName, userId, accessToken, deviceId,
});
try {
  const vault = await core.createVault(storage, "Example");
  const file = await core.uploadFile(
    storage, vault.id, "hello.txt",
    new TextEncoder().encode("Hello"), "text/plain",
  );
  const downloaded = await core.downloadFile(storage, vault.id, file.id);
  console.log(new TextDecoder().decode(downloaded.bytes));
} finally {
  storage.getClient().stopClient();
}
```

`TeleCryptIOStorage.create` initializes the Matrix client and its persistent browser crypto store
by default. Browser persistence uses IndexedDB and the Matrix Rust crypto WASM runtime, so this
example assumes a browser environment. OIDC discovery, login, refresh, and the corresponding
`createFromOidc` inputs are exported from `@telecrypt-io/storage/core`.

The example creates retained Matrix rooms and encrypted media. Delete its file and then its empty
vault when finished; cleanup is part of the operation, not an automatic consequence of stopping
the client.

## Storage model and behavior

The SDK maps the file tree to Matrix primitives defined by MSC3089:

- A vault is a Matrix Space room marked as a file tree.
- A folder is a child Space in that tree.
- A file is a Matrix event referring to encrypted uploaded content.
- Sharing uses Matrix room invitations and permissions use Matrix power levels.

Vault, folder, and file IDs are opaque Matrix room and event IDs. Names are display labels: two
objects with the same name are still distinct, and a name is not an idempotency key.

Vault and folder names, and file names, are stored in encrypted room messages. Matrix room names
remain the generic `Encrypted storage`; file-listing state stores only an event pointer, and media
uploads omit the original filename. Use the asynchronous operations in `@telecrypt-io/storage/core`
to read names. The synchronous Matrix SDK tree helper cannot decrypt on demand and exposes a generic
file label until an async operation resolves the name. This is a TeleCrypt metadata format: standard
MSC3089 clients will not display the private names or understand these file indexes. SDK 0.8 starts
this format without a reader or migration for trees written by older SDK versions; those old trees
may be ignored or removed.

File bytes are encrypted in the client before upload with Matrix attachment encryption (AES-CTR
and a per-file key distributed through the room's Megolm session). The server stores encrypted
media and Matrix events, but encryption does not hide all room, event, or other metadata from the
server or users who can read the room.

The Decryption Key Safe is mandatory before the public core storage operations. Inspect
`storage.keySafe.getStatus(signal?)`. For `setup-required`, call `setup(signal?)`, offer the returned
`recoveryKey` for copying/saving, explain that losing both this key and local decryption keys can
make files permanently unreadable, and require an explicit saved-key acknowledgement before
`confirmSaved(signal?)`. `confirmation-required` returns the same pending key after interruption.
For `restore-required`, call `restore(recoveryKey, signal?)` with the existing key; this restores
room keys and signs the current login using the existing account keys. Normal use requires `ready`.
Setup and restore never replace an existing safe or account signing identity. Resetting the account
password cannot recover encrypted files.

Pending setup state is kept beside the login's IndexedDB crypto data. A platform that snapshots
IndexedDB to disk, such as the CLI, must supply `onKeySafeStateChanged` at creation and durably flush
its snapshot before resolving that callback. Key Safe methods accept an optional `AbortSignal`.
The safe, signing keys, and saved-key acknowledgement are shared SDK behavior rather than separate
Web/CLI implementations.

Sharing uses Matrix's native encrypted-history bundle exchange. Both users must have completed
their account signing setup. An invitation alone does not establish successful history sharing:
the SDK checks native recipient-device eligibility afterward and reports partial completion if
keys could not be shared. An upload restriction can reject the encrypted history bundle upload;
the error is preserved, including when retrying an existing invitation.

Deletion has strict ordering. Delete files before their folders or vaults because folders and
vaults must be empty. File deletion removes the encrypted media object before redacting its Matrix
event and requires TeleCrypt's Synapse storage extension; stock Synapse cannot provide that
deletion contract.

## Source repositories

- Web application: [`TeleCrypt-io/storage`](https://github.com/TeleCrypt-io/storage)
- Command-line client: [`cli/`](https://github.com/TeleCrypt-io/storage/tree/main/cli)

## License

See [`LICENSE`](./LICENSE) for the complete terms. The current license is Business Source License
1.1 with an additional grant for non-commercial use; it is not an open-source license. The stated
Change Date is 2030-07-20, and the Change License is Apache License 2.0. The license also changes
on the fourth anniversary of the first public distribution of a specific version if that occurs
before its stated Change Date. The full license controls in case of any discrepancy.
