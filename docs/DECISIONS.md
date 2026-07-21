# Decisions & rationale

Short records of choices that would otherwise get re-litigated. Newest first.

---

## D7 — Production testing via redpill: no secrets, ≤3 serial provisions, recovery-restore is local-only

**Decided 2026-07-21. Verified live against real telecrypt.io before deciding.**

Goal: real functional verification against production `telecrypt.io` after every deploy, without
ever requiring secrets in CI. Full spec: `docs/PROD_TESTING_SPEC.md`.

**Decisions:**
1. **Accounts come from the public `redpill` endpoint only** (`POST https://telecrypt.io/redpill`,
   no auth, no body) — never a real user's credentials, never an admin/API secret. This is what
   makes the whole suite runnable from an unauthenticated GitHub Actions job.
2. **≤3 accounts per run, provisioned SERIALLY, from a single file's single `beforeAll`.**
   Redpill is rate-limited 5/min per source IP; parallelizing (or splitting provisioning across
   multiple test files, which vitest would run concurrently by default) risks tripping it. Part A
   uses 2.
3. **Accounts are never torn down** — the controlplane retention locker reaps unadopted agent
   accounts automatically. Tests still best-effort delete the folders/rooms they create (wrapped
   so a cleanup failure never fails the test itself), since room/folder litter isn't
   self-cleaning the way accounts are.
4. **Cross-device recovery *restore* is NOT exercised against prod, and is not faked to look like
   it is.** Redpill hands back one account per call with no password, so there is no secrets-free
   way to log a second device into the same account. Prod (`P.4`) covers `setupRecovery()` +
   backup-active only; full restore with a genuine negative control stays where it already was —
   the local MAS-delegated stack (`test/functional/keys.test.ts` 5.3, `test/functional/core.test.ts`
   C.4), both of which construct a real second device via `loginNewDevice`.
5. **Fully separate from `npm test`, by directory + dedicated config + dedicated script, not by
   convention alone.** `test/production/**` is excluded in the root `vitest.config.ts` AND only
   reachable via a separate `vitest.prod.config.ts` (`npm run test:prod`) with no `globalSetup`
   (the local suite's `globalSetup` requires a live local Synapse, which must never be a
   prerequisite for hitting prod). Verified: the default suite still collects exactly the same 53
   local tests post-change.
6. **Wired via a separate workflow (`workflow_run` on "Deploy UI to GitHub Pages" success, plus
   `workflow_dispatch`), not folded into `deploy-ui.yml` itself.** A failing prod-test is a
   post-deploy alert, not a gate — the deploy already published by the time this runs, and
   nothing here rolls it back.

**Real finding this surfaced, not anticipated at spec time:** telecrypt.io runs a fail-closed
"inverted tier" Synapse module (`tier_controller`) — every account, human or agent, is
`RESTRICTED` (no media uploads at all, capped room creation, no room encryption state events)
until explicitly marked `user_type='verified'` via the owner's own out-of-band `tc-verify.sh`.
Redpill accounts are never verified, so the suite's upload-dependent tests (round-trip,
multi-participant share, plaintext check) get `413 M_TOO_LARGE` on every upload — including a
0-byte one, confirmed via raw `curl` independent of this library — deterministically, by design,
not as a bug. There is no secrets-free way around this (verifying an account requires exactly the
privileged admin-DB action redpill was built to avoid needing), so it's documented in
`BLOCKERS.md` rather than worked around: the tests assert the real intended behavior, never a
faked success. A runtime preflight (`probeUploadsRestricted` in `beforeAll`) detects this exact,
verified denial signature and `ctx.skip()`s the three affected tests with a loud reason, so the
suite stays green-when-healthy (a real regression is still distinguishable) instead of being
permanently, uninformatively red — self-correcting if the policy ever changes, no code change
needed. Recovery setup (`P.4`, no upload touched) verified passing against real prod, both
before and after adding the skip logic. Also fixed during this decision: the post-deploy workflow
runs Part A and Part B as two INDEPENDENT jobs, not sequential steps — GitHub Actions' implicit
`if: success()` chaining between steps would otherwise have silently skipped the deployed-UI
smoke (Part B) on every run where Part A had a failing step, defeating its purpose as the
blank-page/entrypoints regression catcher.

---

## D6 — MAS/OAuth auth (additive), hosted UI on storage.telecrypt.io, llms.txt

