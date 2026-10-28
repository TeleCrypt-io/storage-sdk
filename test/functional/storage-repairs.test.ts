import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MatrixEvent } from "matrix-js-sdk";
import { writeFile } from "node:fs/promises";
import { TeleCryptIOStorage } from "../../src/TeleCryptIOStorage.js";
import * as core from "../../src/core/operations.js";
import { MutationOutcomeUnknownError, MutationPartialError } from "../../src/core/errors.js";
import { registerTestUser, loginNewDevice } from "../harness/users.js";
import { waitFor } from "../harness/waitFor.js";

const output = process.env.STORAGE_TRUST_RESULTS_PATH;
const findings: Record<string, unknown> = {};
const clients: TeleCryptIOStorage[] = [];
const rooms: Array<{ storage: TeleCryptIOStorage; id: string }> = [];
const files: Array<{ storage: TeleCryptIOStorage; room: string; id: string }> = [];
const nativeFetch = globalThis.fetch.bind(globalThis);
let owner: Awaited<ReturnType<typeof storageUser>>;
let reader: Awaited<ReturnType<typeof storageUser>>;
let pauseToken: string | undefined;
let syncHeld = false;
let releaseSync: (() => void) | undefined;
let syncGate = Promise.resolve();
let failEventId: string | undefined;
let stallRequest: ((url: string, method: string) => boolean) | undefined;
let observedAbort = false;

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

async function save(name: string, value: unknown) {
  findings[name] = value;
  if (output) await writeFile(output, JSON.stringify(findings, null, 2) + "\n", { mode: 0o600 });
}

async function vault(name: string, readers: Array<Awaited<ReturnType<typeof storageUser>>> = [reader]) {
  const result = await core.createVault(owner.storage, name);
  rooms.push({ storage: owner.storage, id: result.id });
  for (const member of readers) {
    await core.shareVault(owner.storage, result.id, member.user.userId, "viewer");
    await core.joinVault(member.storage, result.id);
  }
  return result;
}

async function upload(storage: TeleCryptIOStorage, room: string, name: string, text: string) {
  const file = await core.uploadFile(storage, room, name, new TextEncoder().encode(text), "text/plain");
  files.push({ storage, room, id: file.id });
  return file;
}

async function holdOwnerSync(room: string) {
  syncHeld = false;
  syncGate = new Promise<void>((resolve) => { releaseSync = resolve; });
  pauseToken = owner.user.accessToken;
  await owner.storage.getClient().sendStateEvent(
    room,
    "io.telecrypt.audit.sync_gate" as never,
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

async function decrypt(storage: TeleCryptIOStorage, raw: object) {
  const event = new MatrixEvent(structuredClone(raw) as never);
  await storage.getClient().decryptEventIfNeeded(event);
  return {
    success: !event.isDecryptionFailure(),
    body: event.getContent().body,
    error: event.decryptionFailureReason,
  };
}

beforeAll(async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (failEventId && url.includes(`/event/${encodeURIComponent(failEventId)}`)) throw new Error("audit post-commit readback outage");
    if (stallRequest?.(url, init?.method ?? "GET")) {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        const abort = () => { observedAbort = true; reject(new DOMException("aborted", "AbortError")); };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const response = await nativeFetch(input, init);
    if (pauseToken && new URL(url).pathname.endsWith("/sync") && headers.get("authorization") === `Bearer ${pauseToken}`) {
      syncHeld = true;
      await syncGate;
    }
    return response;
  });
  owner = await storageUser("trust_followup_owner");
  reader = await storageUser("trust_followup_reader");
}, 120000);

afterAll(async () => {
  resumeOwnerSync();
  vi.restoreAllMocks();
  const failures: string[] = [];
  for (const file of files.reverse()) {
    try { await core.deleteFile(file.storage, file.room, file.id); }
    catch (error) { failures.push(`file: ${String(error)}`); }
  }
  for (const room of rooms.reverse()) {
    try { await core.deleteVault(room.storage, room.id); }
    catch (error) { failures.push(`room: ${String(error)}`); }
  }
  for (const client of clients) client.getClient().stopClient();
  await save("cleanup", { failures });
  expect(failures).toEqual([]);
}, 120000);


