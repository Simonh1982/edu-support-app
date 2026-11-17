# Workplan: phase 1 (MVP: Work and Learn): APPROVED
**Version:** 1.9, 17 November 2026. **Status:** **approved by Simon (31 Oct)**, and this is the working document. Updated after WP-114g (public STATE **v45**) and the switch to Claude Code as the main developer.
**Starts from:** public STATE **v19** (phase 0 closed). **Now at:** STATE **v51**, last package WP-114i, **732 tests passing**. Build spec generated from master **v3.7**. Current amendments (in `docs/build-spec-amendments.md`): A-008, A-009, A-010, A-011 (long documents) and **A-012** (120,000 characters; try a summary again). **Next amendment: A-013.** Blueprint **v1.4** (unchanged).
**Scope source:** build spec §47.1 phase 1 row, plus A-005 and A-008 to A-011, plus items carried from phase 0.

## How Claude Code uses this document
**From 17 November 2026, Claude Code is the main developer.** It plans, writes, tests and opens a pull request for each package; Simon merges and does the live checks. `CLAUDE.md` sets out the procedure.

- Read this document, `docs/STATE.md` and `docs/build-spec-amendments.md` at the start of every session.
- `STATE.md` and the latest pull request win over the status column here.
- The next package is the lowest-numbered one that isn't done and whose dependencies are done, unless Simon chooses otherwise.
- One package per session. Keep to its scope, and say what comes next at the end.
- Update this file's status column in the same pull request when a package is done. Simon no longer edits it by hand.
- **Private details** (personal settings, current units, the preferred-sites list) are in the private repository's `docs/private-notes.md`, never here.

## Phase 1 exit check (build spec §47.1, §57)
- Passes §57's acceptance table, including **zero leaks on the test set** for the chosen models.
- The learner uses it for real homework. **Real use can start now** (WP-113 is live).
- **Follow-up with the learner after his first fortnight.**

## Decisions
1. **Co-design session: held (31 Oct).** Outcomes are in master v3.7 (C1–C12).
2. **EPQ:** phase 1's research and notebook cover the early stages if phase 2 isn't ready. The EPQ hasn't started yet.
3. **Alert assignment (WP-142):** **yes.** Phone notification is wanted but not critical. WP-144 is folded into WP-142.
4. **`CLAUDE.md` wording:** both library files are updated. WP-101 carried the public copy (**done**); WP-142 carries the private one.
5. **Docs in the repositories:** **done for the public repository** (blueprint v1.4, build spec v3.7). The master spec goes to private `docs/` by hand or in WP-142.
6. **`zod` override (31 Oct, owner-approved hotfix):** see "Standing rules".
7. **Co-design decisions (31 Oct):**
   - The app's display name appears in the app only (value in private settings).
   - Explanations are **always fuller** by default.
   - The parent label is plural, so wording must agree (value in private settings).
   - **A-007:** thumbs up and down on every AI reply.
8. **Upcoming groups (2 Nov; a clarification of §17, no amendment):**
   - **Today:** due today, plus overdue work.
   - **Coming soon:** the 7 days from tomorrow, plus every task with no deadline.
   - **Later:** anything after that.
   - Work leaves the list once it is Handed in or Done.
9. **WP-110/111 choices (2 Nov):**
   - **Home layout 2A.**
   - **Recommended next 1A** (fixed rules, no AI).
   - **Disengagement:** `DISENGAGE_AFTER` defaults to 3. Only "idk"-style answers count.
   - The other WP-111 choices (1A, 2A, 4B) are recorded in STATE.
10. **WP-112 (2 Nov):** a level-2 or level-3 message is **not an attempt**. Every level-2 moment is sent, and `alert.yml` keeps it to one issue a day.
11. **WP-113 (3 Nov):**
    - **Fail closed:** if the checker gives no clear answer, the reply counts as not passed.
    - Replies to a level-2 or level-3 message aren't checked.
    - **Tally defaults:** 10 task-specific replies or 8,000 characters per task (`TASK_TALLY_REPLIES`, `TASK_TALLY_CHARS`), to be tuned after real use.
    - The second draft is skipped if the first reply and its check took over 70 s.
