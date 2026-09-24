import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { Method } from "matrix-js-sdk/lib/http-api/method.js";
import { TeleCryptIOStorage } from "../../src/TeleCryptIOStorage.js";
import { createVault, uploadFile, shareVault, joinVault, listFiles, downloadFile, listVaults } from "../../src/core/operations.js";
import { registerTestUser, loginNewDevice } from "../harness/users.js";
import { stopTestClient } from "../harness/clients.js";
import { waitFor } from "../harness/waitFor.js";

it("sets up signed logins, shares existing encrypted names/files, and restores the same safe on another login", async () => {
  const owner = await registerTestUser("safe_owner");
  const reader = await registerTestUser("safe_reader");
  const sessions: TeleCryptIOStorage[] = [];
  const open = async (user: { userId: string; accessToken: string; deviceId: string }) => {
    const storage = await TeleCryptIOStorage.create({ baseUrl: "http://localhost:8008", serverName: "localhost:8008", ...user });
    sessions.push(storage); return storage;
  };
  try {
    const a = await open(owner); const b = await open(reader);
    const { recoveryKey } = await a.keySafe.setup();
    await expect(listVaults(a)).rejects.toThrow("Decryption Key Safe");
    await a.keySafe.confirmSaved();
    await b.keySafe.setup(); await b.keySafe.confirmSaved();
    const vault = await createVault(a, "Existing private name");
    const content = new TextEncoder().encode("existing encrypted file content");
    await uploadFile(a, vault.id, "private.txt", content, "text/plain");
    await shareVault(a, vault.id, reader.userId, "viewer");
    await joinVault(b, vault.id);
    const files = await waitFor(async () => {
      try { const values = await listFiles(b, vault.id); return values.some((file) => file.name === "private.txt") ? values : null; }
      catch { return null; }
    }, { label: "new reader decrypts preexisting filename", timeoutMs: 20000 });
    const result = await downloadFile(b, vault.id, files[0].id);
    expect(result.bytes).toEqual(content);
    expect((await listVaults(b)).find((value) => value.id === vault.id)?.name).toBe("Existing private name");
    await waitFor(async () => {
      const info = await a.getClient().http.authedRequest<{count:number}>(Method.Get, "/room_keys/version");
      return info && info.count > 0;
    }, { label: "room keys uploaded to safe", timeoutMs: 20000 });
    const fresh = await open(await loginNewDevice(owner));
    expect((await fresh.keySafe.getStatus()).state).toBe("restore-required");
    await fresh.keySafe.restore(recoveryKey);
    expect((await fresh.keySafe.getStatus()).state).toBe("ready");
    const restored = await waitFor(async () => {
      try { return await downloadFile(fresh, vault.id, files[0].id); } catch { return null; }
    }, { label: "fresh owner login restores file", timeoutMs: 20000 });
    expect(restored.bytes).toEqual(content);
  } finally { sessions.forEach((storage) => stopTestClient(storage.getClient())); }
}, 120000);
