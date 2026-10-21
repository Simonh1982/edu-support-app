STATE version: 6
Updated: 2026-10-21 16:58 (UK time)
Last work package applied: WP-008

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
scripts/spike-image-input.js
scripts/spike-web-tools.js
scripts/stamp-versions.sh
scripts/start-server.sh
server/ai/copilot.js
server/ai/image-input.js
server/ai/index.js
server/ai/json.js
server/ai/mock.js
server/ai/models.js
server/ai/tools.js
server/config.js
server/index.js
server/port.js
test/ai.test.js
test/codespace.test.js
test/image-input.test.js
test/port.test.js
test/server.test.js
test/stamp-versions.test.js
test/web-shell.test.js
test/web-tools.test.js
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
- `server/index.js`: `class HttpError(status, message)`, `createState(config, now = new Date())` → `{ startedAt, restsAt, ai, storage, port }`, `healthBody(state)`, `readJson(req, limit): Promise<unknown>`, `createHandler({ config, state, log = console })`, `createServer(config, state = createState(config), log = console)` → `{ server, state }`, `processChain(pid, { depth?, read? }): string`
- `server/ai/models.js`: `ROLES` (frozen array of 6 roles), `MODELS_URL` (URL), `validateModels(raw: unknown)` → `{ models, errors }`, `loadModels(url = MODELS_URL): Promise<{ models, errors }>` (never throws)
- `server/ai/copilot.js`: `SDK_PACKAGE`, `DEFAULT_WORK_DIR`, `redact(text): string`, `errorSummary(err, max = 300): string`, `loadSdk(importer?): Promise<{ sdk, error }>`, `builtInToolNames(value): string[]`, `createCopilotAi({ sdk, token, workDir?, log? })` → `{ mode: 'copilot', ask({ model, system, prompt, attachments?, tools?, allowPermission?, onPermission?, onEvent?, unsafeAllToolsForTest?, timeoutMs? }), listModels(), listBuiltInTools(), stop() }`. Shell, write, read and MCP permission requests are always refused; `availableTools` defaults to `[]`.
- `server/ai/mock.js`: `createMockAi({ replies?, failures?, models?, builtInTools?, permissionRequests?, events? } = {})` → `{ mode: 'mock', ask, listModels, listBuiltInTools, stop, calls }`
- `server/ai/index.js`: `STARTUP_SYSTEM`, `STARTUP_PROMPT`, `createAi({ env?, importer?, log? }): Promise<{ ai, error }>`, `runStartupCheck({ ai, models, timeoutMs? }): Promise<{ ready, roles, errors }>`, `startAi({ state, env?, importer?, log?, modelsUrl?, timeoutMs? }): Promise<{ ai, models } | null>` (never throws)
- `scripts/list-copilot-models.js`: `describeModel(model): string`, `compareRoles(models, available)` → `[{ role, id, found }]`
- `server/ai/json.js`: `parseJsonReply(text: unknown): Record<string, unknown> | null`
- `server/ai/image-input.js`: `MAX_IMAGE_BYTES` (8 MB), `IMAGE_TYPES` (frozen ext → MIME map: jpg, jpeg, png, webp, gif), `checkImageFile(filePath, { maxBytes? } = {}): Promise<{ path, mimeType, bytes, displayName }>`, `fileAttachment(image)` → `{ type: 'file', path, displayName }`, `blobAttachment(image): Promise<{ type: 'blob', data, mimeType, displayName }>`
- `scripts/spike-image-input.js`: `REPO_ROOT`, `USAGE`, `parseArgs(argv)`, `resolveImagePath(input, { cwd?, repoRoot? } = {})`, `ukDate(now = new Date()): string`, `briefPrompts(today)` → `{ system, prompt }`, `checkBrief(parsed, { deadline? } = {})` → `{ verdict: 'PASS' | 'CHECK' | 'FAIL', reasons }`, `visionInfo(list, modelId)`, `runSpike({ ai, models, role?, imagePath, mode?, deadline?, now?, timeoutMs? })`, `formatReport(report): string[]`
- `server/ai/tools.js`: `WEB_TOOLS` (`['web_fetch', 'web_search']`), `WEB_PERMISSION_KINDS` (`['url']`), `NEVER_ALLOWED_KINDS` (`['shell', 'write', 'read', 'mcp']`), `permissionPolicy(kinds = [])` → `(request) => boolean`, `toolNameOf(value): string | null`, `describePermission(request)` → `{ kind, tool }`
- `scripts/spike-web-tools.js`: `CHECKS`, `USAGE`, `parseArgs(argv)`, `numericFields(data)`, `createCollector()`, `toolEvidence(collector)`, `judgeFetch(parsed, evidence)`, `judgeSearch(parsed, evidence)`, `judgeRefusal({ text, secret, markerExists, permissions })`, `judgeCache(usageByCall)`, `cacheSystemPrompt(lines = 200)`, `runFetch`, `runSearch`, `runRefusal({ ai, model, tools, variant, timeoutMs })`, `runCache({ ai, model, timeoutMs })`, `runSpike({ ai, models, role?, tools?, only?, timeoutMs? })`, `formatReport(report): string[]`
- `server/port.js`: `PORT_LOG`, `ATTEMPTS` (18), `DELAY_MS` (10000), `visibilityArgs(port, codespaceName)`, `ghEnv(token, env?)`, `runGh(args, { env, timeoutMs? })`, `shortError(result)`, `appendPortLog(line, file?)`, `managePort({ state, config, port, env?, run?, sleep?, writeLog?, log?, attempts?, delayMs?, now? })` → `{ done, stop() }`

