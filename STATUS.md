# STATUS — TeleCrypt Secure Storage

**Date:** 2026-07-21

## Phases complete

| Phase | Description | Status |
|---|---|---|
| 0 | Test harness (disposable Synapse, user provisioning, client sessions, smoke test) | ✅ |
| 1 | Core tree operations — `SecureStorage` class, tree CRUD, listing, discovery | ✅ |
| 2 | Encrypted files — upload/download, byte-identical round-trip, mimetype, server never sees plaintext | ✅ |
| 3 | Sharing and access control — invite, permissions, viewer/editor, revocation | ✅ |
| 4 | Versioning — version history, old version download, listFiles vs listAllFiles, fresh-client history | ✅ |
| 5 | Key management — cross-signing bootstrap, secret storage, recovery key generation and decoding | ✅ |
| 5B | **Real key recovery** — server-side Secure Backup + restore on a genuinely new device (the "lost laptop" case) | ✅ |
| 6 | **`secure-storage` CLI** — session, recovery, shared folders, files; driven end-to-end by the library | ✅ |
| 7 | **`core/` extraction** — platform-agnostic operations + typed result contract, shared by the CLI now and a future UI | ✅ |

## Phase 7 — `core/` extraction (this session)

Behavior-preserving refactor (`docs/CORE_EXTRACTION_SPEC.md`): pulled the operation logic that used
to live inline inside `commander` `.action()` closures in `src/cli/index.ts` out into a new
**platform-agnostic `src/core/`** module, so a future React UI can call the exact same tested logic
and the exact same typed result contract instead of re-deriving them from the CLI.

**The layering now:**

```
  src/SecureStorage.ts   library — raw MSC3089/crypto ops (unchanged)
        │
  src/core/              operations.ts (one fn per action) + types.ts (typed
        │                result contract) + poll.ts / errors.ts. Browser-safe:
        │                no node:fs / node:path / node:v8 / process / commander
        │                / fake-indexeddb — verified by grep, see below.
   ┌────┴────┐
  src/cli/   (future) UI  thin adapters: parse args → openStorage() → one
                          core.* call → wrap into {json, text} → runAction
```

- **`src/core/types.ts`** — the shared typed result contract (`FolderInfo`, `FileInfo`, `Member`,
  `ShareResult`, `UnshareResult`, `JoinResult`, `DownloadedFile`, `RecoverySetup`,
  `RecoveryRestore`). These types ARE the CLI's `--json` schema (or a trivial projection of it —
  e.g. `FolderInfo.id` becomes the CLI's `folderId` key, to keep existing CLI output byte-for-byte
  unchanged) and are the future UI's data model.
- **`src/core/operations.ts`** — `createFolder`, `listFolders`, `joinFolder`, `shareFolder`,
  `unshareFolder`, `listMembers`, `listFiles`, `uploadFile`, `downloadFile`, `setupRecovery`,
  `restoreRecovery`. Each takes an already-created `SecureStorage` plus plain inputs; bytes in/out
  are always `Uint8Array`, never file paths. Folder/file resolution-with-polling (formerly
  `requireTree`/`requireFile` in `src/cli/storage.ts`) moved here as internal `resolveTree`/
  `resolveFile` helpers, since every operation that takes a `folderId`/`fileId` needs it — this is
  genuinely platform-agnostic logic, not a CLI concern.
- **`src/core/poll.ts`** and **`src/core/errors.ts`** — re-homed from `src/cli/` (no behavior
  change); `src/cli/poll.ts` and `src/cli/errors.ts` are now thin re-exports so existing CLI
  imports keep working unchanged.
- **What stayed in `src/cli/`** (Node/CLI-only, per the spec): `cryptoSnapshot.ts` (disk
  persistence), `profile.ts` (fs session), `storage.ts` (`openStorage`/`close` = profile +
  snapshot + `SecureStorage.create`, plus `waitForBackupSettled` — a short-lived-*process*
  concern, not something a long-lived UI tab needs), `output.ts` (`runAction`), all `commander`
  wiring, and the `login`/`register`/`whoami`/`logout` commands (session/profile-bound, and
  `login`/`register` build their own client rather than receiving an already-created
  `SecureStorage`, so they're out of scope for `core/` by the spec's own rule).
