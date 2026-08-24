/**
 * A freshly-synced client doesn't always see a room/event the *instant* the
 * server has committed it — e.g. a room this same session just created can
 * briefly be absent from the very next from-scratch `/sync` a later process
 * performs, before showing up moments later. That's real async settling
 * (Matrix eventual-consistency-on-fresh-sync), not a bug to paper over with
 * a fixed delay: poll the actual condition, bounded by a timeout, leveraging
 * the client's own live background sync loop (already running in this
 * process since TeleCryptIOStorage.create() started it).
 */
export async function waitForCondition<T>(
  check: (signal?: AbortSignal) => T | null | undefined | Promise<T | null | undefined>,
  opts?: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal },
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? 15000;
  const intervalMs = opts?.intervalMs ?? 300;
  const deadline = Date.now() + timeoutMs;
  const timeoutError = (): Error =>
    new Error(`timed out after ${timeoutMs}ms waiting for condition`);

  const abortError = (): Error => {
    const reason = opts?.signal?.reason;
    return reason instanceof Error ? reason : new Error("condition wait aborted");
  };

  for (;;) {
    if (opts?.signal?.aborted) throw abortError();

    const remaining = deadline - Date.now();
    if (remaining < 0) throw timeoutError();

    // A condition check may perform I/O. Awaiting it directly would make the
    // outer timeout ineffective when that I/O hangs forever. The per-attempt
    // controller gives checks that support AbortSignal a chance to stop, while
    // the race still bounds checks that do not.
    const checkController = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abortFromCaller = (): void => checkController.abort(opts?.signal?.reason);
    opts?.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const checkPromise = Promise.resolve().then(() => check(checkController.signal));
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        checkController.abort();
        reject(timeoutError());
      }, remaining);
    });
    let callerAbort: (() => void) | undefined;
    const callerAbortPromise = new Promise<never>((_, reject) => {
      callerAbort = () => reject(abortError());
      opts?.signal?.addEventListener("abort", callerAbort, { once: true });
    });

    let result: T | null | undefined;
    try {
      result = await Promise.race([checkPromise, timeoutPromise, callerAbortPromise]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      opts?.signal?.removeEventListener("abort", abortFromCaller);
      if (callerAbort) opts?.signal?.removeEventListener("abort", callerAbort);
    }
    if (result !== null && result !== undefined) return result;
    if (Date.now() >= deadline) {
      throw timeoutError();
    }
    const delay = Math.min(intervalMs, deadline - Date.now());
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const onAbort = (): void => {
        clearTimeout(timer);
        opts?.signal?.removeEventListener("abort", onAbort);
        reject(abortError());
      };
      const done = (): void => {
        opts?.signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      timer = setTimeout(done, Math.max(0, delay));
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts?.signal?.aborted) onAbort();
    });
  }
}
