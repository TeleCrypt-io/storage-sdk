import { describe, expect, it, vi, afterEach } from "vitest";
import { encryptAttachment } from "matrix-encrypt-attachment";
import { MatrixEvent } from "matrix-js-sdk";

vi.mock("matrix-encrypt-attachment", () => ({
  encryptAttachment: vi.fn(async () => ({ data: new Uint8Array([1]), info: {} })),
  decryptAttachment: vi.fn(async () => new ArrayBuffer(1)),
}));

import { TeleCryptIOStorage } from "../src/TeleCryptIOStorage.js";
import { FileTooLargeError, UndecryptableFileError } from "../src/core/errors.js";
import { MAX_MEDIA_FILE_BYTES, validateCanonicalMatrixUserId } from "../src/core/constants.js";

function branch() {
  return {
    id: "$media-file",
    roomId: "!media-room:example.test",
    getName: () => "Encrypted file",
  } as never;
}

function encryptedFileEvent(
  content: Record<string, unknown> = {
    msgtype: "m.file",
    body: "secret.txt",
    file: { url: "mxc://example.test/media" },
    info: { mimetype: "text/plain", size: 1 },
  },
  decryptionFailure = false,
) {
  return {
    getId: () => "$media-file",
    getRoomId: () => "!media-room:example.test",
    getSender: () => "@owner:example.test",
    getType: () => "m.room.message",
    getWireType: () => "m.room.encrypted",
    getContent: () => content,
    getTs: () => 0,
    isRedacted: () => false,
    isDecryptionFailure: () => decryptionFailure,
  };
}

