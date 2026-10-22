import { describe, expect, it, vi } from "vitest";
import { EventType, MatrixEvent, RoomCreateTypeField, RoomType, UNSTABLE_MSC3088_PURPOSE, UNSTABLE_MSC3088_ENABLED, UNSTABLE_MSC3089_TREE_SUBTYPE } from "matrix-js-sdk";
import { TeleCryptIOStorage, type TreeSpace } from "../src/TeleCryptIOStorage.js";
import { joinVault, listSubfolders } from "../src/core/operations.js";
import { markTreeDeleted } from "../src/deletion-markers.js";

const owner = "@owner:example.test";
const reader = "@reader:example.test";
const roomId = "!tree:example.test";

function permissionFixture(userId = owner) {
  const state = [
    { type: EventType.RoomCreate, state_key: "", sender: owner, content: { type: "m.space" } },
    { type: UNSTABLE_MSC3088_PURPOSE.name, state_key: UNSTABLE_MSC3089_TREE_SUBTYPE.name, content: { [UNSTABLE_MSC3088_ENABLED.name]: true } },
    { type: EventType.RoomEncryption, state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } },
    { type: EventType.RoomMember, state_key: owner, content: { membership: "join" } },
    { type: EventType.RoomPowerLevels, state_key: "", content: {
      state_default: 0, events_default: 0, users_default: 0, invite: 100,
      users: { [owner]: 100, [reader]: 0 },
      events: { [EventType.RoomPowerLevels]: 100, [EventType.RoomJoinRules]: 0, [UNSTABLE_MSC3088_PURPOSE.name]: 0, "io.example.other": 75 },
    } },
    { type: EventType.RoomJoinRules, state_key: "", content: { join_rule: "public" } },
  ] as Array<{ type: string; state_key: string; sender?: string; content: Record<string, unknown> }>;
  const getStateEvents = (type: string, key: string) => {
    const raw = state.find((item) => item.type === type && item.state_key === key);
    return raw ? new MatrixEvent(raw as never) : null;
  };
  const room = { roomId, currentState: { getStateEvents, setStateEvents: vi.fn() } };
  const client = {
    getUserId: () => userId,
    getRoom: () => room,
    http: { authedRequest: vi.fn(async () => structuredClone(state)) },
    sendStateEvent: vi.fn(async (_id: string, type: string, content: Record<string, unknown>, key: string) => {
      state.find((item) => item.type === type && item.state_key === key)!.content = content;
      return { event_id: "$permission-update" };
    }),
  };
  return { client, state, storage: new TeleCryptIOStorage(client as never) };
}

