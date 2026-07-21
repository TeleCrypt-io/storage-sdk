// Layer 2 (server-side Secure Backup + restore) needs a persistent crypto store
// so that a genuinely new device's *own* crypto state survives its own restart,
// and so bootstrapped secrets/backup state are written where matrix-js-sdk
// expects to find them. Node has no native IndexedDB, so we polyfill it for
// this file only (vitest isolates each test file's globals).
import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { decodeRecoveryKey } from "matrix-js-sdk/src/crypto-api/recovery-key";
import { registerTestUser, loginNewDevice } from "../harness/users";
import { stopTestClient } from "../harness/clients";
import { waitFor } from "../harness/waitFor";
import { TeleCryptIOStorage } from "../../src/TeleCryptIOStorage";

const BASE_URL = "http://localhost:8008";

async function createStorage(user: {
  userId: string;
  accessToken: string;
  deviceId: string;
}): Promise<TeleCryptIOStorage> {
  return TeleCryptIOStorage.create({
    baseUrl: BASE_URL,
    userId: user.userId,
    accessToken: user.accessToken,
    deviceId: user.deviceId,
  });
}

/** Polls the raw server-side key backup endpoint until it reports at least
 * one stored key. This is the authoritative proof that the background backup
 * engine has actually finished uploading — `getActiveSessionBackupVersion()`
 * only proves the engine believes a backup is active, not that any given
 * session has reached the server yet. */