- One deliberate, harmless divergence from a literal "parse args → openStorage → one core.* call"
  shape: `folder share`'s `--role` validation is still checked in the CLI closure *before*
  `openStorage()` (so a bad `--role` fails exactly as fast as before, without even attempting
  login), and `core.shareFolder` repeats the identical check internally so it's still safe to call
  standalone. Confirmed via the full CLI test suite that command-level JSON/text output is
  unchanged.

**Browser-safety verification:** `grep -rnE "node:fs|node:path|node:v8|process\.|commander|fake-indexeddb" src/core/` returns nothing — `src/core/` imports only `../SecureStorage.js` and its own
siblings. This is the proof a browser bundle can consume `core/` directly.

**New test:** `test/functional/core.test.ts` (4 tests, C.1–C.4) calls `core.*` functions
**in-process** (no CLI subprocess) against the real disposable Synapse: folder create/list;
a multi-participant share where userB uploads and userA `downloadFile`s userB's bytes
byte-identical; an upload/download `Uint8Array` round-trip; `setupRecovery` + `restoreRecovery`
on a genuinely fresh device (with a negative control before restore). This is the direct
UI-readiness proof, parallel to what `keys.test.ts`/`sharing.test.ts` already proved for the raw
library.

**Test results:** all 47 pre-existing tests pass unchanged, plus the 4 new core tests — **51/51**.
Verified with 3 consecutive full-suite runs (including a from-scratch `synapse:down && synapse:up`
before the first), all green, no flakiness. `npm run lint` and `npm run build` pass clean.

No `BLOCKERS.md` was needed — every command's behavior was preserved exactly.

## Phase 5B — real key recovery (this session)

Closed the gap documented in `docs/PHASE_5B_KEY_RECOVERY.md`: Phase 5 built cross-signing
bootstrap and recovery-key *generation*, but never built server-side key backup or restore,
so a genuinely new device could never actually recover old files. Tests 5.3/5.4 had been
softened to hide this.

**Two things changed:**

1. **`SecureStorage.create(opts)`** — the new recommended entry point (`src/SecureStorage.ts`).
   Builds the `MatrixClient`, calls `initRustCrypto` with a **persistent** crypto store
   (IndexedDB) **by default** — this replaces the old amnesiac `useIndexedDB: false` default
   that let the missing-recovery gap slip in unnoticed. Wires `cryptoCallbacks` so the `keys`
   API works out of the box, starts the client, waits for first sync, returns a ready
   `SecureStorage`. The plain constructor (`new SecureStorage(client)`) still exists for
   advanced callers who build/configure the `MatrixClient` themselves; `keys.*` only works
   there if the caller wires an equivalent `cryptoCallbacks` object at `createClient()` time
   (matrix-js-sdk fixes that object reference at construction — it cannot be added after
   `initRustCrypto()` has run).

2. **`storage.keys` API** — `setupRecovery()`, `isRecoverySetup()`, `restoreFromRecoveryKey()`.
   `setupRecovery()` calls `bootstrapCrossSigning`, then `bootstrapSecretStorage({
   setupNewSecretStorage: true, setupNewKeyBackup: true, createSecretStorageKey })` (which
   internally calls `resetKeyBackup()` and starts the backup engine), then
   `checkKeyBackupAndEnable()`, and returns the Recovery Key string. `restoreFromRecoveryKey()`
   decodes the key, unlocks secret storage via a temporary `getSecretStorageKey` callback,
   calls `loadSessionBackupPrivateKeyFromSecretStorage()` then `restoreKeyBackup()`, and
   returns `{ imported, total }`. Both paths throw clear, prefixed errors (never silently
   "succeed") on a malformed or wrong recovery key. See `src/SecureStorage.ts` for full
   implementation and doc comments.

**Harness:** `loginNewDevice(user)` (`test/harness/users.ts`) does a real
`POST /_matrix/client/v3/login` with `m.login.password`, returning a second `TestUser` with a
new `device_id` + `access_token` for the same account — the "new laptop."

