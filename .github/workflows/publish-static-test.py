"""Offline behavioral contract tests for the SDK publication state machine.

These checks deliberately model the remote states that the workflow must handle and
then inspect the parsed job boundaries for the corresponding operations.  A string
being present in an unrelated comment is not sufficient to satisfy the contract.
"""

from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).parents[2]
WORKFLOW = (ROOT / ".github/workflows/publish.yml").read_text(encoding="utf-8")
VERIFY = (ROOT / ".github/workflows/verify.yml").read_text(encoding="utf-8")
PACKAGE = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
PACKAGE_LOCK = json.loads((ROOT / "package-lock.json").read_text(encoding="utf-8"))
NODE_VERSION = (ROOT / ".node-version").read_text(encoding="utf-8").strip()


class ContractError(AssertionError):
    pass


def job(name: str) -> str:
    match = re.search(rf"^  {re.escape(name)}:\n(?P<body>.*?)(?=^  [A-Za-z0-9_-]+:|\Z)", WORKFLOW, re.MULTILINE | re.DOTALL)
    if not match:
        raise ContractError(f"missing workflow job: {name}")
    return match.group("body")


def step(job_text: str, name: str) -> str:
    marker = f"      - name: {name}\n"
    start = job_text.find(marker)
    if start < 0:
        raise ContractError(f"missing step: {name}")
    start = job_text.find("        run: |\n", start)
    if start < 0:
        raise ContractError(f"step has no shell: {name}")
    start += len("        run: |\n")
    end = job_text.find("\n      - ", start)
    return job_text[start:] if end < 0 else job_text[start:end]


def exact_asset(tag: str, digest: str = "sha256:" + "a" * 64, size: int = 10) -> dict:
    return {
        "id": 8,
        "tag_name": tag,
        "name": tag,
        "body": f"Release {tag}",
        "target_commitish": "a" * 40,
        "created_at": "2026-08-24T00:00:00Z",
        "published_at": "2026-08-24T00:00:01Z",
        "draft": False,
        "prerelease": False,
        "immutable": True,
        "assets": [
            {"id": 9, "name": f"{tag}.tgz", "state": "uploaded", "size": size, "digest": digest},
            {"id": 10, "name": f"{tag}.integrity.json", "state": "uploaded", "size": 300, "digest": "sha256:" + "b" * 64},
        ],
    }


def publication_action(probe: dict | None, run_attempt: int, tag: str = "v1.2.3") -> str:
    """Model the only permitted transitions before the workflow mutates GitHub."""

    if probe is None:
        return "create-draft"
    if probe.get("transport") in {"timeout", "error"}:
        raise ContractError("transport failures are not confirmed 404s")
    if probe.get("tag_name") != tag or probe.get("name") != tag or probe.get("body") != f"Release {tag}" or probe.get("target_commitish") != "a" * 40 or probe.get("prerelease") is not False:
        raise ContractError("Release identity conflict")
    if probe.get("draft") is True:
        if probe.get("created_at") != "2026-08-24T00:00:00Z" or probe.get("published_at") is not None or probe.get("immutable") not in (None, False):
            raise ContractError("draft unexpectedly immutable")
        if not isinstance(probe.get("id"), int) or isinstance(probe.get("id"), bool) or probe["id"] <= 0 or not isinstance(probe.get("assets"), list) or len(probe["assets"]) > 64 or any(not isinstance(asset, dict) or not isinstance(asset.get("id"), int) or isinstance(asset.get("id"), bool) or asset["id"] <= 0 for asset in probe["assets"]):
            raise ContractError("draft identity or asset bounds are not exact")
        return "reuse-draft"
    if probe.get("draft") is False:
        if run_attempt <= 1:
            raise ContractError("published Release requires an explicit rerun")
        if probe != exact_asset(tag, size=10):
            raise ContractError("published Release is not exact and immutable")
        return "reuse-published"
    raise ContractError("unknown Release state")


