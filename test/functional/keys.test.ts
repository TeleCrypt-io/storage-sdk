import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { encodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key.js";
import { TeleCryptIOStorage, createVault, uploadFile, listVaults, listFiles, downloadFile, deleteFile, deleteVault } from "../../src/index.js";
import { registerTestUser, loginNewDevice } from "../harness/users.js";

it("uses the public Safe API for confirmation, existing-key recovery and ordinary storage", async () => {
  const user = await registerTestUser("public_safe");
  const open = (device: typeof user, startClient = true) => TeleCryptIOStorage.create({
    ...device, baseUrl: "http://localhost:8008", serverName: "localhost:8008", startClient,
  });
  const original = await open(user);
  let fresh: TeleCryptIOStorage | undefined;
  let vaultId: string | undefined;
  let mediaId: string | undefined;
  try {
    expect(await original.keySafe.getStatus()).toEqual({ state: "setup-required" });
    const { recoveryKey } = await original.keySafe.setup();
    expect(await original.keySafe.getStatus()).toEqual({ state: "confirmation-required", recoveryKey });
    await expect(listVaults(original)).rejects.toThrow("Set up or unlock");
    await original.keySafe.confirmSaved();
    expect(await original.keySafe.getStatus()).toEqual({ state: "ready" });
    const version = await original.getClient().getCrypto()!.getActiveSessionBackupVersion();
    const safeKeyId = (await original.getClient().secretStorage.getKey())![0];
    const vault = await createVault(original, "Public Safe recovery");
    vaultId = vault.id;
    const bytes = new TextEncoder().encode("public API recovery bytes");
    const file = await uploadFile(original, vault.id, "private.txt", bytes, "text/plain");
    mediaId = (await original.getOriginalFileEvent(vault.id, file.id)).getContent().file.url;
    await original.waitForKeyBackup(vault.id, file.id);
    await original.waitForKeyBackup(vault.id);
    original.getClient().stopClient();

    fresh = await open(await loginNewDevice(user), false);
    expect(await fresh.keySafe.getStatus()).toEqual({ state: "restore-required" });
    await expect(fresh.keySafe.setup()).rejects.toThrow("already exists");
    await expect(fresh.keySafe.restore("not a recovery key")).rejects.toThrow("Invalid");
    await expect(fresh.keySafe.restore(encodeRecoveryKey(new Uint8Array(32).fill(8)))).rejects.toThrow("does not unlock");
    await expect(listVaults(fresh)).rejects.toThrow("Set up or unlock");
    const restored = await fresh.keySafe.restore(recoveryKey);
    expect(restored.imported).toBeGreaterThan(0);
    expect(await fresh.keySafe.getStatus()).toEqual({ state: "ready" });
    expect(await fresh.getClient().getCrypto()!.getActiveSessionBackupVersion()).toBe(version);
    expect((await fresh.getClient().secretStorage.getKey())![0]).toBe(safeKeyId);
    expect((await listFiles(fresh, vault.id)).map((entry) => entry.name)).toEqual(["private.txt"]);
    expect((await downloadFile(fresh, vault.id, file.id)).bytes).toEqual(bytes);
    await expect(fresh.keySafe.setup()).rejects.toThrow("already exists");
    await deleteFile(fresh, vault.id, file.id);
    mediaId = undefined;
    await deleteVault(fresh, vault.id);
    vaultId = undefined;
  } finally {
    // If an assertion failed after the original crypto engine stopped, use
    // this test owner's ordinary APIs to remove its known media and room.
    const request = async (path: string, body: object) => {
      const response = await fetch(`http://localhost:8008${path}`, {
        method: "POST", headers: { Authorization: `Bearer ${user.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`cleanup failed: ${response.status} ${await response.text()}`);
    };
    try {
      if (mediaId) await request("/_matrix/client/unstable/io.telecrypt.storage/delete_media", { media_ids: [mediaId] });
      if (vaultId) for (const action of ["leave", "forget"]) await request(`/_matrix/client/v3/rooms/${encodeURIComponent(vaultId)}/${action}`, {});
    } finally {
      fresh?.getClient().stopClient();
      original.getClient().stopClient();
    }
  }
}, 120000);