**Decided 2026-07-21. Verified live against real telecrypt.io MAS before deciding.**

Goal: host the web UI at `storage.telecrypt.io` (GitHub Pages), authenticating against
telecrypt.io only; add MAS/OAuth login to BOTH the CLI and the web UI; drop an `llms.txt`
for agent use.

**Verified facts (curled telecrypt.io, 2026-07-21):**
- Homeserver `https://telecrypt.io`; MAS issuer `https://telecrypt.io/auth/`.
- MAS has **dynamic client registration** (`.../auth/oauth2/registration`), **device grant**
  (`.../auth/oauth2/device`), `authorization_code` + `refresh_token`, PKCE S256.
- **Password login STILL works** on telecrypt.io — `m.login.password` is offered alongside
  `m.login.sso` (`org.matrix.msc3824.delegated_oidc_compatibility`). So MAS runs in
  **compatibility mode**. This is why OAuth is *additive*, not a replacement.
- matrix-js-sdk (installed, v41) exposes the OIDC API we need:
  `discoverAndValidateOIDCIssuerWellKnown`, `registerOidcClient`, `generateOidcAuthorizationUrl`,
  `completeAuthorizationCodeGrant`, `OidcTokenRefresher`, `client.getAuthMetadata()`.

**Decisions:**
1. **OAuth is additive; the 51 storage/E2EE tests and the password path stay unchanged.**
   OAuth is a new door yielding the same `{token, MatrixClient}`. Do NOT convert the existing
   harness away from password login.
2. **CLI uses the OAuth device-code grant** (RFC 8628). A terminal has no redirect URL; device
   code needs none — CLI prints a short `user_code` + verification URL, user approves in a
   browser, CLI polls the token endpoint. (Rejected loopback/RFC-8252: it would require
   allowing `http://localhost` redirects, and SSH-headless was explicitly a non-goal, so the
   only merit of loopback vanished while its cost — a MAS localhost-redirect policy relaxation —
   remained.) Device code also means the CLI needs **no prod-MAS policy change at all**.
3. **Web UI uses OIDC authorization-code + PKCE** with dynamic client registration. Cache the
   DCR `client_id` in localStorage (do NOT re-register every load); persist PKCE verifier +
   `state` in sessionStorage across the redirect; handle the `?code&state` callback on load;
   tokens in localStorage with `OidcTokenRefresher`. Production redirect URI is
   `https://storage.telecrypt.io/` — passes MAS's default DCR policy (real HTTPS host), so
   **production MAS is never modified**.
4. **Testing OAuth: add a LOCAL MAS to the throwaway stack; production stays strict/untouched.**
   Run a disposable MAS next to the disposable Synapse (in **compatibility mode**, so
   `m.login.password` still works and the 51 tests stay green — the one real harness change is
   routing test-user *creation* through MAS). We own that dev MAS, so its DCR policy can allow
   `http://localhost` redirects freely — dev/CI concern only, zero prod exposure. This is the
   clean resolution of the "loosen prod?" question: never loosen prod; use our own dev MAS.
5. **Hosting:** web UI built from `ui/` and deployed to **GitHub Pages** at
   `storage.telecrypt.io` (CNAME file in the Pages artifact + a DNS CNAME record — DNS is the
   owner's action). The deployed UI hardcodes homeserver = `https://telecrypt.io` (no
   homeserver field — "auth against telecrypt.io only").
6. **`llms.txt`** at repo root (agents browsing the repo) AND served at the site root
   (`storage.telecrypt.io/llms.txt`, llmstxt.org convention) — CLI usage rules for agents.

**Localhost-redirect risk (why we avoid loosening prod):** loopback+PKCE is the RFC-8252
standard and low-risk per request, but relaxing prod MAS's DCR policy to accept `http://localhost`
is a *standing* loosening of two guardrails (HTTPS-only + coherent-host) affecting every future
DCR client — small but permanent surface increase. A disposable local MAS avoids it entirely.

**ACTUAL OUTCOME (built 2026-07-21, same session as the decision above — see `STATUS.md`
Phase 10 for the full account). Reality matched the plan on the big calls, diverged on a
few implementation details worth recording so they don't get re-litigated:**

