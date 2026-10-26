import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { EventType, UNSTABLE_MSC3089_BRANCH } from "matrix-js-sdk";
import { writeFile } from "node:fs/promises";
import { TeleCryptIOStorage } from "../../src/TeleCryptIOStorage.js";
import * as core from "../../src/core/operations.js";
import { registerTestUser, loginNewDevice } from "../harness/users.js";
import { waitFor } from "../harness/waitFor.js";

const evidence = process.env.STORAGE_MUTATION_REGRESSIONS_RESULTS_PATH;
const findings: Record<string, unknown> = {};
const clients: TeleCryptIOStorage[] = [];
const rooms: Array<{ storage: TeleCryptIOStorage; id: string }> = [];
const files: Array<{ storage: TeleCryptIOStorage; room: string; id: string }> = [];
const nativeFetch = globalThis.fetch.bind(globalThis);
let owner: Awaited<ReturnType<typeof storageUser>>;
let ownerB: TeleCryptIOStorage;
let reader: Awaited<ReturnType<typeof storageUser>>;
let pauseToken: string | undefined;
let syncHeld = false;
let releaseSync: (() => void) | undefined;
let syncGate = Promise.resolve();

async function save(name: string, value: unknown) {
  findings[name] = value;
  if (evidence) await writeFile(evidence, JSON.stringify(findings, null, 2) + "\n", { mode: 0o600 });
}

async function openStorage(user: Awaited<ReturnType<typeof registerTestUser>>) {
  const storage = await TeleCryptIOStorage.create({
    ...user,
    baseUrl: "http://localhost:8008",
    serverName: "localhost:8008",
    persistentCryptoStore: false,
  });
  clients.push(storage);
  return storage;
}

async function storageUser(prefix: string) {
  const user = await registerTestUser(prefix);
  const storage = await openStorage(user);
  const { recoveryKey } = await storage.keySafe.setup();
  await storage.keySafe.confirmSaved();
  return { user, storage, recoveryKey };
}

async function holdOwnerSync(roomId: string) {
  syncHeld = false;
  syncGate = new Promise<void>((resolve) => { releaseSync = resolve; });
  pauseToken = owner.user.accessToken;
  await owner.storage.getClient().sendStateEvent(
    roomId,
    "io.telecrypt.storage_regression.sync_gate" as never,
    { tick: Date.now() } as never,
    "",
  );
  await waitFor(() => syncHeld, { label: "owner sync response held", timeoutMs: 10000 });
}

function resumeOwnerSync() {
  pauseToken = undefined;
  releaseSync?.();
  releaseSync = undefined;
}

async function roomChildren(storage: TeleCryptIOStorage, roomId: string): Promise<string[]> {
  await storage.refreshRoomState(roomId);
  const events = storage.getClient().getRoom(roomId)?.currentState.getStateEvents(EventType.SpaceChild);
  return (Array.isArray(events) ? events : events ? [events] : [])
    .filter((event) => {
      const content = event.getContent();
      return typeof content === "object" && content !== null && Object.keys(content).length > 0;
    })
    .map((event) => event.getStateKey())
    .filter((room): room is string => typeof room === "string");
}

beforeAll(async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const response = await nativeFetch(input, init);
    if (
      pauseToken &&
      new URL(url).pathname.endsWith("/sync") &&
      headers.get("authorization") === `Bearer ${pauseToken}`
    ) {
      syncHeld = true;
      await syncGate;
    }
    return response;
  });
  owner = await storageUser("mutation_regression_owner");
  reader = await storageUser("mutation_regression_reader");
  ownerB = await openStorage(await loginNewDevice(owner.user));
  await ownerB.keySafe.restore(owner.recoveryKey);
}, 120000);

