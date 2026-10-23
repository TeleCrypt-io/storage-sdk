import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { EventType } from "matrix-js-sdk";
import { writeFile } from "node:fs/promises";
import { TeleCryptIOStorage } from "../../src/TeleCryptIOStorage.js";
import * as core from "../../src/core/operations.js";
import { registerTestUser, loginNewDevice } from "../harness/users.js";
import { waitFor } from "../harness/waitFor.js";

const evidence = "/home/ubuntu/harness.git/artifacts/storage-bugfixes-20261023/sdk-native-regressions.json";
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
  await writeFile(evidence, JSON.stringify(findings, null, 2) + "\n", { mode: 0o600 });
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
  expect(deletedBranch?.isActive).toBe(false);
  expect(deletedAttachment.isRedacted()).toBe(true);
  await expect(core.renameFile(owner.storage, vault.id, deleted.id, "resurrected.txt")).rejects.toThrow(
    "rename file failed",
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
      listingInactive: deletedBranch?.isActive === false,
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
