# Implementation Plan — TeleCrypt Secure Storage

**Read this whole file before writing any code.**

You are implementing a TypeScript client library for end-to-end-encrypted file storage on
Matrix. This document is self-contained: it assumes you have no prior context about this
project. Follow it step by step, in order. Do not skip ahead.

---

## 0. Ground rules

1. **Tests come first.** Every phase defines tests before implementation. Write the test,
   watch it fail, then write code until it passes. Do not write implementation code for a
   phase before that phase's tests exist.
2. **Never invent API calls.** If you are unsure whether a method exists, check the installed
   package under `node_modules/matrix-js-sdk/`. Do not guess method names.
3. **Do not modify files under `node_modules/`.**
4. **Never test against a production server.** Only the local Docker Synapse from Phase 0.
5. **If a step fails twice, stop and write the error into `BLOCKERS.md` with the exact command
   and output.** Do not improvise a workaround. Do not disable or skip a failing test to make
   the suite green.
6. **Commit after each phase passes**, with the message `Phase N: <short description>`.

### Definition of done for any phase
- All tests for that phase pass.
- No test is skipped, commented out, or marked `.todo`.
- `npm run lint` and `npm run build` both succeed.

---

## 1. What you are building

A library that lets a user store files in encrypted folders on a Matrix server, and share
those folders with other users.

The concepts map like this:

| File-system concept | Matrix concept |
|---|---|
| Folder / directory | A Matrix **Space** (a room marked as a file tree) |
| Subfolder | A child Space |
| File | A Matrix **event** in the space, pointing at uploaded encrypted content |
| File version | A newer event superseding the old one |
| Sharing | Inviting a Matrix user to the room |
| Permissions | Matrix power levels |

This design is called **MSC3089**. It is already implemented in the `matrix-js-sdk` package —
you are writing a friendlier wrapper around it, not implementing it from scratch.

**Encryption model:** file bytes are encrypted *before* upload. The server only ever stores an
opaque encrypted blob and never has the decryption key. This is non-negotiable — never send
unencrypted file bytes to the server in Phase 2 or later.

---

## 2. The API you will use

These are verified to exist in `matrix-js-sdk` v41. Use exactly these names.

### Getting a file tree

```ts
// Create a new top-level folder. Returns MSC3089TreeSpace.
const tree = await client.unstableCreateFileTree("My Folder");

// Get an existing one by room ID. Returns MSC3089TreeSpace | null.
const tree = client.unstableGetFileTreeSpace(roomId);
```

### `MSC3089TreeSpace` — a folder

```ts
tree.id                                   // string: the room ID
tree.isTopLevel                           // boolean
await tree.setName(name: string)
await tree.invite(userId: string, andSubspaces = true)
await tree.setPermissions(userId: string, role: TreePermissions)
tree.getPermissions(userId: string)       // returns TreePermissions
await tree.createDirectory(name: string)  // returns MSC3089TreeSpace (a subfolder)
tree.getDirectories()                     // returns MSC3089TreeSpace[]
tree.getDirectory(roomId: string)         // returns MSC3089TreeSpace | undefined
await tree.delete()
tree.getOrder()                           // number
await tree.setOrder(index: number)
tree.getFile(fileEventId: string)         // returns MSC3089Branch | null
tree.listFiles()                          // returns MSC3089Branch[]  (active files only)
tree.listAllFiles()                       // returns MSC3089Branch[]  (includes old versions)

await tree.createFile(
  name: string,
  encryptedContents: FileType,   // the ENCRYPTED bytes
  info: EncryptedFile,           // encryption metadata (key, iv, hashes)
  additionalContent?: IContent,
)                                // returns { event_id: string }
```

### `MSC3089Branch` — a file

```ts
branch.id                                 // string: the event ID
branch.isActive                           // boolean: false if deleted/superseded
branch.version                            // number
await branch.delete()
branch.getName()                          // string
await branch.setName(name: string)
branch.isLocked()                         // boolean
await branch.setLocked(locked: boolean)
await branch.getFileInfo()                // { info: EncryptedFile, httpUrl: string }  ⚠️ SEE §3
await branch.getFileEvent()               // returns MatrixEvent
await branch.getVersionHistory()          // returns MSC3089Branch[]
await branch.createNewVersion(name, encryptedContents, info, additionalContent?)
```

