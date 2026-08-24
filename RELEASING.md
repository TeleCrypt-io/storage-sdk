# Releasing `@telecrypt-io/storage`

Publishing to npm is automated via GitHub Actions using **npm Trusted Publishing (OIDC)**.
There is no npm token stored anywhere — no `NODE_AUTH_TOKEN` secret in this repo, nothing to
rotate. The workflow (`.github/workflows/publish.yml`) authenticates to npm by presenting this
specific GitHub Actions run's OIDC identity, and npm only accepts that identity because a human
has explicitly told npmjs.com to trust it.

The build job uses the tested exact Node.js `22.23.2` LTS runner and its bundled npm `10.9.8`,
matching the `packageManager` declaration in `package.json`. The publication job first verifies
that toolchain, then deliberately installs and verifies npm `11.5.1` for Trusted Publishing.
Dependency installation is always exact-lock and lifecycle-disabled, with funding and audit network
calls disabled; changing either Node or npm toolchain requires a fresh release-workflow verification.

Before the first release, an operator must enable and verify the repository's GitHub **immutable
releases** setting. The Actions token cannot read or change that repository setting, so the
workflow cannot perform this preflight; it fails closed later unless the resulting Release reports
`immutable: true`.

The repository must also protect the `v*` tag pattern against updates and deletion, without a
workflow bypass. This is an external repository/org prerequisite to verify before the first
release; the Actions token cannot prove or enforce that administrative setting. The workflow's
immediate pre/post exact-tag checks remain defense in depth, while the protection rule closes the
otherwise unavoidable race between those checks and immutable publication.

## Release flow

1. Bump `version` in `package.json` (semver).
2. Commit that change.
3. Create an annotated tag and push it:
   ```sh
   git tag -a vX.Y.Z -m "Release vX.Y.Z"
   git push origin vX.Y.Z
   ```
4. GitHub Actions rejects a non-annotated tag, rechecks the remote tag and `main` identity, then
   installs dependencies without lifecycle scripts and runs lint, unit tests, and the build once.
   It verifies the exact package contents and creates one tested archive with SHA-256/SHA-512
   digests plus a small `vX.Y.Z.integrity.json` release asset binding those digests to the annotated
   tag, commit, package, version, and byte size. The
   release job queries only the exact tag endpoint so it can safely recover an exact existing draft or
   published Release after a lost response. It accepts only the exact tag, body, source, asset name,
   size, and digest; a matching draft is verified and then published, while any mismatch, ambiguity,
   or unconfirmed endpoint response fails closed. New Releases are created as drafts from the annotated tag and
   are published only after the same exact contract is proven; the final immutable Release must
   retain its exact identity and created timestamp.
5. Only after that immutable GitHub Release gate passes does the workflow publish the tested archive
   with npm Trusted Publishing/OIDC and provenance; it never rebuilds or repacks for publication.
   After publication, npm registry distribution metadata and the package git head are fetched with
   finite bounds and compared to the tested archive, its integrity record, and the exact release
   commit. npm's provenance attestation presence and signature verification are also required. A rerun
   may reuse an already-published version only when every checked field and byte matches; otherwise
   it fails closed.

The workflow validates the exact tag and package version, then runs the release checks, immutable
GitHub Release gate, and npm publication with provenance. Keep publication bound to
annotated exact-version tags; do not add token-based, branch, or manual publish paths.
