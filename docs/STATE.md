STATE version: 14
Updated: 2026-10-29 14:43 (UK time)
Last work package applied: WP-014b

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
scripts/inbox-check.js
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
server/ai/limits.js
server/ai/mock.js
server/ai/models.js
server/ai/tools.js
server/auth.js
server/config.js
server/index.js
server/port.js
server/storage/git.js
server/storage/inbox.js
server/storage/index.js
server/storage/items.js
server/storage/records.js
server/storage/snapshot.js
server/storage/store.js
test/ai.test.js
test/auth.test.js
test/capture.test.js
test/codespace.test.js
test/front-end.test.js
test/image-input.test.js
test/inbox-check.test.js
test/inbox.test.js
test/items.test.js
test/port.test.js
test/server.test.js
test/snapshot.test.js
test/stamp-versions.test.js
test/storage-recovery.test.js
test/storage.test.js
test/web-shell.test.js
test/web-tools.test.js
test/worker-inbox.test.js
test/worker.test.js
wake/worker.js
web/app.css
web/app.js
web/capture.js
web/config.js
web/icons/icon-192.png
web/icons/icon-512.png
web/index.html
web/manifest.webmanifest
web/parent/index.html
web/parent/parent.js
web/shared/auth.js
web/shared/capture.js
web/shared/wake.js
```

## Exports
- `web/app.js`: `loginUrl` (re-exported from `web/shared/auth.js`); runs the page when a DOM exists
- `web/shared/auth.js`: `PASS_ROLES`, `PASS_KEY_PREFIX`, `REQUEST_TIMEOUT_MS`, `SIGN_IN_MESSAGES`, `signInMessage`, `workerEndpoint`, `loginUrl`, `readFragment`, `decodePass`, `passIsCurrent`, `checkNewPass`, `memoryStorage`, `usableStorage`, `storageKey`, `savePass`, `loadPass`, `clearPass`, `readJsonBody`, `timeoutSignal`, `workerRequest`
- `web/shared/wake.js`: `WAKE_SETTINGS`, `WAKE_MESSAGES`, `probeHealth`, `createWaker`
- `web/shared/capture.js`: `INBOX_MAX_BYTES`, `CLIENT_ID_PATTERN`, `INBOX_TYPES`, `INBOX_SOURCES`, `INBOX_KINDS`, `IMAGE_TOO_LARGE_MESSAGE` (copies; tested against the server), `uploadIdFor`, `RESIZE`, `UPLOAD_TIMEOUT_MS`, `POLL_MS`, `POLL_LIMIT_MS`, `MAX_FILES_AT_ONCE`, `MAX_ROWS`, `FILE_ACCEPT`, `CAPTURE_MESSAGES`, `newClientId`, `titleForClientId`, `formatBytes`, `shortTime`, `classifyFile`, `fitWithin`, `encodeWithinLimits`, `bytesToBase64`, `prepareCapture`, `sendCapture`, `inboxItems`, `snapshotUploads`, `mergeCaptures`, `needsPolling`, `createCaptureQueue` → `{ add, retry, refresh, start, stop, rows, idle }`
- `web/capture.js`: `resizeImage(file)`, `createCaptureScreen({ workerUrl, onSignedOut, doc? })` → `{ start(token), stop() }` or null
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
- `server/storage/store.js`: `BATCH_MS` (5000), `RETRY_DELAYS_MS`, `checkPath(relPath, { allowInbox? })`, `createStore({ dir, remoteUrl, env, runGit?, batchMs?, retryDelays?, log?, now?, sleep?, onStatus?, beforeCommit? })` → `{ dir, status(), init(), flush(), commitLocal(), put(path, record), append(path, entry), remove(path, { allowInbox? }), move(from, to), sync(), logEvent(type, options?), read(path), list(dir) }`. `beforeCommit` runs inside the git lock, before `git add`, once per batch with changes; a failure is logged and never blocks saving. Also exports `conflictRule(relPath)`, `unionLines(remoteText, localText)`, `parseUnmerged(text)`; `syncLocked`/`flush`/`sync` results may include `recovered: string[]` or `attention: true`.
- `server/storage/index.js`: `DEFAULT_STORAGE_DIR` (`/workspaces/storage`), `APP_ROOT`, `storageSettings(env?, { appRoot? })`, `snapshotStep`, `startStorage({ state, config, env?, log?, makeStore?, getImageLimits?, inbox? })` (starts the inbox poller) → store or null (never throws)
- `server/storage/items.js` (item block): `SNAPSHOT_PATH`, `ITEM_ID_PATTERN`, `ITEM_TYPES`, `itemPath`, `itemTypeAllowed`, `snapshotSection`; Node only: `ITEM_BLOCK_START`, `ITEM_BLOCK_END`, `extractItemBlock`, `itemResponse`
- `server/storage/inbox.js` (inbox block): `INBOX_MAX_BYTES`, `INBOX_MAX_BASE64`, `CLIENT_ID_PATTERN`, `INBOX_TYPES`, `INBOX_SOURCES`, `INBOX_KINDS`, `inboxPaths`, `uploadIdFor`, `base64Bytes`, `inboxMetadata`; Node only: `INBOX_BLOCK_START`, `INBOX_BLOCK_END`, `extractInboxBlock`, `POLL_MS` (10000), `POLL_BACKOFF_MS` (60000), `LIMITS_WAIT_MS` (45000), `checkInboxMetadata(raw, clientId)`, `uploadRecord({ meta, sizeCheck, now? })`, `processInbox({ store, getImageLimits?, waitForLimits?, now?, log? })` → `{ processed, failed, duplicates, waiting, skipped }`, `startInboxPoller({ store, getImageLimits?, log?, pollMs?, backoffMs?, … })`
- `server/ai/limits.js`: `IMAGE_TOO_LARGE_MESSAGE`, `imageLimits(list, modelId)`, `checkImage({ bytes, mimeType }, limits)`, `loadImageLimits(handle, role = 'light')` (reads `handle.models[role]` and `handle.ai.listModels()`; null on failure)
- `scripts/inbox-check.js`: `USAGE`, `LARGE_BYTES`, `PUSH_WAIT_MS` (30000), `checkIds(now?)`, `captures(largeBytes?)`, `waitForServerPush({ serverHealth, sleep?, clock?, waitMs?, stepMs? })`, `localHealth(env?, fetchImpl?)`, `runCheck({ workerUrl, env?, fetchImpl?, makeStore?, tmpRoot?, serverHealth?, … })` (tidy-up waits for the server to push first)
- `server/storage/snapshot.js`: `buildSnapshot`, `UPCOMING_LIMIT`, `RECENT_LIMIT`, `SHARED_LIMIT`
- `scripts/item-check.js`: `USAGE`, `TEST_IDS`, `testNote`, `runCheck`
- `scripts/storage-check.js`: `INBOX_TEST_FILE`, `USAGE`, `parseArgs(argv)`, `runCheck({ settings, wait?, waitForOwner, makeStore?, tmpRoot?, out? })`
- `server/auth.js` (pass block): constants `PASS_ROLES`, `PASS_TTL_OWN_S`, `PASS_TTL_SHARED_S`, `PASS_MAX_LENGTH`, `PASS_MIN_KEY_LENGTH`, `PASS_CLOCK_SKEW_S`, `PARENT_READABLE_TYPES` (`notebook`, `plan`, `draft`); functions `passB64urlEncode`, `passB64urlDecode`, `parseAllowedAccounts(raw)` → `{ accounts, error }`, `passSettings(env)` → `{ settings, errors }`, `roleFor(accounts, login)`, `mintPass({ login, shared?, settings, now? })`, `verifyPass(token, settings, { now? })` → `{ ok, pass } | { ok: false, reason }` (reasons: `not-configured`, `missing`, `malformed`, `signature`, `expired`, `version`, `account`), `passFromHeader(value)`, `canReadItem(role, type, record)`
- `server/auth.js` (Node only): `PASS_BLOCK_START`, `PASS_BLOCK_END`, `extractPassBlock(source)`, `AUTH_MESSAGES`, `createAuth({ env?, log?, now? })` → `{ ready, errors, authenticate(headers), authorise(pass, roles), canRead(pass, type, record) }`
- `wake/worker.js`: `default { fetch(request, env) }` only (Cloudflare module Worker; contains the pass block).
- `scripts/worker-check.js`: `USAGE`, `normaliseWorkerUrl(text)`, `expectedBackendUrl(env?)`, `runCheck({ workerUrl, env?, fetchImpl?, out? }): Promise<boolean>`
- **Shared code rule:** the block between the `PASS BLOCK` markers in `server/auth.js` (WP-011) and the block between the `ITEM BLOCK` markers in `server/storage/items.js` (WP-013) and the block between the `INBOX BLOCK` markers in `server/storage/inbox.js` (WP-014a) are each copied verbatim into `wake/worker.js`. Change both copies together; tests check they are identical.
- **Front-end copies rule:** the copies in `web/shared/capture.js` (`CLIENT_ID_PATTERN`, `INBOX_TYPES`, `INBOX_MAX_BYTES`, `INBOX_SOURCES`, `INBOX_KINDS`, `uploadIdFor`, `IMAGE_TOO_LARGE_MESSAGE`) are checked against `server/storage/inbox.js` and `server/ai/limits.js` by `test/capture.test.js`; a change to either server value must be copied there too.
- **Item paths:** lookup is `type` + `id` (+ `task` for items in a task folder): `notebook/<id>.json`, `sources/<id>.json`, `tasks/<id>/task.json`, `tasks/<task>/plan.json` (id checked, not used), `tasks/<task>/drafts/<id>.json` (id `v<n>`), `tasks/<task>/feedback/<id>.json`. IDs match `^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$`.
- **Snapshot (`index/snapshot.json`):** titles, dates and counts only (titles from a record's own `title` or its task's title, else a plain label); learner and parent sections; settings keep short strings, numbers and booleans; app name from `profile/app.json` (`displayName`, then `name`), null if absent; `planStatus` and `nextSession` null for now. Uploads appear in `learner.recent` as `type: 'upload'`, title Photo/File, with `status` only (never extracted text; never in the parent section). Written by the store's `beforeCommit` step, so the first batch after start-up refreshes it.

## Scripts
- `scripts/stamp-versions.sh <web-dir> <version>`: deploy-time `?v=` stamping (exit 2 bad args, exit 1 unstamped reference).
- `scripts/start-server.sh [--foreground|--watch]`: proven start script (blueprint §3.2); logs to `.server/`.
- `npm test`: `node --test`. `npm run icons`: regenerate the PNG icons. `npm run server`: restart the server in the background and tail the log. `npm run models [-- --json]`: list the account's Copilot models and check `models.json`. `npm run spike:image -- <image> [--deadline YYYY-MM-DD] [--role <role>] [--mode both|file|blob]`: phase 0 test 1 (image input); refuses images inside the repo except `.server/`. `npm run spike:web [-- --role <role>] [--tools a,b] [--only fetch,search,refuse,cache]`: phase 0 test 2 (web tools, refusals, cache). `npm run storage:check [-- --no-wait]`: phase 0 verify step 7 (clone, write and push, then push again after an `inbox/` commit made on GitHub).
- `node scripts/inbox-check.js [worker address]`: verify steps 9 (server half) and 10 (8 MB through the Worker); sends two invented files and tidies up.
- `node scripts/item-check.js [worker address]`: live parent-role check (writes two invented notes, checks learner/parent access through the Worker, deletes them).
- `node scripts/worker-check.js [worker address]` (asks for the address if not given): set-up check after WP-011 — Worker settings, matching pass secrets, `/status`, backend address and `/wake` on an awake Codespace.

## Routes
- `GET /api/health` (no pass). Times are UK time (`+00:00`/`+01:00`), including `port.updatedAt`.
- `GET /api/item?type=&id=&task=` (pass): learner opens all types; parent opens only notes, plans and drafts with `sharedWithParent` set; unshared and missing both return 404.
- `/api/health` `ai` = `{ ready, roles, errors, mode }`; `mode` is `starting` | `off` | `mock` | `copilot`; each `roles` entry is `{ model, ok, ms | error }`. The AI start-up test runs after the server starts listening.
- `/api/health` `port` = `{ visibility, detail, attempts, updatedAt }`; `visibility` is `unknown` | `n/a` | `pending` | `public` | `private`. The port manager starts after listening.
- `/api/health` `storage` = `{ ok, ready, lastPull, lastPush, pending, detail }`. Storage starts after listening.

## Sync clashes (WP-014a-fix)
When `git pull --rebase` clashes, `syncLocked()` settles server-made files itself: event logs (`events/*.jsonl`) are merged by line (both sides kept once); `index/snapshot.json` takes the remote side and is rebuilt in the next batch; `inbox/` prefers the remote (Worker) copy; `uploads/` prefers the local (server) copy. Anything else aborts the rebase, keeps local commits, sets `storage.detail` to `needs attention: sync clash in <paths> …` (paths only) and stops pulling until restart; saving continues locally. Manual fix: inspect and resolve in `/workspaces/storage`, then `npm run server`.

## Pages
- Learner `/`: sign-in, signed-in screen, waking (polls `/api/health` every 5 s for up to 5 min; `/status` every third poll; rings again if still `Shutdown`; port hint after 90 s `Available`). Pass in `localStorage` on own devices, `sessionStorage` only on a shared computer.
  - Capture section (camera, gallery, file). Images are resized on the device to JPEG ≤ 1,600 px and ≤ ~700 KB; PDF and Word go unchanged up to 8 MB. Captures go to the Worker `POST /inbox` as `kind=brief`, one at a time, with a device client ID (`p…` photo, `f…` file); Try again reuses the ID. The "Your photos and files" list merges this device's captures, `GET /inbox` (waiting) and the snapshot's upload entries, checked every 15 s while anything is pending, for up to 15 minutes after the last activity. Nothing is kept in browser storage.
- Parent `/parent/`: sign-in, pass check through the Worker's `/status`, no waking.

## Worker routes (`wake/worker.js`)
- `GET /`: no pass; `{ ok, service, missing, settingsErrors }`, names only.
- `GET /auth/login?shared=0|1`: redirects to GitHub OAuth (no scopes, signed state, valid for 10 minutes).
- `GET /auth/callback`: redirects to `APP_URL#pass=…` (learner) or `APP_URL/parent/#pass=…` (parent), or `APP_URL#error=not-configured|cancelled|expired|github|not-allowed`.
- `GET /status` (pass): `{ state, backendUrl }`.
- `POST /wake` (pass): `{ state, started, backendUrl }`; 409 from GitHub is returned as 200 with `started: false`.
- `GET /snapshot` (pass; storage settings needed): the role's section of `index/snapshot.json`; no snapshot → 404.
- `GET /item?type=&id=&task=` (pass; storage settings needed): same rules as `/api/item`; unshared or missing → 404. Reads via the GitHub contents API (`Accept: application/vnd.github.raw`).
- `POST /inbox?clientId=&type=&source=camera|gallery|file&kind=brief|own&capturedAt=` (learner pass; body = base64 text, up to 8 MB decoded): writes the file, then the metadata, to `inbox/`; 201 `{ clientId, uploadId, bytes, status: 'received' }`; 400/403/413/502.
- `GET /inbox` (any pass): `{ items: [{ clientId, uploadId, bytes }], count }`, complete captures only.
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
- Steps 1–7 passed (step 6 on 21 Oct 2026 after WP-008; step 7 on 21 Oct 2026 after WP-009: `storage:check` PASS, pulled the inbox commit before pushing).
- Step 8 passed 26 Oct 2026: sign-in on phone, laptop and shared computer after WP-012; parent-role `item-check` PASS after WP-013.
- Step 10 passed 26 Oct 2026 (8 MB through the Worker, 4.2–5.4 s).
- Step 9 server half passed 26 Oct 2026 (device half in WP-014b).

## Deviations in effect
- `server/storage/store.js` (WP-009): git error text in `[storage]` logs and `storage.detail` has the storage repository's `owner/name` replaced with `<storage-repo>`, because git errors quote the remote URL and `/api/health` is public.
- `test/storage.test.js` (WP-014a-fix): the fake git answers `ls-files` (no unmerged paths), and the "failed pull aborts the rebase" test expects `ls-files` then `rebase` after the failed pull, because `syncLocked` now checks for clashes first.

## Known issues
- Dependencies: `@github/copilot-sdk` 1.0.22 (pinned).
- Verify step 9 device half: waiting for Simon's live check after WP-014b (not yet passed).
- `spike:web` built-in tool line is misleading with SDK 1.0.22: `BuiltInTools` is `{ Isolated: [...] }` (a curated subset with no web tools), so the report shows `Isolated` as the only tool and flags `web_fetch, web_search` as "not in the SDK list". Reporting only; not changed.
- The queued `postAttachCommand` (`--watch`) runs once per Codespace start, when the first foreground server exits (seen 26 Oct: new server 1.4 s after `pkill`). Harmless when only one server is running. `start-server.sh` and `devcontainer.json` are proven and unchanged.
- `node -e "import('@github/copilot-sdk')…"` fails (SDK 1.0.22 calls `createRequire` on the importing filename, which is `[eval]` under `-e`). Importing from a module file, as the server does, works.