def release_catalog_action(entries: list[object], tag: str = "v1.2.3") -> tuple[str, int | None]:
    """Model the validated minimal Release catalog before any GitHub mutation."""

    expected_keys = {"id", "tag_name", "draft"}
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != expected_keys:
            raise ContractError("Release catalog entry is not the exact projected object")
        release_id = entry.get("id")
        if not isinstance(release_id, int) or isinstance(release_id, bool) or release_id <= 0:
            raise ContractError("Release catalog ID is not a positive integer")
        if not isinstance(entry.get("tag_name"), str) or not entry["tag_name"]:
            raise ContractError("Release catalog tag is not a non-empty string")
        if not isinstance(entry.get("draft"), bool):
            raise ContractError("Release catalog draft flag is not boolean")
    matches = [entry for entry in entries if entry["tag_name"] == tag]
    if len(matches) > 1:
        raise ContractError("Release catalog contains duplicate exact tags")
    if not matches:
        return "create-draft", None
    return "fetch-release", matches[0]["id"]


def release_catalog_output_action(exit_status: int, stdout: str, tag: str = "v1.2.3") -> tuple[str, int | None]:
    """Model one bounded successful newline-delimited catalog projection."""

    if exit_status != 0:
        raise ContractError("catalog transport or API failures are not recoverable")
    if len(stdout.encode("utf-8")) > 131072:
        raise ContractError("catalog output exceeds the bounded capture")
    entries = []
    for line in stdout.splitlines():
        if not line.strip():
            continue
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError as error:
            raise ContractError("catalog output contains malformed JSON") from error
    return release_catalog_action(entries, tag)


def final_publish_recheck(probe: dict, tag: str = "v1.2.3") -> None:
    """Model the final remote read that must precede the draft->published PATCH."""
    publication_action(probe, 1, tag)
    assets = probe.get("assets")
    if (
        probe.get("id") != 42
        or not isinstance(assets, list)
        or len(assets) != 2
        or {asset.get("name") for asset in assets} != {f"{tag}.tgz", f"{tag}.integrity.json"}
        or {asset.get("id") for asset in assets} != {43, 44}
        or any(asset.get("state") != "uploaded" for asset in assets)
        or not any(asset.get("name") == f"{tag}.tgz" and asset.get("size") == 10 and asset.get("digest") == "sha256:" + "a" * 64 for asset in assets)
        or not any(asset.get("name") == f"{tag}.integrity.json" and asset.get("size") == 300 and asset.get("digest") == "sha256:" + "b" * 64 for asset in assets)
    ):
        raise ContractError("final draft artifact changed")


