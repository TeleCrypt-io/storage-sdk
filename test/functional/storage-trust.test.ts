import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MatrixEvent } from "matrix-js-sdk";
import { encryptAttachment } from "matrix-encrypt-attachment";
import { writeFile } from "node:fs/promises";
import { TeleCryptIOStorage } from "../../src/TeleCryptIOStorage.js";
import * as core from "../../src/core/operations.js";
import { registerTestUser, loginNewDevice } from "../harness/users.js";
import { waitFor } from "../harness/waitFor.js";

const output = "/home/ubuntu/harness.git/artifacts/storage-trust/phase1/native-final-results.json";
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
  await writeFile(output, JSON.stringify(findings, null, 2) + "\n", { mode: 0o600 });
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

async function waitForDecryption(storage: TeleCryptIOStorage, raw: object, success: boolean) {
  return waitFor(async () => {
    const result = await decrypt(storage, raw);
    return result.success === success ? result : null;
  }, { label: `event decryption success=${success}`, timeoutMs: 15000 });
}

beforeAll(async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const response = await nativeFetch(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
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

describe("Matrix device trust and Storage metadata authorship", () => {
  it("rejects a substituted outer sender and preserves owner multi-device history", async () => {
    const tree = await vault("Authenticated metadata binding");
    const otherTree = await core.createVault(owner.storage, "Cross-room binding");
    rooms.push({ storage: owner.storage, id: otherTree.id });
    const before = await upload(owner.storage, tree.id, "before.txt", "historical owner content");
    await owner.storage.waitForKeyBackup(tree.id, before.id);
    const ownerClient = owner.storage.getClient();
    const readerClient = reader.storage.getClient();

    // The fixture creates a real second Matrix login and signs it with this
    // account's recovered cross-signing identity.
    const secondOwnerUser = await loginNewDevice(owner.user);
    const secondOwner = await openStorage(secondOwnerUser);
    await secondOwner.keySafe.restore(owner.recoveryKey);
    await waitFor(async () => {
      const trust = await ownerClient.getCrypto()!.getDeviceVerificationStatus(owner.user.userId, secondOwnerUser.deviceId);
      return trust?.signedByOwner ?? false;
    }, { label: "second owner login signed by owner identity", timeoutMs: 20000 });
    const recovered = await core.downloadFile(secondOwner, tree.id, before.id);
    expect(new TextDecoder().decode(recovered.bytes)).toBe("historical owner content");

    // A message from that legitimate owner device remains valid as the name
    // metadata event, including when the pointer is authored by the first.
    const multiDeviceMessage = await secondOwner.getClient().sendMessage(tree.id, {
      msgtype: "io.telecrypt.storage.metadata",
      body: "owner second device name",
    } as never);
    await ownerClient.sendStateEvent(
      tree.id,
      "io.telecrypt.storage.metadata" as never,
      { event_id: multiDeviceMessage.event_id } as never,
      "",
    );
    expect(await owner.storage.getTreeName(tree.id)).toBe("owner second device name");

    const warm = await readerClient.sendMessage(tree.id, {
      msgtype: "io.telecrypt.storage.metadata",
      body: "warm reader sender session",
    } as never);
    await waitFor(async () => {
      const raw = await ownerClient.fetchRoomEvent(tree.id, warm.event_id);
      return (await decrypt(owner.storage, raw)).success;
    }, { label: "owner receives real reader encryption session" });
    await holdOwnerSync(tree.id);
    try {
      const sent = await readerClient.sendMessage(tree.id, {
        msgtype: "io.telecrypt.storage.metadata",
        body: "attacker-controlled-name",
      } as never);
      const genuine = await readerClient.fetchRoomEvent(tree.id, sent.event_id);
      const forgedId = `$trust_sender_${Date.now()}`;
      const forged = { ...genuine, event_id: forgedId, sender: owner.user.userId };
      const nativeRead = ownerClient.fetchRoomEvent.bind(ownerClient);
      const read = vi.spyOn(ownerClient, "fetchRoomEvent").mockImplementation(async (roomId, eventId) =>
        eventId === forgedId ? structuredClone(forged) : nativeRead(roomId, eventId));
      await ownerClient.sendStateEvent(
        tree.id,
        "io.telecrypt.storage.metadata" as never,
        { event_id: forgedId } as never,
        "",
      );
      let result: string | undefined;
      let error: string | undefined;
      try { result = await owner.storage.getTreeName(tree.id); }
      catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
      read.mockRestore();
      await save("outer_sender_substitution", {
        accepted: result === "attacker-controlled-name",
        returnedName: result,
        error,
        model: "real reader Megolm ciphertext; controlled server changes outer sender to owner; owner-authored pointer selects the synthetic event",
      });
      expect(result).not.toBe("attacker-controlled-name");
      expect(result).toBe("Encrypted storage");
      expect(error).toBeUndefined();

      await ownerClient.sendStateEvent(
        tree.id,
        "io.telecrypt.storage.metadata" as never,
        { event_id: multiDeviceMessage.event_id } as never,
        "",
      );
      expect(await owner.storage.getTreeName(tree.id)).toBe("owner second device name");

      const crossId = `$trust_cross_room_${Date.now()}`;
      const cross = { ...genuine, event_id: crossId, sender: owner.user.userId, room_id: otherTree.id };
      const readCross = vi.spyOn(ownerClient, "fetchRoomEvent").mockImplementation(async (roomId, eventId) =>
        eventId === crossId ? structuredClone(cross) : nativeRead(roomId, eventId));
      await ownerClient.sendStateEvent(
        otherTree.id,
        "io.telecrypt.storage.metadata" as never,
        { event_id: crossId } as never,
        "",
      );
      let crossName: string | undefined;
      let crossError: string | undefined;
      try { crossName = await owner.storage.getTreeName(otherTree.id); }
      catch (cause) { crossError = cause instanceof Error ? cause.message : String(cause); }
      readCross.mockRestore();
      await save("cross_room_substitution", { accepted: crossName === "attacker-controlled-name", returnedName: crossName, error: crossError });
      expect(crossName).not.toBe("attacker-controlled-name");
    } finally {
      resumeOwnerSync();
      await owner.storage.getTree(tree.id)?.setName("Authenticated metadata binding restored");
    }
  }, 180000);

  it("excludes an unsigned recipient device until its owner restores and signs it", async () => {
    const tree = await vault("Signed recipient device");
    const unsignedUser = await loginNewDevice(reader.user);
    const unsigned = await openStorage(unsignedUser);
    const ownerCrypto = owner.storage.getClient().getCrypto()!;
    const establishedReaderTrust = await waitFor(async () => {
      const identity = await ownerCrypto.getUserVerificationStatus(reader.user.userId);
      const device = await ownerCrypto.getDeviceVerificationStatus(reader.user.userId, reader.user.deviceId);
      return device?.signedByOwner && !identity.isCrossSigningVerified()
        ? { identity, device }
        : null;
    }, { label: "reader device is self-signed without owner verification", timeoutMs: 20000 });
    expect(establishedReaderTrust.device.signedByOwner).toBe(true);
    expect(establishedReaderTrust.device.crossSigningVerified).toBe(false);
    expect(establishedReaderTrust.identity.isCrossSigningVerified()).toBe(false);

    await waitFor(async () => {
      const info = await ownerCrypto.getUserDeviceInfo([reader.user.userId]);
      return info.get(reader.user.userId)?.has(unsignedUser.deviceId) ?? false;
    }, { label: "owner discovers new reader device", timeoutMs: 20000 });
    const trustBefore = await ownerCrypto.getDeviceVerificationStatus(reader.user.userId, unsignedUser.deviceId);
    expect(trustBefore?.signedByOwner).toBe(false);

    const unsignedFuture = await upload(owner.storage, tree.id, "unsigned.txt", "not sent to unsigned devices");
    expect(new TextDecoder().decode((await core.downloadFile(reader.storage, tree.id, unsignedFuture.id)).bytes))
      .toBe("not sent to unsigned devices");
    const unsignedRaw = await owner.storage.getClient().fetchRoomEvent(tree.id, unsignedFuture.id);
    const unsignedResult = await waitForDecryption(unsigned, unsignedRaw, false);
    await save("unsigned_recipient_future_keys", {
      signedByOwnerBeforeRestore: trustBefore?.signedByOwner,
      futureDescriptorDecrypts: unsignedResult.success,
      decryptionFailure: unsignedResult.error,
    });
    expect(unsignedResult.success).toBe(false);

    const restore = await unsigned.keySafe.restore(reader.recoveryKey);
    expect(restore.state).toBe("ready");
    expect(restore.imported).toBeGreaterThan(0);
    await waitFor(async () => {
      const status = await ownerCrypto.getDeviceVerificationStatus(reader.user.userId, unsignedUser.deviceId);
      return status?.signedByOwner ?? false;
    }, { label: "reader's recovered device signed by reader identity", timeoutMs: 20000 });

    const restoredFuture = await upload(owner.storage, tree.id, "restored.txt", "available after device restore");
    const restoredRaw = await owner.storage.getClient().fetchRoomEvent(tree.id, restoredFuture.id);
    const restoredResult = await waitForDecryption(unsigned, restoredRaw, true);
    await save("restored_recipient_future_keys", {
      signedByOwnerAfterRestore: true,
      futureDescriptorDecrypts: restoredResult.success,
      body: restoredResult.body,
    });
    expect(restoredResult.success).toBe(true);
    expect(restoredResult.body).toBe("restored.txt");
  }, 180000);

  it("rotates future retained-handle writes after removal before sync catches up", async () => {
    const survivor = await storageUser("trust_followup_survivor");
    const tree = await vault("Removal and remaining reader", [reader, survivor]);
    const before = await upload(owner.storage, tree.id, "before.txt", "before removal");
    expect(new TextDecoder().decode((await core.downloadFile(reader.storage, tree.id, before.id)).bytes)).toBe("before removal");
    expect(new TextDecoder().decode((await core.downloadFile(survivor.storage, tree.id, before.id)).bytes)).toBe("before removal");

    const retainedTree = owner.storage.getTree(tree.id)!;
    const retainedFile = retainedTree.getFile(before.id)!;
    const ownerClient = owner.storage.getClient();
    const beforeRaw = await ownerClient.fetchRoomEvent(tree.id, before.id);
    await holdOwnerSync(tree.id);
    try {
      await core.unshareVault(owner.storage, tree.id, reader.user.userId);
      const serverMembership = await owner.storage.getRoomMembership(tree.id, reader.user.userId);
      const localMembership = ownerClient.getRoom(tree.id)?.getMember(reader.user.userId)?.membership;
      expect(serverMembership).toBe("leave");
      expect(localMembership).toBe("join");

      await retainedTree.setName("post-removal tree name");
      expect(await owner.storage.getTreeName(tree.id)).toBe("post-removal tree name");
      const treePointerEvent = ownerClient.getRoom(tree.id)!.currentState
        .getStateEvents("io.telecrypt.storage.metadata", "") as MatrixEvent;
      const treePointer = treePointerEvent.getContent() as { event_id: string };
      const treeNameRaw = await ownerClient.fetchRoomEvent(tree.id, treePointer.event_id);

      await retainedFile.setName("post-removal renamed file.txt");
      expect(await owner.storage.getFileName(tree.id, before.id)).toBe("post-removal renamed file.txt");
      const fileMetadataId = await owner.storage.getFileMetadataEventId(tree.id, before.id);
      expect(fileMetadataId).toBeTruthy();
      const fileNameRaw = await ownerClient.fetchRoomEvent(tree.id, fileMetadataId!);

      const encrypted = await encryptAttachment(new TextEncoder().encode("future file after removal"));
      const created = await retainedTree.createFile(
        "post-removal upload.txt",
        new Uint8Array(encrypted.data),
        encrypted.info as unknown as Record<string, unknown>,
        { info: { mimetype: "text/plain", size: "future file after removal".length } },
      );
      files.push({ storage: owner.storage, room: tree.id, id: created.event_id });
      const uploadRaw = await ownerClient.fetchRoomEvent(tree.id, created.event_id);

      const survivorTreeName = await waitForDecryption(survivor.storage, treeNameRaw, true);
      const survivorFileName = await waitForDecryption(survivor.storage, fileNameRaw, true);
      const survivorUpload = await waitForDecryption(survivor.storage, uploadRaw, true);
      const removedTreeName = await decrypt(reader.storage, treeNameRaw);
      const removedFileName = await decrypt(reader.storage, fileNameRaw);
      const removedUpload = await decrypt(reader.storage, uploadRaw);

      const after = [treeNameRaw, fileNameRaw, uploadRaw].map((raw) => {
        const event = raw as { content?: { session_id?: string } };
        return event.content?.session_id;
      });
      await save("revocation_retained_handles_before_sync", {
        serverMembership,
        localMembershipBeforeWrites: localMembership,
        preRemovalSession: beforeRaw.content.session_id,
        postRemovalSessions: after,
        removedRecipient: [removedTreeName, removedFileName, removedUpload],
        remainingRecipient: [survivorTreeName, survivorFileName, survivorUpload],
        model: "honest server; removed reader is given captured post-removal ciphertext directly; existing tree and file handles are retained across kick while owner /sync is held",
      });
      expect(after.every((session) => typeof session === "string" && session !== beforeRaw.content.session_id)).toBe(true);
      expect(removedTreeName.success).toBe(false);
      expect(removedFileName.success).toBe(false);
      expect(removedUpload.success).toBe(false);
      expect(survivorTreeName.success).toBe(true);
      expect(survivorFileName.success).toBe(true);
      expect(survivorUpload.success).toBe(true);
      const survivorDownload = await core.downloadFile(survivor.storage, tree.id, created.event_id);
      expect(new TextDecoder().decode(survivorDownload.bytes)).toBe("future file after removal");
      findings.revocation_retained_handles_before_sync = {
        ...(findings.revocation_retained_handles_before_sync as Record<string, unknown>),
        remainingRecipientDownloadedUpload: new TextDecoder().decode(survivorDownload.bytes),
      };
      await writeFile(output, JSON.stringify(findings, null, 2) + "\n", { mode: 0o600 });
    } finally {
      resumeOwnerSync();
    }
  }, 180000);
});
