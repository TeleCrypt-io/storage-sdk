import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MatrixEvent } from "matrix-js-sdk";
import { MatrixScheduler } from "matrix-js-sdk/lib/scheduler.js";
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
let holdRequest: ((url: string) => Promise<void> | undefined) | undefined;
let blockedBackupToken: string | undefined;
let failCleanupRoom: string | undefined;
afterEach(() => { blockedBackupToken = undefined; failEventId = undefined; failCleanupRoom = undefined; });

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
    await holdRequest?.(url);
    if (failCleanupRoom && url.includes(`/rooms/${encodeURIComponent(failCleanupRoom)}/leave`)) {
      return new Response(JSON.stringify({ errcode: "M_UNKNOWN", error: "controlled cleanup failure" }),
        { status: 503, headers: { "content-type": "application/json" } });
    }
    const requestHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (blockedBackupToken && requestHeaders.get("authorization") === `Bearer ${blockedBackupToken}` &&
        (init?.method ?? "GET") === "PUT" && url.includes("/room_keys/keys")) {
      return new Response(JSON.stringify({ errcode: "M_UNKNOWN", error: "controlled backup outage" }),
        { status: 503, headers: { "content-type": "application/json" } });
    }
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
 it("settles an initial creation name without a pointer after cleanup failure and reload", async () => {
   const creator = await storageUser("creation_no_pointer");
   const client = creator.storage.getClient();
   const sendState = client.sendStateEvent.bind(client);
   let roomId: string | undefined;
   let pointerAttempts = 0;
   const spy = vi.spyOn(client, "sendStateEvent").mockImplementation(async (...args) => {
     if (args[1] === "io.telecrypt.storage.metadata") {
       pointerAttempts++;
       roomId = args[0];
       failCleanupRoom = roomId;
       throw new Error("controlled initial pointer failure");
     }
     return await sendState(...args);
   });
   let restored: TeleCryptIOStorage | undefined;
   try {
     blockedBackupToken = creator.user.accessToken;
     const error = await core.createVault(creator.storage, "unlinked creation").then(() => null, (e: unknown) => e);
     expect(error).toBeInstanceOf(MutationPartialError);
     const target = (error as MutationPartialError).backupTargets[0]!;
     expect(target).toMatchObject({ treeId: roomId, metadataEventId: expect.any(String) });
     const raw = await client.fetchRoomEvent(target.treeId, target.metadataEventId!);
     await expect(creator.storage.waitForKeyBackup(target.treeId, undefined, { metadataEventId: target.metadataEventId, timeoutMs: 2000 })).rejects.toThrow();
     blockedBackupToken = undefined;
     expect(await creator.storage.waitForKeyBackup(target.treeId, undefined, { metadataEventId: target.metadataEventId })).toBe("backed_up");
     expect(pointerAttempts).toBe(1);
     client.stopClient();
     restored = await openStorage(await loginNewDevice(creator.user));
     await restored.keySafe.restore(creator.recoveryKey);
     expect((await decrypt(restored, raw)).body).toBe("unlinked creation");
   } finally {
     spy.mockRestore(); blockedBackupToken = undefined; failCleanupRoom = undefined;
     if (roomId) {
       const cleanupClient = restored?.getClient() ?? client;
       await cleanupClient.leave(roomId); await cleanupClient.forget(roomId);
     }
   }
 }, 120000);
 it.each(["failure", "success"])("retains a post-pointer creation receipt when cleanup is %s", async (cleanup) => {
   const client = owner.storage.getClient();
   const sendState = client.sendStateEvent.bind(client);
   const controller = new AbortController();
   let roomId: string | undefined;
   const spy = vi.spyOn(client, "sendStateEvent").mockImplementation(async (...args) => {
     const result = await sendState(...args);
     if (args[1] === "io.telecrypt.storage.metadata") {
       roomId = args[0];
       if (cleanup === "failure") failCleanupRoom = roomId;
       controller.abort();
     }
     return result;
   });
   try {
     if (cleanup === "failure") blockedBackupToken = owner.user.accessToken;
     const error = await core.createVault(owner.storage, "post-pointer", { signal: controller.signal }).then(() => null, (e: unknown) => e);
     expect(error).toBeInstanceOf(MutationPartialError);
     const partial = error as MutationPartialError;
     expect(partial.completedIds).toContain(roomId);
     if (cleanup === "failure") {
       const target = partial.backupTargets[0]!;
       expect(target).toMatchObject({ treeId: roomId, metadataEventId: expect.any(String) });
       await expect(owner.storage.waitForKeyBackup(target.treeId, undefined, { metadataEventId: target.metadataEventId, timeoutMs: 2000 })).rejects.toThrow();
       blockedBackupToken = undefined;
       expect(await owner.storage.waitForKeyBackup(target.treeId, undefined, { metadataEventId: target.metadataEventId })).toBe("backed_up");
     } else expect(partial.backupTargets).toEqual([]);
   } finally {
     spy.mockRestore(); failCleanupRoom = undefined;
     if (roomId && cleanup === "failure") { await client.leave(roomId); await client.forget(roomId); }
   }
 }, 120000);
 it("retains a folder name receipt when link creation and room cleanup fail", async () => {
   const parent = await vault("Folder receipt parent", []);
   const client = owner.storage.getClient();
   const sendState = client.sendStateEvent.bind(client);
   let roomId: string | undefined;
   const spy = vi.spyOn(client, "sendStateEvent").mockImplementation(async (...args) => {
     if (args[0] === parent.id && args[1] === "m.space.child") {
       roomId = args[3] as string;
       failCleanupRoom = roomId;
       throw new Error("controlled link failure");
     }
     return await sendState(...args);
   });
   try {
     blockedBackupToken = owner.user.accessToken;
     const error = await core.createSubfolder(owner.storage, parent.id, "folder receipt").then(() => null, (e: unknown) => e);
     expect(error).toBeInstanceOf(MutationPartialError);
     const target = (error as MutationPartialError).backupTargets[0]!;
     expect(target).toMatchObject({ treeId: roomId, metadataEventId: expect.any(String) });
     await expect(owner.storage.waitForKeyBackup(target.treeId, undefined, { metadataEventId: target.metadataEventId, timeoutMs: 2000 })).rejects.toThrow();
     blockedBackupToken = undefined;
     expect(await owner.storage.waitForKeyBackup(target.treeId, undefined, { metadataEventId: target.metadataEventId })).toBe("backed_up");
   } finally {
     spy.mockRestore(); failCleanupRoom = undefined;
     if (roomId) { await client.leave(roomId); await client.forget(roomId); }
   }
 }, 120000);
 it.each(["failure", "success"])("retains a late creation acknowledgement through cleanup %s", async (cleanup) => {
   const client = owner.storage.getClient();
   const send = client.sendMessage.bind(client);
   let release!: () => void;
   let acknowledged!: () => void;
   let roomId: string | undefined;
   const gate = new Promise<void>((resolve) => { release = resolve; });
   const ready = new Promise<void>((resolve) => { acknowledged = resolve; });
   const sendSpy = vi.spyOn(client, "sendMessage").mockImplementation(async (...args) => {
     const result = await send(...args);
     if (typeof args[1] === "object" && args[1]?.body === "late-create") {
       roomId = args[0];
       if (cleanup === "failure") failCleanupRoom = roomId;
       acknowledged(); await gate;
     }
     return result;
   });
   const controller = new AbortController();
   const pending = core.createVault(owner.storage, "late-create", { signal: controller.signal })
     .then(() => null, (error: unknown) => error);
   try {
     await ready;
     controller.abort();
     release();
     const error = await pending;
     expect(error).toBeInstanceOf(MutationPartialError);
     expect((error as MutationPartialError).completedIds).toContain(roomId);
     if (cleanup === "failure") {
       expect((error as MutationPartialError).backupTargets[0]).toMatchObject({ treeId: roomId, metadataEventId: expect.any(String) });
       expect((error as Error).cause).toBeInstanceOf(AggregateError);
     } else {
       expect((error as MutationPartialError).backupTargets).toEqual([]);
     }
   } finally {
     release(); sendSpy.mockRestore(); failCleanupRoom = undefined;
     if (roomId && cleanup === "failure") { await client.leave(roomId); await client.forget(roomId); }
   }
 }, 120000);
 it.each(["vault", "folder"])("settles cancelled %s creation through encryption and cleanup", async (kind) => {
   const parent = kind === "folder" ? await vault("Creation parent", []) : undefined;
   const client = owner.storage.getClient();
   const backend = (client as unknown as { cryptoBackend: { encryptEvent: (event: MatrixEvent, room: unknown) => Promise<void> } }).cryptoBackend;
   const encrypt = backend.encryptEvent.bind(backend);
   let releaseEncryption!: () => void;
   let releaseCleanup!: () => void;
   let encryptionStarted!: () => void;
   let cleanupStarted!: () => void;
   const encryptionGate = new Promise<void>((resolve) => { releaseEncryption = resolve; });
   const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
   const encryptionReady = new Promise<void>((resolve) => { encryptionStarted = resolve; });
   const cleanupReady = new Promise<void>((resolve) => { cleanupStarted = resolve; });
   const encryptionSpy = vi.spyOn(backend, "encryptEvent").mockImplementation(async (event, room) => {
     if (event.getContent().body === "cancelled-creation") { encryptionStarted(); await encryptionGate; }
     await encrypt(event, room);
   });
   holdRequest = (url) => url.endsWith("/leave") ? (cleanupStarted(), cleanupGate) : undefined;
   const controller = new AbortController();
   let settled = false;
   const operation = kind === "vault"
     ? core.createVault(owner.storage, "cancelled-creation", { signal: controller.signal })
     : core.createSubfolder(owner.storage, parent!.id, "cancelled-creation", { signal: controller.signal });
   const pending = operation.then(() => null, (error: unknown) => error).finally(() => { settled = true; });
   try {
     await encryptionReady;
     controller.abort();
     await new Promise((resolve) => setTimeout(resolve, 100));
     expect(settled).toBe(false);
     releaseEncryption();
     await cleanupReady;
     expect(settled).toBe(false);
     releaseCleanup();
     expect(await pending).toBeInstanceOf(Error);
   } finally { releaseEncryption(); releaseCleanup(); holdRequest = undefined; encryptionSpy.mockRestore(); }
 }, 120000);
 it.each(["partial", "success"])("backs up the first exact %s rename session after another device replaces the pointer", async (outcome) => {
   const tree = await vault("Concurrent rename sessions", []);
   const file = await upload(owner.storage, tree.id, "before.txt", "contents");
   await owner.storage.waitForKeyBackup(tree.id, file.id);
   const secondUser = await loginNewDevice(owner.user);
   const second = await openStorage(secondUser);
   await second.keySafe.restore(owner.recoveryKey);
   const client = second.getClient();
   const sendState = client.sendStateEvent.bind(client);
   const spy = vi.spyOn(client, "sendStateEvent").mockImplementation(async (...args) => {
     const result = await sendState(...args);
     if (outcome === "partial" && args[0] === tree.id && args[3] === file.id) failEventId = file.id;
     return result;
   });
   blockedBackupToken = secondUser.accessToken;
   let firstResult: unknown;
   try {
     firstResult = await core.renameFile(second, tree.id, file.id, "first-rename.txt").then((result) => result, (error: unknown) => error);
   } finally { spy.mockRestore(); failEventId = undefined; }
   if (outcome === "partial" && !(firstResult instanceof MutationPartialError)) throw firstResult ?? new Error("rename unexpectedly succeeded");
   if (outcome === "success" && firstResult instanceof Error) throw firstResult;
   const target = outcome === "partial"
     ? (firstResult as MutationPartialError).backupTargets[0]!
     : (firstResult as { backupTarget: { treeId: string; fileId: string; metadataEventId: string } }).backupTarget;
   expect(target.metadataEventId).toBeTruthy();
   const firstRaw = await client.fetchRoomEvent(tree.id, target.metadataEventId!);
   const firstSession = firstRaw.content.session_id as string;
   const headers = { Authorization: `Bearer ${secondUser.accessToken}` };
   const versionResponse = await nativeFetch(`http://localhost:8008/_matrix/client/v3/room_keys/version`, { headers });
   const version = (await versionResponse.json() as { version: string }).version;
   const backupUrl = `http://localhost:8008/_matrix/client/v3/room_keys/keys/${encodeURIComponent(tree.id)}/${encodeURIComponent(firstSession)}?version=${encodeURIComponent(version)}`;
   expect((await nativeFetch(backupUrl, { headers })).status).toBe(404);
   await core.renameFile(owner.storage, tree.id, file.id, "second-rename.txt");
   const secondId = await owner.storage.getFileMetadataEventId(tree.id, file.id);
   const secondRaw = await owner.storage.getClient().fetchRoomEvent(tree.id, secondId!);
   expect(secondRaw.content.session_id).not.toBe(firstSession);
   blockedBackupToken = undefined;
   expect(await second.waitForKeyBackup(tree.id, file.id, { metadataEventId: target.metadataEventId })).toBe("backed_up");
   expect((await nativeFetch(backupUrl, { headers })).status).toBe(200);
   client.stopClient();
   const reloaded = await openStorage(await loginNewDevice(owner.user));
   await reloaded.keySafe.restore(owner.recoveryKey);
   expect((await decrypt(reloaded, firstRaw)).body).toBe("first-rename.txt");
 }, 120000);
 it("settles a cancelled native queued send without cancelling the unrelated send ahead of it", async () => {
   const tree = await vault("Queued cancellation", []);
   const other = await vault("Queue predecessor", []);
   const file = await upload(owner.storage, tree.id, "before.txt", "contents");
   const client = owner.storage.getClient();
   const internal = client as unknown as { scheduler?: MatrixScheduler; sendEventHttpRequest: (event: MatrixEvent) => Promise<{ event_id: string }> };
   const previous = internal.scheduler;
   const scheduler = new MatrixScheduler(() => -1);
   const queueEvent = scheduler.queueEvent.bind(scheduler);
   let queueCount = 0;
   vi.spyOn(scheduler, "queueEvent").mockImplementation((event) => {
     const result = queueEvent(event);
     queueCount++;
     return result;
   });
   scheduler.setProcessFunction(async (event) => {
     const result = await internal.sendEventHttpRequest(event);
     client.getRoom(event.getRoomId()!)?.updatePendingEvent(event, "sent" as never, result.event_id);
     return result;
   });
   internal.scheduler = scheduler;
   let release!: () => void;
   let reached!: () => void;
   const gate = new Promise<void>((resolve) => { release = resolve; });
   const ready = new Promise<void>((resolve) => { reached = resolve; });
   const txn = client.makeTxnId();
   holdRequest = (url) => url.endsWith(`/${encodeURIComponent(txn)}`) ? (reached(), gate) : undefined;
   let firstSettled = false;
   const first = client.sendMessage(other.id, { msgtype: "m.text", body: "unrelated queue predecessor" } as never, txn)
     .finally(() => { firstSettled = true; });
   const controller = new AbortController();
   let settled = false;
   let pending: Promise<unknown> | undefined;
   try {
     await ready;
     pending = core.renameFile(owner.storage, tree.id, file.id, "queued-name.txt", { signal: controller.signal })
       .then(() => null, (error: unknown) => error).finally(() => { settled = true; });
     await waitFor(() => queueCount >= 2, { label: "rename waits in native send queue", timeoutMs: 15000 });
     controller.abort();
     expect(await pending).toBeInstanceOf(MutationOutcomeUnknownError);
     expect(settled).toBe(true);
     expect(firstSettled).toBe(false);
     release();
     expect((await first).event_id).toBeTruthy();
     expect(await owner.storage.getFileName(tree.id, file.id)).toBe("before.txt");
   } finally {
     release();
     holdRequest = undefined;
     controller.abort();
     if (pending) await pending;
     internal.scheduler = previous;
   }
 }, 120000);
 it("waits for native encryption after cancellation without aborting an unrelated send", async () => {
   const tree = await vault("Encryption cancellation", []);
   const other = await vault("Unrelated send", []);
   const file = await upload(owner.storage, tree.id, "before.txt", "contents");
   const client = owner.storage.getClient();
   const backend = (client as unknown as { cryptoBackend: { encryptEvent: (event: MatrixEvent, room: unknown) => Promise<void> } }).cryptoBackend;
   const encrypt = backend.encryptEvent.bind(backend);
   let release!: () => void;
   let reached!: () => void;
   const gate = new Promise<void>((resolve) => { release = resolve; });
   const ready = new Promise<void>((resolve) => { reached = resolve; });
   const spy = vi.spyOn(backend, "encryptEvent").mockImplementation(async (event, room) => {
     if (event.getContent().body === "encryption-gated.txt") { reached(); await gate; }
     await encrypt(event, room);
   });
   const controller = new AbortController();
   let settled = false;
   const pending = core.renameFile(owner.storage, tree.id, file.id, "encryption-gated.txt", { signal: controller.signal })
     .then(() => null, (error: unknown) => error).finally(() => { settled = true; });
   try {
     await ready;
     controller.abort();
     await new Promise((resolve) => setTimeout(resolve, 100));
     expect(settled).toBe(false);
     const unrelated = await core.uploadFile(owner.storage, other.id, "unrelated.txt", new TextEncoder().encode("unrelated"), "text/plain");
     files.push({ storage: owner.storage, room: other.id, id: unrelated.id });
     release();
     expect(await pending).toBeInstanceOf(MutationOutcomeUnknownError);
     expect(await owner.storage.getFileName(tree.id, file.id)).toBe("before.txt");
   } finally { release(); spy.mockRestore(); }
 }, 120000);

 it("keeps a late native acknowledgement after cancellation", async () => {
   const tree = await vault("Late acknowledgement", []);
   const file = await upload(owner.storage, tree.id, "before.txt", "contents");
   const client = owner.storage.getClient();
   const send = client.sendMessage.bind(client);
   let release!: () => void;
   let acknowledged!: () => void;
   const gate = new Promise<void>((resolve) => { release = resolve; });
   const ready = new Promise<void>((resolve) => { acknowledged = resolve; });
   const spy = vi.spyOn(client, "sendMessage").mockImplementation(async (...args) => {
     const result = await send(...args);
     if (typeof args[1] === "object" && args[1]?.body === "late-ack.txt") { acknowledged(); await gate; }
     return result;
   });
   const controller = new AbortController();
   let settled = false;
   const pending = core.renameFile(owner.storage, tree.id, file.id, "late-ack.txt", { signal: controller.signal })
     .then(() => null, (error: unknown) => error).finally(() => { settled = true; });
   try {
     await ready;
     controller.abort();
     await new Promise((resolve) => setTimeout(resolve, 100));
     expect(settled).toBe(false);
     release();
     const error = await pending;
     expect(error).toBeInstanceOf(MutationPartialError);
     const target = (error as MutationPartialError).backupTargets[0]!;
     expect(target.metadataEventId).toBeTruthy();
     expect(await owner.storage.waitForKeyBackup(tree.id, file.id, { metadataEventId: target.metadataEventId })).toBe("backed_up");
   } finally { release(); spy.mockRestore(); }
 }, 120000);
 it("retains a tree rename receipt after cancellation following its pointer acknowledgement", async () => {
   const tree = await vault("Before cancelled rename", []);
   const controller = new AbortController();
   const client = owner.storage.getClient();
   const sendState = client.sendStateEvent.bind(client);
   const spy = vi.spyOn(client, "sendStateEvent").mockImplementation(async (...args) => {
     const result = await sendState(...args);
     if (args[0] === tree.id && args[1] === "io.telecrypt.storage.metadata") controller.abort();
     return result;
   });
   try {
     const error = await core.renameVault(owner.storage, tree.id, "Accepted rename", { signal: controller.signal })
       .then(() => null, (failure: unknown) => failure);
     expect(error).toBeInstanceOf(MutationPartialError);
     expect((error as MutationPartialError).backupTargets).toEqual([{ treeId: tree.id, metadataEventId: expect.any(String) }]);
     expect(await owner.storage.waitForKeyBackup(tree.id)).toBe("backed_up");
   } finally { spy.mockRestore(); }
 }, 120000);
 it.each(["metadata", "listing", "readback", "verification"])("bounds stalled rename %s requests", async (stage) => {
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
   let readsAfterListing = 0;
   stallRequest = (url, method) => stage === "metadata"
     ? method === "PUT" && url.includes("/send/m.room.encrypted/")
     : stage === "listing"
       ? method === "PUT" && url.includes("/state/") && url.includes(encodeURIComponent(file.id))
       : listingAccepted && method === "GET" && url.includes(`/event/${encodeURIComponent(file.id)}`) &&
         ++readsAfterListing >= (stage === "verification" ? 2 : 1);
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
