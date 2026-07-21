# Spec: Deploy web UI to storage.telecrypt.io (GitHub Pages) + llms.txt

**Status:** to build. **Independent of the OAuth work** (does not touch auth code).
Rationale: `docs/DECISIONS.md` D6 (items 5–6).

## Part A — GitHub Pages deploy of `ui/` to storage.telecrypt.io

The web UI lives in `ui/` (Vite + React). Deploy its production build to GitHub Pages on a
custom domain `storage.telecrypt.io`.

1. **GitHub Actions workflow** `.github/workflows/deploy-ui.yml`:
   - Trigger: push to `main` affecting `ui/**` (and `workflow_dispatch`).
   - Steps: checkout → setup Node 22 → `cd ui && npm ci && npm run build` → upload the built
     `ui/dist` as a Pages artifact → deploy with `actions/deploy-pages`.
   - `permissions: { pages: write, id-token: write, contents: read }`, and a `github-pages`
     environment, per the standard GitHub Pages Actions pattern. Use the official
     `actions/configure-pages`, `actions/upload-pages-artifact`, `actions/deploy-pages`.
2. **Custom domain:** a `CNAME` file containing `storage.telecrypt.io` must end up at the root of
   the published artifact. Easiest: put `ui/public/CNAME` with that single line (Vite copies
   `public/` to `dist/`). Verify it lands in `dist/`.
3. **Vite base path:** for a custom-domain (apex-of-subdomain) deploy the site is served from
   `/`, so `base: '/'` is correct — confirm `ui/vite.config.ts` doesn't set a subpath base.
4. **Homeserver locked to telecrypt.io in production:** the deployed UI must authenticate against
   telecrypt.io only. Make the homeserver a build/config value (e.g. a Vite env var
   `VITE_HOMESERVER`, defaulting to `https://telecrypt.io` for the production build) and, when
   it's set, **hide the homeserver input** and use the fixed value. Local dev can still override
   it (e.g. to the local MAS/Synapse) via the env var. Do not hardcode in a way that blocks dev.
   **NOTE (OAuth already landed):** the UI now has MAS/OIDC login (authorization-code + PKCE) in
   addition to password — read the current login component first (`ui/src/components/LoginScreen.tsx`
   or wherever login now lives) and gate ONLY the homeserver input on `VITE_HOMESERVER`; do not
   touch the OAuth/PKCE logic. telecrypt.io advertises MAS, so with the homeserver fixed the
   OIDC "Log in with MAS" path is the natural primary in production. Redirect URI is already
   `window.location.origin + '/'`, which becomes `https://storage.telecrypt.io/` in prod — no
   change needed there. Verify `cd ui && npm run build && npm run dev` both still work after.
5. **SPA fallback:** if the UI uses only state/tab routing (no path-based routes), no 404
   fallback is needed — confirm. If it does use path routes, add a `404.html` copy of
   `index.html` (GitHub Pages SPA trick).

**Cannot be done from here (state clearly in output + STATUS.md):**
- Enabling Pages for the repo (Settings → Pages → source = GitHub Actions) — repo admin, once.
- The **DNS record**: a `CNAME` for `storage.telecrypt.io` → `telecrypt-io.github.io` (owner's
  DNS / geo_dns). HTTPS cert provisioning by GitHub lags a bit after DNS resolves.
- Setting the custom domain in repo Pages settings (or it's inferred from the CNAME file).

Do NOT attempt to change DNS or push to production infra. Produce the workflow + CNAME + config
and document the human steps precisely.

## Part B — llms.txt

Create `llms.txt` giving an LLM/agent a concise operating guide to the `telecrypt-io` CLI —
enough to drive it without reading the whole repo. Follow the llmstxt.org shape (H1 title, a
short blockquote summary, then sections). Include:
- What the tool is (E2EE file storage/sharing on Matrix; `npm i -g @telecrypt-io/storage`).
- The exact CLI command tree with one-line descriptions and real examples:
  `telecrypt-io storage login …`, `… folder create/list/share/members/unshare …`,
  `… file upload/list/download …`, `… recovery setup/restore …`. Pull the real command
  names/flags from `src/cli/index.ts` — do not invent.
- The `--json` flag (machine-readable output) and that commands exit non-zero with a JSON error
  on failure — the key facts an agent needs to script it reliably.
- A short "gotchas for agents" section: recovery key must be saved (only way to recover on a new
  device), sharing is by Matrix user id, files are E2EE so the server never sees plaintext.

Place it at **repo root** (`/llms.txt`) AND ensure it's served at the site root: copy it to
`ui/public/llms.txt` so the Pages build serves `storage.telecrypt.io/llms.txt`. (A build step or
a committed copy — keep them in sync; a one-line note in the CI or a `prebuild` copy is fine.)

## Constraints

- Do not touch auth code, the library, `core/`, or the existing tests. This task is deploy +
  docs only. The 51 + 4 tests must remain green (you likely won't run them, but don't break
  anything that would).
- `cd ui && npm run build` must succeed and produce `dist/` with `CNAME` and `llms.txt` at its
  root. Verify by listing `ui/dist/`.
- Keep `ui/` dev working (`npm run dev`) after the config change.
- Update `STATUS.md` with the deploy workflow, the exact human steps (enable Pages, DNS CNAME),
  and llms.txt locations. Commit + push to `origin main`.
- Report: the workflow added, that the build emits CNAME + llms.txt in dist/, the precise
  human/DNS steps still required, and the commit hash.
