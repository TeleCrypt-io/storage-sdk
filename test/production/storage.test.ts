// PRODUCTION functional suite — hits REAL telecrypt.io, no local stack, no
// mocks. Uses the dedicated operator-VERIFIED test accounts from secrets
// (PROD_TEST_USER_1/PASS_1, _2). See docs/PROD_TESTING_SPEC.md.
//
// Why verified accounts (not redpill): redpill provisions UNVERIFIED accounts,
// which telecrypt.io blocks from uploading media (the product's verification
// boundary) and rate-limits at the free-tier default. So they're useless for
// functional storage tests. Verified accounts get uploads + a raised rate
// limit (both granted by scripts/tc-verify.sh), so the full upload/share
// round-trip runs for real. The suite fails loudly if the secrets are absent.
//
// Node has no native IndexedDB — same fake-indexeddb polyfill the local suite
// uses (test/functional/core.test.ts, keys.test.ts). TeleCryptIOStorage scopes
// the crypto store per (userId, deviceId), so the two accounts don't collide
// even though fake-indexeddb is process-global.
//
// Each test cleans up its own folders; beforeAll/afterAll additionally sweep
// EVERY folder on both accounts, so these dedicated accounts never accumulate
// rooms across runs.
import "fake-indexeddb/auto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TeleCryptIOStorage } from "../../src/TeleCryptIOStorage";
import * as core from "../../src/core/operations";
import { waitFor } from "../harness/waitFor";
import { type RedpillAccount } from "./redpillClient";
import { loginVerifiedAccounts } from "./verifiedAccounts";

// NOTE: the "account" shape is shared with redpillClient's RedpillAccount
// (mxid/accessToken/deviceId/homeserver), but this suite uses ONLY the
// dedicated operator-VERIFIED test accounts (from secrets) — redpill accounts
// are unverified and can't upload, so they're useless for functional storage
// tests. If the secrets are missing, the suite fails loudly rather than
// running against a useless account.
type TestAccount = RedpillAccount;

let accountA: TestAccount;
let accountB: TestAccount;
let storageA: TeleCryptIOStorage;
let storageB: TeleCryptIOStorage;

async function buildStorage(account: TestAccount): Promise<TeleCryptIOStorage> {
  return TeleCryptIOStorage.create({
    baseUrl: account.homeserver,
    userId: account.mxid,
    accessToken: account.accessToken,
    deviceId: account.deviceId,
  });
}

/**
 * Best-effort cleanup: deletes a folder this run created. Never throws —
 * cleanup failing must not fail the test that already made its assertions.
 * Accounts themselves need no teardown (controlplane retention locker
 * reaps unadopted redpill accounts automatically).
 */
async function cleanupFolder(storage: TeleCryptIOStorage, folderId: string): Promise<void> {
  try {
    const tree = storage.getTree(folderId);
    await tree?.delete();
  } catch {
    // best-effort — swallow deliberately, see doc comment above.
  }
}

/**
 * Sweeps EVERY top-level folder visible to an account and deletes it — a
 * thorough teardown so these dedicated test accounts never accumulate rooms
 * across runs (each MSC3089 folder is a real room on prod). Safe because
 * these accounts exist only for this suite. Best-effort per folder: one
 * failed delete doesn't stop the sweep.
 */
async function sweepAllFolders(storage: TeleCryptIOStorage): Promise<void> {
  try {
    const folders = await core.listFolders(storage);
    for (const f of folders) {
      await cleanupFolder(storage, f.id);
    }
  } catch {
    // best-effort sweep — never throw from teardown.
  }
}

