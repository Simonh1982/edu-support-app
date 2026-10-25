STATE version: 11
Updated: 2026-10-25 22:11 (UK time)
Last work package applied: WP-013

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
scripts/item-check.js
scripts/list-copilot-models.js
scripts/make-icons.js
scripts/spike-image-input.js
scripts/spike-web-tools.js
scripts/stamp-versions.sh
scripts/start-server.sh
scripts/storage-check.js
scripts/worker-check.js
server/ai/copilot.js
server/ai/image-input.js
server/ai/index.js
server/ai/json.js
server/ai/mock.js
server/ai/models.js
server/ai/tools.js
server/auth.js
server/config.js
server/index.js
server/port.js
server/storage/git.js
server/storage/index.js
server/storage/items.js
server/storage/records.js
server/storage/snapshot.js
server/storage/store.js
test/ai.test.js
test/auth.test.js
test/codespace.test.js
test/front-end.test.js
test/image-input.test.js
test/items.test.js
test/port.test.js
test/server.test.js
test/snapshot.test.js
test/stamp-versions.test.js
test/storage.test.js
test/web-shell.test.js
test/web-tools.test.js
test/worker.test.js
wake/worker.js
web/app.css
web/app.js
web/config.js
web/icons/icon-192.png
web/icons/icon-512.png
web/index.html
web/manifest.webmanifest
web/parent/index.html
web/parent/parent.js
web/shared/auth.js
web/shared/wake.js
```

## Exports
- `web/app.js`: `loginUrl` (re-exported from `web/shared/auth.js`); runs the page when a DOM exists
- `web/shared/auth.js`: `PASS_ROLES`, `PASS_KEY_PREFIX`, `REQUEST_TIMEOUT_MS`, `SIGN_IN_MESSAGES`, `signInMessage`, `workerEndpoint`, `loginUrl`, `readFragment`, `decodePass`, `passIsCurrent`, `checkNewPass`, `memoryStorage`, `usableStorage`, `storageKey`, `savePass`, `loadPass`, `clearPass`, `readJsonBody`, `timeoutSignal`, `workerRequest`
- `web/shared/wake.js`: `WAKE_SETTINGS`, `WAKE_MESSAGES`, `probeHealth`, `createWaker`
- `web/config.js`: `config` (frozen object: `{ workerUrl: string }`)
- `scripts/make-icons.js`: `renderIcon(size: number): Buffer`, `encodePng(size: number, raw?: Buffer): Buffer`
- `server/config.js`: `PAGES_ORIGIN` (string), `loadConfig(env = process.env)` → frozen `{ port, host, idleTimeoutMin, devOrigins, jsonBodyLimit, uploadBodyLimit, codespaceName, publicUrl }`, `isAllowedOrigin(origin: string | undefined, config: { devOrigins: boolean }): boolean`
- `server/index.js`: `class HttpError(status, message)`, `createState(config, now = new Date())` → `{ startedAt, restsAt, ai, storage, port }`, `healthBody(state)`, `readJson(req, limit): Promise<unknown>`, `createHandler({ config, state, log = console, authSettings = null, getStore = () => null })`, `checkPass`, `createServer(config, state?, log?, options?)` with `options = { authSettings, getStore }` → `{ server, state }`, `processChain(pid, { depth?, read? }): string`
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
- `server/storage/records.js`: `SCHEMA_VERSION` (1), `CREATED_BY`, `MAX_EVENT_PAYLOAD_BYTES` (1024), `MAX_EVENT_STRING` (200), `ukIso(date?)`, `ukMonth(date?)`, `newId(prefix, date?)`, `newRecord(prefix, fields, { createdBy, now? })`, `updateRecord(record, changes?, { now? })`, `makeEvent(type, { links?, payload?, createdBy?, now? })`, `eventsPath(date?)`
- `server/storage/git.js`: `IDENTITY`, `gitEnv({ token?, env?, host? })`, `cleanGitText(text, max?)`, `runGit(args, { cwd, env, timeoutMs? })`, `createLock()` → `{ run(fn) }`
- `server/storage/store.js`: `BATCH_MS` (5000), `RETRY_DELAYS_MS`, `checkPath(relPath, { allowInbox? })`, `createStore({ dir, remoteUrl, env, runGit?, batchMs?, retryDelays?, log?, now?, sleep?, onStatus?, beforeCommit? })` → `{ dir, status(), init(), flush(), commitLocal(), put(path, record), append(path, entry), remove(path), logEvent(type, options?), read(path), list(dir) }`. `beforeCommit` runs inside the git lock, before `git add`, once per batch with changes; a failure is logged and never blocks saving.
- `server/storage/index.js`: `DEFAULT_STORAGE_DIR` (`/workspaces/storage`), `APP_ROOT`, `storageSettings(env?, { appRoot? })`, `snapshotStep`, `startStorage({ state, config, env?, log?, makeStore? })` → store or null (never throws)
- `server/storage/items.js` (item block): `SNAPSHOT_PATH`, `ITEM_ID_PATTERN`, `ITEM_TYPES`, `itemPath`, `itemTypeAllowed`, `snapshotSection`; Node only: `ITEM_BLOCK_START`, `ITEM_BLOCK_END`, `extractItemBlock`, `itemResponse`
- `server/storage/snapshot.js`: `buildSnapshot`, `UPCOMING_LIMIT`, `RECENT_LIMIT`, `SHARED_LIMIT`
- `scripts/item-check.js`: `USAGE`, `TEST_IDS`, `testNote`, `runCheck`
- `scripts/storage-check.js`: `INBOX_TEST_FILE`, `USAGE`, `parseArgs(argv)`, `runCheck({ settings, wait?, waitForOwner, makeStore?, tmpRoot?, out? })`
- `server/auth.js` (pass block): constants `PASS_ROLES`, `PASS_TTL_OWN_S`, `PASS_TTL_SHARED_S`, `PASS_MAX_LENGTH`, `PASS_MIN_KEY_LENGTH`, `PASS_CLOCK_SKEW_S`, `PARENT_READABLE_TYPES` (`notebook`, `plan`, `draft`); functions `passB64urlEncode`, `passB64urlDecode`, `parseAllowedAccounts(raw)` → `{ accounts, error }`, `passSettings(env)` → `{ settings, errors }`, `roleFor(accounts, login)`, `mintPass({ login, shared?, settings, now? })`, `verifyPass(token, settings, { now? })` → `{ ok, pass } | { ok: false, reason }` (reasons: `not-configured`, `missing`, `malformed`, `signature`, `expired`, `version`, `account`), `passFromHeader(value)`, `canReadItem(role, type, record)`
- `server/auth.js` (Node only): `PASS_BLOCK_START`, `PASS_BLOCK_END`, `extractPassBlock(source)`, `AUTH_MESSAGES`, `createAuth({ env?, log?, now? })` → `{ ready, errors, authenticate(headers), authorise(pass, roles), canRead(pass, type, record) }`
- `wake/worker.js`: `default { fetch(request, env) }` only (Cloudflare module Worker; contains the pass block).
- `scripts/worker-check.js`: `USAGE`, `normaliseWorkerUrl(text)`, `expectedBackendUrl(env?)`, `runCheck({ workerUrl, env?, fetchImpl?, out? }): Promise<boolean>`
- **Shared code rule:** the block between the `PASS BLOCK` markers in `server/auth.js` (WP-011) and the block between the `ITEM BLOCK` markers in `server/storage/items.js` (WP-013) are each copied verbatim into `wake/worker.js`. Change both copies together; tests check they are identical.
- **Item paths:** lookup is `type` + `id` (+ `task` for items in a task folder): `notebook/<id>.json`, `sources/<id>.json`, `tasks/<id>/task.json`, `tasks/<task>/plan.json` (id checked, not used), `tasks/<task>/drafts/<id>.json` (id `v<n>`), `tasks/<task>/feedback/<id>.json`. IDs match `^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$`.
- **Snapshot (`index/snapshot.json`):** titles, dates and counts only (titles from a record's own `title` or its task's title, else a plain label); learner and parent sections; settings keep short strings, numbers and booleans; app name from `profile/app.json` (`displayName`, then `name`), null if absent; `planStatus` and `nextSession` null for now. Written by the store's `beforeCommit` step, so the first batch after start-up refreshes it.

## Scripts
- `scripts/stamp-versions.sh <web-dir> <version>`: deploy-time `?v=` stamping (exit 2 bad args, exit 1 unstamped reference).
- `scripts/start-server.sh [--foreground|--watch]`: proven start script (blueprint §3.2); logs to `.server/`.
- `npm test`: `node --test`. `npm run icons`: regenerate the PNG icons. `npm run server`: restart the server in the background and tail the log. `npm run models [-- --json]`: list the account's Copilot models and check `models.json`. `npm run spike:image -- <image> [--deadline YYYY-MM-DD] [--role <role>] [--mode both|file|blob]`: phase 0 test 1 (image input); refuses images inside the repo except `.server/`. `npm run spike:web [-- --role <role>] [--tools a,b] [--only fetch,search,refuse,cache]`: phase 0 test 2 (web tools, refusals, cache). `npm run storage:check [-- --no-wait]`: phase 0 verify step 7 (clone, write and push, then push again after an `inbox/` commit made on GitHub).
- `node scripts/item-check.js [worker address]`: live parent-role check (writes two invented notes, checks learner/parent access through the Worker, deletes them).
- `node scripts/worker-check.js [worker address]` (asks for the address if not given): set-up check after WP-011 — Worker settings, matching pass secrets, `/status`, backend address and `/wake` on an awake Codespace.

## Routes
- `GET /api/health` (no pass). Times are UK time (`+00:00`/`+01:00`), including `port.updatedAt`.
- `GET /api/item?type=&id=&task=` (pass): learner opens all types; parent opens only notes, plans and drafts with `sharedWithParent` set; unshared and missing both return 404.
- `/api/health` `ai` = `{ ready, roles, errors, mode }`; `mode` is `starting` | `off` | `mock` | `copilot`; each `roles` entry is `{ model, ok, ms | error }`. The AI start-up test runs after the server starts listening.
- `/api/health` `port` = `{ visibility, detail, attempts, updatedAt }`; `visibility` is `unknown` | `n/a` | `pending` | `public` | `private`. The port manager starts after listening.
- `/api/health` `storage` = `{ ok, ready, lastPull, lastPush, pending, detail }`. Storage starts after listening.

## Pages
- Learner `/`: sign-in, signed-in screen, waking (polls `/api/health` every 5 s for up to 5 min; `/status` every third poll; rings again if still `Shutdown`; port hint after 90 s `Available`). Pass in `localStorage` on own devices, `sessionStorage` only on a shared computer.
- Parent `/parent/`: sign-in, pass check through the Worker's `/status`, no waking.

## Worker routes (`wake/worker.js`)
- `GET /`: no pass; `{ ok, service, missing, settingsErrors }`, names only.
- `GET /auth/login?shared=0|1`: redirects to GitHub OAuth (no scopes, signed state, valid for 10 minutes).
- `GET /auth/callback`: redirects to `APP_URL#pass=…` (learner) or `APP_URL/parent/#pass=…` (parent), or `APP_URL#error=not-configured|cancelled|expired|github|not-allowed`.
- `GET /status` (pass): `{ state, backendUrl }`.
- `POST /wake` (pass): `{ state, started, backendUrl }`; 409 from GitHub is returned as 200 with `started: false`.
- `GET /snapshot` (pass; storage settings needed): the role's section of `index/snapshot.json`; no snapshot → 404.
- `GET /item?type=&id=&task=` (pass; storage settings needed): same rules as `/api/item`; unshared or missing → 404. Reads via the GitHub contents API (`Accept: application/vnd.github.raw`).
- Pass failures: 401 `{ error, reason }`. GitHub failures: 502 `{ error, githubStatus, acceptedPermissions? }`. Other origins: 403. Body over 1 KB: 413.