describe("existing Storage permissions", () => {
  it("repairs the owner's existing public vault and preserves unrelated permissions", async () => {
    const f = permissionFixture();
    await f.storage.refreshRoomState(roomId);
    const power = f.state.find((event) => event.type === EventType.RoomPowerLevels)!.content;
    expect(power).toMatchObject({
      state_default: 100, events_default: 0, invite: 100,
      users: { [owner]: 100, [reader]: 0 },
      events: { [EventType.RoomJoinRules]: 100, [UNSTABLE_MSC3088_PURPOSE.name]: 100, "io.example.other": 75 },
    });
    expect(f.state.find((event) => event.type === EventType.RoomJoinRules)?.content).toEqual({ join_rule: "invite" });
    expect(f.client.sendStateEvent).toHaveBeenCalledTimes(2);
    await f.storage.refreshRoomState(roomId);
    expect(f.client.sendStateEvent).toHaveBeenCalledTimes(2);
  });

  it("does not write permissions as a reader", async () => {
    const f = permissionFixture(reader);
    await f.storage.refreshRoomState(roomId);
    expect(f.client.sendStateEvent).not.toHaveBeenCalled();
  });

  it.each(["missing", "unsupported"])("does not repair owner permissions when encryption is %s", async (encryption) => {
    const f = permissionFixture();
    const encryptionEvent = f.state.find((event) => event.type === EventType.RoomEncryption)!;
    if (encryption === "missing") {
      f.state.splice(f.state.indexOf(encryptionEvent), 1);
    } else {
      encryptionEvent.content = { algorithm: "m.megolm.v1.aes-ctr" };
    }

    await f.storage.refreshRoomState(roomId);

    expect(f.client.sendStateEvent).not.toHaveBeenCalled();
  });

  it("does not restore disabled Storage markers or deleted trees", async () => {
    const f = permissionFixture();
    const purpose = f.state.find((event) => event.type === UNSTABLE_MSC3088_PURPOSE.name)!;
    purpose.content = { [UNSTABLE_MSC3088_ENABLED.name]: false };
    await f.storage.refreshRoomState(roomId);
    purpose.content = { [UNSTABLE_MSC3088_ENABLED.name]: true };
    markTreeDeleted(f.client as never, roomId);
    await f.storage.refreshRoomState(roomId);
    expect(f.client.sendStateEvent).not.toHaveBeenCalled();
  });

  it("finishes a repair interrupted after the power-level write", async () => {
    const f = permissionFixture();
    const send = f.client.sendStateEvent.getMockImplementation()!;
    f.client.sendStateEvent.mockImplementationOnce(send).mockRejectedValueOnce(new Error("disconnected"));
    await expect(f.storage.refreshRoomState(roomId)).rejects.toThrow("disconnected");
    f.client.sendStateEvent.mockImplementation(send);
    await f.storage.refreshRoomState(roomId);
    expect(f.client.sendStateEvent.mock.calls.filter((call) => call[1] === EventType.RoomPowerLevels)).toHaveLength(1);
    expect(f.state.find((event) => event.type === EventType.RoomJoinRules)?.content).toEqual({ join_rule: "invite" });
  });
});

function storageRoom(roomId: string, algorithm?: string) {
  const events = new Map<string, { getContent: () => Record<string, unknown>; getSender: () => string }>();
  const put = (type: string, stateKey: string, content: Record<string, unknown>, sender = owner) =>
    events.set(`${type}\u0000${stateKey}`, { getContent: () => content, getSender: () => sender });
  put(EventType.RoomCreate, "", { [RoomCreateTypeField]: RoomType.Space });
  put(UNSTABLE_MSC3088_PURPOSE.name, UNSTABLE_MSC3089_TREE_SUBTYPE.name, {
    [UNSTABLE_MSC3088_ENABLED.name]: true,
  });
  if (algorithm !== undefined) put(EventType.RoomEncryption, "", { algorithm });
  return {
    roomId,
    currentState: {
      getStateEvents: (type: string, stateKey = "") => events.get(`${type}\u0000${stateKey}`) ?? null,
    },
  };
}

function projectedTree(id: string, directories: TreeSpace[] = [], isTopLevel = true): TreeSpace {
  return {
    id,
    room: { name: "Encrypted storage" },
    isTopLevel,
    getDirectories: () => directories,
    getDirectory: (roomId: string) => directories.find((directory) => directory.id === roomId),
  } as unknown as TreeSpace;
}

