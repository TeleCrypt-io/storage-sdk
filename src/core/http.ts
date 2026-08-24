/**
 * Read a response body without allowing an untrusted peer to control the
 * amount of memory consumed. Callers decide whether a truncated body is an
 * error and retain the response status when they need provider-error mapping.
 */
export interface BoundedResponseBody {
  bytes: Uint8Array<ArrayBuffer>;
  truncated: boolean;
}

export interface BoundedResponseOptions {
  /** Error returned when the body signal aborts. */
  abortError?: () => Error;
  /** Keep a stream reader locked until its asynchronous cancellation settles. */
  deferReaderRelease?: boolean;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

/**
 * Reject a caller-facing operation as soon as a signal aborts. The underlying
 * operation is deliberately not awaited after that point: browser/network
 * implementations are allowed to ignore AbortSignal, but a bounded SDK API
 * must still settle at its deadline. Its promise remains observed so a late
 * rejection cannot become an unhandled rejection.
 */
export function raceWithAbort<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal,
  onAbort: () => void,
  error: () => Error,
): Promise<T> {
  if (signal.aborted) {
    try {
      onAbort();
    } catch {
      // Cleanup is best effort; the caller-facing abort error remains stable.
    }
    // The operation may already have been started by the caller. Observe its
    // eventual rejection even though the public operation is already aborted.
    void Promise.resolve(operation).catch(() => undefined);
    return Promise.reject(error());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", abort);
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const abort = (): void => {
      // A resolved fetch can still have its abort event delivered first when a
      // caller aborts immediately after starting it. Let an already-resolved
      // operation hand its response to the bounded body reader, which can then
      // cancel that reader instead of losing it in the fetch race.
      queueMicrotask(() => {
        finish(() => {
          try {
            onAbort();
          } catch {
            // Cleanup is best effort; the caller-facing abort error remains stable.
          }
          reject(error());
        });
      });
    };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(operation).then(
      (value) => finish(() => resolve(value)),
      (reason: unknown) => finish(() => reject(reason)),
    );
    if (signal.aborted) abort();
  });
}

function cancelWithoutWaiting(cancel: () => PromiseLike<void> | void): Promise<void> {
  try {
    return Promise.resolve(cancel()).catch(() => undefined);
  } catch {
    // A stream may reject cancellation synchronously; the caller is already
    // rejecting or returning a bounded result, so cleanup remains best effort.
    return Promise.resolve();
  }
}

function releaseReaderWithoutThrowing(reader: { releaseLock: () => void }): void {
  try {
    reader.releaseLock();
  } catch {
    // A reader with a still-pending read can reject lock release. The bounded
    // caller must retain its abort/size result rather than waiting for or
    // replacing it with stream cleanup failure.
  }
}

export async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
  options: BoundedResponseOptions = {},
): Promise<BoundedResponseBody> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("invalid response body limit");
  }
  const cancelBody = (): void => {
    if (response.body) cancelWithoutWaiting(() => response.body!.cancel());
  };
  const cancelAbortedResponse = (): void => {
    if (!response.body) {
      cancelBody();
      return;
    }
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      reader = response.body.getReader();
    } catch {
      cancelBody();
      return;
    }
    const cancellation = cancelWithoutWaiting(() => reader.cancel());
    if (options.deferReaderRelease) void cancellation.then(() => releaseReaderWithoutThrowing(reader));
    else releaseReaderWithoutThrowing(reader);
  };
  if (signal?.aborted) {
    cancelAbortedResponse();
    throw options.abortError?.() ?? abortError();
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) {
    cancelBody();
    return { bytes: new Uint8Array(), truncated: true };
  }
  if (!response.body) return { bytes: new Uint8Array(), truncated: false };

  const reader = response.body.getReader();
  let cancellation: Promise<void> | undefined;
  const cancelReader = (): void => {
    cancellation ??= cancelWithoutWaiting(() => reader.cancel());
  };
  const releaseReader = (): void => {
    if (options.deferReaderRelease && cancellation) {
      void cancellation.then(() => releaseReaderWithoutThrowing(reader));
    } else {
      releaseReaderWithoutThrowing(reader);
    }
  };
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytesRead = 0;
  const readChunk = (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    if (!signal) return reader.read();
    if (signal.aborted) {
      cancelReader();
      return Promise.reject(options.abortError?.() ?? abortError());
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => signal.removeEventListener("abort", onAbort);
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cancelReader();
        cleanup();
        reject(options.abortError?.() ?? abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      reader.read().then(
        (result) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      );
    });
  };

  try {
    for (;;) {
      const { done, value } = await readChunk();
      if (done) break;
      const remaining = maxBytes - bytesRead;
      if (value.byteLength > remaining) {
        if (remaining > 0) {
          const chunk = new Uint8Array(remaining);
          chunk.set(value.subarray(0, remaining));
          chunks.push(chunk);
          bytesRead += remaining;
        }
        cancelReader();
        return { bytes: joinBytes(chunks, bytesRead), truncated: true };
      }
      const chunk = new Uint8Array(value.byteLength);
      chunk.set(value);
      chunks.push(chunk);
      bytesRead += value.byteLength;
    }
  } finally {
    releaseReader();
  }
  return { bytes: joinBytes(chunks, bytesRead), truncated: false };
}

function joinBytes(chunks: Uint8Array<ArrayBuffer>[], total: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
