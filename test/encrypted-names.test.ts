import { describe, expect, it, vi } from "vitest";
import { EventType, MsgType, RoomCreateTypeField, RoomType, UNSTABLE_MSC3088_ENABLED, UNSTABLE_MSC3088_PURPOSE, UNSTABLE_MSC3089_BRANCH, UNSTABLE_MSC3089_TREE_SUBTYPE } from "matrix-js-sdk";
import { EventShieldReason } from "matrix-js-sdk/lib/crypto-api/index.js";
import { TeleCryptIOStorage, type FileBranch, type TreeSpace } from "../src/TeleCryptIOStorage.js";

const ROOM_ID = "!private-storage:example.test";
const OWNER = "@owner:example.test";

function encryptedEvent(eventId: string, content: Record<string, unknown>) {
  return {
    getId: () => eventId,
    getRoomId: () => ROOM_ID,
    getSender: () => OWNER,
    getType: () => EventType.RoomMessage,
    getWireType: () => EventType.RoomMessageEncrypted,
    getContent: () => content,
    getTs: () => 1,
    isRedacted: () => false,
    isDecryptionFailure: () => false,
  };
}

function fixture() {
  const events = new Map<string, ReturnType<typeof encryptedEvent>>();
  let metadataPointer: Record<string, unknown> = { event_id: "$tree-name" };
  let metadataSender = OWNER;
  let encryptionAlgorithm: string | undefined = "m.megolm.v1.aes-sha2";
  let branchContent: Record<string, unknown> = { active: true, metadata_event_id: "$file-event" };
  let listingEventId = "$listing-event";
  let branchSender = OWNER;
  let idSequence = 0;
  let shieldReason: EventShieldReason | null = null;
  const sentMessages: Array<{ roomId: string; content: Record<string, unknown>; eventId: string }> = [];
  const sentStates: Array<{ roomId: string; type: string; content: Record<string, unknown>; stateKey: string }> = [];
  const rawBranch = {
    id: "$file-event",
    roomId: ROOM_ID,
    get indexEvent() {
      return {
        getId: () => listingEventId,
        getSender: () => branchSender,
        getContent: () => branchContent,
        isRedacted: () => Object.keys(branchContent).length === 0,
      };
    },
    getName: () => "Encrypted file",
    getFileInfo: vi.fn(),
    getFileEvent: vi.fn(),
  } as unknown as FileBranch;
  const tree = {
    id: ROOM_ID,
    room: { name: "Encrypted storage" },
    isTopLevel: true,
    getDirectories: () => [],
    getDirectory: () => undefined,
    invite: vi.fn(),
    delete: vi.fn(),
    getOrder: () => 0,
    setOrder: vi.fn(),
    getPermissions: () => "owner",
    setPermissions: vi.fn(),
    getFile: (fileId: string) => fileId === rawBranch.id ? rawBranch : null,
    listFiles: () => [rawBranch],
    createFile: vi.fn(),
  } as unknown as TreeSpace;
  const room = {
    roomId: ROOM_ID,
    currentState: {
      getStateEvents: (type: string, stateKey: string) => {
        if (type === EventType.RoomCreate && stateKey === "") {
          return {
            getSender: () => OWNER,
            getContent: () => ({ [RoomCreateTypeField]: RoomType.Space }),
          };
        }
        if (type === UNSTABLE_MSC3088_PURPOSE.name && stateKey === UNSTABLE_MSC3089_TREE_SUBTYPE.name) {
          return { getContent: () => ({ [UNSTABLE_MSC3088_ENABLED.name]: true }) };
        }
        if (type === EventType.RoomEncryption && stateKey === "") {
          return encryptionAlgorithm === undefined
            ? null
            : { getContent: () => ({ algorithm: encryptionAlgorithm }) };
        }
        if (type === "io.telecrypt.storage.metadata" && stateKey === "") {
          return { getSender: () => metadataSender, getContent: () => metadataPointer };
        }
        return null;
      },
    },
  };
  const client = {
    getUserId: () => OWNER,
    getDomain: () => "example.test",
    getCrypto: () => ({
      getEncryptionInfoForEvent: vi.fn().mockImplementation(async () => ({ shieldColour: shieldReason === null ? 0 : 2, shieldReason })),
    }),
    getRooms: () => [room],
    getRoom: (roomId: string) => roomId === ROOM_ID ? room : null,
    createRoom: vi.fn(async () => ({ room_id: ROOM_ID })),
    unstableGetFileTreeSpace: () => tree,
    sendMessage: vi.fn(async (roomId: string, content: Record<string, unknown>) => {
      const eventId = content.msgtype === MsgType.File ? "$file-event" : `$message-${++idSequence}`;
      sentMessages.push({ roomId, content, eventId });
      events.set(eventId, encryptedEvent(eventId, content));
      return { event_id: eventId };
    }),
    sendStateEvent: vi.fn(async (
      roomId: string,
      type: string,
      content: Record<string, unknown>,
      stateKey: string,
    ) => {
      sentStates.push({ roomId, type, content, stateKey });
      if (type === "io.telecrypt.storage.metadata") {
        metadataPointer = content;
        metadataSender = OWNER;
      }
      if (type === UNSTABLE_MSC3089_BRANCH.name) {
        branchContent = content;
        branchSender = OWNER;
        listingEventId = `$listing-${idSequence}`;
      }
      return { event_id: listingEventId };
    }),
    uploadContent: vi.fn(async (_bytes: ArrayBuffer, options: Record<string, unknown>) => {
      return { content_uri: options.includeFilename === false ? "mxc://example.test/uploaded" : "mxc://example.test/leaked-name" };
    }),
    fetchRoomEvent: vi.fn(async (_roomId: string, eventId: string) => ({ event_id: eventId })),
    getEventMapper: () => (raw: { event_id: string }) => events.get(raw.event_id),
    decryptEventIfNeeded: vi.fn().mockResolvedValue(undefined),
    http: { authedRequest: vi.fn().mockResolvedValue([]) },
  };
  return {
    client,
    tree,
    events,
    sentMessages,
    sentStates,
    getBranchContent: () => branchContent,
    getMetadataPointer: () => metadataPointer,
    setEncryptionAlgorithm: (algorithm: string | undefined) => { encryptionAlgorithm = algorithm; },
    setShieldReason: (reason: EventShieldReason | null) => { shieldReason = reason; },
  };
}

