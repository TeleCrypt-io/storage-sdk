import { describe, expect, it, vi } from "vitest";
import { EventType, MatrixError, UNSTABLE_MSC3089_BRANCH } from "matrix-js-sdk";
import { TeleCryptIOStorage } from "../src/TeleCryptIOStorage.js";
import { MutationPartialError } from "../src/core/errors.js";
import { uploadFile } from "../src/core/operations.js";

const treeId = "!upload:example.test";
const mediaId = "mxc://example.test/media";
const fileId = "$attachment";
const owner = "@owner:example.test";

function fixture() {
  let mediaExists = false;
  let attachmentExists = false;
  let attachmentRedacted = false;
  let listed = false;
  let listingRedacted = false;
  const attachment = {
    getId: () => fileId, getRoomId: () => treeId, getSender: () => owner,
    getWireType: () => EventType.RoomMessageEncrypted, getType: () => EventType.RoomMessage,
    getContent: () => ({ msgtype: "m.file", file: { url: mediaId } }),
    isRedacted: () => attachmentRedacted,
  };
  const listing = {
    getId: () => "$listing", getSender: () => owner,
    getContent: () => ({ active: true, metadata_event_id: fileId }),
    isRedacted: () => listingRedacted,
  };
  const tree = {
    id: treeId, getDirectories: () => [], listFiles: () => [], getFile: () => null,
  };
  const client = {
    getUserId: () => owner,
    unstableGetFileTreeSpace: () => tree,
    getRoom: () => ({ currentState: { getStateEvents: (type: string) =>
      type === UNSTABLE_MSC3089_BRANCH.name && listed ? listing : null } }),
    uploadContent: vi.fn(async () => { mediaExists = true; return { content_uri: mediaId }; }),
    sendMessage: vi.fn(async () => { attachmentExists = true; return { event_id: fileId }; }),
    sendStateEvent: vi.fn(async () => { listed = true; return { event_id: "$listing" }; }),
    fetchRoomEvent: vi.fn(async () => attachment),
    getEventMapper: () => () => attachment,
    decryptEventIfNeeded: vi.fn().mockResolvedValue(undefined),
    redactEvent: vi.fn(async (_room: string, id: string) => {
      if (id === fileId) attachmentRedacted = true;
      if (id === "$listing") listingRedacted = true;
      return { event_id: "$redaction" };
    }),
    http: { authedRequest: vi.fn(async () => { mediaExists = false; return {}; }) },
  };
  const storage = new TeleCryptIOStorage(client as never);
  vi.spyOn(storage, "refreshRoomState").mockResolvedValue(undefined);
  vi.spyOn(storage.keySafe, "requireReady").mockResolvedValue(undefined);
  const decorated = storage.getTree(treeId)!;
  const upload = () => storage.uploadFile(decorated, "file.txt", new Uint8Array([1]).buffer, "text/plain");
  return {
    client, storage, upload, list: () => { listed = true; },
    state: () => ({ mediaExists, attachmentExists, attachmentRedacted, listed, listingRedacted }),
  };
}

describe("partial upload recovery", () => {
  it("compensates a definitive listing rejection with owned-media deletion and attachment redaction", async () => {
    const f = fixture();
    f.client.sendStateEvent.mockRejectedValue(new MatrixError({ errcode: "M_FORBIDDEN" }, 403));
    await expect(f.upload()).rejects.toThrow("file upload was rejected; uploaded media and attachment were removed");
    expect(f.state()).toMatchObject({ mediaExists: false, attachmentRedacted: true, listed: false });
    expect(f.client.http.authedRequest).toHaveBeenCalledExactlyOnceWith(
      "POST", "/io.telecrypt.storage/delete_media", undefined, { media_ids: [mediaId] },
      expect.objectContaining({ prefix: "/_matrix/client/unstable" }),
    );
  });

  it("compensates media when the attachment is definitively rejected", async () => {
    const f = fixture();
    f.client.sendMessage.mockRejectedValue(new MatrixError({ errcode: "M_FORBIDDEN" }, 403));
    await expect(f.upload()).rejects.toThrow("file upload was rejected");
    expect(f.state()).toMatchObject({ mediaExists: false, attachmentExists: false });
    expect(f.client.redactEvent).not.toHaveBeenCalled();
  });

  it("preserves IDs through core when cleanup fails, and retries cleanup without creating another upload", async () => {
    const f = fixture();
    f.client.sendStateEvent.mockRejectedValue(new MatrixError({ errcode: "M_FORBIDDEN" }, 403));
    f.client.http.authedRequest.mockRejectedValueOnce(new Error("deletion unavailable"));
    await expect(uploadFile(f.storage, treeId, "file.txt", new Uint8Array([1]), "text/plain")).rejects.toMatchObject({
      name: "MutationPartialError", operation: "file upload", completedIds: [mediaId, fileId], treeId,
    });
    expect(f.state()).toMatchObject({ mediaExists: true, attachmentRedacted: false });
    await f.storage.cleanupFileUpload(treeId, mediaId, fileId);
    await f.storage.cleanupFileUpload(treeId, mediaId, fileId);
    expect(f.state()).toMatchObject({ mediaExists: false, attachmentRedacted: true });
    expect(f.client.uploadContent).toHaveBeenCalledTimes(1);
    expect(f.client.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.client.redactEvent).toHaveBeenCalledTimes(1);
  });

  it("never compensates an ambiguous accepted listing until explicitly requested", async () => {
    const f = fixture();
    f.client.sendStateEvent.mockImplementation(async () => { f.list(); throw new Error("response lost"); });
    await expect(f.upload()).rejects.toMatchObject({
      name: "MutationPartialError", completedIds: [mediaId, fileId], treeId,
    });
    expect(f.state()).toMatchObject({ mediaExists: true, attachmentRedacted: false, listed: true });
    expect(f.client.http.authedRequest).not.toHaveBeenCalled();
    await f.storage.cleanupFileUpload(treeId, mediaId, fileId);
    expect(f.state()).toMatchObject({ mediaExists: false, attachmentRedacted: true, listingRedacted: true });
  });

  it("retains the known media ID when the attachment outcome is unknown", async () => {
    const f = fixture();
    f.client.sendMessage.mockRejectedValue(new Error("response lost"));
    await expect(f.upload()).rejects.toMatchObject({
      name: "MutationPartialError", completedIds: [mediaId], treeId,
    });
    expect(f.client.http.authedRequest).not.toHaveBeenCalled();
    await f.storage.cleanupFileUpload(treeId, mediaId);
    expect(f.state().mediaExists).toBe(false);
  });

  it("retains IDs after a server-side timeout instead of deleting uncertain accepted work", async () => {
    const f = fixture();
    f.client.sendStateEvent.mockRejectedValue(new MatrixError({ errcode: "M_UNKNOWN" }, 408));
    await expect(f.upload()).rejects.toBeInstanceOf(MutationPartialError);
    expect(f.client.http.authedRequest).not.toHaveBeenCalled();
  });

  it("rejects mismatched recovery IDs before deleting any media", async () => {
    const f = fixture();
    await expect(f.storage.cleanupFileUpload(treeId, "mxc://example.test/unrelated", fileId)).rejects.toThrow(
      "partial upload attachment does not match",
    );
    expect(f.client.http.authedRequest).not.toHaveBeenCalled();
    expect(f.client.redactEvent).not.toHaveBeenCalled();
  });
});
