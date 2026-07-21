# Spec: Extract a shared `core/` (unified logic + typed result contract)

**Status:** to build. **Type:** behavior-preserving refactor. **Gate:** the 47 existing tests
stay green.

## Why

The CLI's operation logic lives inside `commander` `.action()` closures in `src/cli/index.ts`,
entangled with arg-parsing and stdout. That logic can't be reused by the future React UI. Extract
it into a **platform-agnostic `src/core/` module** that both the CLI and the UI call, so the UI
runs the same tested code and the same typed data contract instead of re-deriving them.

This is the maximum-reuse endpoint we agreed on: the `SecureStorage` library is already 100%
shared; this adds the thin operation/orchestration layer + the result-type contract on top.

## The layering after this change

```
  src/SecureStorage.ts   library — raw MSC3089/crypto ops (already shared, unchanged)
        │
  src/core/              NEW — platform-agnostic: operations + typed results.
        │                NO node:fs / node:path / node:v8 / process / commander / stdout.
   ┌────┴────┐
  src/cli/   (future) UI  thin adapters over core
```

## What goes in `core/`

`core/types.ts` — the shared **typed result contract** (one definition, consumed by CLI now and
UI later). At minimum: `FolderInfo { id, name }`, `FileInfo { id, name, mimetype? }`,
`Member { userId, role }`, `ShareResult`, `RecoverySetup { recoveryKey }`,
`RecoveryRestore { imported, total }`. These types ARE the CLI's `--json` schema and the UI's
data model — unify them here.

`core/operations.ts` — one function per operation, taking an already-created `SecureStorage`
plus plain inputs, returning the typed results above. **Bytes in/out are `Uint8Array` — never
file paths.** No I/O, no stdout, no process. Cover every current command's logic, including the
1:1 ones, so the UI can do *everything* through `core` and never touch the library directly:
- `createFolder(storage, name) → FolderInfo`
- `listFolders(storage) → FolderInfo[]`  (top-level filter lives here)
- `joinFolder(storage, folderId)`
- `shareFolder(storage, folderId, userId, role) → ShareResult`  (the invite + setPermissions +
  "already in room means role-change, not error" logic moves here from the CLI closure)
- `unshareFolder(storage, folderId, userId)`
- `listMembers(storage, folderId) → Member[]`
- `uploadFile(storage, folderId, name, bytes: Uint8Array, mimetype) → FileInfo`
- `downloadFile(storage, folderId, fileId) → { bytes: Uint8Array, mimetype, name }`
- `setupRecovery(storage) → RecoverySetup`
- `restoreRecovery(storage, recoveryKey) → RecoveryRestore`

Also move the genuinely platform-agnostic helpers into core: `poll.ts` and the error type
(`errors.ts`) — or re-home them under `core/` and re-export.

## What STAYS in `src/cli/` (do not move — these are Node/CLI-only adapters)

- `cryptoSnapshot.ts` (disk persistence), `profile.ts` (fs session), `storage.ts`
  (`openStorage`/`close` = profile + snapshot + `SecureStorage.create`).
- `output.ts` (`runAction`, stdout/`--json`/exit-code rendering) and all `commander` wiring.
- Each command becomes a thin wrapper: parse args → `openStorage()` → call one `core.*` function
  → wrap the typed result into `{ json, text }` → `runAction`. The `json` field should be the
  core typed result (or a trivial projection of it), so the CLI's JSON == the core contract.

## Hard rule: `core/` must be browser-safe

`core/` must NOT import `node:fs`, `node:path`, `node:v8`, `process`, `commander`, or
`fake-indexeddb`. It may import from `matrix-js-sdk`, `matrix-encrypt-attachment`, and the
library. **Verify** this at the end (grep core/ for those imports; there must be none). This is
the proof the UI can consume it.

`core/` receives an already-created `SecureStorage` — it never creates the client itself (store
config is platform-specific and stays in the adapters).

## Tests

1. **Behavior-preserving gate:** all 47 existing tests still pass, unchanged. This is the primary
   success criterion — the refactor must not alter behavior.
2. **New direct core tests** (`test/functional/core.test.ts` or similar): call `core.*` functions
   **in-process** (no subprocess, no CLI) against the real Synapse, asserting on the typed
   results. This proves the core is independently consumable and testable — the UI-readiness
   proof. Cover at least: folder create/list; a multi-participant share where userB uploads and
   userA `downloadFile`s userB's bytes byte-identical; upload/download `Uint8Array` round-trip;
   `setupRecovery` + `restoreRecovery` on a fresh device. These use the existing harness
   (`registerTestUser`, `loginNewDevice`, `SecureStorage.create` with `fake-indexeddb`).
3. Keep the existing CLI subprocess tests as integration smoke — do not delete them.

## Constraints

- **No mocks.** Real disposable Synapse via podman (`npm run synapse:up`; **off by default** —
  bring it down when done). Poll real conditions with `waitFor`; no fixed sleeps; no flaky green.
- **Never weaken a test** to accommodate the refactor. If behavior genuinely can't be preserved,
  stop and write it to `BLOCKERS.md`. No `.skip`/`.only`/`.todo`.
- `npm run lint` and `npm run build` must pass. Update `STATUS.md` (new `core/` layer, the
  layering diagram) and append a short entry to `docs/DECISIONS.md` (D3: core extraction — what’s
  shared vs adapter). Commit and push to `origin main`.
