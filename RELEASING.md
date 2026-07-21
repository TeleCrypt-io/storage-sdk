# Releasing `@telecrypt-io/storage`

Publishing to npm is automated via GitHub Actions using **npm Trusted Publishing (OIDC)**.
There is no npm token stored anywhere — no `NODE_AUTH_TOKEN` secret in this repo, nothing to
rotate. The workflow (`.github/workflows/publish.yml`) authenticates to npm by presenting this
specific GitHub Actions run's OIDC identity, and npm only accepts that identity because a human
has explicitly told npmjs.com to trust it (the one-time setup below).

## One-time human setup (cannot be done from CI)

Before the first automated publish can succeed, someone with publish rights on the
`@telecrypt-io` npm org must configure this package as npm expects for Trusted Publishing:

1. The `telecrypt-io` npm org already exists.
2. On npmjs.com, go to the `@telecrypt-io/storage` package's **Settings → Trusted Publisher**
   (if the package doesn't exist on npm yet, the first publish must be done manually — `npm
   publish` from a machine logged in as an org member with an authenticator — after which
   Trusted Publishing can be configured for all subsequent releases).
3. Add a **GitHub Actions** trusted publisher pointing at:
   - **Repository:** `TeleCrypt-io/secure-storage`
   - **Workflow filename:** `publish.yml`
   - **Environment:** none required unless you choose to gate the job behind a GitHub
     Environment (not currently configured in the workflow)
4. Save. From this point on, a push of any `v*` tag from this repo triggers `publish.yml`, which
   authenticates via OIDC (no token) and publishes with provenance.

## Release flow (routine, after the one-time setup)

1. Bump `version` in `package.json` (semver).
2. Commit that change.
3. Tag it and push the tag:
   ```sh
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
4. GitHub Actions picks up the `v*` tag push, runs `npm ci && npm run build && npm publish
   --access public --provenance`, and the new version appears on npm with a provenance
   attestation (visible on the npm package page as "Built and signed on GitHub Actions").

Nothing else is required from a human for a routine release — steps 1–3 above are it.

## What's automated vs what a human must still do

| Step | Automated? |
|---|---|
| Configuring npm to trust this repo's `publish.yml` (one-time) | **Human — npmjs.com UI** |
| First publish of the package, if `@telecrypt-io/storage` doesn't exist on npm yet | **Human — manual `npm publish`** |
| Every release after that: build + publish on tag push | Automated (`.github/workflows/publish.yml`) |
| Version bump + creating/pushing the git tag | **Human** (or a future release-automation step — not built yet) |

## Status of this workflow

`.github/workflows/publish.yml` is written to match npm's current Trusted Publishing / OIDC
documentation (`permissions: id-token: write`, `registry-url` set via `actions/setup-node`, `npm
publish --provenance`, no token secret). It has **not** been exercised end-to-end — that requires
the human npmjs.com Trusted Publisher configuration above plus a real `vX.Y.Z` tag push, neither
of which this session could do. The first real release is what validates it; if it fails, the
likely culprits are (a) the Trusted Publisher config on npmjs.com not matching the repo/workflow
filename exactly, or (b) the npm CLI version in the runner being older than the 11.5.1 minimum
Trusted Publishing requires (the workflow pins `npm install -g npm@latest` specifically to avoid
this).
