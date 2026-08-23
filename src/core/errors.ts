/** A user-facing operation error: a clean, prefix-free message meant to be
 * shown directly to a user — never a raw stack trace. Thrown for expected failure
 * conditions (bad login, wrong recovery key, missing file, vault, or folder, not
 * logged in, ...). Platform-agnostic: no Node/CLI dependencies. */
export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}