it.each([false, true])("reconciles rename after another device deletes the file (interrupted cleanup: %s)", async (interruptCleanup) => {
  const storage = owner.storage;
  const vault = await core.createVault(storage, "Concurrent deletion");
  const file = await core.uploadFile(storage, vault.id, "before.txt", new TextEncoder().encode("race"), "text/plain");
  await storage.waitForKeyBackup(vault.id, file.id);
  await waitFor(() => ownerB.getTree(vault.id), { label: "second device sees vault", timeoutMs: 15000 });
  const client = storage.getClient();
  const send = client.sendMessage.bind(client);
  const redact = client.redactEvent.bind(client);
  let release!: () => void;
  let paused = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const sendSpy = vi.spyOn(client, "sendMessage").mockImplementation(async (...args) => {
    if ((args[1] as Record<string, unknown>).body === "after.txt") {
      paused = true;
      await gate;
    }
    return send(...args);
  });
  const redactSpy = vi.spyOn(client, "redactEvent").mockImplementation(async (...args) => {
    if (interruptCleanup) throw new Error("rename cleanup temporarily unavailable");
    return redact(...args);
  });
  const renamed = core.renameFile(storage, vault.id, file.id, "after.txt").catch((error: unknown) => error);
  try {
    await waitFor(() => paused, { label: "rename paused after validation", timeoutMs: 15000 });
    await core.deleteFile(ownerB, vault.id, file.id);
    release();
    expect(await renamed).toBeInstanceOf(Error);
    sendSpy.mockRestore();
    redactSpy.mockRestore();
    // Retry from the device that already completed deletion: its local marker
    // must not hide a late owner-authored listing from reconciliation.
    await core.deleteFile(ownerB, vault.id, file.id);
    await storage.refreshRoomState(vault.id);
    expect(await core.listFiles(storage, vault.id)).toEqual([]);
    const listing = client.getRoom(vault.id)?.currentState.getStateEvents(UNSTABLE_MSC3089_BRANCH.name, file.id);
    // The original encrypted file message is the deletion authority. The
    // Whether the server also redacts the MSC3089 branch is incidental to
    // listing; only the original encrypted message is deletion authority.
    await save(`concurrentRenameDelete-${interruptCleanup}`, {
      renameRejected: true,
      deleteRetryCompleted: true,
      listingRedacted: listing?.isRedacted() ?? false,
      fileRemainsHiddenByOriginalRedaction: true,
    });
  } finally {
    release();
    await renamed;
    sendSpy.mockRestore();
    redactSpy.mockRestore();
    await core.deleteFile(ownerB, vault.id, file.id);
    await core.deleteVault(ownerB, vault.id);
  }
}, 120000);

afterAll(async () => {
  resumeOwnerSync();
  vi.restoreAllMocks();
  const failures: string[] = [];
  for (const file of files.reverse()) {
    try { await core.deleteFile(file.storage, file.room, file.id); }
    catch (error) { failures.push(`file ${file.id}: ${String(error)}`); }
  }
  for (const room of rooms.reverse()) {
    try { await core.deleteVault(room.storage, room.id); }
    catch (error) { failures.push(`room ${room.id}: ${String(error)}`); }
  }
  for (const client of clients) client.getClient().stopClient();
  await save("cleanup", { failures });
  expect(failures).toEqual([]);
}, 120000);

