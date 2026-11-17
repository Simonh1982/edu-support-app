# Build spec amendments: `edu-support-app`

**What this is:** owner decisions made since `docs/build-spec.md` was generated from the master specification. Each one changes or clarifies a numbered build spec section.
**Status:** **where an amendment differs from `build-spec.md`, the amendment wins** until the master specification is updated and the build spec regenerated. Never edit `build-spec.md` directly.
**Privacy:** this file contains nothing about the learner, and lives in the public repository.
**Last updated:** 17 November 2026.

---

## Current amendments

Build spec generated from master specification **v3.7** (31 October 2026). Current amendments: A-008 to A-012.

### A-008: Photos and files are removed automatically, and hidden from the list once they are tasks
**Decided:** 4 November 2026 (owner, options 1A and 2B). **Changes:** build spec §32.2 ("How long conversations are kept"), Appendix A.3 (Upload) and A.6 (retention note); blueprint §4.6 (retention table). **Workplan:** WP-123 (retention), and WP-122 or an earlier tidy-up package (the list).

**1. Retention (2B).**
- An upload linked to a task (the task's `sourceUploads`, or the upload's `taskId`) is removed **30 days after the task is first marked submitted or done**. That uses the same clock (`completedAt`) as task-linked AI conversations.
- An upload linked to no task (never confirmed, or failed) is removed **60 days after it was received**, the same period as conversations not linked to a task.
- **What goes:** the file and its Upload record, including the extracted text and spelling corrections.
- **What stays:** the task, with its corrected question text and anchors, plus drafts, plans and feedback (learning history). Links to the removed upload are cleared.
- Both periods are settings in `server/config.js`. Clean-ups run when the server starts, so no scheduler is needed.
- A removed upload stays in the private repository's history. Full erasure is only on request, using the owner-run runbook (§32.2).

**2. Display (1A).**
- "Your photos and files" shows only uploads still waiting, being read, waiting to be checked, or failed.
- Once an upload is confirmed as a task, it leaves the list. It can still be opened from its task until it is removed.
- The snapshot is unchanged.

**Wording for §32.2,** after the conversation periods: *"Photos and files are removed 30 days after their task is first completed, or after 60 days if they never became a task. The task itself, with its question and details, is kept."*

### A-009: Research cards in tiers, with preferred educational sites
**Decided:** 4 November 2026 (owner, options B and C). **Changes:** build spec §25 (Live web research), §26 (Source presentation) and §28 (Summarisation); blueprint §7.5 (tools and source filter). **Workplan:** WP-114d, plus a small private settings package for the preferred-sites list.

**Why:** in testing, the cards were relevant but held only official and academic sources. A search for a specific case study returns case-study material. Introductory resources explain the **concept**, so they must be searched for separately. §25 already asks for *"accessible introductions … reputable educational resources"*; this amendment makes that reliable.

**1. Tiers, each with its own search.**

| Tier | What is searched | Card label (§26) |
|---|---|---|
| Start here | The concept at A-level standard, preferring the preferred sites | Quick introduction |
| Watch | A short explainer video on the concept | Video (with its length, if known) |
| Your case study | The named place, text, track or project: official and primary sources | Official information |
| Go deeper | Academic or specialist material, preferring an open-access copy | More challenging reading |

- Aim for about 4–5 cards in this order. Fill a tier only when there is a good source for it. Never pad.
- **Summarise** isn't offered for video cards, because there is no page text to read.

**2. Preferred sites (private settings).**
- A per-subject list of preferred educational sites is held in the **private** repository, as `profile/sources.json`. The owner can edit it, and nothing is hard-coded in public code.
- Preferred sites are **preferred, not exclusive**. Any good source can still appear.
- An empty **school resources** list sits alongside it. Sources added there are labelled *"Use your school login"*.

**3. The source filter is unchanged from §25.**
- It works **page by page, not site by site**. Revision sites that also host model answers stay usable.
- A model answer, exemplar or essay-bank page is excluded **only when it closely matches one of the learner's open tasks**, judged against the task's anchors as in §23.4 and §23.6. Model answers to other questions may be linked.

**4. Paywalled sources.**
- Prefer an open-access copy, for example a university repository or the author's own copy.
- Otherwise, label the card *"May need a subscription. Ask {parents} if they can get you a copy."* The wording uses the private `{parent}`/`{parents}` labels and agrees with a plural label.

### A-010: Paste or attach a source the tutor can't open, and add sources he finds himself
**Decided:** 6 November 2026 (owner, options 1B, 2A and 3B). **Changes:** build spec §26 (Source presentation), §28 (Summarisation), §29 (Research notebook) and Appendix A.3 (Source); blueprint §7.5. **Workplan:** WP-114e (paste, add your own source), WP-114f (attach a file or photos).

**Why:** in testing, many sites refused the tutor's page reader (for example 403 from a council site and a revision site with a paywall). Refusals are likely to become more common as sites block AI tools. Some useful sources, such as a full journal article or a book, can only be read by the learner.

**1. Add a source he found himself (1B).**

- From a task, he can add a source with a **title**, plus an **author or publisher** and a **link** if he has them.
- It is saved as a Source record (`origin: learner`) linked to the task and its topics, and labelled *"Your source"*.

**2. Paste to summarise.**

