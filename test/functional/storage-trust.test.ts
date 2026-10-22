import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MatrixEvent } from "matrix-js-sdk";
import {
  AllDevicesIsolationMode,
  EventShieldColour,
  EventShieldReason,
  OnlySignedDevicesIsolationMode,
} from "matrix-js-sdk/lib/crypto-api/index.js";
import { encryptAttachment } from "matrix-encrypt-attachment";
import { writeFile } from "node:fs/promises";
import { TeleCryptIOStorage } from "../../src/TeleCryptIOStorage.js";
import * as core from "../../src/core/operations.js";
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
type ToDeviceRecipient = { userId: string; deviceId: string };
type ToDeviceRequestCapture = { eventType: string; recipients: ToDeviceRecipient[]; status: number };
let recipientCapture: { accessToken: string; requests: ToDeviceRequestCapture[] } | undefined;

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

async function captureToDeviceRecipients<T>(accessToken: string, action: () => Promise<T>) {
  if (recipientCapture) throw new Error("to-device recipient capture is already active");
  const capture = { accessToken, requests: [] as ToDeviceRequestCapture[] };
  recipientCapture = capture;
  try {
    const result = await action();
    return { result, requests: capture.requests };
  } finally {
    recipientCapture = undefined;
  }
}

function recipientsFor(requests: ToDeviceRequestCapture[], userId: string): Set<string> {
  return new Set(requests.flatMap((request) => request.recipients
    .filter((recipient) => recipient.userId === userId)
    .map((recipient) => recipient.deviceId)));
}

