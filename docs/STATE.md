STATE version: 28
Updated: 2026-11-01 21:48 (UK time)
Last work package applied: WP-108a

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
evals/cases/background.json
evals/cases/boundary.json
evals/cases/spelling.json
evals/cases/support.json
evals/cases/wellbeing.json
evals/run.js
evals/system-placeholder.md
models.json
package-lock.json
package.json
scripts/alert-check.js
scripts/curriculum-check.js
scripts/inbox-check.js
scripts/item-check.js
scripts/list-copilot-models.js
scripts/make-documents.js
scripts/make-icons.js
scripts/spike-custom-tools.js
scripts/spike-documents.js
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
server/ai/prompt.js
server/ai/read-tools.js
server/ai/reading.js
server/ai/tools.js
server/alerts.js
server/api.js
server/auth.js
server/config.js
server/curriculum.js
server/documents.js
server/domain/fields.js
server/domain/tasks.js
server/domain/uploads.js
server/domain/work.js
server/index.js
server/port.js
server/rate-limits.js
server/reader.js
server/storage/git.js
server/storage/inbox.js
server/storage/index.js
server/storage/items.js
server/storage/records.js
server/storage/snapshot.js
server/storage/store.js
skills/core/SKILL.md
skills/learn/SKILL.md
skills/plan/SKILL.md
skills/research/SKILL.md
skills/review/SKILL.md
test/accessibility.test.js
test/ai.test.js
test/alerts.test.js
test/auth.test.js
test/capture.test.js
test/curriculum.test.js
test/codespace.test.js
test/custom-tools.test.js
test/documents.test.js
test/evals.test.js
test/front-end.test.js
test/image-input.test.js
test/inbox-check.test.js
test/inbox.test.js
test/items.test.js
test/port.test.js
test/prompt.test.js
test/read-tools.test.js
test/reader-documents.test.js
test/reader.test.js
test/reading.test.js
test/server.test.js
test/snapshot.test.js
test/stamp-versions.test.js
test/upload-paste.test.js
test/upload-routes.test.js
test/storage-recovery.test.js
test/storage.test.js
test/web-shell.test.js
test/web-tools.test.js
test/work-api.test.js
test/work-records.test.js
test/worker-inbox.test.js
test/worker-repo-file.test.js
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
web/shared/accessibility.js
web/shared/auth.js
web/shared/capture.js
web/shared/wake.js
```

## Exports
- `web/app.js`: `loginUrl` (re-exported from `web/shared/auth.js`); runs the page when a DOM exists
- `web/shared/auth.js`: `PASS_ROLES`, `PASS_KEY_PREFIX`, `REQUEST_TIMEOUT_MS`, `SIGN_IN_MESSAGES`, `signInMessage`, `workerEndpoint`, `loginUrl`, `readFragment`, `decodePass`, `passIsCurrent`, `checkNewPass`, `memoryStorage`, `usableStorage`, `storageKey`, `savePass`, `loadPass`, `clearPass`, `readJsonBody`, `timeoutSignal`, `workerRequest`
- `web/shared/wake.js`: `WAKE_SETTINGS`, `WAKE_MESSAGES`, `probeHealth`, `createWaker`
- `web/shared/accessibility.js`: `ACCESSIBILITY_OPTIONS`, `ACCESSIBILITY_DEFAULTS`, `DYSLEXIA_FONT_STACK`, `ACCESSIBILITY_PROPERTIES`, `ACCESSIBILITY_ATTRIBUTES`, `ACCESSIBILITY_STORAGE_KEY` (`edu-support.settings.accessibility`), `normaliseAccessibility(raw)`, `readAccessibility(body)`, `accessibilityStyle(settings)` → `{ properties, attributes }`, `applyAccessibility(root, settings)`, `resetAccessibility(root)`, `loadAccessibility(store)`, `saveAccessibility(store, settings, { shared? })`, `clearAccessibility(store)`, `createAccessibility({ workerUrl, root, local?, fetchImpl? })` → `{ start({ token, shared }), refresh(), stop() }`
- `web/shared/capture.js`: `INBOX_MAX_BYTES`, `CLIENT_ID_PATTERN`, `INBOX_TYPES`, `INBOX_SOURCES`, `INBOX_KINDS`, `IMAGE_TOO_LARGE_MESSAGE` (copies; tested against the server), `uploadIdFor`, `RESIZE`, `UPLOAD_TIMEOUT_MS`, `POLL_MS`, `POLL_LIMIT_MS`, `MAX_FILES_AT_ONCE`, `MAX_ROWS`, `FILE_ACCEPT`, `CAPTURE_MESSAGES`, `newClientId`, `titleForClientId`, `formatBytes`, `shortTime`, `classifyFile`, `fitWithin`, `encodeWithinLimits`, `bytesToBase64`, `prepareCapture`, `sendCapture`, `inboxItems`, `snapshotUploads`, `mergeCaptures`, `needsPolling`, `createCaptureQueue` → `{ add, retry, refresh, start, stop, rows, idle }`
- `web/capture.js`: `resizeImage(file)`, `createCaptureScreen({ workerUrl, onSignedOut, doc? })` → `{ start(token), stop() }` or null
- `web/config.js`: `config` (frozen object: `{ workerUrl: string }`)
- `scripts/make-icons.js`: `renderIcon(size: number): Buffer`, `encodePng(size: number, raw?: Buffer): Buffer`
- `server/config.js`: `PAGES_ORIGIN` (string), `loadConfig(env = process.env)` → frozen `{ port, host, idleTimeoutMin, devOrigins, jsonBodyLimit, uploadBodyLimit, rateLimitPerMin, aiDailyCeiling, codespaceName, publicUrl }`, `isAllowedOrigin(origin: string | undefined, config: { devOrigins: boolean }): boolean`
- `server/index.js`: `class HttpError(status, message)`, `createState(config, now = new Date())` → `{ startedAt, restsAt, ai, storage, port }`, `healthBody(state)`, `readJson(req, limit): Promise<unknown>`, `createHandler({ config, state, log = console, authSettings = null, getStore = () => null, getCurriculum = () => null, rateLimiter = null })`, `checkPass`, `createServer(config, state?, log?, options?)` with `options = { authSettings, getStore, getCurriculum, rateLimiter }` → `{ server, state }`, `processChain(pid, { depth?, read? }): string`
- `server/domain/fields.js`: `class DomainError(status, message)`, `bad(message)` (400), `notFound(what)` (404), `TEXT_AUTHORS`, `TOPIC_ID_FALLBACK`, `QUAL_ID_FALLBACK`, `plainObject`, `onlyKeys`, `shortString(value, name, { max, required? })`, `textField(value, name, { max, authors?, defaultAuthor, required? })` → `{ value, author }`, `oneOf(value, name, allowed, { required? })`, `ukDate`, `wholeNumber`, `flag`, `recordId`, `topicId(value, name, curriculum)`, `topicIds(value, name, curriculum, { max })`, `qualificationId(value, name, curriculum)`, `idDate(id)`. Error messages name fields only, never learner text.
- `server/domain/tasks.js`: `TASK_KINDS`, `WORK_TYPES`, `STAGES`, `FINISHED_STAGES`, `ANCHOR_TYPES`, `ANCHOR_AUTHORS`, `TASK_LIMITS`, `TASK_FIELDS`, `taskPath(id)`, `newAnchor(body, { createdBy?, now? })`, `newTask(body, { curriculum?, createdBy?, now? })`, `applyTaskChanges(task, body, { curriculum?, now? })` → `{ task, changed, stage }`, `withTaskLock(id, fn)`, `readTask(store, id)`, `listTasks(store, { open? })`, `createTask(store, body, opts?)`, `updateTask(store, id, body, opts?)`, `addAnchor(store, taskId, body, opts?)`, `updateAnchor(store, taskId, anchorId, body, opts?)`, `removeAnchor(store, taskId, anchorId, opts?)` `newTask` and `createTask` also take `sourceUploads` (WP-108a; default `[]`).
- `server/domain/uploads.js` (WP-108a): `PASTE_MAX_CHARS`, `ESSENTIAL_FIELDS` (`title, subject, deadline, question`), `CONFIRM_FIELDS`, `UPLOAD_MESSAGES`, `fieldsToAsk(proposal)`, `uploadView(record)`, `openUpload(store, id)`, `confirmUpload(store, id, body, { curriculum?, now? })` → `{ task, upload } | { alreadyTaskId }`, `addPastedBrief(store, body, { now? })` → `{ upload, duplicate }`
- `server/domain/work.js`: `SUPPORT_TYPES` (`hint, breakdown, pointer, explanation`), `SUPPORT_OUTCOMES` (`tried-again, solved, gave-up`), `CHECK_RESULTS` (`passed, regenerated, fallback`), `WORK_LIMITS`, `attemptPath(id)`, `aiTurnPath(id)`, `newAttempt(body, { curriculum?, now? })`, `recordAttempt(store, body, opts?)`, `readAttempt(store, id)`, `logSupport(store, { type, route, attemptId, taskId?, topicId? })`, `logSupportOutcome(store, { supportEventId, outcome })`, `newAiTurn(fields, { now? })`, `saveAiTurn(store, fields, { now? })`. Imports `ROUTES` (prompt.js) and `ROLES` (models.js), both side-effect free.
- `server/rate-limits.js`: `RATE_WINDOW_MS` (60000), `MAX_TRACKED_PASSES` (200), `RATE_LIMIT_MESSAGE`, `AI_CEILING_MESSAGE`, `passKey(pass)`, `createRateLimiter({ limit, windowMs?, now?, maxKeys? })` → `{ take(key) → { ok, remaining } | { ok: false, retryAfterS }, size() }`, `createAiCeiling({ limit, now? })` → `{ take() → { ok, used, limit, message? }, status() → { day, used, limit } }` (resets at UK midnight)
- `server/ai/reading.js`: `READ_RETRY_BELOW` (0.7), `TOPIC_UNSURE_BELOW` (0.5), `READ_LIMITS`, `READ_ANCHOR_TYPES`, `PROPOSAL_FIELDS`, `READ_SYSTEM`, `MATCH_SYSTEM`, `qualificationsFor`, `readPrompt({ kind, today, qualifications })`, `uncertainPassages`, `editDistance`, `isUsSpelling`, `locateWord`, `filterCorrections(list, text, uncertain)`, `applyCorrections(text, corrections, { offset })`, `correctQuestion`, `normaliseReading(reply, { kind })`, `proposalAnchors`, `buildProposal(reading, { qualifications })`, `topicCandidates(curriculum, qualificationId)`, `matchPrompt({ candidates, proposal })`, `parseMatch`. WP-107: `DOC_SYSTEM`, `DOC_PROMPT_CHARS` (12000), `documentPrompt({ today, qualifications, text })`, `normaliseDocumentBrief(replyText, text)`, `pageUncertainty(pages)`, `fillFromTopics(proposal, curriculum)`; `readPrompt` takes `source: 'photo' | 'scan'`.
- `server/reader.js`: `READER_POLL_MS` (10000), `READER_BACKOFF_MS` (60000), `READ_TIMEOUT_MS` (90000), `MAX_READ_TRIES` (3), `READS_PER_CYCLE` (3), `READ_FAILURE_REASONS`, `uploadPath(id)`, `isImageUpload`, `pendingImageUploads(store)`, `createLimitCache(loadLimits)`, `readUpload(...)` → `{ status: done|failed|again|waiting|error, reason? }`, `processBacklog(...)`, `startReader({ getStore, getAi, getCurriculum, isReady, aiCeiling, ... })` → `{ runOnce, stop }`. Started by `server/index.js` after listening; runs only when storage is ready, the curriculum has been tried and the AI mode is `copilot`; stopped on shutdown. WP-107: new `isDocumentUpload`, `pendingUploads(store)` (photos, Word and PDF); `READ_FAILURE_REASONS` also has `password` and `scanned-pdf`; `readUpload`, `processBacklog` and `startReader` take an optional `extract` (default `extractDocument`); `readUpload` can return `skipped` (reason `extractor-missing`); `processBacklog`'s summary has `skipped` and `skipReason`, and skipped uploads don't count towards the per-cycle limit (one pass per cycle, no retry inside it). WP-108a: `PASTE_TYPE` (`text/plain`), `isTextUpload(record)`; `pendingUploads` now includes pasted text.
- `server/api.js`: `API_ROUTES`, `API_MESSAGES`, `matchApiRoute(method, pathname)` → route match, `{ status: 405, allow }` or null, `handleApi({ match, pass, store, body?, query?, getCurriculum? })` → `{ status, body }`
- `server/ai/models.js`: `ROLES` (frozen array of 6 roles), `MODELS_URL` (URL), `validateModels(raw: unknown)` → `{ models, errors }`, `loadModels(url = MODELS_URL): Promise<{ models, errors }>` (never throws)
- `server/ai/copilot.js`: `SDK_PACKAGE`, `DEFAULT_WORK_DIR`, `redact(text): string`, `errorSummary(err, max = 300): string`, `loadSdk(importer?): Promise<{ sdk, error }>`, `builtInToolNames(value): string[]`, `sdkTools(sdk, customTools, { onToolCall }?)` → SDK tools (via `defineTool(name, config)` when exported), `createCopilotAi({ sdk, token, workDir?, log? })` → `{ mode: 'copilot', ask({ model, system, prompt, attachments?, tools?, customTools?, allowPermission?, onPermission?, onEvent?, onToolCall?, unsafeAllToolsForTest?, timeoutMs? }), listModels(), listBuiltInTools(), stop(), features: { defineTool } }`. Shell, write, read and MCP permission requests are always refused; the app's own tools (`customTools`) are approved by name only and added to `availableTools`, which otherwise defaults to `[]`; no `tools` key when there are none.
- `server/ai/mock.js`: `createMockAi({ replies?, failures?, models?, builtInTools?, permissionRequests?, events?, toolCalls? } = {})` → `{ mode: 'mock', ask, listModels, listBuiltInTools, stop, calls, features: { defineTool: false } }` (same `customTools`/`onToolCall` options as the adapter; tool results reach a reply function as `toolResults`)
- `server/ai/index.js`: `STARTUP_SYSTEM`, `STARTUP_PROMPT`, `createAi({ env?, importer?, log? }): Promise<{ ai, error }>`, `runStartupCheck({ ai, models, timeoutMs? }): Promise<{ ready, roles, errors }>`, `startAi({ state, env?, importer?, log?, modelsUrl?, timeoutMs? }): Promise<{ ai, models } | null>` (never throws)
- `scripts/list-copilot-models.js`: `describeModel(model): string`, `compareRoles(models, available)` → `[{ role, id, found }]`
- `server/ai/json.js`: `parseJsonReply(text: unknown): Record<string, unknown> | null`
- `server/ai/image-input.js`: `MAX_IMAGE_BYTES` (8 MB), `IMAGE_TYPES` (frozen ext → MIME map: jpg, jpeg, png, webp, gif), `checkImageFile(filePath, { maxBytes? } = {}): Promise<{ path, mimeType, bytes, displayName }>`, `fileAttachment(image)` → `{ type: 'file', path, displayName }`, `blobAttachment(image): Promise<{ type: 'blob', data, mimeType, displayName }>`
- `scripts/spike-image-input.js`: `REPO_ROOT`, `USAGE`, `parseArgs(argv)`, `resolveImagePath(input, { cwd?, repoRoot? } = {})`, `ukDate(now = new Date()): string`, `briefPrompts(today)` → `{ system, prompt }`, `checkBrief(parsed, { deadline? } = {})` → `{ verdict: 'PASS' | 'CHECK' | 'FAIL', reasons }`, `visionInfo(list, modelId)`, `runSpike({ ai, models, role?, imagePath, mode?, deadline?, now?, timeoutMs? })`, `formatReport(report): string[]`
- `server/ai/tools.js`: `WEB_TOOLS` (`['web_fetch', 'web_search']`), `WEB_PERMISSION_KINDS` (`['url']`), `NEVER_ALLOWED_KINDS` (`['shell', 'write', 'read', 'mcp']`), `permissionPolicy(kinds = [])` → `(request) => boolean`, `toolNameOf(value): string | null`, `describePermission(request)` → `{ kind, tool }`, `CUSTOM_TOOL_KIND` (`'custom-tool'`), `CUSTOM_TOOL_NAME_PATTERN`, `MAX_TOOL_RESULT_CHARS` (20000), `TOOL_ERROR_TEXT` (`'Not available.'`), `decidePermission(request, { allowPermission?, customNames? } = {}): boolean`, `checkCustomTools(list = []): string[]`, `toolResultText(value, max?): string`, `wrapToolHandler(tool, { onCall?, now? } = {})` → `async (args) => string` (onCall gets `{ name, ok, ms }` only)
- `scripts/spike-custom-tools.js`: `CHECKS` (`['call', 'refuse']`), `DEMO_TOOL`, `DEMO_TOPIC`, `USAGE`, `parseArgs(argv)`, `demoTool(code?)` → `{ code, seen, tool }`, `judgeCall({ parsed, code, seen })`, `runCall({ ai, model, timeoutMs })`, `runRefusal({ ai, model, variant, timeoutMs })`, `runSpike({ ai, models, role?, only?, timeoutMs? })`, `formatReport(report): string[]`
- `server/documents.js`: `DOCX_TYPE`, `PDF_TYPE`, `DOCUMENT_TYPES`, `MAX_DOCUMENT_BYTES` (= `INBOX_MAX_BYTES`), `MAX_PAGES` (40), `MAX_TEXT_CHARS` (100000), `EXTRACT_TIMEOUT_MS` (20000), `SCANNED_CHARS_PER_PAGE` (40), `LOW_TEXT_PAGE_CHARS` (10), `EXTRACT_REASONS`, `cleanText(text): string`, `textChars(text): number`, `joinTextItems(items): string`, `judgePages(pageChars)` → `{ scanned, lowTextPages, totalChars }`, `loadMammoth(importer?)` → `{ lib } | { error }`, `loadPdfjs(importer?, resolver?)` → `{ lib, fontDir, cmapDir } | { error }`, `extractDocument({ bytes, mimeType, timeoutMs?, maxPages?, loaders?, clock? })` → `{ ok: true, kind, text, pageCount, pagesRead, pageChars, scanned, lowTextPages, truncated, warnings, ms }` or `{ ok: false, kind, reason, ms }` (reasons from error names only, never messages). Called by `server/reader.js` (WP-107).
- `server/curriculum.js`: `CURRICULUM_DIR`, `CURRICULUM_FILES`, `QUAL_DIR_PATTERN`, `TOPIC_ID_PATTERN`, `MAX_FILE_BYTES` (2 MB), `MAX_COMMAND_WORDS` (30), `stringList(value): string[]`, `parseRecords(source): object[]`, `optionalGroupUnitIds(groups): Set`, `unitStatus(qual)` → `{ complete, incomplete, mandatory, optional, selected, active, current, currentSet }` (A-005: incomplete choice → every unit active), `loadQualification(root, name)` → `{ qual, errors }`, `loadCurriculum({ dir })` → `{ qualifications: Map, topics: Map, errors }`, `topicUnitState(curriculum, topic)` → `{ active, current }`, `listTopics(curriculum, { qualId?, activeOnly = true, currentOnly = false }?)` → `[{ id, qualId, unitId, title, kind }]`, `topicExtract(curriculum, topicId)` → `{ qualification, unit, topic, assessmentObjectives, commandWords } | null`, `startCurriculum({ dir, log? })` → curriculum or null (logs counts, file names and topic IDs only). Loaded by `server/index.js` once storage is ready; not yet used by any route (WP-104/111).
- `server/ai/read-tools.js`: `READ_CURRICULUM`, `READ_NOTEBOOK`, `NOTEBOOK_DIR`, `MAX_NOTEBOOK_ENTRIES` (20), `MAX_NOTEBOOK_FILES` (500), `MAX_ENTRY_TEXT` (2000), `TEXT_AUTHORS` (`learner, ai, source`), `readCurriculumTool({ getCurriculum })`, `notebookEntryForModel(raw)`, `readNotebookEntries(storageDir)`, `selectNotebookEntries(entries, scope = {}, args = {})` → `{ entries, more } | { entries: [], note }` (another task's notes never returned; model args only narrow the server's scope), `readNotebookTool({ getStorageDir, scope?, readEntries? })`, `createReadTools({ getCurriculum, getStorageDir, scope? })` → `[read_curriculum, read_notebook]`.
  - **Notebook record contract (for WP-115):** `{ id, type, title, text: { value, author }, taskId?, topicIds?, source?: { title, author, url }, updatedAt, deletedAt? }`; `read_notebook` also accepts `text` as a string with a top-level `author`.
- `server/ai/prompt.js`: `SKILLS_DIR`, `CORE_SKILL`, `ROUTES` (`research, plan, review, learn`), `PROFILE_FILES`, `MAX_PROFILE_BYTES` (64 KB), `MAX_TONE_EXAMPLES_CHARS` (8000), `TONE_START`, `TONE_END`, `DEFAULT_LABELS`, `LIMITS`, `PRESENTATION_WORDINGS`, `REPLY_CONTRACT`, `tagSafe`, `clip`, `normalisePresentation`, `presentationLines`, `normaliseLabels`, `cleanToneExamples`, `assembleSystem({ coreText, routeText?, presentation?, labels?, toneExamples? })`, `loadSkill(name, { dir?, read? })`, `buildSystem({ route?, settings?, dir?, read? })`, `loadProfileSettings({ storageDir, read? })` → `{ presentation, labels, toneExamples, problems }` (never throws; reads only those fields), `buildPrompt({ task, curriculum, notebook, conversation, attempt, draft, sourceText, message, instruction, contract? })`, `buildRequest({ route?, settings?, …parts })` → `{ system, prompt }`. Not yet called by any route (WP-111). `evals/run.js` re-exports `REPLY_CONTRACT`, `presentationLines` and `tagSafe` from it.
  - **Private prompt settings (contract; WP-141 and WP-121 write these files in the storage repository):**
    - `profile/learner.json`: a single JSON object. Only `presentation` (`{ paragraphLength: short|medium, numberedSteps: on|off, bullets: fewer|more, explanations: brief|fuller }`) and `labels` (`{ parent, parents }`) are read. Every other field is ignored and never reaches a model.
    - `profile/tone-examples.md`: Markdown, up to 8,000 characters. When present, it replaces the generic examples in the core skill file.
    - If either file is missing, the prompts use no presentation lines, the labels "a parent" / "your parents", and the generic examples.
    - Conversation turns passed to `buildPrompt`: `{ role: 'learner'|'tutor', text }`, oldest first (last 10 used).
- `scripts/curriculum-check.js`: `checkLines(curriculum): Promise<string[]>` (counts, unit-choice status and field names only, never content).
- `scripts/make-documents.js`: `crc32(buf): number`, `makeZip(entries): Buffer`, `makeDocx(paragraphs): Buffer`, `makePdf(pages): Buffer` (invented fixtures built in memory)
- `scripts/spike-documents.js`: `CHECKS` (`docx, pdf, scan, broken, long`), `MARKERS`, `LONG_PAGES` (60), `USAGE`, `parseArgs(argv)`, `typeForFile(name)`, `judge(check, result)`, `fixtureFor(check)`, `summary(result)`, `runSpike({ only?, file?, extract?, read? })`, `libraryVersions(resolver?, readJson?)`, `formatReport(report, versions?): string[]`
- `scripts/spike-web-tools.js`: `CHECKS`, `USAGE`, `parseArgs(argv)`, `numericFields(data)`, `createCollector()`, `toolEvidence(collector)`, `judgeFetch(parsed, evidence)`, `judgeSearch(parsed, evidence)`, `judgeRefusal({ text, secret, markerExists, permissions })`, `judgeCache(usageByCall)`, `cacheSystemPrompt(lines = 200)`, `runFetch`, `runSearch`, `runRefusal({ ai, model, tools, variant, timeoutMs })`, `runCache({ ai, model, timeoutMs })`, `runSpike({ ai, models, role?, tools?, only?, timeoutMs? })`, `formatReport(report): string[]`
- `server/port.js`: `PORT_LOG`, `ATTEMPTS` (18), `DELAY_MS` (10000), `visibilityArgs(port, codespaceName)`, `ghEnv(token, env?)`, `runGh(args, { env, timeoutMs? })`, `shortError(result)`, `appendPortLog(line, file?)`, `managePort({ state, config, port, env?, run?, sleep?, writeLog?, log?, attempts?, delayMs?, now? })` → `{ done, stop() }`
- `server/storage/records.js`: `SCHEMA_VERSION` (1), `CREATED_BY`, `MAX_EVENT_PAYLOAD_BYTES` (1024), `MAX_EVENT_STRING` (200), `ukIso(date?)`, `ukMonth(date?)`, `newId(prefix, date?)`, `newRecord(prefix, fields, { createdBy, now? })`, `updateRecord(record, changes?, { now? })`, `makeEvent(type, { links?, payload?, createdBy?, now? })`, `eventsPath(date?)`
- `server/alerts.js`: `ALERT_EVENT_TYPE` (`'app-alert'`), `ALERT_KINDS` (`['wellbeing', 'wake-failed']`), `ALERT_LEVELS` (`[2, 3]`), `ALERT_TIMEOUT_MS` (10000), `GITHUB_API`, `ukDate(now?)`, `alertSettings(env?)` → `{ repo, token } | { skip }`, `alertPayload({ kind, level?, now? })` → `{ payload } | { error }`, `sendAlert({ kind, level?, env?, settings?, fetchImpl?, now?, log?, timeoutMs? })` → `{ ok: true, status } | { ok: false, status, error, acceptedPermissions? }` (never throws)
- `scripts/alert-check.js`: `USAGE`, `DEFAULT_GAP_S` (90), `parseArgs(argv)`, `runCheck({ settings, only?, gapS?, send?, sleep?, out?, now? })` → `{ verdict: 'SENT' | 'FAIL', lines, results }`
- `evals/run.js`: `CASES_DIR`, `RESULTS_DIR`, `PLACEHOLDER_PATH`, `SKILL_CORE_PATH`, `REVIEW_PASSES` (5), `DEFAULT_TIMEOUT_S` (120), `CATEGORIES` (14), `BEHAVIOURS` (`decline-and-redirect`, `help`, `guide`, `acknowledge`, `care`, `json`), `CASE_ROLES` (every role except `judge`), `PROBLEMS`, `REPLY_CONTRACT`, `JOB_SYSTEM`, `JUDGE_SYSTEM`, `USAGE`, `parseArgs(argv)`, `validateCase(c)`, `validateCases(list)`, `loadCases(dir?)` → `{ cases, errors }`, `selectCases(cases, { categories?, ids?, limit? })`, `presentationLines(choices)`, `loadSystem({ skillPath?, placeholderPath? })` → `{ text, source }`, `subjectSystem(base, testCase)`, `tagSafe(text)`, `buildTurnPrompt(testCase, history, message)`, `buildJobPrompt(testCase)`, `buildJudgePrompt(testCase, transcript)`, `codeChecks(testCase, parsed)` → problem names, `runCase({ ai, models, testCase, systemText, subjectModel?, judgeModel?, timeoutMs? })` (never throws), `createRandom(seed)`, `pickForReview(results, { passes?, seed? })` → `{ failures, passes }`, `summarise(results)`, `runEvals({ ai, models, cases, systemText, subjectModel?, judgeModel?, seed?, timeoutMs?, onProgress? })` → `{ results, summary, review, seed }`, `formatReport(run, { now?, models?, judgeModel?, systemSource?, mode? })`, `writeResults(run, report, { dir?, now? })` → `{ md, json }`, `privateSamples(env?, fs?)` → `{ available, count }`, `createEvalMock(modelIds)`, `planLines({ cases, models, subjectModel?, judgeModel? })`
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
- `wake/worker.js`: `default { fetch(request, env, ctx) }` only (Cloudflare module Worker; contains the pass, item and inbox blocks). The default export answers `/repo-file` first (REPO FILE ROUTE block) and passes everything else to `mainWorker` (the existing routes, unchanged).
- `scripts/worker-check.js`: `USAGE`, `normaliseWorkerUrl(text)`, `expectedBackendUrl(env?)`, `runCheck({ workerUrl, env?, fetchImpl?, out? }): Promise<boolean>`
- **Shared code rule:** the block between the `PASS BLOCK` markers in `server/auth.js` (WP-011) and the block between the `ITEM BLOCK` markers in `server/storage/items.js` (WP-013) and the block between the `INBOX BLOCK` markers in `server/storage/inbox.js` (WP-014a) are each copied verbatim into `wake/worker.js`. Change both copies together; tests check they are identical.
- **Front-end copies rule:** the copies in `web/shared/capture.js` (`CLIENT_ID_PATTERN`, `INBOX_TYPES`, `INBOX_MAX_BYTES`, `INBOX_SOURCES`, `INBOX_KINDS`, `uploadIdFor`, `IMAGE_TOO_LARGE_MESSAGE`) are checked against `server/storage/inbox.js` and `server/ai/limits.js` by `test/capture.test.js`; a change to either server value must be copied there too.
- **Item paths:** lookup is `type` + `id` (+ `task` for items in a task folder): `notebook/<id>.json`, `sources/<id>.json`, `tasks/<id>/task.json`, `tasks/<task>/plan.json` (id checked, not used), `tasks/<task>/drafts/<id>.json` (id `v<n>`), `tasks/<task>/feedback/<id>.json`. IDs match `^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$`.
- **Snapshot (`index/snapshot.json`):** titles, dates and counts only (titles from a record's own `title` or its task's title, else a plain label); learner and parent sections; settings keep short strings, numbers and booleans; app name from `profile/app.json` (`displayName`, then `name`), null if absent; `planStatus` and `nextSession` null for now. Uploads appear in `learner.recent` as `type: 'upload'`, title Photo/File/"Pasted text", with `status`, plus `failureReason` (failed only; a code word) and `taskId` (when confirmed) (WP-108a) (never extracted text; never in the parent section). Written by the store's `beforeCommit` step, so the first batch after start-up refreshes it.

## Scripts
- `scripts/stamp-versions.sh <web-dir> <version>`: deploy-time `?v=` stamping (exit 2 bad args, exit 1 unstamped reference).
- `scripts/start-server.sh [--foreground|--watch]`: proven start script (blueprint §3.2); logs to `.server/`.
- `npm test`: `node --test`. `npm run icons`: regenerate the PNG icons. `npm run server`: restart the server in the background and tail the log. `npm run models [-- --json]`: list the account's Copilot models and check `models.json`. `npm run spike:image -- <image> [--deadline YYYY-MM-DD] [--role <role>] [--mode both|file|blob]`: phase 0 test 1 (image input); refuses images inside the repo except `.server/`. `npm run spike:web [-- --role <role>] [--tools a,b] [--only fetch,search,refuse,cache]`: phase 0 test 2 (web tools, refusals, cache); the SDK `BuiltInTools` export is shown for reference only. `npm run spike:tools [-- --role <role>] [--only call,refuse]`: phase 1 spike (WP-101): the model calls an invented read-only custom tool, and shell, file and web requests stay refused (uses Copilot credits). `npm run curriculum:check`: loads `curriculum/` from the storage clone (`STORAGE_DIR` or `/workspaces/storage`) as the server does; prints counts, unit-choice status and field names only; exits 1 with `Overall: CHECK` if anything is missing. `npm run spike:docs [-- --only docx,pdf,scan,broken,long] [--file <.pdf|.docx>]`: WP-102 document extraction spike (invented files built in memory; `--file` prints counts only, never text; no credits). `npm run storage:check [-- --no-wait]`: phase 0 verify step 7 (clone, write and push, then push again after an `inbox/` commit made on GitHub).
- `npm run alert:check [-- --only 3|2] [--gap <seconds>]`: verify step 11 (sends real test alerts; Codespace terminal only).
- `npm run evals [-- --yes | --mock] [--category a,b] [--id a,b] [--limit n] [--model id] [--judge-model id] [--seed n] [--timeout s]`: the boundary test set (blueprint §11). No options = dry run (validates cases, prints the plan, sends nothing). `--yes` uses Copilot credits. Reports go to `evals/results/report-<UK time>.md` and `.json` (git-ignored; they hold model output).
- `node scripts/inbox-check.js [worker address]`: verify steps 9 (server half) and 10 (8 MB through the Worker); sends two invented files and tidies up.
- `node scripts/item-check.js [worker address]`: live parent-role check (writes two invented notes, checks learner/parent access through the Worker, deletes them).
- `node scripts/worker-check.js [worker address]` (asks for the address if not given): set-up check after WP-011 — Worker settings, matching pass secrets, `/status`, backend address and `/wake` on an awake Codespace.

## Routes
- `GET /api/health` (no pass). Times are UK time (`+00:00`/`+01:00`), including `port.updatedAt`.
- `GET /api/item?type=&id=&task=` (pass): learner opens all types; parent opens only notes, plans and drafts with `sharedWithParent` set; unshared and missing both return 404.
- **Work routes (WP-105; pass required; learner only, parent gets 403):** `GET /api/tasks` (`?open=1` for open tasks only), `POST /api/tasks`, `GET /api/tasks/:id`, `PATCH /api/tasks/:id`, `POST /api/tasks/:id/anchors`, `PATCH /api/tasks/:id/anchors/:anchorId`, `DELETE /api/tasks/:id/anchors/:anchorId`, `POST /api/attempts`. Order: match → pass (401/503) → rate limit → body (256 KB, 413) → role (403) → storage ready (503) → handler. Unknown `/api/...` paths return 404 without a pass; a known path with the wrong method returns 405 with `Allow`. Validation errors (400) name fields only.
- **Upload routes (WP-108a; pass required; learner only):** `POST /api/uploads/paste` (`{ clientId, text }` → 201, or 200 `duplicate: true` on retry; 409 if the clientId belongs to another capture); `GET /api/uploads/:id` (the view: `status`, `failureReason`, `origin`, `contentKind`, `taskId`, `text` once done, `truncated`, `uncertain`, `spellingCorrections`, `proposal`, `ask`); `POST /api/uploads/:id/confirm` (body: any of `title, subject, qualificationId, topicIds, kind, workType, deadline, marks, wordCount, questionText, anchors, undoneCorrections` (positions); anything left out keeps the draft's value → 201 `{ task, upload }`; 409 `{ error, taskId }` if already a task; 409 if not read yet or not a brief).
- **Rate limit:** `RATE_LIMIT_PER_MIN` requests per pass per minute (default 120) on the work routes and `/api/item`; over the limit → 429 with `Retry-After`.
- `/api/health` `ai` = `{ ready, roles, errors, mode }`; `mode` is `starting` | `off` | `mock` | `copilot`; each `roles` entry is `{ model, ok, ms | error }`. The AI start-up test runs after the server starts listening.
- `/api/health` `port` = `{ visibility, detail, attempts, updatedAt }`; `visibility` is `unknown` | `n/a` | `pending` | `public` | `private`. The port manager starts after listening.
- `/api/health` `storage` = `{ ok, ready, lastPull, lastPush, pending, detail }`. Storage starts after listening.

## Work records (WP-105)
- Paths: `tasks/<taskId>/task.json` (anchors inside the task), `attempts/<UK month>/<id>.json`, `ai-turns/<UK month>/<id>.json` (month from the time inside the id).
- Task stages: `not-started`, `researching`, `planning`, `drafting`, `reviewing`, `submitted`, `done`. `completedAt` is set the first time the stage becomes `submitted` or `done` and never cleared (retention clock, WP-123). A typed task starts `confirmed: true`. Learner anchors start confirmed; source anchors don't.
- Events (ids, field names, types and stages only, never text): `task.created`, `task.updated`, `task.stage`, `anchor.added`, `anchor.updated`, `anchor.removed`, `attempt.recorded`, `support.requested`, `support.outcome`.
- AI turns at wellbeing level 2–3 keep no text (`textRemoved: true`).

### Uploads after reading (WP-106, WP-107)
- `status: 'done'` adds `extractedText { value, author }` (`source` for briefs, `learner` for own writing), `truncated`, `uncertain [{ text, start, end }]`, `spellingCorrections [{ original, corrected, position, undone }]` (briefs only), `readBy { role, model }`, `reread`, `readAt`, `readTries`.
- Briefs also get `proposal { title, subject, qualificationId, kind, workType, question { verbatim, corrected }, deadline, marks, wordCount, anchors (newAnchor() shape, author source, unconfirmed), topicIds, uncertainFields }`. WP-108 turns it into a Task once the learner confirms it.
- Failures: `failureReason` is one of `too-large`, `unsupported-type`, `no-vision`, `file-missing`, `unreadable`.
- Events: `upload.read` (ids and counts only) and `upload.failed` with `stage: 'reading'`. AI turn records with features `read-upload` and `match-topics` (no text).
- The reader runs only when the AI mode is `copilot`; with `AI_MOCK=1` uploads are never read. The snapshot still shows uploads as Photo/File with `status` only; `uploads/` keeps the local side on a sync clash (`prefer-local`).
- Documents (WP-107) are read by the server: `readBy { role: 'text', model: null }`; a brief also gets `proposalBy { role, model }`, or null if no model gave a usable draft task. Scanned PDFs: `readBy` as for photos.
- `uncertain` entries may be page flags `{ text: null, start: null, end: null, page, reason: 'little-text' }`.
- The `upload.read` payload has `method: image | scan | text`.
- New failure reasons: `password` and `scanned-pdf`, for A-003: *"This PDF can't be read as it is. Please take photos of the pages instead."*
- The draft task's `qualificationId` and `subject` are filled in from the topics when they all belong to one qualification. The subject is the qualification's title, if it is 40 characters or fewer.
- Pasted briefs (WP-108a): `origin: 'paste'`, `mimeType: 'text/plain'`, `file: null`, `contentKind: 'brief'`; text saved at paste time (`extractedText`, author `source`); read by the reader with `method: 'text'` (no extraction, no attachment).
- Confirmation (WP-108a) sets `taskId`, `confirmedAt` and `spellingCorrections[].undone` on the upload; the Task gets `sourceUploads: [uploadId]`, `createdBy: 'ai'`, every anchor confirmed. Events: `upload.confirmed` (ids, counts and changed field names) and `upload.received` with `source: 'paste'` (`chars` count).

## Sync clashes (WP-014a-fix)
When `git pull --rebase` clashes, `syncLocked()` settles server-made files itself: event logs (`events/*.jsonl`) are merged by line (both sides kept once); `index/snapshot.json` takes the remote side and is rebuilt in the next batch; `inbox/` prefers the remote (Worker) copy; `uploads/` prefers the local (server) copy. Anything else aborts the rebase, keeps local commits, sets `storage.detail` to `needs attention: sync clash in <paths> …` (paths only) and stops pulling until restart; saving continues locally. Manual fix: inspect and resolve in `/workspaces/storage`, then `npm run server`.

## Evals
Case files are JSON arrays in `evals/cases/`, generic and invented only. Each case has `id`, `category`, `role`, `turns` (1–6), optional `task` `{ question, anchors }`, optional `presentation` (the four §30 choices), optional `instruction` (background jobs only) and `expect` `{ behaviour, notes, wellbeingLevel?, wellbeingMax?, mustMention?, json?, jsonContains?, mustSuggest? }`. Background jobs (`behaviour: "json"`) are checked in code only; everything else is also judged by the `judge` role. The tutor runs on `skills/core/SKILL.md` (generic tone examples, default labels) and the presentation wordings from `server/ai/prompt.js` (WP-104); `evals/system-placeholder.md` is only a fallback. Cases don't yet name a route, so route skill files aren't exercised by the evals (WP-125). `--mock` checks the runner only: its canned reply can't satisfy the `background` cases' JSON expectations, so a full mock run gives 25/34 (9 `background` cases fail with `json-mismatch`; same before WP-104). Private spelling samples (`<STORAGE_DIR>/evals-private/`) are counted only, never read, until phase 1.

## Pages
- Learner `/`: sign-in, signed-in screen, waking (polls `/api/health` every 5 s for up to 5 min; `/status` every third poll; rings again if still `Shutdown`; port hint after 90 s `Available`). Pass in `localStorage` on own devices, `sessionStorage` only on a shared computer.
  - Capture section (camera, gallery, file). Images are resized on the device to JPEG ≤ 1,600 px and ≤ ~700 KB; PDF and Word go unchanged up to 8 MB. Captures go to the Worker `POST /inbox` as `kind=brief`, one at a time, with a device client ID (`p…` photo, `f…` file); Try again reuses the ID. The "Your photos and files" list merges this device's captures, `GET /inbox` (waiting) and the snapshot's upload entries, checked every 15 s while anything is pending, for up to 15 minutes after the last activity. Nothing is kept in browser storage.
  - Accessibility settings from the snapshot's `settings.accessibility`, applied as CSS custom properties (`--text-scale`, `--line-height`, `--paragraph-gap`, `--font`, `--letter-spacing`, `--word-spacing`) and `data-theme` / `data-contrast` / `data-motion` on `<html>`; read at sign-in and again when the tutor is ready; kept in `localStorage` on own devices only; reset and forgotten at sign-out. Vocabulary (first value is the default; anything else is ignored):

    | Key | Values |
    |---|---|
    | `textSize` | `standard`, `large`, `larger`, `x-large`, `largest` (100–200%) |
    | `font` | `standard`, `dyslexia-friendly` |
    | `lineSpacing` | `standard`, `wide`, `wider` |
    | `paragraphSpacing` | `standard`, `wide`, `wider` |
    | `theme` | `system`, `light`, `dark`, `cream` |
    | `contrast` | `standard`, `high` |
    | `reducedMotion` | `false`, `true` |

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
- `GET /repo-file?path=` and `POST /repo-file` (JSON `{ path }`) (WP-014c): no pass, no origin check, no CORS headers; reads `Simonh1982/edu-support-app` `main` via raw.githubusercontent.com with no token and no settings. Path rules: relative, only A–Z a–z 0–9 . _ - /, no `..`, no empty or `.` parts, ≤ 200 characters. Returns `text/plain` plus a final line `--- end of <path> (<n> lines) ---`; 400 bad path or body, 404 missing, 405 other methods, 413 file over 1 MB or body over 1 KB, 502 GitHub error. raw.githubusercontent.com may serve a version up to ~5 minutes old.
- Pass failures: 401 `{ error, reason }`. GitHub failures: 502 `{ error, githubStatus, acceptedPermissions? }`. Other origins: 403. Body over 1 KB: 413.

## Settings and secrets expected
- Server (optional, non-secret): `PORT`, `HOST`, `IDLE_TIMEOUT_MIN`, `DEV_ORIGINS`. Also read if present (set by Codespaces): `CODESPACE_NAME`, `GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN`.
- AI (optional, non-secret): `AI_MOCK=1` (use the mock AI), `COPILOT_WORK_DIR` (SDK work folder; default is under the OS temp folder).
- Limits (optional, non-secret): `RATE_LIMIT_PER_MIN` (default 120), `AI_DAILY_CEILING` (default 300 AI requests per UK day). Logged at start-up as `[limits] …`.
- `COPILOT_GITHUB_TOKEN`: read by `server/ai/index.js` only (passed to the Copilot adapter); never logged.
- `GH_PORTS_TOKEN`: read by `server/port.js` only (passed to `gh` as `GH_TOKEN`); never logged.
- `STORAGE_REPO`, `STORAGE_TOKEN`: read by `server/storage/index.js` and `server/alerts.js` (for alerts the token is sent only to `api.github.com` and never logged). The token is passed to git as an auth header in the environment and is never logged. Optional, non-secret: `STORAGE_DIR` (default `/workspaces/storage`; must be outside the app repository).
- `PASS_SIGNING_KEY` (32 characters or more), `PASS_VERSION` (whole number ≥ 1) and `ALLOWED_ACCOUNTS` (JSON login → `learner`/`parent`): read by `server/auth.js` (`createAuth`) only; never logged. The server calls `passSettings` at start-up and logs `[auth] off: …` (names only) if they're missing.
- Front end: `web/config.js` `workerUrl` is set to the Worker address.
- **Worker (Cloudflare) settings:** text `CODESPACE_NAME`, `ALLOWED_ORIGIN`, `APP_URL`, `OAUTH_CLIENT_ID`, `PASS_VERSION`; secret `GITHUB_TOKEN` (Codespaces lifecycle), `OAUTH_CLIENT_SECRET`, `PASS_SIGNING_KEY`, `ALLOWED_ACCOUNTS`. Also `STORAGE_TOKEN` (secret; a separate token from the Codespace's) and `STORAGE_REPO` (text), used by `/snapshot` and `/item`.

## Verify steps passed
- Steps 1–7 passed (step 6 on 21 Oct 2026 after WP-008; step 7 on 21 Oct 2026 after WP-009: `storage:check` PASS, pulled the inbox commit before pushing).
- Step 8 passed 26 Oct 2026: sign-in on phone, laptop and shared computer after WP-012; parent-role `item-check` PASS after WP-013.
- Step 10 passed 26 Oct 2026 (8 MB through the Worker, 4.2–5.4 s).
- Step 9 passed in full 29 Oct 2026 after WP-014b: a photo taken while the Codespace was stopped showed 'Received – waiting to be read' on the phone and laptop, then 'it'll be read once reading is switched on' about 20 s after Tutor ready. Image resize: 12 MP photo → 1600 × 1200, 266 KB.
- Step 11 passed 29 Oct 2026 after WP-015: three dispatches answered 204; level-3 email within a minute; the second level-2 alert was added as a comment, with no third issue.
- Step 12 replaced by amendment A-004 (weekly wake dropped): manual check passed 29 Oct 2026 — Auto-delete codespace switched off, bookmark icon showing, Codespace owned by the owner's personal account.
- Step 13 passed by 31 Oct 2026: curriculum outlines with fixed topic IDs for all four qualifications are committed to the storage repository (private WP-019a, 019b, 019c, 019d). The owner spot-checked each one before it was committed.
- Step 14 passed by 31 Oct 2026: with the Codespace stopped, in a private window, the snapshot appeared at once and the tutor was ready 18 s after waking (target: about 2 minutes). Bookmark icon rechecked: still showing.
- Step 15 (school network) taken out of the phase 0 exit check by amendment A-006 (31 Oct 2026). Done when convenient (WP-020-school); if the school blocks any of the addresses, the learner uses the phone app at school. Not yet done.
- Step 16 passed 31 Oct 2026: the credential register in the storage repository has every token's created and expiry dates (names and dates only), plus the account checks and a Cloudflare logging note (private WP-019a-reg, WP-020b). One account check is still outstanding; it's recorded privately and doesn't block phase 0. Cloudflare Worker logs: invocation logs on; no `Authorization` header appears in `/snapshot` or `/status` entries (checked by the owner).
- Step 17 passed 31 Oct 2026: erasure dry run with an invented file in the storage repository. The owner rewrote the history and force-pushed `main`. The file is gone from all history (404 on GitHub; Claude Code confirmed it's absent from every commit). The Codespace cloned storage again cleanly (`storage` ok, ready, nothing pending) and the app reached Tutor ready. The private erasure runbook was updated to match (WP-020b): the owner runs it; stop the server but keep the Codespace running; delete `/workspaces/storage` straight after the force-push, before the server starts again.
- **Phase 0 exit check complete (31 Oct 2026):** sign-in works on the phone, laptop and a shared computer; a photo taken while the backend was asleep appeared once it was awake; a test level-3 alert reached the owner. The school network check is no longer part of the exit check (A-006).
- WP-101 custom tools: `npm run spike:tools` run by the owner in the Codespace on 31 Oct 2026: `call`, `refuse (allowed list)` and `refuse (permission check only)` all PASS.
- WP-102 document extraction: `npm run spike:docs` run by the owner in the Codespace on 31 Oct 2026 (Node 22.16.0, mammoth 1.13.0, pdfjs-dist 6.4.299): docx, pdf, scan, broken and long all PASS; Overall PASS.
- WP-103 curriculum: `npm run curriculum:check` run by the owner in the Codespace on 31 Oct 2026: 4 qualifications, 312 topics, Problems 0, Overall PASS; server log `[curriculum] loaded: 4 qualifications, 312 topics`.
- Docs uploaded by the owner on 31 Oct 2026: `docs/blueprint.md` "Version: 1.4 (31 October 2026: phase 0 complete; …)"; `docs/build-spec.md` "Version: generated from master specification v3.6 (31 October 2026)".
- Build spec updated by the owner (before WP-104): `docs/build-spec.md` now reads "**Version:** generated from master specification v3.7 (31 October 2026)."
- WP-106 live check (1 Nov 2026, Codespace, invented handwritten brief, photographed twice): question, deadline and 'Strech → Stretch' read correctly both times; 'Imaginary Bay' left uncorrected; the crossing-out was left out of the question; topics matched. The location anchor was missing and the qualification was left blank; both were fixed in WP-107.

## Deviations in effect
- `package.json` (owner-approved hotfix, 31 Oct 2026, not from a work package): `"overrides": { "zod": "4.6.7" }` added after `dependencies`; lockfile regenerated. Reason: `npm audit` flagged 2 high (GHSA-mrhx-c7xc-m3w5, memory exhaustion) in `zod` 4.3.6, which `@github/copilot-sdk` 1.0.22 pins exactly (1.0.28 pins the same). Nothing in the app or the SDK imports `zod` at run time (SDK uses it in type definitions only). After the override: `npm audit` 0 vulnerabilities; `npm ci`, `npm test` (361/361) and `npm run spike:docs` pass; the SDK still loads (`defineTool` present). Future packages that edit `package.json` must keep the `overrides` block; remove it only once the SDK pins `zod` >=4.6.6.
- `server/storage/store.js` (WP-009): git error text in `[storage]` logs and `storage.detail` has the storage repository's `owner/name` replaced with `<storage-repo>`, because git errors quote the remote URL and `/api/health` is public.
- `test/storage.test.js` (WP-014a-fix): the fake git answers `ls-files` (no unmerged paths), and the "failed pull aborts the rebase" test expects `ls-files` then `rebase` after the failed pull, because `syncLocked` now checks for clashes first.
- `wake/worker.js` `/repo-file` (WP-014c): no pass, by owner decision, because it serves only the public repository.
- `test/evals.test.js` (WP-018): the invented token in "an AI error becomes verdict 'error' with a redacted reason" is lengthened from 16 to 36 characters after `ghp_`, because the real `redact()` in `server/ai/copilot.js` matches 20 or more (real tokens have 36). The server is unchanged.

## Known issues
- If `npm install` hasn't been run after a rebuild, documents wait and the log says `[reader] paused: extractor-missing` (photos are still read).
- The upload route now exists (WP-108a). The capture screen still shows the old messages until WP-108b (it must show the right message for each `failureReason`, including `password` and `scanned-pdf`, the A-003 wording).
- The AI ceiling is counted per AI call: one photo uses 1–3 calls.
- The rate limit and AI ceiling are in memory and reset on restart. The reader (WP-106) uses `aiCeiling.take()` and `saveAiTurn`; nothing calls `logSupport` until WP-111.
- The loader reads a top-level `optionalGroups`; the private qualification records keep either/or groups at `structure.optionalGroups`. No effect today (every unit has `type`); a fallback is planned for WP-120.
- `wake/worker.js` `/repo-file`: the final catch logs `err?.message ?? String(err)`, whereas every other catch in the Worker logs only `err?.name`. Low risk: the route reads only the public repository, uses no token or setting, and doesn't log the path. Change it to `err?.name` in the next package that changes the Worker anyway, so that no extra Cloudflare paste is needed (owner decision, 31 Oct 2026).
- `wake/worker.js`: the opening comment still says a later package adds the weekly wake (WP-016). A-004 removed that. Correct it in the same Worker change.
- Dependencies: `@github/copilot-sdk` 1.0.22, `mammoth` 1.13.0, `pdfjs-dist` 6.4.299 (all pinned). `pdfjs-dist` needs Node >=22.13.0 (Codespace image `javascript-node:1-22`) and pulls in the optional native package `@napi-rs/canvas` 1.1.0 (not used for text). `isEvalSupported` no longer exists in pdf.js 6.4.299 (ignored; the library has no runtime code compilation). `zod` is overridden to 4.6.7 (see Deviations); `npm audit` reports 0 vulnerabilities.
- Eval set is an outline (34 cases; target 40–60, WP-125). Evals now use the real core skill file.
- Nothing calls `sendAlert` yet (phase 1 `server/wellbeing.js`). No weekly wake (A-004); the `wake-failed` alert kind is kept but unused.
- Accessibility settings have no settings screen yet; `profile/accessibility.json` in the storage repository is written in a later phase. The dyslexia-friendly font uses locally installed fonts only (no download), so on Android it falls back to the system sans-serif with wider letter and word spacing.
- The queued `postAttachCommand` (`--watch`) runs once per Codespace start, when the first foreground server exits (seen 26 Oct: new server 1.4 s after `pkill`). Harmless when only one server is running. `start-server.sh` and `devcontainer.json` are proven and unchanged.
- `node -e "import('@github/copilot-sdk')…"` fails (SDK 1.0.22 calls `createRequire` on the importing filename, which is `[eval]` under `-e`). Importing from a module file, as the server does, works.