- **Local-MAS architecture: unified, not dual-stack.** Before building anything, ran the
  advisor-recommended probe — register a user via `mas-cli`, log in via compat, run
  `bootstrapCrossSigning`/`bootstrapSecretStorage`/key backup — against a real MAS-delegated
  Synapse. It passed cleanly (no extra reauth needed for cross-signing on a brand-new
  account under MSC3861 delegation). So the throwaway stack now runs **one** MAS-delegated
  Synapse serving both the 51 pre-existing tests and the new OAuth tests — not point 4's
  literal "disposable MAS next to the disposable Synapse" as a separate parallel stack.
  Simpler to maintain, and it's what "the one real harness change is routing test-user
  creation through MAS" (point 4) already implied.
- **A front-door reverse proxy (Caddy) turned out to be required, not optional.** MAS's own
  docs are explicit that `/_matrix/client/*/login`, `*/logout`, `*/refresh` must be proxied
  to MAS directly once delegated — Synapse stops serving them itself (confirmed: a bare
  delegated Synapse 404s "Unrecognized request" on `/login`). `throwaway_synapse/Caddyfile`
  now owns the public `:8008` URL, routing those three paths to MAS and everything else to
  Synapse, so every existing test/CLI/UI default (`http://localhost:8008`) keeps working
  unchanged. This mirrors what a real production reverse proxy (e.g. the owner's own Caddy in
  front of telecrypt.io) must already be doing.
