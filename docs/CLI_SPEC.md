# Spec: `secure-storage` CLI (shared folders + recovery)

**Status:** to build. **Prereq:** library Phases 0–5B green (41 tests), key recovery works.
**Scope:** a terminal CLI over the existing library. **No web UI. No external share links.**

## Goal

A scriptable command-line tool that lets a user log in, set up recovery, create **shared
folders**, invite other participants, and have participants **add files that other participants
can read** — all end-to-end encrypted, driven entirely by the existing `SecureStorage` library.
This is both a usable MVP and the behavior contract the eventual React UI will follow.

Priority order: **reliability > completeness > polish.** Every command must be provable by a
functional test. Text in, structured text out — no guessing.

---

## THE central challenge: crypto persistence across processes (read first)

A CLI runs each command as a **separate OS process**. The library's `create()` uses
`initRustCrypto({ useIndexedDB: true })`. In Node the only IndexedDB is `fake-indexeddb`, which
is **in-memory** — it evaporates when the process exits. So naively, every command would start
with an empty crypto store and be unable to decrypt anything from a previous command. This is
the same "amnesia" failure the library already fought — now across processes.

**You must make the Matrix session AND the crypto store survive between separate CLI
invocations.** Options, in rough order of preference — pick one, justify it:

1. **Disk-persistent crypto store.** Back the Node IndexedDB with disk so the rust-crypto store
   survives process exit (e.g. a disk-backed IndexedDB implementation, or snapshotting
   `fake-indexeddb` to a file on exit and reloading on start). Behaves like a normal CLI.
2. **Key-backup restore per run (fallback).** Since Layer 2 key backup already works, a fresh
   process can restore keys from the server backup each run using a stored recovery key. Always
   works, dogfoods what we built, but slower and requires storing the recovery key in the
   profile dir (mode 0600). Acceptable for v1 if option 1 proves intractable — document it.

**Mandatory proof test:** `file upload` in one process, then `file download` in a *separate*
process, and the decrypted bytes match the original. If that passes across two real subprocess
invocations, persistence works. If you cannot make it pass, document exactly why in
`BLOCKERS.md` — do not paper over it.

State lives under a **profile directory**, overridable by env var `SECURE_STORAGE_HOME`
(default e.g. `~/.secure-storage`). This is essential for tests: each simulated user/device
gets its own `SECURE_STORAGE_HOME`, so tests can run two participants in isolation. The profile
holds the session JSON (homeserver, userId, deviceId, accessToken) and the crypto store.

---

## Tech

- **Node + TypeScript**, in this repo. Arg parsing: **`commander`** (ubiquitous, predictable).
- Runnable as a bin. Tests may invoke it via `tsx src/cli/index.ts ...` to avoid a build step;
  also ensure `npm run build` produces a working compiled entry.
- **Every command supports `--json`** — machine-readable output on stdout for test assertions.
  Human-readable text is the default; `--json` is what tests parse. Errors: non-zero exit code
  + a JSON `{ "error": "..." }` on stderr under `--json`.
- Reuse the library (`SecureStorage.create`, `keys.*`, folders, files). Do **not** reimplement
  crypto or Matrix logic in the CLI — the CLI is a thin driver.

---

## Commands

Session:
- `login --homeserver <url> --user <localpart> --password <pw>` — log in, persist session +
  crypto to the profile. (Also add `register` for dev/test convenience: same args, registers
  then logs in.)
- `whoami` — print the current userId / deviceId / homeserver.
- `logout` — clear the profile.

Recovery (Layer 2, already in the library):
- `recovery setup` — `keys.setupRecovery()`; print the Recovery Key (with a clear "save this"
  note). Under `--json`, output `{ "recoveryKey": "..." }`.
- `recovery restore <recoveryKey>` — `keys.restoreFromRecoveryKey()`; print imported/total.

Folders (shared folders):
- `folder create <name>` — print the new folder id.
- `folder list` — list the caller's folders (id + name).
- `folder share <folderId> <userId> [--role viewer|editor]` — invite a participant at a role
  (default viewer). (Loop the library's single-user `invite` + `setPermissions`.)
- `folder members <folderId>` — list participants and their roles. **Requires a small library
  addition** — see below.
- `folder unshare <folderId> <userId>` — remove a participant.

Files:
- `file upload <folderId> <path> [--name <name>]` — encrypt + upload; print the file id.
- `file list <folderId>` — list files (id, name).
- `file download <folderId> <fileId> <destPath>` — download + decrypt to a local path.

---

## Small library addition needed

Add `listMembers()` to the tree/folder API in `src/SecureStorage.ts`: return each participant
(userId) and their role (viewer/editor/owner), read from room membership + power levels. Cover
it with a library test. `folder members` wraps it. (`invite` stays single-user; the CLI loops.)

---

## Tests (test-first, same discipline as the rest of the repo)

Under `test/functional/` (or a `test/cli/` dir). All against the real disposable Synapse via
podman. Spawn the CLI as a **subprocess** (`child_process`), each with its own
`SECURE_STORAGE_HOME`, and assert on `--json` stdout / exit codes.

Required scenarios:
1. **Cross-process persistence** (the mandatory proof above): register+login, `recovery setup`,
   `folder create`, `file upload` — each as separate CLI invocations — then in a *fresh*
   invocation `file download` and assert byte-identical to the original. Proves the crypto store
   survived across processes.
2. **Multi-participant shared folder — the core use case.** Two profiles (userA, userB, each own
   `SECURE_STORAGE_HOME`): A `folder create`, A `folder share <id> @userB --role editor`, B
   accepts/joins + `file upload`, then **A `file download`s B's file and it decrypts** — proving
   a participant added a file and another participant read it. Then a third who was never invited
   cannot list it.
3. `folder members` reports the right participants and roles.
4. `recovery restore` on a genuinely fresh profile (new device) recovers a file (mirrors library
   test 5.3 but through the CLI).
5. Error paths: bad login, wrong recovery key, download of a nonexistent file — clean non-zero
   exit + JSON error, no stack-trace vomit.

---

## Constraints

- **Do not break the existing 41 tests.**
- **No mocks.** Real Synapse via podman (`npm run synapse:up`; **off by default** — bring it
  down when done).
- Async settling (sync, backup, decryption): poll real conditions with `waitFor`, never fixed
  sleeps. A flaky test is a false green — fix the race.
- **Never weaken an assertion to get green.** If something genuinely can't work (esp. the
  cross-process crypto persistence), document it in `BLOCKERS.md` and leave the test failing.
  No `.skip`/`.only`/`.todo`.
- `npm run lint` and `npm run build` must pass. Update `STATUS.md` (new CLI, commands,
  persistence approach chosen, `listMembers` addition). Commit and push to `origin main`.