### `TreePermissions` (import from `matrix-js-sdk`)

```ts
enum TreePermissions {
  Viewer = "viewer",   // default
  Editor = "editor",   // ~power level 50
  Owner  = "owner",    // power level 100
}
```

### Encryption helpers (package: `matrix-encrypt-attachment`)

```ts
import { encryptAttachment, decryptAttachment } from "matrix-encrypt-attachment";

const encrypted = await encryptAttachment(data);   // data: ArrayBuffer
// encrypted.data -> ArrayBuffer (ciphertext)
// encrypted.info -> EncryptedFile (key material + hashes)

const plaintext = await decryptAttachment(ciphertext, info);  // returns ArrayBuffer
```

**Upload pattern** (encrypt, then hand ciphertext to `createFile`):

```ts
const encrypted = await encryptAttachment(data);
const { event_id } = await tree.createFile(
  name,
  Buffer.from(encrypted.data),
  encrypted.info,
  { info: { mimetype, size } },
);
```

---

## 3. ⚠️ Known traps — read before Phase 2

These will cost you hours if you hit them without warning.

### TRAP 1: `getFileInfo().httpUrl` returns a URL that 404s

`MSC3089Branch.getFileInfo()` builds its URL with `client.mxcUrlToHttp(file["url"])` and
**omits the authentication flag**. That produces a legacy `/_matrix/media/v3/download/...`
URL. Modern Synapse (v1.139+) requires *authenticated* media and returns **404 Not Found**
for those URLs. This is a real gap in the upstream library, not a mistake on your part.

**Do not use `httpUrl` from `getFileInfo()`.** Download like this instead:

```ts
const { info } = await branch.getFileInfo();   // use `info` — it is correct
const mxcUrl = info.url;                       // e.g. "mxc://server/mediaid"

// 7th positional arg = useAuthentication
const url = client.mxcUrlToHttp(mxcUrl, undefined, undefined, undefined, false, true, true);

const res = await fetch(url!, {
  headers: { Authorization: `Bearer ${client.getAccessToken()}` },
});
if (!res.ok) throw new Error(`media download failed: ${res.status}`);
const ciphertext = await res.arrayBuffer();
const plaintext = await decryptAttachment(ciphertext, info);
```

If you see a **404 on media download**, this is almost certainly the cause.

### TRAP 2: Rate limiting will break the test suite
Synapse rate-limits registration and messaging by default. A test suite creating users and
sending many events *will* start failing with `M_LIMIT_EXCEEDED`. The Phase 0 config disables
rate limiting. If you see `M_LIMIT_EXCEEDED`, the config was not applied — fix the config, do
not add sleeps to the tests.

### TRAP 3: Two users are mandatory
Sharing, permissions, and revocation cannot be verified from one account. A test that checks
"user A shared with user B" by asking A is not a real test. Always verify from **B's own
client session**.

### TRAP 4: State propagation is not instant
After an action (invite, permission change, new file), the other client may not see it
immediately — it arrives via sync. Use the `waitFor` helper from Phase 0. Never use a bare
`sleep` with a fixed duration.

### TRAP 5: Encryption is not optional after Phase 2
From Phase 2 onward, file bytes must be encrypted before upload. If a test writes plaintext
to the server it is wrong, even if it passes.

### TRAP 6: `getVersionHistory()` only searches the in-memory timeline
Verified in the v41 source: `MSC3089Branch.getVersionHistory()` walks
`room.getLiveTimeline().getEvents()` — only events currently loaded in memory. On a **fresh
client**, or once old events have paginated out, version history comes back **silently
incomplete** (no error, just missing versions). Every new version also writes two persistent
state events, so room state grows with each version and each file.

Consequence for Phase 4: do not test versioning only on the same client that created the
versions (its timeline is warm and the bug hides). Test that a **fresh** client for the same
user, after joining/syncing, recovers the *full* version chain. If it cannot, that is the bug —
document it in `BLOCKERS.md`; you may need to force a timeline back-pagination before calling
`getVersionHistory()`.

---

## 3B. Decisions the human owner must make before you start

These came out of a design review. They affect architecture, so they are settled by the
project owner, **not** by you. If any is still unanswered when you reach it, stop and put it in
`BLOCKERS.md` — do not pick a default.

