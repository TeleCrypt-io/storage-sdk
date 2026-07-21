/**
 * A freshly-synced client doesn't always see a room/event the *instant* the
 * server has committed it — e.g. a room this same session just created can
 * briefly be absent from the very next from-scratch `/sync` a later process
 * performs, before showing up moments later. That's real async settling
 * (Matrix eventual-consistency-on-fresh-sync), not a bug to paper over with
 * a fixed delay: poll the actual condition, bounded by a timeout, leveraging
 * the client's own live background sync loop (already running in this
 * process since SecureStorage.create() started it).
 */
export async function waitForCondition<T>(
  check: () => T | null | undefined,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? 15000;
  const intervalMs = opts?.intervalMs ?? 300;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const result = check();
    if (result !== null && result !== undefined) return result;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for condition`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
