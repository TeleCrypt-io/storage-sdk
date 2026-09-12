import { FileTooLargeError } from "./errors.js";

/** Read a complete response body while preserving the caller's cancellation contract. */
export interface ResponseBody {
  bytes: Uint8Array<ArrayBuffer>;
}

/**
 * A response stream failed after producing some bytes. The bytes are kept for
 * diagnostic callers; product-media callers must unwrap only the cause and
 * never expose this raw buffer in a public error.
 */
export class ResponseBodyReadError extends Error {
  readonly bytes: Uint8Array<ArrayBuffer>;

  constructor(bytes: Uint8Array<ArrayBuffer>, cause: unknown) {
    super("response body read failed", { cause });
    this.name = "ResponseBodyReadError";
    this.bytes = bytes;
  }
}

export interface ResponseBodyOptions {
  /** Error returned when the body signal aborts. */
  abortError?: () => Error;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

/**
 * Reject a caller-facing operation as soon as a signal aborts. The underlying
 * operation is deliberately not awaited after that point: browser/network
 * implementations are allowed to ignore AbortSignal, but the SDK API must
 * still settle at its deadline. A deadline rejection is the complete public
 * outcome; the late operation has no second result channel.
 */
export function raceWithAbort<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal,
  error: () => Error,
): Promise<T> {
  // Attach the rejection observer before checking an already-aborted signal;
  // the caller may have started this operation before entering the race.
  const observedOperation = Promise.resolve(operation);
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
      finish(() => {
        try {
          reject(error());
        } catch (abortError) {
          reject(abortError);
        }
      });
    };
    signal.addEventListener("abort", abort, { once: true });
    observedOperation.then(
      (value) => finish(() => resolve(value)),
      (reason: unknown) => finish(() => reject(reason)),
    );
    if (signal.aborted) abort();
  });
}

function startCancellation(cancel: () => PromiseLike<unknown> | unknown): void {
  try {
    void Promise.resolve(cancel()).catch(() => {});
  } catch {
    // Cleanup must not delay or replace the operation result.
  }
}

/** Start discarding a rejected response without waiting for provider cleanup. */
export function cancelResponseBody(response: Response): void {
  if (response.body) startCancellation(() => response.body!.cancel());
}

function cancelReaderAndRelease(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  startCancellation(() => reader.cancel());
  try {
    reader.releaseLock();
  } catch {
    // The reader may still have a pending read; the caller's error remains authoritative.
  }
}

async function readResponseBodyInternal(
  response: Response,
  signal?: AbortSignal,
  options: ResponseBodyOptions = {},
  maxBytes?: number,
): Promise<ResponseBody> {
  if (signal?.aborted) {
    const failure = options.abortError?.() ?? abortError();
    cancelResponseBody(response);
    throw failure;
  }
  if (
    maxBytes !== undefined &&
    (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
  ) {
    throw new Error("invalid media response body limit");
  }
  if (maxBytes !== undefined) {
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && /^\d+$/u.test(contentLength) && Number(contentLength) > maxBytes) {
      const tooLarge = new FileTooLargeError();
      cancelResponseBody(response);
      throw tooLarge;
    }
  }
  if (!response.body) return { bytes: new Uint8Array() };

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch (error) {
    cancelResponseBody(response);
    throw new ResponseBodyReadError(new Uint8Array(), error);
  }
  let cancellationStarted = false;
  const cancelReader = (): void => {
    if (cancellationStarted) return;
    cancellationStarted = true;
    startCancellation(() => reader.cancel());
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
      if (maxBytes !== undefined && value.byteLength > maxBytes - bytesRead) {
        throw new FileTooLargeError();
      }
      const chunk = new Uint8Array(value.byteLength);
      chunk.set(value);
      chunks.push(chunk);
      bytesRead += value.byteLength;
    }
  } catch (error) {
    if (signal?.aborted) {
      const failure = new ResponseBodyReadError(joinBytes(chunks, bytesRead), error);
      cancelReader();
      try { reader.releaseLock(); } catch { /* Pending reads release with cancellation. */ }
      throw failure;
    }
    cancelReaderAndRelease(reader);
    if (error instanceof FileTooLargeError) throw error;
    throw new ResponseBodyReadError(joinBytes(chunks, bytesRead), error);
  }
  // A settled normal read has no pending read request, so Web Streams
  // guarantees that this synchronous release cannot throw.
  try {
    reader.releaseLock();
  } catch (error) {
    throw new ResponseBodyReadError(joinBytes(chunks, bytesRead), error);
  }
  return { bytes: joinBytes(chunks, bytesRead) };
}

export function readResponseBody(
  response: Response,
  signal?: AbortSignal,
  options: ResponseBodyOptions = {},
): Promise<ResponseBody> {
  return readResponseBodyInternal(response, signal, options);
}

/** Read successful product media with the SDK's single plaintext-size ceiling. */
export function readMediaResponseBody(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
  options: ResponseBodyOptions = {},
): Promise<ResponseBody> {
  return readResponseBodyInternal(response, signal, options, maxBytes);
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