it("refreshes changed child links and recovers unshare when a descendant is not in the local store", async () => {
  const vault = await core.createVault(owner.storage, "Recursive unshare regression");
  rooms.push({ storage: owner.storage, id: vault.id });
  const child = await core.createSubfolder(owner.storage, vault.id, "Known child");
  rooms.push({ storage: owner.storage, id: child.id });
  await core.shareVault(owner.storage, vault.id, reader.user.userId, "viewer");
  await core.joinVault(reader.storage, vault.id);
  await waitFor(() => ownerB.getTree(child.id), { label: "second owner sees existing child", timeoutMs: 15000 });

  await holdOwnerSync(child.id);
  let grandchild: Awaited<ReturnType<typeof core.createSubfolder>> | undefined;
  let firstResult: Awaited<ReturnType<typeof core.unshareVault>> | undefined;
  let firstError: string | undefined;
  let readerMembershipBefore: string | null = null;
  try {
    grandchild = await core.createSubfolder(ownerB, child.id, "Added during delayed sync");
    rooms.push({ storage: ownerB, id: grandchild.id });
    expect(await roomChildren(owner.storage, child.id)).toContain(grandchild.id);
    await waitFor(
      () => reader.storage.getClient().getRoom(grandchild!.id)?.getMyMembership() === "invite",
      { label: "reader receives the new descendant invitation", timeoutMs: 15000 },
    );
    await core.joinVault(reader.storage, grandchild.id);
    readerMembershipBefore = await ownerB.getRoomMembership(grandchild.id, reader.user.userId);
    expect(readerMembershipBefore).toBe("join");

    const beforeRemoval = await core.uploadFile(
      ownerB,
      grandchild.id,
      "before-unshare.txt",
      new TextEncoder().encode("reader can access this before removal"),
      "text/plain",
    );
    files.push({ storage: ownerB, room: grandchild.id, id: beforeRemoval.id });
    const readableBeforeRemoval = await core.downloadFile(reader.storage, grandchild.id, beforeRemoval.id);
    expect(new TextDecoder().decode(readableBeforeRemoval.bytes)).toBe("reader can access this before removal");

    expect(owner.storage.getTree(child.id)).not.toBeNull();
    expect(owner.storage.getTree(grandchild.id)).toBeNull();
    try {
      firstResult = await core.unshareVault(owner.storage, vault.id, reader.user.userId);
    } catch (error) {
      firstError = error instanceof Error ? error.message : String(error);
    }
  } finally {
    resumeOwnerSync();
  }

  if (firstResult) {
    expect(await ownerB.getRoomMembership(grandchild!.id, reader.user.userId)).toBe("leave");
  } else {
    expect(firstError).toBeTruthy();
    expect(await ownerB.getRoomMembership(grandchild!.id, reader.user.userId)).toBe(readerMembershipBefore);
  }
  await waitFor(
    () => owner.storage.getTree(grandchild!.id),
    { label: "owner sync restores the newly related room", timeoutMs: 15000 },
  );
  const removal = firstResult ?? await core.unshareVault(owner.storage, vault.id, reader.user.userId);
  const memberships = {
    root: await ownerB.getRoomMembership(vault.id, reader.user.userId),
    child: await ownerB.getRoomMembership(child.id, reader.user.userId),
    grandchild: await ownerB.getRoomMembership(grandchild!.id, reader.user.userId),
  };
  expect(removal.removed).toBe(true);
  expect(memberships).toEqual({ root: "leave", child: "leave", grandchild: "leave" });

  const uploadedAfterRemoval = await core.uploadFile(
    ownerB,
    grandchild!.id,
    "after-unshare.txt",
    new TextEncoder().encode("new content after removal"),
    "text/plain",
  );
  files.push({ storage: ownerB, room: grandchild!.id, id: uploadedAfterRemoval.id });
  await expect(core.downloadFile(reader.storage, grandchild!.id, uploadedAfterRemoval.id)).rejects.toThrow();
  await save("recursiveUnshare", {
    ownerSawExistingChild: true,
    grandchildWasAbsentLocallyBeforeRemoval: true,
    firstAttempt: firstResult ? "completed all descendants" : { error: firstError },
    recoveredAfterSync: !firstResult,
    memberships,
    postRemovalDownloadRejected: true,
  });
}, 120000);