describe("encrypted storage names", () => {
  it.each([undefined, "m.megolm.v1.aes-ctr"])("blocks retained tree and file handles after room encryption becomes %s", async (algorithm) => {
    const test = fixture();
    const storage = new TeleCryptIOStorage(test.client as never);
    const tree = await storage.createTree("Protected vault");
    const file = tree.getFile("$file-event")!;
    test.client.uploadContent.mockClear();
    test.client.sendMessage.mockClear();
    test.client.sendStateEvent.mockClear();
    test.setEncryptionAlgorithm(algorithm);

    await expect(storage.uploadFile(tree, "new.txt", new Uint8Array([1]).buffer, "text/plain")).rejects.toMatchObject({
      name: "StorageError",
      message: "storage room encryption is unavailable or unsupported",
    });
    await expect(tree.setName("new vault name")).rejects.toMatchObject({
      name: "StorageError",
      message: "storage room encryption is unavailable or unsupported",
    });
    await expect(file.setName("new file name")).rejects.toMatchObject({
      name: "StorageError",
      message: "storage room encryption is unavailable or unsupported",
    });

    expect(test.client.uploadContent).not.toHaveBeenCalled();
    expect(test.client.sendMessage).not.toHaveBeenCalled();
    expect(test.client.sendStateEvent).not.toHaveBeenCalled();
  });

  it("stores tree names in encrypted messages and publishes only a generic room name and pointer", async () => {
    const test = fixture();
    const storage = new TeleCryptIOStorage(test.client as never);
    const tree = await storage.createTree("My private vault");

    expect(test.client.createRoom).toHaveBeenCalledWith(expect.objectContaining({ name: "Encrypted storage" }));
    expect(JSON.stringify(test.client.createRoom.mock.calls[0]?.[0])).not.toContain("My private vault");
    expect(test.sentMessages[0]).toMatchObject({
      roomId: ROOM_ID,
      content: { msgtype: "io.telecrypt.storage.metadata", body: "My private vault" },
    });
    expect(test.sentStates).toContainEqual({
      roomId: ROOM_ID,
      type: "io.telecrypt.storage.metadata",
      content: { event_id: "$message-1" },
      stateKey: "",
    });
    expect(await storage.getTreeName(tree.id)).toBe("My private vault");
    expect(test.client.decryptEventIfNeeded).toHaveBeenCalled();
    expect(tree.room.name).toBe("Encrypted storage");
  });

  it("uses the crypto engine sender mismatch result for encrypted metadata", async () => {
    const test = fixture();
    const storage = new TeleCryptIOStorage(test.client as never);
    const tree = await storage.createTree("Authenticated vault name");
    test.setShieldReason(EventShieldReason.MISMATCHED_SENDER);

    expect(await storage.getTreeName(tree.id)).toBe("Encrypted storage");
  });

  it("keeps names listable before key recovery and resolves them on retry afterward", async () => {
    const test = fixture();
    const storage = new TeleCryptIOStorage(test.client as never);
    const tree = await storage.createTree("Private vault");
    const treeNameEventId = test.getMetadataPointer().event_id as string;
    const encryptedTreeName = test.events.get(treeNameEventId)!;
    test.events.set(treeNameEventId, {
      ...encryptedTreeName,
      isDecryptionFailure: () => true,
    });

    expect(await storage.getTreeName(tree.id)).toBe("Encrypted storage");

    await storage.uploadFile(
      tree,
      "secret.txt",
      new Uint8Array([1, 2, 3]).buffer,
      "text/plain",
    );
    const encryptedFileName = test.events.get("$file-event")!;
    test.events.set("$file-event", {
      ...encryptedFileName,
      isDecryptionFailure: () => true,
    });
    expect(await storage.getFileName(tree.id, "$file-event", { refreshState: false })).toBe(
      "Encrypted file",
    );

    test.events.set(treeNameEventId, encryptedTreeName);
    test.events.set("$file-event", encryptedFileName);
    expect(await storage.getTreeName(tree.id)).toBe("Private vault");
    expect(await storage.getFileName(tree.id, "$file-event", { refreshState: false })).toBe(
      "secret.txt",
    );
  });

  it("uploads without a media filename and keeps the branch state limited to a metadata pointer", async () => {
    const test = fixture();
    const storage = new TeleCryptIOStorage(test.client as never);
    const tree = await storage.createTree("Vault name");

    await storage.uploadFile(
      tree,
      "private-report.pdf",
      new Uint8Array([1, 2, 3]).buffer,
      "application/pdf",
    );

    expect(test.client.uploadContent).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      { includeFilename: false },
    );
    const fileMessage = test.sentMessages.find((message) => message.content.msgtype === MsgType.File);
    expect(fileMessage?.content).toMatchObject({
      body: "private-report.pdf",
      file: { url: "mxc://example.test/uploaded" },
    });
    expect(test.sentStates.at(-1)).toMatchObject({
      type: UNSTABLE_MSC3089_BRANCH.name,
      stateKey: fileMessage?.eventId,
      content: { active: true, metadata_event_id: fileMessage?.eventId },
    });
    expect(JSON.stringify(test.getBranchContent())).not.toContain("private-report.pdf");
    expect(JSON.stringify(test.sentStates)).not.toContain("private-report.pdf");
    expect(await storage.getFileName(tree.id, fileMessage!.eventId, { refreshState: false })).toBe(
      "private-report.pdf",
    );
  });

  it("renames files with encrypted metadata messages and leaves generic Matrix state unchanged", async () => {
    const test = fixture();
    const storage = new TeleCryptIOStorage(test.client as never);
    const tree = await storage.createTree("Vault name");
    await tree.getFile("$file-event")!.setName("renamed-report.pdf");

    const rename = test.sentMessages.at(-1)!;
    expect(rename.content).toEqual({
      msgtype: "io.telecrypt.storage.metadata",
      body: "renamed-report.pdf",
      file_event_id: "$file-event",
    });
    expect(test.getBranchContent()).toEqual({ active: true, metadata_event_id: rename.eventId });
    expect(await storage.getFileName(tree.id, "$file-event", { refreshState: false })).toBe(
      "renamed-report.pdf",
    );
    expect(tree.room.name).toBe("Encrypted storage");
  });
});
