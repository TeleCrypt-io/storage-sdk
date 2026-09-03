import { describe, expect, it, vi } from "vitest";
import { UNSTABLE_MSC3089_BRANCH } from "matrix-js-sdk";
import { TeleCryptIOStorage, type FileBranch, type TreeSpace } from "../src/TeleCryptIOStorage.js";
import { deleteFile, deleteVault } from "../src/core/operations.js";

const ROOM_ID = "!cross-client-delete:example.test";
const FILE_ID = "$cross-client-file";

interface SharedState {
  branchPresent: boolean;
  branchContent: Record<string, unknown>;
  redacted: boolean;
}

interface DeleteFixture {
  shared: SharedState;
  client: Record<string, unknown>;
  storage: TeleCryptIOStorage;
  tree: TreeSpace;
  branch: FileBranch;
}

function stateEvent(content: Record<string, unknown>) {
  return {
    getStateKey: () => FILE_ID,
    getContent: () => content,
  };
}

function makeFixture(
  branchContent: Record<string, unknown>,
  options: { branchPresent?: boolean } = {},
  sharedState?: SharedState,
): DeleteFixture {
  const shared: SharedState = sharedState ?? {
    branchPresent: options.branchPresent ?? true,
    branchContent: { ...branchContent },
    redacted: false,
  };
  let localBranchContent = { ...branchContent };

  const branch = {
    id: FILE_ID,
    get isActive() {
      return localBranchContent.active === true;
    },
    version: 1,
    getName: () => "cross-client.txt",
    setName: vi.fn(),
    delete: vi.fn(),
    getFileInfo: vi.fn().mockResolvedValue({
      info: { url: "mxc://example.test/cross-client-media" },
      httpUrl: "https://matrix.example.test/media",
    }),
    getFileEvent: vi.fn(),
    getVersionHistory: vi.fn(),
    createNewVersion: vi.fn(),
  } as unknown as FileBranch;
  (branch.getVersionHistory as ReturnType<typeof vi.fn>).mockResolvedValue([branch]);

  const room = {
    roomId: ROOM_ID,
    getMyMembership: () => "join",
    currentState: {
      getStateEvents: (eventType: string, stateKey?: string) => {
        if (eventType !== UNSTABLE_MSC3089_BRANCH.name) return [];
        if (stateKey !== undefined) {
          return shared.branchPresent && stateKey === FILE_ID ? stateEvent(localBranchContent) : null;
        }
        return shared.branchPresent ? [stateEvent(localBranchContent)] : [];
      },
    },
  };
  const tree = {
    id: ROOM_ID,
    room: { name: "Cross-client vault" },
    isTopLevel: true,
    getDirectories: () => [],
    listAllFiles: () => [branch],
    getFile: () => branch,
  } as unknown as TreeSpace;

  const client: Record<string, unknown> = {
    getUserId: () => "@cross-client:example.test",
    getDomain: () => "example.test",
    getRoom: (roomId: string) => (roomId === ROOM_ID ? room : null),
    getRooms: () => [room],
    unstableGetFileTreeSpace: () => tree,
    http: {
      authedRequest: vi.fn(async (_method: string, path: string) => {
        if (path === "/joined_rooms") return { joined_rooms: [ROOM_ID] };
        if (path.endsWith("/members")) {
          return {
            chunk: [{ state_key: "@cross-client:example.test", content: { membership: "join" } }],
          };
        }
        if (path.includes("m.room.power_levels")) return {};
        return [];
      }),
    },
    sendStateEvent: vi.fn(async (_roomId: string, eventType: string, content: Record<string, unknown>) => {
      if (eventType === UNSTABLE_MSC3089_BRANCH.name) {
        shared.branchContent = { ...content };
      }
    }),
    redactEvent: vi.fn(async () => {
      shared.redacted = true;
    }),
    leave: vi.fn().mockResolvedValue(undefined),
    forget: vi.fn().mockResolvedValue(undefined),
    kick: vi.fn().mockResolvedValue(undefined),
  };

  const storage = {
    getClient: () => client,
    getTree: () => tree,
    listJoinedRoomIds: vi.fn().mockResolvedValue([ROOM_ID]),
    refreshRoomState: vi.fn(async () => {
      localBranchContent = { ...shared.branchContent };
    }),
    listMembers: vi.fn().mockResolvedValue([
      { userId: "@cross-client:example.test", role: "owner", membership: "join" },
    ]),
    getRoomMembership: vi.fn().mockResolvedValue("join"),
  } as unknown as TeleCryptIOStorage;

  return { shared, client, storage, tree, branch };
}

describe("cross-client deletion reconciliation", () => {
  it("allows client A to delete a vault after client B leaves an authoritative tombstone", async () => {
    const shared: SharedState = {
      branchPresent: true,
      branchContent: { active: true, name: "cross-client.txt" },
      redacted: false,
    };
    const fixtureB = makeFixture(shared.branchContent, {}, shared);
    const fixtureA = makeFixture(shared.branchContent, {}, shared);

    await expect(deleteFile(fixtureB.storage, ROOM_ID, FILE_ID)).resolves.toEqual({
      id: FILE_ID,
      deleted: true,
    });
    expect(fixtureB.shared.branchContent).toEqual({});
    expect(fixtureB.shared.redacted).toBe(true);

    // Refresh A from the shared authoritative branch state, without copying B's process-local marker.
    await fixtureA.storage.refreshRoomState(ROOM_ID);

    await expect(deleteVault(fixtureA.storage, ROOM_ID)).resolves.toEqual({
      id: ROOM_ID,
      deleted: true,
    });
    expect(fixtureA.client.forget).toHaveBeenCalledWith(ROOM_ID);
  });

  it.each([
    ["active", { active: true, name: "cross-client.txt" }, {}],
    ["malformed inactive", { active: false, name: "cross-client.txt" }, {}],
    ["unverified", {}, { branchPresent: false }],
  ])("fails closed for a %s branch", async (_label, content, options) => {
    const fixture = makeFixture(content, options);

    await expect(deleteVault(fixture.storage, ROOM_ID)).rejects.toMatchObject({
      code: "NON_EMPTY_TREE",
      treeId: ROOM_ID,
    });
    expect(fixture.client.leave).not.toHaveBeenCalled();
    expect(fixture.client.forget).not.toHaveBeenCalled();
  });
});