describe("SDK repair regressions", () => {
 it.each(["metadata", "listing", "readback"])("bounds stalled rename %s requests", async (stage) => {
   const tree = await vault(`Rename deadline ${stage}`, []);
   const file = await upload(owner.storage, tree.id, "before.txt", "contents");
   const client = owner.storage.getClient();
   const sendState = client.sendStateEvent.bind(client);
   let listingAccepted = false;
   const spy = vi.spyOn(client, "sendStateEvent").mockImplementation(async (...args) => {
     const result = await sendState(...args);
     if (args[0] === tree.id && args[3] === file.id) listingAccepted = true;
     return result;
   });
   observedAbort = false;
   stallRequest = (url, method) => stage === "metadata"
     ? method === "PUT" && url.includes("/send/m.room.encrypted/")
     : stage === "listing"
       ? method === "PUT" && url.includes("/state/") && url.includes(encodeURIComponent(file.id))
       : listingAccepted && method === "GET" && url.includes(`/event/${encodeURIComponent(file.id)}`);
   const started = Date.now();
   try {
     const error = await core.renameFile(owner.storage, tree.id, file.id, "after.txt", { timeoutMs: 1000 })
       .then(() => null, (failure: unknown) => failure);
     expect(error).toBeInstanceOf(stage === "metadata" ? MutationOutcomeUnknownError : MutationPartialError);
     expect(Date.now() - started).toBeLessThan(5000);
     expect(observedAbort).toBe(true);
     if (stage !== "metadata") expect((error as MutationPartialError).backupTargets[0]?.metadataEventId).toBeTruthy();
   } finally { stallRequest = undefined; spy.mockRestore(); }
 }, 120000);
 it("retains and backs up the exact acknowledged tree name when its pointer fails", async () => {
   const tree = await vault("Before pointer failure", []);
   const client = owner.storage.getClient();
   const sendState = client.sendStateEvent.bind(client);
   const spy = vi.spyOn(client, "sendStateEvent").mockImplementation(async (...args) => {
     if (args[0] === tree.id && args[1] === "io.telecrypt.storage.metadata") throw new Error("pointer unavailable");
     return sendState(...args);
   });
   const error = await core.renameVault(owner.storage, tree.id, "Unlinked name").then(() => null, (failure: unknown) => failure);
   spy.mockRestore();
   expect(error).toBeInstanceOf(MutationPartialError);
   const target = (error as MutationPartialError).backupTargets[0]!;
   expect(target.treeId).toBe(tree.id);
   expect(target.metadataEventId).toBeTruthy();
   expect(await owner.storage.waitForKeyBackup(tree.id, undefined, { metadataEventId: target.metadataEventId })).toBe("backed_up");
   expect(await owner.storage.getTreeName(tree.id)).toBe("Before pointer failure");
 }, 120000);
 it("backs up acknowledged file metadata when its listing write fails", async () => {
   const tree = await vault("File pointer failure", []);
   const file = await upload(owner.storage, tree.id, "before.txt", "contents");
   const client = owner.storage.getClient();
   const sendState = client.sendStateEvent.bind(client);
   const spy = vi.spyOn(client, "sendStateEvent").mockImplementation(async (...args) => {
     if (args[0] === tree.id && args[3] === file.id) throw new Error("listing unavailable");
     return sendState(...args);
   });
   const error = await core.renameFile(owner.storage, tree.id, file.id, "Unlinked name").then(() => null, (failure: unknown) => failure);
   spy.mockRestore();
   expect(error).toBeInstanceOf(MutationPartialError);
   const target = (error as MutationPartialError).backupTargets[0]!;
   expect(target).toMatchObject({ treeId: tree.id, fileId: file.id, metadataEventId: expect.any(String) });
   expect(await owner.storage.waitForKeyBackup(tree.id, file.id, { metadataEventId: target.metadataEventId })).toBe("backed_up");
   expect(await owner.storage.getFileName(tree.id, file.id)).toBe("before.txt");
 }, 120000);
 it("rotates after removal during upload", async () => {
   const tree = await vault("Audit removal during media upload");
   const before = await upload(owner.storage, tree.id, "before.txt", "prior content");
   await core.downloadFile(reader.storage, tree.id, before.id);
   const c = owner.storage.getClient();
   const beforeRaw = await c.fetchRoomEvent(tree.id, before.id);
   await holdOwnerSync(tree.id);
   const originalUpload = c.uploadContent.bind(c);
   const spy = vi.spyOn(c, "uploadContent").mockImplementation(async (...args) => {
     const result = await originalUpload(...args);
     const kick = await nativeFetch(`http://localhost:8008/_matrix/client/v3/rooms/${encodeURIComponent(tree.id)}/kick`, {
       method: "POST", headers: { Authorization: `Bearer ${owner.user.accessToken}`, "Content-Type": "application/json" },
       body: JSON.stringify({user_id: reader.user.userId, reason: "audit external-device removal"})
     });
     expect(kick.status).toBe(200);
     expect(await owner.storage.getRoomMembership(tree.id, reader.user.userId)).toBe("leave");
     expect(c.getRoom(tree.id)!.getMember(reader.user.userId)!.membership).toBe("join");
     return result;
   });
   try {
     const after = await upload(owner.storage, tree.id, "after-removal.txt", "secret committed after removal");
     const afterRaw = await c.fetchRoomEvent(tree.id, after.id);
     const decrypted = await decrypt(reader.storage, afterRaw);
     await save("upload_removal_race", {preRemovalSession: beforeRaw.content.session_id, postRemovalSession: afterRaw.content.session_id, removedReader: decrypted});
     expect(decrypted.success).toBe(false);
     expect(afterRaw.content.session_id).not.toBe(beforeRaw.content.session_id);
   } finally { spy.mockRestore(); resumeOwnerSync(); }
 }, 120000);
 it("retains backup targets after committed rename", async () => {
   const tree = await vault("Audit rename readback");
   const file = await upload(owner.storage, tree.id, "before.txt", "rename payload");
   await owner.storage.waitForKeyBackup(tree.id, file.id);
   const c = owner.storage.getClient();
   const originalState = c.sendStateEvent.bind(c);
   let committed = false;
   const stateSpy = vi.spyOn(c, "sendStateEvent").mockImplementation(async (...args) => {
     const result = await originalState(...args);
     if (args[0] === tree.id && args[3] === file.id) { committed = true; failEventId = file.id; }
     return result;
   });
   let failure: unknown;
   try { await core.renameFile(owner.storage, tree.id, file.id, "committed-rename.txt"); }
   catch (error) { failure = error; }
   finally { stateSpy.mockRestore(); failEventId = undefined; }
   const error = failure as Error & {backupTargets?: unknown};
   const actualName = await owner.storage.getFileName(tree.id, file.id);
   await save("rename_partial_tracking", {committed, actualName, errorName: error?.name, message:error?.message, backupTargets: error?.backupTargets ?? null});
   expect(actualName).toBe("committed-rename.txt");
   expect(error.name).toBe("MutationPartialError");
   expect(error.backupTargets).toEqual([{ treeId: tree.id, fileId: file.id, metadataEventId: expect.any(String) }]);
 }, 120000);

 it("does not restore access after concurrent removal", async () => {
   const tree = await vault("Audit second reconciliation race");
   const owner2User = await loginNewDevice(owner.user);
   const owner2 = await openStorage(owner2User);
   await owner2.keySafe.restore(owner.recoveryKey);
   const originalMembers = owner.storage.listMembers.bind(owner.storage);
   let parentReads = 0;
   
   let unshareResult: unknown;
   
   const spy = vi.spyOn(owner.storage, "listMembers").mockImplementation(async (space, options) => {
     const snapshot = await originalMembers(space, options);
     if (space.id === tree.id && ++parentReads === 1) {
       unshareResult = await core.unshareVault(owner2, tree.id, reader.user.userId);

     }
     return snapshot;
   });
   let child;
   try { child = await core.createSubfolder(owner.storage, tree.id, "Raced child"); }
   finally { spy.mockRestore(); }
   rooms.push({storage: owner.storage, id:child.id});
   const parentMembership = await owner.storage.getRoomMembership(tree.id, reader.user.userId);
   const childMembership = await owner.storage.getRoomMembership(child.id, reader.user.userId);
   await save("child_ban_race", {parentReads, unshareResult, parentMembership, childMembership});
   expect(parentMembership).toBe("ban");
   expect(childMembership).toBe("ban");
   await core.unshareVault(owner2, tree.id, reader.user.userId);
   const absent = "@absent:localhost:8008";
   await core.unshareVault(owner2, tree.id, absent);
   expect(await owner2.getRoomMembership(tree.id, absent)).toBe("ban");
   expect(await owner2.getRoomMembership(child.id, absent)).toBe("ban");
   await core.shareVault(owner2, tree.id, reader.user.userId, "viewer");
   expect(await owner2.getRoomMembership(tree.id, reader.user.userId)).toBe("invite");
   expect(await owner2.getRoomMembership(child.id, reader.user.userId)).toBe("invite");
   await core.joinVault(reader.storage, tree.id);
   const sharedAgain = await upload(owner.storage, child.id, "reshared.txt", "explicit access restored");
   expect(new TextDecoder().decode((await core.downloadFile(reader.storage, child.id, sharedAgain.id)).bytes)).toBe("explicit access restored");
 },120000);
});
