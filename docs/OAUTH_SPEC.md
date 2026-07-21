# Spec: MAS/OAuth login (CLI device-code + Web UI PKCE), local MAS for tests

**Status:** to build. **Gate:** the existing 51 storage tests + 4 UI E2E stay green.
Full rationale: `docs/DECISIONS.md` D6. Read that first.

## Principle

OAuth is an **additive** auth path. It produces the same `{ accessToken, deviceId, userId,
MatrixClient }` the password path already produces — just through MAS/OIDC instead of
`m.login.password`. Do **not** rip out or change the password path; the 51 storage/E2EE tests
depend on it and must stay green.

## Verified facts (already checked against real telecrypt.io MAS — don't re-verify)

- Homeserver `https://telecrypt.io`, MAS issuer `https://telecrypt.io/auth/`.
- MAS endpoints: registration `/auth/oauth2/registration`, device `/auth/oauth2/device`,
  token `/auth/oauth2/token`, authorize `/auth/authorize`. DCR + PKCE S256 + device grant all on.
- MAS runs in **compatibility mode** → `m.login.password` still works (that's why the local MAS
  below can keep the password tests green).
- matrix-js-sdk (installed v41) OIDC API — use these, they exist under
  `node_modules/matrix-js-sdk/lib/oidc/`:
  `discoverAndValidateOIDCIssuerWellKnown`, `registerOidcClient`, `generateOidcAuthorizationUrl`,
  `completeAuthorizationCodeGrant`, `OidcTokenRefresher`, and `client.getAuthMetadata()`.
  Read the `.d.ts` files for exact signatures — do NOT guess.

## Part A — Local MAS in the throwaway stack (do this first; it unblocks testing)

Add a disposable MAS next to the disposable Synapse so OAuth can be tested with no prod
dependency. **We own it, so its DCR policy may allow `http://localhost` redirects freely.**

- Extend `throwaway_synapse/` (currently a single podman Synapse via `up.sh`/`down.sh`) to also
  run **MAS** and configure Synapse to delegate auth to it (MSC3861). Use the official MAS image
  (`ghcr.io/element-hq/matrix-authentication-service`) — check a working version tag.
- **Compatibility mode ON** so `m.login.password` still works (the 51 tests need it). Confirm by
  curling the local `/_matrix/client/v3/login` and seeing `m.login.password` in the flows.
- MAS client-registration policy: allow localhost + insecure (http) redirects, non-coherent
  hosts — this is a dev instance, be permissive.