async function encryptionInfo(storage: TeleCryptIOStorage, raw: object) {
  const event = new MatrixEvent(structuredClone(raw) as never);
  await storage.getClient().decryptEventIfNeeded(event);
  const info = await storage.getClient().getCrypto()!.getEncryptionInfoForEvent(event);
  return {
    decrypted: !event.isDecryptionFailure(),
    body: event.getContent().body,
    failure: event.decryptionFailureReason,
    shieldColour: info ? EventShieldColour[info.shieldColour] : null,
    shieldReason: info?.shieldReason === null || info?.shieldReason === undefined
      ? null
      : EventShieldReason[info.shieldReason],
  };
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

async function waitForDecryptionFailure(storage: TeleCryptIOStorage, raw: object, reason: string) {
  return waitFor(async () => {
    const result = await decrypt(storage, raw);
    return !result.success && result.error === reason ? result : null;
  }, { label: `event decryption failure=${reason}`, timeoutMs: 15000 });
}

beforeAll(async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const token = headers.get("authorization")?.replace(/^Bearer /i, "");
    const activeCapture = recipientCapture;
    const pathname = new URL(url).pathname;
    const toDevice = pathname.match(/\/sendToDevice\/([^/]+)\//);
    let recipients: ToDeviceRecipient[] | undefined;
    if (activeCapture && token === activeCapture.accessToken && toDevice) {
      const body = typeof init?.body === "string"
        ? init.body
        : input instanceof Request
          ? await input.clone().text()
          : undefined;
      const payload = body ? JSON.parse(body) as { messages?: Record<string, Record<string, unknown>> } : undefined;
      recipients = Object.entries(payload?.messages ?? {}).flatMap(([userId, devices]) =>
        Object.keys(devices).map((deviceId) => ({ userId, deviceId })));
    }
    const response = await nativeFetch(input, init);
    if (activeCapture && recipients) {
      activeCapture.requests.push({
        eventType: decodeURIComponent(toDevice![1]!),
        recipients,
        status: response.status,
      });
    }
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
    const beforeRaw = await ownerClient.fetchRoomEvent(tree.id, before.id);
    const recoveredHistoryInfo = await encryptionInfo(secondOwner, beforeRaw);
    const ownerHistoryInfo = await encryptionInfo(owner.storage, beforeRaw);
    await save("recovered_history_encryption_info", { recoveredHistoryInfo, ownerHistoryInfo });
    expect(recoveredHistoryInfo.decrypted).toBe(true);
    expect(ownerHistoryInfo.decrypted).toBe(true);

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
    const multiDeviceRaw = await ownerClient.fetchRoomEvent(tree.id, multiDeviceMessage.event_id);
    const multiDeviceInfo = await encryptionInfo(owner.storage, multiDeviceRaw);
    await save("owner_multidevice_encryption_info", multiDeviceInfo);
    expect(multiDeviceInfo.decrypted).toBe(true);

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

      const ownerCrypto = ownerClient.getCrypto()!;
      ownerCrypto.setDeviceIsolationMode(new AllDevicesIsolationMode(false));
      const mismatchMessage = await readerClient.sendMessage(tree.id, {
        msgtype: "io.telecrypt.storage.metadata",
        body: "mismatched-sender-guard-probe",
      } as never);
      const mismatchGenuine = await readerClient.fetchRoomEvent(tree.id, mismatchMessage.event_id);
      const mismatchId = `$trust_mismatch_guard_${Date.now()}`;
      const mismatch = { ...mismatchGenuine, event_id: mismatchId, sender: owner.user.userId };
      const mismatchProbe = new MatrixEvent(structuredClone(mismatch) as never);
      await ownerClient.decryptEventIfNeeded(mismatchProbe);
      const mismatchInfo = await ownerCrypto.getEncryptionInfoForEvent(mismatchProbe);
      const readMismatch = vi.spyOn(ownerClient, "fetchRoomEvent").mockImplementation(async (roomId, eventId) =>
        eventId === mismatchId ? structuredClone(mismatch) : nativeRead(roomId, eventId));
      await ownerClient.sendStateEvent(
        tree.id,
        "io.telecrypt.storage.metadata" as never,
        { event_id: mismatchId } as never,
        "",
      );
      const mismatchName = await new TeleCryptIOStorage(ownerClient).getTreeName(tree.id);
      readMismatch.mockRestore();
      await save("mismatched_sender_guard", {
        cryptoDecryptionSucceeded: !mismatchProbe.isDecryptionFailure(),
        cryptoShieldColour: mismatchInfo ? EventShieldColour[mismatchInfo.shieldColour] : null,
        cryptoShieldReason: mismatchInfo?.shieldReason === null || mismatchInfo?.shieldReason === undefined
          ? null
          : EventShieldReason[mismatchInfo.shieldReason],
        sdkReturnedGenericName: mismatchName === "Encrypted storage",
      });
      expect(mismatchProbe.isDecryptionFailure()).toBe(false);
      expect(mismatchInfo?.shieldReason).toBe(EventShieldReason.MISMATCHED_SENDER);
      expect(mismatchName).toBe("Encrypted storage");
      ownerCrypto.setDeviceIsolationMode(new OnlySignedDevicesIsolationMode());

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
      owner.storage.getClient().getCrypto()?.setDeviceIsolationMode(new OnlySignedDevicesIsolationMode());
      resumeOwnerSync();
      await owner.storage.getTree(tree.id)?.setName("Authenticated metadata binding restored");
    }
  }, 180000);

  it("stops sending future keys to an old unsigned recipient after policy transition", async () => {
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

    const ownerClient = owner.storage.getClient();
    try {
      ownerCrypto.setDeviceIsolationMode(new AllDevicesIsolationMode(false));
      await ownerCrypto.forceDiscardSession(tree.id);
      const allDevicesWrite = await captureToDeviceRecipients(owner.user.accessToken, () =>
        upload(owner.storage, tree.id, "old-policy.txt", "old AllDevices session"));
      const allDevicesRaw = await ownerClient.fetchRoomEvent(tree.id, allDevicesWrite.result.id);
      const allDevicesSession = (allDevicesRaw as { content?: { session_id?: string } }).content?.session_id;
      const allDevicesRequests = allDevicesWrite.requests.filter((request) => request.eventType === "m.room.encrypted");
      const allDevicesRecipients = recipientsFor(allDevicesRequests, reader.user.userId);
      const allDevicesUnsigned = await waitForDecryption(unsigned, allDevicesRaw, true);
      const allDevicesSigned = await waitForDecryption(reader.storage, allDevicesRaw, true);

      ownerCrypto.setDeviceIsolationMode(new OnlySignedDevicesIsolationMode());
      const transitioned = await captureToDeviceRecipients(owner.user.accessToken, async () => {
        const treeSpace = owner.storage.getTree(tree.id)!;
        await treeSpace.setName("post-transition tree name");
        expect(await owner.storage.getTreeName(tree.id)).toBe("post-transition tree name");
        const pointer = ownerClient.getRoom(tree.id)!.currentState
          .getStateEvents("io.telecrypt.storage.metadata", "") as MatrixEvent;
        const nameId = (pointer.getContent() as { event_id: string }).event_id;
        const nameRaw = await ownerClient.fetchRoomEvent(tree.id, nameId);
        const file = await upload(owner.storage, tree.id, "post-transition.txt", "new OnlySigned session");
        const fileRaw = await ownerClient.fetchRoomEvent(tree.id, file.id);
        return { nameId, nameRaw, file, fileRaw };
      });
      const transitionRequests = transitioned.requests.filter((request) => request.eventType === "m.room.encrypted");
      const transitionRecipients = recipientsFor(transitionRequests, reader.user.userId);
      const transitionedNameSession = (transitioned.result.nameRaw as { content?: { session_id?: string } }).content?.session_id;
      const transitionedFileSession = (transitioned.result.fileRaw as { content?: { session_id?: string } }).content?.session_id;
      const transitionedNameForUnsigned = await waitForDecryptionFailure(
        unsigned,
        transitioned.result.nameRaw,
        "MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE",
      );
      const transitionedFileForUnsigned = await waitForDecryptionFailure(
        unsigned,
        transitioned.result.fileRaw,
        "MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE",
      );
      const transitionedNameForReader = await waitForDecryption(reader.storage, transitioned.result.nameRaw, true);
      const transitionedFileForReader = await waitForDecryption(reader.storage, transitioned.result.fileRaw, true);

      const restore = await unsigned.keySafe.restore(reader.recoveryKey);
      expect(restore.state).toBe("ready");
      expect(restore.imported).toBeGreaterThan(0);
      await waitFor(async () => {
        const status = await ownerCrypto.getDeviceVerificationStatus(reader.user.userId, unsignedUser.deviceId);
        return status?.signedByOwner ?? false;
      }, { label: "reader's recovered device signed by reader identity", timeoutMs: 20000 });
      await ownerCrypto.forceDiscardSession(tree.id);
      const restoredWrite = await captureToDeviceRecipients(owner.user.accessToken, () =>
        upload(owner.storage, tree.id, "restored.txt", "available after device restore"));
      const restoredRaw = await ownerClient.fetchRoomEvent(tree.id, restoredWrite.result.id);
      const restoredRequests = restoredWrite.requests.filter((request) => request.eventType === "m.room.encrypted");
      const restoredRecipients = recipientsFor(restoredRequests, reader.user.userId);
      const restoredResult = await waitForDecryption(unsigned, restoredRaw, true);
      await save("signed_recipient_policy_transition", {
        signedByOwnerBeforeRestore: trustBefore?.signedByOwner,
        allDevices: {
          encryptedToDeviceRequests: allDevicesRequests,
          recipients: [...allDevicesRecipients],
          session: allDevicesSession,
          unsignedReader: allDevicesUnsigned,
          signedReader: allDevicesSigned,
        },
        onlySignedTransition: {
          encryptedToDeviceRequests: transitionRequests,
          recipients: [...transitionRecipients],
          sessions: [transitionedNameSession, transitionedFileSession],
          unsignedName: transitionedNameForUnsigned,
          unsignedFile: transitionedFileForUnsigned,
          signedName: transitionedNameForReader,
          signedFile: transitionedFileForReader,
        },
        restoredSignedDevice: {
          signedByOwner: true,
          encryptedToDeviceRequests: restoredRequests,
          recipients: [...restoredRecipients],
          descriptor: restoredResult,
        },
      });

      expect(allDevicesRequests.length).toBeGreaterThan(0);
      expect(allDevicesRequests.every((request) => request.status >= 200 && request.status < 300)).toBe(true);
      expect(allDevicesRecipients.has(unsignedUser.deviceId)).toBe(true);
      expect(allDevicesRecipients.has(reader.user.deviceId)).toBe(true);
      expect(allDevicesUnsigned.success).toBe(true);
      expect(allDevicesUnsigned.body).toBe("old-policy.txt");
      expect(allDevicesSigned.success).toBe(true);
      expect(transitionRequests.every((request) => request.status >= 200 && request.status < 300)).toBe(true);
      expect(transitionedNameSession).not.toBe(allDevicesSession);
      expect(transitionedFileSession).toBe(transitionedNameSession);
      expect(transitionRecipients.has(reader.user.deviceId)).toBe(true);
      expect(transitionRecipients.has(unsignedUser.deviceId)).toBe(false);
      expect(transitionedNameForUnsigned.success).toBe(false);
      expect(transitionedNameForUnsigned.error).toBe("MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE");
      expect(transitionedFileForUnsigned.success).toBe(false);
      expect(transitionedFileForUnsigned.error).toBe("MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE");
      expect(transitionedNameForReader.success).toBe(true);
      expect(transitionedFileForReader.success).toBe(true);
      expect(restoredRequests.every((request) => request.status >= 200 && request.status < 300)).toBe(true);
      expect(restoredRecipients.has(unsignedUser.deviceId)).toBe(true);
      expect(restoredResult.success).toBe(true);
      expect(restoredResult.body).toBe("restored.txt");
    } finally {
      ownerCrypto.setDeviceIsolationMode(new OnlySignedDevicesIsolationMode());
    }
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
      await save("revocation_retained_handles_before_sync", findings.revocation_retained_handles_before_sync);
    } finally {
      resumeOwnerSync();
    }
  }, 180000);
});