1. **Maximum file size for v1.** Matrix caps uploads at `max_upload_size` (the test server is
   set to 100 MB). There is no chunking or resume in `m.file` or MSC3089. So v1 is limited to
   single-shot files under that cap. **Assume "documents and photos, ≤100 MB" unless told
   otherwise.** Multi-GB "Nextcloud-like" files require a chunking layer that is explicitly out
   of scope here — do not attempt it.

2. **Quota enforcement location — do not build quotas yet.** This server is stock Synapse with
   no custom enforcement module. Anything enforced only in this client library is trivially
   bypassed (a user can call Synapse directly with their own token). Real enforcement must live
   server-side (Synapse config or a module) and is **not designed yet**. Do not add
   client-side quota logic and call it enforcement — leave it out and note it.

3. **External share links (Phase 6) are NOT in your scope** — see §10. They need a separate
   design (a proxy with its own Synapse credentials, a token store, and a decision about
   serving the encrypted blob with the key in the URL fragment). Do not build them.

## 3C. Library API must cover tree discovery

A user's folders are Matrix rooms. Across a fresh session there is no magic index — the library
must be able to **enumerate the caller's file trees** by listing their joined rooms and
filtering for the MSC3089 tree marker. Your `TeleCryptIOStorage` API (Phase 1) must expose something
like `listTrees(): MSC3089TreeSpace[]`. Add a Phase 1 test that a *fresh* client for the same
user can find a tree created in an earlier session.

---

## 4. Phase 0 — Test harness

**Goal:** a working test harness against a real, disposable Synapse. No library code yet.

**Two things to understand before you start:**

- **The Synapse must be running before you run tests.** `npm test` does *not* start it. Always
  `npm run synapse:up` first. The clean-state command is
  `npm run synapse:down && npm run synapse:up && npm test`. It is left **off by default** — the
  owner does not keep it running between sessions.
- **No test users are pre-created, and you must not add any.** Every test registers its own
  users at runtime via `registerTestUser` (Step 0.3), each with a random suffix, so runs never
  collide and never depend on leftover state. Do not seed fixture users into the server.

**Preflight guard (required).** Add a Vitest `globalSetup` file that, before any test runs,
checks `GET http://localhost:8008/_matrix/client/versions` and — if it is unreachable — fails
immediately with a clear message: `Synapse not reachable at :8008 — run 'npm run synapse:up'
first`. This turns a cryptic connection-refused into an obvious instruction.

### Step 0.1 — Project setup

Create `package.json`:

```json
{
  "name": "@telecrypt-io/storage",
  "version": "0.1.0",
  "license": "BUSL-1.1",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "lint": "eslint src test --ext .ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "synapse:up": "./throwaway_synapse/up.sh",
    "synapse:fresh": "./throwaway_synapse/up.sh --fresh",
    "synapse:down": "./throwaway_synapse/down.sh"
  },
  "dependencies": {
    "matrix-js-sdk": "41.9.0",
    "matrix-encrypt-attachment": "1.0.3"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "@typescript-eslint/parser": "^8.0.0",
    "eslint": "^9.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.0.0"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"],
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "test"]
}
```

Run `npm install`. **Verify:** it completes with no errors.

### Step 0.2 — Disposable Synapse (already built — just run it)

**This is done for you.** The `throwaway_synapse/` directory already contains a working,
verified single-container Synapse launched via **podman** (not docker). Do not rebuild it.

```
throwaway_synapse/
  up.sh                    # generate config on first run, then start; --fresh wipes and regenerates
  down.sh                  # stop + remove container; --wipe also deletes ./data
  homeserver.extra.yaml    # test overrides: open registration + all rate limits disabled + 100M uploads
  data/                    # generated config, db, media (gitignored, owned by the container UID)
```

Run it via the npm scripts (they call the shell scripts above):

```bash
npm run synapse:up      # start (reuses ./data if present — fast)
npm run synapse:fresh   # wipe everything and regenerate from scratch
npm run synapse:down    # stop and remove the container
```

**Verified working:** after `npm run synapse:up`,
`curl http://localhost:8008/_matrix/client/versions` returns JSON with `"versions"`, and a
`POST /_matrix/client/v3/register` with `auth: { type: "m.login.dummy" }` successfully creates
users (proving open registration and disabled rate limits are in effect).

