# Working in this repo

`@telecrypt-io/storage` — E2EE file storage/sharing on Matrix (MSC3089). Library
(`src/TeleCryptIOStorage.ts`) → shared `src/core/` → CLI (`src/cli/`) + React UI (`ui/`).
Read `STATUS.md` for current state and `docs/DECISIONS.md` (D1–D7) for why things are the way
they are before changing them.

## ⚠️ This is a PUBLIC repo

Never commit internals of other **private** TeleCrypt-io repos (e.g. `server` — its Synapse
modules, DB schema, admin scripts, or infra topology). If you explore another repo to root-cause
something, describe the *observable* behavior, not its private implementation. Before pushing,
scan your diff for cross-repo internals. (This happened once — see the private ops notes.)

## Testing — two separate suites

- **Local suite** (`npm test`): runs against a disposable **podman** MAS+Synapse stack
  (`throwaway_synapse/`, `up.sh`/`down.sh`, **off by default** — bring it up first, down after).
  No mocks. This is where storage/E2EE/recovery logic is fully exercised.
- **Prod suite** (`npm run test:prod` / `test:prod:smoke`): hits **real telecrypt.io**. Requires
  operator-provided **verified** test-account secrets (`PROD_TEST_USER_1/PASS_1`, `_2`) — it
  fails loudly without them. Runs post-deploy via `.github/workflows/prod-tests.yml`. Don't run
  it repeatedly in quick succession (prod is rate-limited).

## Known gap worth remembering

The UI E2E (`ui/test/e2e/`) runs against the **Vite dev server**, so it can't catch
production-*bundle* bugs (e.g. a blank page from bundling issues). The deployed-UI smoke
(`test/production/deployed-ui.spec.ts`) catches those *after* deploy. A pre-deploy prod-build
smoke (Playwright vs `vite preview`) would catch them earlier — not yet built.

## Deploys

Pushing changes under `ui/**` to `main` auto-deploys the UI to `https://storage.telecrypt.io`
(GitHub Pages). Publishing the library to npm is tag-triggered (`vX.Y.Z`) via Trusted Publishing
— see `RELEASING.md`. Never weaken/skip a test to get green; if genuinely blocked, write
`BLOCKERS.md` and stop.
