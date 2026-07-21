# Decisions & rationale

Short records of choices that would otherwise get re-litigated. Newest first.

---

## D4 — Public rebrand + npm Trusted Publishing

**Decision:** rebranded the library/CLI to their public identity and set up automated,
tokenless npm publishing.

**Naming scheme:**
- Main library class: `SecureStorage` → **`TeleCryptIOStorage`** (`src/SecureStorage.ts` →
  `src/TeleCryptIOStorage.ts`; its options type `CreateSecureStorageOpts` →
  `CreateTeleCryptIOStorageOptions`). The `core/` operation function names (`createFolder`,
  `uploadFile`, etc.) were deliberately left alone — they're generic verbs, not brand-bound.
- npm package: `@telecrypt/secure-storage` → **`@telecrypt-io/storage`** (matches the
  `telecrypt-io` npm org and the `TeleCrypt-io/secure-storage` GitHub repo).
- CLI binary: `secure-storage` → **`telecrypt-io`**, with every existing command nested one
  level deeper under a `storage` namespace (`telecrypt-io storage folder create ...`, `telecrypt-io
  storage login ...`, etc.) — this reserves the top-level `telecrypt-io` binary for other
  TeleCrypt.io command groups later, without another rename.
- Profile env var: `SECURE_STORAGE_HOME` → **`TELECRYPT_IO_STORAGE_HOME`** (default dir
  `~/.telecrypt-io/storage`); `SECURE_STORAGE_DEBUG` → `TELECRYPT_IO_STORAGE_DEBUG` for the same
  reason (same family of env var, left inconsistent otherwise).
- `LICENSE`'s "Licensed Work" field updated from "TeleCrypt Secure Storage" to "TeleCrypt.io
  Storage" to match; licence terms (BUSL-1.1) themselves untouched.

**Why nest the CLI under `storage` instead of just renaming the binary:** the class/package
rename is 1:1, but the CLI binary rename is 1:many in spirit — `telecrypt-io` is meant to be the
one binary for the TeleCrypt.io product line, of which encrypted storage is the first command
group, not the only one. Nesting now avoids a second breaking CLI reshuffle later.

**Trusted Publishing (`.github/workflows/publish.yml`):** publishes on any `v*` tag push via npm
OIDC Trusted Publishing + provenance — no `NODE_AUTH_TOKEN`/npm token secret in the repo at all.
Requires `permissions: id-token: write`, `registry-url` set through `actions/setup-node`, and
`npm publish --provenance`; pins `npm install -g npm@latest` in the job since Trusted Publishing
needs npm CLI ≥ 11.5.1, which is newer than what some Node setup-node versions bundle. The
matching one-time human step (registering this repo + `publish.yml` as a Trusted Publisher on
npmjs.com for `@telecrypt-io/storage`) is documented in `RELEASING.md`, along with the routine
release flow (bump version, tag, push tag). **Unverified:** this workflow has not been exercised
against a real npm publish — that requires the human npmjs.com-side configuration and a real tag
push, neither of which happened this session. It's written to match npm's current Trusted
Publishing docs; the first real release is what proves it end-to-end.

**Verification:** exhaustively grepped the whole repo (excluding `node_modules`/`dist`/`.git`)
for `SecureStorage`, `secure-storage`, `SECURE_STORAGE`, and `CreateSecureStorageOpts` after the
rename — the only remaining hit was the generated `package-lock.json`, refreshed by `npm
install`. All 51 pre-existing functional tests pass unchanged in substance (the CLI subprocess
tests were updated to the new `storage`-nested command paths and the new env var, per the
rename — no test assertions were weakened). `npm run lint` and `npm run build` pass clean; the
compiled `dist/cli/index.js storage --help` (and a real `--json` error path) were run directly
under `node` to confirm the renamed entry point and its imports actually work post-build, not
just under `tsx`.

---

## D3 — Core extraction: what's shared vs adapter

**Decision:** extracted `src/core/` (`operations.ts` + `types.ts`, plus `poll.ts`/`errors.ts`
re-homed from `src/cli/`) as the platform-agnostic operation layer both the CLI and a future UI
call, sitting between the already-shared `TeleCryptIOStorage` library and the Node-only CLI adapter.
Full rationale and scope: `docs/CORE_EXTRACTION_SPEC.md`.

**What's shared (`src/core/`):** one function per user action (`createFolder`, `listFolders`,
`joinFolder`, `shareFolder`, `unshareFolder`, `listMembers`, `listFiles`, `uploadFile`,
`downloadFile`, `setupRecovery`, `restoreRecovery`), taking an already-created `TeleCryptIOStorage` +
plain inputs, returning the typed results in `core/types.ts`. Bytes in/out are `Uint8Array`, never
file paths. Folder/file resolution-with-polling (the old `requireTree`/`requireFile`) lives here
too, as an internal `resolveTree`/`resolveFile` — every operation taking a `folderId`/`fileId`
needs it, and there's nothing Node-specific about polling a Matrix client's local sync state.

**What's adapter (stays in `src/cli/`):** anything that's actually about being a *short-lived Node
process* rather than about the Matrix operation itself — `cryptoSnapshot.ts` (disk-persisting
`fake-indexeddb` across process exits), `profile.ts` (session.json on disk), `storage.ts`
(`openStorage` = profile + snapshot + `TeleCryptIOStorage.create`; `waitForBackupSettled`, which exists
specifically because a CLI command's process might exit before the SDK's fire-and-forget backup
upload loop finishes — a concern a long-lived browser tab doesn't have), `output.ts`/`runAction`
(stdout/`--json`/exit-code rendering), all `commander` wiring, and `login`/`register`/`whoami`/
`logout` (session-bound, and `login`/`register` construct their own client rather than receiving
an already-created `TeleCryptIOStorage`, so they're outside `core/`'s contract by construction).

**Why the split there and not, say, at `TeleCryptIOStorage` alone:** `TeleCryptIOStorage` was already 100%
shared, but every *command's* actual logic (the invite-then-setPermissions dance in `folder
share`, "already in room means role-change not error", the top-level filter in `folder list`, the
not-found-vs-not-yet-synced polling) lived inline in `commander` closures — unreachable without
going through arg-parsing and stdout. `core/` is the maximum-reuse endpoint: a UI now needs zero
new business logic, only a new adapter (client construction/storage config + rendering), exactly
mirroring what `src/cli/storage.ts`+`output.ts` already do for the CLI.

**Verification, not just intent:** `core/` importing `node:fs`/`node:path`/`node:v8`/`process`/
`commander`/`fake-indexeddb` would silently break this contract, so it's checked by grep (see
`STATUS.md` Phase 7) rather than asserted — currently clean (only imports `../TeleCryptIOStorage.js`
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