Notes that will save you time:
- **Rootless podman maps `data/` to the container's UID.** The host cannot edit or `rm` those
  files directly — that is why `up.sh`/`down.sh` do config-append and wipe *inside* a container
  (`podman unshare`). If you touch `data/` by hand you will hit "Permission denied"; use the
  scripts.
- The server name is `localhost` and it listens on `:8008`. Do not change these — the harness
  hardcodes them.
- There is **no MAS** in this test server — it uses Synapse's built-in registration/login.
  Production uses MAS; see §14 for why the suite must also run against production-like infra
  before launch.

### Step 0.3 — User provisioning helper

Create `test/harness/users.ts`. It must export:

```ts
export interface TestUser {
  userId: string;      // "@alice_abc123:localhost"
  accessToken: string;
  deviceId: string;
  password: string;
}

/** Registers a brand-new user with a random username. */
export async function registerTestUser(prefix: string): Promise<TestUser>;
```

Implement using the register endpoint directly:
`POST http://localhost:8008/_matrix/client/v3/register` with body
`{ username, password, auth: { type: "m.login.dummy" }, inhibit_login: false }`.
Use a random suffix so repeated runs never collide.

**Verify:** a scratch test registers two users and prints two distinct user IDs.

### Step 0.4 — Client session helper

Create `test/harness/clients.ts`, exporting:

```ts
/** Creates a started, encryption-ready client for a test user. */
export async function createTestClient(user: TestUser): Promise<MatrixClient>;

/** Stops the client and releases resources. */
export async function stopTestClient(client: MatrixClient): Promise<void>;
```

`createTestClient` must:
1. `createClient({ baseUrl: "http://localhost:8008", userId, accessToken, deviceId })`
2. `await client.initRustCrypto()` — **this exact method**, not `initCrypto`
3. `await client.startClient({ initialSyncLimit: 10 })`
4. Wait until the client has completed its first sync before returning

**Verify:** a scratch test creates clients for two users, then stops them, with no errors and
no hanging process.

### Step 0.5 — `waitFor` helper

Create `test/harness/waitFor.ts`:

```ts
/**
 * Polls `check` until it returns a truthy value, or throws after `timeoutMs`.
 * Use this instead of fixed sleeps when waiting for state to sync.
 */
export async function waitFor<T>(
  check: () => T | Promise<T>,
  opts?: { timeoutMs?: number; intervalMs?: number; label?: string },
): Promise<T>;
```

Defaults: `timeoutMs: 10000`, `intervalMs: 200`. On timeout, throw an error including `label`.

### Step 0.6 — Smoke test

Create `test/functional/smoke.test.ts` proving the harness works end to end:

1. Register two users, Alice and Bob.
2. Create clients for both.
3. Alice creates a file tree: `await alice.unstableCreateFileTree("smoke")`.
4. Assert the returned tree has a non-empty `.id`.
5. Alice invites Bob: `await tree.invite(bobUserId)`.
6. Bob joins: `await bob.joinRoom(tree.id)`.
7. Using `waitFor`, assert Bob can see the room: `bob.getRoom(tree.id) !== null`.
8. Stop both clients.

**Phase 0 is done when this test passes reliably three runs in a row.**

---

## 5. Phase 1 — Core tree operations (no encryption yet)

Encryption is deliberately excluded here so tree semantics are isolated from crypto.

Create `src/TeleCryptIOStorage.ts` wrapping the raw API with a friendlier interface. Design it
yourself, but it must cover everything the tests below need.

Write `test/functional/tree.test.ts` covering:

| # | Test |
|---|---|
| 1.1 | Create a top-level folder; name matches; `isTopLevel` is true |
| 1.2 | Create a subfolder; it appears in `getDirectories()` |
| 1.3 | Create nested subfolders three deep; the full hierarchy is walkable |
| 1.4 | Rename a folder; the new name is visible after sync |
| 1.5 | Delete a subfolder; it disappears from `getDirectories()` |
| 1.6 | `getDirectory(roomId)` returns the right folder; unknown ID returns `undefined` |
| 1.7 | `getOrder()` / `setOrder()` reorders folders as expected |
| 1.8 | Creating a folder with an empty name either throws or is handled — assert whichever it does, and document it |
| 1.9 | `listTrees()` returns the caller's top-level trees (see §3C) |
| 1.10 | A **fresh** client for the same user (new client object, full sync) can find a tree created earlier via `listTrees()` — proves cross-session discovery |

