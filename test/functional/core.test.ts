// Proves src/core/operations.ts is independently consumable: call core.*
// functions IN-PROCESS (no CLI subprocess, no commander, no stdout) against
// a real Synapse, asserting on the typed results from src/core/types.ts.
// This is the UI-readiness proof — everything exercised here is exactly
// what a future React UI would call directly, with the exact same
// TeleCryptIOStorage + core layer the CLI uses.
//
// Layer 2 (server-side Secure Backup + restore, C.4) needs a persistent
// crypto store so a genuinely new device's own crypto state survives its
// own restart, and so bootstrapped secrets/backup state land where
// matrix-js-sdk expects. Node has no native IndexedDB, so we polyfill it for
// this file only (vitest isolates each test file's globals) — this import
// stays in the TEST file, never in src/core/, per the browser-safety rule.
import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { registerTestUser, loginNewDevice } from "../harness/users";
import { stopTestClient } from "../harness/clients";
import { waitFor } from "../harness/waitFor";
import { TeleCryptIOStorage } from "../../src/TeleCryptIOStorage";
import * as core from "../../src/core/operations";

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

describe("core operations", () => {
  it("C.1 createFolder/listFolders: typed FolderInfo, top-level only", async () => {
    const user = await registerTestUser("core_folder");
    const storage = await createStorage(user);
    try {
      const created = await core.createFolder(storage, "CoreFolder");
      expect(created.id).toBeTruthy();
      expect(created.name).toBe("CoreFolder");

      const folders = await waitFor(
        async () => {
          const all = await core.listFolders(storage);
          return all.some((f) => f.id === created.id) ? all : null;
        },
        { label: "listFolders sees the new folder", timeoutMs: 15000 },
      );
      expect(folders.find((f) => f.id === created.id)).toEqual({
        id: created.id,
        name: "CoreFolder",
      });
    } finally {
      stopTestClient(storage.getClient());
    }
  });

  it("C.2 multi-participant share: B uploads, A downloads B's bytes byte-identical", async () => {
    const userA = await registerTestUser("core_share_a");
    const userB = await registerTestUser("core_share_b");
    const storageA = await createStorage(userA);
    const storageB = await createStorage(userB);
    try {
      const folder = await core.createFolder(storageA, "CoreShared");

      const share = await core.shareFolder(storageA, folder.id, userB.userId, "editor");
      expect(share).toEqual({ folderId: folder.id, userId: userB.userId, role: "editor" });

      const joined = await core.joinFolder(storageB, folder.id);
      expect(joined).toEqual({ folderId: folder.id, joined: true });

      const originalBytes = new TextEncoder().encode(`core round-trip ${Math.random()}`);
      const uploaded = await core.uploadFile(
        storageB,
        folder.id,
        "from-b.txt",
        originalBytes,
        "text/plain",
      );
      expect(uploaded.name).toBe("from-b.txt");
      expect(uploaded.mimetype).toBe("text/plain");

      // Device A downloads B's upload — proves the megolm key A received as
      // room creator (from B's upload) actually decrypts, byte-identical.
      const downloaded = await waitFor(
        async () => {
          try {
            return await core.downloadFile(storageA, folder.id, uploaded.id);
          } catch {
            return null;
          }
        },
        { label: "A decrypts B's upload", timeoutMs: 15000 },
      );

      expect(downloaded.bytes).toEqual(originalBytes);
      expect(downloaded.mimetype).toBe("text/plain");
      expect(downloaded.name).toBe("from-b.txt");
    } finally {
      stopTestClient(storageA.getClient());
      stopTestClient(storageB.getClient());
    }
  });

  it("C.3 uploadFile/downloadFile: Uint8Array round-trip is byte-identical", async () => {
    const user = await registerTestUser("core_roundtrip");
    const storage = await createStorage(user);
    try {
      const folder = await core.createFolder(storage, "RoundTrip");
      const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 42, 7]);
      const uploaded = await core.uploadFile(
        storage,
        folder.id,
        "bytes.bin",
        bytes,
        "application/octet-stream",
      );

      const files = await waitFor(
        async () => {
          const listed = await core.listFiles(storage, folder.id);
          return listed.length > 0 ? listed : null;
        },
        { label: "listFiles sees the upload" },
      );
      expect(files).toEqual([{ id: uploaded.id, name: "bytes.bin" }]);

      const downloaded = await core.downloadFile(storage, folder.id, uploaded.id);
      expect(downloaded.bytes).toEqual(bytes);
      expect(downloaded.mimetype).toBe("application/octet-stream");
      expect(downloaded.name).toBe("bytes.bin");
    } finally {
      stopTestClient(storage.getClient());
    }
  });

  it("C.4 setupRecovery + restoreRecovery on a fresh device", async () => {
    const userA = await registerTestUser("core_recover");
    const storageA = await createStorage(userA);
    try {
      const folder = await core.createFolder(storageA, "CoreRecoveryTest");
      const bytes = new TextEncoder().encode("core recovery content");
      const uploaded = await core.uploadFile(storageA, folder.id, "secret.txt", bytes, "text/plain");
      await waitFor(
        async () => {
          const listed = await core.listFiles(storageA, folder.id);
          return listed.length > 0 ? listed : null;
        },
        { label: "file visible on device A" },
      );

      const setup = await core.setupRecovery(storageA);
      expect(typeof setup.recoveryKey).toBe("string");
      expect(setup.recoveryKey).toBeTruthy();

      // Backup engine believes it is active...
      await waitFor(() => storageA.keys.isRecoverySetup(), {
        label: "backup active on device A",
        timeoutMs: 15000,
      });
      // ...AND the file's room key has actually reached the server (the
      // upload is asynchronous background work, separate from "active").
      await waitFor(
        async () => {
          const res = await fetch(`${BASE_URL}/_matrix/client/v3/room_keys/version`, {
            headers: { Authorization: `Bearer ${userA.accessToken}` },
          });
          if (!res.ok) return null;
          const info = (await res.json()) as { count?: number };
          return (info.count ?? 0) >= 1 ? true : null;
        },
        { label: "server backup count >= 1", timeoutMs: 20000 },
      );

      // Device B: a genuine second device for the same user — new device_id,
      // new access_token, empty crypto store of its own.
      const userB = await loginNewDevice(userA);
      const storageB = await createStorage(userB);
      try {
        await waitFor(
          async () => {
            const folders = await core.listFolders(storageB);
            return folders.some((f) => f.id === folder.id) ? true : null;
          },
          { label: "device B lists the folder", timeoutMs: 15000 },
        );
        await waitFor(
          async () => {
            const listed = await core.listFiles(storageB, folder.id);
            return listed.length > 0 ? true : null;
          },
          { label: "device B sees the (still undecryptable) file", timeoutMs: 15000 },
        );

        // NEGATIVE CONTROL: device B has no keys yet, so it must NOT be able
        // to decrypt. Proves the empty start — if this assertion fails,
        // device B's crypto store is leaking from device A's, and the later
        // "success" would be meaningless.
        await expect(core.downloadFile(storageB, folder.id, uploaded.id)).rejects.toThrow();

        const restore = await core.restoreRecovery(storageB, setup.recoveryKey);
        expect(restore.imported).toBeGreaterThan(0);
        expect(restore.imported).toBeLessThanOrEqual(restore.total);

        // Decryption settling can take a moment after the keys land locally
        // — poll real decrypt success, not the clock.
        const downloaded = await waitFor(
          async () => {
            try {
              return await core.downloadFile(storageB, folder.id, uploaded.id);
            } catch {
              return null;
            }
          },
          { label: "device B decrypts the file after restore", timeoutMs: 15000 },
        );
        expect(downloaded.bytes).toEqual(bytes);
        expect(downloaded.mimetype).toBe("text/plain");
      } finally {
        stopTestClient(storageB.getClient());
      }
    } finally {
      stopTestClient(storageA.getClient());
    }
  });
});
