STATE version: 3
Updated: 2026-10-20 19:51 (UK time)
Last work package applied: WP-005

## File tree
```
.devcontainer/devcontainer.json
.github/workflows/pages.yml
.gitignore
CLAUDE.md
LICENSE
README.md
docs/STATE.md
docs/blueprint.md
docs/build-spec.md
models.json
package-lock.json
package.json
scripts/list-copilot-models.js
scripts/make-icons.js
scripts/stamp-versions.sh
scripts/start-server.sh
server/ai/copilot.js
server/ai/index.js
server/ai/mock.js
server/ai/models.js
server/config.js
server/index.js
test/ai.test.js
test/codespace.test.js
test/server.test.js
test/stamp-versions.test.js
test/web-shell.test.js
web/app.css
web/app.js
web/config.js
web/icons/icon-192.png
web/icons/icon-512.png
web/index.html
web/manifest.webmanifest
```

## Exports
- `web/app.js`: `loginUrl(workerUrl: string, shared: boolean): string | null`
- `web/config.js`: `config` (frozen object: `{ workerUrl: string }`)
- `scripts/make-icons.js`: `renderIcon(size: number): Buffer`, `encodePng(size: number, raw?: Buffer): Buffer`
- `server/config.js`: `PAGES_ORIGIN` (string), `loadConfig(env = process.env)` → frozen `{ port, host, idleTimeoutMin, devOrigins, jsonBodyLimit, uploadBodyLimit, codespaceName, publicUrl }`, `isAllowedOrigin(origin: string | undefined, config: { devOrigins: boolean }): boolean`
- `server/index.js`: `class HttpError(status, message)`, `createState(config, now = new Date())` → `{ startedAt, restsAt, ai, storage, port }`, `healthBody(state)`, `readJson(req, limit): Promise<unknown>`, `createHandler({ config, state, log = console })`, `createServer(config, state = createState(config), log = console)` → `{ server, state }`
- `server/ai/models.js`: `ROLES` (frozen array of 6 roles), `MODELS_URL` (URL), `validateModels(raw: unknown)` → `{ models, errors }`, `loadModels(url = MODELS_URL): Promise<{ models, errors }>` (never throws)
- `server/ai/copilot.js`: `SDK_PACKAGE`, `DEFAULT_WORK_DIR`, `redact(text): string`, `errorSummary(err, max = 300): string`, `loadSdk(importer?): Promise<{ sdk, error }>`, `createCopilotAi({ sdk, token, workDir?, log? })` → `{ mode: 'copilot', ask({ model, system, prompt, timeoutMs? }), listModels(), stop() }`
- `server/ai/mock.js`: `createMockAi({ replies?, failures?, models? } = {})` → `{ mode: 'mock', ask, listModels, stop, calls }`
- `server/ai/index.js`: `STARTUP_SYSTEM`, `STARTUP_PROMPT`, `createAi({ env?, importer?, log? }): Promise<{ ai, error }>`, `runStartupCheck({ ai, models, timeoutMs? }): Promise<{ ready, roles, errors }>`, `startAi({ state, env?, importer?, log?, modelsUrl?, timeoutMs? }): Promise<{ ai, models } | null>` (never throws)
- `scripts/list-copilot-models.js`: `describeModel(model): string`, `compareRoles(models, available)` → `[{ role, id, found }]`

## Scripts
- `scripts/stamp-versions.sh <web-dir> <version>`: deploy-time `?v=` stamping (exit 2 bad args, exit 1 unstamped reference).
- `scripts/start-server.sh [--foreground|--watch]`: proven start script (blueprint §3.2); logs to `.server/`.
- `npm test`: `node --test`. `npm run icons`: regenerate the PNG icons. `npm run server`: restart the server in the background and tail the log. `npm run models [-- --json]`: list the account's Copilot models and check `models.json`.

## Routes
- `GET /api/health` (no pass). Everything else returns 404 JSON for now.
- `/api/health` `ai` = `{ ready, roles, errors, mode }`; `mode` is `starting` | `off` | `mock` | `copilot`; each `roles` entry is `{ model, ok, ms | error }`. The AI start-up test runs after the server starts listening.

## Settings and secrets expected
- Server (optional, non-secret): `PORT`, `HOST`, `IDLE_TIMEOUT_MIN`, `DEV_ORIGINS`. Also read if present (set by Codespaces): `CODESPACE_NAME`, `GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN`.
- AI (optional, non-secret): `AI_MOCK=1` (use the mock AI), `COPILOT_WORK_DIR` (SDK work folder; default is under the OS temp folder).
- `COPILOT_GITHUB_TOKEN`: read by `server/ai/index.js` only (passed to the Copilot adapter); never logged.
- Codespace secrets declared in `devcontainer.json` (not yet read by code): `GH_PORTS_TOKEN`, `STORAGE_TOKEN`, `STORAGE_REPO`, `PASS_SIGNING_KEY`, `PASS_VERSION`, `ALLOWED_ACCOUNTS`.
- Front end: `web/config.js` `workerUrl` is empty by design until WP-011.

## Deviations in effect
None.

## Known issues
- Not yet verified: Codespace build, `postStartCommand`/`postAttachCommand` in a real Codespace, port forwarding.
- Dependencies: `@github/copilot-sdk` 1.0.22 (pinned).
- Copilot adapter not yet run against the real service (verify step 3).
- `node -e "import('@github/copilot-sdk')…"` fails (SDK 1.0.22 calls `createRequire` on the importing filename, which is `[eval]` under `-e`). Importing from a module file, as the server does, works.
