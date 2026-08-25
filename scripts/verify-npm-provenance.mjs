import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const MAX_JSON_BYTES = 131_072;
const MAX_ARCHIVE_BYTES = 134_217_728;
const NPM_REGISTRY = "https://registry.npmjs.org";
const NPM_PUBLISH_PREDICATE = "https://github.com/npm/attestation/tree/main/specs/publish/v0.1";
const SLSA_PREDICATE = "https://slsa.dev/provenance/v1";
const SLSA_BUILD_TYPE = "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
const GITHUB_HOSTED_BUILDER = "https://github.com/actions/runner/github-hosted";

export class ProvenanceError extends Error {}

function fail(message) {
  throw new ProvenanceError(message);
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function string(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function exactString(value, expected, label) {
  if (value !== expected) fail(`${label} is not exact`);
}

function readJson(path, label) {
  let stat;
  try {
    stat = fs.statSync(path);
  } catch (error) {
    fail(`${label} cannot be read: ${error.message}`);
  }
  if (!stat.isFile() || stat.size > MAX_JSON_BYTES) fail(`${label} exceeds the bounded JSON input`);
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function npmSubject(packageName, version) {
  return packageName.startsWith("@")
    ? `pkg:npm/%40${packageName.slice(1)}@${version}`
    : `pkg:npm/${packageName}@${version}`;
}

function expectedTarballUrl(packageName, version) {
  const unscopedName = packageName.includes("/") ? packageName.slice(packageName.lastIndexOf("/") + 1) : packageName;
  return `${NPM_REGISTRY}/${packageName}/-/${unscopedName}-${version}.tgz`;
}

function expectedAttestationsUrl(packageName, version) {
  return `${NPM_REGISTRY}/-/npm/v1/attestations/${packageName.replaceAll("/", "%2f")}@${version}`;
}

function assertRegistryUrl(value, expected, label) {
  exactString(value, expected, label);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} is not a URL`);
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "registry.npmjs.org" || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) {
    fail(`${label} is not an exact registry URL`);
  }
}

function archiveDigests(path) {
  let stat;
  try {
    stat = fs.statSync(path);
  } catch (error) {
    fail(`archive cannot be read: ${error.message}`);
  }
  if (!stat.isFile() || stat.size > MAX_ARCHIVE_BYTES) fail("archive exceeds the 128 MiB bound");
  const bytes = fs.readFileSync(path);
  return {
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    sha512Base64: crypto.createHash("sha512").update(bytes).digest("base64"),
    sha512Hex: crypto.createHash("sha512").update(bytes).digest("hex"),
  };
}

function decodeStatement(attestation, label) {
  const value = object(attestation, label);
  const bundle = object(value.bundle, `${label}.bundle`);
  const envelope = object(bundle.dsseEnvelope, `${label}.bundle.dsseEnvelope`);
  exactString(envelope.payloadType, "application/vnd.in-toto+json", `${label}.payloadType`);
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length < 1) fail(`${label} has no DSSE signature`);
  const payload = string(envelope.payload, `${label}.payload`);
  let decoded;
  try {
    decoded = Buffer.from(payload, "base64");
    if (decoded.length === 0 || decoded.toString("base64") !== payload) fail(`${label}.payload is not canonical base64`);
    return object(JSON.parse(decoded.toString("utf8")), `${label}.statement`);
  } catch (error) {
    if (error instanceof ProvenanceError) throw error;
    fail(`${label}.payload is not a valid statement: ${error.message}`);
  }
}

function verifySubject(statement, expectedSubject, expectedSha512, label) {
  if (!Array.isArray(statement.subject) || statement.subject.length !== 1) fail(`${label}.subject is not singular`);
  const subject = object(statement.subject[0], `${label}.subject[0]`);
  exactString(subject.name, expectedSubject, `${label}.subject.name`);
  const digest = object(subject.digest, `${label}.subject.digest`);
  exactString(digest.sha512, expectedSha512, `${label}.subject.digest.sha512`);
}

function verifyNpmStatement(statement, packageName, version, expectedSubject, expectedSha512) {
  exactString(statement._type, "https://in-toto.io/Statement/v0.1", "npm statement type");
  exactString(statement.predicateType, NPM_PUBLISH_PREDICATE, "npm predicate type");
  verifySubject(statement, expectedSubject, expectedSha512, "npm statement");
  const predicate = object(statement.predicate, "npm predicate");
  exactString(predicate.name, packageName, "npm predicate package");
  exactString(predicate.version, version, "npm predicate version");
  exactString(predicate.registry, NPM_REGISTRY, "npm predicate registry");
}

function verifySlsaStatement(statement, packageName, version, commit, tag, expectedSubject, expectedSha512) {
  exactString(statement._type, "https://in-toto.io/Statement/v1", "SLSA statement type");
  exactString(statement.predicateType, SLSA_PREDICATE, "SLSA predicate type");
  verifySubject(statement, expectedSubject, expectedSha512, "SLSA statement");
  const predicate = object(statement.predicate, "SLSA predicate");
  const build = object(predicate.buildDefinition, "SLSA build definition");
  exactString(build.buildType, SLSA_BUILD_TYPE, "SLSA build type");
  const external = object(build.externalParameters, "SLSA external parameters");
  const workflow = object(external.workflow, "SLSA workflow");
  exactString(workflow.ref, `refs/tags/${tag}`, "SLSA workflow ref");
  exactString(workflow.repository, "https://github.com/TeleCrypt-io/storage-sdk", "SLSA workflow repository");
  exactString(workflow.path, ".github/workflows/publish.yml", "SLSA workflow path");
  if (!Array.isArray(build.resolvedDependencies)) fail("SLSA resolved dependencies are missing");
  const expectedUri = `git+https://github.com/TeleCrypt-io/storage-sdk@refs/tags/${tag}`;
  if (!build.resolvedDependencies.some((dependency) => {
    if (dependency === null || typeof dependency !== "object" || Array.isArray(dependency)) return false;
    const digest = dependency.digest;
    return dependency.uri === expectedUri && digest && digest.gitCommit === commit;
  })) fail("SLSA resolved dependency is not the exact release commit");
  const runDetails = object(predicate.runDetails, "SLSA run details");
  const builder = object(runDetails.builder, "SLSA builder");
  exactString(builder.id, GITHUB_HOSTED_BUILDER, "SLSA builder");
}

export function verifyNpmProvenance({ distPath, attestationsPath, archivePath, packageName, version, tag, commit }) {
  string(distPath, "dist path");
  string(attestationsPath, "attestations path");
  string(archivePath, "archive path");
  string(packageName, "package name");
  string(version, "version");
  string(tag, "tag");
  string(commit, "commit");
  if (!/^(?:@[^/\s]+\/)?[^/\s]+$/u.test(packageName)) fail("package name is not canonical");
  if (!/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(version)) fail("version is not an exact stable semver");
  exactString(tag, `v${version}`, "tag");
  if (!/^[0-9a-f]{40}$/u.test(commit)) fail("commit is not an exact lowercase SHA-1");

  const dist = object(readJson(distPath, "dist metadata"), "dist metadata");
  const archive = archiveDigests(archivePath);
  assertRegistryUrl(dist.tarball, expectedTarballUrl(packageName, version), "npm tarball URL");
  exactString(dist.integrity, `sha512-${archive.sha512Base64}`, "npm tarball integrity");
  const attestations = object(dist.attestations, "npm attestations metadata");
  assertRegistryUrl(attestations.url, expectedAttestationsUrl(packageName, version), "npm attestations URL");
  const provenance = object(attestations.provenance, "npm provenance metadata");
  exactString(provenance.predicateType, SLSA_PREDICATE, "npm provenance predicate type");

  const document = object(readJson(attestationsPath, "attestations document"), "attestations document");
  if (!Array.isArray(document.attestations) || document.attestations.length !== 2) fail("attestations document must contain exactly two statements");
  const statements = document.attestations.map((attestation, index) => decodeStatement(attestation, `attestation[${index}]`));
  const npmStatements = statements.filter((statement) => statement.predicateType === NPM_PUBLISH_PREDICATE);
  const slsaStatements = statements.filter((statement) => statement.predicateType === SLSA_PREDICATE);
  if (npmStatements.length !== 1 || slsaStatements.length !== 1) fail("attestations document must contain one npm and one SLSA statement");
  verifyNpmStatement(npmStatements[0], packageName, version, npmSubject(packageName, version), archive.sha512Hex);
  verifySlsaStatement(slsaStatements[0], packageName, version, commit, tag, npmSubject(packageName, version), archive.sha512Hex);
  return { packageName, version, tag, commit, sha256: archive.sha256, sha512: `sha512-${archive.sha512Base64}` };
}

function parseArguments(args) {
  const options = {};
  const allowed = new Set(["dist", "attestations", "archive", "package", "version", "tag", "commit"]);
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith("--") || !allowed.has(key.slice(2)) || index + 1 >= args.length || args[index + 1].startsWith("--")) {
      fail("usage: --dist FILE --attestations FILE --archive FILE --package NAME --version VERSION --tag TAG --commit SHA");
    }
    options[key.slice(2)] = args[index + 1];
    index += 1;
  }
  for (const key of allowed) if (!options[key]) fail(`missing --${key}`);
  return {
    distPath: options.dist,
    attestationsPath: options.attestations,
    archivePath: options.archive,
    packageName: options.package,
    version: options.version,
    tag: options.tag,
    commit: options.commit,
  };
}

function main() {
  try {
    const result = verifyNpmProvenance(parseArguments(process.argv.slice(2)));
    console.log(`verified npm provenance for ${result.packageName}@${result.version} at ${result.commit}`);
  } catch (error) {
    console.error(`npm provenance verification failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