beforeAll(async () => {
  // Uses ONLY the dedicated operator-VERIFIED test accounts (from secrets).
  // Verified accounts can upload media AND have a raised rate limit (both are
  // verification perks — see scripts/tc-verify.sh), so the full upload/share
  // round-trip runs for real. No redpill fallback: redpill accounts are
  // unverified and can't upload, so running against one would be pointless.
  const verified = await loginVerifiedAccounts();
  if (!verified) {
    throw new Error(
      "production suite requires verified test accounts — set PROD_TEST_USER_1/PROD_TEST_PASS_1 " +
        "and PROD_TEST_USER_2/PROD_TEST_PASS_2 (GitHub Secrets in CI; a local .env for manual runs). " +
        "These must be operator-verified accounts (see scripts/tc-verify.sh).",
    );
  }
  const [a, b] = verified;
  accountA = a;
  accountB = b;
  storageA = await buildStorage(accountA);
  storageB = await buildStorage(accountB);

  // Start from a clean slate — remove any folders left by a previous run
  // (e.g. one interrupted before its own cleanup).
  await sweepAllFolders(storageA);
  await sweepAllFolders(storageB);
}, 60000);

afterAll(async () => {
  // Thorough teardown: delete every folder these accounts can see, then stop.
  await sweepAllFolders(storageA);
  await sweepAllFolders(storageB);
  storageA?.getClient().stopClient();
  storageB?.getClient().stopClient();
});

