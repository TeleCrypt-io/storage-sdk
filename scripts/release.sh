#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
mode="${1:?usage: bash scripts/release.sh prepare|publish TAG}"
tag="${2:?release tag required}"
case "$mode" in prepare|publish) ;; *) echo 'Expected prepare or publish' >&2; exit 2;; esac
sha="$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
[[ "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
test "$(git cat-file -t "refs/tags/$tag")" = tag
test "$(git rev-parse "$tag^{commit}")" = "$sha"
version="${tag#v}"
test "$(node -p 'require("./package.json").name')" = '@telecrypt-io/storage'
test "$(node -p 'require("./package-lock.json").name')" = '@telecrypt-io/storage' 
test "$version" = "$(node -p 'require("./package.json").version')"
test "$version" = "$(node -p 'require("./package-lock.json").packages[""].version')"
directory="release/$tag"
asset="telecrypt-io-storage-$version.tgz"
if [[ "$mode" == prepare ]]; then
test "$(node --version)" = "v$(cat .node-version)"
test "$(npm --version)" = "$(node -p 'require("./package.json").packageManager.replace(/^npm@/u, "")')"
npm ci --ignore-scripts --no-fund --no-audit
npm run lint
npm run test:unit
rm -rf -- dist
npm run build
mkdir -p "$directory"
npm pack --ignore-scripts --pack-destination "$directory"
jq -n --arg sha "$sha" --arg asset "$asset" --arg digest "sha256:$(sha256sum "$directory/$asset" | cut -d' ' -f1)" --argjson size "$(wc -c <"$directory/$asset")" '{sha:$sha,asset:$asset,digest:$digest,size:$size}' >"$directory/manifest.json"
printf 'Prepared %s/%s; publish with: bash scripts/release.sh publish %s\n' "$directory" "$asset" "$tag"
else
test "$(jq -r .sha "$directory/manifest.json")" = "$sha"
test "$(jq -r .asset "$directory/manifest.json")" = "$asset"
digest="$(jq -r .digest "$directory/manifest.json")"
size="$(jq -r .size "$directory/manifest.json")"
test "sha256:$(sha256sum "$directory/$asset" | cut -d' ' -f1)" = "$digest"
test "$(wc -c <"$directory/$asset")" = "$size"
test "$(gh api "repos/TeleCrypt-io/storage-sdk/git/ref/tags/$tag" --jq .object.sha)" = "$(git rev-parse "refs/tags/$tag")"
npm whoami >/dev/null
npm publish "$directory/$asset" --ignore-scripts --access public
gh release create "$tag" "$directory/$asset" --repo TeleCrypt-io/storage-sdk --verify-tag --target "$sha" --generate-notes
fi
