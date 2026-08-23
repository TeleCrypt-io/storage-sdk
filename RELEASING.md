# Releasing `@telecrypt-io/storage`

Publishing to npm is automated via GitHub Actions using **npm Trusted Publishing (OIDC)**.
There is no npm token stored anywhere — no `NODE_AUTH_TOKEN` secret in this repo, nothing to
rotate. The workflow (`.github/workflows/publish.yml`) authenticates to npm by presenting this
specific GitHub Actions run's OIDC identity, and npm only accepts that identity because a human
has explicitly told npmjs.com to trust it.

## Release flow

1. Bump `version` in `package.json` (semver).
2. Commit that change.
3. Create an annotated tag and push it:
   ```sh
   git tag -a vX.Y.Z -m "Release vX.Y.Z"
   git push origin vX.Y.Z
   ```
4. GitHub Actions rejects a non-annotated tag, then runs `npm ci && npm run build && npm publish
   --access public --provenance`. npm refuses to publish an already-existing package version, and
   the new version appears on npm with a provenance
   attestation (visible on the npm package page as "Built and signed on GitHub Actions").

The workflow validates the exact tag and package version, then runs the release checks and publishes
with provenance. Keep publication bound to annotated exact-version tags; do not add token-based,
branch, or manual publish paths.
