import { describe, expect, it, vi } from "vitest";
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
    body: { getReader: () => reader },
  } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("HTTP cancellation", () => {
  it("preserves an ordinary response failure with cleanup failure", async () => {
    const primary = new Error("response rejected");
    const cleanup = new Error("response cleanup failed");
    const response = {
      body: { cancel: vi.fn().mockRejectedValue(cleanup) },
    } as unknown as Response;

    let caught: unknown;
    try {
      await cancelResponseBody(response, "response rejection", primary);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([primary, cleanup]);
  });

  it("bounds ordinary response cleanup", async () => {
    vi.useFakeTimers();
    try {
      const response = {
        body: { cancel: vi.fn(() => new Promise<void>(() => undefined)) },
      } as unknown as Response;
      const pending = cancelResponseBody(response, "response rejection");
      const assertion = expect(pending).rejects.toBeInstanceOf(AggregateError);
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a cleanup timeout as the complete ordinary response failure", async () => {
    vi.useFakeTimers();
    try {
      const cleanup = deferred<void>();
      const response = {
        body: { cancel: vi.fn(() => cleanup.promise) },
      } as unknown as Response;
      const pending = cancelResponseBody(response, "response rejection");
      const assertion = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5_000);
      const failure = await assertion;
      cleanup.reject(new Error("late response cleanup failed"));
      await Promise.resolve();
      await Promise.resolve();
      const timeoutFailure = (failure as AggregateError).errors[0] as Error;
      expect(timeoutFailure.message).toContain("timed out");
      expect(timeoutFailure.cause).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
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

  it("reports a pre-abort cleanup timeout before rejecting", async () => {
    vi.useFakeTimers();
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
    try {
      const pending = readResponseBody(response, controller.signal);
      const assertion = expect(pending).rejects.toBeInstanceOf(AggregateError);
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(releaseLock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a mid-read cleanup timeout before rejecting", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const controller = new AbortController();
    const pending = readResponseBody(
      responseWithReader({
        read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined),
        cancel,
        releaseLock: vi.fn(),
      }),
      controller.signal,
    );
    try {
      controller.abort();
      const assertion = expect(pending).rejects.toBeInstanceOf(AggregateError);
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the complete response body without a diagnostic-size rejection", async () => {
    const bytes = new Uint8Array(5);
    const result = await readResponseBody(
      responseWithReader({
        read: vi.fn()
          .mockResolvedValueOnce({ done: false, value: bytes })
          .mockResolvedValueOnce({ done: true, value: undefined }),
        cancel: vi.fn().mockResolvedValue(undefined),
        releaseLock: vi.fn(),
      }),
    );
    expect(result).toEqual({ bytes });
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

  it("preserves a read failure with reader cancellation failure", async () => {
    const readError = new Error("body read failed");
    const cancelError = new Error("reader cancellation failed");
    let caught: unknown;
    try {
      await readResponseBody(
        responseWithReader({
          read: vi.fn().mockRejectedValue(readError),
          cancel: vi.fn().mockRejectedValue(cancelError),
          releaseLock: vi.fn(),
        }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ResponseBodyReadError);
    expect((caught as ResponseBodyReadError).bytes).toEqual(new Uint8Array());
    expect((caught as Error).cause).toBeInstanceOf(AggregateError);
    expect(((caught as Error).cause as AggregateError).errors).toEqual([readError, cancelError]);
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
    const storage = {
      listTrees: () => new Promise<never>(() => undefined),
    } as never;
    const started = Date.now();
    await expect(listVaults(storage, { timeoutMs: 10 })).rejects.toThrow("operation cancelled");
    expect(Date.now() - started).toBeLessThan(500);
  });
});
