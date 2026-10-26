import "fake-indexeddb/auto";
import { describe, it, expect, vi } from "vitest";
import { EventType } from "matrix-js-sdk";
import { UNSTABLE_MSC3089_BRANCH } from "matrix-js-sdk";
import { registerTestUser, loginNewDevice } from "../harness/users";
import { createTestClient, stopTestClient } from "../harness/clients";
import { waitFor } from "../harness/waitFor";
import { TeleCryptIOStorage } from "../../src/TeleCryptIOStorage";
import * as core from "../../src/core/operations.js";
import { getMyVaultRole } from "../../src/core/operations.js";
import { UndecryptableFileError } from "../../src/core/errors.js";
import { TreePermissions } from "matrix-js-sdk/src/models/MSC3089TreeSpace";

async function waitForTree(
  storage: TeleCryptIOStorage,
  treeId: string,
  label = "tree visible",
) {
  return waitFor(
    async () => {
      const trees = await storage.listTrees();
      return trees.find((t) => t.id === treeId) ?? null;
    },
    { label, timeoutMs: 15000 },
  );
}

async function waitForTreeName(
  storage: TeleCryptIOStorage,
  treeId: string,
  expected: string,
  label = "encrypted tree name visible",
): Promise<void> {
  await waitFor(async () => {
    try {
      return (await storage.getTreeName(treeId)) === expected;
    } catch {
      return false;
    }
  }, { label, timeoutMs: 15000 });
}

async function createImplicitCreatorTree(storage: TeleCryptIOStorage, name: string) {
  const client = storage.getClient();
  const createRoom = client.createRoom.bind(client);
  const versionSelection = vi.spyOn(client, "createRoom").mockImplementation((options) =>
    createRoom({ ...options, room_version: "12" }),
  );
  try {
    const vault = await core.createVault(storage, name);
    return await waitFor(
      () => storage.getTree(vault.id),
      { label: `v12 tree ${name} syncs`, timeoutMs: 15000 },
    );
  } finally {
    versionSelection.mockRestore();
  }
}

async function readyStorage(client: Awaited<ReturnType<typeof createTestClient>>) {
  const storage = new TeleCryptIOStorage(client);
  await storage.keySafe.setup();
  await storage.keySafe.confirmSaved();
  return storage;
}

async function waitForFiles(
  tree: { listFiles: () => { length: number } },
  label = "files appear",
) {
  return waitFor<{ id: string; getName: () => string }[]>(
    () => {
      const files = tree.listFiles() as { id: string; getName: () => string }[];
      return files.length > 0 ? files : null;
    },
    { label, timeoutMs: 15000 },
  );
}

