import { describe, expect, it, vi, afterEach } from "vitest";
import { encryptAttachment } from "matrix-encrypt-attachment";
import { MatrixEvent } from "matrix-js-sdk";

vi.mock("matrix-encrypt-attachment", () => ({
  encryptAttachment: vi.fn(async () => ({ data: new Uint8Array([1]), info: {} })),
  decryptAttachment: vi.fn(async () => new ArrayBuffer(1)),
}));

import { TeleCryptIOStorage } from "../src/TeleCryptIOStorage.js";
import { FileTooLargeError } from "../src/core/errors.js";
import { MAX_MEDIA_FILE_BYTES, validateCanonicalMatrixUserId } from "../src/core/constants.js";

function branch() {
  return {
    getFileInfo: vi.fn().mockResolvedValue({ info: { url: "mxc://example.test/media" } }),
    getFileEvent: vi.fn().mockResolvedValue({ getContent: () => ({ info: {} }) }),
  } as never;
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

  it("keeps the exact 128 MiB media boundary independent of private limits", async () => {
    const createFile = vi.fn().mockResolvedValue({ event_id: "$media-boundary" });
    const storage = new TeleCryptIOStorage({} as never);
    const tree = { createFile } as never;

    expect(MAX_MEDIA_FILE_BYTES).toBe(134_217_728);
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

  it("rejects an oversized chunked encrypted response and cancels the reader", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const reader = {
      read: vi.fn().mockResolvedValue({
        done: false,
        value: new Uint8Array(MAX_MEDIA_FILE_BYTES + 1),
      }),
      cancel,
      releaseLock: vi.fn(),
    };
    const client = {
      getAccessToken: () => "access-token",
      getHomeserverUrl: () => "https://matrix.example.test",
      mxcUrlToHttp: () => "https://matrix.example.test/_matrix/media/download/example.test/media",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: { getReader: () => reader },
    }));

    await expect(new TeleCryptIOStorage(client as never).downloadFile(branch())).rejects.toBeInstanceOf(
      FileTooLargeError,
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("rejects a bodyless media response without calling unbounded arrayBuffer", async () => {
    const arrayBuffer = vi.fn().mockResolvedValue(new ArrayBuffer(1));
    const client = {
      getAccessToken: () => "access-token",
      getHomeserverUrl: () => "https://matrix.example.test",
      mxcUrlToHttp: () => "https://matrix.example.test/_matrix/media/download/example.test/media",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": "1" }),
      body: null,
      arrayBuffer,
    }));

    await expect(new TeleCryptIOStorage(client as never).downloadFile(branch())).rejects.toThrow(
      "media download failed",
    );
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin 307 redirect before a bearer replay", async () => {
    const first = new Response(null, {
      status: 307,
      headers: { Location: "https://cdn.example.test/file" },
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(first);
    vi.stubGlobal("fetch", fetchMock);
    const client = {
      getAccessToken: () => "access-token",
      getHomeserverUrl: () => "https://matrix.example.test",
      mxcUrlToHttp: () => "https://matrix.example.test/_matrix/media/download/example.test/media",
    };

    await expect(new TeleCryptIOStorage(client as never).downloadFile(branch())).rejects.toThrow(
      "media download failed",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer access-token" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not mutate an advanced client's transport configuration", () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response("small body", {
        status: 200,
        headers: { "content-length": String(4 * 1024 * 1024 + 1) },
      }),
    );
    const client = {
      http: { opts: { fetchFn, localTimeoutMs: 0 } },
    } as never;
    new TeleCryptIOStorage(client);

    const opts = (client as { http: { opts: { fetchFn: typeof fetch; localTimeoutMs: number } } }).http.opts;
    expect(opts.fetchFn).toBe(fetchFn);
    expect(opts.localTimeoutMs).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("leaves an advanced client's non-state transport untouched", () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response("small body", {
        status: 200,
        headers: { "content-length": String(16 * 1024 * 1024 + 1) },
      }),
    );
    const client = { http: { opts: { fetchFn } } } as never;
    new TeleCryptIOStorage(client);
    const wrapped = (client as { http: { opts: { fetchFn: typeof fetch } } }).http.opts.fetchFn;
    expect(wrapped).toBe(fetchFn);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not install a stalled-response wrapper on an advanced client", () => {
    const fetchFn = vi.fn();
    const client = { http: { opts: { fetchFn } } } as never;
    new TeleCryptIOStorage(client);
    expect((client as { http: { opts: { fetchFn: typeof fetch } } }).http.opts.fetchFn).toBe(fetchFn);
  });

  it("settles a media deadline when fetch ignores AbortSignal", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
      vi.stubGlobal("fetch", fetchMock);
      const client = {
        getAccessToken: () => "access-token",
        getHomeserverUrl: () => "https://matrix.example.test",
        mxcUrlToHttp: () => "https://matrix.example.test/_matrix/media/download/example.test/media",
      };
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
    const file = branch() as { getFileEvent: ReturnType<typeof vi.fn> };
    file.getFileEvent = vi.fn().mockResolvedValue({
      getContent: () => ({ info: { mimetype: "text/\nplain" } }),
    });
    const client = {
      getAccessToken: () => "access-token",
      getHomeserverUrl: () => "https://matrix.example.test",
      mxcUrlToHttp: () => "https://matrix.example.test/_matrix/media/download/example.test/media",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-length": "1" },
        }),
      ),
    );

    await expect(new TeleCryptIOStorage(client as never).downloadFile(file as never)).rejects.toThrow(
      "media metadata is invalid",
    );
  });

  it("checks cancellation after the file event metadata read", async () => {
    const controller = new AbortController();
    const file = branch() as { getFileEvent: ReturnType<typeof vi.fn> };
    file.getFileEvent = vi.fn().mockImplementation(async () => {
      controller.abort();
      return { getContent: () => ({ info: {} }) };
    });
    const client = {
      getAccessToken: () => "access-token",
      getHomeserverUrl: () => "https://matrix.example.test",
      mxcUrlToHttp: () => "https://matrix.example.test/_matrix/media/download/example.test/media",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([1]), { status: 200, headers: { "content-length": "1" } }),
      ),
    );

    await expect(
      new TeleCryptIOStorage(client as never).downloadFile(file as never, controller.signal),
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

  it("does not replace an advanced client's redirect policy", () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { Location: "https://evil.example.test/redirect" },
      }),
    );
    const client = { http: { opts: { fetchFn } } } as never;
    new TeleCryptIOStorage(client);
    const wrapped = (client as { http: { opts: { fetchFn: typeof fetch } } }).http.opts.fetchFn;
    expect(wrapped).toBe(fetchFn);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not abort an advanced client's shared transport", () => {
    const fetchFn = vi.fn();
    const client = { http: { opts: { fetchFn } } } as never;
    new TeleCryptIOStorage(client);
    expect((client as { http: { opts: { fetchFn: typeof fetch } } }).http.opts.fetchFn).toBe(fetchFn);
  });
});
