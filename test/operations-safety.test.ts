import { describe, expect, it, vi } from "vitest";
import {
  EventType,
  MatrixError,
  UNSTABLE_MSC3088_ENABLED,
  UNSTABLE_MSC3088_PURPOSE,
  UNSTABLE_MSC3089_TREE_SUBTYPE,
} from "matrix-js-sdk";
import {
  TeleCryptIOStorage,
  type TreeSpace,
  withMatrixMutationAbort,
} from "../src/TeleCryptIOStorage.js";
import {
  declineInvite,
  deleteFile,
  deleteVault,
  downloadFile as downloadCoreFile,
  joinVault,
  listFiles,
  listPendingInvites,
  listSubfolders,
  renameFolder,
  shareVault,
  unshareVault,
} from "../src/core/operations.js";
import { MutationPartialError, UndecryptableFileError } from "../src/core/errors.js";
import { waitForCondition } from "../src/core/poll.js";

function makeTree(id: string, name: string, isTopLevel: boolean): TreeSpace {
  return {
    id,
    room: { name },
    isTopLevel,
    getDirectories: () => [],
    listAllFiles: () => [],
  } as unknown as TreeSpace;
}

function reviewedInviteRoom(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    currentState: {
      getStateEvents: (type: string, stateKey: string) => {
        if (type === EventType.RoomCreate) return { getContent: () => ({ type: "m.space" }) };
        if (type === UNSTABLE_MSC3088_PURPOSE.name && stateKey === UNSTABLE_MSC3089_TREE_SUBTYPE.name) {
          return { getContent: () => ({ [UNSTABLE_MSC3088_ENABLED.name]: true }) };
        }
        return null;
      },
    },
    ...extra,
  };
}