- **`OidcTokenRefresher` (matrix-js-sdk's class) is unusable under Node** — confirmed by
  direct testing, not assumed: it unconditionally constructs an `oidc-client-ts` `OidcClient`
  requiring `window.sessionStorage`/`window.localStorage`, even though a plain
  `grant_type=refresh_token` exchange never reads or writes them. Fixed by NOT using it:
  `src/core/oidc.ts`'s `refreshOidcToken`/`buildTokenRefreshFunction` hand-roll the refresh
  as a plain `fetch` POST instead (the DCR'd client is public — `token_endpoint_auth_method:
  "none"` — so refresh needs only `client_id`, no secret). Works identically in Node and the
  browser; both the CLI and UI adapters share the exact same refresh code now, which is
  *more* unified than the original plan, not less. `client.getAuthMetadata()` (discovery)
  has the same underlying `window` dependency and is unavoidable (it's matrix-js-sdk's own
  recommended non-deprecated discovery path) — handled with a narrowly *scoped*
  install-then-remove `window` stub (`src/cli/oidcWindowPolyfill.ts`), used only around that
  one call at CLI login time. A *permanent* `globalThis.window` was tried first and broke
  something unrelated: `@matrix-org/matrix-sdk-crypto-wasm`'s own environment detection
  (`typeof window !== "undefined"` → assumes real browser IndexedDB) started throwing
  "Unsupported environment" the moment `window` existed at all, since the CLI's whole
  crypto-persistence design (D1) depends on Node being detected as Node.
- **DCR redirect URIs for the CLI's device-code client remain unverified against production
  MAS.** The local dev MAS's permissive policy (`allow_host_mismatch`, `allow_insecure_uris`)
  accepts a placeholder `http://localhost:0/` redirect URI that's never actually
  dereferenced (device-code never redirects a browser). Point 2 above ("device code also
  means the CLI needs no prod-MAS policy change at all") is about the *grant flow* needing
  no redirect — it's still true that no *authorization* redirect happens — but dynamic
  *client registration* itself still requires *some* syntactically valid `redirect_uris`
  entry, and whether telecrypt.io's stricter prod DCR policy accepts a loopback-style
  placeholder for a `native` client is unverified; only exercised against the local MAS.
  Do not assume this works against telecrypt.io without testing it there first.
- **Two real MAS-specific gotchas surfaced while getting the 51 tests green again** (full
  detail in `STATUS.md` Phase 10): Synapse refuses to start with delegation enabled AND the
  throwaway stack's old `enable_registration: true` override present ("Registration cannot
  be enabled when OAuth delegation is enabled") — removed the override, since account
  creation goes through MAS regardless. And MAS enforces the Matrix user ID grammar strictly
  (lowercase localpart only), unlike the old plain `POST /register`, which silently accepted
  mixed case — a few historically mixed-case test username prefixes needed defensive
  lowercasing.
- **A genuine flake, root-caused, not papered over:** MAS provisions the Synapse-side account
  *asynchronously* (confirmed via MAS's own background-job logs) — a login attempted before
  that job finishes can transiently 500. Invisible under light load, real under the full
  suite's concurrency once the OAuth test file joined it. Fixed by retrying login
  specifically on a 500 (bounded, polls the real condition), not a fixed sleep.
- **The PKCE "Playwright vs. programmatic" fallback question resolved itself:** MAS's login
  and consent pages turned out to be plain server-rendered forms with CSRF tokens and no JS
  challenge — easy to drive both in a real Playwright browser (`ui/test/e2e/oidc.spec.ts`,
  the spec's "ideal" path, built and green) and headlessly over raw HTTP with a hand-rolled
  cookie jar (used for the CLI's device-code approval in `test/functional/oidc.test.ts`,
  since that test needs to act as "the approving party" without a browser at all). No
  programmatic PKCE fallback was needed in addition to the Playwright test — the Playwright
  test alone satisfies that requirement.

All three deliverables (CLI device-code, UI PKCE, local MAS) ended up built and verified
end-to-end: 53/53 root tests (51 original + 2 new OIDC), 5/5 UI E2E (4 original + 1 new
OIDC/PKCE), all run multiple times including from a fresh `--fresh` stack, zero flakiness
after the fixes above. No `BLOCKERS.md` was needed.

---

## D5 — UI is a thin adapter over `core/`; browser IndexedDB is native, no snapshot

**Decision:** the React web UI (`ui/`) contains **no E2EE, sharing, or recovery logic of its
own** — it builds a session, calls `src/core/*` directly, and renders the typed results, exactly
mirroring what `src/cli/*` already does. Full spec: `docs/UI_SPEC.md`; what was built and how it
was tested: `STATUS.md` Phase 9.

**Why this was cheap:** this is the payoff of D3 (the `core/` extraction) — a UI needed zero new
business logic, only a new adapter layer (browser session construction + rendering), the same
shape as the CLI's `src/cli/storage.ts` + `output.ts`. Every hard, tested behavior (the
invite-then-setPermissions dance, not-found-vs-not-yet-synced polling, recovery bootstrap/restore)
was already sitting in `core/`, platform-agnostic by construction.

**Browser persistence needed zero new code**, which is the payoff of D1 (snapshot
`fake-indexeddb`, not a disk-native shim): D1 already established that CLI and browser call the
exact same `initRustCrypto({ useIndexedDB: true })` API — only the CLI needed extra machinery
(`fake-indexeddb` + snapshot-to-disk) because Node has no native IndexedDB. A browser tab does,
so `TeleCryptIOStorage.create({...})` (default `persistentCryptoStore: true`) just works, with the
crypto store persisting across reloads automatically. The UI persists exactly one thing itself,
in `localStorage`: `{homeserver, userId, deviceId, accessToken}` — everything else (megolm
sessions, cross-signing keys, backup state) lives in the browser's own IndexedDB, untouched by
UI code.

**The only genuinely new problem was a browser/bundler one, not a design one:** matrix-js-sdk's
WASM rust-crypto and `Buffer.from()` calls assume a Node-ish global environment a browser
doesn't have. Solved narrowly — `global: "globalThis"` in `vite.config.ts` plus a `buffer`
package polyfill wired to `globalThis.Buffer` in `main.tsx` — rather than reaching for a
kitchen-sink polyfill plugin; the WASM asset itself needed no special handling, since Vite's
built-in `new URL(..., import.meta.url)` asset resolution already covers how
`@matrix-org/matrix-sdk-crypto-wasm` loads its `.wasm` file. Full details in STATUS.md Phase 9.

**Verification, not just "the page renders":** a passing UI with silently-broken crypto would be
the exact silent-failure mode this project's own testing discipline warns against, so "boots" was
defined as login + a real `core.listFolders()` call succeeding with a clean console *before* any
further feature work — verified via a real Playwright run against a real Synapse, not a jsdom
mock. From there: 11 Vitest/RTL wiring tests (core/ mocked at the boundary — this is explicitly
where mocking is allowed) plus 4 Playwright E2E tests with zero mocks (real Synapse, real
rust-crypto, real two-`BrowserContext` multi-participant share, real fresh-device recovery
mirroring `test/functional/keys.test.ts` 5.3) — the full E2E suite run 3 times with zero
flakiness. Root suite re-confirmed at 51/51 after all UI work, with `ui/` excluded from the root
`vitest.config.ts` so the two suites can't cross-contaminate.

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
