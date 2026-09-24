import { DecryptionKeySafe } from "../src/key-safe.js";
beforeEach(() => { vi.spyOn(DecryptionKeySafe.prototype, "requireReady").mockResolvedValue(undefined); });
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FetchHttpApi } from "matrix-js-sdk/lib/http-api/fetch.js";
import {
  EventType,
  MatrixError,
  UNSTABLE_MSC3088_ENABLED,
  UNSTABLE_MSC3088_PURPOSE,
  UNSTABLE_MSC3089_TREE_SUBTYPE,
} from "matrix-js-sdk";
import {
  boundedMatrixFetch,
  TeleCryptIOStorage,
  type TreeSpace,
} from "../src/TeleCryptIOStorage.js";
import {
  declineInvite,
  deleteFile,
  deleteFolder,
  deleteVault,
  createSubfolder,
  downloadFile as downloadCoreFile,
  getFileDetails,
  joinVault,
  listFiles,
  listSubfolders,
  uploadFile,
  renameFolder,
  shareVault,
  unshareVault,
} from "../src/core/operations.js";
import {
  MutationPartialError,
  RoomCleanupIncompleteError,
  UndecryptableFileError,
} from "../src/core/errors.js";
import { waitForCondition } from "../src/core/poll.js";
import { isFileDeleted, isTreeDeleted, markTreeDeleted } from "../src/deletion-markers.js";