**Tests 5.3/5.4 rewritten to their strong form** (`test/functional/keys.test.ts`):
- **5.3** — Device A uploads a file and runs `setupRecovery()`. The test polls
  `isRecoverySetup()` (backup engine believes it's active) **and** the raw server endpoint
  `GET /room_keys/version` for `count >= 1` (the file's room key has actually reached the
  server — `isRecoverySetup()` alone only proves the engine is running, not that this specific
  session uploaded). Device B = `loginNewDevice` + `create()`. **Negative control:** asserts
  device B **cannot** decrypt the file yet — verified in logs as a genuine rust-crypto
  `DecryptionError: This message was sent before this device logged in, and key backup is not
  working`, not a mocked/skipped check. Then `restoreFromRecoveryKey(recoveryKey)`, and polls
  for device B to decrypt the file to bytes identical to what device A uploaded.
- **5.4** — device B with a garbage string (fails at `decodeRecoveryKey`, before any network
  call) and with a well-formed-but-wrong recovery key (a genuine key from an unrelated
  throwaway account) both throw from `restoreFromRecoveryKey`, and device B still cannot
  decrypt the file afterward.
- **5.1/5.2** simplified to exercise the `keys` API directly (`setupRecovery()` returns a
  decodable 32-byte key and `isRecoverySetup()` transitions false → true).

**Device isolation:** each `create()`d client gets its own IndexedDB store, prefixed by
`secure-storage::<userId>::<deviceId>` (overridable). This matters even outside of tests: the
rust crypto backend's default store prefix is a single fixed constant, so two different
device sessions sharing one IndexedDB origin (as happens in this repo's tests, since
`fake-indexeddb` is process-global) would otherwise silently share one crypto store. Device
B's negative control in 5.3 is what would catch a regression here.

No blockers — Layer 2 worked end-to-end against this Synapse. No `BLOCKERS.md` was needed.

## Phase 6 — `secure-storage` CLI (this session)

Built a `secure-storage` CLI (`src/cli/`, Node + TypeScript + `commander`) that drives the
library end-to-end: `login`/`register`/`whoami`/`logout`, `recovery setup`/`restore`,
`folder create`/`list`/`join`/`share`/`members`/`unshare`, `file upload`/`list`/`download`.
Every command supports `--json` (machine-readable stdout on success, `{"error": "..."}` on
stderr + non-zero exit on failure — never a stack trace). See `CLI.md` for full command
reference and example usage. Full detail (including three real bugs the CLI work uncovered
and fixed in the library) lives in `docs/CLI_SPEC.md`'s companion notes below; short version:

**THE central challenge — crypto persistence across processes — solved with Option 1 (disk-
persistent crypto store), not the key-backup-restore fallback.** A CLI runs each command as a
separate OS process; `fake-indexeddb` (the only IndexedDB in Node) is in-memory and evaporates
on exit. `src/cli/cryptoSnapshot.ts` snapshots every IndexedDB database (generically, over the
*public* IndexedDB API — `databases()`, cursors, transactions — not fake-indexeddb's internals)
to `$SECURE_STORAGE_HOME/crypto.snapshot` (binary, `node:v8` serialize/deserialize so
`Uint8Array` megolm keys survive; file mode 0600) after every command, and reloads it before
the next one. Session (homeserver/userId/deviceId/accessToken) lives in
`$SECURE_STORAGE_HOME/session.json`, same directory, same mode.

Option 2 (per-run key-backup restore) was rejected on architectural grounds, not merely
"harder": for userA to decrypt userB's newly-uploaded file, userA's device must receive a
to-device olm message encrypted to userA's *device identity*. Key backup is strictly
per-account — userB's fresh session key never lands in userA's own backup. If userA's device
identity regenerated every process (the amnesiac option), the queued to-device message would be
encrypted to a stale identity and undecryptable — Option 2 cannot pass the multi-participant
scenario at all, independent of how well it's implemented. Confirmed with the mandatory proof
(`file upload` in one subprocess, `file download` in a separate one, byte-identical) and the
core multi-participant flow (A shares with B, B joins + uploads, **A downloads B's file**,
byte-identical, uninvited C sees nothing) — both pass deterministically (4 full-suite runs plus
3 additional isolated repeats of CLI.1–3, all green; see Test results below).

**Three real library-level bugs surfaced by driving the library from short-lived processes**
(all fixed in `src/SecureStorage.ts`, not papered over in the CLI or the tests):
1. **`unstableCreateFileTree()` race** (matrix-js-sdk's own bug): it creates the room via a
   plain `createRoom()` HTTP call, then immediately does `client.getRoom(roomId)` and throws
   `Error("Unknown room")` if the local store hasn't caught up via `/sync` yet — which, on a
   client that's mere milliseconds old, it usually hasn't. `SecureStorage.createTree()` now
   catches exactly this, waits for the client's own live sync loop to surface the new room (by
   room-ID-set diffing, not name matching), and wraps it via `unstableGetFileTreeSpace()`
   instead of surfacing a spurious failure for a folder that in fact exists.
2. **`downloadFile()` threw an opaque `TypeError`** ("Cannot read properties of undefined
   (reading 'url')") instead of a clear error when the underlying event couldn't be decrypted
   (missing megolm session) — `getFileInfo()` hands back a placeholder with no usable `info` in
   that case rather than throwing. Now checked explicitly and reported as "could not read file
   info from the event — it is likely undecryptable on this device."
3. **`listMembers()` reads the server's REST state directly** (`GET .../members`,
   `GET .../state/m.room.power_levels/`), not the client's locally synced `tree.room`/
   `currentState`. Investigated via the advisor after `folder members`/role-promotion reads
   flapped between correct and stale/missing across repeated *fresh* client syncs of the *same*
   room, even 40+ seconds after the change — proven (10x back-to-back curl against the REST
   state endpoints, all consistent) to be sync-convergence lag specific to reading full
   membership+power-level state from a freshly-started client, not a general reliability
   problem: writes (invite/createRoom/setPermissions/upload) and existence polls
   (`requireTree`/`requireFile`, which succeed because they poll *within* one live process as
   its sync loop ticks) were never affected. Reading the same data straight from the server
   sidesteps sync convergence entirely for the one read that needed it.

**CLI-specific robustness (in `src/cli/`, not the library):**
- `requireTree`/`requireFile` (`storage.ts`) poll (bounded, 15s) for a folder/file to become
  visible before concluding "not found" — a room/branch another process *just* created can be
  briefly absent from this process's own first sync.
- `waitForBackupSettled` (`storage.ts`) — the SDK's key-backup upload loop is deliberately
  fire-and-forget with a randomised 0–10s startup jitter (to avoid a multi-device thundering
  herd). A long-lived app can let that run in the background; a CLI command that exits right
  after `recovery setup`/`file upload` resolves would silently outrun it, leaving a "successful"
  upload not actually backed up yet. `recovery setup` and `file upload` now wait (best-effort,
  bounded, skipped entirely if recovery was never set up) for the SDK's
  `CryptoEvent.KeyBackupSessionsRemaining` to report 0 before the process exits.
- `console.log/debug/info/trace/warn/error` are all silenced by default (routed to stderr,
  labelled, under `SECURE_STORAGE_DEBUG=1`) — matrix-js-sdk and the rust-crypto WASM tracing
  layer write verbose logs to *both* stdout and stderr by default (push-rule setup notices,
  background-request warnings even on fully successful runs), which would otherwise corrupt
  both halves of the `--json` contract. The CLI's own output always goes through
  `process.stdout.write`/`process.stderr.write` directly (`output.ts`), never `console.*`.
- `folder share` re-invites unconditionally (so it doubles as "change an existing participant's
  role"); a 403 "already in the room" from the invite call is swallowed and the role change
  still applies — any other invite failure still propagates.

**Small library addition** (as scoped in `docs/CLI_SPEC.md`): `SecureStorage.listMembers(tree)`
— see bug #3 above for why it reads REST state directly. Covered by library test 3.9 in
`test/functional/sharing.test.ts` (owner from creation, invited-viewer, joined-and-promoted-to-
editor, never-invited user absent). `folder members` is a thin wrapper.

**Also fixed while wiring the CLI's `bin`/build path:** `tsconfig.json` had `rootDir: "."`
against `include: ["src/**/*.ts"]`, so `npm run build` actually emitted `dist/src/index.js`,
not `dist/index.js` as `package.json`'s own `main` field claimed — a latent, previously-unnoticed
mismatch (nothing had ever consumed the built output before). Fixed to `rootDir: "src"`. Also
switched `module`/`moduleResolution` from `"bundler"`/`"ES2022"` to `"NodeNext"` — required for
`dist/cli/index.js` to actually run under plain `node` (bundler resolution tolerates
extensionless/directory-index relative imports that Node's real ESM loader rejects); added
explicit `.js` extensions to this repo's own relative imports and to the two matrix-js-sdk deep
imports that pointed at a directory (`matrix-js-sdk/lib/crypto-api` → `.../index.js`) or a bare
module id (`.../recovery-key` → `.../recovery-key.js`). Verified the compiled entry point
directly (`node dist/cli/index.js ...`), not just the `tsx` dev path — register → folder create
→ file upload → file download, byte-identical.

## Test results (Phase 6)

**Total: 47 tests, 47 passed, 0 failed** (37 pre-Phase-6 + 1 new library test (3.9) + 9 new CLI
tests). Verified deterministically this session: 4 consecutive full-suite runs (including one
against a from-scratch `synapse:down && synapse:up`), plus 3 additional isolated repeats of just
CLI.1–CLI.3 (the cross-process persistence proof and the multi-participant/members scenarios),
all green.

- `test/functional/smoke.test.ts` — 1 test
- `test/functional/tree.test.ts` — 10 tests
- `test/functional/files.test.ts` — 8 tests
- `test/functional/sharing.test.ts` — 9 tests (adds 3.9, `listMembers`)
- `test/functional/versions.test.ts` — 6 tests
- `test/functional/keys.test.ts` — 4 tests
- `test/functional/cli.test.ts` — 9 tests, real subprocesses via `test/harness/cli.ts`:
  - CLI.1 cross-process persistence proof (mandatory)
  - CLI.2 multi-participant shared folder (A shares → B joins+uploads → **A downloads B's
    file**, byte-identical; uninvited C sees nothing)
  - CLI.3 `folder members` (owner/viewer/editor roles, both before and after a promotion)
  - CLI.4 `recovery restore` on a genuinely fresh profile (new device via `login`, not
    `register`) recovers a file — includes a negative control (fails before restore)
  - CLI.5 error paths (5 sub-tests): bad login, garbage recovery key, nonexistent file, no
    session (both `--json` and text mode) — all clean non-zero exit, no stack traces

`npm run lint` and `npm run build` pass clean.

## Notes

- **CLI:** `secure-storage` (Phase 6) — see `CLI.md` for commands and example usage, and "Phase
  6" above for the crypto-persistence design and the bugs it surfaced. State lives under
  `$SECURE_STORAGE_HOME` (default `~/.secure-storage`): `session.json` + `crypto.snapshot`, both
  mode 0600.
- All tests run against a **real disposable Synapse** via podman (`throwaway_synapse/`). No mocks.
- File encryption uses `matrix-encrypt-attachment` (AES-CTR + JWK) — same scheme as Matrix attachments.
- Tree semantics use `matrix-js-sdk`'s MSC3089 primitives (`MSC3089TreeSpace` / `MSC3089Branch`).
- The `httpUrl` from `getFileInfo()` 404s on modern Synapse (authenticated media required). All downloads in the library use the authenticated workaround (`mxcUrlToHttp` with `useAuthentication=true` + `Authorization: Bearer`).
- **Recommended entry point is now `SecureStorage.create(opts)` + `storage.keys.*`** (Phase 5B, this session), not the bare constructor — see "Phase 5B" above. The old note that lived here ("full cross-device key restoration depends on key backup which requires additional setup") is what this session's work resolved.
- Deep-importing matrix-js-sdk internals (`decodeRecoveryKey`, `CryptoCallbacks`) from `src/SecureStorage.ts` must go through the **compiled** `matrix-js-sdk/lib/...` path, not `matrix-js-sdk/src/...`. The `src/` tree's own relative imports use literal `.ts` extensions (their build setup allows it); pulling that into our `tsc` build (which lacks `allowImportingTsExtensions`) makes `tsc` fully type-check matrix-js-sdk's entire source tree and fail with hundreds of unrelated errors, since `skipLibCheck` only skips `.d.ts` files. `matrix-js-sdk/lib/...` is proper compiled output (`.js` + `.d.ts`), so `skipLibCheck` applies normally. Test files are unaffected (not part of the `tsc` build; vitest's esbuild transform doesn't type-check), which is why the pre-existing `test/functional/keys.test.ts` deep-`src/` import was never a problem before this session added a deep import to `src/SecureStorage.ts` itself.
- Test 3.8 (revocation) genuinely proves key-denial: Bob cannot decrypt "AFTER removal" via the library, via a direct low-level room-event fetch (denied by Synapse), or by attempting to decrypt the raw ciphertext (which he *can* fetch — media isn't ACL'd — but not decrypt, since he never obtains the AES key). An earlier version of this test only checked room membership, which proved the kick worked but not that E2EE key-denial worked; fixed 2026-07-20.
- Test 4.6 (fresh-client version history) requires a **persistent** crypto store to mean anything — the harness's default `useIndexedDB: false` makes "fresh client, same user" crypto-amnesiac (in-memory store discarded on restart), so it could never have recovered real history no matter what `getVersionHistory()` did. Fixed 2026-07-20 by scoping `useIndexedDB: true` (via `fake-indexeddb`, dev-dependency) to just this test, plus polling for the full 3-version chain (re-fetching the branch and calling `getVersionHistory()` each iteration) instead of asserting on the first read — the chain walk depends on v2/v3 finishing local decryption and relation aggregation, which is asynchronous and can still be settling right after the (unencrypted) branch state events land. The initial version of this fix (persistence alone, first-read assertion) was flaky (~1-in-10 runs recovered only 2 of 3 versions); adding the poll made it deterministic across 15 consecutive runs. Note this genuinely depends on the chain being recoverable — if key-denial were real, the poll times out and the test fails, it doesn't mask anything.
- An earlier hypothesis for 4.6's root cause — that `getVersionHistory()` only scans the live timeline without paginating, and a shallow `initialSyncLimit: 10` sync misses older events — was tested (forced `client.scrollback()`) and disproved: the fresh client's first `/sync` already contained all 19 timeline events for the room. The actual cause was crypto-store persistence + decryption-settling timing, not pagination.

## Out of scope (not built)

- Phase 6: External share links (requires a separate HTTP proxy)
- Phase 7: Web UI
- Quota enforcement (relies on Synapse's built-in `max_upload_size`)
- Federation (disabled on target Synapse)

## Build note

Previously this section claimed `npm run build` produced errors from `matrix-js-sdk`'s own source files. That was unverified and turned out to be wrong: `tsconfig.json` only includes `src/**/*.ts` (not `test/`) and has `skipLibCheck: true`, so `matrix-js-sdk`'s declaration files were never actually being checked. The one real error was in our own `src/SecureStorage.ts` (an unsafe cast from `Record<string, unknown>` straight to `IEncryptedFile` for `decryptAttachment()`'s second argument, which TypeScript correctly flags as needing to go through `unknown` first) — fixed 2026-07-20. `npm run build` now passes clean.

Separately, `eslint.config.js` did not exist at all before 2026-07-20 (this project had `eslint` as a devDependency but no config, so `npm run lint` failed outright with "ESLint couldn't find an eslint.config.js"). Added a minimal flat config for `@typescript-eslint`'s recommended rules, with `no-unused-vars` configured to respect this codebase's existing `_`-prefix-means-intentionally-unused convention and `no-explicit-any` turned off (matrix-js-sdk's MSC3089 types are frequently too narrow for how the tests exercise them, and the tests already leaned on `any` pervasively before lint ever ran). `npm run lint` now passes clean.
