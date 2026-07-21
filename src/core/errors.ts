/** A user-facing operation error: a clean, prefix-free message meant to be
 * shown directly to a user (CLI stderr today, a future UI's error toast
 * tomorrow) — never a raw stack trace. Thrown for expected failure
 * conditions (bad login, wrong recovery key, missing file/folder, not
 * logged in, ...). Platform-agnostic: no Node/CLI dependencies. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}