it("rejects rename through retained handles after listing or original attachment redaction", async () => {
  const vault = await core.createVault(ownerB, "Deleted file rename regression");
  rooms.push({ storage: ownerB, id: vault.id });

  const deleted = await core.uploadFile(
    ownerB,
    vault.id,
    "before-delete.txt",
    new TextEncoder().encode("deleted from another device"),
    "text/plain",
  );
  files.push({ storage: ownerB, room: vault.id, id: deleted.id });
  await waitFor(() => owner.storage.getTree(vault.id)?.getFile(deleted.id), {
    label: "first owner sees file before remote deletion",
    timeoutMs: 15000,
  });
  const deletedHandle = owner.storage.getTree(vault.id)!.getFile(deleted.id)!;
  await core.deleteFile(ownerB, vault.id, deleted.id);
  await owner.storage.refreshRoomState(vault.id);
  const deletedBranch = owner.storage.getTree(vault.id)?.getFile(deleted.id);
  const deletedAttachment = await owner.storage.getOriginalFileEvent(vault.id, deleted.id, true);
  expect(deletedBranch?.isActive).toBe(true);
  expect(deletedAttachment.isRedacted()).toBe(true);
  await expect(core.renameFile(owner.storage, vault.id, deleted.id, "resurrected.txt")).rejects.toThrow(
    "file not found",
  );
  await expect(deletedHandle.setName("resurrected through retained handle.txt")).rejects.toThrow(
    "file not found",
  );
  expect((await core.listFiles(owner.storage, vault.id)).map((file) => file.id)).not.toContain(deleted.id);

  const redactedListing = await core.uploadFile(
    ownerB,
    vault.id,
    "listing-only-redaction.txt",
    new TextEncoder().encode("attachment remains while listing is redacted"),
    "text/plain",
  );
  files.push({ storage: ownerB, room: vault.id, id: redactedListing.id });
  await waitFor(() => owner.storage.getTree(vault.id)?.getFile(redactedListing.id), {
    label: "first owner sees file before listing redaction",
    timeoutMs: 15000,
  });
  const listingHandle = owner.storage.getTree(vault.id)!.getFile(redactedListing.id)!;
  const listingEventId = ownerB.getTree(vault.id)?.getFile(redactedListing.id)?.indexEvent?.getId();
  expect(listingEventId).toBeTruthy();
  await ownerB.getClient().redactEvent(vault.id, listingEventId!);
  await owner.storage.refreshRoomState(vault.id);
  const remainingAttachment = await owner.storage.getOriginalFileEvent(vault.id, redactedListing.id, true);
  expect(remainingAttachment.isRedacted()).toBe(false);
  await expect(listingHandle.setName("ghost-listing.txt")).rejects.toThrow("file not found");
  expect((await core.listFiles(owner.storage, vault.id)).map((file) => file.id)).not.toContain(redactedListing.id);

  await save("renameDeletedFiles", {
    completedDeletion: {
      listingStillPresent: deletedBranch?.isActive === true,
      originalAttachmentRedacted: deletedAttachment.isRedacted(),
      coreRenameRejected: true,
      retainedHandleRenameRejected: true,
      ghostListingCreated: false,
    },
    listingOnlyRedaction: {
      listingInactive: owner.storage.getTree(vault.id)?.getFile(redactedListing.id)?.isActive === false,
      originalAttachmentRedacted: remainingAttachment.isRedacted(),
      retainedHandleRenameRejected: true,
      ghostListingCreated: false,
    },
  });
}, 120000);