async function waitForServerBackupCount(
  accessToken: string,
  minCount: number,
): Promise<number> {
  return waitFor(
    async () => {
      const res = await fetch(`${BASE_URL}/_matrix/client/v3/room_keys/version`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return null;
      const info = (await res.json()) as { count?: number };
      return (info.count ?? 0) >= minCount ? info.count! : null;
    },
    { label: `server backup count >= ${minCount}`, timeoutMs: 20000 },
  );
}

describe("key management", () => {
  it("5.1 setupRecovery bootstraps cross-signing + secret storage + key backup", async () => {
    const user = await registerTestUser("key");
    const storage = await createStorage(user);
    try {
      const { recoveryKey } = await storage.keys.setupRecovery();
      expect(recoveryKey).toBeTruthy();
      expect(typeof recoveryKey).toBe("string");

      // The returned key must be a genuine, well-formed recovery key.
      const decoded = decodeRecoveryKey(recoveryKey);
      expect(decoded.byteLength).toBe(32);

      await waitFor(() => storage.keys.isRecoverySetup(), {
        label: "recovery active after setupRecovery",
        timeoutMs: 15000,
      });
    } finally {
      stopTestClient(storage.getClient());
    }
  });

  it("5.2 isRecoverySetup reflects state before and after setupRecovery", async () => {
    const user = await registerTestUser("key");
    const storage = await createStorage(user);
    try {
      expect(await storage.keys.isRecoverySetup()).toBe(false);

      await storage.keys.setupRecovery();

      const ready = await waitFor(() => storage.keys.isRecoverySetup(), {
        label: "isRecoverySetup() becomes true",
        timeoutMs: 15000,
      });
      expect(ready).toBe(true);
    } finally {
      stopTestClient(storage.getClient());
    }
  });

  it("5.3 a genuinely new device recovers files via the Recovery Key", async () => {
    const userA = await registerTestUser("recover");
    const storageA = await createStorage(userA);
    try {
      const tree = await storageA.createTree("RecoveryTest");
      await waitFor(() => tree.room.name === "RecoveryTest", {
        label: "tree name visible",
      });

      const plaintext = new TextEncoder().encode(
        "lost laptop recovery test content",
      ).buffer as ArrayBuffer;
      await storageA.uploadFile(tree, "important.txt", plaintext, "text/plain");

      await waitFor(
        () => {
          const fs = tree.listFiles();
          return fs.length > 0 ? fs : null;
        },
        { label: "file visible on device A", timeoutMs: 15000 },
      );

      const { recoveryKey } = await storageA.keys.setupRecovery();
      expect(recoveryKey).toBeTruthy();

      // Backup engine believes it is active...
      await waitFor(() => storageA.keys.isRecoverySetup(), {
        label: "backup active on device A",
        timeoutMs: 15000,
      });
      // ...AND the file's room key has actually reached the server (the
      // upload is asynchronous background work, separate from "active").
      await waitForServerBackupCount(userA.accessToken, 1);

      // Device B: a genuine second device for the same user — new device_id,
      // new access_token, empty crypto store (verified via the negative
      // control below).
      const userB = await loginNewDevice(userA);
      const storageB = await createStorage(userB);
      try {
        const treesB = await waitFor(
          async () => {
            const ts = await storageB.listTrees();
            return ts.length > 0 ? ts : null;
          },
          { label: "device B lists trees", timeoutMs: 15000 },
        );
        const treeB = treesB.find((t) => t.id === tree.id);
        expect(treeB).toBeDefined();

        const filesB = await waitFor(
          () => {
            const fs = treeB!.listFiles();
            return fs.length > 0 ? fs : null;
          },
          { label: "device B sees the file", timeoutMs: 15000 },
        );

        // NEGATIVE CONTROL: device B has no keys yet, so it must NOT be able
        // to decrypt. This proves the empty start — if this assertion fails,
        // device B's crypto store is leaking from device A's, and the later
        // "success" would be meaningless.
        await expect(storageB.downloadFile(filesB[0])).rejects.toThrow();

        const restoreResult = await storageB.keys.restoreFromRecoveryKey(recoveryKey);
        expect(restoreResult.imported).toBeGreaterThan(0);
        expect(restoreResult.imported).toBeLessThanOrEqual(restoreResult.total);

        // Decryption settling can take a moment after the keys land locally —
        // poll real decrypt success, not the clock.
        const downloaded = await waitFor(
          async () => {
            try {
              return await storageB.downloadFile(filesB[0]);
            } catch {
              return null;
            }
          },
          { label: "device B decrypts the file after restore", timeoutMs: 15000 },
        );

        expect(new Uint8Array(downloaded.data)).toEqual(new Uint8Array(plaintext));
        expect(downloaded.mimetype).toBe("text/plain");
      } finally {
        stopTestClient(storageB.getClient());
      }
    } finally {
      stopTestClient(storageA.getClient());
    }
  });

  it("5.4 restoreFromRecoveryKey fails cleanly with a wrong Recovery Key", async () => {
    const userA = await registerTestUser("recoverbad");
    const storageA = await createStorage(userA);
    try {
      const tree = await storageA.createTree("BadRecoveryTest");
      await waitFor(() => tree.room.name === "BadRecoveryTest", {
        label: "tree name visible",
      });

      const plaintext = new TextEncoder().encode("must stay unrecoverable")
        .buffer as ArrayBuffer;
      await storageA.uploadFile(tree, "secret.txt", plaintext, "text/plain");
      await waitFor(
        () => {
          const fs = tree.listFiles();
          return fs.length > 0 ? fs : null;
        },
        { label: "file visible on device A", timeoutMs: 15000 },
      );

      await storageA.keys.setupRecovery();
      await waitFor(() => storageA.keys.isRecoverySetup(), {
        label: "backup active on device A",
        timeoutMs: 15000,
      });
      await waitForServerBackupCount(userA.accessToken, 1);

      // A well-formed but cryptographically wrong recovery key: a genuine
      // recovery key generated for an unrelated account. Decodes cleanly, but
      // must not unlock userA's secret storage / key backup.
      const throwawayUser = await registerTestUser("throwaway");
      const throwawayStorage = await createStorage(throwawayUser);
      const { recoveryKey: wrongKey } = await throwawayStorage.keys.setupRecovery();
      stopTestClient(throwawayStorage.getClient());

      const userB = await loginNewDevice(userA);
      const storageB = await createStorage(userB);
      try {
        const treesB = await waitFor(
          async () => {
            const ts = await storageB.listTrees();
            return ts.length > 0 ? ts : null;
          },
          { label: "device B lists trees", timeoutMs: 15000 },
        );
        const treeB = treesB.find((t) => t.id === tree.id);
        expect(treeB).toBeDefined();

        const filesB = await waitFor(
          () => {
            const fs = treeB!.listFiles();
            return fs.length > 0 ? fs : null;
          },
          { label: "device B sees the file", timeoutMs: 15000 },
        );

        // Garbage input: fails at decode, before ever touching the network.
        await expect(
          storageB.keys.restoreFromRecoveryKey("not a real recovery key"),
        ).rejects.toThrow();

        // Well-formed but wrong key: must fail cleanly, not silently "succeed".
        await expect(
          storageB.keys.restoreFromRecoveryKey(wrongKey),
        ).rejects.toThrow();

        // Device B still cannot decrypt the file — no partial/silent success.
        await expect(storageB.downloadFile(filesB[0])).rejects.toThrow();
      } finally {
        stopTestClient(storageB.getClient());
      }
    } finally {
      stopTestClient(storageA.getClient());
    }
  });
});
