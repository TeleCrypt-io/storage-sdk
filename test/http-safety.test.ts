import { describe, expect, it, vi } from "vitest";
import { listVaults } from "../src/core/operations.js";
import { raceWithAbort, readBoundedResponseBody } from "../src/core/http.js";

function responseWithReader(reader: {
  read: () => Promise<ReadableStreamReadResult<Uint8Array>>;
  cancel: () => Promise<void>;
  releaseLock: () => void;
}, headers?: HeadersInit): Response {
  return {
    headers: new Headers(headers),
    body: { getReader: () => reader },
  } as unknown as Response;
}

describe("bounded HTTP cancellation", () => {
  it("rejects an abort race when the underlying operation ignores abort", async () => {
    const controller = new AbortController();
    const pending = new Promise<void>(() => undefined);
    const result = raceWithAbort(
      pending,
      controller.signal,
      () => undefined,
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
      raceWithAbort(operation, controller.signal, () => undefined, () => new Error("bounded abort")),
    ).rejects.toThrow("bounded abort");
    await Promise.resolve();
    expect(thenCalled).toBe(true);
  });

  it("does not await a never-settling cancel on pre-abort", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const releaseLock = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const response = responseWithReader(
      {
        read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined),
        cancel,
        releaseLock,
      },
    );
    await expect(readBoundedResponseBody(response, 4, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("does not await a never-settling cancel after a mid-read abort", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const controller = new AbortController();
    const pending = readBoundedResponseBody(
      responseWithReader({
        read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined),
        cancel,
        releaseLock: vi.fn(),
      }),
      4,
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("returns immediately when content length exceeds the limit", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const result = await readBoundedResponseBody(
      {
        headers: new Headers({ "content-length": "5" }),
        body: { cancel },
      } as unknown as Response,
      4,
    );
    expect(result.truncated).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("returns immediately when a chunk exceeds the limit", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const result = await readBoundedResponseBody(
      responseWithReader({
        read: vi.fn().mockResolvedValue({ done: false, value: new Uint8Array([1, 2, 3, 4, 5]) }),
        cancel,
        releaseLock: vi.fn(),
      }),
      4,
    );
    expect(result).toEqual({ bytes: new Uint8Array([1, 2, 3, 4]), truncated: true });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("bounds an operation whose promise ignores its deadline signal", async () => {
    const storage = {
      listTrees: () => new Promise<never>(() => undefined),
    } as never;
    const started = Date.now();
    await expect(listVaults(storage, { timeoutMs: 10 })).rejects.toThrow("operation cancelled");
    expect(Date.now() - started).toBeLessThan(500);
  });
});
