# TeleCrypt.io Storage

[![npm](https://img.shields.io/npm/v/@telecrypt-io/storage)](https://www.npmjs.com/package/@telecrypt-io/storage)

A JavaScript/TypeScript SDK for encrypted Matrix file trees, based on
[MSC3089](https://github.com/matrix-org/matrix-spec-proposals/pull/3089), an open and currently
unmerged Matrix proposal.

## Install

```bash
npm install @telecrypt-io/storage
```

The SDK supports Node.js `24.22.1` as its exact engine version. Its release tooling requires
npm `11.19.0`.

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

Applications that require the Decryption Key Safe before downloading room history can create the
client with `startClient: false`. Check its status and restore room keys first; `restore()` starts
sync after importing them so Matrix can publish this login's device keys and complete account
signing. For an already-ready safe, call `await storage.startSync()` after the status check. Keep
Storage operations locked until the Safe reports ready. The default is to start sync during
creation.

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

If an upload is rejected after media was accepted, the SDK removes that media and any acknowledged
attachment. A transport failure leaves accepted work intact. An upload `MutationPartialError`
retains `treeId` and `completedIds` in the order `[mediaId, attachmentEventId?]`. Keep those IDs;
do not repeat the upload blindly. To discard the partial upload, call
`core.cleanupFileUpload(storage, error.treeId, error.completedIds[0], error.completedIds[1])`.
Retry cleanup with the same IDs if it fails. A known attachment ID can also be passed to ordinary
`core.deleteFile` even when its listing was never committed. An initial media response lost before
the server returns any identifier still has an unknown outcome and cannot provide cleanup IDs.
Upload cancellation stops before the next write and waits for the current request's bounded
settlement so returned media/event IDs are retained. Keep observing the upload promise after
cancelling a UI wait or closing a view; persist any partial receipt for the originating account.

The Decryption Key Safe is mandatory before the public core storage operations. Inspect
`storage.keySafe.getStatus(signal?)`. For `setup-required`, call `setup(signal?)`, offer the returned
`recoveryKey` for copying/saving, explain that losing both this key and local decryption keys can
make files permanently unreadable, and require an explicit saved-key acknowledgement before
`confirmSaved(signal?)`. `confirmation-required` returns the same pending key after interruption.
For `restore-required`, call `restore(recoveryKey, signal?)` with the existing key; this restores
room keys and signs the current login using the existing account keys. Normal use requires `ready`.
Setup and restore never replace an existing safe or account signing identity. Resetting the account
password cannot recover encrypted files.

In SDK 0.10, `storage.keySafe` replaces `storage.keys.*`, `core.setupRecovery`, and
`core.restoreRecovery`; those obsolete entry points and their recovery-specific result/error types
have been removed. Use the setup, explicit `confirmSaved`, status and restore flow above. A returned
Recovery Key alone does not mean the user has saved it or that this login is ready. Existing saved
Recovery Keys, account signing keys and encrypted files remain valid; do not create a replacement Safe.

| Removed entry point | Replacement |
| --- | --- |
| `storage.keys.setupRecovery()` / `core.setupRecovery(storage)` | `storage.keySafe.setup()`, then `confirmSaved()` after the user saves the key |
| `storage.keys.getStatus()` / `isRecoverySetup()` | `storage.keySafe.getStatus()`; normal storage access requires `state === "ready"` |
| `storage.keys.restoreFromRecoveryKey(key)` / `core.restoreRecovery(storage, key)` | `storage.keySafe.restore(key)` |

Use `KeySafeStatus` instead of the former `RecoveryStatus` topology. Safe operations return their
typed results directly and report failures through `StorageError`; callers should no longer import
the removed `RecoverySetup`, `RecoveryRestore`, or `Recovery*Error` types.

Short-lived clients should call `storage.waitForKeyBackup(treeId, fileId?, options?)` after creating
or renaming encrypted metadata and before closing. Omit `fileId` for a vault or folder. This checks
the attachment and current name encryption sessions in the active server backup, including reused keys that produce no
new backup-progress event. If verification fails, retain the local profile and retry backup;
the metadata mutation has already committed.
For a partial rename, pass each retained backup target's `metadataEventId` in the existing options
object so verification includes the acknowledged event even if its pointer write failed.

Pending setup state is kept beside the login's IndexedDB crypto data. A platform that snapshots
IndexedDB to disk, such as the CLI, must supply `onKeySafeStateChanged` at creation and durably flush
its snapshot before resolving that callback. Key Safe methods accept an optional `AbortSignal`.
The safe, signing keys, and saved-key acknowledgement are shared SDK behavior rather than separate
Web/CLI implementations.

Sharing uses Matrix's native encrypted-history bundle exchange. `shareVault` assigns Viewer,
Editor, or Owner to the vault and its existing folders; callers default new shares to Viewer. Both
users must have completed their account signing setup. An invitation alone does not establish
successful history sharing: the SDK checks native recipient-device eligibility afterward and
reports partial completion if keys could not be shared. An upload restriction can reject the
encrypted history bundle upload; the error is preserved, including when retrying an existing
invitation. Changing the role of a joined member does not reinvite them or claim history-key
delivery. Matrix authorizes every permission and membership change, so a higher-powered member can
demote or remove an Owner while Matrix can deny an equal-power change. Partial outcomes retain the
rooms already changed.

Signing in on another device does not transfer key delivery queued for an offline device. A
Recovery Key restores only keys already backed up for the account; it cannot recover a room key
that was never received and backed up. If a download raises `UndecryptableFileError` after Safe
restoration, the room key may not have been delivered to that device; membership does not replay it.

`joinVault` accepts the vault and its linked folder invitations, including their history keys.
New folders inherit the parent's joined and invited readers; browsing accepts their folder
invitations. If reader access fails after folder creation, the partial-completion error retains
the created folder ID. Retry sharing the parent vault to complete access to that folder.
Unsharing bans the person from the selected folder and its descendants until an explicit share
unbans and invites them. Previously delivered keys remain usable. Inheritance checks for a child
ban before sharing or changing its role; Matrix does not make the membership check and a separate
power-level update atomic.

New Storage spaces use the upstream file-tree power-level template with the Storage file index and
encrypted metadata events writable by Editors. Room reads leave permissions and join rules
unchanged. An explicit role change converts only the known legacy owner-only template and preserves
member assignments; custom permission settings stay as configured. Roles are reported from native
effective power, including a room-v12 creator who has no explicit power-level entry. Matrix remains
the authority for each attempted change. Disabled Storage markers and deleted trees are not restored
automatically. Keep SDK, Web, and CLI clients current together once Editors have created file
metadata; older releases assume owner-only authorship.

Only the member who uploaded a file can delete its encrypted media, even when another Editor
renamed it. Completing deletion also requires native Matrix permission to redact the original file
message. Upstream defaults do not give Viewers that permission; a preserved custom power-level
configuration may. Storage uses the current Matrix capability to show the action, while Matrix
remains authoritative when it is attempted. Confirmed redaction of the original file message
removes it from Storage views and backup settlement. Deletion removes the encrypted media object
before redacting that message and requires TeleCrypt's Synapse storage extension; stock Synapse
cannot provide that deletion contract. Delete files before their folders or vaults because folders
and vaults must be empty.

## Source repositories

- Web application: [`TeleCrypt-io/storage`](https://github.com/TeleCrypt-io/storage)
- Command-line client: [`cli/`](https://github.com/TeleCrypt-io/storage/tree/main/cli)

## License

See [`LICENSE`](./LICENSE) for the complete terms. The current license is Business Source License
1.1 with an additional grant for non-commercial use; it is not an open-source license. The stated
Change Date is 2030-07-20, and the Change License is Apache License 2.0. The license also changes
on the fourth anniversary of the first public distribution of a specific version if that occurs
before its stated Change Date. The full license controls in case of any discrepancy.