12. **WP-114 (4 Nov):**
    - **1B: the tutor decides when to search,** on Research only. The instructions say most replies need no search, because A-level content is well established.
    - **WP-114 is split** into a (server), b (screen) and c (fix).
    - This fits §9.1's "search the live web", so no amendment is needed.
13. **Live checks (4 Nov):** every live check starts by asking Simon to set up a **realistic task**, such as a real coastline or a real set text. Never use invented places like "Imaginary Bay": the tutor can't find anything about them. The task data lives only in the private repository.
14. **Uploads (4 Nov, A-008):**
    - **1A:** "Your photos and files" hides uploads once they are confirmed as tasks.
    - **2B:** uploads are removed 30 days after their task is first submitted or done.
    - Uploads that never became a task are removed after 60 days.
    - Removals stay in the repository history unless the erasure runbook is run.
15. **Research cards (4 Nov, A-009; built in WP-114d):** four tiers, each searched separately (Start here, Watch, Your case study, Go deeper); preferred sites from private `profile/sources.json`; paywalled cards labelled with the `{parents}` wording; videos are never summarised. Answer-site pages are dropped only when they closely match an open task.
16. **Sites that refuse the tutor (6 Nov, A-010; built in WP-114e and WP-114f):**
    - He can **paste the text** of a source (at most 12,000 characters). It is summarised once and never stored.
    - **Choice 3B:** he can **attach a copy** (a PDF, a Word file or up to 5 photos) through the Worker inbox with kind `source`. Copies are read exactly, never spelling-corrected, and kept out of "Your photos and files".
    - He can add **his own sources** (title, optional author and link).
    - The task panel at the top of a task conversation also lets him **change the stage**.
17. **Long documents (17 Nov, A-011; built in WP-114g):** files up to 20 MB (once verified through the Worker and GitHub); attached copies read up to 75,000 characters; summaries grow with the document, up to roughly 700–900 words.

## Standing rules added in phase 1
1. **Any package that changes `package.json` must keep the `overrides` block.** Read the current file first; never REPLACE it from older text.
2. Don't add `zod` as a direct dependency (if ever needed: 4.6.6 or later).
3. When upgrading the Copilot SDK, check its `zod` pin. Remove the override only once the SDK pins 4.6.6 or later.
4. **Owner preferences:**
   - keep replies concise and read only the files needed;
   - large packages are fine, so split only where it makes sense;
   - the safeguarding level-3 wording stays as it is;
   - small hotfixes are recorded in STATE under "Deviations in effect".
5. **Steps and tests quote the button label shown on the route being tested.** Research and Review use the §23.1 labels (for example "Give me a search hint"). Plan uses the generic §21 labels.
6. **SDK facts proven in phase 1 (WP-114c):**
   - `web_search` raises **no** permission request.
   - The proof that a tool ran is the event `tool.execution_start`, with the name in `data.toolName`.
7. **Live checks when time is short (17 Nov):** Simon may report results without the Codespace log output. The agent records what was seen and lists anything unconfirmed, rather than holding the package open.

## Before phase 1 (not packages)
| Item | Who | Blocks | Status |
|---|---|---|---|
| Blueprint v1.4 and build spec v3.7 in public `docs/` | Simon | — | **Done** |
| Co-design session | Simon with the learner | — | **Done (31 Oct)** |
| Amendments A-008 to A-011 in `docs/build-spec-amendments.md` | Simon | — | **Done (17 Nov)** |
| This workplan in `docs/workplan-phase1.md`, new `CLAUDE.md` in both repositories, `docs/private-notes.md` in the private repository | Simon | Next session | **To do (17 Nov)** |
| Master spec to private `docs/` | Simon, or WP-142 | Nothing | To do |

