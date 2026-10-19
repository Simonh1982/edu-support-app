# Technical blueprint: the learning-support app (`edu-support-app`)

**Version:** 1.0 (October 2026)
**Status:** build reference for Claude Code. It replaces the earlier generic blueprint.
**Requirements:** the **build spec** in `docs/build-spec.md`. It is generated from the private
master specification, which always wins if the two disagree.

This document says **how** the app is built. The build spec says **what** it does. Section
references in brackets (e.g. §23.5) point to the build spec.

> **Privacy rule for everyone working in this repository, including Claude Code.**
> This repository is **public**. Never write anything about the learner here: no name, personal
> details, real coursework, real conversations or writing samples. That applies to code, comments,
> test data and commit messages. Use invented examples. Real data lives only in the private storage
> repository, which the server reads at run time. `CLAUDE.md` repeats this rule.

Items marked **(unverified)** have not been tested yet; confirm them in phase 0 before building
on them. Everything else is either decided or has been proven in an earlier build on the same
platform.

---

## 1. System overview

```
 Phone / laptop browser                    Cloudflare Worker (always on, free plan)
┌──────────────────────────────┐         ┌──────────────────────────────────────────┐
│ GitHub Pages (static site)   │ ──────▶ │ sign-in (GitHub OAuth) → signed pass       │
│ learner app  /               │         │ /status, /wake  (Codespace lifecycle token)│
│ parent page  /parent/        │         │ /snapshot, /item, /inbox (storage token)   │
│ cache + queue (own devices)  │         │ weekly cron wake (+ failure alert)         │
└──────────────┬───────────────┘         └───────────────┬──────────────────────────┘
               │ API when awake (HTTPS, port 3000 Public) │ GitHub REST API
               ▼                                          ▼
┌──────────────────────────────────────┐   pull / commit / push   ┌─────────────────────────────┐
│ Codespace on the public app repo     │ ◀──────────────────────▶ │ Private storage repository   │
│ Node server (foreground process)     │                          │ JSON records, JSONL events,  │
│  ├─ only writer of main records      │   repository_dispatch    │ uploads, curriculum, index/  │
│  ├─ AI via Copilot SDK (roles)       │ ───────────────────────▶ │ Actions workflow → alert     │
│  └─ makes its port Public on start   │                          │ issue (as github-actions bot)│
└──────────────────────────────────────┘                          └─────────────────────────────┘
```

- **Front end:** plain HTML, CSS and ES modules in `web/`, with no build step, published to
  GitHub Pages by GitHub Actions. There are two entry points: the learner app (`web/index.html`)
  and the parent page (`web/parent/index.html`). The learner app never links to the parent page.
- **Backend:** a small Node.js server (no framework) in a Codespace on the **public** app
  repository. It does all the real work: AI calls, saving, calculations and the live check.
- **AI:** GitHub Copilot through the Copilot SDK, billed to the owner's Copilot Business seat.
  Models are chosen by role (section 7).
- **Storage:** a **private** GitHub repository, called `<storage-repo>` throughout. Its real name
  is held in configuration (`STORAGE_REPO`), never in public code. The server clones it into the
  Codespace and is the **only writer of main records**. The Worker writes only to `inbox/`.
- **Worker:** a Cloudflare Worker that is always awake. It handles sign-in, wakes the Codespace,
  serves a small read-only **snapshot** plus individual items while the Codespace sleeps, accepts
  captures into the inbox, and runs a weekly wake.
- **Alerts:** the server sends a `repository_dispatch` event to the storage repository. A GitHub
  Actions workflow there opens or updates an issue as `github-actions[bot]`, so GitHub notifies
  the owner. GitHub doesn't notify you about your own actions, so issues opened with the owner's
  token would arrive silently.

