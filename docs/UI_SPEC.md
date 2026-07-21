# Spec: React web UI (thin adapter over `core/`)

**Status:** to build. **Stack:** React + Vite + TypeScript; Vitest + React Testing Library
(component/wiring); Playwright (E2E against real Synapse). **Prereq:** library + `core/` renamed
to `TeleCryptIOStorage` / `@telecrypt-io/storage`, 51 tests green.

## Principle

The UI is a **thin adapter over `src/core/`** — exactly like the CLI. It contains **no E2EE,
sharing, or recovery logic**; it builds a session, calls `core.*`, and renders the typed
results. All the hard, tested logic already lives in the library + core. The UI's only new
surface is: client/session construction for the browser, and rendering. Keep it that way.

## Where it lives & how it wires to core

- Put the app in `ui/` with its own `package.json` (browser build deps must not pollute the
  published library). Do not touch the library's `package.json`/`dist`.
- Import the **browser-safe** modules only: `src/core/*` and `src/TeleCryptIOStorage.ts`. **Never
  import from `src/cli/*`** (Node-only: fs, snapshot, commander).
- **Browser persistence is native** — call `TeleCryptIOStorage.create({ useIndexedDB: true })`;
  the browser's real IndexedDB persists the crypto store across reloads automatically. There is
  **no snapshot** here — that's a CLI-only concern. This is the payoff of the earlier design.
- Session (accessToken/deviceId/userId/homeserver) persists in `localStorage`.

## Auth (v1)

Password login against Synapse — mirror the CLI/tests (`POST /_matrix/client/v3/login`,
`m.login.password`). Homeserver field defaults to `http://localhost:8008` for dev. (Production
MAS/OAuth is a later concern — not v1.)

## Flows (mirror the `telecrypt-io storage` commands)

1. **Login** — homeserver, username, password → session; persist it; land on the folder list.
   (Include a dev-only "register" affordance so tests/humans can make an account.)
2. **Recovery**
   - After login, if `isRecoverySetup()` is false, prompt to **set up recovery**: call
     `core.setupRecovery()`, show the **Recovery Key** prominently with a "save this — it's the
     only way to recover on a new device" warning and a copy button.
   - A **restore** entry point: on a session with no keys, let the user paste their Recovery Key
     → `core.restoreFromRecoveryKey()` → show imported/total.
3. **Folders** — list (`core.listFolders`), create (`core.createFolder`), open a folder.
4. **Inside a folder**
   - File list (`core.listFiles`); upload via a file picker (read File → `Uint8Array` →
     `core.uploadFile`); download (`core.downloadFile` → Blob → browser save).
   - Share: invite a user at a role (`core.shareFolder`), list members (`core.listMembers`),
     remove (`core.unshareFolder`).

Keep state in React hooks/Context — the library holds the real state; the UI reflects it. No
Redux. Styling: plain CSS/CSS-modules, clean and minimal (visual polish is reviewed separately
via screenshots — do not over-invest in design).

## Tests — this is how we get "certain" without eyes

1. **Component/wiring (Vitest + React Testing Library, jsdom):** assert that user actions call
   the right `core.*` function and render its result. Mocking `core` at that boundary is fine
   for these — they test the wiring, not the crypto.
2. **E2E (Playwright, real disposable Synapse via podman):** the real guarantee. DOM assertions
   (`getByText`, `getByRole`), not pixels. Must cover:
   - login → create folder → it appears in the list
   - upload a file → it appears → download it → bytes match what was uploaded
   - **multi-participant share (two browser contexts):** userA creates a folder and shares it
     with userB as editor; userB (second context) uploads a file; userA sees and downloads
     userB's file, bytes identical. This is the core product flow.
   - recovery: set up recovery (capture the shown key), then a fresh context / cleared storage
     restores with that key and can read a file. (Mirror library test 5.3 through the UI.)
   Playwright starts the Vite dev server + the podman Synapse; assert on the DOM.

## Constraints

- **Do not break the existing 51 library/CLI tests.** The UI is additive.
- **No mocks in the Playwright E2E** — real Synapse, real crypto, real browser. (Mocks are only
  allowed in the jsdom component-wiring tests.)
- Async settling (sync, backup, decryption) is real — wait on real conditions
  (`getByText` appearing), never fixed sleeps; no flaky green. If a flow genuinely can't be made
  to work in-browser (e.g. a Vite/WASM/IndexedDB setup blocker), document it precisely in
  `BLOCKERS.md` rather than faking it.
- Likely setup hurdle to solve first: matrix-js-sdk's **WASM crypto + IndexedDB under Vite**
  (WASM loading, possible `Buffer`/`global` polyfills, top-level await). **Get a minimal app
  booting with a working login + one `core` call before building all the features.**
- `npm run build` (the UI's) and lint must pass. Update `STATUS.md` (new `ui/` + how to run it).
  Commit and push to `origin main`.

Note: visual/layout correctness is verified separately by the human operator via browser
screenshots — your job is functional correctness proven by Playwright DOM assertions.