## Work packages
| WP | Repo | Title | Goal | Depends on | Status |
|---|---|---|---|---|---|
| 101 | public | Spike: custom tools | Read-only custom tool called; others refused; `CLAUDE.md` refresh | — | **Done** (PR #20, v20) |
| 102 | public | Spike: document text extraction | `mammoth` and `pdfjs-dist`; scanned PDFs detected | — | **Done** (PR #21, v21) |
| 102-hotfix | public | `zod` override | Clear `npm audit` warnings | — | **Done** (PR #22, v22) |
| 103 | public | Curriculum loader and read tools | `read_curriculum`, `read_notebook`; unit logic | 101 | **Done** (PR #23, v23) |
| 104 | public | Skill files and prompt assembly | Core and route skill files; fixed wordings; evals on the real skill file | 103 | **Done** |
| 105 | public | Work records and API skeleton | Records, `/api/*`, events, rate limits, AI ceiling | 103 | **Done** |
| 106 | public | Reading uploads: photos | Backlog, blob attachments, A-001, anchors, topic matching | 105 | **Done** (live check 1 Nov) |
| 107 | public | Reading uploads: documents and scans | Word and PDF text; A-003 | 102, 106 | **Done** |
| 108a | public | Task confirmation: server | Paste route; confirm an upload as a Task | 106, 107 | **Done** |
| 108b | public | Task confirmation screen | "What are you working on?" and "Check the details" | 108a | **Done** (PR #29, v29; live check 2 Nov) |
| 109 | public | Upcoming view | Today, Coming soon and Later; stages; deadline changes with Undo | 105 | **Done** (PR #30, v30; live check 2 Nov) |
| 110 | public | Home screen, cache and queue | Three actions; Recommended next; IndexedDB view; edit queue | 109 | **Done** (live check 2 Nov) |
| 111 | public | Conversation core and support pairs | Routes; attempt before help; two pairs; escape; disengagement; thumbs (A-007) | 104, 105 | **Done** (as 111a, 111a-fix and 111b; live check 2 Nov) |
| 112 | public | Wellbeing and alerts | Levels 1–3; text removed before save; alerts; helplines | 111 | **Done** (PR #35, v35; live check 2 Nov) |
| 113 | public | Live check and per-task tally | Checker role; regenerate, then fallback; `checkResult`; tally | 111 | **Done** (v36; live check 3 Nov) |
| 114 | public | Understand and research it | Web tools; source filter; source cards; Source records; AI summary cards | 113 | **Done** (114a PR #37, v37; 114b PR #38, v38; 114c PR #39, v39; live check 4 Nov) |
| 114d | public | Source quality and summaries | Tiered cards (A-009); preferred sites; paywall label; fetch diagnosis (`source-check`) | 114 | **Done** (as 114d, 114e and 114f; see below) |
| 114d (part) | public | Tiers, preferred sites, paywalls | A-009; `fetchWatcher`; `scripts/source-check.js`; reply wait 210 s | 114 | **Done** (v40; live check 6 Nov) |
| 114e | public | Task panel, pasted text, own sources | A-010: task panel; paste the text instead; add a source he found himself | 114d | **Done** (v41; live check 6 Nov) |
| 114f | public | Attach a copy; change the stage | A-010 3B: attach a PDF, Word file or up to 5 photos to a source (Worker inbox kind `source`); "Change the stage" in the task panel; Worker tidy-ups | 114e | **Done** (PR #42, v42, 703 tests; live check 17 Nov in part, see below) |
| 114g | public | Long documents (**A-011**) | 20 MB file limit everywhere (Worker, server, `server/documents.js`, `web/shared/`), **verified live first**; attached copies read to 75,000 characters with a plain "covers the first … pages" note when longer; summaries that grow with the document. **Folded in:** the "Open the link" wording when a copy has no link. **Check first:** whether source summaries count towards the per-task tally (decision 11); if they do, ask Simon before changing it | 114f | **Done** (STATE v45). Part 1 (option 1 chosen by Simon): files over 8 MB streamed through the Worker; 20 MB limit everywhere (PR #43). Part 1b: no git folder-rename guess (PR #44); size check passed 17 Nov. Part 2: 75,000 characters with a coverage note, summaries of about 150–900 words following the document's sections, 100 pages, "Open the link" wording fixed. **Fix** (WP-114g-fix, STATE v46): the live check refused a long article's summary as too close, so summaries now get their own check wording (reporting the source is fine; applying it to his question is not). Part 2 (STATE v47): the same copy attached twice counts once, and the coverage note gives pages. Part 3 (STATE v48, **A-012**): 120,000 characters, and "Try the summary again" after a too-close answer. Source summaries don't count towards the per-task tally (saved with no text, not task-specific), so no change was needed |
| 114h | public | Carry on with a conversation | After a reload, a task's conversation carries on from the latest one for that task and route (used within **60 days**, Simon's choice); **Start a new conversation** begins afresh. Raised by Simon (17 Nov) | 111b | **Done** (STATE v50) |
| 114i | public | Attach a copy from a research card | When the tutor can't open a card's page (for example, a journal platform blocks it), **Attach a copy instead** appears beside the paste box and opens that source's attach box in the task panel. Raised by Simon (17 Nov) | 114f | **Done** (STATE v51) |
| 115 | public | Notebook | Entries with author; quotes with citation; AI text pin-only; history and search; surfacing earlier research; notebook titles in the snapshot; the task panel's **Your notes** part. **Must use the notebook record shape fixed by WP-103** (`type: 'summary'` entries already exist). **Folded in (17 Nov, Simon):** a **Summarise again** button when a new copy is attached to a source that already has a summary (today the old summary shows and Summarise is gone) | 114 | To do (after 114g) |
| 116 | public | Plan my answer | Plan record (his words only); pinned entries; gaps; main-point attempt; thesis added as an anchor (§23.6) | 115 | To do |
| 117 | public | Review my work | Opus content review beside the spelling panel; paste check; feedback titles in the snapshot | 107, 113, 115 | To do |
| 118 | public | Check my spelling | Same check on notes, plan sections and attempt boxes; results never stored | 117 | To do |
| 119 | public | Learn something | Starting points; guided sections; knowledge checks with Question items and Answers; model answer rules | 113, 103 | To do (unblocked) |
| 120 | public | Unit selection (**A-005**) | Learner-only unit route; locked and optional units; either/or groups; snapshot settings | 103, 110 | To do. **Pending edit:** loader fallback |
| 121 | public | "What the app knows about you" and settings | Presentation choices; accessibility screen; "What `{parent}` sees" preview; what's kept and for how long (include A-008 and attached copies) | 110, 104 | To do |
| 122 | public | Deletion | Delete items with derived material; links cleared; `<dialog>` with the §32.2 text. **Folded in (A-008 1A):** hide confirmed uploads in "Your photos and files" (or in an earlier tidy-up package, after Simon's navigation notes). Also removes a duplicate queued task if one appears | 115, 117 | To do |
| 123 | public | Retention clean-ups | `server/retention.js` at start-up: task-linked AI turns 30 days after first submitted or done; others 60 days. **Also:** `conversations/` records with their turns; **uploads per A-008** (30 days after the task's `completedAt`; 60 days if never a task); **attached source copies** (Uploads with `contentKind: 'source'` in a Source's `uploadIds`: the task clock through the Source's `taskId`, or 60 days without a task) | 105 | To do (unblocked) |
| 124 | public | Welcome, end of session, parent alert history | First-run welcome; end-of-session next step; parent alert history. (The Worker tidy-ups were done in WP-114f) | 112, 110 | To do (unblocked) |
| 125 | public | Test set to 40–60 cases | All §23.7 and C.3 categories; zero leaks. **Folded in:** tighten `ROUTE_SYSTEM` wellbeing levels; light-model route-choice cases at levels 0–3; route-aware cases | 104, 111–119 | To do |
| 126 | public | Phase 1 acceptance run | Automated parts of §57; owner's manual checklist | all public | To do |

### WP-114f live check (17 Nov 2026, laptop; Simon short of time)
| Step | Result |
|---|---|
| Change the stage (Planning, then back) | **Passed** |
| Own source with a PDF attached; summarise | **Worked**, but the summary was **not very detailed for the length of the document** (see open items) |
| Photos attached to a "couldn't open" source; summarise | **Worked** (summary produced) |
| Time to "Your copy is ready to summarise" | Not reported |
| Copies absent from "Your photos and files" | Not reported |
| Phone: picker offers camera and gallery; no sideways scrolling | Not reported |
| Log lines (`[sources]`, `[inbox]`, `[reader]`) | **Not captured** (terminal closed). Check at the next live check that they hold code words and counts only |
| Worker pasted into Cloudflare | Assumed done (uploads reached the server through the inbox) |

### Pending edits (fold into the named package; no package of their own)
| Edit | Where | Fold into |
|---|---|---|
| ~~Record the WP-108b and WP-109 live checks~~ | `docs/STATE.md` | **Done** (WP-110) |
| ~~Record the WP-114c live check~~ | `docs/STATE.md` | **Done** (v40–42) |
| ~~`/repo-file` catch logs `err?.name`; drop the weekly-wake comment~~ | `wake/worker.js` | **Done** (WP-114f) |
| ~~Record the WP-114f live check (table above) in "Verify steps passed"~~ | `docs/STATE.md` | **Done** (WP-114g) |
| Loader also reads `structure.optionalGroups` | `server/curriculum.js` | WP-120, or any earlier package that edits that file |
| Tighten the wellbeing level wording in `ROUTE_SYSTEM`; add light-model route-choice eval cases at levels 0–3 | `server/ai/conversation.js`, `evals/cases` | WP-125 |
| Extend `BLOCKED_SOURCE_HOSTS` as essay-bank sites are found | `server/ai/sources.js` | Any package touching sources |
| ~~A "read the original" answer about an attached copy says "Open the link", even when there is no link~~ | `server/domain/attachments.js` / summary messages | **Done** (WP-114g) |

### Open items (no package yet)
| Item | Notes |
|---|---|
| ~~Summaries of long attached documents are thin~~ | **Decided (17 Nov):** A-011, built in WP-114g. The 8 MB file limit also stopped a journal article uploading |
| Topics and qualification can't be changed on the check screen | No topic-list route yet. Simon to choose the package |
| ~~Understand and research it starts again after a reload~~ | **Done** in WP-114h (Simon chose a small package, 60 days) |
| Navigation feels inconsistent in places | Simon to note the screen, what he tapped and what he expected. A small tidy-up package may follow |

### Private packages
| WP | Repo | Title | Goal | Depends on | Status |
|---|---|---|---|---|---|
| 114r | private | Clear test records | Remove the test tasks, uploads, attempts, conversations, ai-turns, sources, notebook entries and events. Keep profile, curriculum, docs, workflow and snapshot | — | **Done** (PR #12, 4 Nov; 89 files removed; `planner/`, `questions/` and `sessions/` left alone) |
| 114p | private | Preferred sites (A-009) | `profile/sources.json`: `{ preferred: { all, <qualificationId> }, school: [] }`, matching the contract in STATE | 114d | **Status to confirm** (not recorded in this workplan; Simon to say whether it was committed) |
| 140a–d | private | Full detail for current units | Full-detail topics (same IDs; `detailLevel: full`), one package per qualification | units known | **Ready.** Current units are in private `docs/private-notes.md` |
| 141 | private | Co-design settings | `profile/app.json`, `profile/learner.json`, private tone examples, spelling samples later | — | **Ready.** Must match the private prompt settings contract in STATE |
| 142 | private | Alert issue assignment and `CLAUDE.md` refresh | `alert.yml` assigns issues to the owner; REPLACE `CLAUDE.md`; optionally master spec v3.7 to `docs/` | — | **Approved**; any time |
| 143 | private | Register: learner's two-step verification | Record the result | Simon's answer | Waiting |
| 020-school | — | School network check (A-006) | Learner on a school PC | — | Whenever convenient |

**Private commits since v1.7:** none recorded here. WP-114p status to confirm; live-check test records (the test task, its sources and attached copies) are now in the storage repository and may want a later clear-out like WP-114r.

**Order:** ~~101 → … → 114 → 114d/e/f → 114g → 114h → 114i~~ → **115** → 116 → 117 → 118 → 119 → 120 → 121 → 122 → 123 → 124 → 125 → 126. WP-119, WP-123 and WP-124 are unblocked and can go earlier if Simon prefers. Private packages slot in when their information arrives; WP-142 can go at any time.

**Progress:** 15 of 26 public packages done, plus one hotfix (WP-108, 111 and 114 were split; WP-114d became 114d, 114e and 114f; WP-114g was added for A-011 and is done). Public tests: 327 at phase start → 640 (v39) → 703 (v42) → 721 (v45) → 723 (v46) → 724 (v47) → 726 (v48) → 727 (v49) → 731 (v50) → **732** (v51).

## Risks
| Risk | Handling |
|---|---|
| EPQ starts (November) before phase 2 exists | Phase 1's research and notebook cover topic choice and research |
| Some unit choices still unknown | 140a–d go ahead with known units; the learner completes the rest in the app (WP-120) |
| Haiku misses leaks or under-rates wellbeing | WP-125 decides; move the checker to Sonnet if needed (§43) |
| Research replies up to ~110 s on the searching try; the screen waits 210 s | Watch for timeouts in real use; settings can be tuned |
| `web_fetch` refused by some sites (403) or paywalls | **Handled:** paste the text (WP-114e) or attach a copy (WP-114f) |
| Sources skew to official and academic pages | **Handled:** A-009 tiers (WP-114d) |
| 20 MB may be too much for the Worker's free plan or GitHub's file API | GitHub allows 100 MB and Cloudflare a 100 MB body; the Worker's 128 MB memory was the blocker (measured), so WP-114g part 1 streams large files. `inbox-size-check` proves it live; fall back to about 12 MB if it fails |
| WP-114f log lines not yet seen live | Check at the next live check that they hold code words and counts only |
| Package size (front-end screens) | Large packages are fine; split at a natural break, roughly over 1,500 lines |
| A `package.json` change drops the `zod` override | Standing rule 1; Claude Code checks `npm audit` |
| Large libraries slow a fresh Codespace install | Accepted; one-off `npm install` after a rebuild |

## Changes from the original plan
1. *(31 Oct)* First draft.
2. *(31 Oct)* Reviewed against build spec §47.1, master v3.6 and STATE v19.
3. *(31 Oct)* **v1.3: approved.** Decisions 1–5; WP-142 approved with WP-144 folded in.
4. *(31 Oct)* **v1.4:** WP-101 to 103 and the `zod` hotfix done; standing rules for `package.json`; pending edits table.
5. *(31 Oct)* **v1.5:** co-design held; WP-108 and WP-110 unblocked; A-007 in WP-111.
6. *(2 Nov)* **v1.6:** WP-104 to WP-109 done; WP-108 split; decision 8; standing rule 4.
7. *(4 Nov)* **v1.7:** WP-110 to WP-114 done (STATE v39, 640 tests); private WP-114r done; decisions 9–14; standing rules 5 and 6; WP-114d proposed; A-008 folded into WP-121, 122 and 123.
8. *(17 Nov)* **v1.8:**
   - WP-114d done as 114d, 114e and 114f (STATE v42, PR #42, 703 tests).
   - Decisions 15 (A-009) and 16 (A-010) added; standing rule 7 added.
   - WP-114f live check recorded in part; thin summaries of long documents added as an open item.
   - Worker tidy-ups done in WP-114f, so removed from WP-124 and the pending edits.
   - WP-123 now also removes attached source copies.
   - Private WP-114p listed (status to confirm).
   - Risks updated. **WP-115 is next.**
9. *(17 Nov)* **v1.9:** Claude Code becomes the main developer (one package per session; it keeps this file's status up to date). **A-011** decided (20 MB files; 75,000 characters; longer summaries); **WP-114g** added before WP-115. Private details moved to private `docs/private-notes.md`. Next amendment A-012.
