import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The verifier is a first-party Node CLI module; its runtime export is tested
// directly so the unit suite does not need to spawn a child process.
// @ts-expect-error The JavaScript CLI intentionally has no generated declaration file.
import { verifyNpmProvenance } from "../scripts/verify-npm-provenance.mjs";

type Fixture = {
  archive: Buffer;
  dist: Record<string, unknown>;
  attestations: Record<string, unknown>;
  distRaw?: string;
};

const packageName = "@telecrypt-io/storage";
const version = "0.5.8";
const tag = `v${version}`;
const commit = "a".repeat(40);
const subject = `pkg:npm/%40telecrypt-io/storage@${version}`;
let fixtureDirectory: string | undefined;

function signed(statement: Record<string, unknown>) {
  return {
    predicateType: statement.predicateType,
    bundle: {
      mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.2",
      dsseEnvelope: {
        payloadType: "application/vnd.in-toto+json",
        payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
        signatures: [{ sig: "test-signature", keyid: "test-key" }],
      },
    },
  };
}

function makeFixture(): Fixture {
  const archive = Buffer.from("deterministic archive fixture\n");
  const sha512Base64 = requireHash("sha512", archive, "base64");
  const sha512Hex = requireHash("sha512", archive);
  const npmStatement = {
    _type: "https://in-toto.io/Statement/v0.1",
    subject: [{ name: subject, digest: { sha512: sha512Hex } }],
    predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
    predicate: { name: packageName, version, registry: "https://registry.npmjs.org" },
  };
  const slsaStatement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: subject, digest: { sha512: sha512Hex } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            ref: `refs/tags/${tag}`,
            repository: "https://github.com/TeleCrypt-io/storage-sdk",
            path: ".github/workflows/publish.yml",
          },
        },
        resolvedDependencies: [{
          uri: `git+https://github.com/TeleCrypt-io/storage-sdk@refs/tags/${tag}`,
          digest: { gitCommit: commit },
        }],
      },
      runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" } },
    },
  };
  return {
    archive,
    dist: {
      integrity: `sha512-${sha512Base64}`,
      tarball: `https://registry.npmjs.org/@telecrypt-io/storage/-/storage-${version}.tgz`,
      attestations: {
        url: `https://registry.npmjs.org/-/npm/v1/attestations/@telecrypt-io%2fstorage@${version}`,
        provenance: { predicateType: "https://slsa.dev/provenance/v1" },
      },
    },
    attestations: { attestations: [signed(npmStatement), signed(slsaStatement)] },
  };
}

function requireHash(algorithm: "sha256" | "sha512", bytes: Buffer, encoding: "hex" | "base64" = "hex") {
  return createHash(algorithm).update(bytes).digest(encoding) as string;
}

function run(fixture: Fixture) {
  fixtureDirectory = mkdtempSync(join(tmpdir(), "storage-sdk-provenance-test-"));
  const archivePath = join(fixtureDirectory, "archive.tgz");
  const distPath = join(fixtureDirectory, "dist.json");
  const attestationsPath = join(fixtureDirectory, "attestations.json");
  writeFileSync(archivePath, fixture.archive);
  writeFileSync(distPath, fixture.distRaw ?? JSON.stringify(fixture.dist));
  writeFileSync(attestationsPath, JSON.stringify(fixture.attestations));
  try {
    return {
      ok: true,
      value: verifyNpmProvenance({
        distPath,
        attestationsPath,
        archivePath,
        packageName,
        version,
        tag,
        commit,
      }),
    };
  } catch (error) {
    return { ok: false, error };
  }
}

afterEach(() => {
  if (fixtureDirectory) rmSync(fixtureDirectory, { recursive: true, force: true });
  fixtureDirectory = undefined;
});

describe("npm provenance verifier", () => {
  it("accepts the exact npm and SLSA statements for the hosted archive", () => {
    const result = run(makeFixture());
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ packageName, version, tag, commit });
  });

  it.each([
    ["the npm integrity", (fixture: Fixture) => { fixture.dist.integrity = "sha512-invalid"; }],
    ["the attestation URL", (fixture: Fixture) => {
      const metadata = fixture.dist.attestations as Record<string, unknown>;
      metadata.url = "https://evil.example.test/attestations";
    }],
    ["the SLSA workflow ref", (fixture: Fixture) => {
      const statements = fixture.attestations.attestations as Array<Record<string, unknown>>;
      const bundle = statements[1].bundle as Record<string, unknown>;
      const envelope = bundle.dsseEnvelope as Record<string, unknown>;
      const statement = JSON.parse(Buffer.from(envelope.payload as string, "base64").toString("utf8")) as Record<string, unknown>;
      const predicate = statement.predicate as Record<string, unknown>;
      const build = predicate.buildDefinition as Record<string, unknown>;
      const external = build.externalParameters as Record<string, unknown>;
      const workflow = external.workflow as Record<string, unknown>;
      workflow.ref = "refs/tags/v0.5.6";
      envelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
    }],
    ["the archive subject digest", (fixture: Fixture) => {
      const statements = fixture.attestations.attestations as Array<Record<string, unknown>>;
      for (const item of statements) {
        const bundle = item.bundle as Record<string, unknown>;
        const envelope = bundle.dsseEnvelope as Record<string, unknown>;
        const statement = JSON.parse(Buffer.from(envelope.payload as string, "base64").toString("utf8")) as Record<string, unknown>;
        const subjects = statement.subject as Array<Record<string, unknown>>;
        subjects[0].digest = { sha512: "0".repeat(128) };
        envelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
      }
    }],
  ])("rejects a mutation of %s", (_label, mutate) => {
    const fixture = makeFixture();
    mutate(fixture);
    const result = run(fixture);
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
  });

  it("rejects duplicate or missing attestation statements", () => {
    const fixture = makeFixture();
    const statements = fixture.attestations.attestations as Array<Record<string, unknown>>;
    statements.pop();
    statements.push(statements[0]);
    const result = run(fixture);
    expect(result.ok).toBe(false);
  });

  it("uses bounded JSON inputs rather than reading an unbounded stream", () => {
    const fixture = makeFixture();
    fixture.distRaw = `${JSON.stringify(fixture.dist)}${"x".repeat(131_072)}`;
    const result = run(fixture);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("bounded JSON input");
  });
});