**Do not proceed to Phase 2 until all Phase 1 tests pass.**

---

## 6. Phase 2 — Encrypted files

Re-read **TRAP 1** in §3 before starting. You will hit it otherwise.

Add upload/download to `src/TeleCryptIOStorage.ts`:
- `uploadFile(tree, name, data: ArrayBuffer, mimetype: string): Promise<string>`
- `downloadFile(branch): Promise<{ data: ArrayBuffer; mimetype: string }>`

Write `test/functional/files.test.ts` covering:

| # | Test |
|---|---|
| 2.1 | Upload a small text file; download it; bytes are **byte-identical** to the original |
| 2.2 | Upload a binary file (random 100 KB); round-trips byte-identically |
| 2.3 | Uploaded file appears in `tree.listFiles()` with the correct name |
| 2.4 | `branch.getName()` returns the original filename |
| 2.5 | A file with a non-ASCII name (e.g. `тест-файл.txt`) round-trips correctly |
| 2.6 | mimetype survives the round trip |
| 2.7 | **The server never sees plaintext** — fetch the raw media URL and assert the bytes do *not* equal the plaintext |
| 2.8 | Delete a file; it no longer appears in `listFiles()` |

Test 2.7 is the most important test in the project. It is what proves the product's core
claim. Do not skip it.

---

## 7. Phase 3 — Sharing and access control

This is where the sharp edges are. Every test must verify from the **recipient's** client.

Write `test/functional/sharing.test.ts` covering:

| # | Test |
|---|---|
| 3.1 | Alice shares a folder with Bob as Viewer; Bob can list the files |
| 3.2 | Bob (Viewer) can **download and decrypt** a file Alice uploaded |
| 3.3 | Bob as Editor can upload a file; Alice can decrypt it |
| 3.4 | Bob as Viewer **cannot** upload (assert it fails) |
| 3.5 | A user who was never invited cannot read the folder at all |
| 3.6 | `getPermissions()` reports the role that was set |
| 3.7 | Sharing a parent folder with `andSubspaces = true` grants access to subfolders |
| 3.8 | After Alice removes Bob, Bob cannot read **files added afterwards** |

Test 3.8 is the critical E2EE test. Removing a user from a Matrix room does not retroactively
remove their ability to decrypt content they already had keys for — that is expected and
correct. What must hold is that **new** content after removal is unreadable to them. Assert
exactly that, and write a comment in the test explaining the distinction so it is not
"fixed" later by someone misreading it.

---

## 8. Phase 4 — Versioning

Write `test/functional/versions.test.ts`:

| # | Test |
|---|---|
| 4.1 | `createNewVersion` produces a new version; `branch.version` increments |
| 4.2 | `getVersionHistory()` returns all versions, newest first |
| 4.3 | An old version's content is still downloadable and decryptable |
| 4.4 | `listFiles()` shows only the current version; `listAllFiles()` shows all |
| 4.5 | Renaming a file does not create a new version |
| 4.6 | **Fresh-client history (see TRAP 6):** create 3 versions, then a *brand-new* client for the same user recovers the full 3-version chain via `getVersionHistory()`. This is the test that catches the in-memory-timeline bug. |

---

## 9. Phase 5 — Key management / multi-device

Write `test/functional/keys.test.ts`:

| # | Test |
|---|---|
| 5.1 | `bootstrapCrossSigning()` completes for a fresh user |
| 5.2 | `bootstrapSecretStorage()` produces a recovery key |
| 5.3 | A **second device** for the same user, given the recovery key, decrypts a file uploaded by the first device |
| 5.4 | A second device given a **wrong** recovery key fails cleanly with a clear error |

Test 5.3 requires a second `MatrixClient` for the same user with a *different* device ID.
That is the whole point — do not shortcut it by reusing the first client.

---

## 10. Stop here

**Phase 6 (external share links) and Phase 7 (web UI) are out of scope for you.** Do not start
them. When Phases 0–5 pass, do the following and then stop:

1. Ensure all tests pass from a clean state:
   `npm run synapse:down && npm run synapse:up && npm test`
2. Ensure `npm run lint` and `npm run build` succeed.
3. Write `STATUS.md` in the repo root containing:
   - Which phases are complete
   - Total test count and pass/fail
   - Anything in `BLOCKERS.md`
   - Any place where actual behaviour differed from this plan
4. Commit everything.

Then report back that Phases 0–5 are complete.

---

## 11. Reference material

- `matrix-js-sdk` source: `node_modules/matrix-js-sdk/src/models/MSC3089TreeSpace.ts` and
  `MSC3089Branch.ts` — read these when unsure about behaviour. This is your primary reference.
- `matrix-files-sdk` (https://github.com/matrix-org/matrix-files-sdk) — Apache-2.0, an older
  wrapper around the same API. **You may read and copy from it**, keeping its copyright notice.
  It is a complete worked example of every operation you need. Note it targets an older
  matrix-js-sdk, so its download path has TRAP 1.
- **`files-sdk-demo` — do NOT open it.** It is AGPL-3.0, incompatible with this project's
  licence. `matrix-files-sdk` (Apache-2.0, above) covers everything you need as a code
  reference, so there is no reason to read the AGPL demo at all. Staying out of it entirely
  removes any risk of copied structure. Do not clone, browse, or paste from it.

## 12. Licensing rule

This project ships under **BUSL 1.1** (see `LICENSE`). Do not add any dependency licensed
under GPL, AGPL, or any other copyleft licence. Permissive licences (MIT, Apache-2.0, BSD,
ISC) are fine. If unsure about a dependency's licence, do not add it — note it in
`BLOCKERS.md` instead.

## 13. Cross-cutting requirements (apply to every phase)

**Pin dependencies exactly.** `matrix-js-sdk` is pinned to an exact version (`41.9.0`, no `^`)
because the MSC3089 API uses `unstable*` names that can move between minor releases. Do not
loosen the pin. Keep all MSC3089 calls behind your own `TeleCryptIOStorage` interface so that a
future SDK bump breaks in one file, not across the codebase.

**Keep storage and crypto pluggable.** `matrix-js-sdk` is browser-first: its Rust crypto is
WASM and its default store is IndexedDB. Do not hardcode browser globals in the library. Take
the store/crypto-store as a constructor dependency so the same library can run in Node (for the
test suite and any future headless use). The test harness supplies a Node-compatible store; a
browser UI would supply IndexedDB.

**CI cost — do not mock the server.** The value of this suite is that it runs against a real
Synapse; mocking the tree/crypto layer would hide exactly the bugs the traps warn about. To
keep CI affordable: start the throwaway Synapse **once per test run** (not per test), cache the
podman image, and stage CI — run the full suite on merge-to-main and a faster subset on push.
Never make a failing integration test pass by replacing Synapse with a mock.

## 14. Not covered here: staging against production-like infra

This suite runs against the throwaway Synapse, which is **stock Synapse with built-in auth and
no S3**. Production is different in ways that can break things this suite will never catch:
MAS-based auth, an S3 media backend, authenticated-media enforcement, and real upload limits.

Two production risks to flag for the owner (not your job to fix, but note them in `STATUS.md`):
- **Media retention / S3 lifecycle.** Synapse does not purge local media by default, but an S3
  bucket lifecycle rule could silently delete stored files that Synapse still references —
  catastrophic for a storage product. The deployment must verify both the Synapse
  `media_retention` config and the S3 bucket's lifecycle policy.
- **A staging run against a production-like Synapse (MAS + S3)** is required before launch. It
  is out of scope for you, but STATUS.md should state that it has not been done.

## 15. Anti-circularity note for the tests

You are writing both the implementation and the tests, so a wrong assumption can end up encoded
in both and still go green. Guard against this by preferring assertions against **server-side
ground truth that an independent client can see**, not against your own library's return
values. The strongest tests in this plan are exactly those:
- 2.7 — fetch the *raw* stored bytes and prove they are not the plaintext
- 3.8 — an independent second client cannot decrypt content added after removal
- 4.6 — a fresh client recovers the full version history

When you add tests, bias toward that shape: check what Synapse actually stored and what a
*different* client actually sees, not just what your code returned.