- Offered on a source card once the tutor couldn't open the page or found a paywall, and on any source he added himself.
- He pastes the part he needs (up to 12,000 characters). The tutor summarises it with no web tools, and the §28 rules apply: it is labelled **AI summary**, keeps the source, names the most useful section and encourages him to read the original. On a task it goes through the live check (§23.5).
- **The pasted text is never stored or logged (2A).** It goes to the model once, and only the summary is kept, as a notebook entry. He can paste again if he needs to.

**3. Attach a file or photos (3B).**

- On a source, he can attach a **PDF or Word file**, or **up to 5 photos of pages** (for example from a textbook), for a summary.
- Attachments go through the Worker inbox like every other capture (one route). The server reads them as it reads briefs, and they are never treated as briefs or his own work.
- **Retention follows A-008:** removed 30 days after the task is first submitted or done, or after 60 days if the source has no task. The summary stays as part of his learning history.

**4. Unchanged.**

- Source text, pasted or attached, is **never rated for wellbeing** (§32.1).
- AI-written summaries can be pinned but never inserted into his own text (§28, §29).
- The source filter and the A-009 tiers are unchanged.

### A-011: Long documents attached to a source
**Decided:** 17 November 2026 (owner). **Changes:** build spec §28 (Summarisation), §44 (uploads); blueprint §3.5, §5.2 and §10.4 (upload limits). **Workplan:** WP-114g.

**Why:** in testing, a journal article was too large to upload, and when one did upload, only the first 40,000 characters were read. The summary covered little more than the introduction.

**1. Larger files (20 MB).**
- PDF and Word files can be up to **20 MB** (was 8 MB). This is one limit for every file route: briefs, his own drafts and attached source copies.
- Photos are unchanged: they're still resized on the device.
- The limit changes everywhere it's held: the Worker's `POST /inbox`, the server, `server/documents.js`, and the page's copy in `web/shared/`. The tests that check these copies match must still pass.
- Raise the document reader's other limits to suit long documents: at least **100 pages**, and a longer reading time if needed.
- **Verify first:** 20 MB has not been tested through the Worker's free plan or GitHub's file API. The phase 0 test proved only 8 MB. If either fails, report it and propose the highest limit that works, or another upload route. The owner decides.

**2. More of the document is read (75,000 characters).**
- An attached copy is read up to **75,000 characters, including spaces** (`ATTACHED_SOURCE_MAX_CHARS`; was 40,000).
- If a document is longer, the summary says plainly which part it covers, for example *"This summary covers roughly the first 24 of 40 pages"*, and suggests attaching or pasting the rest.
- Pasted text keeps its 12,000-character limit (A-010).

**3. Longer documents get longer summaries.**
- Summary length scales with the document: short for a few pages, up to roughly **700–900 words** for a document near 75,000 characters.
- Long summaries follow the document's own sections, and name the sections most useful to his question.
- Every §28 rule still applies: the summary is labelled **AI summary**, keeps the source, encourages him to read the original, explains the source rather than relaying its argument on his question, and goes through the live check on a task (§23.5).

### A-012: More of a long document is read, and a summary can be tried again
**Decided:** 17 November 2026 (owner; drafted for approval, approved by merging WP-114g-fix part 3). **Changes:** A-011 part 2 (the limit) and build spec §28 (Summarisation). **Workplan:** WP-114g.

**Why:** in testing, a 25-page journal article came to about 82,000 characters as the app reads it. Word counted about 50,000 for the same file, because the app also reads the text Word leaves out when it opens a PDF, such as headers, footers, captions, tables and the reference list. So 75,000 left out the last pages. Also, once a summary was refused as too close to the task, there was no way to try again without attaching the file again.

**1. 120,000 characters.**
- An attached copy is read up to **120,000 characters, including spaces** (`ATTACHED_SOURCE_MAX_CHARS`; was 75,000 under A-011).
- Everything else in A-011 is unchanged: the coverage note when a document is longer, summaries of up to roughly 700–900 words, and pasted text at 12,000 characters.

**2. Try again after "too close".**
- When a summary fails the live check twice, the message stays, and **Summarise** becomes **Try the summary again**. It uses the copy already attached or the page already saved.
- Each try goes through the live check as before (§23.5). "Read the original" and "needs a subscription" still end the offer, as before.

---

## Folded into the build spec

| Amendment | Decision | Now in |
|---|---|---|
| A-001 | Spelling in transcribed briefs vs the learner's own writing | Build spec §8.1, §9.3, §44, Appendix A.3; blueprint §7.13 |
| A-002 | Image size safeguards | Build spec §8.1, §44; blueprint §10.4 |
| A-003 | Scanned PDFs: sent to the model within its limits, otherwise ask for photos | Build spec §44; blueprint §10.4 |
| A-004 | No weekly wake; the Codespace is kept with Auto-delete off | Build spec §42, §47.1, Appendix B; blueprint §9.3, §9.4 |
| A-005 | The learner chooses optional and current units in the app | Build spec §4.2, §6, §47.1, Appendix A.2, Appendix D; blueprint §2.2, §3.5, §4.3, §10.8 |
| A-006 | School network check is optional | Build spec §47.1, Appendix B; blueprint §13 step 15 |
| A-007 | Thumbs up and down on AI replies | Build spec §31, §47.1, Appendix A.6 |

New amendments start at **A-012**.
