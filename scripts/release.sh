#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
mode="${1:?usage: bash scripts/release.sh prepare TAG}"
tag="${2:?release tag required}"
case "$mode" in prepare) ;; *) echo 'Expected prepare; publish through the release.yml workflow' >&2; exit 2;; esac
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
printf 'Prepared %s/%s; after pushing the commit and tag, publish with: gh workflow run release.yml --repo TeleCrypt-io/storage-sdk --ref %s\n' "$directory" "$asset" "$tag"
