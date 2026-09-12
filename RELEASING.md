# Releasing

Set the matching version in `package.json` and `package-lock.json`, then create and push an
annotated `vX.Y.Z` tag for that commit. The GitHub Actions workflow checks the tag, runs lint,
unit tests, and the build, creates the GitHub Release entry, and publishes the package through npm
Trusted Publishing. npm manages the OIDC authentication and provenance; this repository stores no
publish token.

The workflow uses the Node.js version in `.node-version` and the npm version in `packageManager`.
If a run stops after creating the GitHub Release or while publishing to npm, inspect both services
before retrying: npm package versions cannot be replaced.