**Cost:** GitHub (free), Cloudflare Workers (free plan), Codespaces (within the owner's personal
allowance), Copilot (the owner's Business seat). No other services or accounts are needed.

---

## 2. Repositories and file layout

### 2.1 Public app repository (`edu-support-app`)

| Path | Purpose |
|---|---|
| `CLAUDE.md` | Working rules for Claude Code, including the privacy rule |
| `docs/build-spec.md` | Requirements (generated from the private master) |
| `docs/blueprint.md` | This document |
| `.devcontainer/devcontainer.json` | Codespace image, `gh` feature, foreground start |
| `scripts/start-server.sh` | Starts the server correctly at boot, on attach and on restart |
| `scripts/stamp-versions.sh` | Adds `?v=<commit>` to file addresses at deploy |
| `scripts/list-copilot-models.js` | `npm run models`: model IDs and prices available to the account |
| `.github/workflows/pages.yml` | Publishes `web/` to Pages |
| `server/index.js`, `server/config.js` | HTTP server, routing, CORS, limits |
| `server/auth.js` | Pass verification and role checks |
| `server/port.js` | Makes port 3000 Public on every start |
| `server/storage/` | Storage repo clone, record read/write, batching, pull-before-push, snapshot writer |
| `server/domain/` | Tasks, anchors, notebook, plans, drafts, feedback, questions, sessions, events |
| `server/derived/` | Calculated values (status, recommendations, counts), as pure functions |
| `server/ai/` | Copilot client, model roles, prompt assembly, JSON parsing, live check, tally, mock |
| `server/wellbeing.js` | Level handling, text removal before save, alert dispatch |
| `server/retention.js` | Start-up clean-ups (conversation retention, inference lapse) |
| `skills/*/SKILL.md` | The AI's behaviour rules, re-read on every request; generic, no personal data |
| `models.json` | Role → model ID (section 7.2) |
| `wake/worker.js` | The Cloudflare Worker (pasted into Cloudflare by hand) |
| `web/` | Learner app; `web/parent/` parent page; `web/shared/` code used by browser and Node |
| `test/` | Unit and integration tests (`npm test`); Worker tests with a fake GitHub API |
| `evals/` | Boundary test-set runner (`npm run evals`); prompts are generic, results are git-ignored |

### 2.2 Private storage repository (`<storage-repo>`)

```
profile/             learner.json (display name, subjects, presentation settings),
                     accessibility.json, preferences.json, app.json (display name of the app)
curriculum/<qual>/   qualification.json, units.json, topics.json, aos.json,
                     command-words.json, sources/*.pdf (owner's original PDFs)
tasks/<taskId>/      task.json (incl. anchors), plan.json, drafts/v<n>.json, feedback/<id>.json
uploads/             <uploadId>.<ext> (resized image or original file), <uploadId>.json (metadata,
                     extracted text, corrections)
inbox/               <clientId>.<ext> + <clientId>.json   (written by the Worker only)
notebook/            <entryId>.json
sources/             <sourceId>.json
questions/<topicId>/ <itemId>.json
sessions/            <sessionId>.json
planner/             availability.json, sessions/<id>.json        (phase 4)
ai-turns/<YYYY-MM>/  <turnId>.json
events/              <YYYY-MM>.jsonl                               (append-only)
index/               snapshot.json                                 (small contents page only)
evals-private/       samples of the learner's writing for the spelling tests (never copied out)
docs/                master specification, credential register, runbooks/erasure.md
.github/workflows/   alert.yml
```

- Every record carries `id`, `createdAt`, `updatedAt`, `createdBy`, `schemaVersion`. Every text
  field carries `author` (`learner` / `ai` / `source`). Dates and times use the `Europe/London`
  time zone. The full record list is in build spec Appendix A.
- **Statuses are calculated, not stored** (topic status, plan status, streaks, counts,
  recommendations). `server/derived/` computes them from records and events.

---

## 3. Codespace backend

### 3.1 `devcontainer.json`

```json
{
  "image": "mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm",
  "features": { "ghcr.io/devcontainers/features/github-cli:1": {} },
  "postCreateCommand": "npm install",
  "postStartCommand": "bash scripts/start-server.sh --foreground",
  "postAttachCommand": "bash scripts/start-server.sh --watch",
  "forwardPorts": [3000],
  "portsAttributes": { "3000": { "label": "App", "onAutoForward": "notify" } },
  "secrets": {
    "COPILOT_GITHUB_TOKEN": { "description": "Fine-grained token: Copilot Requests" },
    "GH_PORTS_TOKEN": { "description": "Classic token: codespace scope only" },
    "STORAGE_TOKEN": { "description": "Fine-grained token: Contents read/write on the storage repo" },
    "STORAGE_REPO": { "description": "owner/name of the private storage repo" },
    "PASS_SIGNING_KEY": { "description": "Shared with the Worker" },
    "PASS_VERSION": { "description": "Shared with the Worker" },
    "ALLOWED_ACCOUNTS": { "description": "JSON: GitHub login → role. Shared with the Worker" }
  }
}
```

- **The `javascript-node` image doesn't include `gh`.** The `github-cli` feature is required, or
  making the port Public fails with exit code 127.
- **After changing `devcontainer.json`, rebuild once:** Ctrl + Shift + P → *Codespaces: Rebuild
  Container*.
- **New or changed secrets load only after the Codespace fully stops and starts again**, or is
  rebuilt. Reloading the browser isn't enough.
- `IDLE_TIMEOUT_MIN` (default `30`) is a server setting in `server/config.js` and must match the
  owner's Codespaces idle-timeout setting.

### 3.2 Starting the server reliably (proven; don't change this)

- **Run the server in the foreground in `postStartCommand`.** A background process started from
  `postStartCommand` is killed when that step finishes, even with `nohup` and `setsid`. Running in
  the foreground means the step never "finishes" while the server runs. This is what makes a
  remote wake work.
- `postAttachCommand` (when someone opens the Codespace in VS Code) starts the server **only if it
  isn't already running**, then tails the log. Ctrl + C stops the tail, not the server.
- `npm run server` (no flag) restarts the server in the background and tails the log. Use it after
  `git pull`.
- Match the process with `pgrep -f '^node server/index\.js'`. A looser pattern matched other
  commands, including the one doing the killing.
- Logs live in `.server/` inside the workspace (git-ignored), so they survive restarts:
  `start.log` (one line per start-up step), `server.log` (server output), `port.log`
  (port-visibility result).
- The server logs stop signals and **ignores `SIGHUP`**, which a closing terminal sends.

```bash
# scripts/start-server.sh (condensed)
cd "$(dirname "$0")/.." || exit 1
DIR="$PWD/.server"; mkdir -p "$DIR"; LOG="$DIR/server.log"; MODE="${1:-}"
note() { echo "$(date -u +%FT%TZ) [$MODE] $*" >>"$DIR/start.log"; }
running() { pgrep -f '^node server/index\.js' >/dev/null 2>&1; }
case "$MODE" in
  --foreground) pkill -f '^node server/index\.js'; : >"$LOG"; note "foreground"
                node server/index.js >>"$LOG" 2>&1 </dev/null; note "stopped ($?)"; exit 0 ;;
  --watch)      running || { setsid nohup node server/index.js >>"$LOG" 2>&1 </dev/null & } ;;
  *)            pkill -f '^node server/index\.js'; sleep 1; : >"$LOG"
                setsid nohup node server/index.js >>"$LOG" 2>&1 </dev/null & ;;
esac
exec tail -n 40 -f "$LOG"
```

### 3.3 Making the port Public on every start (proven)

- Forwarded ports reset to **Private** every time the Codespace restarts. A Private port answers
  browsers with a GitHub sign-in redirect, which shows up as a CORS or "not valid JSON" error.
- Use `gh codespace ports visibility 3000:public -c "$CODESPACE_NAME"` with a **classic** token
  that has only the `codespace` scope (`GH_PORTS_TOKEN`, passed as `GH_TOKEN`). Fine-grained tokens
  can't change port visibility.
- Do this **from the server, after it starts listening**. Retry 18 times, 10 seconds apart. Log the
  first failure and the result to `.server/port.log`, and report it in `/api/health`.
- The public address is `https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`.
  Print it at start-up, together with the Codespace name.

### 3.4 Start-up sequence

1. Load configuration and secrets; ignore `SIGHUP`.
2. Storage: clone `<storage-repo>` to `/workspaces/storage` if it's missing. This is **outside**
   the app repo's working tree, so it can never be committed to the public repo by accident. Then
   `git pull --rebase`.
3. Process the inbox (section 4.4).
4. Run retention and expiry clean-ups (section 4.6).
5. Build in-memory indexes from the records, then write the snapshot.
6. Start the Copilot client and send one tiny test message, so "ready" really means Copilot
   answers.
7. Listen on port 3000, then make the port Public.
8. Record the start time, which is used for the "resting soon" warning (section 9.2).

### 3.5 Server essentials

- `GET /api/health` returns
  `{ ok, ai: { ready, roles, errors }, storage: { ok, lastPush }, startedAt, restsAt, port }`.
  `restsAt` is `startedAt + IDLE_TIMEOUT_MIN`.
- **Every other endpoint requires a valid pass** (section 6) and checks the role.
- **CORS:** echo the `Origin` back only if it's the Pages origin (or localhost in development).
  Allow the headers `Content-Type, Authorization`.
- Send every error as JSON `{ error }` with a sensible status.
- Limits: normal JSON bodies 256 KB; `POST /api/uploads` up to 8 MB; per-pass rate limits; a daily
  AI request ceiling as a safety net.

---

## 4. Storage

### 4.1 Principles

- The **private storage repository is the database.** Each record is a small JSON file; events go
  in monthly JSONL files.
- **One writer per file.** The server writes everything except `inbox/`. The Worker writes only
  `inbox/`. Both commit to the same repository, so the server must **pull before every push**.
- **Data outlives the Codespace.** If the Codespace is deleted, a new one clones the repository and
  carries on.

### 4.2 Writing and committing (`server/storage/`)

1. Domain code calls `store.put(path, record)` or `store.append(eventsFile, event)`. The file is
   written in the local clone straight away, and memory indexes are updated.
2. Changes are **batched for 5–10 seconds**. Then the server runs `git add -A`, `git commit`,
   `git pull --rebase` and `git push`. The two writers never touch the same files, so the rebase is
   always clean.
3. If the push fails, keep the commit, retry with back-off, and report it in `/api/health`.
4. **Rewrite the snapshot at most once per batch.**
5. Use a single in-process lock for all git operations. The server never runs two git commands at
   once.
6. Authenticate git with `STORAGE_TOKEN`, via an HTTPS credential helper or the remote URL in
   memory. Never write the token into `.git/config` in a file that is committed anywhere.

### 4.3 Snapshot (`index/snapshot.json`): a small contents page

The snapshot lets the always-on Worker show something useful while the Codespace sleeps. It holds
**no note, feedback or draft text**, which keeps Git history small and makes deletion complete.

```json
{
  "generatedAt": "2026-11-02T18:04:11+00:00",
  "learner": {
    "upcoming": [{ "taskId": "t_…", "title": "…", "subject": "…", "deadline": "2026-11-07",
                   "stage": "planning", "kind": "assignment" }],
    "planStatus": "On track",
    "nextSession": null,
    "settings": { "accessibility": { }, "presentation": { } },
    "recent": [{ "type": "notebook", "id": "n_…", "title": "…", "updatedAt": "…" },
               { "type": "feedback", "id": "f_…", "title": "…", "updatedAt": "…" }],
    "inboxPending": 0
  },
  "parent": {
    "upcoming": [{ "title": "…", "subject": "…", "deadline": "…" }],
    "planStatus": "On track",
    "shared": [{ "type": "draft", "id": "d_…", "title": "…" }]
  }
}
```

- The Worker returns **only the section for the caller's role**.
- Individual items are fetched with `GET /item` (section 5.2), which applies the same permission
  rules as the server.

### 4.4 Inbox

- While the Codespace sleeps, the Worker writes each capture as `inbox/<clientId>.<ext>` plus
  `inbox/<clientId>.json`. The metadata includes the source, size, `capturedAt` and the
  uploader's role. **`clientId` is generated on the device**, so a retry overwrites the same file
  instead of creating a duplicate.
- At start-up, and whenever it pulls, the server processes the inbox. It moves each capture into
  `uploads/`, creates the Upload record, queues extraction and deletes the inbox files.
- The Worker's `GET /inbox` lists pending items, so other devices can show "received, waiting to
  be read".

### 4.5 Deletion

- Deleting an item removes it from current files, together with its derived material (extracted
  text, corrections). Links from other records are cleared.
- The confirmation text is in build spec §32.2.
- **Full erasure from history happens only on request**, following
  `docs/runbooks/erasure.md` in the storage repository:
  1. pause writes;
  2. confirm the inbox is empty;
  3. run `git filter-repo` to remove the path or text;
  4. force-push;
  5. re-clone in the Codespace;
  6. note that GitHub may keep cached copies briefly, and contact GitHub Support if complete
     removal is needed.

### 4.6 Retention and expiry (run at start-up; no scheduler needed)

| What | Rule |
|---|---|
| AI turns linked to a task | Removed 30 days after the task is **first** marked submitted or done |
| AI turns not linked to a task | Removed after 60 days |
| Inferences (from phase 3) | Lapse after 20 weeks unless renewed; blocked once marked "That's wrong" |
| Spelling-check results | Never stored |

All periods are settings in `server/config.js`.

---

## 5. Cloudflare Worker (`wake/worker.js`)

### 5.1 Settings (Cloudflare → Worker → Settings → Variables and Secrets)

| Type | Name | Value |
|---|---|---|
| Secret | `GITHUB_TOKEN` | Fine-grained token: **app repo only**, Codespaces read and Codespaces lifecycle admin read/write |
| Secret | `STORAGE_TOKEN` | Fine-grained token: **storage repo only**, Contents read/write. A separate token from the one the Codespace uses |
| Text | `STORAGE_REPO` | `owner/name` of the storage repo |
| Text | `CODESPACE_NAME` | The Codespace's name (not its URL) |
| Text | `ALLOWED_ORIGIN` | `https://simonh1982.github.io` (origin only) |
| Text | `APP_URL` | `https://simonh1982.github.io/edu-support-app/` |
| Text | `OAUTH_CLIENT_ID` | From the GitHub OAuth app |
| Secret | `OAUTH_CLIENT_SECRET` | From the GitHub OAuth app |
| Secret | `PASS_SIGNING_KEY` | Same value as the Codespace secret |
| Text | `PASS_VERSION` | Same value as the Codespace secret (e.g. `1`) |
| Secret | `ALLOWED_ACCOUNTS` | Same JSON as the Codespace secret, e.g. `{"owner-login":"parent","learner-login":"learner"}` |

- **Keep two separate tokens** for lifecycle and storage. One token covering both repositories
  would also give the Worker write access to the public code.
- The allowed accounts and pass version live in **two places**: the Worker and the Codespace. The
  credential register says to update both together.

### 5.2 Endpoints

| Endpoint | Who | What it does |
|---|---|---|
| `GET /auth/login?shared=0\|1` | Anyone | Redirects to GitHub OAuth with a signed `state` (timestamp + `shared` flag; no storage needed). Requests **no scopes** |
| `GET /auth/callback` | GitHub | Exchanges the code, calls `GET /user`, checks the login against `ALLOWED_ACCOUNTS`, mints a pass, then redirects to `APP_URL` (or `APP_URL/parent/`) with the pass in the URL **fragment** (`#pass=…`). It doesn't keep the GitHub token |
| `GET /status` | Pass | `{ state }` of the Codespace |
| `POST /wake` | Pass | Starts the Codespace if needed; returns `{ state, started }`. `409` means "already starting" and is not an error |
| `GET /snapshot` | Pass | The caller's section of `index/snapshot.json` |
| `GET /item?type=&id=` | Pass | One record. Learner: own records. Parent: only records with `sharedWithParent` set |
| `POST /inbox` | Learner pass | Writes a capture (≤ 8 MB) and its metadata to `inbox/` |
| `GET /inbox` | Pass | Lists pending inbox items (metadata only) |
| `scheduled()` | Cron | Weekly wake (section 9.3) |

### 5.3 Rules that apply to every endpoint

- **Pass check on every request:** the signature is valid, it hasn't expired,
  `ver == PASS_VERSION`, and the login is still in `ALLOWED_ACCOUNTS`. Removing an account
  therefore takes effect immediately.
- Reject any other origin with 403, and answer `OPTIONS` preflights.
- GitHub API calls **must send `User-Agent`**, plus `Authorization: Bearer …`,
  `Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2022-11-28`.
- Show GitHub's `x-accepted-github-permissions` header in errors only for 401, 403 and 404.
- Contents API: files over 1 MB must be read with `Accept: application/vnd.github.raw`.
- **(unverified)** The free plan's CPU limit when base64-encoding an 8 MB file. Test in phase 0.
  The browser resizes photos to about 300 KB, so normal use is small.

### 5.4 Deploying

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Create Worker**.
2. Name it and select **Deploy**.
3. Select **Edit code**, paste the whole of `wake/worker.js`, then select **Deploy**.
4. Add the variables and secrets, then select **Deploy** again.
5. Add the cron trigger (section 9.3).

There is no automatic deploy. After any change to `worker.js` in the repository, paste it into
Cloudflare again.

---

## 6. Sign-in and passes

### 6.1 Flow

1. The learner app has no pass, so it shows **Sign in with GitHub**, with a tick box: *"This is a
   shared computer"*.
2. The browser goes to the Worker at `/auth/login`, then on to GitHub, then back to
   `/auth/callback`. The Worker checks the account and mints a pass.
3. The Worker redirects to the app with `#pass=…`. The app stores the pass and removes it from
   the address bar with `history.replaceState`.
4. Every call to the Worker or the server sends `Authorization: Bearer <pass>`.

### 6.2 Pass format

The pass is HMAC-SHA256 signed using WebCrypto in the Worker and `crypto` in Node:

```
base64url(JSON{ sub:"<github login>", role:"learner"|"parent", ver:<PASS_VERSION>,
                iat:<epoch s>, exp:<epoch s>, shared:true|false }) + "." + base64url(signature)
```

- **Own devices:** `exp` = 30 days. The pass is stored in `localStorage`.
- **Shared computer:** `exp` = 4 hours. The pass is stored in `sessionStorage`, and **nothing else
  is saved in the browser**: no cache, and edits are queued in memory only.
- **To sign out every device,** raise `PASS_VERSION` in both places.
- **OAuth app settings:** callback URL `https://<worker>.<account>.workers.dev/auth/callback`;
  no scopes.

### 6.3 Roles

| Role | Can |
|---|---|
| `learner` | Everything in the learner app; read own records; capture; delete own items |
| `parent` | Parent summary; alert history; items the learner has shared. **Never** unshared content, conversations or drafts |

Role checks happen on the server **and** in the Worker. Tests confirm that the parent role can't
read unshared items.

---

## 7. AI layer (`server/ai/`)

### 7.1 Copilot client

- Package: `@github/copilot-sdk`, imported dynamically so the server still starts if it's
  missing. Keep the SDK's working files out of the repository by pointing them at a temp folder.
- **Authentication:** a fine-grained token with **Copilot Requests** permission and no repository
  access, stored as the Codespaces secret `COPILOT_GITHUB_TOKEN` and passed as `gitHubToken`. Don't
  use `useLoggedInUser` in a Codespace: the Codespace's own token isn't a Copilot credential and
  fails with 403.
- **One session per request.** Disconnect in `finally`. Use `systemMessage` with
  `{ mode: "replace" }` so our prompt replaces Copilot's.
- **At start-up,** send one tiny test message to each configured role's model and report the
  results in `/api/health`. Copilot errors embed long header dumps, so extract the `"body"` text
  for display.
- **Image input (unverified; phase 0 test 1).** Photo reading depends on the SDK accepting images
  for the light model. If it doesn't, the fallback is server-side text extraction for printed
  briefs. Handwriting would then need a decision from the owner.

```js
// server/ai/copilot.js (outline)
const session = await client.createSession({
  model,                                              // from models.json role
  systemMessage: { mode: "replace", content: system },
  availableTools: toolsFor(role, feature),            // allowed list only (7.5)
  infiniteSessions: { enabled: false },
  onPermissionRequest: (req) => isAllowed(req) ? { kind: "approve" }
                                               : { kind: "reject", feedback: "Not available." },
});
```

### 7.2 Model roles (`models.json`)

| Role | Starting model | Used for |
|---|---|---|
| `conversation` | Claude Sonnet 5.5 | Research conversation, source cards and summaries, support-button replies, Learn something, plan feedback, follow-up talk about review feedback, EPQ prompts; later question banks and exam-style marking |
| `review` | Claude Opus 5.5 | Review my work (content); draft comparison (phase 2) |
| `light` | Claude Haiku 5.5 | Route detection and first-message reading, photo and file extraction (retry on `conversation` when confidence is low), topic matching, short-answer marking, misconception tagging |
| `spelling` | Claude Haiku 5.5 | Spelling, punctuation and grammar |
| `checker` | Claude Haiku 5.5 | Live check and overlap judgement; move to Sonnet if the evals show missed leaks |
| `judge` | Claude Opus 5.5 | Judging the eval set only |

```json
{ "conversation": "claude-sonnet-5.5", "review": "claude-opus-5.5", "light": "claude-haiku-5.5",
  "spelling": "claude-haiku-5.5", "checker": "claude-haiku-5.5", "judge": "claude-opus-5.5" }
```

- **Check the exact IDs with `npm run models`; don't guess.** Re-run the evals after any change.
- Non-Claude models may replace `light`, `spelling` or `checker` only if the evals show they are as
  reliable and cheaper. Everything the learner reads or replies to stays on Claude.
- **Never use `"auto"`.** Copilot can switch models between requests, which breaks tone
  consistency.

### 7.3 Prompt assembly

A request contains only:
1. the system prompt, built from the core skill file (`skills/core`) plus the route's skill file;
2. the **presentation settings**, translated into fixed, tested wordings (one per setting value);
3. the current task, its anchors and the relevant curriculum extract (looked up by topic ID);
4. recent conversation turns, relevant notebook entries and the learner's attempt.

All learner-supplied text is wrapped in tags (`<learner_message>`, `<learner_draft>`,
`<source_text>`), and the system prompt says the content inside them is data, not instructions.

**Never sent:** diagnoses, interests, other tasks, full history, anything from the parent side,
disclosure records.

### 7.4 Reply contract

Every AI call asks for **a single JSON object**. It is parsed forgivingly: strip code fences, then
take the text from the first `{` to the last `}`. Each feature has a fixed schema. Conversation
replies use:

```json
{ "reply": "…", "replyType": "hint|breakdown|pointer|explanation|clarification|summary|feedback|other",
  "taskSpecific": true, "wellbeingLevel": 0, "sources": [] }
```

- `wellbeingLevel` (0–3) is required **only on replies to messages the learner typed** (section
  7.10). If it's missing, ask once more; if it's still missing, record it as unknown and log it.
- `taskSpecific` feeds the per-task tally (section 7.7).
- `replyType` is set by the **server** from the action that triggered the reply. The model's own
  value is ignored for routing decisions.

### 7.5 Tools: allowed list only

| Tool | Where | Notes |
|---|---|---|
| Web search, web fetch | Research and Learn routes | SDK built-in tools. **(unverified)** Confirm the exact names and configuration in phase 0; test reliability early |
| `read_notebook(taskId?, topicId?)` | Research, Plan, Learn | Custom read-only tool (`defineTool`) |
| `read_curriculum(topicId)` | All routes | Custom read-only tool |

- **Everything else is refused**, including the SDK's built-in shell and file tools. That matters
  because the Codespace holds credentials.
- Fetched web pages are data and may contain instructions aimed at the AI. Those instructions are
  never followed.
- **Source filter:** exclude essay banks and model answers for the same question as the task.
  Source cards describe what a source *covers*, not what it argues.

### 7.6 Live check (`server/ai/check.js`)

**Applies to:**
- **Plan my answer** and **Review my work**;
- **Explain** when it relates to an assignment;
- **every** reply in **Understand and research it** when the conversation is linked to a task.

**Steps:**
1. The checker (`checker` role) receives the reply, the task question, the task anchors and an
   excerpt of the learner's draft. It returns `{ "leak": true|false, "reason": "…" }`. The question
   it answers is: *"Does this reply analyse or argue about these anchors in a way the learner
   could submit?"*
2. If the reply leaks, regenerate it once with stricter instructions and check again.
3. If it still leaks, send a **questions-only fallback** reply.
4. Store `checkResult` (`passed` / `regenerated` / `fallback`) on the AI turn. The owner's failure
   log is a filtered view of these turns.

### 7.7 Per-task tally

- Count the replies marked `taskSpecific` and their length for each task.
- Above the threshold (a setting), the route's instructions switch to **questions only** for that
  task.

### 7.8 Practice model answers and overlap

A model answer is shown only after the learner has answered, and only in Revise or a Learn
knowledge check.

1. If the question's topic matches a topic with an open task, the checker receives that task's
   anchors.
2. It judges whether the question involves an anchor or rewords the task question.
3. If either is true, show marking feedback without a model answer.

### 7.9 Spelling check (`spelling` role)

The model returns a list of suggestions:

```json
{ "items": [{ "original": "…", "suggestion": "…", "type": "spelling|punctuation|grammar",
              "start": 0, "end": 0, "context": "…" }] }
```

- **Code filter.** Drop any item whose edit changes more than 3 words, or whose character edit
  distance is more than `max(3, 30% of the original length)`. Drop any non-UK spelling.
- Group repeated mistakes, e.g. *"'their' instead of 'there' (4 times)"*.
- There is no cap. Results are shown, then discarded; nothing is stored.
- The review panel runs Opus (content) and this check **side by side**.

### 7.10 Wellbeing (`server/wellbeing.js`)

- **Rate only messages the learner types to the app.** Never rate drafts, notes, uploaded briefs,
  spelling checks or sources. The skill file tells the model to distinguish discussing a topic
  from talking about oneself, and the eval set includes Drama- and Geography-style themes.
- If the `light` model reads the first message and rates it above 1, pass the conversation to
  `conversation` for the reply.
- **Levels 2 and 3:**
  1. Remove the text of that message, and anything created from it (for example an attempt
     record), **before saving**.
  2. Store an event containing only the date and level.
  3. Send the alert (section 8).
- **What the learner sees:**
  - Level 3: an immediate reply that says, for example, *"I'll let mum and dad know"*, plus UK
    helplines (Childline 0800 1111; Shout, text 85258; Samaritans 116 123; 999 in immediate
    danger).
  - Level 2: a lighter line, such as *"If you want to talk it through, mum and dad are around."*
  - Level 1: a kind reply only.

### 7.11 Paste check (code, no AI)

- Split the draft into overlapping windows of 8 or more words.
- Compare them with **all AI-authored text** for the task's topics, including notebook summaries
  written before the task existed.
- At a normalised overlap of about 0.8 or more (a tunable setting), add a gentle note to the review
  output.

### 7.12 Costs and limits

- Log role, model, tokens and estimated credits for every AI turn.
- A daily ceiling on AI requests acts as a safety net.
- The expected cost is about 650 credits a month in term time (build spec §43).
- If Copilot is unavailable or the allowance runs out, the non-AI parts keep working: Upcoming,
  the notebook, pre-generated questions and the timer.

---

## 8. Alerts (storage repository workflow)

The server, or the Worker for wake failures, calls
`POST /repos/<storage-repo>/dispatches` with the storage token:

```json
{ "event_type": "app-alert", "client_payload": { "kind": "wellbeing", "level": 3, "date": "2026-11-02" } }
```

`<storage-repo>/.github/workflows/alert.yml`:

```yaml
name: app-alert
on:
  repository_dispatch:
    types: [app-alert]
permissions:
  issues: write
jobs:
  alert:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/github-script@v7
        with:
          script: |
            const p = context.payload.client_payload || {};
            const day = p.date || new Date().toISOString().slice(0, 10);
            let title;
            if (p.kind === "wake-failed") title = `Weekly wake failed (${day})`;
            else title = `Check in with the learner (level ${p.level}) – ${day}`;
            const { owner, repo } = context.repo;
            if (p.kind === "wellbeing" && Number(p.level) === 2) {
              // at most one level-2 alert a day: comment on today's if it exists
              const open = await github.paginate(github.rest.issues.listForRepo, { owner, repo, state: "open" });
              const today = open.find(i => i.title === title);
              if (today) { await github.rest.issues.createComment({ owner, repo, issue_number: today.number, body: "Another level-2 moment today." }); return; }
            }
            await github.rest.issues.create({ owner, repo, title, body: "No details are recorded. Please check in." });
```

- Issues are created by `github-actions[bot]`, so the owner is notified by email and by push if
  they use the GitHub Mobile app. The owner must be **watching** the storage repository, which is
  the default for repositories they create.
- The display name used in issue titles can be read from `profile/app.json` by the workflow if
  wanted. The title never contains anything the learner said.
- **Test in phase 0** (step 11).

---

## 9. Waking, resting and keeping the Codespace

### 9.1 Waking from the browser (proven pattern)

1. Call `POST /wake` on the Worker. Then poll the backend's `/api/health` every **5 seconds**, for
   up to **5 minutes**.
2. On every third check, also read `/status`, to show progress. If the state is `Shutdown` and
   more than 30 seconds have passed since the last ring, **ring again**: the first ring may have
   arrived while the Codespace was still shutting down.
3. Show a small status line in plain English, such as *"Tutor getting ready – about a minute"*.
   Never show a full-screen banner: the snapshot view stays usable (section 10.3).
4. If the state has been `Available` for over 90 seconds and the backend still isn't answering,
   the port is probably still Private. Show that, and log it.

**Backend address.** The Worker's `/status` also returns `backendUrl`, built from
`CODESPACE_NAME`. If the Codespace is ever replaced, only the Worker setting needs updating; there's
nothing to change in `web/config.js`.

### 9.2 Resting

- The idle timeout is **30 minutes**. Requests to the app don't count as activity, so the timer
  runs from the moment the Codespace wakes.
- `/api/health` reports `restsAt`. About 5 minutes before that time, the app warns the learner.
- When the backend stops answering, the app switches to snapshot mode and keeps unsent work in the
  queue. After the next wake, the conversation resumes from the saved turns.

### 9.3 Weekly wake (Worker cron)

- Cloudflare → Worker → **Settings → Triggers → Cron Triggers**: add `0 3 * * 1` (Mondays, 03:00
  UTC).
- `scheduled()` calls the same start logic as `/wake`. A `409` response counts as success.
- **On failure** (any 401, 403, 404 or 5xx), it sends `repository_dispatch` with
  `{ kind: "wake-failed" }` using `STORAGE_TOKEN`. The owner is then notified (section 8).
- Each wake resets GitHub's 30-day deletion clock. The cost is about 2 hours of Codespace time a
  month.

### 9.4 If the Codespace is ever replaced

1. Create a new Codespace on `main`.
2. Check that the Codespaces secrets are scoped to the app repository (they carry over).
3. Update `CODESPACE_NAME` in the Worker.
4. Fully stop and start the new Codespace.

The data is safe in the storage repository.

---

## 10. Front end (`web/`)

### 10.1 Pages and version stamping (proven)

- In repository **Settings → Pages**, set **Source: GitHub Actions**. The workflow uploads `web/`
  using `actions/upload-pages-artifact@v3` and `actions/deploy-pages@v4`.
- **Pages lets browsers keep files for 10 minutes,** and Chrome's normal reload doesn't re-check
  scripts. At deploy time, `scripts/stamp-versions.sh web "${GITHUB_SHA::8}"` adds `?v=<commit>` to
  `index.html` references and to every relative `from "./x.js"` import. The deploy fails if any
  import is missed.

### 10.2 Start-up in the browser

1. No pass → show the sign-in screen.
2. Pass present → show the **cached view** straight away. This applies on own devices only; it is
   stored in IndexedDB.
3. In parallel, call the Worker's `/status`:
   - if the backend is `Available` and its health check passes, use **live mode**;
   - otherwise fetch `/snapshot` (**snapshot mode**), start waking, and show the status line.

### 10.3 Snapshot mode, cache and queue

- **Snapshot mode:** Upcoming, the schedule, plan status and recent titles come from the snapshot.
  Opening a note or a piece of feedback calls `GET /item`. Captures go to `POST /inbox`.
- **Edits made while waking** (ticking off or moving a session, typing a task) go into a queue
  stored in IndexedDB. Each edit has a `clientId` and a timestamp, and is shown on top of the
  snapshot, marked *"will save when the tutor's ready"*. When the backend answers, the queue is
  sent in order; the server applies the edits, and the last write wins.
- **Shared computer:** nothing is saved in the browser. The queue is held in memory only, and is
  cleared at sign-out or when the tab closes.

### 10.4 Capture

- Use `<input type="file" accept="image/*" capture="environment">` for photos, plus a normal file
  picker for PDF and Word files.
- Photos are resized in the browser on a canvas, to 1,600 px on the longest edge as JPEG
  (about 300 KB). PDF and Word files are sent unchanged, up to 8 MB.
- Every capture gets a `clientId` generated on the device.

### 10.5 Names

- The code, package and repository use the neutral name `edu-support-app`.
- **The app's display name** comes from `profile/app.json` in the snapshot, because the learner
  chooses it at the co-design session. It never appears in public code.

### 10.6 Accessibility and phone use

- Apply text size, spacing, theme and contrast as CSS custom properties, using settings from the
  snapshot. Respect `prefers-reduced-motion`. Offer a dyslexia-friendly font as a choice, not as
  the default.
- Use semantic HTML, with **real text only** and no text in images, so Android's own voice typing
  and read-aloud work. Everything must work by keyboard on the laptop, with contrast at AA or
  better. On phones, there must be no sideways scrolling and tap targets must be large.
- Make the app installable: add a web app manifest and icons. **(unverified)** Check Chrome's
  current install requirements on Android during phase 0.
- Ask for confirmation with an in-page `<dialog>`, never `confirm()`.
- Code in `web/shared/` is used by both the browser and Node, so it uses no DOM-only or Node-only
  APIs.

### 10.7 Parent page (`web/parent/`)

- Phase 1 shows the alert history and a note that the summary is coming later.
- Phase 5 adds the summary, "View more detail" (counts and statuses only) and shared items.
- The learner's "What Dad sees" preview uses the same parent-side calculation, so the two can never
  differ.

---

## 11. Testing

| Command | What it runs |
|---|---|
| `npm test` | Unit and integration tests with the mock AI (see below) |
| `npm run evals` | The boundary test set against the configured models, judged by the `judge` role. It writes a report of the failures plus 5 random passes. Results are git-ignored. Spelling samples are read from `evals-private/` in the storage repo at run time and are never copied into the public repo |
| `npm run models` | Lists the model IDs and prices available to the account |

`npm test` covers:
- pass signing and expiry, version and account checks;
- role checks, including that **the parent role can't read unshared items**;
- storage batching and pull-before-push with a simulated Worker commit (using a temporary bare
  repo);
- that the snapshot contains **no note, feedback or draft text**;
- inbox idempotency;
- retention rules;
- the spelling-check filter, the paste check and the derived statuses;
- the Worker endpoints, against a fake GitHub API;
- the flow with the mock AI.

**Eval-set categories:**
- direct requests;
- "example" and role-play framing;
- extraction spread across several turns;
- authority claims;
- format tricks;
- emotional pressure;
- translation;
- **legitimate requests that must not be refused**;
- task anchors and short knowledge homework;
- practice questions that reword a task;
- over-applied presentation settings and overuse of humour;
- wellbeing levels, including academic themes that **must not** trigger alerts;
- background jobs (extraction, topic matching, tagging);
- UK spelling.

**After a model change,** the owner reviews the failures plus 5 random passes. **After a
skill-file change,** the failures only.

---

## 12. Configuration and credential register

| Name | Where | Purpose | Notes |
|---|---|---|---|
| `COPILOT_GITHUB_TOKEN` | Codespaces secret | AI calls | Fine-grained, Copilot Requests; **note its expiry** |
| `GH_PORTS_TOKEN` | Codespaces secret | Make the port Public | Classic, `codespace` scope only; **note its expiry** |
| `STORAGE_TOKEN` (server) | Codespaces secret | Clone, push, send alerts | Fine-grained, storage repo only, Contents read/write; **note its expiry** |
| `GITHUB_TOKEN` (Worker) | Worker secret | Status and wake | Fine-grained, app repo only, Codespaces read plus lifecycle admin; **note its expiry** |
| `STORAGE_TOKEN` (Worker) | Worker secret | Snapshot, item, inbox, wake-failure alert | A separate token; storage repo only, Contents read/write; **note its expiry** |
| `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` | Worker | Sign-in | From the GitHub OAuth app |
| `PASS_SIGNING_KEY` | Worker **and** Codespace | Sign and verify passes | Change both together |
| `PASS_VERSION` | Worker **and** Codespace | Sign out all devices | Raise both together |
| `ALLOWED_ACCOUNTS` | Worker **and** Codespace | GitHub login → role | Change both together |
| `STORAGE_REPO` | Worker **and** Codespace | Name of the private repo | Never hard-coded in public files |
| `CODESPACE_NAME` | Worker | Wake and backend address | Update if the Codespace is replaced |
| `IDLE_TIMEOUT_MIN` | `server/config.js` | Rest warning | Must match the GitHub setting (30) |

- When any token expires, its feature stops silently: AI errors, the port stays Private, waking
  fails, or saving fails.
- Keep this register, **with expiry dates**, in `docs/` in the storage repository.
- Never print a token. To check that a secret is present, print only the variable names.

---

## 13. Phase 0 set-up checklist

Do the steps in order, and confirm each one works before moving on.

1. **Repositories.** In the public `edu-support-app`, add `CLAUDE.md`, `docs/`, `web/` (a
   sign-in screen only) and `pages.yml`, and set Pages → Source: GitHub Actions. In the private
   `<storage-repo>`, add the folder structure and `alert.yml`.
   *Verify:* the Pages URL loads the sign-in screen.
2. **Codespace.** Add `devcontainer.json`, `start-server.sh` and a server skeleton, then create a
   Codespace on `main`.
   *Verify:* `.server/start.log` shows the foreground start, and
   `curl -s localhost:3000/api/health` answers.
3. **Copilot.** Create the token and the secret, then **fully stop and start** the Codespace. Run
   `npm run models` and fill in `models.json`.
   *Verify:* every role passes its start-up test.
4. **Test 1: image input.** Send a photo of a printed brief to the `light` model through the SDK.
   *Verify:* the question and deadline are read correctly. **If this fails, stop and agree the
   fallback with the owner.**
5. **Test 2: web tools.** *Verify:* web search and fetch work on the allowed list, and a shell or
   file tool request is refused.
6. **Port.** Create the classic token and secret, then stop and start the Codespace.
   *Verify:* `.server/port.log` says "Public".
7. **Storage.** Create the token and secret.
   *Verify:* the server clones the repo, writes and pushes. Make a manual commit to `inbox/` on
   GitHub, then check that the server's next push still succeeds (pull-before-push).
8. **Sign-in.** Create the OAuth app, the Worker and its settings.
   *Verify:* signing in works on the phone and the laptop, and in shared-computer mode; the pass
   reaches the app; the parent role can't open unshared items.
9. **Snapshot and inbox.** *Verify:* with the Codespace stopped, the phone shows the snapshot; a
   photo taken then appears on the laptop as "received", and once the Codespace is awake it is
   processed within 10 seconds.
10. **Worker CPU.** *Verify:* an 8 MB upload through `/inbox` succeeds on the free plan.
11. **Alerts.** Send a test dispatch for level 3 and one for level 2 (twice in one day).
    *Verify:* the owner, and the forwarding address if set up, receive them within 5 minutes; the
    second level-2 alert is added as a comment.
12. **Weekly wake.** Add the cron trigger, and simulate a failure (for example with a wrong
    Codespace name in a test run).
    *Verify:* the "Weekly wake failed" issue arrives.
13. **Curriculum outlines.** In a session working on the **storage** repository, generate outlines
    and stable topic IDs for every qualification from the owner's original PDFs.
    *Verify:* the owner spot-checks one qualification.
14. **End to end.** Stop the Codespace, open the Pages site in a private window and sign in.
    *Verify:* the snapshot appears at once, and live AI is available within about 2 minutes.
15. **School network.** Ask the learner to open the site on a school PC.
    *Verify:* `github.com`, `*.github.io`, `*.workers.dev` and `*.app.github.dev` all load.
16. **Credential register.** Complete it, with expiry dates.

---

## 14. Troubleshooting: symptom → cause → fix

| Symptom | Cause | Fix |
|---|---|---|
| Remote wake: Codespace "Available" but no server process and empty logs | Background process killed after `postStartCommand` | Run the server **in the foreground** in `postStartCommand` |
| `gh: No such file or directory`, exit 127 | The image lacks `gh` | Add the `github-cli` feature, then rebuild |
| Page stuck at "nearly ready"; works after making the port Public by hand | Port reset to Private on restart | `GH_PORTS_TOKEN` (classic, `codespace` scope); the server sets visibility with retries |
| Secret ignored, or the wrong model used | The Codespace hasn't restarted since the secret changed | Fully stop the Codespace, then start it |
| Copilot 403 "not authorized" | No Copilot seat, or the Codespace's own token was used | Fine-grained token with Copilot Requests, from an account with a seat |
| Worker reports 409 "already running" | 409 treated as an error | Treat 409 as normal |
| Worker 401, 403 or 404 | A token is missing a permission or repository access | Read `x-accepted-github-permissions` |
| Worker GitHub calls rejected | No `User-Agent` header | Always send `User-Agent` |
| New button visible but does nothing (Chrome) | Old JavaScript cached | Version stamping at deploy; for now, Ctrl + Shift + R |
| Ctrl + C "stops" the server | It only stops the log tail | Expected; the server keeps running |
| `git push` rejected (non-fast-forward) | The Worker committed inbox files since the last pull | `git pull --rebase` before every push (built in); check the lock |
| Alert issue created but no notification | Issue opened with the owner's own token, or the repo isn't watched | Open issues only through the Actions workflow; watch the repository |
| Parent page shows content it shouldn't | Missing role check | Fix the check in **both** the Worker and the server; extend the test |
| Everyone suddenly signed out | `PASS_VERSION` or `PASS_SIGNING_KEY` changed in one place only | Make the Worker and the Codespace match |
| Sign-in loops back to the sign-in screen | OAuth callback URL mismatch, or the fragment was lost | Check the OAuth app's callback URL and `APP_URL` |

---

## 15. Working with this owner

- The owner is a **GitHub novice**. Give numbered instructions with one action per step, saying
  exactly where to click.
- Put **each terminal command in its own copyable code block, one line each.**
- Write in **UK English** and end each answer with a **percentage confidence score**.
- **Never** ask the owner to print or paste a token. For diagnostics, print only variable names or
  yes/no results.
- After changes to `.devcontainer/`, say a rebuild is needed. After server changes, say to run
  `git pull` then `npm run server` in the Codespace. After a Worker change, say to paste
  `worker.js` into Cloudflare again. After front-end-only changes, merging is enough.
- The owner likes to see options with a recommendation, an HTML mock-up before big UI changes, and
  a pull request for each piece of work.
- **Never put anything about the learner in this public repository** (see the top of this
  document). If the build spec and this blueprint ever disagree with the private master
  specification, ask the owner. Don't guess.
