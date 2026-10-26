import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { FetchHttpApi } from "matrix-js-sdk/lib/http-api/fetch.js";
import { ClientPrefix } from "matrix-js-sdk/lib/http-api/prefix.js";
import { Method } from "matrix-js-sdk/lib/http-api/method.js";
import { boundedMatrixFetch } from "../src/TeleCryptIOStorage.js";
import { listVaults } from "../src/core/operations.js";
import {
  cancelResponseBody,
  raceWithAbort,
  readMediaResponseBody,
  readResponseBody,
  ResponseBodyReadError,
} from "../src/core/http.js";

function responseWithReader(reader: {
  read: () => Promise<ReadableStreamReadResult<Uint8Array>>;
  cancel: () => Promise<void>;
  releaseLock: () => void;
}, headers?: HeadersInit): Response {
  return {
    headers: new Headers(headers),
    body: { getReader: () => reader, cancel: reader.cancel },
  } as unknown as Response;
}

describe("HTTP cancellation", () => {
  it("reads a valid Matrix sync response after the 30-second long poll", async () => {
    const syncResponse = {
      next_batch: "s31",
      rooms: { join: {}, invite: {}, leave: {} },
      presence: { events: [] },
      account_data: { events: [] },
      to_device: { events: [] },
      device_lists: { changed: [], left: [] },
      device_one_time_keys_count: { curve25519: 0 },
    };
    let requestUrl = "";
    const server = createServer((request, response) => {
      requestUrl = request.url ?? "";
      if (!requestUrl.startsWith("/_matrix/client/v3/sync?")) {
        response.writeHead(404).end();
        return;
      }
      const timer = setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(syncResponse));
      }, 31_000);
      response.once("close", () => clearTimeout(timer));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("local sync server did not bind a port");
    const api = new FetchHttpApi({ emit: vi.fn() } as never, {
      baseUrl: `http://127.0.0.1:${address.port}`,
      prefix: ClientPrefix.V3,
      onlyData: true,
      accessToken: "local-sync-test",
      localTimeoutMs: 110_000,
      fetchFn: boundedMatrixFetch(globalThis.fetch.bind(globalThis)),
    });
    try {
      const started = Date.now();
      const result = await api.authedRequest<typeof syncResponse>(
        Method.Get,
        "/sync",
        { timeout: 30_000 },
      );
      expect(Date.now() - started).toBeGreaterThanOrEqual(30_000);
      expect(requestUrl).toContain("timeout=30000");
      expect(result).toEqual(syncResponse);
    } finally {
      api.abort();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 45_000);

  it("starts cancelling a rejected response without waiting for its stream", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    cancelResponseBody({ body: { cancel } } as unknown as Response);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects an abort race when the underlying operation ignores abort", async () => {
    const controller = new AbortController();
    const pending = new Promise<void>(() => undefined);
    const result = raceWithAbort(
      pending,
      controller.signal,
      () => new Error("bounded abort"),
    );
    controller.abort();
    await expect(result).rejects.toThrow("bounded abort");
  });

  it("observes an already-started operation after pre-abort", async () => {
    const controller = new AbortController();
    controller.abort();
    let thenCalled = false;
    const operation: PromiseLike<void> = {
      then: (_resolve, reject) => {
        thenCalled = true;
        reject?.(new Error("late operation failure"));
      },
    };
    await expect(
      raceWithAbort(operation, controller.signal, () => new Error("bounded abort")),
    ).rejects.toThrow("bounded abort");
    await Promise.resolve();
    expect(thenCalled).toBe(true);
  });

  it("rejects a pre-aborted race even when the operation is already fulfilled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      raceWithAbort(Promise.resolve("value"), controller.signal, () => new Error("bounded abort")),
    ).rejects.toThrow("bounded abort");
  });

  it("cancels a response body when its signal is already aborted", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const controller = new AbortController();
    controller.abort();
    const response = responseWithReader(
      {
        read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined),
        cancel,
        releaseLock: vi.fn(),
      },
    );
    await expect(readResponseBody(response, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels an in-flight response read when its signal aborts", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const releaseLock = vi.fn();
    const controller = new AbortController();
    const pending = readResponseBody(
      responseWithReader({
        read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined),
        cancel,
        releaseLock,
      }),
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(ResponseBodyReadError);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("enforces the product media limit while streaming successful bytes", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const response = responseWithReader({
      read: vi.fn().mockResolvedValue({ done: false, value: new Uint8Array([1, 2, 3]) }),
      cancel,
      releaseLock: vi.fn(),
    });

    await expect(readMediaResponseBody(response, 2)).rejects.toMatchObject({
      name: "FileTooLargeError",
      code: "FILE_TOO_LARGE",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("retains bytes produced before a response read failure", async () => {
    const readError = new Error("body read failed after a partial response");
    let caught: unknown;
    try {
      await readResponseBody(
        responseWithReader({
          read: vi.fn()
            .mockResolvedValueOnce({ done: false, value: new Uint8Array([1, 2, 3]) })
            .mockRejectedValueOnce(readError),
          cancel: vi.fn().mockResolvedValue(undefined),
          releaseLock: vi.fn(),
        }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ResponseBodyReadError);
    expect((caught as ResponseBodyReadError).bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect((caught as ResponseBodyReadError).cause).toBe(readError);
  });

  it("bounds an operation whose promise ignores its deadline signal", async () => {
    const storage = { keySafe: { requireReady: async () => undefined },
      listTrees: () => new Promise<never>(() => undefined),
    } as never;
    const started = Date.now();
    await expect(listVaults(storage, { timeoutMs: 10 })).rejects.toThrow("operation cancelled");
    expect(Date.now() - started).toBeLessThan(500);
  });
});