## Settings and secrets expected
- Server (optional, non-secret): `PORT`, `HOST`, `IDLE_TIMEOUT_MIN`, `DEV_ORIGINS`. Also read if present (set by Codespaces): `CODESPACE_NAME`, `GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN`.
- AI (optional, non-secret): `AI_MOCK=1` (use the mock AI), `COPILOT_WORK_DIR` (SDK work folder; default is under the OS temp folder).
- `COPILOT_GITHUB_TOKEN`: read by `server/ai/index.js` only (passed to the Copilot adapter); never logged.
- `GH_PORTS_TOKEN`: read by `server/port.js` only (passed to `gh` as `GH_TOKEN`); never logged.
- `STORAGE_REPO`, `STORAGE_TOKEN`: read by `server/storage/index.js` only. The token is passed to git as an auth header in the environment and is never logged. Optional, non-secret: `STORAGE_DIR` (default `/workspaces/storage`; must be outside the app repository).
- `PASS_SIGNING_KEY` (32 characters or more), `PASS_VERSION` (whole number ≥ 1) and `ALLOWED_ACCOUNTS` (JSON login → `learner`/`parent`): read by `server/auth.js` (`createAuth`) only; never logged. The server calls `passSettings` at start-up and logs `[auth] off: …` (names only) if they're missing.
- Front end: `web/config.js` `workerUrl` is set to the Worker address.
- **Worker (Cloudflare) settings:** text `CODESPACE_NAME`, `ALLOWED_ORIGIN`, `APP_URL`, `OAUTH_CLIENT_ID`, `PASS_VERSION`; secret `GITHUB_TOKEN` (Codespaces lifecycle), `OAUTH_CLIENT_SECRET`, `PASS_SIGNING_KEY`, `ALLOWED_ACCOUNTS`. Also `STORAGE_TOKEN` (secret; a separate token from the Codespace's) and `STORAGE_REPO` (text), used by `/snapshot` and `/item`.

## Verify steps passed
1–7 passed (step 6 on 21 Oct 2026 after WP-008; step 7 on 21 Oct 2026 after WP-009: `storage:check` PASS, pulled the inbox commit before pushing).

## Deviations in effect
- `server/storage/store.js` (WP-009): git error text in `[storage]` logs and `storage.detail` has the storage repository's `owner/name` replaced with `<storage-repo>`, because git errors quote the remote URL and `/api/health` is public.

## Known issues
- Dependencies: `@github/copilot-sdk` 1.0.22 (pinned).
- Verify step 8 parent-role check: run by Simon after WP-013 (`node scripts/item-check.js`).
- Worker live checks (sign-in, `/status`, `/wake` on an awake Codespace) are done by Simon after merge. Remote wake from Shutdown is first tested in WP-012 (verify step 8).
- `spike:web` built-in tool line is misleading with SDK 1.0.22: `BuiltInTools` is `{ Isolated: [...] }` (a curated subset with no web tools), so the report shows `Isolated` as the only tool and flags `web_fetch, web_search` as "not in the SDK list". Reporting only; not changed.
- `EADDRINUSE` on restart: most likely the `--watch` attach command, queued behind the boot-time foreground start, firing during `npm run server`'s 1-second pause. After WP-008 (server frees the port at once on `SIGTERM`), one restart showed a single start launched by `npm run server` and no `EADDRINUSE`. Treat as likely fixed; if it returns, check `grep -E "starting:|already in use" .server/server.log`. `start-server.sh` is proven and unchanged.
- `node -e "import('@github/copilot-sdk')…"` fails (SDK 1.0.22 calls `createRequire` on the importing filename, which is `[eval]` under `-e`). Importing from a module file, as the server does, works.
