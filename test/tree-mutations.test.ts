import { describe, expect, it, vi } from "vitest";
import {
  TeleCryptIOStorage,
  type TreeSpace,
  withMatrixMutationAbort,
  withTreeMutation,
} from "../src/TeleCryptIOStorage.js";
import { RoomCleanupIncompleteError } from "../src/core/errors.js";

function tree(id: string, name: string, isTopLevel: boolean): TreeSpace {
  return {
    id,
    room: { name },
    isTopLevel,
    getDirectories: () => [],
  } as unknown as TreeSpace;
}

describe("tree mutations", () => {
  it("routes createDirectory through the linked-subtree path and refreshes both rooms", async () => {
    const parentRoom = {
      name: "Parent",
      currentState: { setStateEvents: vi.fn(), getStateEvents: vi.fn(() => []) },
    };
    const childRoom = {
      name: "Child",
      currentState: { setStateEvents: vi.fn(), getStateEvents: vi.fn(() => []) },
    };
    const parent = { ...tree("!parent:example.test", "Parent", true), room: parentRoom } as unknown as TreeSpace;
    const child = { ...tree("!child:example.test", "Child", false), room: childRoom } as unknown as TreeSpace;
    const rooms = [{ roomId: parent.id }];
    const trees = new Map([[parent.id, parent]]);
    const client = {
      getUserId: () => "@alice:example.test",
      getDomain: () => "example.test",
      getRooms: () => rooms,
      getRoom: (roomId: string) => roomId === parent.id ? parentRoom : roomId === child.id ? childRoom : null,
      createRoom: vi.fn(async () => {
        rooms.push({ roomId: child.id });
        trees.set(child.id, child);
        return { room_id: child.id };
      }),
      unstableGetFileTreeSpace: vi.fn((roomId: string) => trees.get(roomId) ?? null),
      sendStateEvent: vi.fn().mockResolvedValue(undefined),
      http: { authedRequest: vi.fn(async () => []) },
    };
    const storage = new TeleCryptIOStorage(client as never);
    const decoratedParent = storage.getTree(parent.id)!;

    await expect(decoratedParent.createDirectory("Child")).resolves.toBe(child);
    expect(client.http.authedRequest).toHaveBeenCalledWith(
      "GET",
      `/rooms/${encodeURIComponent(parent.id)}/state`,
      undefined,
      undefined,
      expect.any(Object),
    );
  });

  it("serializes all mutations for one client through one queue", async () => {
    const client = {} as never;
    const events: string[] = [];
    let releaseFirst!: () => void;
    const first = withTreeMutation(client, async () => {
      events.push("first:start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push("first:end");
    });
    const second = withTreeMutation(client, async () => {
      events.push("second");
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });

  it("cancels a queued mutation without aborting the active one", async () => {
    const abort = vi.fn();
    const client = { http: { abort } } as never;
    let releaseFirst!: () => void;
    const first = withTreeMutation(client, async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return "first";
    });
    const controller = new AbortController();
    let secondStarted = false;
    const second = withTreeMutation(
      client,
      async () => {
        secondStarted = true;
        return "second";
      },
      controller.signal,
    );
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    releaseFirst();
    await expect(first).resolves.toBe("first");
    await expect(second).rejects.toThrow("operation cancelled");
    expect(secondStarted).toBe(false);
    expect(abort).not.toHaveBeenCalled();
  });

  it("waits for an active mutation and reports an unknown outcome after cancellation", async () => {
    const controller = new AbortController();
    let release!: () => void;
    const pending = withMatrixMutationAbort(
      {} as never,
      () => new Promise<string>((resolve) => {
        release = () => resolve("committed");
      }),
      controller.signal,
    );
    controller.abort();
    let settled = false;
    void pending.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(pending).rejects.toMatchObject({ code: "MUTATION_OUTCOME_UNKNOWN" });
  });

  it("uses the exact createRoom ID instead of scanning newly observed rooms", async () => {
    const existing = tree("!existing:example.test", "Existing", true);
    const created = tree("!created:example.test", "Created", true);
    const rooms = [{ roomId: existing.id }];
    const trees = new Map([[existing.id, existing]]);
    const unstableCreateFileTree = vi.fn(() => {
      throw new Error("unstableCreateFileTree must not be used");
    });
    const client = {
      getUserId: () => "@alice:example.test",
      getDomain: () => "example.test",
      getRooms: () => rooms,
      createRoom: vi.fn(async (options: Record<string, unknown>) => {
        expect(options.creation_content).toEqual({ type: "m.space" });
        rooms.push({ roomId: created.id });
        trees.set(created.id, created);
        return { room_id: created.id };
      }),
      unstableCreateFileTree,
      unstableGetFileTreeSpace: vi.fn((roomId: string) => trees.get(roomId) ?? null),
    };
    const storage = new TeleCryptIOStorage(client as never);

    await expect(storage.createTree("Created")).resolves.toBe(created);
    expect(client.createRoom).toHaveBeenCalledTimes(1);
    expect(unstableCreateFileTree).not.toHaveBeenCalled();
    expect(client.unstableGetFileTreeSpace).toHaveBeenCalledWith(created.id);
  });

  it("rejects unsafe tree names before creating a room", async () => {
    const client = {
      getUserId: () => "@alice:example.test",
      createRoom: vi.fn(),
    };
    await expect(new TeleCryptIOStorage(client as never).createTree("bad\nname")).rejects.toThrow(
      "invalid name",
    );
    expect(client.createRoom).not.toHaveBeenCalled();
  });

  it("rejects an invalid room identifier before reusing a createRoom response", async () => {
    const client = {
      getUserId: () => "@alice:example.test",
      getDomain: () => "example.test",
      createRoom: vi.fn(async () => ({ room_id: "$not-a-room-id" })),
      unstableGetFileTreeSpace: vi.fn(),
    };
    const storage = new TeleCryptIOStorage(client as never);

    await expect(storage.createTree("Invalid response")).rejects.toMatchObject({
      code: "ROOM_CREATION_AMBIGUOUS",
    });
    expect(client.unstableGetFileTreeSpace).not.toHaveBeenCalled();
  });

  it("serializes same-name top-level creation while returning distinct rooms", async () => {
    const created = [
      tree("!created-one:example.test", "Same", true),
      tree("!created-two:example.test", "Same", true),
    ];
    const rooms: { roomId: string }[] = [];
    const trees = new Map<string, TreeSpace>();
    let createCount = 0;
    const client = {
      getUserId: () => "@alice:example.test",
      getDomain: () => "example.test",
      getRooms: () => rooms,
      createRoom: vi.fn(async () => {
        const next = created[createCount];
        createCount += 1;
        rooms.push({ roomId: next.id });
        trees.set(next.id, next);
        return { room_id: next.id };
      }),
      unstableGetFileTreeSpace: vi.fn((roomId: string) => trees.get(roomId) ?? null),
    };
    const storage = new TeleCryptIOStorage(client as never);

    const [first, second] = await Promise.all([
      storage.createTree("Same"),
      storage.createTree("Same"),
    ]);
    expect(first).toBe(created[0]);
    expect(second).toBe(created[1]);
    expect(first.id).not.toBe(second.id);
    expect(createCount).toBe(2);
  });

  it("creates and links same-name children using each returned ID", async () => {
    const children: TreeSpace[] = [];
    const parent = {
      ...tree("!parent:example.test", "Parent", true),
      getDirectories: () => children,
      room: {
        name: "Parent",
        currentState: { setStateEvents: vi.fn() },
      },
    } as unknown as TreeSpace;
    const createdChildren = [
      tree("!child-one:example.test", "Child", false),
      tree("!child-two:example.test", "Child", false),
    ];
    const rooms = [{ roomId: parent.id }];
    const trees = new Map([[parent.id, parent]]);
    const client = {
      getUserId: () => "@alice:example.test",
      getDomain: () => "example.test",
      getRooms: () => rooms,
      getRoom: (roomId: string) => (roomId === parent.id ? parent.room : null),
      createRoom: vi.fn(async () => {
        const child = createdChildren[children.length];
        rooms.push({ roomId: child.id });
        trees.set(child.id, child);
        return { room_id: child.id };
      }),
      unstableGetFileTreeSpace: vi.fn((roomId: string) => trees.get(roomId) ?? null),
      sendStateEvent: vi.fn(async (_roomId: string, type: string, _content: unknown, stateKey: string) => {
        const child = createdChildren.find((candidate) => candidate.id === stateKey);
        if (type === "m.space.child" && child && !children.includes(child)) {
          children.push(child);
        }
      }),
      http: { authedRequest: vi.fn(async () => []) },
    };
    const storage = new TeleCryptIOStorage(client as never);

    const [first, second] = await Promise.all([
      storage.createSubtree(parent, "Child"),
      storage.createSubtree(parent, "Child"),
    ]);
    expect(first).toBe(createdChildren[0]);
    expect(second).toBe(createdChildren[1]);
    expect(first.id).not.toBe(second.id);
    expect(client.createRoom).toHaveBeenCalledTimes(2);
    expect(client.sendStateEvent).toHaveBeenCalledWith(
      parent.id,
      "m.space.child",
      { via: ["example.test"] },
      createdChildren[0].id,
    );
  });

  it("cleans the exact child and partial parent link when linking fails", async () => {
    const child = tree("!child-failed:example.test", "Child", false);
    const parentRoom = {
      currentState: {
        setStateEvents: vi.fn(),
        getStateEvents: vi.fn(() => ({
          getId: () => "$parent-link",
          getSender: () => "@alice:example.test",
        })),
      },
    };
    const parent = {
      ...tree("!parent-failed:example.test", "Parent", true),
      getDirectories: () => [],
      room: parentRoom,
    } as unknown as TreeSpace;
    const trees = new Map([[parent.id, parent], [child.id, child]]);
    const client = {
      getUserId: () => "@alice:example.test",
      getDomain: () => "example.test",
      getRooms: () => [{ roomId: parent.id }, { roomId: child.id }],
      getRoom: (roomId: string) => (roomId === parent.id ? parentRoom : null),
      createRoom: vi.fn(async () => ({ room_id: child.id })),
      unstableGetFileTreeSpace: vi.fn((roomId: string) => trees.get(roomId) ?? null),
      sendStateEvent: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("parent link failed")),
      redactEvent: vi.fn().mockResolvedValue(undefined),
      leave: vi.fn().mockResolvedValue(undefined),
      forget: vi.fn().mockResolvedValue(undefined),
      http: { authedRequest: vi.fn(async () => []) },
    };
    const storage = new TeleCryptIOStorage(client as never);

    await expect(storage.createSubtree(parent, "Child")).rejects.toThrow("parent link failed");
    expect(client.redactEvent).toHaveBeenCalledWith(parent.id, "$parent-link");
    expect(client.leave).toHaveBeenCalledWith(child.id);
    expect(client.forget).toHaveBeenCalledWith(child.id);
  });

  it("redacts a parent link committed before an ambiguous send failure", async () => {
    const child = tree("!child-ambiguous:example.test", "Child", false);
    const parentRoom = {
      currentState: {
        setStateEvents: vi.fn(),
        getStateEvents: vi.fn(() => ({
          getId: () => "$ambiguous-parent-link",
          getSender: () => "@alice:example.test",
        })),
      },
    };
    const parent = {
      ...tree("!parent-ambiguous:example.test", "Parent", true),
      getDirectories: () => [],
      room: parentRoom,
    } as unknown as TreeSpace;
    const trees = new Map([[parent.id, parent], [child.id, child]]);
    const client = {
      getUserId: () => "@alice:example.test",
      getDomain: () => "example.test",
      getRooms: () => [{ roomId: parent.id }, { roomId: child.id }],
      getRoom: (roomId: string) => (roomId === parent.id ? parentRoom : null),
      createRoom: vi.fn(async () => ({ room_id: child.id })),
      unstableGetFileTreeSpace: vi.fn((roomId: string) => trees.get(roomId) ?? null),
      // The server may have accepted this event even though the client saw a
      // transport failure and received no event_id.
      sendStateEvent: vi.fn().mockRejectedValue(new Error("ambiguous parent link failure")),
      redactEvent: vi.fn().mockResolvedValue(undefined),
      leave: vi.fn().mockResolvedValue(undefined),
      forget: vi.fn().mockResolvedValue(undefined),
      http: { authedRequest: vi.fn(async () => []) },
    };
    const storage = new TeleCryptIOStorage(client as never);

    await expect(storage.createSubtree(parent, "Child")).rejects.toThrow(
      "ambiguous parent link failure",
    );
    expect(client.http.authedRequest).toHaveBeenCalledWith(
      "GET",
      `/rooms/${encodeURIComponent(parent.id)}/state`,
      undefined,
      undefined,
      expect.any(Object),
    );
    expect(client.redactEvent).toHaveBeenCalledWith(parent.id, "$ambiguous-parent-link");
    expect(client.leave).toHaveBeenCalledWith(child.id);
    expect(client.forget).toHaveBeenCalledWith(child.id);
  });

  it("does not redact another actor's replacement relation during compensation", async () => {
    const child = tree("!child-foreign-link:example.test", "Child", false);
    const parentRoom = {
      currentState: {
        setStateEvents: vi.fn(),
        getStateEvents: vi.fn(() => ({
          getId: () => "$foreign-parent-link",
          getSender: () => "@mallory:example.test",
        })),
      },
    };
    const parent = {
      ...tree("!parent-foreign-link:example.test", "Parent", true),
      getDirectories: () => [],
      room: parentRoom,
    } as unknown as TreeSpace;
    const client = {
      getUserId: () => "@alice:example.test",
      getDomain: () => "example.test",
      getRooms: () => [{ roomId: parent.id }, { roomId: child.id }],
      getRoom: (roomId: string) => (roomId === parent.id ? parentRoom : null),
      createRoom: vi.fn(async () => ({ room_id: child.id })),
      unstableGetFileTreeSpace: vi.fn((roomId: string) => (roomId === parent.id ? parent : child)),
      sendStateEvent: vi.fn().mockRejectedValue(new Error("ambiguous parent link failure")),
      redactEvent: vi.fn().mockResolvedValue(undefined),
      leave: vi.fn().mockResolvedValue(undefined),
      forget: vi.fn().mockResolvedValue(undefined),
      http: { authedRequest: vi.fn(async () => []) },
    };
    const storage = new TeleCryptIOStorage(client as never);

    let caught: unknown;
    try {
      await storage.createSubtree(parent, "Child");
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ message: "ambiguous parent link failure", cleanupIncomplete: true });
    expect(client.redactEvent).not.toHaveBeenCalled();
    expect(client.leave).toHaveBeenCalledWith(child.id);
    expect(client.forget).toHaveBeenCalledWith(child.id);
  });

  it("rolls back a child-side parent link committed before an ambiguous send failure", async () => {
    const child = tree("!child-side-ambiguous:example.test", "Child", false);
    const parentRoom = {
      currentState: {
        setStateEvents: vi.fn(),
        getStateEvents: vi.fn(() => ({
          getId: () => "$parent-side-link",
          getSender: () => "@alice:example.test",
        })),
      },
    };
    const childRoom = {
      currentState: {
        setStateEvents: vi.fn(),
        getStateEvents: vi.fn(() => ({
          getId: () => "$child-side-link",
          getSender: () => "@alice:example.test",
        })),
      },
    };
    const parent = {
      ...tree("!parent-child-side:example.test", "Parent", true),
      getDirectories: () => [],
      room: parentRoom,
    } as unknown as TreeSpace;
    const trees = new Map([[parent.id, parent], [child.id, child]]);
    const client = {
      getUserId: () => "@alice:example.test",
      getDomain: () => "example.test",
      getRooms: () => [{ roomId: parent.id }, { roomId: child.id }],
      getRoom: (roomId: string) => (roomId === parent.id ? parentRoom : roomId === child.id ? childRoom : null),
      createRoom: vi.fn(async () => ({ room_id: child.id })),
      unstableGetFileTreeSpace: vi.fn((roomId: string) => trees.get(roomId) ?? null),
      sendStateEvent: vi.fn()
        .mockResolvedValueOnce({ event_id: "$parent-response-link" })
        .mockRejectedValueOnce(new Error("ambiguous child link failure")),
      redactEvent: vi.fn().mockResolvedValue(undefined),
      leave: vi.fn().mockResolvedValue(undefined),
      forget: vi.fn().mockResolvedValue(undefined),
      http: { authedRequest: vi.fn(async () => []) },
    };
    const storage = new TeleCryptIOStorage(client as never);

    await expect(storage.createSubtree(parent, "Child")).rejects.toThrow(
      "ambiguous child link failure",
    );
    expect(client.redactEvent).toHaveBeenCalledWith(parent.id, "$parent-response-link");
    expect(client.redactEvent).toHaveBeenCalledWith(child.id, "$child-side-link");
    expect(client.leave).toHaveBeenCalledWith(child.id);
    expect(client.forget).toHaveBeenCalledWith(child.id);
  });

  it("reports incomplete cleanup when child-side redaction leaves a live parent link", async () => {
    const child = tree("!child-side-stale:example.test", "Child", false);
    const parentRoom = {
      currentState: {
        setStateEvents: vi.fn(),
        getStateEvents: vi.fn(() => ({
          getId: () => "$parent-link",
          getContent: () => ({}),
        })),
      },
    };
    const childRoom = {
      currentState: {
        setStateEvents: vi.fn(),
        getStateEvents: vi.fn(() => ({
          getId: () => "$child-link",
          getContent: () => ({ via: ["example.test"] }),
        })),
      },
    };
    const parent = {
      ...tree("!parent-child-side-stale:example.test", "Parent", true),
      getDirectories: () => [],
      room: parentRoom,
    } as unknown as TreeSpace;
    const trees = new Map([[parent.id, parent], [child.id, child]]);
    let refreshCount = 0;
    const client = {
      getUserId: () => "@alice:example.test",
      getDomain: () => "example.test",
      getRooms: () => [{ roomId: parent.id }, { roomId: child.id }],
      getRoom: (roomId: string) => (roomId === parent.id ? parentRoom : roomId === child.id ? childRoom : null),
      createRoom: vi.fn(async () => ({ room_id: child.id })),
      unstableGetFileTreeSpace: vi.fn((roomId: string) => trees.get(roomId) ?? null),
      sendStateEvent: vi.fn()
        .mockResolvedValueOnce({ event_id: "$parent-link" })
        .mockResolvedValueOnce({ event_id: "$child-link" }),
      redactEvent: vi.fn().mockResolvedValue(undefined),
      leave: vi.fn().mockResolvedValue(undefined),
      forget: vi.fn().mockResolvedValue(undefined),
      http: {
        authedRequest: vi.fn(async () => {
          refreshCount += 1;
          if (refreshCount === 3) throw new Error("post-link refresh failed");
          return [];
        }),
      },
    };
    const storage = new TeleCryptIOStorage(client as never);

    let caught: unknown;
    try {
      await storage.createSubtree(parent, "Child");
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      message: "post-link refresh failed",
      cleanupIncomplete: true,
    });
    expect(client.redactEvent).toHaveBeenCalledWith(child.id, "$child-link");
    expect(client.leave).toHaveBeenCalledWith(child.id);
    expect(client.forget).toHaveBeenCalledWith(child.id);
  });

  it("preserves the link failure and attaches incomplete cleanup detail", async () => {
    const child = tree("!child-redact-failed:example.test", "Child", false);
    const parentRoom = {
      currentState: {
        setStateEvents: vi.fn(),
        getStateEvents: vi.fn(() => ({
          getId: () => "$parent-link",
          getSender: () => "@alice:example.test",
        })),
      },
    };
    const parent = {
      ...tree("!parent-redact-failed:example.test", "Parent", true),
      getDirectories: () => [],
      room: parentRoom,
    } as unknown as TreeSpace;
    const client = {
      getUserId: () => "@alice:example.test",
      getDomain: () => "example.test",
      getRooms: () => [{ roomId: parent.id }, { roomId: child.id }],
      getRoom: (roomId: string) => (roomId === parent.id ? parentRoom : null),
      createRoom: vi.fn(async () => ({ room_id: child.id })),
      unstableGetFileTreeSpace: vi.fn((roomId: string) => (roomId === parent.id ? parent : child)),
      sendStateEvent: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("parent link failed")),
      redactEvent: vi.fn().mockRejectedValue(new Error("redaction failed")),
      leave: vi.fn().mockResolvedValue(undefined),
      forget: vi.fn().mockResolvedValue(undefined),
      http: { authedRequest: vi.fn(async () => []) },
    };
    const storage = new TeleCryptIOStorage(client as never);

    let caught: unknown;
    try {
      await storage.createSubtree(parent, "Child");
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      message: "parent link failed",
      cleanupIncomplete: true,
      cleanupError: {
        name: "RoomCleanupIncompleteError",
        code: "ROOM_CLEANUP_INCOMPLETE",
        roomId: child.id,
      } satisfies Partial<RoomCleanupIncompleteError>,
    });
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("parent link failed");
  });

  it.each(["leave", "forget"] as const)("surfaces %s cleanup failures", async (failedStep) => {
    const client = {
      getRoom: vi.fn(() => ({ getMyMembership: () => "join" })),
      leave: vi.fn(async () => {
        if (failedStep === "leave") throw new Error("leave failed");
      }),
      forget: vi.fn(async () => {
        if (failedStep === "forget") throw new Error("forget failed");
      }),
    };
    const storage = new TeleCryptIOStorage(client as never) as unknown as {
      cleanupCreatedRoom: (roomId: string) => Promise<void>;
    };

    await expect(storage.cleanupCreatedRoom("!created-cleanup-failed:example.test")).rejects.toMatchObject({
      name: "RoomCleanupIncompleteError",
      roomId: "!created-cleanup-failed:example.test",
    });
  });
});