describe("operation safety", () => {
  function deletionFixture(history: Array<{ id: string; mediaId: string }>) {
    const versions = history.map(({ id, mediaId }) => ({
      id,
      getFileInfo: vi.fn().mockResolvedValue({ info: { url: mediaId }, httpUrl: "https://matrix.invalid" }),
    }));
    versions[0].getVersionHistory = vi.fn().mockResolvedValue(versions);
    const tree = makeTree("!delete-file:example.test", "Delete file", true);
    tree.getFile = vi.fn().mockReturnValue(versions[0]);
    const client = {
      http: { authedRequest: vi.fn().mockResolvedValue({}) },
      sendStateEvent: vi.fn().mockResolvedValue({}),
      redactEvent: vi.fn().mockResolvedValue({}),
    };
    const storage = {
      getTree: () => tree,
      getClient: () => client,
    } as unknown as TeleCryptIOStorage;
    return { client, storage, tree, versions };
  }

  it("deletes every version's media before redacting its Matrix events", async () => {
    const fixture = deletionFixture([
      { id: "$v2", mediaId: "mxc://example.test/v2" },
      { id: "$v1", mediaId: "mxc://example.test/v1" },
    ]);

    await expect(deleteFile(fixture.storage, fixture.tree.id, "$v2")).resolves.toEqual({
      id: "$v2",
      deleted: true,
    });
    expect(fixture.client.http.authedRequest).toHaveBeenCalledWith(
      "POST",
      "/io.telecrypt.storage/delete_media",
      undefined,
      { media_ids: ["mxc://example.test/v2", "mxc://example.test/v1"] },
      expect.objectContaining({ prefix: "/_matrix/client/unstable" }),
    );
    expect(fixture.client.http.authedRequest.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.client.sendStateEvent.mock.invocationCallOrder[0],
    );
    expect(fixture.client.sendStateEvent).toHaveBeenNthCalledWith(
      1,
      fixture.tree.id,
      "org.matrix.msc3089.branch",
      {},
      "$v2",
    );
    expect(fixture.client.redactEvent).toHaveBeenNthCalledWith(2, fixture.tree.id, "$v1");
  });

  it("rejects a cyclic version chain before any media or event mutation", async () => {
    const fixture = deletionFixture([{ id: "$v2", mediaId: "mxc://example.test/v2" }]);
    fixture.versions[0].getVersionHistory.mockResolvedValue([
      fixture.versions[0],
      fixture.versions[0],
    ]);

    await expect(deleteFile(fixture.storage, fixture.tree.id, "$v2")).rejects.toThrow(
      "file version history contains a cycle",
    );
    expect(fixture.client.http.authedRequest).not.toHaveBeenCalled();
    expect(fixture.client.sendStateEvent).not.toHaveBeenCalled();
    expect(fixture.client.redactEvent).not.toHaveBeenCalled();
  });

  it("reports typed partial state when event cleanup fails after media deletion", async () => {
    const fixture = deletionFixture([
      { id: "$v2", mediaId: "mxc://example.test/v2" },
      { id: "$v1", mediaId: "mxc://example.test/v1" },
    ]);
    fixture.client.redactEvent.mockRejectedValueOnce(new Error("redaction failed"));

    await expect(deleteFile(fixture.storage, fixture.tree.id, "$v2")).rejects.toMatchObject({
      code: "MUTATION_PARTIAL",
      operation: "delete file",
      completedIds: [],
    });
    expect(fixture.client.http.authedRequest).toHaveBeenCalledTimes(1);
    expect(fixture.client.redactEvent).toHaveBeenCalledTimes(1);
  });

  it("bounds the version chain before issuing a deletion request", async () => {
    const fixture = deletionFixture(
      Array.from({ length: 129 }, (_, index) => ({
        id: `$v${index}`,
        mediaId: `mxc://example.test/v${index}`,
      })),
    );

    await expect(deleteFile(fixture.storage, fixture.tree.id, "$v0")).rejects.toThrow(
      "file version history is invalid or too large",
    );
    expect(fixture.client.http.authedRequest).not.toHaveBeenCalled();
  });

  it("bounds the pending-invite room inventory before iterating it", async () => {
    const storage = {
      getClient: () => ({ getRooms: () => Array.from({ length: 10_001 }, () => ({}) ) }),
    } as unknown as TeleCryptIOStorage;

    await expect(listPendingInvites(storage)).rejects.toThrow("invite list is too large");
  });

  it("bounds file and folder collections before mapping remote objects", async () => {
    const hugeFiles = Array.from({ length: 10_001 }, (_, index) => ({
      id: `$file-${index}`,
      getName: () => `file-${index}`,
    }));
    const hugeFolders = Array.from({ length: 10_001 }, (_, index) => ({
      id: `!folder-${index}:example.test`,
      room: { name: `folder-${index}` },
    }));
    const tree = makeTree("!bounded:example.test", "Bounded", true);
    tree.listFiles = () => hugeFiles as never;
    tree.getDirectories = () => hugeFolders as never;
    const storage = {
      getTree: () => tree,
      refreshRoomState: vi.fn().mockResolvedValue(undefined),
    } as unknown as TeleCryptIOStorage;

    await expect(listFiles(storage, tree.id)).rejects.toThrow("file list is too large");
    await expect(listSubfolders(storage, tree.id)).rejects.toThrow("folder list is too large");
  });

  it("removes the mutation abort listener when the operation throws synchronously", async () => {
    const controller = new AbortController();
    const abortRequests = vi.fn();
    const failure = new Error("synchronous mutation failure");
    const pending = withMatrixMutationAbort(
      { http: { abort: abortRequests } } as never,
      () => {
        throw failure;
      },
      controller.signal,
    );

    await expect(pending).rejects.toBe(failure);
    controller.abort();
    expect(abortRequests).not.toHaveBeenCalled();
  });

  it("bounds a hung asynchronous condition check and aborts it", async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const pending = waitForCondition(
        (signal) =>
          new Promise<null>((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          }),
        { timeoutMs: 100, intervalMs: 10 },
      );
      const assertion = expect(pending).rejects.toThrow(
        "timed out after 100ms waiting for condition",
      );
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the stable undecryptable-device error", async () => {
    const branch = { id: "$file", getName: () => "secret.txt" };
    const tree = makeTree("!vault:example.test", "Vault", true);
    tree.getFile = vi.fn().mockReturnValue(branch);
    const failure = new UndecryptableFileError();
    const storage = {
      getTree: () => tree,
      downloadFile: vi.fn().mockRejectedValue(failure),
    } as unknown as TeleCryptIOStorage;

    await expect(downloadCoreFile(storage, tree.id, branch.id)).rejects.toBe(failure);
  });

  it("evicts a declined invite from the local room store after server cleanup", async () => {
    const removeRoom = vi.fn();
    const refreshRoomState = vi.fn().mockResolvedValue(undefined);
    const unstableGetFileTreeSpace = vi.fn(() => null);
    const client = {
      store: { removeRoom },
      getRoom: vi.fn(() => reviewedInviteRoom()),
      // This is the Matrix 42 behavior for an invited (not joined) room.
      unstableGetFileTreeSpace,
      leave: vi.fn().mockResolvedValue(undefined),
      forget: vi.fn().mockResolvedValue(undefined),
    };
    const storage = {
      getClient: () => client,
      getTree: (roomId: string) => client.unstableGetFileTreeSpace(roomId),
      refreshRoomState,
      getRoomMembership: vi.fn().mockResolvedValue("invite"),
    } as unknown as TeleCryptIOStorage;

    await expect(declineInvite(storage, "!invite:example.test")).resolves.toEqual({
      vaultId: "!invite:example.test",
      declined: true,
    });
    expect(client.leave).toHaveBeenCalledWith("!invite:example.test");
    expect(client.forget).toHaveBeenCalledWith("!invite:example.test");
    expect(unstableGetFileTreeSpace).not.toHaveBeenCalled();
    expect(removeRoom).toHaveBeenCalledWith("!invite:example.test");
    expect(refreshRoomState).toHaveBeenCalledWith(
      "!invite:example.test",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(refreshRoomState.mock.invocationCallOrder[0]).toBeLessThan(client.leave.mock.invocationCallOrder[0]);
  });

  it("fails closed when invite membership cannot be re-read", async () => {
    const client = {
      getRoom: vi.fn(() => undefined),
      leave: vi.fn(),
      forget: vi.fn(),
    };
    const storage = {
      getClient: () => client,
      getTree: () => ({ id: "!invite-unreadable:example.test", isTopLevel: true }),
      refreshRoomState: vi.fn().mockResolvedValue(undefined),
      getRoomMembership: vi.fn().mockRejectedValue(new Error("membership unavailable")),
    } as unknown as TeleCryptIOStorage;

    await expect(declineInvite(storage, "!invite-unreadable:example.test")).rejects.toThrow(
      "decline failed",
    );
    expect(client.leave).not.toHaveBeenCalled();
    expect(client.forget).not.toHaveBeenCalled();
  });

  it("does not decline joined or nested rooms", async () => {
    const leave = vi.fn();
    const forget = vi.fn();
    const storage = {
      getClient: () => ({ getRoom: vi.fn(() => undefined), leave, forget, store: { removeRoom: vi.fn() } }),
      getTree: () => ({ id: "!nested:example.test", isTopLevel: false }),
      refreshRoomState: vi.fn().mockResolvedValue(undefined),
      getRoomMembership: vi.fn().mockResolvedValue("invite"),
    } as unknown as TeleCryptIOStorage;

    await expect(declineInvite(storage, "!nested:example.test")).rejects.toThrow("decline failed");
    expect(leave).not.toHaveBeenCalled();
    expect(forget).not.toHaveBeenCalled();
  });

  it("does not decline a stale top-level view when the invite is currently nested", async () => {
    const leave = vi.fn();
    const forget = vi.fn();
    const room = reviewedInviteRoom({
      currentState: {
        getStateEvents: (type: string, stateKey: string) => {
          if (type === EventType.SpaceParent) return { getContent: () => ({ via: ["example.test"] }) };
          if (type === EventType.RoomCreate) return { getContent: () => ({ type: "m.space" }) };
          if (type === UNSTABLE_MSC3088_PURPOSE.name && stateKey === UNSTABLE_MSC3089_TREE_SUBTYPE.name) {
            return { getContent: () => ({ [UNSTABLE_MSC3088_ENABLED.name]: true }) };
          }
          return null;
        },
      },
    });
    const storage = {
      getClient: () => ({ getRoom: vi.fn(() => room), leave, forget, store: { removeRoom: vi.fn() } }),
      getTree: () => ({ id: "!nested-race:example.test", isTopLevel: true }),
      refreshRoomState: vi.fn().mockResolvedValue(undefined),
      getRoomMembership: vi.fn().mockResolvedValue("invite"),
    } as unknown as TeleCryptIOStorage;

    await expect(declineInvite(storage, "!nested-race:example.test")).rejects.toThrow("decline failed");
    expect(leave).not.toHaveBeenCalled();
    expect(forget).not.toHaveBeenCalled();
  });

  it("refreshes the exact room before reporting a renamed folder", async () => {
    const tree = makeTree("!rename:example.test", "Child", false);
    tree.setName = vi.fn().mockResolvedValue(undefined);
    const refreshRoomState = vi.fn(async () => {
      (tree.room as { name: string }).name = "Renamed";
    });
    const storage = {
      getTree: () => tree,
      refreshRoomState,
    } as unknown as TeleCryptIOStorage;

    await expect(renameFolder(storage, tree.id, "Renamed")).resolves.toEqual({
      id: tree.id,
      name: "Renamed",
    });
    expect(refreshRoomState).toHaveBeenCalledWith(
      tree.id,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("bounds direct room-state refreshes and forwards cancellation", async () => {
    const tree = makeTree("!state:example.test", "State", true);
    const room = { currentState: { setStateEvents: vi.fn() } };
    const signal = new AbortController().signal;
    const authedRequest = vi.fn().mockResolvedValue([]);
    const client = {
      getRoom: () => room,
      http: { authedRequest },
    };
    const storage = new TeleCryptIOStorage(client as never);

    await storage.refreshRoomState(tree.id, { signal, timeoutMs: 1234 });
    expect(authedRequest).toHaveBeenCalledWith(
      "GET",
      `/rooms/${encodeURIComponent(tree.id)}/state`,
      undefined,
      undefined,
      { prefix: "/_matrix/client/v3", localTimeoutMs: 1234, abortSignal: signal },
    );
  });

  it("fails closed when an advanced client has no authenticated transport", async () => {
    const tree = makeTree("!no-http:example.test", "No HTTP", true);
    const storage = new TeleCryptIOStorage({
      getRoom: () => ({ currentState: { setStateEvents: vi.fn() } }),
    } as never);

    await expect(storage.refreshRoomState(tree.id)).rejects.toThrow("Matrix HTTP transport unavailable");
    await expect(storage.listMembers(tree)).rejects.toThrow("Matrix HTTP transport unavailable");
  });

  it("caps caller-provided Matrix request deadlines", async () => {
    const tree = makeTree("!timeout:example.test", "Timeout", true);
    const authedRequest = vi.fn().mockResolvedValue([]);
    const storage = new TeleCryptIOStorage({
      getRoom: () => ({ currentState: { setStateEvents: vi.fn() } }),
      http: { authedRequest },
    } as never);

    await storage.refreshRoomState(tree.id, { timeoutMs: Number.MAX_SAFE_INTEGER });
    expect(authedRequest).toHaveBeenCalledWith(
      "GET",
      `/rooms/${encodeURIComponent(tree.id)}/state`,
      undefined,
      undefined,
      { prefix: "/_matrix/client/v3", localTimeoutMs: 30_000, abortSignal: undefined },
    );
  });

  it("fails closed when authoritative power-level retrieval fails", async () => {
    const tree = makeTree("!members:example.test", "Members", true);
    const authedRequest = vi.fn(async (_method: string, path: string) => {
      if (path.endsWith("/members")) return { chunk: [] };
      throw new Error("power unavailable");
    });
    const storage = new TeleCryptIOStorage({ http: { authedRequest } } as never);

    await expect(storage.listMembers(tree)).rejects.toThrow("power unavailable");
    expect(authedRequest).toHaveBeenCalledTimes(2);
  });

  it("uses the authoritative joined-room inventory for deletion refreshes", async () => {
    const authedRequest = vi.fn().mockResolvedValue({ joined_rooms: ["!authoritative:example.test"] });
    const storage = new TeleCryptIOStorage({ http: { authedRequest } } as never);
    await expect(storage.listJoinedRoomIds({ timeoutMs: 1234 })).resolves.toEqual([
      "!authoritative:example.test",
    ]);
    expect(authedRequest).toHaveBeenCalledWith(
      "GET",
      "/joined_rooms",
      undefined,
      undefined,
      { prefix: "/_matrix/client/v3", localTimeoutMs: 1234, abortSignal: undefined },
    );
  });

  it("does not issue a join when authoritative membership is already joined", async () => {
    const joinRoom = vi.fn();
    const storage = {
      getRoomMembership: vi.fn().mockResolvedValue("join"),
      getClient: () => ({ joinRoom }),
    } as unknown as TeleCryptIOStorage;

    await expect(joinVault(storage, "!joined:example.test")).resolves.toEqual({
      vaultId: "!joined:example.test",
      joined: true,
    });
    expect(joinRoom).not.toHaveBeenCalled();
  });

  it("suppresses join M_FORBIDDEN only after authoritative recheck confirms join", async () => {
    const storage = {
      getRoomMembership: vi.fn()
        .mockResolvedValueOnce("invite")
        .mockResolvedValueOnce("join"),
      getClient: () => ({
        joinRoom: vi.fn().mockRejectedValue(new MatrixError({ errcode: "M_FORBIDDEN" }, 403)),
      }),
    } as unknown as TeleCryptIOStorage;

    await expect(joinVault(storage, "!race:example.test")).resolves.toEqual({
      vaultId: "!race:example.test",
      joined: true,
    });
  });

  it.each([
    ["huge", Number.MAX_SAFE_INTEGER, 30_000],
    ["NaN", Number.NaN, 15_000],
    ["negative", -1, 15_000],
  ])("bounds %s server retry delays", async (_label, advised, expectedDelay) => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const rateLimited = Object.assign(new Error("provider detail must not escape"), {
        isRateLimitError: () => true,
        getRetryAfterMs: () => advised,
      });
      const storage = {
        getRoomMembership: vi.fn().mockResolvedValue("invite"),
        getClient: () => ({ joinRoom: vi.fn().mockRejectedValue(rateLimited) }),
      } as unknown as TeleCryptIOStorage;
      const pending = joinVault(storage, "!limited:example.test");
      await vi.advanceTimersByTimeAsync(0);
      expect(setTimeoutSpy.mock.calls.some((call) => call[1] === expectedDelay)).toBe(true);
      const assertion = expect(pending).rejects.toThrow("join failed");
      await vi.advanceTimersByTimeAsync(90_000);
      await assertion;
    } finally {
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("refuses a nonempty tree before mutating any room", async () => {
    const late = makeTree("!late:example.test", "Late", false);
    const child = makeTree("!child:example.test", "Child", false);
    const root = makeTree("!root:example.test", "Root", true);
    root.delete = vi.fn();
    let children: TreeSpace[] = [child];
    child.getDirectories = () => [root];
    root.getDirectories = () => children;
    const room = (roomId: string) => ({
      getMembers: () => [],
      getMyMembership: () => "join",
      currentState: {
        getStateEvents: (_type: string, stateKey: string) => {
          if (roomId === root.id && stateKey === child.id) {
            return { getId: () => "$root-child", getContent: () => ({ via: ["example.test"] }) };
          }
          if (roomId === child.id && stateKey === root.id) {
            return { getId: () => "$child-root", getContent: () => ({ via: ["example.test"] }) };
          }
          return null;
        },
      },
    });
    const leave = vi.fn(async (roomId: string) => {
      if (roomId === child.id) children = [child, late];
      return {};
    });
    const trees = new Map([
      [root.id, root],
      [child.id, child],
      [late.id, late],
    ]);
    const client = {
      getUserId: () => "@owner:example.test",
      getRoom: (roomId: string) => trees.has(roomId) ? room(roomId) : null,
      getRooms: () => [...trees.keys()].map((roomId) => ({ roomId, ...room(roomId) })),
      unstableGetFileTreeSpace: (roomId: string) => trees.get(roomId) ?? null,
      kick: vi.fn(async () => ({})),
      leave,
      forget: vi.fn(async () => undefined),
      redactEvent: vi.fn(async () => ({})),
      http: {
        authedRequest: vi.fn(async (_method: string, path: string) =>
          path.endsWith("/joined_rooms")
            ? { joined_rooms: [root.id] }
            : path.endsWith("/members")
            ? { chunk: [] }
            : path.includes("m.room.power_levels")
              ? {}
              : [],
        ),
      },
    };

    const storage = new TeleCryptIOStorage(client as never);

    await expect(deleteVault(storage, root.id)).rejects.toMatchObject({
      code: "NON_EMPTY_TREE",
      treeId: root.id,
    });
    expect(root.delete).not.toHaveBeenCalled();
    expect(client.forget).not.toHaveBeenCalled();
    expect(client.redactEvent).not.toHaveBeenCalled();

    await expect(deleteVault(storage, root.id)).rejects.toMatchObject({
      code: "NON_EMPTY_TREE",
      treeId: root.id,
    });
    expect(client.forget).not.toHaveBeenCalled();
  });

  it("requires explicit file deletion before deleting a vault", async () => {
    const root = makeTree("!file-bearing:example.test", "WithFile", true);
    root.listAllFiles = () => [{ id: "$file", getName: () => "payload.bin" }] as never;
    const room = {
      roomId: root.id,
      getMyMembership: () => "join",
      currentState: { getStateEvents: () => [] },
    };
    const forget = vi.fn();
    const client = {
      getUserId: () => "@owner:example.test",
      getRoom: () => room,
      getRooms: () => [room],
      unstableGetFileTreeSpace: () => root,
      leave: vi.fn(),
      forget,
      http: {
        authedRequest: vi.fn(async (_method: string, path: string) =>
          path.endsWith("/joined_rooms") ? { joined_rooms: [root.id] } : path.endsWith("/members") ? { chunk: [] } : [],
        ),
      },
    };

    await expect(deleteVault(new TeleCryptIOStorage(client as never), root.id)).rejects.toMatchObject({
      code: "NON_EMPTY_TREE",
      treeId: root.id,
    });
    expect(forget).not.toHaveBeenCalled();
  });

  it("refuses a tree with multiple child folders before partial deletion is possible", async () => {
    const root = makeTree("!partial-delete-root:example.test", "Root", true);
    const first = makeTree("!partial-delete-first:example.test", "First", false);
    const second = makeTree("!partial-delete-second:example.test", "Second", false);
    root.getDirectories = () => [first, second];
    const relationEvents = new Map<string, { getStateKey: () => string; getId: () => string; getContent: () => object }>();
    const putRelation = (roomId: string, eventType: string, stateKey: string, eventId: string) => {
      relationEvents.set(`${roomId}\u0000${eventType}\u0000${stateKey}`, {
        getStateKey: () => stateKey,
        getId: () => eventId,
        getContent: () => ({ via: ["example.test"] }),
      });
    };
    putRelation(root.id, EventType.SpaceChild, first.id, "$root-first");
    putRelation(first.id, EventType.SpaceParent, root.id, "$first-root");
    putRelation(root.id, EventType.SpaceChild, second.id, "$root-second");
    putRelation(second.id, EventType.SpaceParent, root.id, "$second-root");
    const makeRoom = (roomId: string) => ({
      roomId,
      getMyMembership: () => "join",
      currentState: {
        setStateEvents: vi.fn(),
        getStateEvents: (eventType: string, stateKey?: string) => {
          if (stateKey !== undefined) {
            return relationEvents.get(`${roomId}\u0000${eventType}\u0000${stateKey}`) ?? null;
          }
          return [...relationEvents.entries()]
            .filter(([key]) => key.startsWith(`${roomId}\u0000${eventType}\u0000`))
            .map(([, event]) => event);
        },
      },
    });
    const rooms = new Map([
      [root.id, makeRoom(root.id)],
      [first.id, makeRoom(first.id)],
      [second.id, makeRoom(second.id)],
    ]);
    const forget = vi.fn(async (roomId: string) => {
      void roomId;
    });
    const client = {
      getUserId: () => "@owner:example.test",
      getRoom: (roomId: string) => rooms.get(roomId) ?? null,
      getRooms: () => [...rooms.values()],
      unstableGetFileTreeSpace: (roomId: string) =>
        roomId === root.id ? root : roomId === first.id ? first : roomId === second.id ? second : null,
      leave: vi.fn().mockResolvedValue(undefined),
      forget,
      http: {
        authedRequest: vi.fn(async (_method: string, path: string) =>
          path.endsWith("/joined_rooms")
            ? { joined_rooms: [root.id, first.id, second.id] }
            : path.endsWith("/members")
            ? { chunk: [] }
            : path.includes("m.room.power_levels")
              ? {}
              : [],
        ),
      },
    };
    const storage = new TeleCryptIOStorage(client as never);

    await expect(deleteVault(storage, root.id)).rejects.toMatchObject({
      code: "NON_EMPTY_TREE",
      treeId: root.id,
    });
    expect(forget).not.toHaveBeenCalled();
  });

  it("fails closed without mutating a folder shared by an external parent", async () => {
    const child = makeTree("!shared-child:example.test", "Child", false);
    const root = makeTree("!shared-root:example.test", "Root", true);
    root.getDirectories = () => [child];
    const externalId = "!external-parent:example.test";
    const events = new Map<string, object>([
      [
        `${EventType.SpaceChild}\u0000${child.id}`,
        { getStateKey: () => child.id, getContent: () => ({ via: ["example.test"] }) },
      ],
      [
        `${EventType.SpaceParent}\u0000${root.id}`,
        { getStateKey: () => root.id, getContent: () => ({ via: ["example.test"] }) },
      ],
      [
        `${EventType.SpaceChild}\u0000${externalId}\u0000${child.id}`,
        { getStateKey: () => child.id, getContent: () => ({ via: ["example.test"] }) },
      ],
    ]);
    const makeRoom = (roomId: string) => ({
      roomId,
      getMembers: () => [],
      getMyMembership: () => "join",
      currentState: {
        getStateEvents: (eventType: string, stateKey?: string) => {
          if (stateKey !== undefined) return events.get(`${eventType}\u0000${stateKey}`) ?? null;
          return [...events.entries()]
            .filter(([key]) => key.startsWith(`${eventType}\u0000${roomId}\u0000`) || (roomId === root.id && key === `${eventType}\u0000${child.id}`) || (roomId === child.id && key === `${eventType}\u0000${root.id}`))
            .map(([, event]) => event);
        },
      },
    });
    const rooms = new Map([
      [root.id, makeRoom(root.id)],
      [child.id, makeRoom(child.id)],
      [externalId, makeRoom(externalId)],
    ]);
    const client = {
      getUserId: () => "@owner:example.test",
      getRoom: (roomId: string) => rooms.get(roomId) ?? null,
      getRooms: () => [...rooms.values()],
      unstableGetFileTreeSpace: (roomId: string) =>
        roomId === root.id ? root : roomId === child.id ? child : null,
      kick: vi.fn(),
      leave: vi.fn(),
      forget: vi.fn(),
      redactEvent: vi.fn(),
      http: {
        authedRequest: vi.fn(async (_method: string, path: string) =>
          path.endsWith("/joined_rooms")
            ? { joined_rooms: [root.id] }
            : path.endsWith("/members")
            ? { chunk: [] }
            : path.includes("m.room.power_levels")
              ? {}
              : [],
        ),
      },
    };

    await expect(deleteVault(new TeleCryptIOStorage(client as never), root.id)).rejects.toMatchObject({
      code: "NON_EMPTY_TREE",
      treeId: root.id,
    });
    expect(client.kick).not.toHaveBeenCalled();
    expect(client.leave).not.toHaveBeenCalled();
    expect(client.forget).not.toHaveBeenCalled();
    expect(client.redactEvent).not.toHaveBeenCalled();
  });

  it("unlinks one validated external parent only after child deletion", async () => {
    const child = makeTree("!nested-child:example.test", "Child", false);
    const root = makeTree("!nested-root:example.test", "Root", false);
    const externalId = "!external-parent:example.test";
    root.getDirectories = () => [child];
    const eventMap = new Map<string, { getStateKey: () => string; getContent: () => object }>();
    const put = (roomId: string, eventType: string, stateKey: string, content: object) => {
      eventMap.set(`${roomId}\u0000${eventType}\u0000${stateKey}`, {
        getStateKey: () => stateKey,
        getContent: () => content,
      });
    };
    put(externalId, EventType.SpaceChild, root.id, { via: ["example.test"] });
    put(root.id, EventType.SpaceParent, externalId, { via: ["example.test"] });
    put(root.id, EventType.SpaceChild, child.id, { via: ["example.test"] });
    put(child.id, EventType.SpaceParent, root.id, { via: ["example.test"] });
    const makeRoom = (roomId: string) => ({
      roomId,
      getMembers: () => [],
      getMyMembership: () => "join",
      currentState: {
        setStateEvents: vi.fn(),
        getStateEvents: (eventType: string, stateKey?: string) => {
          const prefix = `${roomId}\u0000${eventType}\u0000`;
          if (stateKey !== undefined) return eventMap.get(`${prefix}${stateKey}`) ?? null;
          return [...eventMap.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([, event]) => event);
        },
      },
    });
    const rooms = new Map([
      [root.id, makeRoom(root.id)],
      [child.id, makeRoom(child.id)],
      [externalId, makeRoom(externalId)],
    ]);
    const client = {
      getUserId: () => "@owner:example.test",
      getRoom: (roomId: string) => rooms.get(roomId) ?? null,
      getRooms: () => [...rooms.values()],
      unstableGetFileTreeSpace: (roomId: string) =>
        roomId === root.id ? root : roomId === child.id ? child : null,
      sendStateEvent: vi.fn(async (roomId: string, eventType: string, content: object, stateKey: string) => {
        put(roomId, eventType, stateKey, content);
      }),
      leave: vi.fn().mockResolvedValue(undefined),
      forget: vi.fn().mockResolvedValue(undefined),
      http: {
        authedRequest: vi.fn(async (_method: string, path: string) =>
          path.endsWith("/joined_rooms")
            ? { joined_rooms: [root.id] }
            : path.endsWith("/members")
            ? { chunk: [] }
            : path.includes("m.room.power_levels")
              ? {}
              : [],
        ),
      },
    };

    await expect(deleteVault(new TeleCryptIOStorage(client as never), root.id)).rejects.toMatchObject({
      code: "NON_EMPTY_TREE",
      treeId: root.id,
    });
    expect(client.sendStateEvent).not.toHaveBeenCalled();
    expect(client.forget).not.toHaveBeenCalled();
  });

  it("rolls back a partial external unlink before reporting failure", async () => {
    const root = makeTree("!partial-root:example.test", "Root", false);
    const externalId = "!partial-parent:example.test";
    const active = { via: ["example.test"] };
    const links = new Map([
      ["child", active],
      ["parent", active],
    ]);
    const rootRoom = {
      roomId: root.id,
      getMembers: () => [],
      getMyMembership: () => "join",
      currentState: {
        setStateEvents: vi.fn(),
        getStateEvents: (eventType: string, stateKey?: string) => {
          if (eventType === EventType.SpaceParent && (stateKey === externalId || stateKey === undefined)) {
            return { getStateKey: () => externalId, getContent: () => links.get("parent") };
          }
          return [];
        },
      },
    };
    const externalRoom = {
      roomId: externalId,
      getMembers: () => [],
      getMyMembership: () => "join",
      currentState: {
        getStateEvents: (eventType: string, stateKey?: string) => {
          if (eventType === EventType.SpaceChild && (stateKey === root.id || stateKey === undefined)) {
            return { getStateKey: () => root.id, getContent: () => links.get("child") };
          }
          return [];
        },
      },
    };
    const rooms = new Map([[root.id, rootRoom], [externalId, externalRoom]]);
    const client = {
      getUserId: () => "@owner:example.test",
      getDomain: () => "example.test",
      getRoom: (roomId: string) => rooms.get(roomId) ?? null,
      getRooms: () => [...rooms.values()],
      unstableGetFileTreeSpace: (roomId: string) => (roomId === root.id ? root : null),
      sendStateEvent: vi.fn().mockImplementation(async (_roomId: string, eventType: string, content: object) => {
        if (eventType === EventType.SpaceChild && Object.keys(content).length === 0) {
          links.set("child", {});
          return;
        }
        if (eventType === EventType.SpaceParent && Object.keys(content).length === 0) {
          throw new Error("parent unlink failed");
        }
        if (eventType === EventType.SpaceChild) {
          links.set("child", active);
          return;
        }
        links.set("parent", active);
      }),
      leave: vi.fn(),
      forget: vi.fn(),
      http: {
        authedRequest: vi.fn(async (_method: string, path: string) =>
          path.endsWith("/joined_rooms")
            ? { joined_rooms: [root.id] }
            : path.endsWith("/members")
            ? { chunk: [] }
            : path.includes("m.room.power_levels")
              ? {}
              : [],
        ),
      },
    };

    await expect(deleteVault(new TeleCryptIOStorage(client as never), root.id)).rejects.toThrow("delete failed");
    expect(client.leave).not.toHaveBeenCalled();
    expect(client.forget).not.toHaveBeenCalled();
    expect(links.get("child")).toEqual(active);
    expect(links.get("parent")).toEqual(active);
    expect(client.sendStateEvent).toHaveBeenCalledTimes(4);
  });

  it("handles a typed kick race only when the member is no longer active", async () => {
    const root = makeTree("!root-race:example.test", "Root", true);
    const member = { userId: "@target:example.test", membership: "join" };
    const room = {
      roomId: root.id,
      getMembers: vi.fn(() => [member]),
      getMyMembership: () => "join",
      currentState: { getStateEvents: () => [] },
    };
    const client = {
      getUserId: () => "@owner:example.test",
      getRoom: () => room,
      getRooms: () => [room],
      unstableGetFileTreeSpace: () => root,
      kick: vi.fn().mockImplementation(async () => {
        member.membership = "leave";
        throw new MatrixError({ errcode: "M_FORBIDDEN" }, 403);
      }),
      leave: vi.fn().mockResolvedValue({}),
      forget: vi.fn().mockResolvedValue(undefined),
      http: {
        authedRequest: vi.fn(async (_method: string, path: string) =>
          path.endsWith("/joined_rooms")
            ? { joined_rooms: [root.id] }
            : path.endsWith("/members")
            ? {
                chunk: [
                  { state_key: "@owner:example.test", content: { membership: "join" } },
                  { state_key: member.userId, content: { membership: member.membership } },
                ],
              }
            : path.includes("m.room.power_levels")
              ? {}
              : [],
        ),
      },
    };
    room.getMembers.mockReturnValueOnce([member]).mockReturnValueOnce([
      { userId: member.userId, membership: "leave" },
    ]);

    await expect(deleteVault(new TeleCryptIOStorage(client as never), root.id)).resolves.toEqual({
      id: root.id,
      deleted: true,
    });
  });

  it("suppresses only typed M_FORBIDDEN after authoritative membership confirms the target", async () => {
    const tree = makeTree("!vault:example.test", "Vault", true);
    tree.invite = vi.fn().mockRejectedValue(new MatrixError({ errcode: "M_FORBIDDEN" }, 403));
    tree.setPermissions = vi.fn().mockResolvedValue(undefined);
    const storage = {
      getTree: () => tree,
      getClient: () => ({ getUserId: () => "@owner:example.test" }),
      refreshRoomState: vi.fn().mockResolvedValue(undefined),
      getRoomMembership: vi.fn().mockResolvedValue("join"),
      listMembers: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { userId: "@target:example.test", membership: "join", role: "viewer" },
        ]),
    } as unknown as TeleCryptIOStorage;

    await expect(shareVault(storage, tree.id, "@target:example.test", "editor")).resolves.toEqual({
      vaultId: tree.id,
      userId: "@target:example.test",
      role: "editor",
    });
    expect(tree.setPermissions).toHaveBeenCalledWith("@target:example.test", "editor");
  });

  it("does not infer an existing member from arbitrary error text", async () => {
    const tree = makeTree("!vault:example.test", "Vault", true);
    const failure = new Error("already in the room, secret=do-not-ignore");
    tree.invite = vi.fn().mockRejectedValue(failure);
    tree.setPermissions = vi.fn();
    const storage = {
      getTree: () => tree,
      getClient: () => ({ getUserId: () => "@owner:example.test" }),
      refreshRoomState: vi.fn().mockResolvedValue(undefined),
      listMembers: vi.fn().mockResolvedValue([]),
    } as unknown as TeleCryptIOStorage;

    await expect(shareVault(storage, tree.id, "@target:example.test", "viewer")).rejects.toThrow(
      "share failed",
    );
    expect(tree.setPermissions).not.toHaveBeenCalled();
  });

  it("applies share and unshare across every known nested room", async () => {
    const child = makeTree("!child-share:example.test", "Child", false);
    const root = makeTree("!root-share:example.test", "Root", true);
    root.getDirectories = () => [child];
    root.invite = vi.fn().mockResolvedValue(undefined);
    root.setPermissions = vi.fn().mockResolvedValue(undefined);
    child.setPermissions = vi.fn().mockResolvedValue(undefined);
    const client = {
      getUserId: () => "@owner:example.test",
      kick: vi.fn().mockResolvedValue(undefined),
    };
    const storage = {
      getTree: () => root,
      getClient: () => client,
      refreshRoomState: vi.fn().mockResolvedValue(undefined),
      listMembers: vi.fn().mockResolvedValue([]),
      getRoomMembership: vi.fn().mockResolvedValue("join"),
    } as unknown as TeleCryptIOStorage;

    await expect(shareVault(storage, root.id, "@target:example.test", "editor")).resolves.toEqual({
      vaultId: root.id,
      userId: "@target:example.test",
      role: "editor",
    });
    expect(root.invite).toHaveBeenCalledWith("@target:example.test");
    expect(root.setPermissions).toHaveBeenCalledWith("@target:example.test", "editor");
    expect(child.setPermissions).toHaveBeenCalledWith("@target:example.test", "editor");

    await expect(unshareVault(storage, root.id, "@target:example.test")).resolves.toEqual({
      vaultId: root.id,
      userId: "@target:example.test",
      removed: true,
    });
    expect(client.kick.mock.calls.map(([roomId]) => roomId).sort()).toEqual([child.id, root.id].sort());
  });

  it("invites a user separately when a nested room is not yet joined", async () => {
    const child = makeTree("!child-share-invite:example.test", "Child", false);
    const root = makeTree("!root-share-invite:example.test", "Root", true);
    root.getDirectories = () => [child];
    root.invite = vi.fn().mockResolvedValue(undefined);
    child.invite = vi.fn().mockResolvedValue(undefined);
    root.setPermissions = vi.fn().mockResolvedValue(undefined);
    child.setPermissions = vi.fn().mockResolvedValue(undefined);
    const storage = {
      getTree: () => root,
      getClient: () => ({ getUserId: () => "@owner:example.test" }),
      refreshRoomState: vi.fn().mockResolvedValue(undefined),
      listMembers: vi.fn().mockResolvedValue([]),
      getRoomMembership: vi.fn().mockImplementation(async (roomId: string) =>
        roomId === child.id ? null : "join"),
    } as unknown as TeleCryptIOStorage;

    await expect(shareVault(storage, root.id, "@target:example.test", "viewer")).resolves.toEqual({
      vaultId: root.id,
      userId: "@target:example.test",
      role: "viewer",
    });
    expect(root.invite).toHaveBeenCalledWith("@target:example.test");
    expect(child.invite).toHaveBeenCalledWith("@target:example.test");
  });

  it("rejects self-sharing and self-unsharing before a membership mutation", async () => {
    const root = makeTree("!self:example.test", "Root", true);
    const kick = vi.fn();
    const storage = {
      getTree: () => root,
      getClient: () => ({ getUserId: () => "@owner:example.test", kick }),
      refreshRoomState: vi.fn().mockResolvedValue(undefined),
      listMembers: vi.fn().mockResolvedValue([]),
      getRoomMembership: vi.fn().mockResolvedValue("join"),
    } as unknown as TeleCryptIOStorage;

    await expect(shareVault(storage, root.id, "@owner:example.test", "viewer")).rejects.toThrow(
      "current user",
    );
    await expect(unshareVault(storage, root.id, "@owner:example.test")).rejects.toThrow(
      "current user",
    );
    expect(kick).not.toHaveBeenCalled();
  });

  it("refuses to kick an existing owner during unshare", async () => {
    const root = makeTree("!owner:example.test", "Root", true);
    const kick = vi.fn();
    const storage = {
      getTree: () => root,
      getClient: () => ({ getUserId: () => "@admin:example.test", kick }),
      refreshRoomState: vi.fn().mockResolvedValue(undefined),
      listMembers: vi.fn().mockResolvedValue([
        { userId: "@owner:example.test", role: "owner", membership: "join" },
      ]),
      getRoomMembership: vi.fn().mockResolvedValue("join"),
    } as unknown as TeleCryptIOStorage;

    await expect(unshareVault(storage, root.id, "@owner:example.test")).rejects.toThrow(
      "existing owner",
    );
    expect(kick).not.toHaveBeenCalled();
  });

  it("refuses to demote an owner discovered in a descendant during share", async () => {
    const child = makeTree("!child-owner:example.test", "Child", false);
    const root = makeTree("!root-owner:example.test", "Root", true);
    root.getDirectories = () => [child];
    root.invite = vi.fn().mockResolvedValue(undefined);
    root.setPermissions = vi.fn().mockResolvedValue(undefined);
    child.setPermissions = vi.fn().mockResolvedValue(undefined);
    const storage = {
      getTree: () => root,
      getClient: () => ({ getUserId: () => "@admin:example.test" }),
      refreshRoomState: vi.fn().mockResolvedValue(undefined),
      listMembers: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ userId: "@target:example.test", role: "owner", membership: "join" }]),
      getRoomMembership: vi.fn().mockResolvedValue("join"),
    } as unknown as TeleCryptIOStorage;

    await expect(shareVault(storage, root.id, "@target:example.test", "viewer")).rejects.toThrow(
      "existing owner",
    );
    expect(child.setPermissions).not.toHaveBeenCalled();
  });

  it("reports share as partial after an earlier room permission commit", async () => {
    const child = makeTree("!child-share-partial:example.test", "Child", false);
    const root = makeTree("!root-share-partial:example.test", "Root", true);
    root.getDirectories = () => [child];
    root.invite = vi.fn().mockResolvedValue(undefined);
    root.setPermissions = vi.fn().mockResolvedValue(undefined);
    child.setPermissions = vi.fn().mockRejectedValue(new Error("child permission failed"));
    const storage = {
      getTree: () => root,
      getClient: () => ({ getUserId: () => "@owner:example.test" }),
      refreshRoomState: vi.fn().mockResolvedValue(undefined),
      listMembers: vi.fn().mockResolvedValue([]),
      getRoomMembership: vi.fn().mockResolvedValue("join"),
    } as unknown as TeleCryptIOStorage;

    await expect(shareVault(storage, root.id, "@target:example.test", "editor")).rejects.toMatchObject({
      code: "MUTATION_PARTIAL",
      operation: "share",
      completedIds: [root.id],
    });
  });

  it("reports unshare as partial after an earlier room membership commit", async () => {
    const child = makeTree("!child-unshare-partial:example.test", "Child", false);
    const root = makeTree("!root-unshare-partial:example.test", "Root", true);
    root.getDirectories = () => [child];
    const kick = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("child kick failed"));
    const storage = {
      getTree: () => root,
      getClient: () => ({ getUserId: () => "@owner:example.test", kick }),
      refreshRoomState: vi.fn().mockResolvedValue(undefined),
      listMembers: vi.fn().mockResolvedValue([]),
      getRoomMembership: vi.fn().mockResolvedValue("join"),
    } as unknown as TeleCryptIOStorage;

    let caught: unknown;
    try {
      await unshareVault(storage, root.id, "@target:example.test");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MutationPartialError);
    expect(caught).toMatchObject({
      code: "MUTATION_PARTIAL",
      operation: "unshare",
      completedIds: [root.id],
    });
  });
});