describe("production: real telecrypt.io via verified test accounts", () => {
  it("P.1 encrypted round-trip on real infra: create, upload, download, byte-identical", async () => {
    const folder = await core.createFolder(storageA, `prod-roundtrip-${Date.now()}`);
    try {
      const bytes = new TextEncoder().encode(`prod round-trip ${Math.random()}`);
      const uploaded = await core.uploadFile(storageA, folder.id, "prod.txt", bytes, "text/plain");

      // Real S3-backed media + authenticated download over the real TLS
      // edge — the thing the local disposable media store can't fully
      // exercise. Poll: settling after upload is genuinely async.
      const downloaded = await waitFor(
        async () => {
          try {
            return await core.downloadFile(storageA, folder.id, uploaded.id);
          } catch {
            return null;
          }
        },
        { label: "download settles on real prod", timeoutMs: 20000 },
      );

      expect(downloaded.bytes).toEqual(bytes);
      expect(downloaded.mimetype).toBe("text/plain");
      expect(downloaded.name).toBe("prod.txt");
    } finally {
      await cleanupFolder(storageA, folder.id);
    }
  });

  it("P.2 multi-participant share on real infra: A shares with B, B uploads, A downloads B's bytes", async () => {
    const folder = await core.createFolder(storageA, `prod-shared-${Date.now()}`);
    try {
      const share = await core.shareFolder(storageA, folder.id, accountB.mxid, "editor");
      expect(share).toEqual({ folderId: folder.id, userId: accountB.mxid, role: "editor" });

      const joined = await core.joinFolder(storageB, folder.id);
      expect(joined).toEqual({ folderId: folder.id, joined: true });

      const originalBytes = new TextEncoder().encode(`prod shared ${Math.random()}`);
      const uploaded = await core.uploadFile(
        storageB,
        folder.id,
        "from-b.txt",
        originalBytes,
        "text/plain",
      );

      // A downloads B's upload — proves the megolm key A received (as room
      // creator, from B's real prod upload) actually decrypts.
      const downloaded = await waitFor(
        async () => {
          try {
            return await core.downloadFile(storageA, folder.id, uploaded.id);
          } catch {
            return null;
          }
        },
        { label: "A decrypts B's upload on real prod", timeoutMs: 20000 },
      );

      expect(downloaded.bytes).toEqual(originalBytes);
      expect(downloaded.mimetype).toBe("text/plain");
      expect(downloaded.name).toBe("from-b.txt");
    } finally {
      await cleanupFolder(storageA, folder.id);
    }
  });

  it("P.3 server never sees plaintext (prod): raw media bytes differ from plaintext", async () => {
    const folder = await core.createFolder(storageA, `prod-plaintext-${Date.now()}`);
    try {
      const plaintext = new TextEncoder().encode(
        "SECRET: must not be stored in plaintext on real prod",
      );
      const uploaded = await core.uploadFile(storageA, folder.id, "secret.txt", plaintext, "text/plain");

      const tree = await waitFor(() => storageA.getTree(folder.id), {
        label: "tree resolves",
        timeoutMs: 15000,
      });
      const branch = await waitFor(() => tree.getFile(uploaded.id), {
        label: "branch resolves",
        timeoutMs: 15000,
      });

      // Fetch the RAW (still-encrypted) media bytes via the same
      // authenticated path the library uses internally, but WITHOUT
      // decrypting — the server-side artifact must not equal plaintext.
      const { info } = await branch.getFileInfo();
      const client = storageA.getClient();
      const rawUrl = client.mxcUrlToHttp(info.url as string, undefined, undefined, undefined, false, true, true);
      expect(rawUrl).toBeTruthy();

      const rawRes = await fetch(rawUrl!, {
        headers: { Authorization: `Bearer ${accountA.accessToken}` },
      });
      expect(rawRes.ok).toBe(true);
      const rawBytes = new Uint8Array(await rawRes.arrayBuffer());

      const notEqual =
        rawBytes.byteLength !== plaintext.byteLength || !rawBytes.every((b, i) => b === plaintext[i]);
      expect(notEqual).toBe(true);

      // And confirm we CAN still decrypt it (the ciphertext is genuinely
      // this file, not garbage) — via the same downloadFile path as P.1.
      const downloaded = await core.downloadFile(storageA, folder.id, uploaded.id);
      expect(downloaded.bytes).toEqual(plaintext);
    } finally {
      await cleanupFolder(storageA, folder.id);
    }
  });

  // Runs LAST on account A deliberately: setupRecovery() bootstraps
  // cross-signing + a brand-new secret storage/key backup for the account,
  // which is a one-shot, account-wide change — sequencing it after P.1/P.3
  // (which only need a plain authenticated account) keeps those tests
  // independent of whether recovery bootstrap succeeds.
  //
  // LIMITATION (deliberate, not a gap to fake): redpill provisions ONE
  // account per call with no password, so there is no way to obtain a
  // SECOND device/session for the same account (the local suite's
  // `loginNewDevice` needs a password login). Full cross-device *restore*
  // therefore cannot be exercised against prod through redpill — it stays
  // covered locally (test/functional/keys.test.ts 5.3 and core.test.ts
  // C.4, both against the local MAS-delegated stack, with a genuine second
  // device and a negative control). This test covers setup/backup-active
  // only, exactly as scoped in docs/PROD_TESTING_SPEC.md Part A #4.
  it("P.4 recovery setup on real MAS: setupRecovery() + backup becomes active (restore is local-only, see comment)", async () => {
    // Idempotent on a persistent account, guarded by SERVER-SIDE ground truth
    // (does real MAS actually hold a key backup version for this account?) —
    // NOT by the local `isRecoverySetup()`, which reflects this run's fresh
    // ephemeral device's trust state, not what's on the server. setupRecovery
    // bootstraps brand-new secret storage + key backup, a one-shot per account;
    // if the server already has a backup (a prior run — these accounts persist,
    // unlike the earlier redpill flow), re-running it would need the EXISTING
    // secret-storage key we don't carry between runs. So: set up only if the
    // server has no backup yet, then assert real MAS holds a backup version
    // either way. Never fakes — the assertion is real server-side state.
    const serverBackupVersion = async (): Promise<string | null> => {
      const res = await fetch(`${accountA.homeserver}/_matrix/client/v3/room_keys/version`, {
        headers: { Authorization: `Bearer ${accountA.accessToken}` },
      });
      if (!res.ok) return null;
      const info = (await res.json()) as { version?: string };
      return info.version ?? null;
    };

    if (!(await serverBackupVersion())) {
      const setup = await core.setupRecovery(storageA);
      expect(typeof setup.recoveryKey).toBe("string");
      expect(setup.recoveryKey).toBeTruthy();
    }

    // Confirm the server side (real MAS/SSSS) actually has a backup version.
    await waitFor(async () => (await serverBackupVersion()) ?? null, {
      label: "real MAS backup version exists",
      timeoutMs: 20000,
    });
  });
});