describe("sharing", () => {
  it.each(["11", "12"] as const)("creates and uses a fresh v%s tree through the public core path", async (roomVersion) => {
    const aliceUser = await registerTestUser(`core_v${roomVersion}_creator`);
    const bobUser = await registerTestUser(`core_v${roomVersion}_viewer`);
    const alice = await createTestClient(aliceUser);
    const bob = await createTestClient(bobUser);
    let vaultId: string | undefined;
    let folderId: string | undefined;
    let creationSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const aliceStore = await readyStorage(alice);
      const bobStore = await readyStorage(bob);
      const createRoom = alice.createRoom.bind(alice);
      let selectedRoomVersion: string | undefined;
      creationSpy = vi.spyOn(alice, "createRoom").mockImplementation((options) => {
        const request = { ...options, room_version: roomVersion };
        selectedRoomVersion = request.room_version;
        return createRoom(request);
      });
      const vault = await core.createVault(aliceStore, `Fresh v${roomVersion} encrypted name`);
      const requestedOptions = creationSpy.mock.calls[0]?.[0];
      expect(selectedRoomVersion).toBe(roomVersion);
      expect(requestedOptions?.room_version).toBeUndefined();
      expect(requestedOptions?.power_level_content_override).not.toHaveProperty("users");
      creationSpy.mockRestore();
      creationSpy = undefined;
      vaultId = vault.id;

      const createEvent = alice.getRoom(vault.id)?.currentState.getStateEvents(EventType.RoomCreate, "");
      if (!createEvent || Array.isArray(createEvent)) throw new Error("v12 room creation event is unavailable");
      expect(createEvent.getContent().room_version).toBe(roomVersion);
      expect(await aliceStore.getTreeName(vault.id)).toBe(`Fresh v${roomVersion} encrypted name`);
      expect(getMyVaultRole(aliceStore, vault.id)).toBe(TreePermissions.Owner);
      expect(await core.getTreeActionCapabilities(aliceStore, vault.id)).toMatchObject({
        renameTree: true,
        uploadFile: true,
        renameFile: true,
        createSubfolder: true,
        deleteTree: true,
        inviteMembers: true,
      });

      await core.renameVault(aliceStore, vault.id, `Renamed v${roomVersion} encrypted name`);
      expect(await aliceStore.getTreeName(vault.id)).toBe(`Renamed v${roomVersion} encrypted name`);
      await core.shareVault(aliceStore, vault.id, bobUser.userId, "viewer");
      await core.joinVault(bobStore, vault.id);
      const bobTree = await waitForTree(bobStore, vault.id, `Bob's fresh v${roomVersion} tree syncs`);
      await waitForTreeName(bobStore, bobTree.id, `Renamed v${roomVersion} encrypted name`, `Bob decrypts the v${roomVersion} name`);
      expect(getMyVaultRole(bobStore, vault.id)).toBe(TreePermissions.Viewer);
      expect(await core.getMemberActionCapabilities(aliceStore, vault.id, [bobUser.userId]))
        .toMatchObject({ [bobUser.userId]: {
          canShare: { viewer: true, editor: true, owner: true },
          canChangeRole: { viewer: true, editor: true, owner: true },
          canUnshare: true,
        } });

      const folder = await core.createSubfolder(aliceStore, vault.id, `Fresh v${roomVersion} child`);
      folderId = folder.id;
      expect((await aliceStore.getTreeName(folder.id))).toBe(`Fresh v${roomVersion} child`);
      const uploaded = await core.uploadFile(
        aliceStore,
        vault.id,
        `v${roomVersion}-file.txt`,
        new TextEncoder().encode(`fresh v${roomVersion} encrypted file`),
        "text/plain",
      );
      const listed = await waitFor(async () => {
        const file = (await core.listFiles(aliceStore, vault.id)).find((candidate) => candidate.id === uploaded.id);
        return file ?? null;
      }, { label: `fresh v${roomVersion} file appears`, timeoutMs: 15000 });
      expect(listed).toMatchObject({ name: `v${roomVersion}-file.txt`, ownerUserId: aliceUser.userId });
      await waitFor(async () => {
        const file = (await core.listFiles(bobStore, vault.id)).find((candidate) => candidate.id === uploaded.id);
        return file ?? null;
      }, { label: `Bob receives the fresh v${roomVersion} file`, timeoutMs: 15000 });
      const downloaded = await core.downloadFile(bobStore, vault.id, uploaded.id);
      expect(new TextDecoder().decode(downloaded.bytes)).toBe(`fresh v${roomVersion} encrypted file`);

      await core.deleteFile(aliceStore, vault.id, uploaded.id);
      await waitFor(async () => (await core.listFiles(aliceStore, vault.id)).length === 0, {
        label: `fresh v${roomVersion} file deletion is visible`,
        timeoutMs: 15000,
      });
      await core.deleteFolder(aliceStore, folder.id);
      folderId = undefined;
      await core.unshareVault(aliceStore, vault.id, bobUser.userId);
      await core.deleteVault(aliceStore, vault.id);
      vaultId = undefined;
    } finally {
      creationSpy?.mockRestore();
      const aliceStore = new TeleCryptIOStorage(alice);
      if (vaultId) {
        try { if (folderId) await core.deleteFolder(aliceStore, folderId); } catch { /* preserve primary assertion */ }
        try { await core.unshareVault(aliceStore, vaultId, bobUser.userId); } catch { /* preserve primary assertion */ }
        try { await core.deleteVault(aliceStore, vaultId); } catch { /* preserve primary assertion */ }
      }
      await stopTestClient(alice);
      await stopTestClient(bob);
    }
  }, 180000);

  it("invites a default Viewer with native invite power and keeps denied role changes partial", async () => {
    const aliceUser = await registerTestUser("invite_power_owner");
    const bobUser = await registerTestUser("invite_power_editor");
    const charlieUser = await registerTestUser("invite_power_viewer");
    const daveUser = await registerTestUser("invite_power_editor_target");
    const alice = await createTestClient(aliceUser);
    const bob = await createTestClient(bobUser);
    const charlie = await createTestClient(charlieUser);
    const dave = await createTestClient(daveUser);
    const aliceStore = await readyStorage(alice);
    const bobStore = await readyStorage(bob);
    await readyStorage(charlie);
    await readyStorage(dave);
    let vaultId: string | undefined;
    try {
      const vault = await core.createVault(aliceStore, "Invite without power-level edit");
      vaultId = vault.id;
      await core.shareVault(aliceStore, vault.id, bobUser.userId, "editor");
      await bob.joinRoom(vault.id);
      await waitForTree(bobStore, vault.id, "invite-only editor joins the vault");

      const currentLevels = alice.getRoom(vault.id)?.currentState.getStateEvents(EventType.RoomPowerLevels, "");
      if (!currentLevels || Array.isArray(currentLevels)) throw new Error("vault power-level state is unavailable");
      const inviteOnlyLevels = structuredClone(currentLevels.getContent()) as Record<string, unknown> & {
        invite?: number;
      };
      inviteOnlyLevels.invite = 50;
      await alice.sendStateEvent(vault.id, EventType.RoomPowerLevels, inviteOnlyLevels, "");
      await aliceStore.refreshRoomState(vault.id);
      await bobStore.refreshRoomState(vault.id);

      const room = bob.getRoom(vault.id);
      if (!room) throw new Error("Bob's vault room is unavailable");
      expect(room.currentState.mayClientSendStateEvent(EventType.RoomPowerLevels, bob)).toBe(false);
      const capabilities = await core.getMemberActionCapabilities(bobStore, vault.id, [
        charlieUser.userId,
        daveUser.userId,
      ]);
      expect(capabilities[charlieUser.userId]).toMatchObject({
        canShare: { viewer: true, editor: false, owner: false },
        canChangeRole: { viewer: false, editor: false, owner: false },
      });

      const beforeInvite = room.currentState.getStateEvents(EventType.RoomPowerLevels, "");
      if (!beforeInvite || Array.isArray(beforeInvite)) throw new Error("power-level event is unavailable");
      const shareViewer = await core.shareVault(bobStore, vault.id, charlieUser.userId, "viewer");
      expect(shareViewer.rootMembership).toBe("invite");
      expect(await bobStore.getRoomMembership(vault.id, charlieUser.userId)).toBe("invite");
      expect((await aliceStore.listMembers(aliceStore.getTree(vault.id)!))
        .find((member) => member.userId === charlieUser.userId)).toMatchObject({ role: "viewer", membership: "invite" });
      const afterViewerInvite = room.currentState.getStateEvents(EventType.RoomPowerLevels, "");
      if (!afterViewerInvite || Array.isArray(afterViewerInvite)) throw new Error("power-level event is unavailable");
      expect(afterViewerInvite.getId()).toBe(beforeInvite.getId());
      expect((afterViewerInvite.getContent().users as Record<string, number> | undefined)?.[charlieUser.userId])
        .toBeUndefined();

      const partialRoleChange = await core.shareVault(bobStore, vault.id, daveUser.userId, "editor")
        .then(() => null, (error: unknown) => error);
      expect(partialRoleChange).toMatchObject({
        code: "MUTATION_PARTIAL",
        operation: "share",
        completedIds: [vault.id],
      });
      expect((partialRoleChange as Error & { cause?: { errcode?: string } }).cause?.errcode).toBe("M_FORBIDDEN");
      expect(await bobStore.getRoomMembership(vault.id, daveUser.userId)).toBe("invite");
      expect((await aliceStore.listMembers(aliceStore.getTree(vault.id)!))
        .find((member) => member.userId === daveUser.userId)).toMatchObject({ role: "viewer", membership: "invite" });
    } finally {
      if (vaultId) {
        try { await core.unshareVault(aliceStore, vaultId, bobUser.userId); } catch { /* preserve primary assertion */ }
        try { await core.unshareVault(aliceStore, vaultId, charlieUser.userId); } catch { /* preserve primary assertion */ }
        try { await core.unshareVault(aliceStore, vaultId, daveUser.userId); } catch { /* preserve primary assertion */ }
        try { await core.deleteVault(aliceStore, vaultId); } catch { /* preserve primary assertion */ }
      }
      await stopTestClient(alice);
      await stopTestClient(bob);
      await stopTestClient(charlie);
      await stopTestClient(dave);
    }
  }, 180000);

  it("uses native custom Matrix permissions for Viewer file, folder, and member actions", async () => {
    const aliceUser = await registerTestUser("native_caps_owner");
    const bobUser = await registerTestUser("native_caps_viewer");
    const charlieUser = await registerTestUser("native_caps_target");
    const alice = await createTestClient(aliceUser);
    const bob = await createTestClient(bobUser);
    const charlie = await createTestClient(charlieUser);
    let vaultId: string | undefined;
    let firstFileId: string | undefined;
    let deniedFileId: string | undefined;
    const mediaIds: string[] = [];
    try {
      const aliceStore = await readyStorage(alice);
      const bobStore = await readyStorage(bob);
      const charlieStore = await readyStorage(charlie);
      const vault = await core.createVault(aliceStore, "Native action capabilities");
      vaultId = vault.id;
      await core.shareVault(aliceStore, vault.id, bobUser.userId, "editor");
      await core.joinVault(bobStore, vault.id);

      const firstFile = await core.uploadFile(
        bobStore,
        vault.id,
        "uploaded-as-editor.txt",
        new TextEncoder().encode("viewer-owned media"),
        "text/plain",
      );
      firstFileId = firstFile.id;
      mediaIds.push((await bobStore.getOriginalFileEvent(vault.id, firstFile.id)).getContent().file.url as string);
      await core.shareVault(aliceStore, vault.id, bobUser.userId, "viewer");
      await waitFor(async () => getMyVaultRole(bobStore, vault.id) === "viewer", {
        label: "uploader is demoted to Viewer",
        timeoutMs: 15000,
      });

      const defaultViewerFile = (await core.listFiles(bobStore, vault.id)).find((file) => file.id === firstFile.id);
      expect(defaultViewerFile).toMatchObject({ ownerUserId: bobUser.userId, canDelete: false });
      await expect(core.deleteFile(bobStore, vault.id, firstFile.id)).rejects.toThrow(
        "Matrix does not permit redacting the original file message",
      );

      const currentLevels = alice.getRoom(vault.id)?.currentState.getStateEvents(EventType.RoomPowerLevels, "");
      if (!currentLevels || Array.isArray(currentLevels)) throw new Error("vault power-level state is unavailable");
      const customLevels = structuredClone(currentLevels.getContent()) as Record<string, unknown> & {
        events?: Record<string, number>;
        users?: Record<string, number>;
      };
      customLevels.events = {
        ...customLevels.events,
        [EventType.RoomMessageEncrypted]: 0,
        [UNSTABLE_MSC3089_BRANCH.name]: 0,
        [EventType.RoomRedaction]: 0,
        [EventType.SpaceChild]: 50,
        [EventType.RoomPowerLevels]: 100,
        "io.telecrypt.storage.metadata": 0,
      };
      customLevels.invite = 1;
      customLevels.kick = 0;
      customLevels.users = { ...customLevels.users, [bobUser.userId]: 1 };
      await alice.sendStateEvent(vault.id, EventType.RoomPowerLevels, customLevels, "");
      await aliceStore.refreshRoomState(vault.id);
      await bobStore.refreshRoomState(vault.id);

      expect(getMyVaultRole(bobStore, vault.id)).toBe("viewer");
      const viewerActions = await core.getTreeActionCapabilities(bobStore, vault.id);
      expect(viewerActions).toMatchObject({
        uploadFile: true,
        renameFile: true,
        createSubfolder: false,
        renameTree: true,
        inviteMembers: true,
      });
      const memberActions = await core.getMemberActionCapabilities(bobStore, vault.id, [aliceUser.userId]);
      expect(memberActions[aliceUser.userId]?.canUnshare).toBe(false);

      await core.renameFile(bobStore, vault.id, firstFile.id, "renamed-as-viewer.txt");
      const allowedFile = (await core.listFiles(bobStore, vault.id)).find((file) => file.id === firstFile.id);
      expect(allowedFile).toMatchObject({ name: "renamed-as-viewer.txt", canRename: true, canDelete: true });
      await core.deleteFile(bobStore, vault.id, firstFile.id);
      await waitFor(async () => (await bobStore.getOriginalFileEventState(vault.id, firstFile.id)).redacted, {
        label: "Viewer uploader redaction reaches Matrix",
        timeoutMs: 15000,
      });
      const deletedMediaUrl = bobStore.getClient().mxcUrlToHttp(mediaIds[0]!, undefined, undefined, undefined, false, true, true)!;
      const deletedMedia = await fetch(deletedMediaUrl, {
        headers: { Authorization: `Bearer ${bobStore.getClient().getAccessToken()}` },
      });
      expect(deletedMedia.status).toBe(404);
      await deletedMedia.text();

      await expect(core.createSubfolder(bobStore, vault.id, "native-denied-folder")).rejects.toMatchObject({
        message: "create folder failed",
        cause: expect.objectContaining({ errcode: "M_FORBIDDEN" }),
      });

      await core.shareVault(aliceStore, vault.id, charlieUser.userId, "viewer");
      await core.joinVault(charlieStore, vault.id);
      const bobMemberActions = await core.getMemberActionCapabilities(bobStore, vault.id, [charlieUser.userId]);
      expect(bobMemberActions[charlieUser.userId]).toMatchObject({
        canShare: { viewer: true, editor: false, owner: false },
        canChangeRole: { viewer: false, editor: false, owner: false },
        canUnshare: true,
      });
      await core.unshareVault(bobStore, vault.id, charlieUser.userId);
      expect(await bobStore.getRoomMembership(vault.id, charlieUser.userId)).toBe("leave");
      const secondFile = await core.uploadFile(
        bobStore,
        vault.id,
        "redaction-denied.txt",
        new TextEncoder().encode("still stored"),
        "text/plain",
      );
      deniedFileId = secondFile.id;
      mediaIds.push((await bobStore.getOriginalFileEvent(vault.id, secondFile.id)).getContent().file.url as string);

      const deniedLevels = { ...customLevels, events: { ...customLevels.events, [EventType.RoomRedaction]: 50 } };
      await alice.sendStateEvent(vault.id, EventType.RoomPowerLevels, deniedLevels, "");
      await aliceStore.refreshRoomState(vault.id);
      await bobStore.refreshRoomState(vault.id);
      const deniedListing = (await core.listFiles(bobStore, vault.id)).find((file) => file.id === secondFile.id);
      expect(deniedListing).toMatchObject({ ownerUserId: bobUser.userId, canDelete: false });
      await expect(core.deleteFile(bobStore, vault.id, secondFile.id)).rejects.toThrow(
        "Matrix does not permit redacting the original file message",
      );
      const stillStored = await core.downloadFile(bobStore, vault.id, secondFile.id);
      expect(new TextDecoder().decode(stillStored.bytes)).toBe("still stored");
    } finally {
      const aliceStore = new TeleCryptIOStorage(alice);
      const bobStore = new TeleCryptIOStorage(bob);
      if (vaultId) {
        try {
          const currentLevels = alice.getRoom(vaultId)?.currentState.getStateEvents(EventType.RoomPowerLevels, "");
          if (currentLevels && !Array.isArray(currentLevels)) {
            const content = structuredClone(currentLevels.getContent()) as Record<string, unknown> & { events?: Record<string, number> };
            content.events = { ...content.events, [EventType.RoomRedaction]: 0 };
            await alice.sendStateEvent(vaultId, EventType.RoomPowerLevels, content, "");
            await aliceStore.refreshRoomState(vaultId);
            await bobStore.refreshRoomState(vaultId);
          }
          if (deniedFileId) await core.deleteFile(bobStore, vaultId, deniedFileId);
          if (firstFileId) await core.deleteFile(bobStore, vaultId, firstFileId);
          await core.unshareVault(aliceStore, vaultId, bobUser.userId);
          await core.unshareVault(aliceStore, vaultId, charlieUser.userId);
          await core.deleteVault(aliceStore, vaultId);
        } catch { /* preserve the primary assertion and fixture identity for cleanup review */ }
      }
      await stopTestClient(alice);
      await stopTestClient(bob);
      await stopTestClient(charlie);
    }
  }, 180000);

  it("uses native v12 creator power for Owner reporting, demotion and removal", async () => {
    const aliceUser = await registerTestUser("v12_creator");
    const bobUser = await registerTestUser("v12_member");
    const alice = await createTestClient(aliceUser);
    const bob = await createTestClient(bobUser);
    let vaultId: string | undefined;
    try {
      const aliceStore = await readyStorage(alice);
      const bobStore = await readyStorage(bob);
      const tree = await createImplicitCreatorTree(aliceStore, "Implicit v12 creator");
      vaultId = tree.id;

      expect(alice.getRoom(tree.id)?.currentState.getMember(aliceUser.userId)?.powerLevel).toBe(Number.POSITIVE_INFINITY);
      expect(getMyVaultRole(aliceStore, tree.id)).toBe(TreePermissions.Owner);
      expect((await aliceStore.listMembers(tree)).find((member) => member.userId === aliceUser.userId)?.role)
        .toBe(TreePermissions.Owner);

      const share = await core.shareVault(aliceStore, tree.id, bobUser.userId, "owner");
      expect(share.rootMembership).toBe("invite");
      await bob.joinRoom(tree.id);
      const bobTree = await waitForTree(bobStore, tree.id, "Bob's v12 tree syncs");
      expect(getMyVaultRole(bobStore, tree.id)).toBe(TreePermissions.Owner);

      await core.shareVault(aliceStore, tree.id, bobUser.userId, "viewer");
      await waitFor(async () => {
        const member = (await aliceStore.listMembers(tree)).find((candidate) => candidate.userId === bobUser.userId);
        return member?.role === TreePermissions.Viewer ? member : null;
      }, { label: "v12 creator demotes a room Owner", timeoutMs: 15000 });
      expect(getMyVaultRole(bobStore, bobTree.id)).toBe(TreePermissions.Viewer);

      await core.shareVault(aliceStore, tree.id, bobUser.userId, "owner");
      expect((await aliceStore.listMembers(tree)).find((member) => member.userId === bobUser.userId)?.role)
        .toBe(TreePermissions.Owner);
      const removed = await core.unshareVault(aliceStore, tree.id, bobUser.userId);
      expect(removed.removed).toBe(true);
      expect(await aliceStore.getRoomMembership(tree.id, bobUser.userId)).toBe("leave");
    } finally {
      if (vaultId) {
        try { await core.deleteVault(new TeleCryptIOStorage(alice), vaultId); } catch { /* report by test result */ }
      }
      await stopTestClient(alice);
      await stopTestClient(bob);
    }
  }, 120000);

  it("reports native equal-power descendant denials as partial share and unshare", async () => {
    const aliceUser = await registerTestUser("partial_owner");
    const bobUser = await registerTestUser("partial_admin");
    const charlieUser = await registerTestUser("partial_target");
    const alice = await createTestClient(aliceUser);
    const bob = await createTestClient(bobUser);
    const charlie = await createTestClient(charlieUser);
    let vaultId: string | undefined;
    let childId: string | undefined;
    try {
      const aliceStore = await readyStorage(alice);
      const bobStore = await readyStorage(bob);
      const charlieStore = await readyStorage(charlie);
      const root = await createImplicitCreatorTree(aliceStore, "Partial native authorization");
      const child = await createImplicitCreatorTree(aliceStore, "Partial native child");
      vaultId = root.id;
      childId = child.id;
      const via = alice.getDomain();
      if (!via) throw new Error("Matrix server domain is unavailable");
      await alice.sendStateEvent(root.id, EventType.SpaceChild, { via: [via] }, child.id);
      await alice.sendStateEvent(child.id, EventType.SpaceParent, { via: [via] }, root.id);
      await aliceStore.refreshRoomState(root.id);
      await aliceStore.refreshRoomState(child.id);
      expect((await aliceStore.getTree(root.id)?.getDirectories())?.map((space) => space.id)).toContain(child.id);

      await core.shareVault(aliceStore, root.id, bobUser.userId, "owner");
      await bob.joinRoom(root.id);
      await bob.joinRoom(child.id);
      await waitForTree(bobStore, child.id, "Bob joins the child");
      await core.shareVault(aliceStore, root.id, charlieUser.userId, "viewer");
      await charlie.joinRoom(root.id);
      await charlie.joinRoom(child.id);
      await waitForTree(charlieStore, child.id, "Charlie joins the child");

      await aliceStore.getTree(child.id)!.setPermissions(charlieUser.userId, "owner");
      await aliceStore.refreshRoomState(child.id);
      expect((await aliceStore.listMembers(aliceStore.getTree(child.id)!))
        .find((member) => member.userId === charlieUser.userId)?.role).toBe(TreePermissions.Owner);

      const partialShare = await core.shareVault(bobStore, root.id, charlieUser.userId, "editor")
        .then(() => null, (error: unknown) => error);
      expect(partialShare).toMatchObject({
        code: "MUTATION_PARTIAL",
        operation: "share",
        completedIds: [root.id],
      });
      expect((partialShare as Error & { cause?: { errcode?: string } }).cause?.errcode).toBe("M_FORBIDDEN");

      const partialUnshare = await core.unshareVault(bobStore, root.id, charlieUser.userId)
        .then(() => null, (error: unknown) => error);
      expect(partialUnshare).toMatchObject({
        code: "MUTATION_PARTIAL",
        operation: "unshare",
        completedIds: [root.id],
      });
      expect((partialUnshare as Error & { cause?: { errcode?: string } }).cause?.errcode).toBe("M_FORBIDDEN");
      expect(await aliceStore.getRoomMembership(root.id, charlieUser.userId)).toBe("leave");
      expect(await aliceStore.getRoomMembership(child.id, charlieUser.userId)).toBe("join");

      await core.unshareVault(aliceStore, root.id, bobUser.userId);
      await core.unshareVault(aliceStore, root.id, charlieUser.userId);
      await core.deleteFolder(aliceStore, child.id);
      childId = undefined;
      await core.deleteVault(aliceStore, root.id);
      vaultId = undefined;
    } finally {
      const aliceStore = new TeleCryptIOStorage(alice);
      if (vaultId) {
        for (const userId of [bobUser.userId, charlieUser.userId]) {
          try { await core.unshareVault(aliceStore, vaultId, userId); } catch { /* preserve primary test failure */ }
        }
      }
      if (childId) {
        try { await core.deleteFolder(aliceStore, childId); } catch { /* preserve primary test failure */ }
      }
      if (vaultId) {
        try { await core.deleteVault(aliceStore, vaultId); } catch { /* preserve primary test failure */ }
      }
      await stopTestClient(alice);
      await stopTestClient(bob);
      await stopTestClient(charlie);
    }
  }, 120000);

  it("reads encrypted event ownership and redaction from a fresh login without its key", async () => {
    const aliceUser = await registerTestUser("envelope_owner");
    const alice = await createTestClient(aliceUser);
    let freshAlice: Awaited<ReturnType<typeof createTestClient>> | undefined;
    let vaultId: string | undefined;
    let fileId: string | undefined;
    try {
      const aliceStore = await readyStorage(alice);
      const tree = await aliceStore.createTree("Fresh device encrypted event");
      vaultId = tree.id;
      await waitForTreeName(aliceStore, tree.id, "Fresh device encrypted event");
      fileId = await core.uploadFile(aliceStore, tree.id, "no-key.txt", new TextEncoder().encode("encrypted"), "text/plain").then((file) => file.id);

      freshAlice = await createTestClient(await loginNewDevice(aliceUser));
      const freshStore = new TeleCryptIOStorage(freshAlice);
      await waitForTree(freshStore, tree.id, "new Alice device syncs the vault");
      const raw = await freshAlice.fetchRoomEvent(tree.id, fileId);
      const mapped = freshAlice.getEventMapper()(raw);
      expect(mapped.getWireType()).toBe("m.room.encrypted");
      await expect(freshStore.getOriginalFileEvent(tree.id, fileId)).rejects.toBeInstanceOf(UndecryptableFileError);
      await expect(freshStore.getOriginalFileEventState(tree.id, fileId)).resolves.toEqual({
        ownerUserId: aliceUser.userId,
        redacted: false,
        canRedact: true,
      });

      await core.deleteFile(aliceStore, tree.id, fileId);
      await waitFor(async () => {
        const state = await freshStore.getOriginalFileEventState(tree.id, fileId!);
        return state.redacted ? state : null;
      }, { label: "fresh device detects original-event redaction without its key", timeoutMs: 15000 });
      await expect(freshStore.getOriginalFileEventState(tree.id, fileId)).resolves.toEqual({
        ownerUserId: aliceUser.userId,
        redacted: true,
        canRedact: false,
      });
    } finally {
      const aliceStore = new TeleCryptIOStorage(alice);
      if (vaultId && fileId) {
        try { await core.deleteFile(aliceStore, vaultId, fileId); } catch { /* preserve primary test failure */ }
      }
      if (vaultId) {
        try { await core.deleteVault(aliceStore, vaultId); } catch { /* preserve primary test failure */ }
      }
      if (freshAlice) await stopTestClient(freshAlice);
      await stopTestClient(alice);
    }
  }, 120000);

  it("3.1 Alice shares with Bob as Viewer; Bob can list the files", async () => {
    const aliceUser = await registerTestUser("share_a");
    const bobUser = await registerTestUser("share_b");
    const alice = await createTestClient(aliceUser);
    const bob = await createTestClient(bobUser);
    try {
      const aliceStore = new TeleCryptIOStorage(alice);
      const bobStore = new TeleCryptIOStorage(bob);

      const tree = await aliceStore.createTree("Shared");
      await waitForTreeName(aliceStore, tree.id, "Shared");

      const data = new TextEncoder().encode("shared content").buffer as ArrayBuffer;
      const eventId = await aliceStore.uploadFile(tree, "shared.txt", data, "text/plain");
      await waitForFiles(tree, "alice file uploaded");

      await tree.invite(bobUser.userId);
      await bob.joinRoom(tree.id);

      const bobTree = await waitForTree(bobStore, tree.id);
      const bobFiles = await waitForFiles(bobTree, "bob sees files");
      expect(bobFiles.some((f) => f.id === eventId)).toBe(true);
    } finally {
      stopTestClient(alice);
      stopTestClient(bob);
    }
  });

  it("3.2 Bob as Viewer can download and decrypt Alice's file", async () => {
    const aliceUser = await registerTestUser("share_a");
    const bobUser = await registerTestUser("share_b");
    const alice = await createTestClient(aliceUser);
    const bob = await createTestClient(bobUser);
    try {
      const aliceStore = new TeleCryptIOStorage(alice);
      const bobStore = new TeleCryptIOStorage(bob);

      const tree = await aliceStore.createTree("DecryptTest");
      await waitForTreeName(aliceStore, tree.id, "DecryptTest");

      // Alice invites Bob FIRST, then uploads so Bob gets the megolm key
      await tree.invite(bobUser.userId);
      await bob.joinRoom(tree.id);
      await waitForTree(bobStore, tree.id, "bob joined");

      // Now Alice uploads — Bob is in the room and gets the key
      const plaintext = new TextEncoder().encode("Hello from Alice!")
        .buffer as ArrayBuffer;
      await aliceStore.uploadFile(tree, "msg.txt", plaintext, "text/plain");
      const _aliceFiles = await waitForFiles(tree);

      // Bob downloads and decrypts
      const bobTree = await waitForTree(bobStore, tree.id);
      const bobFiles = await waitFor(
        async () => {
          const files = bobTree.listFiles() as {
            id: string;
            getName: () => string;
          }[];
          return files.length > 0 ? files : null;
        },
        { label: "bob sees encrypted file", timeoutMs: 15000 },
      );

      const downloaded = await bobStore.downloadFile(bobFiles[0] as any);
      const decoded = new TextDecoder().decode(downloaded.data);
      expect(decoded).toBe("Hello from Alice!");
    } finally {
      stopTestClient(alice);
      stopTestClient(bob);
    }
  });

  it("3.3 Bob as Reader cannot upload", async () => {
    const aliceUser = await registerTestUser("share_a");
    const bobUser = await registerTestUser("share_b");
    const alice = await createTestClient(aliceUser);
    const bob = await createTestClient(bobUser);
    try {
      const aliceStore = new TeleCryptIOStorage(alice);
      const bobStore = new TeleCryptIOStorage(bob);

      const tree = await aliceStore.createTree("EditTest");
      await waitForTreeName(aliceStore, tree.id, "EditTest");

      await tree.invite(bobUser.userId);
      await bob.joinRoom(tree.id);
      const bobTree = await waitForTree(bobStore, tree.id);

      // Storage sharing is owner/readers only. A reader cannot create a file.
      const bobData = new TextEncoder().encode("Bob's file").buffer as ArrayBuffer;
      await expect(bobStore.uploadFile(bobTree, "bob.txt", bobData, "text/plain")).rejects.toThrow();
    } finally {
      stopTestClient(alice);
      stopTestClient(bob);
    }
  });

  it("3.4 uninvited user cannot see the vault", async () => {
    const aliceUser = await registerTestUser("share_a");
    const charlieUser = await registerTestUser("share_c");
    const alice = await createTestClient(aliceUser);
    const charlie = await createTestClient(charlieUser);
    try {
      const aliceStore = new TeleCryptIOStorage(alice);
      const charlieStore = new TeleCryptIOStorage(charlie);

      const tree = await aliceStore.createTree("Private");
      await waitForTreeName(aliceStore, tree.id, "Private");

      const charlieTrees = await charlieStore.listTrees();
      expect(charlieTrees.some((t) => t.id === tree.id)).toBe(false);
    } finally {
      stopTestClient(alice);
      stopTestClient(charlie);
    }
  });

  it("3.5 storage readers cannot change their role", async () => {
    const aliceUser = await registerTestUser("share_a");
    const bobUser = await registerTestUser("share_b");
    const alice = await createTestClient(aliceUser);
    const bob = await createTestClient(bobUser);
    try {
      const aliceStore = new TeleCryptIOStorage(alice);
      const bobStore = new TeleCryptIOStorage(bob);

      const tree = await aliceStore.createTree("PermTest");
      await waitForTreeName(aliceStore, tree.id, "PermTest");

      await tree.invite(bobUser.userId);
      await bob.joinRoom(tree.id);

      const bobTree = await waitForTree(bobStore, tree.id, "Bob sees joined vault");
      const viewerPerms = bobTree.getPermissions(bobUser.userId);
      expect(viewerPerms).toBe(TreePermissions.Viewer);

      await expect(bobTree.setPermissions(bobUser.userId, TreePermissions.Editor)).rejects.toThrow();
      const authoritativeMembers = await aliceStore.listMembers(tree);
      expect(authoritativeMembers.find((member) => member.userId === bobUser.userId)?.role).toBe(
        TreePermissions.Viewer,
      );
      await bobStore.refreshRoomState(tree.id);
      expect(bobTree.getPermissions(bobUser.userId)).toBe(TreePermissions.Viewer);
    } finally {
      stopTestClient(alice);
      stopTestClient(bob);
    }
  });

  it("3.6 sharing parent with andSubspaces grants access to subfolders", async () => {
    const aliceUser = await registerTestUser("share_a");
    const bobUser = await registerTestUser("share_b");
    const alice = await createTestClient(aliceUser);
    const bob = await createTestClient(bobUser);
    try {
      const aliceStore = new TeleCryptIOStorage(alice);
      const bobStore = new TeleCryptIOStorage(bob);

      const parent = await aliceStore.createTree("Parent");
      await waitForTreeName(aliceStore, parent.id, "Parent");

      const child = await parent.createDirectory("Child");
      await waitFor(
        () => !child.isTopLevel,
        { label: "child is subspace", timeoutMs: 10000 },
      );

      // Invite Bob with andSubspaces
      await parent.invite(bobUser.userId, true);
      await bob.joinRoom(parent.id);
      // Also join the child room
      await bob.joinRoom(child.id);

      const bobParent = await waitForTree(bobStore, parent.id, "bob sees parent");

      // Bob needs to wait for the child space relationship to sync
      const bobChild = await waitFor<object | null>(
        () => bobParent.getDirectory(child.id) ?? null,
        { label: "bob sees child directory", timeoutMs: 10000 },
      );
      expect(bobChild).toBeDefined();
    } finally {
      stopTestClient(alice);
      stopTestClient(bob);
    }
  });

  it("3.8 after Alice removes Bob, Bob cannot read new files", async () => {
    const aliceUser = await registerTestUser("share_a");
    const bobUser = await registerTestUser("share_b");
    const alice = await createTestClient(aliceUser);
    const bob = await createTestClient(bobUser);
    try {
      const aliceStore = new TeleCryptIOStorage(alice);
      const bobStore = new TeleCryptIOStorage(bob);

      const tree = await aliceStore.createTree("Revocation");
      await waitForTreeName(aliceStore, tree.id, "Revocation");

      // Alice invites Bob first, then uploads a file Bob can read
      await tree.invite(bobUser.userId);
      await bob.joinRoom(tree.id);
      await waitForTree(bobStore, tree.id, "bob joined");

      const file1 = new TextEncoder().encode("BEFORE removal").buffer as ArrayBuffer;
      await aliceStore.uploadFile(tree, "before.txt", file1, "text/plain");
      const _aliceFiles = await waitForFiles(tree, "first file uploaded");

      // Bob can decrypt the file shared while he had access
      const bobTree = await waitForTree(bobStore, tree.id);
      const bobFiles = await waitFor(
        async () => {
          const files = bobTree.listFiles() as {
            id: string;
            getName: () => string;
          }[];
          return files.length > 0 ? files : null;
        },
        { label: "bob sees before file", timeoutMs: 15000 },
      );
      const firstDownload = await bobStore.downloadFile(bobFiles[0] as any);
      expect(new TextDecoder().decode(firstDownload.data)).toBe("BEFORE removal");

      // Alice kicks Bob from the room
      await alice.kick(tree.id, bobUser.userId, "revoked");

      // Wait for the room state to update
      await waitFor(
        () => {
          const room = bob.getRoom(tree.id);
          return room?.getMyMembership() === "leave";
        },
        { label: "bob removed from room", timeoutMs: 10000 },
      );

      // Alice uploads a NEW file AFTER removal
      const file2 = new TextEncoder().encode("AFTER removal").buffer as ArrayBuffer;
      const afterEventId = await aliceStore.uploadFile(tree, "after.txt", file2, "text/plain");
      const aliceAfterFiles = await waitFor(
        async () => {
          const files = tree.listFiles() as { id: string; getName: () => string }[];
          return files.some((f) => f.id === afterEventId) ? files : null;
        },
        { label: "alice after file", timeoutMs: 15000 },
      );
      const aliceAfterBranch = aliceAfterFiles.find((f) => f.id === afterEventId)!;

      // --- Prove Bob cannot obtain the plaintext of "AFTER removal" — not merely that he was
      // kicked. A passing test here must actually depend on key-denial, not just membership.

      // 1) The friendly library path is closed: Bob's own listTrees() no longer includes the
      // tree at all.
      const bobTreesAfter = await bobStore.listTrees();
      expect(bobTreesAfter.some((t) => t.id === tree.id)).toBe(false);

      // 2) Bob's own client (using the tree reference he already held from before the kick)
      // never receives the new file's branch state at all — once kicked, Synapse stops
      // delivering room updates to him, so the branch is simply absent, full stop.
      expect(bobTree.getFile(afterEventId)).toBeNull();

      // 3) Even a direct, low-level attempt by Bob to fetch the encrypted room event by ID is
      // denied by the server: he is not a member of the room as of when this event was sent, and
      // Synapse enforces that independently of E2EE. This proves Bob cannot obtain the
      // megolm-encrypted event body (and therefore the AES key/JWK carried inside it) through the
      // Matrix API at all, by any means available to his client.
      await expect(bob.fetchRoomEvent(tree.id, afterEventId)).rejects.toThrow();

      // 4) Matrix authenticated media is NOT room-access-controlled: Bob's own (still-valid)
      // access token CAN fetch the raw ciphertext bytes for the file's mxc URI directly. This is
      // the scenario that makes step 5 meaningful — the ciphertext genuinely is reachable, so the
      // security property depends entirely on the key, not on hiding the bytes.
      const { info: aliceFileInfo } = await (
        aliceAfterBranch as unknown as {
          getFileInfo: () => Promise<{ info: Record<string, unknown> }>;
        }
      ).getFileInfo();
      const mxcUrl = aliceFileInfo.url as string;
      const bobClientAny = bob as unknown as {
        mxcUrlToHttp: (mxc: string, ...args: unknown[]) => string | null;
        getAccessToken: () => string | null;
      };
      const bobDownloadUrl = bobClientAny.mxcUrlToHttp(
        mxcUrl,
        undefined,
        undefined,
        undefined,
        false,
        true,
        true,
      );
      const rawRes = await fetch(bobDownloadUrl!, {
        headers: { Authorization: `Bearer ${bobClientAny.getAccessToken()}` },
      });
      expect(rawRes.ok).toBe(true);
      const rawCiphertext = await rawRes.arrayBuffer();

      // The raw ciphertext bytes never contain the plaintext (confirms it really is encrypted,
      // not merely obscured).
      const rawText = new TextDecoder("utf-8", { fatal: false }).decode(rawCiphertext);
      expect(rawText).not.toContain("AFTER removal");

      // 5) And Bob has no legitimate way to get the real decryption key (steps 2 and 3 already
      // proved he cannot reach the event that carries it). Simulating his best-case outcome —
      // attempting to decrypt the ciphertext with a key he does NOT actually have — yields
      // garbage, not "AFTER removal". (AES-CTR has no authentication tag, so a wrong key
      // "succeeds" mechanically but produces useless output; it does not throw.)
      const { decryptAttachment } = await import("matrix-encrypt-attachment");
      const wrongKey = { ...(aliceFileInfo.key as { k: string }) };
      // Reversing the base64url key material guarantees a different (wrong) key while keeping
      // valid base64url characters and length.
      wrongKey.k = wrongKey.k.split("").reverse().join("");
      const garbage = await decryptAttachment(Buffer.from(rawCiphertext), {
        ...aliceFileInfo,
        key: wrongKey,
      } as Parameters<typeof decryptAttachment>[1]);
      expect(new TextDecoder("utf-8", { fatal: false }).decode(garbage)).not.toBe(
        "AFTER removal",
      );
    } finally {
      stopTestClient(alice);
      stopTestClient(bob);
    }
  });

  it("3.8 listMembers reports participants and their roles from membership + power levels", async () => {
    const aliceUser = await registerTestUser("share_a");
    const bobUser = await registerTestUser("share_b");
    const charlieUser = await registerTestUser("share_c");
    const alice = await createTestClient(aliceUser);
    const bob = await createTestClient(bobUser);
    try {
      const aliceStore = new TeleCryptIOStorage(alice);

      const tree = await aliceStore.createTree("Members");
      await waitForTreeName(aliceStore, tree.id, "Members");

      // Alice (the creator/owner) should already be reported even before
      // anyone else is invited.
      const soloMembers = await aliceStore.listMembers(tree);
      expect(soloMembers.some((m) => m.userId === aliceUser.userId && m.role === "owner")).toBe(
        true,
      );

      // Invite Bob as (default) viewer; he shows up as "invite" until he joins.
      await tree.invite(bobUser.userId);
      const invitedMembers = await waitFor(
        async () => {
          const members = await aliceStore.listMembers(tree);
          const b = members.find((m) => m.userId === bobUser.userId);
          return b ? members : null;
        },
        { label: "bob visible as invited", timeoutMs: 10000 },
      );
      const bobInvited = invitedMembers.find((m) => m.userId === bobUser.userId)!;
      expect(bobInvited.role).toBe(TreePermissions.Viewer);
      expect(bobInvited.membership).toBe("invite");

      // Bob joins and remains a reader.
      await bob.joinRoom(tree.id);
      const joinedMembers = await waitFor(
        async () => {
          const members = await aliceStore.listMembers(tree);
          const b = members.find((m) => m.userId === bobUser.userId);
          return b?.membership === "join" && b.role === TreePermissions.Viewer ? members : null;
        },
        { label: "bob joined as reader", timeoutMs: 10000 },
      );
      const bobJoined = joinedMembers.find((m) => m.userId === bobUser.userId)!;
      expect(bobJoined.role).toBe(TreePermissions.Viewer);
      expect(bobJoined.membership).toBe("join");

      // Charlie, who was never invited, must not appear at all.
      expect(joinedMembers.some((m) => m.userId === charlieUser.userId)).toBe(false);
    } finally {
      stopTestClient(alice);
      stopTestClient(bob);
    }
  });
});
