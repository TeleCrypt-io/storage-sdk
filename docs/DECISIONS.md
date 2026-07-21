# Decisions & rationale

Short records of choices that would otherwise get re-litigated. Newest first.

---

## D3 — Core extraction: what's shared vs adapter

**Decision:** extracted `src/core/` (`operations.ts` + `types.ts`, plus `poll.ts`/`errors.ts`
re-homed from `src/cli/`) as the platform-agnostic operation layer both the CLI and a future UI
call, sitting between the already-shared `SecureStorage` library and the Node-only CLI adapter.
Full rationale and scope: `docs/CORE_EXTRACTION_SPEC.md`.

**What's shared (`src/core/`):** one function per user action (`createFolder`, `listFolders`,
`joinFolder`, `shareFolder`, `unshareFolder`, `listMembers`, `listFiles`, `uploadFile`,
`downloadFile`, `setupRecovery`, `restoreRecovery`), taking an already-created `SecureStorage` +
plain inputs, returning the typed results in `core/types.ts`. Bytes in/out are `Uint8Array`, never
file paths. Folder/file resolution-with-polling (the old `requireTree`/`requireFile`) lives here
too, as an internal `resolveTree`/`resolveFile` — every operation taking a `folderId`/`fileId`
needs it, and there's nothing Node-specific about polling a Matrix client's local sync state.

**What's adapter (stays in `src/cli/`):** anything that's actually about being a *short-lived Node
process* rather than about the Matrix operation itself — `cryptoSnapshot.ts` (disk-persisting
`fake-indexeddb` across process exits), `profile.ts` (session.json on disk), `storage.ts`
(`openStorage` = profile + snapshot + `SecureStorage.create`; `waitForBackupSettled`, which exists
specifically because a CLI command's process might exit before the SDK's fire-and-forget backup
upload loop finishes — a concern a long-lived browser tab doesn't have), `output.ts`/`runAction`
(stdout/`--json`/exit-code rendering), all `commander` wiring, and `login`/`register`/`whoami`/
`logout` (session-bound, and `login`/`register` construct their own client rather than receiving
an already-created `SecureStorage`, so they're outside `core/`'s contract by construction).

**Why the split there and not, say, at `SecureStorage` alone:** `SecureStorage` was already 100%
shared, but every *command's* actual logic (the invite-then-setPermissions dance in `folder
share`, "already in room means role-change not error", the top-level filter in `folder list`, the
not-found-vs-not-yet-synced polling) lived inline in `commander` closures — unreachable without
going through arg-parsing and stdout. `core/` is the maximum-reuse endpoint: a UI now needs zero
new business logic, only a new adapter (client construction/storage config + rendering), exactly
mirroring what `src/cli/storage.ts`+`output.ts` already do for the CLI.

**Verification, not just intent:** `core/` importing `node:fs`/`node:path`/`node:v8`/`process`/
`commander`/`fake-indexeddb` would silently break this contract, so it's checked by grep (see
`STATUS.md` Phase 7) rather than asserted — currently clean (only imports `../SecureStorage.js`
and its own siblings).

**Behavior-preserving gate:** all 47 pre-existing tests pass unchanged; a new
`test/functional/core.test.ts` (4 tests) calls `core.*` directly (no CLI subprocess) against the
real Synapse as the standalone-consumability proof. No `BLOCKERS.md` entry was needed — nothing
had to change externally observable behavior to make this split.

---

## D2 — Runtime: Node.js for the CLI at v1 (not Bun)

**Decision:** the CLI runs on **Node.js** for v1. Do not migrate to Bun now.

**Why (all deferred as "not worth bothering at v1"):**
- **Bun's Rust WASM crypto support is unproven.** matrix-js-sdk officially supports Node;
  Bun is untested for `@matrix-org/matrix-sdk-crypto-wasm`. Adopting it would require a
  validation spike before we could trust encryption/recovery on it. (Note: the one *known*
  runtime blocker — a missing `FinalizationRegistry`, which breaks the WASM crypto on
  React Native/Hermes — does **not** apply to Bun, which implements it. So there's no known
  blocker, just unproven; but "unproven crypto runtime" is not a v1 risk we want.)
- **It would force a test-runner migration.** We use Vitest; Vitest under Bun is historically
  unreliable, so going Bun likely means porting all functional tests to `bun:test`. Real cost,
  no v1 benefit.
- **Zero persistence benefit.** Bun has **no IndexedDB** either (open request since 2023), so
  the CLI under Bun would keep the exact same `fake-indexeddb` + snapshot approach as Node.
  Bun changes nothing about the crypto/persistence design.

**Revisit if:** post-v1 we care about CLI startup speed / DX enough to run the spike. It's a
runtime swap under a stable, tested core — cheap to revisit later, expensive to de-risk now.

---

## D1 — Crypto persistence: snapshot `fake-indexeddb` to disk (not a disk-native shim)

**Decision:** the CLI persists the rust-crypto store by **snapshotting the in-memory
`fake-indexeddb` to disk after each command and reloading it before the next**
(`src/cli/cryptoSnapshot.ts`). It does not use a disk-backed IndexedDB shim.

**Why:**
- "IndexedDB" is one API with several implementations that differ in behavior. The rust crypto
  store (WASM) leans hard on **structured-clone of binary values** (`Uint8Array` key material)
  and specific cursor/transaction semantics.
  - Browser-native IndexedDB: faithful → works.
  - `fake-indexeddb` (pure JS, in-memory): faithful → works. **This is why we use it.**
  - `indexeddbshim` (JS→SQLite, disk-persistent): diverges on binary/structured-clone → the
    rust crypto store **breaks** ([matrix-sdk-crypto-wasm #195](https://github.com/matrix-org/matrix-sdk-crypto-wasm/issues/195)).
- So the only implementation that gives disk persistence *directly* is the one that breaks
  crypto. Snapshotting the faithful in-memory store gives us **correct behavior + persistence**
  and sidesteps #195.

**How it keeps CLI and UI code unified:**
- Both call `initRustCrypto({ useIndexedDB: true })` against the IndexedDB API — **identical
  store code**.
- CLI: `fake-indexeddb` + a thin snapshot adapter (the only extra code). The snapshot uses the
  *public* IndexedDB API (`databases()`, cursors, transactions) + `node:v8` (de)serialize, so
  it doesn't depend on `fake-indexeddb` internals.
- UI: browser-native IndexedDB persists automatically — **needs none of the snapshot code**.
- Net: the code that matters is already the same; the snapshot is an additive, CLI-only
  adapter the browser doesn't touch. This is as unified as it can get, given #195.

**Known hardening item (not a v1 blocker):** `saveSnapshotToDisk` writes with
`fs.writeFileSync` (not atomic). A crash mid-write could corrupt the snapshot. Cheap fix:
write to a temp file + `rename`. Ultimate safety net is server-side key backup (Layer 2), which
can always re-seed a lost/corrupt local store.
