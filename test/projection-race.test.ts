import { DecryptionKeySafe } from "../src/key-safe.js";
beforeEach(() => { vi.spyOn(DecryptionKeySafe.prototype, "requireReady").mockResolvedValue(undefined); });
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EventType,
  MatrixError,
  UNSTABLE_MSC3088_ENABLED,
  UNSTABLE_MSC3088_PURPOSE,
  UNSTABLE_MSC3089_TREE_SUBTYPE,
} from "matrix-js-sdk";
import { TeleCryptIOStorage, type TreeSpace } from "../src/TeleCryptIOStorage.js";
import {
  downloadFile as downloadCoreFile,
  listFiles,
  listPendingInvites,
} from "../src/core/operations.js";
import { markTreeDeleted } from "../src/deletion-markers.js";

function encryptedRoom() {
  return {
    currentState: {
      setStateEvents: vi.fn(),
      mayClientSendStateEvent: vi.fn(() => true),
      maySendEvent: vi.fn(() => true),
      maySendRedactionForEvent: vi.fn(() => false),
      getStateEvents: (type: string, stateKey?: string) => {
        if (type === EventType.RoomCreate && stateKey === "") return { getContent: () => ({ type: "m.space" }) };
        if (type === UNSTABLE_MSC3088_PURPOSE.name && stateKey === UNSTABLE_MSC3089_TREE_SUBTYPE.name) {
          return { getContent: () => ({ [UNSTABLE_MSC3088_ENABLED.name]: true }) };
        }
        if (type === EventType.RoomEncryption && stateKey === "") {
          return { getContent: () => ({ algorithm: "m.megolm.v1.aes-sha2" }) };
        }
        return [];
      },
    },
  };
}

function treeWithFile(roomId: string, fileId: string): TreeSpace {
  const file = { id: fileId, getName: () => "stale.txt" };
  return {
    id: roomId,
    room: { name: "stale vault" },
    isTopLevel: true,
    getDirectories: () => [],
    listFiles: () => [file],
    getFile: () => file,
  } as unknown as TreeSpace;
}

describe("deletion race projection guards", () => {
  it("keeps a late room projection out of public tree listings", async () => {
    const roomId = "!deleted:example.test";
    const tree = treeWithFile(roomId, "$stale");
    const client = {
      getRooms: () => [{ roomId }],
      unstableGetFileTreeSpace: vi.fn(() => tree),
    };
    const storage = new TeleCryptIOStorage(client as never);

    markTreeDeleted(storage.getClient(), roomId);

    expect(storage.getTree(roomId)).toBeNull();
    await expect(storage.listTrees()).resolves.toEqual([]);
    expect(client.unstableGetFileTreeSpace).not.toHaveBeenCalled();
  });

  it("filters a surviving listing when the original attachment is redacted", async () => {
    const roomId = "!vault:example.test";
    const fileId = "$deleted-file";
    const tree = treeWithFile(roomId, fileId);
    const client = {
      getRoom: encryptedRoom,
      getUserId: () => "@alice:example.test",
      http: { authedRequest: vi.fn().mockResolvedValue([]) },
      unstableGetFileTreeSpace: () => tree,
    };
    const storage = new TeleCryptIOStorage(client as never);
    vi.spyOn(storage, "getOriginalFileEventState").mockResolvedValue({
      ownerUserId: "@alice:example.test",
      redacted: true,
      canRedact: false,
    });

    await expect(listFiles(storage, roomId)).resolves.toEqual([]);
  });

  it.each([
    ["an unavailable event", new MatrixError({ errcode: "M_NOT_FOUND" }, 404)],
    ["HTTP 500 M_UNKNOWN", new MatrixError({ errcode: "M_UNKNOWN" }, 500)],
  ])("keeps an active listing unresolved after %s", async (_label, unavailable) => {
    const roomId = "!vault-unresolved:example.test";
    const fileId = "$active-but-unavailable";
    const tree = treeWithFile(roomId, fileId);
    const storage = new TeleCryptIOStorage({
      getRoom: encryptedRoom,
      getUserId: () => "@alice:example.test",
      http: { authedRequest: vi.fn().mockResolvedValue([]) },
      unstableGetFileTreeSpace: () => tree,
    } as never);
    vi.spyOn(storage, "getOriginalFileEventState").mockRejectedValue(unavailable);

    let failure: unknown;
    try {
      await listFiles(storage, roomId);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ message: "list files failed" });
    expect((failure as Error & { cause?: unknown }).cause).toBe(unavailable);
  });

  it("rejects a redacted original attachment during core file resolution", async () => {
    const roomId = "!vault-immediate:example.test";
    const fileId = "$deleted-immediate";
    const tree = treeWithFile(roomId, fileId);
    const file = tree.getFile(fileId);
    const getFile = vi.fn(() => file);
    tree.getFile = getFile;
    const client = {
      getRoom: encryptedRoom,
      unstableGetFileTreeSpace: () => tree,
    };
    const storage = new TeleCryptIOStorage(client as never);
    vi.spyOn(storage, "getOriginalFileEventState").mockResolvedValue({
      ownerUserId: "@alice:example.test",
      redacted: true,
      canRedact: false,
    });

    await expect(downloadCoreFile(storage, roomId, fileId)).rejects.toThrow("file not found");
    expect(getFile).toHaveBeenCalledOnce();
  });

  it("keeps a late invite projection out of pending invites", async () => {
    const roomId = "!deleted-invite:example.test";
    const room = { roomId, getMyMembership: vi.fn(() => "invite") };
    const storage = new TeleCryptIOStorage({ getRooms: () => [room] } as never);

    markTreeDeleted(storage.getClient(), roomId);

    await expect(listPendingInvites(storage)).resolves.toEqual([]);
    expect(room.getMyMembership).not.toHaveBeenCalled();
  });
});