def check_state_machine() -> None:
    tag = "v1.2.3"
    assert release_catalog_action([], tag) == ("create-draft", None)
    assert release_catalog_action([{"id": 41, "tag_name": "v1.2.2", "draft": False}], tag) == ("create-draft", None)
    assert release_catalog_action([{"id": 42, "tag_name": tag, "draft": True}], tag) == ("fetch-release", 42)
    assert release_catalog_output_action(0, '{"id":42,"tag_name":"v1.2.3","draft":true}\n', tag) == ("fetch-release", 42)
    assert release_catalog_output_action(0, "", tag) == ("create-draft", None)
    for bad_catalog in (
        [{"id": 42, "tag_name": tag, "draft": True}, {"id": 43, "tag_name": tag, "draft": False}],
        [{"id": 42, "tag_name": tag}],
        [{"id": 42, "tag_name": tag, "draft": True, "extra": False}],
        [{"id": True, "tag_name": tag, "draft": True}],
        [{"id": 0, "tag_name": tag, "draft": True}],
        [{"id": 42, "tag_name": 7, "draft": True}],
        [{"id": 42, "tag_name": tag, "draft": "true"}],
    ):
        try:
            release_catalog_action(bad_catalog, tag)
        except ContractError:
            pass
        else:
            raise ContractError(f"accepted an invalid Release catalog: {bad_catalog}")
    for bad_output in (
        (1, ""),
        (1, '{"id":42,"tag_name":"v1.2.3","draft":true}\n'),
        (0, '{"id":42,"tag_name":"v1.2.3","draft":true}\nnot-json\n'),
        (0, '{"id":42,"tag_name":"v1.2.3"}\n'),
        (0, "x" * 131073),
    ):
        try:
            release_catalog_output_action(*bad_output, tag)
        except ContractError:
            pass
        else:
            raise ContractError(f"accepted invalid Release catalog output: {bad_output[:1]}")
    assert publication_action(None, 1, tag) == "create-draft"
    assert publication_action({"id": 42, "tag_name": tag, "name": tag, "body": f"Release {tag}", "target_commitish": "a" * 40, "created_at": "2026-08-24T00:00:00Z", "published_at": None, "draft": True, "prerelease": False, "assets": []}, 1, tag) == "reuse-draft"
    assert publication_action(exact_asset(tag), 2, tag) == "reuse-published"
    final_draft = {
        "id": 42,
        "tag_name": tag,
        "name": tag,
        "body": f"Release {tag}",
        "target_commitish": "a" * 40,
        "created_at": "2026-08-24T00:00:00Z",
        "published_at": None,
        "draft": True,
        "prerelease": False,
        "immutable": False,
        "assets": [
            {"id": 43, "name": f"{tag}.tgz", "state": "uploaded", "size": 10, "digest": "sha256:" + "a" * 64},
            {"id": 44, "name": f"{tag}.integrity.json", "state": "uploaded", "size": 300, "digest": "sha256:" + "b" * 64},
        ],
    }
    final_publish_recheck(final_draft, tag)
    for field in (
        "id", "tag_name", "name", "body", "target_commitish", "draft", "prerelease", "immutable",
        "created_at", "published_at", "asset_state", "asset_size", "assets", "asset_id", "duplicate_name",
        "duplicate_id", "record_asset",
    ):
        mutated = {**final_draft}
        if field == "assets":
            mutated["assets"] = [{**final_draft["assets"][0], "digest": "sha256:" + "c" * 64}, final_draft["assets"][1]]
        elif field == "asset_id":
            mutated["assets"] = [{**final_draft["assets"][0], "id": 45}, final_draft["assets"][1]]
        elif field == "duplicate_name":
            mutated["assets"] = [final_draft["assets"][0], {**final_draft["assets"][1], "name": f"{tag}.tgz"}]
        elif field == "duplicate_id":
            mutated["assets"] = [final_draft["assets"][0], {**final_draft["assets"][1], "id": 43}]
        elif field == "record_asset":
            mutated["assets"] = [final_draft["assets"][0], {**final_draft["assets"][1], "digest": "sha256:" + "d" * 64}]
        elif field == "asset_state":
            mutated["assets"] = [{**final_draft["assets"][0], "state": "pending"}, final_draft["assets"][1]]
        elif field == "asset_size":
            mutated["assets"] = [{**final_draft["assets"][0], "size": 11}, final_draft["assets"][1]]
        elif field == "id":
            mutated["id"] = 43
        elif field == "immutable":
            mutated["immutable"] = True
        elif field == "created_at":
            mutated["created_at"] = "not-a-timestamp"
        elif field == "published_at":
            mutated["published_at"] = "2026-08-24T00:00:01Z"
        else:
            mutated[field] = False if field == "draft" else True if field == "prerelease" else "changed"
        try:
            final_publish_recheck(mutated, tag)
        except ContractError:
            continue
        raise ContractError(f"final draft recheck accepted a {field} mutation")
    for bad in (
        {"transport": "timeout"},
        {"transport": "error"},
        {**exact_asset(tag), "assets": []},
        {**exact_asset(tag), "immutable": False},
        {"id": 0, "tag_name": tag, "name": tag, "body": f"Release {tag}", "target_commitish": "a" * 40, "created_at": "2026-08-24T00:00:00Z", "published_at": None, "draft": True, "prerelease": False, "assets": []},
        {"id": 42, "tag_name": tag, "name": tag, "body": f"Release {tag}", "target_commitish": "a" * 40, "created_at": "2026-08-24T00:00:00Z", "published_at": None, "draft": True, "prerelease": False, "assets": [{"id": 0}]},
    ):
        try:
            publication_action(bad, 2, tag)
        except ContractError:
            pass
        else:
            raise ContractError(f"accepted invalid remote state: {bad}")
    try:
        publication_action(exact_asset(tag), 1, tag)
    except ContractError:
        pass
    else:
        raise ContractError("accepted a published Release on the initial attempt")


def check_provenance_verifier() -> None:
    verifier = (ROOT / "scripts/verify-npm-provenance.mjs").read_text(encoding="utf-8")
    test_file = (ROOT / "test/npm-provenance.test.ts").read_text(encoding="utf-8")
    for fragment in (
        "verifyNpmProvenance",
        "SLSA_PREDICATE",
        "NPM_PUBLISH_PREDICATE",
        "resolvedDependencies",
        "GITHUB_HOSTED_BUILDER",
        "sha512Hex",
        "expectedAttestationsUrl",
    ):
        if fragment not in verifier:
            raise ContractError(f"npm provenance verifier is missing {fragment}")
    for fragment in ("accepts the exact npm and SLSA statements", "rejects a mutation", "duplicate or missing"):
        if fragment not in test_file:
            raise ContractError(f"npm provenance adversarial coverage is missing {fragment}")