function mediaClient(
  event = encryptedFileEvent(),
  extra: Record<string, unknown> = {},
) {
  const ownerEvent = { getSender: () => "@owner:example.test" };
  return {
    getUserId: () => "@owner:example.test",
    getRoom: () => ({
      currentState: {
        getStateEvents: (type: string, stateKey: string) =>
          type === "m.room.create" && stateKey === "" ? ownerEvent : null,
      },
    }),
    fetchRoomEvent: vi.fn().mockResolvedValue({}),
    getEventMapper: () => () => event,
    decryptEventIfNeeded: vi.fn().mockResolvedValue(undefined),
    getAccessToken: () => "access-token",
    getHomeserverUrl: () => "https://matrix.example.test",
    mxcUrlToHttp: () => "https://matrix.example.test/_matrix/media/download/example.test/media",
    ...extra,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("media safety bounds", () => {
  it.each([
    ["https://backend.telecrypt.io", "telecrypt.io", "@alice:telecrypt.io"],
    ["https://backend.stage.telecrypt.io", "stage.telecrypt.io", "@alice:stage.telecrypt.io"],
  ])("binds %s identities to an explicit Matrix server name", (homeserver, serverName, userId) => {
    expect(new URL(homeserver).hostname).not.toBe(serverName);
    expect(validateCanonicalMatrixUserId(userId, serverName)).toBe(userId);
  });

  it("does not infer the Matrix server name from the backend hostname", () => {
    expect(() => validateCanonicalMatrixUserId("@alice:telecrypt.io", "backend.telecrypt.io")).toThrow(
      "invalid Matrix user ID for this homeserver",
    );
  });

  it("rejects remote cleartext homeservers before constructing a client", async () => {
    await expect(
      TeleCryptIOStorage.create({
        baseUrl: "http://matrix.example.test",
        serverName: "example.test",
        userId: "@alice:example.test",
        accessToken: "access-token",
        deviceId: "DEVICE123",
      }),
    ).rejects.toThrow("invalid Matrix homeserver URL");
  });

  it("rejects whitespace in Matrix identifiers before constructing a client", async () => {
    await expect(
      TeleCryptIOStorage.create({
        baseUrl: "https://matrix.example.test",
        serverName: "example.test",
        userId: "@alice:example.test\n",
        accessToken: "access-token",
        deviceId: "DEVICE123",
      }),
    ).rejects.toThrow("invalid Matrix user ID");
  });

  it("rejects oversized plaintext before encryption", async () => {
    const storage = new TeleCryptIOStorage({} as never);
    await expect(
      storage.uploadFile({} as never, "large.bin", new ArrayBuffer(MAX_MEDIA_FILE_BYTES + 1), "application/octet-stream"),
    ).rejects.toBeInstanceOf(FileTooLargeError);
  });

  it("accepts an upload at the media size boundary", async () => {
    const createFile = vi.fn().mockResolvedValue({ event_id: "$media-boundary" });
    const storage = new TeleCryptIOStorage({} as never);
    const tree = { createFile } as never;

    await expect(
      storage.uploadFile(
        tree,
        "boundary.bin",
        // The mocked encryptor only reads the size gate. Avoid allocating a
        // 128 MiB fixture in every parallel unit worker.
        { byteLength: MAX_MEDIA_FILE_BYTES } as never,
        "application/octet-stream",
      ),
    ).resolves.toBe("$media-boundary");
    expect(createFile).toHaveBeenCalledWith(
      "boundary.bin",
      expect.anything(),
      expect.anything(),
      { info: { mimetype: "application/octet-stream", size: MAX_MEDIA_FILE_BYTES } },
    );
  });

  it("rejects unsafe file metadata before encryption or event creation", async () => {
    const createFile = vi.fn();
    const storage = new TeleCryptIOStorage({} as never);
    const tree = { createFile } as never;

    await expect(storage.uploadFile(tree, "bad\nname", new ArrayBuffer(1), "text/plain")).rejects.toThrow(
      "invalid file name",
    );
    await expect(storage.uploadFile(tree, "ok.txt", new ArrayBuffer(1), "text/plain\n")).rejects.toThrow(
      "invalid MIME type",
    );
    expect(encryptAttachment).not.toHaveBeenCalled();
    expect(createFile).not.toHaveBeenCalled();
  });

  it("rejects a successful media response above the product size limit", async () => {
    const client = mediaClient();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-length": String(MAX_MEDIA_FILE_BYTES + 1) },
        }),
      ),
    );

    await expect(new TeleCryptIOStorage(client as never).downloadFile(branch())).rejects.toBeInstanceOf(
      FileTooLargeError,
    );
  });

  it("preserves a non-placeholder file-event fetch failure", async () => {
    const failure = new Error("media metadata transport unavailable");
    const client = mediaClient(encryptedFileEvent(), {
      fetchRoomEvent: vi.fn().mockRejectedValue(failure),
    });

    await expect(new TeleCryptIOStorage(client as never).downloadFile(branch())).rejects.toBe(failure);
  });

  it("translates the matrix-js-sdk decryption failure state", async () => {
    const client = mediaClient(encryptedFileEvent({}, true));

    await expect(new TeleCryptIOStorage(client as never).downloadFile(branch())).rejects.toBeInstanceOf(
      UndecryptableFileError,
    );
  });

  it("fails closed on a malformed plaintext file event when decryption succeeded", async () => {
    const client = mediaClient(encryptedFileEvent({ msgtype: "m.file", body: "secret.txt" }));

    await expect(new TeleCryptIOStorage(client as never).downloadFile(branch())).rejects.toThrow(
      "encrypted file message is invalid or unavailable",
    );
  });

  it("does not claim decryption failed merely because returned metadata is incomplete", async () => {
    const client = mediaClient(encryptedFileEvent({
      msgtype: "m.file",
      body: "secret.txt",
      file: {},
    }));
    await expect(new TeleCryptIOStorage(client as never).downloadFile(branch())).rejects.toThrow(
      "encrypted file message is invalid or unavailable",
    );
  });

  it("preserves caller cancellation while file info fails", async () => {
    const controller = new AbortController();
    const client = mediaClient(encryptedFileEvent(), {
      decryptEventIfNeeded: vi.fn().mockImplementation(async () => {
        controller.abort();
      }),
    });

    await expect(
      new TeleCryptIOStorage(client as never).downloadFile(branch(), controller.signal),
    ).rejects.toThrow("operation cancelled");
  });

  it("rejects a media response without a body", async () => {
    const client = mediaClient();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": "1" }),
      body: null,
    }));

    await expect(new TeleCryptIOStorage(client as never).downloadFile(branch())).rejects.toThrow(
      "media download failed",
    );
  });

  it("rejects a cross-origin 307 redirect before a bearer replay", async () => {
    const first = new Response(null, {
      status: 307,
      headers: { Location: "https://cdn.example.test/file" },
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(first);
    vi.stubGlobal("fetch", fetchMock);
    const client = mediaClient();

    await expect(new TeleCryptIOStorage(client as never).downloadFile(branch())).rejects.toThrow(
      "media download failed",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer access-token" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("settles a media deadline when fetch ignores AbortSignal", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
      vi.stubGlobal("fetch", fetchMock);
      const client = mediaClient();
      const pending = new TeleCryptIOStorage(client as never).downloadFile(branch());
      await vi.advanceTimersByTimeAsync(0);
      const assertion = expect(pending).rejects.toThrow("media download timed out");
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects malformed downloaded MIME metadata", async () => {
    const client = mediaClient(encryptedFileEvent({
      msgtype: "m.file",
      body: "secret.txt",
      file: { url: "mxc://example.test/media" },
      info: { mimetype: "text/\nplain" },
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-length": "1" },
        }),
      ),
    );

    await expect(new TeleCryptIOStorage(client as never).downloadFile(branch())).rejects.toThrow(
      "media metadata is invalid",
    );
  });

  it("rejects decrypted bytes whose event size metadata does not match", async () => {
    const client = mediaClient(encryptedFileEvent({
      msgtype: "m.file",
      body: "secret.txt",
      file: { url: "mxc://example.test/media" },
      info: { mimetype: "text/plain", size: 2 },
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([1]), { status: 200, headers: { "content-length": "1" } }),
      ),
    );

    await expect(new TeleCryptIOStorage(client as never).downloadFile(branch())).rejects.toThrow(
      "media metadata size does not match decrypted file",
    );
  });

  it("rejects an event size declaration above the media limit", async () => {
    const client = mediaClient(encryptedFileEvent({
      msgtype: "m.file",
      body: "secret.txt",
      file: { url: "mxc://example.test/media" },
      info: { mimetype: "text/plain", size: MAX_MEDIA_FILE_BYTES + 1 },
    }), { mxcUrlToHttp: vi.fn() });

    await expect(new TeleCryptIOStorage(client as never).downloadFile(branch())).rejects.toBeInstanceOf(
      FileTooLargeError,
    );
    expect(client.mxcUrlToHttp).not.toHaveBeenCalled();
  });

  it("checks cancellation after the file event metadata read", async () => {
    const controller = new AbortController();
    const client = mediaClient(encryptedFileEvent({
      msgtype: "m.file",
      body: "secret.txt",
      file: { url: "mxc://example.test/media" },
      info: {},
    }), {
      decryptEventIfNeeded: vi.fn().mockImplementation(async () => {
      controller.abort();
      }),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([1]), { status: 200, headers: { "content-length": "1" } }),
      ),
    );

    await expect(
      new TeleCryptIOStorage(client as never).downloadFile(branch(), controller.signal),
    ).rejects.toThrow("operation cancelled");
  });

  it("does not fall back to the local roomState snapshot", async () => {
    const roomState = vi.fn();
    const client = {
      getRoom: () => ({ currentState: { setStateEvents: vi.fn() } }),
      roomState,
    };

    await expect(new TeleCryptIOStorage(client as never).refreshRoomState("!room:example.test")).rejects.toThrow(
      "Matrix HTTP transport unavailable",
    );
    expect(roomState).not.toHaveBeenCalled();
  });

  it("rejects malformed Matrix room-state event schemas", async () => {
    const client = {
      getRoom: () => ({ currentState: { setStateEvents: vi.fn() } }),
      http: { authedRequest: vi.fn().mockResolvedValue([null]) },
    };

    await expect(new TeleCryptIOStorage(client as never).refreshRoomState("!room:example.test")).rejects.toThrow(
      "invalid Matrix room state response",
    );
  });

  it("clears local state tuples omitted by the authoritative refresh", async () => {
    const stale = new MatrixEvent({
      event_id: "$stale",
      room_id: "!room:example.test",
      sender: "@alice:example.test",
      type: "m.space.child",
      state_key: "!old:example.test",
      content: { via: ["example.test"] },
    });
    const setStateEvents = vi.fn();
    const room = {
      currentState: {
        events: new Map([["m.space.child", new Map([["!old:example.test", stale]])]]),
        setStateEvents,
      },
    };
    const client = {
      getRoom: () => room,
      http: {
        authedRequest: vi.fn().mockResolvedValue([
          {
            type: "m.room.name",
            state_key: "",
            content: { name: "Current" },
          },
        ]),
      },
    };
    await new TeleCryptIOStorage(client as never).refreshRoomState("!room:example.test");
    const refreshed = setStateEvents.mock.calls[0][0] as MatrixEvent[];
    expect(refreshed.some((event) => event.getType() === "m.space.child" && event.getContent())).toBe(true);
    expect(refreshed.find((event) => event.getType() === "m.space.child")?.getContent()).toEqual({});
  });

});