it("lets an editor rename Alice's file while only Alice can delete its media", async () => {
  const vault = await core.createVault(owner.storage, "Uploader deletion authority");
  const vaultRef = { storage: owner.storage, id: vault.id };
  rooms.push(vaultRef);
  const folder = await core.createSubfolder(owner.storage, vault.id, "Shared folder");
  const folderRef = { storage: owner.storage, id: folder.id };
  rooms.push(folderRef);
  const file = await core.uploadFile(
    owner.storage,
    folder.id,
    "alice-name.txt",
    new TextEncoder().encode("bytes owned by Alice"),
    "text/plain",
  );
  const fileRef = { storage: owner.storage, room: folder.id, id: file.id };
  files.push(fileRef);
  const mediaId = (await owner.storage.getOriginalFileEvent(folder.id, file.id)).getContent().file.url as string;
  await owner.storage.waitForKeyBackup(folder.id, file.id);

  await core.shareVault(owner.storage, vault.id, reader.user.userId, "editor");
  await core.joinVault(reader.storage, vault.id);
  await waitFor(() => reader.storage.getTree(folder.id), {
    label: "editor joins the existing shared folder",
    timeoutMs: 15000,
  });
  await core.renameFile(reader.storage, folder.id, file.id, "bob-name.txt");
  expect((await core.listFiles(reader.storage, folder.id)).map((entry) => entry.name)).toContain("bob-name.txt");
  await expect(core.deleteFile(reader.storage, folder.id, file.id)).rejects.toThrow(
    "only the file uploader may delete this file",
  );

  await core.deleteFile(owner.storage, folder.id, file.id);
  await owner.storage.refreshRoomState(folder.id);
  await reader.storage.refreshRoomState(folder.id);
  await ownerB.refreshRoomState(folder.id);
  expect(await core.listFiles(owner.storage, folder.id)).toEqual([]);
  expect(await core.listFiles(reader.storage, folder.id)).toEqual([]);
  expect(await core.listFiles(ownerB, folder.id)).toEqual([]);
  await expect(core.downloadFile(reader.storage, folder.id, file.id)).rejects.toThrow("file not found");

  const mediaUrl = owner.storage.getClient().mxcUrlToHttp(mediaId, undefined, undefined, undefined, false, true, true)!;
  const mediaResponse = await fetch(mediaUrl, {
    headers: { Authorization: `Bearer ${owner.storage.getClient().getAccessToken()}` },
  });
  expect(mediaResponse.status).toBe(404);
  await mediaResponse.text();

  const fresh = await openStorage(await loginNewDevice(owner.user));
  await fresh.keySafe.restore(owner.recoveryKey);
  await waitFor(() => fresh.getTree(folder.id), { label: "fresh owner device sees the shared folder", timeoutMs: 15000 });
  expect(await core.listFiles(fresh, folder.id)).toEqual([]);

  await core.deleteFolder(owner.storage, folder.id);
  files.splice(files.indexOf(fileRef), 1);
  rooms.splice(rooms.indexOf(folderRef), 1);
  await core.deleteVault(owner.storage, vault.id);
  rooms.splice(rooms.indexOf(vaultRef), 1);
  await save("uploaderDeletionAuthority", {
    editorRenameSucceeded: true,
    editorDeleteRejected: true,
    ownerAndFreshDeviceOmitFile: true,
    editorOmitsFile: true,
    mxcMediaStatus: mediaResponse.status,
    emptyFolderDeletionSucceeded: true,
  });
}, 120000);

it("reconciles an editor invite when a second owner unshares during folder creation", async () => {
  const vault = await core.createVault(owner.storage, "Concurrent create and unshare");
  const vaultRef = { storage: owner.storage, id: vault.id };
  rooms.push(vaultRef);
  await core.shareVault(owner.storage, vault.id, reader.user.userId, "viewer");
  await core.joinVault(reader.storage, vault.id);

  let childReads = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const listMembers = ownerB.listMembers.bind(ownerB);
  const pause = vi.spyOn(ownerB, "listMembers").mockImplementation(async (space, options) => {
    const members = await listMembers(space, options);
    if (space.id !== vault.id && ++childReads === 2) {
      await gate;
    }
    return members;
  });
  let created: Awaited<ReturnType<typeof core.createSubfolder>> | undefined;
  try {
    const creating = core.createSubfolder(ownerB, vault.id, "Raced folder");
    await waitFor(() => childReads >= 2, { label: "new folder invite is visible before access reconciliation", timeoutMs: 15000 });
    const firstRemoval = await core.unshareVault(owner.storage, vault.id, reader.user.userId).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    release();
    created = await creating;
    const childRef = { storage: ownerB, id: created.id };
    rooms.push(childRef);

    if (firstRemoval.error) {
      await core.unshareVault(ownerB, vault.id, reader.user.userId);
    }
    const memberships = {
      root: await ownerB.getRoomMembership(vault.id, reader.user.userId),
      child: await ownerB.getRoomMembership(created.id, reader.user.userId),
    };
    expect(memberships.root).toBe("leave");
    expect(["leave", null]).toContain(memberships.child);
    expect(["leave", null]).toContain(await reader.storage.getRoomMembership(created.id, reader.user.userId));
    await core.deleteFolder(ownerB, created.id);
    rooms.splice(rooms.indexOf(childRef), 1);
    await core.deleteVault(ownerB, vault.id);
    rooms.splice(rooms.indexOf(vaultRef), 1);
    await save("createUnshareRace", {
      firstUnshare: firstRemoval.error ? String(firstRemoval.error) : "completed",
      folderCreated: true,
      childMembershipAfterReconciliation: memberships.child,
      rootMembershipAfterUnshare: memberships.root,
      staleReaderAccessRemains: false,
    });
  } finally {
    release();
    pause.mockRestore();
  }
}, 120000);
