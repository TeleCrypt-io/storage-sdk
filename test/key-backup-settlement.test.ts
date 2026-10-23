import { afterEach, describe, expect, it, vi } from "vitest";
import { EventType, MatrixError } from "matrix-js-sdk";
import { TeleCryptIOStorage } from "../src/TeleCryptIOStorage.js";

const treeId = "!vault:example.test";
const owner = "@owner:example.test";
const metadataId = "$name";
const fileId = "$file";
const sessionId = "room/session+id";
const backup = { first_message_index: 0, forwarded_count: 0, is_verified: true,
  session_data: { ciphertext: "ciphertext", ephemeral: "ephemeral", mac: "mac" } };

function fixture() {
  const event = {
    getId: () => metadataId,
    getRoomId: () => treeId,
    getSender: () => owner,
    getWireType: () => EventType.RoomMessageEncrypted,
    getType: () => EventType.RoomMessage,
    getWireContent: () => ({ algorithm: "m.megolm.v1.aes-sha2", session_id: sessionId }),
    getContent: () => ({ msgtype: "io.telecrypt.storage.metadata", body: "name" }),
    isRedacted: () => false,
    isDecryptionFailure: () => false,
  };
  const crypto = {
    getActiveSessionBackupVersion: vi.fn().mockResolvedValue("7"),
    getEncryptionInfoForEvent: vi.fn().mockResolvedValue({ shieldColour: 0, shieldReason: null }),
  };
  const client = {
    getUserId: () => owner,
    getCrypto: () => crypto,
    getRoom: () => ({ currentState: { getStateEvents: (type: string) => type === EventType.RoomCreate
      ? { getSender: () => owner }
      : { getSender: () => owner, getContent: () => ({ event_id: metadataId }) } } }),
    fetchRoomEvent: vi.fn().mockResolvedValue(event),
    getEventMapper: () => () => event,
    decryptEventIfNeeded: vi.fn().mockResolvedValue(undefined),
    http: { authedRequest: vi.fn().mockResolvedValue(backup) },
  };
  const storage = new TeleCryptIOStorage(client as never);
  vi.spyOn(storage, "refreshRoomState").mockResolvedValue(undefined);
  return { storage, client, crypto, event };
}

afterEach(() => vi.restoreAllMocks());

describe("native key backup settlement", () => {
  it("accepts an existing backed-up session without waiting for a progress event", async () => {
    const { storage, client } = fixture();
    await storage.waitForKeyBackup(treeId);
    expect(client.http.authedRequest).toHaveBeenCalledExactlyOnceWith(
      "GET", `/room_keys/keys/${encodeURIComponent(treeId)}/${encodeURIComponent(sessionId)}`,
      { version: "7" }, undefined, expect.objectContaining({ prefix: "/_matrix/client/v3", abortSignal: expect.any(AbortSignal) }),
    );
  });

  it("waits for the exact newly encrypted session to reach backup", async () => {
    const { storage, client } = fixture();
    client.http.authedRequest.mockRejectedValueOnce(new MatrixError({ errcode: "M_NOT_FOUND" }, 404));
    await storage.waitForKeyBackup(treeId, undefined, { timeoutMs: 1000 });
    expect(client.http.authedRequest).toHaveBeenCalledTimes(2);
  });

  it("uses the current encrypted file rename session", async () => {
    const { storage, event } = fixture();
    vi.spyOn(storage, "getFileMetadataEventId").mockResolvedValue(metadataId);
    vi.spyOn(storage, "getOriginalFileEvent").mockResolvedValue(event as never);
    const rename = vi.spyOn(storage, "getFileRenameMetadataEvent").mockResolvedValue(event as never);
    await storage.waitForKeyBackup(treeId, fileId);
    expect(rename).toHaveBeenCalledWith(treeId, fileId, metadataId);
  });

  it("also backs up the attachment when its rename uses a different session", async () => {
    const { storage, client, event } = fixture();
    vi.spyOn(storage, "getFileMetadataEventId").mockResolvedValue(metadataId);
    vi.spyOn(storage, "getOriginalFileEvent").mockResolvedValue(event as never);
    vi.spyOn(storage, "getFileRenameMetadataEvent").mockResolvedValue({
      ...event, getWireContent: () => ({ algorithm: "m.megolm.v1.aes-sha2", session_id: "renamed-session" }),
    } as never);
    await storage.waitForKeyBackup(treeId, fileId);
    expect(client.http.authedRequest.mock.calls.map((call) => call[1])).toEqual([
      `/room_keys/keys/${encodeURIComponent(treeId)}/${encodeURIComponent(sessionId)}`,
      `/room_keys/keys/${encodeURIComponent(treeId)}/renamed-session`,
    ]);
  });

  it("uses the original attachment session before any rename", async () => {
    const { storage, event } = fixture();
    vi.spyOn(storage, "getFileMetadataEventId").mockResolvedValue(fileId);
    const original = vi.spyOn(storage, "getOriginalFileEvent").mockResolvedValue(event as never);
    await storage.waitForKeyBackup(treeId, fileId);
    expect(original).toHaveBeenCalledWith(treeId, fileId);
  });

  it("rejects unreadable metadata before claiming backup is ready", async () => {
    const { storage, client, event } = fixture();
    vi.spyOn(event, "isDecryptionFailure").mockReturnValue(true);
    await expect(storage.waitForKeyBackup(treeId)).rejects.toThrow("undecryptable");
    expect(client.http.authedRequest).not.toHaveBeenCalled();
  });

  it("rejects an invalid backup response instead of accepting HTTP success alone", async () => {
    const { storage, client } = fixture();
    client.http.authedRequest.mockResolvedValue({ first_message_index: 0, session_data: {} });
    await expect(storage.waitForKeyBackup(treeId)).rejects.toThrow("server key backup session is invalid");
  });

  it("bounds an unavailable backup session", async () => {
    const { storage, client } = fixture();
    client.http.authedRequest.mockRejectedValue(new MatrixError({ errcode: "M_NOT_FOUND" }, 404));
    await expect(storage.waitForKeyBackup(treeId, undefined, { timeoutMs: 10 })).rejects.toThrow("key backup did not settle");
  });

  it("honors the Matrix transport cancellation option before reading metadata", async () => {
    const { storage, client } = fixture();
    await expect(storage.waitForKeyBackup(treeId, undefined, { abortSignal: AbortSignal.abort() })).rejects.toThrow("operation cancelled");
    expect(client.fetchRoomEvent).not.toHaveBeenCalled();
  });

  it("preserves a server rejection instead of polling it as an absent session", async () => {
    const { storage, client } = fixture();
    const refusal = new MatrixError({ errcode: "M_FORBIDDEN" }, 403);
    client.http.authedRequest.mockRejectedValue(refusal);
    await expect(storage.waitForKeyBackup(treeId)).rejects.toBe(refusal);
    expect(client.http.authedRequest).toHaveBeenCalledTimes(1);
  });

  it("bounds a hung metadata read and cancels a hung backup request", async () => {
    const first = fixture();
    first.client.fetchRoomEvent.mockReturnValue(new Promise(() => {}));
    await expect(first.storage.waitForKeyBackup(treeId, undefined, { timeoutMs: 10 })).rejects.toThrow("key backup did not settle");
    const second = fixture();
    const controller = new AbortController();
    second.client.http.authedRequest.mockImplementation(() => {
      controller.abort();
      return new Promise(() => {});
    });
    await expect(second.storage.waitForKeyBackup(treeId, undefined, { signal: controller.signal })).rejects.toThrow("operation cancelled");
  });
});
