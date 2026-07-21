# Spec: Production functional tests (redpill-provisioned) + deployed-UI smoke, post-deploy

**Status:** to build. Rationale: real functional verification against production telecrypt.io
after every deployment, using throwaway accounts provisioned via redpill (no secrets).

## Verified facts (spiked live against real prod, 2026-07-21 — don't re-verify)

- **redpill** provisions a throwaway account: `POST https://telecrypt.io/redpill`, **no request
  body, no auth (public, credential-less)**. Returns JSON:
  `{ "mxid", "access_token", "device_id", "homeserver", "adopt_instructions" }`.
- Spiked: the returned token passes `/_matrix/client/v3/account/whoami` AND can `createRoom` on
  real prod. So it's a full, usable account — feed it straight into
  `TeleCryptIOStorage.create({ baseUrl: homeserver, userId: mxid, accessToken, deviceId })`.
- **Rate limit: HAProxy caps `POST /redpill` at 5/min per source IP** (see the owner's
  `freebsd_config.md`). Provision at most ~3 accounts per run, **serially**, in a `beforeAll`.
  Never parallelize redpill calls.
- **Cleanup of accounts is automatic**: unadopted agent accounts are reaped by the controlplane
  retention locker. Tests should still best-effort delete rooms/folders they create, but the
  accounts themselves need no teardown.
- Deployed web UI: `https://storage.telecrypt.io`. Production MAS issuer `https://telecrypt.io/auth/`.

## Part A — Production functional suite (`test/production/`)

Separate from the default `npm test` (which runs against the local disposable stack and must
NOT be affected). New script, e.g. `npm run test:prod`. It hits **real prod** — no local podman
stack, no MAS container.

Provision throwaway accounts via redpill in `beforeAll` (serially, ≤3), build
`TeleCryptIOStorage` instances from the returned tokens, and assert the real flows. The value
over the local suite is the **real Synapse + real S3 media backend + MAS-delegated auth + TLS
edge** — especially authenticated-media upload/download through the real path.

Required tests:
1. **Encrypted round-trip on real infra:** account A creates a folder, uploads a file, downloads
   it, bytes **byte-identical**. (Exercises real S3 media + authenticated download over the real
   edge — the thing the local media store can't fully replicate.)
2. **Multi-participant share on real infra:** A shares a folder with B (editor); B uploads a
   file; A downloads B's file, bytes identical. (Two redpill accounts.)
3. **Server never sees plaintext (prod):** fetch the raw media bytes from prod with an auth'd
   request and assert they ≠ the plaintext.
4. **Recovery setup on real MAS:** A `setupRecovery()` → assert `isRecoverySetup()` is true and a
   key backup is active against the real MAS/SSSS. **NOTE:** full cross-device *restore* needs
   the same account on a second device, which redpill can't provide (one account per call, no
   password). So prod covers recovery **setup/backup-active only**; full restore stays local
   (test 5.3). Document this in the test; do NOT fake a second device.

Constraints:
- **Best-effort cleanup:** after each test, delete the folders/files it created (leave the
  account to the locker). Wrap cleanup so a cleanup failure doesn't fail the test.
- Poll real conditions with the existing `waitFor`; never fixed sleeps.
- Node crypto store: use `fake-indexeddb` like the local tests (import `fake-indexeddb/auto` in
  the prod test file), per-account DB prefix to keep accounts isolated in-process.
- If redpill is unreachable or rate-limited, fail with a clear message (don't silently pass).

## Part B — Deployed-UI smoke (`test/production/deployed-ui.spec.ts`, Playwright, credential-free)

Load the **live** `https://storage.telecrypt.io` in a real browser and assert:
- The app **mounts** (a known element is visible — e.g. the "Log in with MAS/OIDC" button).
- **No console errors** on load. (This directly catches the blank-page / "Multiple
  matrix-js-sdk entrypoints" regression class on the real deployment — the bug that shipped
  today because the E2E only ran against the dev server.)
- Clicking "Log in with MAS/OIDC" **navigates to `https://telecrypt.io/auth/...`** (the real MAS
  authorize/login page) — proving dynamic client registration + redirect work against prod MAS.
  **Stop there — do NOT enter credentials.**

Because Pages CDN propagation lags a deploy, the smoke should first poll `https://storage.telecrypt.io/`
until it serves (and ideally until the freshly-built asset hash is live) before asserting — or
accept a short settle. Handle the browser cache (use a fresh context / bypass cache) so it tests
the new bundle, not a cached one.

## Part C — Run after every deployment

Wire these to run automatically post-deploy. Preferred: a **separate workflow**
`.github/workflows/prod-tests.yml` triggered `on: workflow_run` (when "Deploy UI to GitHub
Pages" completes successfully) **plus `workflow_dispatch`** for manual runs. It:
- installs deps (root + ui, since the prod functional suite uses the library and the smoke uses
  Playwright), builds nothing that needs the local stack,
- runs `npm run test:prod` (Part A) and the Playwright deployed-UI smoke (Part B) against live
  prod,
- **needs no secrets** (redpill is public).

A failing prod-test does not roll back the (already-published) deploy — it's a post-deploy
alert. That's the intended behavior for a smoke; make failures loud.

## Constraints

- The prod suite must be **fully separate** from `npm test` — a normal local/CI run must never
  hit prod. Guard by directory + a dedicated script + the workflow only.
- No secrets anywhere. No passwords. redpill is credential-less by design.
- Respect the 5/min redpill rate limit: ≤3 serial provisions per run.
- Never fake the recovery second-device step (redpill limitation) — document it.
- Do not modify the existing 53 local tests / 5 local UI E2E or the local stack.
- Update `STATUS.md` and `docs/DECISIONS.md` (new entry: prod testing via redpill). Commit + push.
