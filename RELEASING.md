# Releasing `@telecrypt-io/storage`

Publishing to npm is automated via GitHub Actions using **npm Trusted Publishing (OIDC)**.
There is no npm token stored anywhere — no `NODE_AUTH_TOKEN` secret in this repo, nothing to
rotate. The workflow (`.github/workflows/publish.yml`) authenticates to npm by presenting this
specific GitHub Actions run's OIDC identity, and npm only accepts that identity because a human
has explicitly told npmjs.com to trust it (the one-time setup below).

## One-time Trusted Publisher setup (completed)

The owner configured NPM Trusted Publishing for `TeleCrypt-io/storage-sdk` and `publish.yml`.
The first library-only release, `v0.2.0`, published successfully with provenance in GitHub Actions
run [30852528505](https://github.com/TeleCrypt-io/storage-sdk/actions/runs/30852528505).

For a future package/repository migration, someone with publish rights on the `@telecrypt-io` npm
org must configure the replacement package as npm expects for Trusted Publishing:

1. The `telecrypt-io` npm org already exists.
2. On npmjs.com, go to the replacement package's **Settings → Trusted Publisher**.
3. Add a **GitHub Actions** trusted publisher pointing at:
- **Repository:** `TeleCrypt-io/storage-sdk`
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
| First library-only `@telecrypt-io/storage` release | Automated — `v0.2.0` succeeded via OIDC |
| Every release after that: build + publish on tag push | Automated (`.github/workflows/publish.yml`) |
| Version bump + creating/pushing the git tag | **Human** (or a future release-automation step — not built yet) |

## Repository-split migration guard

`@telecrypt-io/storage@0.1.3` was published from the former combined repository and includes the
legacy `telecrypt-io` executable. It remains available and must not be replaced or republished by
this repository. The first library-only release from this repository was a breaking package change.
Its independent CLI replacement is now available as the GitHub-only
[`storage-cli-v0.1.2`](https://github.com/TeleCrypt-io/storage-cli/releases/tag/storage-cli-v0.1.2)
release, so that migration prerequisite is satisfied.

This migration was completed before `v0.2.0`: NPM now trusts `TeleCrypt-io/storage-sdk` and the
exact `publish.yml` workflow. Keep that binding tag-only; do not add a token, branch publication,
or manual publish path.

## Status of this workflow

`.github/workflows/publish.yml` matches NPM Trusted Publishing/OIDC requirements
(`permissions: id-token: write`, `registry-url` set via `actions/setup-node`, `npm publish
--provenance`, and no token secret). It was exercised end-to-end by `v0.2.0`: tag/version guard,
`npm ci`, lint, build, and provenance publication all succeeded. The workflow pins npm 11.5.1,
the minimum version supporting Trusted Publishing.
