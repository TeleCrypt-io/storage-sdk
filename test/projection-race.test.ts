import { describe, expect, it, vi } from "vitest";
import { TeleCryptIOStorage, type TreeSpace } from "../src/TeleCryptIOStorage.js";
import {
  downloadFile as downloadCoreFile,
  listFiles,
  listPendingInvites,
} from "../src/core/operations.js";
import { markFileDeleted, markTreeDeleted } from "../src/deletion-markers.js";

function treeWithFile(roomId: string, fileId: string): TreeSpace {
  const file = { id: fileId, getName: () => "stale.txt" };
  return {
    id: roomId,
    room: { name: "stale vault" },
    isTopLevel: true,
    getDirectories: () => [],
    listFiles: () => [file],
    listAllFiles: () => [file],
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

  it("keeps a late file projection out of the core file listing", async () => {
    const roomId = "!vault:example.test";
    const fileId = "$deleted-file";
    const tree = treeWithFile(roomId, fileId);
    const client = {
      getRoom: () => ({ currentState: { setStateEvents: vi.fn() } }),
      http: { authedRequest: vi.fn().mockResolvedValue([]) },
      unstableGetFileTreeSpace: () => tree,
    };
    const storage = new TeleCryptIOStorage(client as never);

    markFileDeleted(storage.getClient(), roomId, fileId);

    await expect(listFiles(storage, roomId)).resolves.toEqual([]);
  });

  it("rejects a marked file immediately during core file resolution", async () => {
    const roomId = "!vault-immediate:example.test";
    const fileId = "$deleted-immediate";
    const tree = treeWithFile(roomId, fileId);
    const getFile = vi.fn(() => tree.getFile(fileId));
    tree.getFile = getFile;
    const client = {
      unstableGetFileTreeSpace: () => tree,
    };
    const storage = new TeleCryptIOStorage(client as never);

    markFileDeleted(storage.getClient(), roomId, fileId);

    await expect(downloadCoreFile(storage, roomId, fileId)).rejects.toThrow("file not found");
    expect(getFile).not.toHaveBeenCalled();
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