## Scripts
- `scripts/stamp-versions.sh <web-dir> <version>`: deploy-time `?v=` stamping (exit 2 bad args, exit 1 unstamped reference).
- `scripts/start-server.sh [--foreground|--watch]`: proven start script (blueprint §3.2); logs to `.server/`.
- `npm test`: `node --test`. `npm run icons`: regenerate the PNG icons. `npm run server`: restart the server in the background and tail the log. `npm run models [-- --json]`: list the account's Copilot models and check `models.json`. `npm run spike:image -- <image> [--deadline YYYY-MM-DD] [--role <role>] [--mode both|file|blob]`: phase 0 test 1 (image input); refuses images inside the repo except `.server/`. `npm run spike:web [-- --role <role>] [--tools a,b] [--only fetch,search,refuse,cache]`: phase 0 test 2 (web tools, refusals, cache).

## Routes
- `GET /api/health` (no pass). Everything else returns 404 JSON for now.
- `/api/health` `ai` = `{ ready, roles, errors, mode }`; `mode` is `starting` | `off` | `mock` | `copilot`; each `roles` entry is `{ model, ok, ms | error }`. The AI start-up test runs after the server starts listening.
- `/api/health` `port` = `{ visibility, detail, attempts, updatedAt }`; `visibility` is `unknown` | `n/a` | `pending` | `public` | `private`. The port manager starts after listening.

## Settings and secrets expected
- Server (optional, non-secret): `PORT`, `HOST`, `IDLE_TIMEOUT_MIN`, `DEV_ORIGINS`. Also read if present (set by Codespaces): `CODESPACE_NAME`, `GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN`.
- AI (optional, non-secret): `AI_MOCK=1` (use the mock AI), `COPILOT_WORK_DIR` (SDK work folder; default is under the OS temp folder).
- `COPILOT_GITHUB_TOKEN`: read by `server/ai/index.js` only (passed to the Copilot adapter); never logged.
- `GH_PORTS_TOKEN`: read by `server/port.js` only (passed to `gh` as `GH_TOKEN`); never logged.
- Codespace secrets declared in `devcontainer.json` (not yet read by code): `STORAGE_TOKEN`, `STORAGE_REPO`, `PASS_SIGNING_KEY`, `PASS_VERSION`, `ALLOWED_ACCOUNTS`.
- Front end: `web/config.js` `workerUrl` is empty by design until WP-011.

## Deviations in effect
None.

## Known issues
- Port visibility not yet run in a real Codespace (verify step 6).
- Dependencies: `@github/copilot-sdk` 1.0.22 (pinned).
- `spike:web` built-in tool line is misleading with SDK 1.0.22: `BuiltInTools` is `{ Isolated: [...] }` (a curated subset with no web tools), so the report shows `Isolated` as the only tool and flags `web_fetch, web_search` as "not in the SDK list". Reporting only; not changed.
- `npm run server` in the Codespace makes one extra server start and exit with `EADDRINUSE` on every restart, not only on overlapping restarts. Harmless: one server keeps serving. Cause under investigation (WP-008): the server now logs `started by:` and frees the port at once on `SIGTERM`. `start-server.sh` is proven and unchanged.
- `node -e "import('@github/copilot-sdk')…"` fails (SDK 1.0.22 calls `createRequire` on the importing filename, which is `[eval]` under `-e`). Importing from a module file, as the server does, works.