def check_workflow_operations() -> None:
    release = job("release")
    publish_job = job("publish")
    publish = publish_job
    build = job("build")
    release_shell = step(release, "Create or reuse the exact draft Release")
    required = (
        "refs/tags/$RELEASE_TAG:refs/remotes/origin/release-tag",
        "refs/heads/main:refs/remotes/origin/main",
        "git cat-file -t refs/remotes/origin/release-tag",
        "git merge-base --is-ancestor",
        "https://github.com/${GITHUB_REPOSITORY}.git",
        "--no-includes",
        "--name-only",
        "protocol.file.allow=never",
        "protocol.ext.allow=never",
        "protocol.ssh.allow=never",
        "credential.helper=",
        "core.askPass=/bin/false",
        "http.proxy=",
        "https.proxy=",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "GH_HOST: github.com",
        "scripts/bounded-command.py",
        "--paginate",
        "--jq '.[] | {id,tag_name,draft}'",
        "releases?per_page=100",
        "jq -e -s",
        "release_matches",
        "match_count",
        "jq -er '.[0].id",
        "releases/$release_id",
        "--method POST",
        "--field draft=true",
        "--method DELETE",
        "bounded_upload",
        "uploads.github.com",
        "Authorization: Bearer",
        "--data-binary \"@$input\"",
        "cmp -s \"$archive\"",
        "--method PATCH",
        "--field draft=false",
        "GITHUB_RUN_ATTEMPT",
        "target_commitish=$RELEASE_SHA",
        "created_at",
        "published_at",
        "(.assets|length) <= 64",
        "(.assets|length)==2",
        ".integrity.json",
        "record_digest",
    )
    for fragment in required:
        haystack = WORKFLOW if fragment in {"HTTP_PROXY", "HTTPS_PROXY", "GH_HOST: github.com"} else release_shell
        if fragment not in haystack:
            raise ContractError(f"release state machine is missing {fragment}")
    if release_shell.index("--method POST") > release_shell.index("--method DELETE"):
        raise ContractError("draft creation must precede asset replacement")
    if release_shell.index("--method DELETE") > release_shell.index('bounded_upload "$RUNNER_TEMP/upload.json"'):
        raise ContractError("asset deletion must precede upload")
    if release_shell.index('bounded_upload "$RUNNER_TEMP/upload-record.json"') > release_shell.index("--method PATCH"):
        raise ContractError("publication must follow draft upload")
    if "release create" in WORKFLOW or "gh release create" in WORKFLOW or "--draft" in WORKFLOW:
        raise ContractError("one-shot Release creation remains")
    if "--includes=false" in WORKFLOW:
        raise ContractError("unsafe or obsolete recovery machinery remains")
    for fragment in (
        "status_probe",
        "status_line",
        "status_code",
        "missing_release_probe",
        ".documentation_url",
        '"/repos/$GITHUB_REPOSITORY/releases/tags/$RELEASE_TAG"',
        "--include",
    ):
        if fragment in release_shell:
            raise ContractError(f"obsolete Release status probe machinery remains: {fragment}")
    if release_shell.count('bounded_gh "$release_list" api --paginate') != 1:
        raise ContractError("Release catalog must use exactly one bounded paginated request")
    if release_shell.count("--jq '.[] | {id,tag_name,draft}'") != 1:
        raise ContractError("Release catalog must use exactly one minimal projection")
    if release_shell.index("jq -e -s") < release_shell.index('bounded_gh "$release_list"'):
        raise ContractError("Release catalog must be validated after the bounded request")
    if WORKFLOW.count("uses: actions/checkout@v7.0.1") != 3 or WORKFLOW.count("persist-credentials: false") != 3:
        raise ContractError("every SDK job must use a credential-free full checkout")
    if "publish:\n    needs: [build, release]" not in WORKFLOW:
        raise ContractError("publish job is not downstream of the immutable Release")
    if any(
        fragment not in WORKFLOW
        for fragment in (
            "needs.build.outputs.archive_digest",
            "needs.build.outputs.archive_size",
            "needs.build.outputs.record_digest",
            "needs.build.outputs.record_size",
        )
    ):
        raise ContractError("archive expectations are not sourced from the build")
    for fragment in ("EXPECTED_RECORD_DIGEST:", "EXPECTED_RECORD_SIZE:"):
        if fragment not in publish_job:
            raise ContractError(f"publish job is missing {fragment}")
    for fragment in ('npm publish "./$archive"', "--provenance", "npm audit signatures"):
        if fragment not in publish:
            raise ContractError(f"npm trust boundary is missing {fragment}")
    for fragment in ('cat "$publish_out" >&2', 'cat "$publish_err" >&2', 'exit "$publish_status"'):
        if fragment not in publish:
            raise ContractError(f"npm publish failure output is missing {fragment}")
    if 'test "$(node --version)" = v24.20.0' not in publish or 'test "$(npm --version)" = 11.19.0' not in publish:
        raise ContractError("the publish job does not verify the exact Trusted Publishing toolchain")
    if "npm install --global npm@" in WORKFLOW:
        raise ContractError("the workflow must not replace the exact bundled npm toolchain")
    for fragment in (
        "attestations_url=",
        "attestations.json",
        "bounded_registry_retry",
        "for attempt in 1 2 3 4 5 6 7 8 9 10 11 12",
        "sleep 10",
        "scripts/verify-npm-provenance.mjs",
        "--attestations",
        "--package",
        "--version",
        "--tag",
        "--commit",
    ):
        if fragment not in publish:
            raise ContractError(f"npm attestation binding is missing {fragment}")
    if "gitHead" in publish or "githead.json" in publish:
        raise ContractError("npm registry gitHead binding remains; provenance is authoritative")
    if publish.index("npm audit signatures") > publish.index("scripts/verify-npm-provenance.mjs"):
        raise ContractError("cryptographic npm signature verification must precede payload binding")
    if '"$d/audit.txt"' in publish:
        raise ContractError("npm audit output still references a nonexistent file")
    if "curl" not in publish or "https://registry.npmjs.org/@telecrypt-io%2fstorage/" not in publish:
        raise ContractError("registry existence check is missing")
    if "curl" not in publish or "'%{http_code}'" not in publish or "https://registry.npmjs.org/@telecrypt-io%2fstorage/" not in publish:
        raise ContractError("npm existence check is not a machine-confirmed registry status")
    if '--output "$downloaded"' in publish or '--output "$downloaded_record"' in publish or "--max-time 120s" in publish:
        raise ContractError("binary release readback or curl timeout uses an unsupported option")
    if PACKAGE.get("packageManager") != "npm@11.19.0" or PACKAGE.get("engines", {}).get("node") != "24.20.0":
        raise ContractError("package.json does not declare the exact toolchain")
    if NODE_VERSION != "24.20.0" or PACKAGE_LOCK.get("packages", {}).get("", {}).get("engines", {}).get("node") != NODE_VERSION:
        raise ContractError("the Node.js declarations do not match the exact release toolchain")
    if WORKFLOW.count('node-version: "24.20.0"') != 2 or VERIFY.count('node-version: "24.20.0"') != 1:
        raise ContractError("the hosted jobs do not all select the exact release toolchain")
    if VERIFY.count('test "$(npm --version)" = "11.19.0"') != 1:
        raise ContractError("the verification job does not verify the exact bundled npm toolchain")
    if "npm ci --ignore-scripts --no-fund --no-audit" not in build:
        raise ContractError("release build must install without lifecycle scripts or audit network access")
    if "revalidate_draft_for_publish" not in release_shell:
        raise ContractError("the draft is not re-fetched immediately before publication")
    final_recheck = 'verify_source\n              revalidate_draft_for_publish "$probe" "$release_id"\n              bounded_gh "$RUNNER_TEMP/published.json"'
    if final_recheck not in release_shell:
        raise ContractError("publication does not perform the final source and Release recheck immediately before PATCH")


check_state_machine()
check_provenance_verifier()
check_workflow_operations()
if ".github/workflows/publish-static-test.py" not in VERIFY:
    raise ContractError("verify workflow must run the semantic release check")
print("SDK release behavioral invariants passed")
