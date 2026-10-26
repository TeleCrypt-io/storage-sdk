import { describe, expect, it, vi } from "vitest";
import { EventType, JoinRule, UNSTABLE_MSC3088_ENABLED, UNSTABLE_MSC3088_PURPOSE, UNSTABLE_MSC3089_TREE_SUBTYPE } from "matrix-js-sdk";
import { TeleCryptIOStorage } from "../../src/TeleCryptIOStorage.js";
import * as core from "../../src/core/operations.js";
import { registerTestUser } from "../harness/users.js";
import { waitFor } from "../harness/waitFor.js";

async function storageUser(prefix: string) {
  const user = await registerTestUser(prefix);
  const storage = await TeleCryptIOStorage.create({ ...user, baseUrl: "http://localhost:8008", serverName: "localhost:8008", persistentCryptoStore: false });
  await storage.keySafe.setup();
  await storage.keySafe.confirmSaved();
  return { user, storage };
}

describe("Storage access regressions", () => {
  it("keeps default Viewer state changes denied and preserves custom permissions during reads", async () => {
    const owner = await storageUser("access_owner");
    const reader = await storageUser("access_reader");
    const outsider = await storageUser("access_outsider");
    try {
      const vault = await core.createVault(owner.storage, "Private vault");
      await core.shareVault(owner.storage, vault.id, reader.user.userId, "viewer");
      await core.joinVault(reader.storage, vault.id);
      const readerClient = reader.storage.getClient();
      const changeJoinRule = () => readerClient.sendStateEvent(vault.id, EventType.RoomJoinRules, { join_rule: JoinRule.Public }, "");
      const disablePurpose = () => readerClient.sendStateEvent(vault.id, UNSTABLE_MSC3088_PURPOSE.name,
        { [UNSTABLE_MSC3088_ENABLED.name]: false }, UNSTABLE_MSC3089_TREE_SUBTYPE.name);
      await expect(changeJoinRule()).rejects.toMatchObject({ errcode: "M_FORBIDDEN" });
      await expect(disablePurpose()).rejects.toMatchObject({ errcode: "M_FORBIDDEN" });

      const membersBeforeCustomState = await owner.storage.listMembers(owner.storage.getTree(vault.id)!);
      // Preserve a valid custom configuration that explicitly opens these state
      // operations. Reads must not canonicalize it back to the creation defaults.
      const ownerClient = owner.storage.getClient();
      const power = await ownerClient.getStateEvent(vault.id, EventType.RoomPowerLevels, "");
      await ownerClient.sendStateEvent(vault.id, EventType.RoomPowerLevels, {
        ...power, state_default: 0,
        events: { ...power.events, [EventType.RoomJoinRules]: 0, [UNSTABLE_MSC3088_PURPOSE.name]: 0 },
      }, "");
      await changeJoinRule();
      const writeState = vi.spyOn(ownerClient, "sendStateEvent");
      await core.listVaults(owner.storage);
      await core.listVaults(owner.storage);
      expect(writeState).not.toHaveBeenCalled();
      const persistedPower = await ownerClient.getStateEvent(vault.id, EventType.RoomPowerLevels, "");
      expect(persistedPower).toMatchObject({
        state_default: 0,
        events: { [EventType.RoomJoinRules]: 0, [UNSTABLE_MSC3088_PURPOSE.name]: 0 },
      });
      await expect(ownerClient.getStateEvent(vault.id, EventType.RoomJoinRules, ""))
        .resolves.toMatchObject({ join_rule: JoinRule.Public });
      const membersAfterReads = await owner.storage.listMembers(owner.storage.getTree(vault.id)!);
      expect(membersAfterReads).toEqual(membersBeforeCustomState);
      const file = await core.uploadFile(owner.storage, vault.id, "private.txt", new TextEncoder().encode("still private"), "text/plain");
      const downloaded = await core.downloadFile(reader.storage, vault.id, file.id);
      expect(new TextDecoder().decode(downloaded.bytes)).toBe("still private");
      await core.deleteFile(owner.storage, vault.id, file.id);
      await core.deleteVault(owner.storage, vault.id);
      expect(await core.listVaults(owner.storage)).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      for (const { storage } of [owner, reader, outsider]) storage.getClient().stopClient();
    }
  }, 120_000);

  it("accepts existing nested history and inherits readers for new folders", async () => {
    const owner = await storageUser("nested_owner");
    const reader = await storageUser("nested_reader");
    try {
      const vault = await core.createVault(owner.storage, "Nested sharing");
      const child = await core.createSubfolder(owner.storage, vault.id, "Existing folder");
      const nested = await core.createSubfolder(owner.storage, child.id, "Existing nested folder");
      const file = await core.uploadFile(owner.storage, nested.id, "history.txt", new TextEncoder().encode("before invitation"), "text/plain");
      await core.shareVault(owner.storage, vault.id, reader.user.userId, "viewer");
      await waitFor(async () => (await core.listPendingInvites(reader.storage)).some((invite) => invite.id === vault.id), { label: "root invitation" });
      await core.joinVault(reader.storage, vault.id);
      expect(await core.listPendingInvites(reader.storage)).toEqual([]);
      expect(await core.listSubfolders(reader.storage, vault.id)).toEqual([child]);
      expect(await core.listSubfolders(reader.storage, child.id)).toEqual([nested]);
      const downloaded = await core.downloadFile(reader.storage, nested.id, file.id);
      expect(downloaded.name).toBe("history.txt");
      expect(new TextDecoder().decode(downloaded.bytes)).toBe("before invitation");

      const added = await core.createSubfolder(owner.storage, vault.id, "Added after sharing");
      expect(await core.listSubfolders(reader.storage, vault.id)).toEqual(expect.arrayContaining([child, added]));
      expect(await owner.storage.getRoomMembership(added.id, reader.user.userId)).toBe("join");
      const addedNested = await core.createSubfolder(owner.storage, added.id, "Also shared");
      expect(await core.listSubfolders(reader.storage, added.id)).toEqual([addedNested]);
      await core.unshareVault(owner.storage, vault.id, reader.user.userId);
      for (const id of [vault.id, child.id, nested.id, added.id, addedNested.id]) {
        expect(await owner.storage.getRoomMembership(id, reader.user.userId)).toBe("leave");
      }
      await core.deleteFile(owner.storage, nested.id, file.id);
      for (const folder of [nested, child, addedNested, added]) {
        await core.deleteFolder(owner.storage, folder.id);
      }
      await core.deleteVault(owner.storage, vault.id);
      expect(await core.listVaults(owner.storage)).toEqual([]);
    } finally {
      for (const { storage } of [owner, reader]) storage.getClient().stopClient();
    }
  }, 120_000);
});