- Provision users: the 51 tests create users via `POST /_matrix/client/v3/register`. Under MAS
  that likely moves — figure out the working path (MAS may still proxy register in compat mode,
  or use MAS's admin/registration API or a seeded user). **The 51 tests MUST still pass.** If
  register-through-MAS is fiddly, keep a password-capable route for them.
- `up.sh`/`down.sh` (or a sibling script) must bring the whole stack up/down cleanly, still
  **off by default**. Keep the plain-Synapse path working too if the 51 tests use it directly —
  simplest may be: MAS+Synapse compat stack that serves BOTH password (for the 51) and OIDC
  (for new OAuth tests). Decide and document.
- **If MAS+Synapse delegation proves too fiddly to get both password AND OIDC working in a
  reasonable effort, STOP and write `BLOCKERS.md`** with exactly where it wedged — do not fake
  it and do not break the 51 tests.

## Part B — OAuth in the library / core (shared by CLI and UI)

Add an OIDC login capability alongside the existing password `create()`. Keep it browser-safe
where it lives in `core/` (no node-only imports); node-specific bits (device-code polling, a
browser-open, token file persistence) belong in the CLI adapter, not `core/`.

Provide, using the verified matrix-js-sdk OIDC API:
- **Discovery:** from a homeserver base URL → issuer config (`getAuthMetadata` /
  `discoverAndValidateOIDCIssuerWellKnown`).
- **Dynamic client registration** (`registerOidcClient`) with this app's metadata; the caller
  supplies redirect URIs / client name.
- **Device-code flow** (for the CLI): request a device+user code from the device endpoint, and a
  poll-until-authorized that exchanges for tokens. The SDK's helpers are redirect-oriented, so
  device-code likely needs a small manual implementation against the `device_authorization_endpoint`
  + `token_endpoint` from discovery — check whether the SDK wraps it; if not, implement per
  RFC 8628 (poll with `grant_type=urn:ietf:params:oauth:grant-type:device_code`, honor
  `interval`/`expires_in`, handle `authorization_pending`/`slow_down`).
- **Authorization-code + PKCE** (for the UI): `generateOidcAuthorizationUrl` to start,
  `completeAuthorizationCodeGrant` to finish after redirect.
- **Token refresh:** wire `OidcTokenRefresher` so access tokens renew; expose the persisted
  token set (access, refresh, expiry, issuer, clientId) so adapters can store it.
- A `TeleCryptIOStorage.createFromOidc(...)` (or equivalent) that takes the resulting tokens and
  returns a ready storage instance with refresh wired — mirroring `create()` but OIDC-sourced.

## Part C — CLI: device-code login

- `telecrypt-io storage login --oidc` (and/or make `login` detect MAS and prefer OIDC): run the
  device-code flow. Print the `verification_uri` (+ `verification_uri_complete` if present) and
  the short `user_code`; try to auto-open the browser; poll until approved; persist the OIDC
  token set + `client_id` + issuer into the existing profile (`TELECRYPT_IO_STORAGE_HOME`), so
  later commands reuse them and refresh works across processes.
- Existing password `login` stays as-is (works against the plain test Synapse).
- Homeserver arg: `--homeserver https://telecrypt.io` (default can stay localhost for dev).

## Part D — Web UI: authorization-code + PKCE

In `ui/` (its own package; import only `src/core/*` + `src/TeleCryptIOStorage.ts`):
- On "Log in", run OIDC: discover issuer for the configured homeserver → DCR (cache the
  returned `client_id` in `localStorage`, reuse it; do NOT re-register each load) → build the
  PKCE authorization URL (persist code_verifier + `state` in `sessionStorage`) → redirect.
- On app load, detect the `?code&state` callback, complete the token exchange, clear the query
  params, store the token set in `localStorage`, wire `OidcTokenRefresher`, and enter the
  logged-in app.
- Redirect URI = the app's own origin (`window.location.origin + '/'`). Works for both
  `http://localhost:5173/` (dev, against local MAS) and `https://storage.telecrypt.io/` (prod).
- Keep the existing password login too (still useful against a plain Synapse); MAS/OIDC is the
  path for telecrypt.io. It's fine to show OIDC as primary when the homeserver advertises it.

## Tests (real servers, no mocks)

1. **51 storage tests + 4 UI E2E stay green** — primary gate. Re-run them.
2. **New OAuth functional tests against the local MAS:**
   - Device-code end-to-end: drive the flow programmatically (the test can act as the approving
     party by calling MAS's endpoints directly, since it controls the dev MAS / test user) and
     assert it yields a working token + a usable `TeleCryptIOStorage` (create a folder with it).
   - Authorization-code + PKCE: exercise discovery → DCR → auth URL → code → token exchange
     against local MAS, asserting a working token. (A Playwright UI E2E driving the MAS login
     page is ideal; if the MAS login UI is hard to drive headlessly, a programmatic
     code-grant test against the endpoints is an acceptable substitute — document which.)
   - Token refresh: assert a refresh yields a new access token.
   If any of these genuinely can't run against the local MAS, document precisely in `BLOCKERS.md`
   — never weaken/skip. No `.skip`/`.only`/`.todo`.

## Constraints

- Never weaken the 51 tests or the 4 UI E2E. OAuth is additive.
- No mocks in functional tests — real local MAS + Synapse via podman. Poll real conditions with
  `waitFor`, never fixed sleeps; no flaky green.
- Do NOT modify production telecrypt.io or its MAS in any way. All dev/testing is against the
  local disposable MAS.
- `npm run lint` + `npm run build` (root and `ui/`) pass. Update `STATUS.md` and append the
  actual outcome to `docs/DECISIONS.md` D6 if reality differed. Commit + push to `origin main`.
- Report: what works end-to-end against local MAS (device-code, PKCE, refresh), the one
  harness change for user-creation-under-MAS, whether the 51+4 stayed green, anything in
  BLOCKERS.md, and the commit hash.
