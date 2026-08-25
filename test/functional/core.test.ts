// Proves src/core/operations.ts is independently consumable: call core.*
// functions IN-PROCESS (no CLI subprocess, no commander, no stdout) against
// a real Synapse, asserting on the typed results from src/core/types.ts.
// This proves callers use the same TeleCryptIOStorage + core layer.
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
    serverName: "localhost:8008",
    userId: user.userId,
    accessToken: user.accessToken,
    deviceId: user.deviceId,
  });
}

describe("core operations", () => {
  it("C.1 createVault/listVaults: typed VaultInfo, top-level only", async () => {
    const user = await registerTestUser("core_vault");
    const storage = await createStorage(user);
    try {
      const created = await core.createVault(storage, "CoreVault");
      expect(created.id).toBeTruthy();
      expect(created.name).toBe("CoreVault");

      const vaults = await waitFor(
        async () => {
          const all = await core.listVaults(storage);
          return all.some((f) => f.id === created.id) ? all : null;
        },
        { label: "listVaults sees the new vault", timeoutMs: 15000 },
      );
      expect(vaults.find((f) => f.id === created.id)).toEqual({
        id: created.id,
        name: "CoreVault",
      });
    } finally {
      stopTestClient(storage.getClient());
    }
  });

  it("C.1b nested folders: create, list, rename, inspect, and delete", async () => {
    const user = await registerTestUser("core_folder");
    const storage = await createStorage(user);
    try {
      const vault = await core.createVault(storage, "CoreFolderVault");
      const folder = await core.createSubfolder(storage, vault.id, "Child");
      expect(folder).toEqual({ id: expect.any(String), name: "Child" });

      const listed = await waitFor(
        async () => {
          const folders = await core.listSubfolders(storage, vault.id);
          return folders.some((entry) => entry.id === folder.id) ? folders : null;
        },
        { label: "listSubfolders sees the new folder", timeoutMs: 15000 },
      );
      expect(listed).toContainEqual(folder);

      const renamed = await core.renameFolder(storage, folder.id, "Renamed");
      expect(renamed).toEqual({ id: folder.id, name: "Renamed" });
      const details = await core.getFolderDetails(storage, folder.id);
      expect(details).toMatchObject({ id: folder.id, name: "Renamed" });

      await core.deleteFolder(storage, folder.id);
      await waitFor(
        async () => {
          const folders = await core.listSubfolders(storage, vault.id);
          return folders.some((entry) => entry.id === folder.id) ? null : true;
        },
        { label: "listSubfolders no longer returns the deleted folder", timeoutMs: 15000 },
      );
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
      const vault = await core.createVault(storageA, "CoreShared");

      const share = await core.shareVault(storageA, vault.id, userB.userId, "editor");
      expect(share).toEqual({ vaultId: vault.id, userId: userB.userId, role: "editor" });

      const joined = await core.joinVault(storageB, vault.id);
      expect(joined).toEqual({ vaultId: vault.id, joined: true });

      const originalBytes = new TextEncoder().encode(`core round-trip ${Math.random()}`);
      const uploaded = await core.uploadFile(
        storageB,
        vault.id,
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
            return await core.downloadFile(storageA, vault.id, uploaded.id);
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
      const vault = await core.createVault(storage, "RoundTrip");
      const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 42, 7]);
      const uploaded = await core.uploadFile(
        storage,
        vault.id,
        "bytes.bin",
        bytes,
        "application/octet-stream",
      );

      const files = await waitFor(
        async () => {
          const listed = await core.listFiles(storage, vault.id);
          return listed.length > 0 ? listed : null;
        },
        { label: "listFiles sees the upload" },
      );
      expect(files).toEqual([{ id: uploaded.id, name: "bytes.bin" }]);

      const downloaded = await core.downloadFile(storage, vault.id, uploaded.id);
      expect(downloaded.bytes).toEqual(bytes);
      expect(downloaded.mimetype).toBe("application/octet-stream");
      expect(downloaded.name).toBe("bytes.bin");
    } finally {
      stopTestClient(storage.getClient());
    }
  });

  it("C.4 renameFile waits until the new name is visible locally", async () => {
    const user = await registerTestUser("core_rename");
    const storage = await createStorage(user);
    try {
      const vault = await core.createVault(storage, "RenameTest");
      const uploaded = await core.uploadFile(
        storage,
        vault.id,
        "before.txt",
        new TextEncoder().encode("rename me"),
        "text/plain",
      );

      await waitFor(
        async () => {
          const listed = await core.listFiles(storage, vault.id);
          return listed.some((file) => file.id === uploaded.id) ? listed : null;
        },
        { label: "file visible before rename" },
      );

      const renamed = await core.renameFile(storage, vault.id, uploaded.id, "after.txt");
      expect(renamed).toEqual({ id: uploaded.id, name: "after.txt" });

      const filesAfter = await waitFor(
        async () => {
          const listed = await core.listFiles(storage, vault.id);
          return listed.some((file) => file.id === uploaded.id && file.name === "after.txt")
            ? listed
            : null;
        },
        { label: "renamed file visible locally" },
      );
      expect(filesAfter).toContainEqual({ id: uploaded.id, name: "after.txt" });
    } finally {
      stopTestClient(storage.getClient());
    }
  });

  it("C.5 setupRecovery + restoreRecovery on a fresh device", async () => {
    const userA = await registerTestUser("core_recover");
    const storageA = await createStorage(userA);
    try {
      const vault = await core.createVault(storageA, "CoreRecoveryTest");
      const bytes = new TextEncoder().encode("core recovery content");
      const uploaded = await core.uploadFile(storageA, vault.id, "secret.txt", bytes, "text/plain");
      await waitFor(
        async () => {
          const listed = await core.listFiles(storageA, vault.id);
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
            const vaults = await core.listVaults(storageB);
            return vaults.some((f) => f.id === vault.id) ? true : null;
          },
          { label: "device B lists the vault", timeoutMs: 15000 },
        );
        await waitFor(
          async () => {
            const listed = await core.listFiles(storageB, vault.id);
            return listed.length > 0 ? true : null;
          },
          { label: "device B sees the (still undecryptable) file", timeoutMs: 15000 },
        );

        // NEGATIVE CONTROL: device B has no keys yet, so it must NOT be able
        // to decrypt. Proves the empty start — if this assertion fails,
        // device B's crypto store is leaking from device A's, and the later
        // "success" would be meaningless. Also asserts the CLEAR error
        // message (regression: this used to surface as an opaque
        // "Cannot read properties of undefined (reading 'url')").
        await expect(core.downloadFile(storageB, vault.id, uploaded.id)).rejects.toThrow(
          /undecryptable on this device/,
        );

        const restore = await core.restoreRecovery(storageB, setup.recoveryKey);
        expect(restore.imported).toBeGreaterThan(0);
        expect(restore.imported).toBeLessThanOrEqual(restore.total);

        // Decryption settling can take a moment after the keys land locally
        // — poll real decrypt success, not the clock.
        const downloaded = await waitFor(
          async () => {
            try {
              return await core.downloadFile(storageB, vault.id, uploaded.id);
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

  it("C.6 deleteVault forgets the room immediately (no lingering listVaults entry)", async () => {
    const user = await registerTestUser("core_delete");
    const storage = await createStorage(user);
    try {
      const created = await core.createVault(storage, "DeleteMe");
      await waitFor(
        async () => {
          const all = await core.listVaults(storage);
          return all.some((f) => f.id === created.id) ? all : null;
        },
        { label: "listVaults sees the new vault", timeoutMs: 15000 },
      );

      const deleted = await core.deleteVault(storage, created.id);
      expect(deleted).toEqual({ id: created.id, deleted: true });

      // The room must be gone from the LOCAL store immediately after
      // deleteVault resolves — no waiting for the leave event to
      // round-trip through the background sync loop. This is the contract
      // the production browser suite depends on (deleted vaults must
      // disappear from the UI without 30-60s of sync latency).
      expect(storage.getClient().getRoom(created.id)).toBeNull();
      const after = await core.listVaults(storage);
      expect(after.some((f) => f.id === created.id)).toBe(false);
    } finally {
      stopTestClient(storage.getClient());
    }
  });

  it("C.7 declineInvite forgets the room immediately (no lingering invite)", async () => {
    const userA = await registerTestUser("core_decline_a");
    const userB = await registerTestUser("core_decline_b");
    const storageA = await createStorage(userA);
    const storageB = await createStorage(userB);
    try {
      const vault = await core.createVault(storageA, "DeclineMe");
      await core.shareVault(storageA, vault.id, userB.userId, "viewer");

      // B sees the invite...
      await waitFor(
        async () => {
          const invites = await core.listPendingInvites(storageB);
          return invites.some((i) => i.id === vault.id) ? invites : null;
        },
        { label: "B sees the pending invite", timeoutMs: 15000 },
      );

      const declined = await core.declineInvite(storageB, vault.id);
      expect(declined).toEqual({ vaultId: vault.id, declined: true });

      // ...and it must be gone from B's local store immediately.
      expect(storageB.getClient().getRoom(vault.id)).toBeNull();
      const invitesAfter = await core.listPendingInvites(storageB);
      expect(invitesAfter.some((i) => i.id === vault.id)).toBe(false);
    } finally {
      stopTestClient(storageA.getClient());
      stopTestClient(storageB.getClient());
    }
  });
});