function makeTree(id: string, name: string, isTopLevel: boolean): TreeSpace {
  return {
    id,
    room: { name },
    isTopLevel,
    getDirectories: () => [],
    listFiles: () => [],
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

function sharingCrypto() {
  return {
    getCrypto: () => ({ getDeviceVerificationStatus: async () => ({ signedByOwner: true }) }),
    downloadKeysForUsers: async ([user]: string[]) => ({
      master_keys: { [user]: {} }, self_signing_keys: { [user]: {} },
      device_keys: { [user]: { DEVICE: {} } },
    }),
  };
}

describe("history sharing readiness", () => {
  function fixture() {
    const tree = makeTree("!sharing-readiness:example.test", "Private", true);
    tree.invite = vi.fn().mockResolvedValue(undefined);
    const verify = vi.fn(async () => ({ signedByOwner: true }));
    const client = {
      ...sharingCrypto(), getUserId: () => "@owner:example.test",
      getCrypto: () => ({ getDeviceVerificationStatus: verify }),
    };
    const storage = {
      keySafe: { requireReady: async () => undefined }, getClient: () => client,
      getTree: () => tree, refreshRoomState: async () => undefined,
      listMembers: vi.fn().mockResolvedValue([]),
    } as unknown as TeleCryptIOStorage;
    return { tree, verify, client, storage };
  }
  it("does not invite a reader whose signing setup is absent", async () => {
    const f = fixture();
    f.client.downloadKeysForUsers = async () => ({ master_keys: {}, self_signing_keys: {}, device_keys: {} });
    await expect(shareVault(f.storage, f.tree.id, "@reader:example.test", "viewer")).rejects.toThrow("reader must set up");
    expect(f.tree.invite).not.toHaveBeenCalled();
  });
  it("reports invitation as partial when native recipient verification rejects all devices", async () => {
    const f = fixture(); f.verify.mockResolvedValue({ signedByOwner: false });
    await expect(shareVault(f.storage, f.tree.id, "@reader:example.test", "viewer")).rejects.toMatchObject({
      code: "MUTATION_PARTIAL", completedIds: [f.tree.id],
    });
    expect(f.tree.invite).toHaveBeenCalledOnce();
  });
  it("retries native history sharing for an already-pending invitation", async () => {
    const f = fixture();
    (f.storage.listMembers as ReturnType<typeof vi.fn>).mockResolvedValue([{ userId: "@reader:example.test", membership: "invite", role: "viewer" }]);
    await expect(shareVault(f.storage, f.tree.id, "@reader:example.test", "viewer")).resolves.toMatchObject({ role: "viewer" });
    expect(f.tree.invite).toHaveBeenCalledOnce();
  });
});

describe("operation safety", () => {
  it("does not convert a tree state failure into not found", async () => {
    const failure = new Error("expected room create event");
    const getTree = vi.fn(() => { throw failure; });
    const storage = { keySafe: { requireReady: async () => undefined }, getTree } as unknown as TeleCryptIOStorage;

    await expect(listFiles(storage, "!incomplete-state:example.test")).rejects.toMatchObject({
      message: "storage space lookup failed",
      cause: failure,
    });
    expect(getTree).toHaveBeenCalledTimes(1);
  });

  it("does not convert a file state failure into not found", async () => {
    const failure = new Error("file state unavailable");
    const tree = makeTree("!file-state:example.test", "Files", true);
    tree.getFile = vi.fn(() => { throw failure; });
    const storage = { keySafe: { requireReady: async () => undefined },
      getClient: () => ({}),
      getTree: () => tree,
      refreshRoomState: vi.fn().mockResolvedValue(undefined),
    } as unknown as TeleCryptIOStorage;

    await expect(deleteFile(storage, tree.id, "$file:example.test")).rejects.toBe(failure);
    expect(tree.getFile).toHaveBeenCalledTimes(1);
  });

  it("does not retry a typed incomplete-cleanup result", async () => {
    const parent = makeTree("!parent-typed-cleanup:example.test", "Parent", true);
    const failure = new RoomCleanupIncompleteError("!partial-child:example.test");
    const createSubtree = vi.fn().mockRejectedValue(failure);
    const storage = { keySafe: { requireReady: async () => undefined }, getTree: () => parent, createSubtree } as unknown as TeleCryptIOStorage;

    await expect(createSubfolder(storage, parent.id, "Child")).rejects.toBe(failure);
    expect(createSubtree).toHaveBeenCalledTimes(1);
  });

  function deletionFixture({
    id = "$v1",
    mediaId = "mxc://example.test/v1",
    renameId,
    owner = "@owner:example.test",
  }: { id?: string; mediaId?: string; renameId?: string; owner?: string } = {}) {
    let listingRedacted = false;
    let originalRedacted = false;
    let renameRedacted = false;
    const metadataId = renameId ?? id;
    const listing = {
      getId: () => "$listing",
      getSender: () => owner,
      getContent: () => listingRedacted ? {} : { active: true, metadata_event_id: metadataId },
      isRedacted: () => listingRedacted,
    };
    const originalEvent = {
      getContent: () => ({ msgtype: "m.file", body: "secret.txt", file: { url: mediaId } }),
      isRedacted: () => originalRedacted,
    };
    const renameEvent = {
      getContent: () => ({ msgtype: "io.telecrypt.storage.metadata", body: "renamed.txt", file_event_id: id }),
      isRedacted: () => renameRedacted,
    };
    const branch = {
      id,
      roomId: "!delete-file:example.test",
      indexEvent: listing,
      get isActive() { return !listingRedacted; },
      getFileInfo: vi.fn(),
    };
    const tree = makeTree("!delete-file:example.test", "Delete file", true);
    tree.getFile = vi.fn().mockReturnValue(branch);
    const client = {
      getUserId: () => owner,
      http: { authedRequest: vi.fn().mockResolvedValue({}) },
      sendStateEvent: vi.fn().mockResolvedValue({}),
      redactEvent: vi.fn(async (_roomId: string, eventId: string) => {
        if (eventId === "$listing") listingRedacted = true;
        if (eventId === id) originalRedacted = true;
        if (eventId === renameId) renameRedacted = true;
        return {};
      }),
    };
    const refreshRoomState = vi.fn().mockResolvedValue(undefined);
    const storage = { keySafe: { requireReady: async () => undefined },
      getTree: () => tree,
      getClient: () => client,
      refreshRoomState,
      getOriginalFileEvent: vi.fn().mockImplementation(async () => originalEvent),
      getFileMetadataEventId: vi.fn().mockImplementation(async () => listingRedacted ? null : metadataId),
      getFileRenameMetadataEvent: vi.fn().mockImplementation(async () => renameEvent),
    } as unknown as TeleCryptIOStorage;
    return {
      client,
      storage,
      tree,
      branch,
      listing,
      originalEvent,
      renameEvent,
      refreshRoomState,
      markRedacted: () => { listingRedacted = true; originalRedacted = true; },
    };
  }

  function deletionRefreshFixture(
    roomCount: number,
    refreshRoomState: (roomId: string, options?: { signal?: AbortSignal }) => Promise<void>,
  ) {
    const roomIds = Array.from({ length: roomCount }, (_, index) => `!delete-room-${index}:example.test`);
    const root = makeTree(roomIds[0]!, "Delete room", true);
    root.listFiles = () => [{ id: "$remaining", getName: () => "remaining.txt" }] as never;
    const rooms = roomIds.map((roomId) => ({
      roomId,
      getMyMembership: () => "join",
      currentState: { getStateEvents: () => [] },
    }));
    const client = {
      http: { authedRequest: vi.fn() },
      getRooms: () => rooms,
      getRoom: (roomId: string) => rooms.find((room) => room.roomId === roomId) ?? null,
      kick: vi.fn(),
      leave: vi.fn(),
      forget: vi.fn(),
    };
    const storage = { keySafe: { requireReady: async () => undefined },
      getClient: () => client,
      getTree: () => root,
      refreshRoomState,
      getRoomMembership: vi.fn().mockResolvedValue("join"),
    } as unknown as TeleCryptIOStorage;
    return { client, root, roomIds, storage };
  }

  function linkedEmptyFolderFixture() {
    const root = makeTree("!nested-empty:example.test", "Empty", false);
    const externalId = "!external-parent:example.test";
    const active = { via: ["example.test"] };
    const links = new Map<string, { content: object; redacted: boolean; id: string }>([
      ["child", { content: active, redacted: false, id: "$parent-child" }],
      ["parent", { content: active, redacted: false, id: "$child-parent" }],
    ]);
    const events: string[] = [];
    const rootRoom = {
      roomId: root.id,
      currentState: {
        getStateEvents: (eventType: string, stateKey?: string) => {
          if (eventType !== EventType.SpaceParent || (stateKey !== undefined && stateKey !== externalId)) return [];
          const link = links.get("parent")!;
          return [{
            getStateKey: () => externalId,
            getId: () => link.id,
            getSender: () => "@owner:example.test",
            getContent: () => link.content,
            isRedacted: () => link.redacted,
          }];
        },
      },
    };
    const externalRoom = {
      roomId: externalId,
      currentState: {
        getStateEvents: (eventType: string, stateKey?: string) => {
          if (eventType !== EventType.SpaceChild || (stateKey !== undefined && stateKey !== root.id)) return [];
          const link = links.get("child")!;
          return [{
            getStateKey: () => root.id,
            getId: () => link.id,
            getSender: () => "@owner:example.test",
            getContent: () => link.content,
            isRedacted: () => link.redacted,
          }];
        },
      },
    };
    const rooms = new Map([[root.id, rootRoom], [externalId, externalRoom]]);
    const client = {
      getUserId: () => "@owner:example.test",
      getDomain: () => "example.test",
      getRoom: (roomId: string) => rooms.get(roomId) ?? null,
      redactEvent: vi.fn(async (roomId: string, eventId: string) => {
        events.push(`redact:${roomId}:${eventId}`);
        for (const link of links.values()) {
          if (link.id === eventId) {
            link.content = {};
            link.redacted = true;
          }
        }
      }),
      leave: vi.fn(async () => { events.push("leave"); }),
      forget: vi.fn(async () => { events.push("forget"); }),
    };
    const storage = { keySafe: { requireReady: async () => undefined },
      getClient: () => client,
      getTree: () => root,
      refreshRoomState: vi.fn().mockResolvedValue(undefined),
      listMembers: vi.fn().mockResolvedValue([]),
      getRoomMembership: vi.fn().mockResolvedValue("join"),
    } as unknown as TeleCryptIOStorage;
    return { root, externalId, links, events, client, storage };
  }

  it("deletes the current media before redacting its Matrix event", async () => {
    const fixture = deletionFixture({ id: "$v1", mediaId: "mxc://example.test/v1" });

    await expect(deleteFile(fixture.storage, fixture.tree.id, "$v1")).resolves.toEqual({
      id: "$v1",
      deleted: true,
    });
    expect(fixture.client.http.authedRequest).toHaveBeenCalledWith(
      "POST",
      "/io.telecrypt.storage/delete_media",
      undefined,
      { media_ids: ["mxc://example.test/v1"] },
      {
        prefix: "/_matrix/client/unstable",
        rawResponseBody: true,
        abortSignal: expect.any(AbortSignal),
      },
    );
    expect(fixture.client.http.authedRequest.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.client.redactEvent.mock.invocationCallOrder[0],
    );
    expect(fixture.client.redactEvent.mock.calls).toEqual([
      [fixture.tree.id, "$listing"],
      [fixture.tree.id, "$v1"],
    ]);
    expect(isFileDeleted(fixture.client as never, fixture.tree.id, "$v1")).toBe(true);
  });

  it("serializes media deletion as JSON and accepts an empty 204 response", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      return new Response(null, { status: 204 });
    });
    const http = new FetchHttpApi({ emit: vi.fn() } as never, {
      baseUrl: "https://matrix.example.test",
      prefix: "/_matrix/client/v3",
      onlyData: true,
      fetchFn: fetchMock as unknown as typeof fetch,
    });
    const fixture = deletionFixture({ id: "$v1", mediaId: "mxc://example.test/v1" });
    (fixture.client as unknown as { http: typeof http }).http = http;

    await expect(deleteFile(fixture.storage, fixture.tree.id, "$v1")).resolves.toEqual({
      id: "$v1",
      deleted: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(url).toEqual(new URL("https://matrix.example.test/_matrix/client/unstable/io.telecrypt.storage/delete_media"));
    expect(request?.method).toBe("POST");
    expect(new Headers(request?.headers).get("content-type")).toBe("application/json");
    expect(request?.body).toBe(JSON.stringify({ media_ids: ["mxc://example.test/v1"] }));
  });

  it("accepts a browser 204 that exposes a non-null empty response stream", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      redirected: false,
      type: "basic",
      status: 204,
      statusText: "No Content",
      headers: new Headers(),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
    } as unknown as Response);
    const http = new FetchHttpApi({ emit: vi.fn() } as never, {
      baseUrl: "https://matrix.example.test",
      prefix: "/_matrix/client/v3",
      onlyData: true,
      fetchFn: boundedMatrixFetch(fetchMock as unknown as typeof fetch),
    });

    const response = await http.authedRequest<Blob>(
      "POST",
      "/io.telecrypt.storage/delete_media",
      undefined,
      { media_ids: ["mxc://example.test/v1"] },
      { prefix: "/_matrix/client/unstable", rawResponseBody: true },
    );
    expect(response).toBeInstanceOf(Blob);
    expect(response.size).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reconciles the removed file state before reporting deletion success", async () => {
    const fixture = deletionFixture({ id: "$v1", mediaId: "mxc://example.test/v1" });

    await expect(deleteFile(fixture.storage, fixture.tree.id, "$v1")).resolves.toEqual({
      id: "$v1",
      deleted: true,
    });

    expect(fixture.refreshRoomState).toHaveBeenCalledWith(
      fixture.tree.id,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fixture.refreshRoomState.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      Math.max(...fixture.client.redactEvent.mock.invocationCallOrder),
    );
  });

  it("accepts a redacted inactive branch as confirmed deletion", async () => {
    const fixture = deletionFixture({ id: "$v1", mediaId: "mxc://example.test/v1" });
    fixture.markRedacted();

    await expect(deleteFile(fixture.storage, fixture.tree.id, "$v1")).resolves.toEqual({
      id: "$v1",
      deleted: true,
    });
  });

  it("reports typed partial state when event cleanup fails after media deletion", async () => {
    const fixture = deletionFixture({ id: "$v1", mediaId: "mxc://example.test/v1" });
    fixture.client.redactEvent.mockRejectedValueOnce(new Error("redaction failed"));

    await expect(deleteFile(fixture.storage, fixture.tree.id, "$v1")).rejects.toMatchObject({
      code: "MUTATION_PARTIAL",
      operation: "delete file",
      completedIds: ["mxc://example.test/v1"],
    });
    expect(fixture.client.http.authedRequest).toHaveBeenCalledTimes(1);
    expect(fixture.client.redactEvent).toHaveBeenCalledTimes(1);
    expect(isFileDeleted(fixture.client as never, fixture.tree.id, "$v1")).toBe(false);
    await expect(deleteFile(fixture.storage, fixture.tree.id, "$v1")).resolves.toEqual({
      id: "$v1",
      deleted: true,
    });
    expect(fixture.client.redactEvent.mock.calls).toEqual([
      [fixture.tree.id, "$listing"],
      [fixture.tree.id, "$listing"],
      [fixture.tree.id, "$v1"],
    ]);
  });

  it("redacts the current encrypted rename event before the listing and attachment", async () => {
    const fixture = deletionFixture({
      id: "$v1",
      mediaId: "mxc://example.test/v1",
      renameId: "$rename",
    });

    await expect(deleteFile(fixture.storage, fixture.tree.id, "$v1")).resolves.toEqual({
      id: "$v1",
      deleted: true,
    });
    expect(fixture.client.redactEvent.mock.calls).toEqual([
      [fixture.tree.id, "$rename"],
      [fixture.tree.id, "$listing"],
      [fixture.tree.id, "$v1"],
    ]);
  });

  it("refreshes the parent room before listing subfolders", async () => {
    const tree = makeTree("!folders:example.test", "Folders", true);
    const getDirectories = vi.fn().mockReturnValue([
      { id: "!child:example.test", room: { name: "Child" } },
    ]);
    tree.getDirectories = getDirectories;
    const refreshRoomState = vi.fn().mockResolvedValue(undefined);
    const storage = { keySafe: { requireReady: async () => undefined },
      getClient: () => ({
        getRoom: () => ({
          currentState: {
            getStateEvents: (eventType: string) =>
              eventType === EventType.SpaceChild
                ? [{
                    getStateKey: () => "!child:example.test",
                    getContent: () => ({ via: ["example.test"] }),
                  }]
                : [],
          },
        }),
      }),
      getTree: () => tree,
      refreshRoomState,
      getTreeName: vi.fn().mockResolvedValue("Child"),
    } as unknown as TeleCryptIOStorage;

    await expect(listSubfolders(storage, tree.id)).resolves.toEqual([
      { id: "!child:example.test", name: "Child" },
    ]);
    expect(refreshRoomState).toHaveBeenCalledWith(
      tree.id,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(refreshRoomState.mock.invocationCallOrder[0]).toBeLessThan(
      getDirectories.mock.invocationCallOrder[0]!,
    );
  });

  it("does not list a child whose space relation is inactive", async () => {
    const child = { id: "!child:example.test", room: { name: "Child" } };
    const tree = makeTree("!folders:example.test", "Folders", true);
    tree.getDirectories = () => [child] as never;
    const storage = { keySafe: { requireReady: async () => undefined },
      getClient: () => ({
        getRoom: () => ({
          currentState: {
            getStateEvents: (eventType: string) =>
              eventType === EventType.SpaceChild
                ? [{
                    getStateKey: () => child.id,
                    getContent: () => ({}),
                  }]
                : [],
          },
        }),
      }),
      getTree: () => tree,
      refreshRoomState: vi.fn().mockResolvedValue(undefined),
    } as unknown as TeleCryptIOStorage;

    await expect(listSubfolders(storage, tree.id)).resolves.toEqual([]);
  });

  it("waits until an uploaded file is visible before reporting success", async () => {
    const tree = makeTree("!upload:example.test", "Upload", true);
    const file = { id: "$uploaded", getName: () => "nested.txt" };
    let visible = false;
    const getFile = vi.fn(() => (visible ? file : null));
    tree.getFile = getFile as never;
    const refreshRoomState = vi.fn().mockImplementation(async () => {
      visible = true;
    });
    const storage = { keySafe: { requireReady: async () => undefined },
      getTree: () => tree,
      uploadFile: vi.fn().mockResolvedValue(file.id),
      refreshRoomState,
    } as unknown as TeleCryptIOStorage;

    await expect(
      uploadFile(storage, tree.id, "nested.txt", new Uint8Array([1]), "text/plain"),
    ).resolves.toEqual({ id: file.id, name: "nested.txt", mimetype: "text/plain" });
    expect(refreshRoomState).toHaveBeenCalledWith(
      tree.id,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(refreshRoomState.mock.invocationCallOrder[0]).toBeLessThan(getFile.mock.invocationCallOrder[0]!);
  });

  it("reports a partial upload when the committed file never becomes observable", async () => {
    vi.useFakeTimers();
    try {
      const tree = makeTree("!upload-timeout:example.test", "Upload timeout", true);
      tree.getFile = vi.fn().mockReturnValue(null) as never;
      const refreshRoomState = vi.fn().mockResolvedValue(undefined);
      const storage = { keySafe: { requireReady: async () => undefined },
        getTree: () => tree,
        uploadFile: vi.fn().mockResolvedValue("$unobserved"),
        refreshRoomState,
      } as unknown as TeleCryptIOStorage;
      const pending = uploadFile(
        storage,
        tree.id,
        "unobserved.txt",
        new Uint8Array([1]),
        "text/plain",
      );
      const assertion = expect(pending).rejects.toMatchObject({
        code: "MUTATION_PARTIAL",
        operation: "upload file",
        completedIds: ["$unobserved"],
      });

      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
      expect(refreshRoomState).toHaveBeenCalledWith(
        tree.id,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      vi.useRealTimers();
    }
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
    const storage = { keySafe: { requireReady: async () => undefined },
      getClient: () => ({}),
      getTree: () => tree,
      downloadFile: vi.fn().mockRejectedValue(failure),
    } as unknown as TeleCryptIOStorage;

    await expect(downloadCoreFile(storage, tree.id, branch.id)).rejects.toBe(failure);
  });

  it("preserves an unknown download failure as the cause", async () => {
    const branch = { id: "$file", getName: () => "secret.txt" };
    const tree = makeTree("!download-failure:example.test", "Vault", true);
    tree.getFile = vi.fn().mockReturnValue(branch);
    const failure = new Error("download transport unavailable");
    const storage = { keySafe: { requireReady: async () => undefined },
      getClient: () => ({}),
      getTree: () => tree,
      downloadFile: vi.fn().mockRejectedValue(failure),
    } as unknown as TeleCryptIOStorage;

    await expect(downloadCoreFile(storage, tree.id, branch.id)).rejects.toMatchObject({
      message: "download failed",
      cause: failure,
    });
  });

  it("preserves an unknown file-details failure as the cause", async () => {
    const failure = new Error("file event unavailable");
    const branch = {
      id: "$details-file",
      getName: () => "details.txt",
      getFileEvent: vi.fn().mockRejectedValue(failure),
    };
    const tree = makeTree("!details-failure:example.test", "Vault", true);
    tree.getFile = vi.fn().mockReturnValue(branch);
    const storage = { keySafe: { requireReady: async () => undefined },
      getClient: () => ({}),
      getTree: () => tree,
      getFileName: vi.fn().mockResolvedValue("details.txt"),
      getOriginalFileEvent: vi.fn().mockRejectedValue(failure),
    } as unknown as TeleCryptIOStorage;

    await expect(getFileDetails(storage, tree.id, branch.id)).rejects.toMatchObject({
      message: "get file details failed",
      cause: failure,
    });
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
    const storage = { keySafe: { requireReady: async () => undefined },
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

  it("uses stripped invite state when Synapse forbids pre-join room reads", async () => {
    const leave = vi.fn().mockResolvedValue(undefined);
    const forget = vi.fn().mockResolvedValue(undefined);
    const removeRoom = vi.fn();
    const room = reviewedInviteRoom({ getMyMembership: () => "invite" });
    const refreshRoomState = vi.fn().mockResolvedValue(undefined);
    const storage = { keySafe: { requireReady: async () => undefined },
      getClient: () => ({ getRoom: () => room, leave, forget, store: { removeRoom } }),
      getTree: () => null,
      refreshRoomState,
      getRoomMembership: vi.fn().mockRejectedValue(new MatrixError({ errcode: "M_FORBIDDEN" }, 403)),
    } as unknown as TeleCryptIOStorage;

    await expect(declineInvite(storage, "!invite-prejoin:example.test")).resolves.toEqual({
      vaultId: "!invite-prejoin:example.test",
      declined: true,
    });
    expect(refreshRoomState).not.toHaveBeenCalled();
    expect(leave).toHaveBeenCalledWith("!invite-prejoin:example.test");
    expect(forget).toHaveBeenCalledWith("!invite-prejoin:example.test");
    expect(removeRoom).toHaveBeenCalledWith("!invite-prejoin:example.test");
  });

  it("fails closed when invite membership cannot be re-read", async () => {
    const client = {
      getRoom: vi.fn(() => undefined),
      leave: vi.fn(),
      forget: vi.fn(),
    };
    const storage = { keySafe: { requireReady: async () => undefined },
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
    const storage = { keySafe: { requireReady: async () => undefined },
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
    const storage = { keySafe: { requireReady: async () => undefined },
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
    let name = "Child";
    tree.setName = vi.fn(async (updated: string) => { name = updated; });
    const refreshRoomState = vi.fn(async () => {
      return;
    });
    const storage = { keySafe: { requireReady: async () => undefined },
      getTree: () => tree,
      refreshRoomState,
      getTreeName: vi.fn(async (roomId: string, options: { signal?: AbortSignal }) => {
        await refreshRoomState(roomId, options);
        return name;
      }),
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

  it("surfaces a rename refresh failure immediately with its cause", async () => {
    const tree = makeTree("!rename-refresh-failure:example.test", "Child", false);
    tree.setName = vi.fn().mockResolvedValue(undefined);
    const refreshFailure = new Error("refresh unavailable");
    const refreshRoomState = vi.fn().mockRejectedValue(refreshFailure);
    const storage = { keySafe: { requireReady: async () => undefined },
      getTree: () => tree,
      refreshRoomState,
      getTreeName: vi.fn(async (roomId: string, options: { signal?: AbortSignal }) => {
        await refreshRoomState(roomId, options);
        return "Renamed";
      }),
    } as unknown as TeleCryptIOStorage;

    await expect(renameFolder(storage, tree.id, "Renamed")).rejects.toMatchObject({
      message: "rename failed",
      cause: refreshFailure,
    });
    expect(refreshRoomState).toHaveBeenCalledTimes(1);
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

  it("forwards caller-provided Matrix request deadlines", async () => {
    const tree = makeTree("!timeout:example.test", "Timeout", true);
    const authedRequest = vi.fn().mockResolvedValue([]);
    const storage = new TeleCryptIOStorage({
      getRoom: () => ({ currentState: { setStateEvents: vi.fn() } }),
      http: { authedRequest },
    } as never);

    await storage.refreshRoomState(tree.id, { timeoutMs: 120_000 });
    expect(authedRequest).toHaveBeenCalledWith(
      "GET",
      `/rooms/${encodeURIComponent(tree.id)}/state`,
      undefined,
      undefined,
      { prefix: "/_matrix/client/v3", localTimeoutMs: 120_000, abortSignal: undefined },
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

  it("checks only the room being deleted before rejecting remaining files", async () => {
    const refreshRoomState = vi.fn(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    });
    const fixture = deletionRefreshFixture(20, refreshRoomState);

    await expect(deleteVault(fixture.storage, fixture.root.id)).rejects.toMatchObject({
      code: "NON_EMPTY_TREE",
      treeId: fixture.root.id,
    });
    expect(refreshRoomState).toHaveBeenCalledTimes(1);
    expect(refreshRoomState).toHaveBeenCalledWith(fixture.root.id, expect.anything());
    expect(fixture.client.kick).not.toHaveBeenCalled();
    expect(fixture.client.leave).not.toHaveBeenCalled();
    expect(fixture.client.forget).not.toHaveBeenCalled();
    expect(isTreeDeleted(fixture.client as never, fixture.root.id)).toBe(false);
  });

  it("does not inspect unrelated rooms when deleting a tree", async () => {
    const refreshRoomState = vi.fn().mockResolvedValue(undefined);
    const fixture = deletionRefreshFixture(1, refreshRoomState);
    const unrelated = {
      roomId: "!unrelated-invite:example.test",
      getMyMembership: () => "invite",
      currentState: { getStateEvents: () => [] },
    };
    const graphRooms = fixture.client.getRooms;
    fixture.client.getRooms = () => [...graphRooms(), unrelated];

    await expect(deleteVault(fixture.storage, fixture.root.id)).rejects.toMatchObject({
      code: "NON_EMPTY_TREE",
      treeId: fixture.root.id,
    });
    expect(refreshRoomState).toHaveBeenCalledTimes(1);
    expect(refreshRoomState).toHaveBeenCalledWith(fixture.root.id, expect.anything());
  });

  it("ignores a confirmed deleted child still linked from the room", async () => {
    const child = makeTree("!late-deleted-child:example.test", "Child", false);
    const root = makeTree("!late-deleted-root:example.test", "Root", true);
    root.getDirectories = () => [child];
    const rootRoom = {
      roomId: root.id,
      getMyMembership: () => "join",
      currentState: {
        getStateEvents: (eventType: string) => eventType === EventType.SpaceChild
          ? [{ getStateKey: () => child.id, getContent: () => ({ via: ["example.test"] }) }]
          : [],
      },
    };
    const childRoom = {
      roomId: child.id,
      // This is the shape of the late Matrix `rooms.leave` projection: the
      // room is visible again locally, but it is no longer joined.
      getMyMembership: () => "leave",
      currentState: { getStateEvents: () => [] },
    };
    const getRooms = vi.fn(() => [rootRoom, childRoom]);
    const refreshRoomState = vi.fn().mockResolvedValue(undefined);
    const leave = vi.fn().mockResolvedValue(undefined);
    const forget = vi.fn().mockResolvedValue(undefined);
    const client = {
      getUserId: () => "@owner:example.test",
      getRoom: (roomId: string) => (roomId === root.id ? rootRoom : roomId === child.id ? childRoom : null),
      getRooms,
      unstableGetFileTreeSpace: (roomId: string) => (roomId === root.id ? root : roomId === child.id ? child : null),
      http: { authedRequest: vi.fn() },
      leave,
      forget,
    };
    const storage = { keySafe: { requireReady: async () => undefined },
      getClient: () => client,
      getTree: (roomId: string) => (roomId === root.id ? root : null),
      refreshRoomState,
      listMembers: vi.fn().mockResolvedValue([]),
      getRoomMembership: vi.fn().mockResolvedValue("join"),
    } as unknown as TeleCryptIOStorage;

    // The child was successfully deleted, then a late leave sync recreated its
    // local projection. The deletion marker remains the only local evidence
    // that this child is already complete and must not block its empty parent.
    markTreeDeleted(client as never, child.id);

    await expect(deleteVault(storage, root.id)).resolves.toEqual({
      id: root.id,
      deleted: true,
    });
    expect(refreshRoomState).toHaveBeenCalledTimes(1);
    expect(refreshRoomState).toHaveBeenCalledWith(root.id, expect.anything());
    expect(getRooms).not.toHaveBeenCalled();
    expect(leave).toHaveBeenCalledWith(root.id);
    expect(forget).toHaveBeenCalledWith(root.id);
    expect(leave).not.toHaveBeenCalledWith(child.id);
    expect(forget).not.toHaveBeenCalledWith(child.id);
  });

  it("ignores an inactive child relation retained by the Matrix tree helper", async () => {
    const child = makeTree("!unlinked-child:example.test", "Child", false);
    const root = makeTree("!unlinked-root:example.test", "Root", true);
    root.getDirectories = () => [child];
    const inactiveChildEvent = {
      getStateKey: () => child.id,
      getContent: () => ({}),
    };
    const rootRoom = {
      roomId: root.id,
      getMyMembership: () => "join",
      currentState: {
        getStateEvents: (eventType: string, stateKey?: string) => {
          if (eventType !== EventType.SpaceChild) return [];
          if (stateKey !== undefined && stateKey !== child.id) return null;
          return stateKey === child.id ? inactiveChildEvent : [inactiveChildEvent];
        },
      },
    };
    const childRoom = {
      roomId: child.id,
      getMyMembership: () => "leave",
      currentState: { getStateEvents: () => [] },
    };
    const leave = vi.fn().mockResolvedValue(undefined);
    const forget = vi.fn().mockResolvedValue(undefined);
    const client = {
      getUserId: () => "@owner:example.test",
      getRoom: (roomId: string) => (roomId === root.id ? rootRoom : roomId === child.id ? childRoom : null),
      unstableGetFileTreeSpace: (roomId: string) => (roomId === root.id ? root : roomId === child.id ? child : null),
      http: { authedRequest: vi.fn() },
      leave,
      forget,
    };
    const storage = { keySafe: { requireReady: async () => undefined },
      getClient: () => client,
      getTree: (roomId: string) => (roomId === root.id ? root : null),
      refreshRoomState: vi.fn().mockResolvedValue(undefined),
      listMembers: vi.fn().mockResolvedValue([]),
      getRoomMembership: vi.fn().mockResolvedValue("join"),
    } as unknown as TeleCryptIOStorage;

    await expect(deleteVault(storage, root.id)).resolves.toEqual({
      id: root.id,
      deleted: true,
    });
    expect(leave).toHaveBeenCalledWith(root.id);
    expect(forget).toHaveBeenCalledWith(root.id);
    expect(leave).not.toHaveBeenCalledWith(child.id);
    expect(forget).not.toHaveBeenCalledWith(child.id);
  });

  it("fails closed on a room refresh error without starting deletion", async () => {
    const refreshFailure = new Error("room refresh failed");
    const refreshRoomState = vi.fn((roomId: string): Promise<void> => {
      if (roomId.endsWith("-0:example.test")) throw refreshFailure;
      return Promise.resolve();
    });
    const fixture = deletionRefreshFixture(12, refreshRoomState);

    await expect(deleteVault(fixture.storage, fixture.root.id)).rejects.toMatchObject({
      message: "delete failed",
      cause: refreshFailure,
    });
    expect(refreshRoomState.mock.calls.length).toBe(1);
    expect(fixture.client.kick).not.toHaveBeenCalled();
    expect(fixture.client.leave).not.toHaveBeenCalled();
    expect(fixture.client.forget).not.toHaveBeenCalled();
    expect(isTreeDeleted(fixture.client as never, fixture.root.id)).toBe(false);
  });

  it("does not issue a join when authoritative membership is already joined", async () => {
    const joinRoom = vi.fn();
    const storage = { keySafe: { requireReady: async () => undefined },
      getRoomMembership: vi.fn().mockResolvedValue("join"),
      getClient: () => ({ joinRoom }),
    } as unknown as TeleCryptIOStorage;

    await expect(joinVault(storage, "!joined:example.test")).resolves.toEqual({
      vaultId: "!joined:example.test",
      joined: true,
    });
    expect(joinRoom).not.toHaveBeenCalled();
  });

  it("attempts a join when Synapse hides invite membership behind M_FORBIDDEN", async () => {
    const joinRoom = vi.fn().mockResolvedValue(undefined);
    const client = {
      getUserId: () => "@reader:example.test",
      getRoom: () => ({ getMember: () => ({ membership: "invite" }) }),
      joinRoom,
    };
    const storage = { keySafe: { requireReady: async () => undefined },
      getRoomMembership: vi.fn().mockRejectedValue(new MatrixError({ errcode: "M_FORBIDDEN" }, 403)),
      getClient: () => client,
    } as unknown as TeleCryptIOStorage;

    await expect(joinVault(storage, "!invited:example.test")).resolves.toEqual({
      vaultId: "!invited:example.test",
      joined: true,
    });
    expect(joinRoom).toHaveBeenCalledWith("!invited:example.test");
  });

  it("suppresses join M_FORBIDDEN only after authoritative recheck confirms join", async () => {
    const joinRoom = vi.fn().mockRejectedValue(new MatrixError({ errcode: "M_FORBIDDEN" }, 403));
    const storage = { keySafe: { requireReady: async () => undefined },
      getRoomMembership: vi.fn()
        .mockResolvedValueOnce("invite")
        .mockResolvedValueOnce("join"),
      getClient: () => ({
        getUserId: () => "@reader:example.test",
        getRoom: () => ({ getMember: () => ({ membership: "invite" }) }),
        joinRoom,
      }),
    } as unknown as TeleCryptIOStorage;

    await expect(joinVault(storage, "!race:example.test")).resolves.toEqual({
      vaultId: "!race:example.test",
      joined: true,
    });
    expect(joinRoom).toHaveBeenCalledTimes(1);
  });

  it("waits until the local room store has the invite before joining", async () => {
    vi.useFakeTimers();
    try {
      let roomLookups = 0;
      const inviteRoom = { getMember: () => ({ membership: "invite" }) };
      const joinRoom = vi.fn().mockResolvedValue(undefined);
      const storage = { keySafe: { requireReady: async () => undefined },
        getRoomMembership: vi.fn().mockResolvedValue("invite"),
        getClient: () => ({
          getUserId: () => "@reader:example.test",
          getRoom: () => ++roomLookups >= 3 ? inviteRoom : undefined,
          joinRoom,
        }),
      } as unknown as TeleCryptIOStorage;

      const pending = joinVault(storage, "!syncing:example.test");
      await vi.advanceTimersByTimeAsync(300);
      await expect(pending).resolves.toEqual({
        vaultId: "!syncing:example.test",
        joined: true,
      });
      expect(joinRoom).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for the server-advised delay before retrying a rate-limited join", async () => {
    vi.useFakeTimers();
    try {
      const rateLimited = Object.assign(new Error("provider detail must not escape"), {
        isRateLimitError: () => true,
        getRetryAfterMs: () => 45_000,
      });
      const joinRoom = vi.fn().mockRejectedValueOnce(rateLimited).mockResolvedValueOnce(undefined);
      const storage = { keySafe: { requireReady: async () => undefined },
        getRoomMembership: vi.fn().mockResolvedValue("invite"),
        getClient: () => ({
          getUserId: () => "@reader:example.test",
          getRoom: () => ({ getMember: () => ({ membership: "invite" }) }),
          joinRoom,
        }),
      } as unknown as TeleCryptIOStorage;
      const pending = joinVault(storage, "!limited:example.test");
      const assertion = expect(pending).resolves.toEqual({
        vaultId: "!limited:example.test",
        joined: true,
      });
      await vi.advanceTimersByTimeAsync(44_999);
      expect(joinRoom).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
      expect(joinRoom).toHaveBeenCalledTimes(2);
    } finally {
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
        getStateEvents: (eventType: string, stateKey?: string) => {
          const events = [];
          if (roomId === root.id && eventType === EventType.SpaceChild) {
            events.push({
              getStateKey: () => child.id,
              getId: () => "$root-child",
              getContent: () => ({ via: ["example.test"] }),
            });
          }
          if (roomId === child.id && eventType === EventType.SpaceParent) {
            events.push({
              getStateKey: () => root.id,
              getId: () => "$child-root",
              getContent: () => ({ via: ["example.test"] }),
            });
          }
          if (stateKey === undefined) return events;
          return events.find((event) => event.getStateKey() === stateKey) ?? null;
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
    root.listFiles = () => [{ id: "$file", getName: () => "payload.bin" }] as never;
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

  it("requires explicit file deletion before deleting a folder", async () => {
    const folder = makeTree("!file-bearing-folder:example.test", "WithFile", false);
    folder.listFiles = () => [{ id: "$file", getName: () => "payload.bin" }] as never;
    const room = {
      roomId: folder.id,
      getMyMembership: () => "join",
      currentState: { getStateEvents: () => [] },
    };
    const forget = vi.fn();
    const client = {
      getUserId: () => "@owner:example.test",
      getRoom: () => room,
      getRooms: () => [room],
      unstableGetFileTreeSpace: () => folder,
      leave: vi.fn(),
      forget,
      http: {
        authedRequest: vi.fn(async (_method: string, path: string) =>
          path.endsWith("/joined_rooms") ? { joined_rooms: [folder.id] } : path.endsWith("/members") ? { chunk: [] } : [],
        ),
      },
    };

    await expect(deleteFolder(new TeleCryptIOStorage(client as never), folder.id)).rejects.toMatchObject({
      code: "NON_EMPTY_TREE",
      treeId: folder.id,
    });
    expect(forget).not.toHaveBeenCalled();
  });

  it("refuses a room with nested folders before mutating it", async () => {
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

  it("redacts owner-authored parent links before deleting an empty room", async () => {
    const fixture = linkedEmptyFolderFixture();

    await expect(deleteFolder(fixture.storage, fixture.root.id)).resolves.toEqual({
      id: fixture.root.id,
      deleted: true,
    });
    expect(fixture.events).toEqual([
      `redact:${fixture.externalId}:$parent-child`,
      `redact:${fixture.root.id}:$child-parent`,
      "leave",
      "forget",
    ]);
    expect(fixture.links.get("child")?.content).toEqual({});
    expect(fixture.links.get("parent")?.content).toEqual({});
  });

  it("keeps completed relation redactions and resumes room deletion on retry", async () => {
    const fixture = linkedEmptyFolderFixture();
    fixture.client.forget.mockRejectedValueOnce(new Error("forget failed"));

    await expect(deleteFolder(fixture.storage, fixture.root.id)).rejects.toMatchObject({
      code: "MUTATION_PARTIAL",
      operation: "delete",
      completedIds: [fixture.root.id],
    });
    expect(fixture.links.get("child")?.content).toEqual({});
    expect(fixture.links.get("parent")?.content).toEqual({});
    expect(fixture.events.slice(0, 2)).toEqual([
      `redact:${fixture.externalId}:$parent-child`,
      `redact:${fixture.root.id}:$child-parent`,
    ]);

    await expect(deleteFolder(fixture.storage, fixture.root.id)).resolves.toEqual({
      id: fixture.root.id,
      deleted: true,
    });
    expect(fixture.events.filter((event) => event.startsWith("redact:"))).toHaveLength(2);
  });

  it("continues a folder unlink when one relation was already redacted", async () => {
    const fixture = linkedEmptyFolderFixture();
    const childRelation = fixture.links.get("child")!;
    childRelation.content = {};
    childRelation.redacted = true;

    await expect(deleteFolder(fixture.storage, fixture.root.id)).resolves.toEqual({
      id: fixture.root.id,
      deleted: true,
    });
    expect(fixture.events).toEqual([
      `redact:${fixture.root.id}:$child-parent`,
      "leave",
      "forget",
    ]);
  });

  it("reports a partial unlink and retries the remaining owner-authored relation", async () => {
    const fixture = linkedEmptyFolderFixture();
    let failChildRelation = true;
    const redactEvent = fixture.client.redactEvent.getMockImplementation()!;
    fixture.client.redactEvent.mockImplementation(async (roomId: string, eventId: string) => {
      if (eventId === "$child-parent" && failChildRelation) {
        failChildRelation = false;
        throw new Error("child link redaction failed");
      }
      return redactEvent(roomId, eventId);
    });

    await expect(deleteFolder(fixture.storage, fixture.root.id)).rejects.toMatchObject({
      code: "MUTATION_PARTIAL",
      operation: "delete folder links",
      completedIds: ["$parent-child"],
      message: expect.stringContaining("retry deleting the same folder"),
    });
    expect(fixture.links.get("child")?.content).toEqual({});
    expect(fixture.links.get("parent")?.content).toEqual({ via: ["example.test"] });
    expect(fixture.client.leave).not.toHaveBeenCalled();
    expect(fixture.client.forget).not.toHaveBeenCalled();

    await expect(deleteFolder(fixture.storage, fixture.root.id)).resolves.toEqual({
      id: fixture.root.id,
      deleted: true,
    });
    expect(fixture.events.filter((event) => event.startsWith("redact:"))).toEqual([
      `redact:${fixture.externalId}:$parent-child`,
      `redact:${fixture.root.id}:$child-parent`,
    ]);
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
      // An unrelated, incomplete local room is not part of this deletion and
      // must not become a speculative precondition for it.
      getRooms: () => [room, { roomId: "!unrelated:example.test" }],
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

    const storage = new TeleCryptIOStorage(client as never);
    await expect(deleteVault(storage, root.id)).resolves.toEqual({
      id: root.id,
      deleted: true,
    });
    expect(isTreeDeleted(client as never, root.id)).toBe(true);
  });

  it("reports room deletion as partial after an earlier member kick succeeds", async () => {
    const root = makeTree("!delete-partial:example.test", "Partial", true);
    const room = {
      roomId: root.id,
      currentState: { getStateEvents: () => [] },
    };
    const kick = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second kick failed"));
    const client = {
      getUserId: () => "@owner:example.test",
      getDomain: () => "example.test",
      getRoom: () => room,
      getRooms: () => [room],
      unstableGetFileTreeSpace: () => root,
      kick,
      leave: vi.fn(),
      forget: vi.fn(),
      http: { authedRequest: vi.fn() },
    };
    const storage = { keySafe: { requireReady: async () => undefined },
      getClient: () => client,
      getTree: () => root,
      listMembers: vi.fn().mockResolvedValue([
        { userId: "@owner:example.test", role: "owner", membership: "join" },
        { userId: "@first:example.test", role: "viewer", membership: "join" },
        { userId: "@second:example.test", role: "viewer", membership: "join" },
      ]),
      getRoomMembership: vi.fn().mockResolvedValue("join"),
      refreshRoomState: vi.fn().mockResolvedValue(undefined),
    } as unknown as TeleCryptIOStorage;

    await expect(deleteVault(storage, root.id)).rejects.toMatchObject({
      code: "MUTATION_PARTIAL",
      operation: "delete",
      completedIds: [root.id],
    });
    expect(kick).toHaveBeenCalledTimes(2);
    expect(client.leave).not.toHaveBeenCalled();
    expect(client.forget).not.toHaveBeenCalled();
  });

  it("does not hide a native media upload denial behind an existing invitation", async () => {
    const tree = makeTree("!vault:example.test", "Vault", true);
    tree.invite = vi.fn().mockRejectedValue(new MatrixError({ errcode: "M_FORBIDDEN" }, 403));
    const storage = { keySafe: { requireReady: async () => undefined },
      getTree: () => tree,
      getClient: () => ({ ...sharingCrypto(), getUserId: () => "@owner:example.test" }),
      refreshRoomState: vi.fn().mockResolvedValue(undefined),
      getRoomMembership: vi.fn().mockResolvedValue("join"),
      listMembers: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { userId: "@target:example.test", membership: "join", role: "viewer" },
        ]),
    } as unknown as TeleCryptIOStorage;

    await expect(shareVault(storage, tree.id, "@target:example.test", "viewer")).rejects.toMatchObject({
      cause: { errcode: "M_FORBIDDEN" },
    });
  });

  it("does not infer an existing member from arbitrary error text", async () => {
    const tree = makeTree("!vault:example.test", "Vault", true);
    const failure = new Error("already in the room, secret=do-not-ignore");
    tree.invite = vi.fn().mockRejectedValue(failure);
    const storage = { keySafe: { requireReady: async () => undefined },
      getTree: () => tree,
      getClient: () => ({ ...sharingCrypto(), getUserId: () => "@owner:example.test" }),
      refreshRoomState: vi.fn().mockResolvedValue(undefined),
      listMembers: vi.fn().mockResolvedValue([]),
    } as unknown as TeleCryptIOStorage;

    await expect(shareVault(storage, tree.id, "@target:example.test", "viewer")).rejects.toThrow(
      "share failed",
    );
  });

  it("applies share and unshare across every known nested room", async () => {
    const child = makeTree("!child-share:example.test", "Child", false);
    const root = makeTree("!root-share:example.test", "Root", true);
    root.getDirectories = () => [child];
    root.invite = vi.fn().mockResolvedValue(undefined);
    const client = { ...sharingCrypto(),
      getUserId: () => "@owner:example.test",
      kick: vi.fn().mockResolvedValue(undefined),
    };
    const storage = { keySafe: { requireReady: async () => undefined },
      getTree: () => root,
      getClient: () => client,
      refreshRoomState: vi.fn().mockResolvedValue(undefined),
      listMembers: vi.fn().mockResolvedValue([]),
      getRoomMembership: vi.fn().mockResolvedValue("join"),
    } as unknown as TeleCryptIOStorage;

    await expect(shareVault(storage, root.id, "@target:example.test", "viewer")).resolves.toEqual({
      vaultId: root.id,
      userId: "@target:example.test",
      role: "viewer",
    });
    expect(root.invite).toHaveBeenCalledWith("@target:example.test");

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
    const storage = { keySafe: { requireReady: async () => undefined },
      getTree: () => root,
      getClient: () => ({ ...sharingCrypto(), getUserId: () => "@owner:example.test" }),
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
    const storage = { keySafe: { requireReady: async () => undefined },
      getTree: () => root,
      getClient: () => ({ ...sharingCrypto(), getUserId: () => "@owner:example.test", kick }),
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
    const storage = { keySafe: { requireReady: async () => undefined },
      getTree: () => root,
      getClient: () => ({ ...sharingCrypto(), getUserId: () => "@admin:example.test", kick }),
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
    const storage = { keySafe: { requireReady: async () => undefined },
      getTree: () => root,
      getClient: () => ({ ...sharingCrypto(), getUserId: () => "@admin:example.test" }),
      refreshRoomState: vi.fn().mockResolvedValue(undefined),
      listMembers: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ userId: "@target:example.test", role: "owner", membership: "join" }]),
      getRoomMembership: vi.fn().mockResolvedValue("join"),
    } as unknown as TeleCryptIOStorage;

    await expect(shareVault(storage, root.id, "@target:example.test", "viewer")).rejects.toThrow(
      "existing owner",
    );
  });

  it("reports share as partial after an earlier room invite commit", async () => {
    const child = makeTree("!child-share-partial:example.test", "Child", false);
    const root = makeTree("!root-share-partial:example.test", "Root", true);
    root.getDirectories = () => [child];
    root.invite = vi.fn().mockResolvedValue(undefined);
    child.invite = vi.fn().mockRejectedValue(new Error("child invite failed"));
    const storage = { keySafe: { requireReady: async () => undefined },
      getTree: () => root,
      getClient: () => ({ ...sharingCrypto(), getUserId: () => "@owner:example.test" }),
      refreshRoomState: vi.fn().mockResolvedValue(undefined),
      listMembers: vi.fn().mockResolvedValue([]),
      getRoomMembership: vi.fn().mockResolvedValue(null),
    } as unknown as TeleCryptIOStorage;

    await expect(shareVault(storage, root.id, "@target:example.test", "viewer")).rejects.toMatchObject({
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
    const storage = { keySafe: { requireReady: async () => undefined },
      getTree: () => root,
      getClient: () => ({ ...sharingCrypto(), getUserId: () => "@owner:example.test", kick }),
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