describe("encrypted Storage room discovery", () => {
  it("requires Megolm encryption for direct, top-level, and nested discovery", async () => {
    const rootId = "!root:example.test";
    const validChildId = "!valid-child:example.test";
    const missingChildId = "!missing-child:example.test";
    const unsupportedChildId = "!unsupported-child:example.test";
    const validChild = projectedTree(validChildId, [], false);
    const missingChild = projectedTree(missingChildId, [], false);
    const unsupportedChild = projectedTree(unsupportedChildId, [], false);
    const root = projectedTree(rootId, [validChild, missingChild, unsupportedChild]);
    const rooms = new Map([
      [rootId, storageRoom(rootId, "m.megolm.v1.aes-sha2")],
      [validChildId, storageRoom(validChildId, "m.megolm.v1.aes-sha2")],
      [missingChildId, storageRoom(missingChildId)],
      [unsupportedChildId, storageRoom(unsupportedChildId, "m.megolm.v1.aes-ctr")],
    ]);
    const trees = new Map([
      [rootId, root],
      [validChildId, validChild],
      [missingChildId, missingChild],
      [unsupportedChildId, unsupportedChild],
    ]);
    const client = {
      getRoom: (id: string) => rooms.get(id) ?? null,
      getRooms: () => [...rooms.values()],
      getUserId: () => "@reader:example.test",
      unstableGetFileTreeSpace: (id: string) => trees.get(id) ?? null,
    };
    const storage = new TeleCryptIOStorage(client as never);

    expect(storage.getTree(rootId)).not.toBeNull();
    expect(storage.getTree(validChildId)).not.toBeNull();
    expect(storage.getTree(missingChildId)).toBeNull();
    expect(storage.getTree(unsupportedChildId)).toBeNull();
    await expect(storage.listTrees()).resolves.toEqual([
      expect.objectContaining({ id: rootId }),
      expect.objectContaining({ id: validChildId }),
    ]);
    expect(root.getDirectories().map((directory) => directory.id)).toEqual([validChildId]);
    expect(root.getDirectory(validChildId)?.id).toBe(validChildId);
    expect(root.getDirectory(missingChildId)).toBeUndefined();
    expect(root.getDirectory(unsupportedChildId)).toBeUndefined();
  });
});

function invitationFixture() {
  const memberships = new Map([["!root:example.test", "invite"], ["!child:example.test", "invite"], ["!nested:example.test", "invite"]]);
  const links = new Map([["!root:example.test", ["!child:example.test"]], ["!child:example.test", ["!nested:example.test"]]]);
  const client = {
    getUserId: () => reader,
    getRoom: (id: string) => ({
      getMyMembership: () => memberships.get(id),
      getMember: () => ({ membership: memberships.get(id) }),
      currentState: { getStateEvents: (type: string) => type === EventType.SpaceChild ? (links.get(id) ?? []).map((child) => ({
        getStateKey: () => child, getContent: () => ({ via: ["example.test"] }),
      })) : [] },
    }),
    joinRoom: vi.fn(async (id: string) => { memberships.set(id, "join"); }),
  };
  const storage = {
    keySafe: { requireReady: async () => undefined },
    getClient: () => client,
    getRoomMembership: async (id: string) => memberships.get(id),
    getTree: (id: string) => memberships.get(id) === "join" ? { id } as TreeSpace : null,
    refreshRoomState: async () => undefined,
    getTreeName: async (id: string) => id,
  } as unknown as TeleCryptIOStorage;
  return { client, storage, memberships };
}

describe("nested invitation acceptance", () => {
  it("joins all linked children and can retry after joining only the root", async () => {
    const f = invitationFixture();
    const join = f.client.joinRoom.getMockImplementation()!;
    f.client.joinRoom.mockImplementationOnce(join).mockRejectedValueOnce(new Error("disconnected"));
    await expect(joinVault(f.storage, "!root:example.test")).rejects.toMatchObject({
      code: "MUTATION_PARTIAL", completedIds: ["!root:example.test"],
    });
    f.client.joinRoom.mockImplementation(join);
    await joinVault(f.storage, "!root:example.test");
    expect([...f.memberships.values()]).toEqual(["join", "join", "join"]);
    expect(f.client.joinRoom.mock.calls.filter(([id]) => id === "!root:example.test")).toHaveLength(1);
  });

  it("accepts a new child's invitation when browsing an already joined vault", async () => {
    const f = invitationFixture();
    f.memberships.set("!root:example.test", "join");
    await expect(listSubfolders(f.storage, "!root:example.test")).resolves.toEqual([
      { id: "!child:example.test", name: "!child:example.test" },
    ]);
    expect(f.memberships.get("!child:example.test")).toBe("join");
    expect(f.memberships.get("!nested:example.test")).toBe("invite");
  });
});
