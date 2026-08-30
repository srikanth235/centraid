<!-- governance: allow-receipt-per-issue checklist-echo-only for PR 876; file coverage stays the original #882 slice list -->
# Issue #882 — close the handoff gaps across all eight apps

<!-- One receipt for issue #882; each slice has its own section below. -->

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-28 | claude-code | 9f9597ec-a2db-55c1-a91a-455e1423453c |

## Checklist

Mirrors [#882](https://github.com/srikanth235/centraid/issues/882)'s acceptance
criteria, in its order. One is deliberately unchecked and says why on its own
line rather than only in prose.

- [x] A task opens on the phone, and the recurrence anchor can be set from it
- [x] Every row in the Tasks More sheet navigates; Anytime, All, Search, Logbook, Catch up and Reminders are reachable on the phone
- [x] Quick add offers When, Where, Priority and Lands-in, and states where the task lands
- [x] The Tasks lens and sort toolbar is drawn, and scrolls horizontally at 390px without pushing the first task off-screen
- [x] A project opens to its sections; New project asks for an area and a home vault instead of writing a literal name
- [x] An overdue due date on a phone row carries the attention tone; priority rides the row
- [x] Notes draws Notebooks, Tags and History as places on the phone; a version can be restored there
- [x] Agenda's compact band offers no destination that resolves to a different view, and the phone and web bands are generated from one table
- [x] Locker's Access history, Import and Export read the doors #873 landed, or still say where the act happens — never a dead control
- [ ] The four dead register entries are gone, and every remaining `NATIVE_FALLBACK` entry names a handler the cover genuinely does not dispatch — **three of the four are gone** (`tasks.action.edit`, `photos.action.tag-asset`, `locker.query.access`). `locker.action.export` is KEPT: the phone does dispatch it, through the shared builder in `apps/locker/writes.ts` where the one-computation rule wants the name, so the native tree names nothing and the scan cannot see it. The criterion's second clause was written too narrowly — the register also marks handlers that are dispatched but invisible to the scan, which is the block this entry moved into
- [x] `handler-reachability.test.ts` matches dispatch shapes, and fails when a handler is only named by a route key or a copy constant
- [x] `docs/design-divergences.md` carries the Tasks and Notes phone-scope rows, or those rows are gone because the gap is closed

The seven slices the execution plan named, all landed: A the Tasks detail place
and More sheet; B the Tasks board's remaining brief; C Notes' three places and the
band; D Agenda's band coherence; E Locker's three doors; F gate fidelity, the
register and the docs; and G, which the plan did not foresee — the comment-density
ratchet, repaired by trimming after seven parallel slices pushed it red.

## What prompted it

An audit of the v17 Binding Layer handoff canvas against what the eight apps
actually ship. The web and desktop surfaces implement their briefs. Every gap
was on the phone, and it concentrated in the two apps [#834](https://github.com/srikanth235/centraid/issues/834)
rebuilt: the Tasks cover drew about four of the brief's twelve screens, and the
Notes cover was five files that no gate measured.

Three defects surfaced while establishing the register, none of them a missing
screen:

1. Agenda's compact band published a **Month** destination that resolved to Day
   and could never light up, because `BAND_DESTINATIONS` came from `TOUCH_VIEWS`
   while the band was handed the *resolved* view as its active id.
2. The shared app bar withdrew its own Search on compact "because the band
   already carries Search" — which Agenda's band did not. The field was
   reachable only as an unlabelled second tap inside the More sheet.
3. Tasks' project rows carried placeholder writes: one saved a section literally
   named "Today", the other a project literally named "Inbox".

And one governance finding: the reachability gate's `hasLiteral` matches any
quoted occurrence of a handler name in a cover, so **a route key satisfies it**.
`locker.action.export` and `locker.query.access` had been passing the mobile gate
on `export: "export"` and `route="access"` while the phone dispatched neither.

## What changed

<!-- receipt-per-issue substring crosswalk: the checked checklist items,
quoted so the gate can find them in this section. The work itself is
described in the slice sections below; this list is the mechanical echo. -->

- A task opens on the phone, and the recurrence anchor can be set from it
- Every row in the Tasks More sheet navigates; Anytime, All, Search, Logbook, Catch up and Reminders are reachable on the phone
- Quick add offers When, Where, Priority and Lands-in, and states where the task lands
- The Tasks lens and sort toolbar is drawn, and scrolls horizontally at 390px without pushing the first task off-screen
- A project opens to its sections; New project asks for an area and a home vault instead of writing a literal name
- An overdue due date on a phone row carries the attention tone; priority rides the row
- Notes draws Notebooks, Tags and History as places on the phone; a version can be restored there
- Agenda's compact band offers no destination that resolves to a different view, and the phone and web bands are generated from one table
- Locker's Access history, Import and Export read the doors #873 landed, or still say where the act happens — never a dead control
- `handler-reachability.test.ts` matches dispatch shapes, and fails when a handler is only named by a route key or a copy constant
- `docs/design-divergences.md` carries the Tasks and Notes phone-scope rows, or those rows are gone because the gap is closed

### Slice A — the Tasks detail place (`d7c8a0577`)

A row could be completed or long-pressed to file, never opened. The detail is a
place *within* the one Tasks screen, not a new route — the navigator's
single-route shape is deliberate and stayed untouched. It carries the editable
title and note, the field list, the subtask family and the lifecycle pair, and a
field is **absent** when the row has no answer, so a one-shot task draws no
repeat control.

The anchor — from the schedule, or from completion — appears only on a task that
actually repeats. It is the one choice that decides what a missed period means,
and the phone had no surface for it at all.

Every More row now navigates, keyed by the web's own shelf segments. Search
dispatches the app's `search` query and states that the index lives beside the
gateway when it cannot be reached, rather than showing an empty result set posing
as "no matches". Catch up draws the absence buckets with one bulk verb each. The
Logbook's foot says this replica holds no denominator instead of borrowing the
vault's window sentence.

`attach` and `detach` stay undrawn: the cover has no native file picker, and a
control that opens nothing is the placeholder this repo bans.

### Slice B — the Tasks board's remaining brief (`b32c541ed`)

Quick add is title-first, with When, Where, Priority and Lands in appearing
inline once there is a title, and a foot naming where it will land. **Lands in is
drawn only where more than one vault is mounted**, because a single unpressable
chip is a dead control. The field never parses a sentence; the assistant is the
natural-language door and the sheet says so.

The toolbar is one horizontal scroller — three chips and a verb cannot wrap at
390px without eating the first task. Mine and House are one axis, so choosing one
retires the other rather than two additive-looking chips emptying the board.

A project opens to its sections with manual order inside each, and New project
asks for the name, the area and the home vault a project actually needs. Both
placeholder writes are gone.

The row keeps its two promises: the overdue part alone carries the attention
tone, so the rest of the meta stays quiet, and priority rides the row while
reserving nothing when unset.

### Slice C — Notes' three places and its band (`91f20508f`)

Notebooks, Tags and History. The version chain is the one that mattered: restore
**appends**, and a test asserts the pre-restore chain survives inside the
post-restore one, because a restore that loses what it replaced is the failure
the feature exists to prevent.

Notes claims the phone band, which its four places now earn — Library,
Notebooks, Journal, Search, plus More at the cap. Ids and labels come from the
blueprint's table, so band, sheet and library cannot disagree.

Three queries stay undispatched for a structural reason, not a choice: the native
replica session exposes no named-query seam — only entity read, FTS search and
write — so the powerbox and the chain run the **shared** computations over those
transports. Slice F records that in `NATIVE_QUERY_UI`, which is exactly what that
register means.

### Slice D — Agenda's band coherence (`4e555d6bd`)

`TOUCH_VIEWS` is now `readonly TouchView[]`, where the type admits only day,
schedule and waiting: Month and Week are absent **by type** rather than by
convention. `POINTER_VIEWS` is untouched. `resolveView` keeps its coercion, which
is now what it always claimed to be — a pointer member whose stored knob says
Month narrows the window on a narrow one, not a band fallback.

Search became the band's fourth destination on both seats, and the field moved
out of the More sheet into its own row. Closing it clears the term, because a
closed field that still filters is a hidden filter.

Two tests carry the rule: no band destination may resolve to a view other than
itself, and the bar's compact withdrawal must be matched by a band that carries
Search. Both were demonstrated red by putting `month` back in the table.

### Slice E — Locker's three doors (`eb8ddf22f`)

Access history, Import and Export were fact screens naming the seat where the act
happens. That was correct when written; [#873](https://github.com/srikanth235/centraid/issues/873)
has since landed the doors, and this slice points the phone at them.

- Access history dispatches `locker.query.access` through the cover's one gateway
  door. The shared secret bag already enumerated `accessEntries`, so the wipe path
  was waiting for the surface. The list names the verb, the item and the columns a
  reveal touched, and **never a value** — a test asserts a `SECRET` constant is
  absent from what it renders.
- Export issues the canonical write through the shared builder, which stamps it
  online-only, so the write door refuses to enqueue it before any id is minted.
- Import goes through the gateway's owner-tier vault-imports workflow, the same
  door Photos' camera-roll import already stages through, with every refusal drawn
  as itself.

Companion stays a fact screen: its candidate and fill queries belong to the
browser extension by construction.

### Slice F — gate fidelity, the register, and the docs

`hasLiteral` is gone. Every scan calls `hasDispatch`, which keeps an occurrence
of a handler name only in a **dispatch position**: the value of an
`action:`/`query:` field (reachable through ternary operands, so
`action: starred ? "unstar-item" : "star-item"` counts), or inside the still-open
argument list of a real call. Object keys, array elements, JSX attributes, `case`
labels, union members and `===` comparisons all fail now and passed before. Every
accepted position is a strict subset of the old test, so the gate can only have
got stricter.

The matcher was widened exactly once, and for a shape that was proven to
dispatch: Locker's ternary `action:` pairs failed the first pass, and the matcher
was fixed rather than an exception added.

`WEBVIEW_APPS` is deleted with its whole mobile branch. #799 retired the WebView
host and Notes was its only member, so every surface is now measured on its own
tree — the phone's Notes cover included, for the first time.

The register, corrected against what the covers do rather than what they once
did: Tasks drops five entries and keeps `attach`/`detach`; Locker drops
`query.access` and keeps `action.export`, moved beside the seven builder-backed
writes because its old rationale had become false; Photos drops `tag-asset`;
Notes gains its own entries. `NATIVE_QUERY_UI` gained `notes` (six queries the
native session cannot dispatch, because it exposes only entity read, FTS search
and write) and `photos.people`, and lost the stale `locker` and `tally` keys
whose queries the gateways now dispatch. `MOBILE_EXCEPTION_RATIONALE` no longer
claims the Assistant carries every entry, which was false for the 28
builder-backed Locker and Tally writes.

### Slice G — the comment-density ratchet, back to green by cutting

Every file the gate named was trimmed. No pin was raised, no file allowlisted,
`tests/comment-density-ratchet.json` untouched, and `--write` never run — it would
have silently pinned the unpinned over-cap files, which is the same laundering as
an allowlist. Global share fell 14.60% → 14.53%, and the pass is comment-only by
`scripts/comment-only-diff.mjs`.

Nothing naming a security rule, a consent boundary, a wipe path or a pending-write
invariant was cut: those were compressed and kept at their strongest site, so
`locker-files.ts` came down from 60.53% to 12.57% while keeping "both file doors
carry plaintext; no copy may outlive the act" and the size-refusal reason.

Two files needed a second pass afterwards, because later work re-raised them:
`apps/mobile/src/apps/locker/LockerExportView.test.tsx` (the hygiene-ratchet
rewrite added JSDoc) and `apps/web/tests/e2e/agenda-compact-band.spec.ts` (the new
evidence spec landed over the cap). Both were trimmed rather than pinned, and the
gate is green on the final tree.

## The files this change touches

**Mobile Tasks — `apps/mobile/src/apps/tasks/`** (24) — `TaskDetail.tsx`,
`TaskDetailFields.tsx`, `TaskRow.tsx`, `TasksCatchUp.tsx`, `TasksDenied.tsx`,
`TasksHome.styles.ts`, `TasksHome.tsx`, `TasksMoreSheet.tsx`,
`TasksPlaceHeader.tsx`, `TasksProject.tsx`, `TasksProjects.tsx`,
`TasksQuickAdd.tsx`, `TasksReminders.tsx`, `TasksRows.tsx`, `TasksSearch.tsx`,
`TasksToolbar.tsx`, `tasks-band.ts`, `tasks-groups.test.ts`, `tasks-groups.ts`,
`tasks-places.test.ts`, `tasks-places.ts`, `tasks-row-model.test.ts`,
`tasks-row-model.ts`, `tasks-seat-copy.ts`

**Mobile Notes — `apps/mobile/src/apps/notes/`** (14) — `NoteEditor.tsx`,
`NotesBand.tsx`, `NotesHistory.tsx`, `NotesHome.styles.ts`, `NotesHome.tsx`,
`NotesPlaces.tsx`, `NotesPowerbox.tsx`, `NotesScreen.tsx`, `notes-band.test.ts`,
`notes-band.ts`, `notes-model.test.ts`, `notes-model.ts`, `useNoteVersions.ts`,
`useNotes.ts`

**Mobile Locker — `apps/mobile/src/apps/locker/`** (21) —
`LockerAccessScreen.tsx`, `LockerAccessView.test.tsx`, `LockerAccessView.tsx`,
`LockerExportView.test.tsx`, `LockerExportView.tsx`, `LockerImportView.test.tsx`,
`LockerImportView.tsx`, `LockerMoreSheet.tsx`, `LockerSurfaceScreen.tsx`,
`locker-band.test.ts`, `locker-band.ts`, `locker-export.test.ts`,
`locker-files.ts`, `locker-gateway.ts`, `locker-seat-copy.ts`, `locker-store.ts`,
`locker-surfaces.test.ts`, `locker-surfaces.ts`, `locker-view-model.test.ts`,
`locker-view-model.ts`, `locker-writes.ts`

**Mobile Agenda and kit** (6) — `apps/mobile/src/apps/agenda/AgendaHome.tsx`,
`agenda-band.test.ts`, `agenda-band.ts`; `apps/mobile/src/kit/band/band-owner.ts`
and `band-owner.test.ts` (Notes joins the roster);
`apps/mobile/src/kit/replica/row-provenance.test.ts` (the row's provenance
assertions follow the row into `TaskRow.tsx`)

**Blueprint Tasks — `packages/blueprints/apps/tasks/`** (14) — `board-view.ts`,
`board-view.test.ts`, `components/Editor.tsx`, `detail.ts`, `detail.test.ts`,
`logic.ts`, `logic.test.ts`, `projects.ts`, `projects.test.ts`, `quick-add.ts`,
`quick-add.test.ts`, `view-copy.ts`, `view-copy.test.ts`, `writes.ts`

**Blueprint Notes — `packages/blueprints/apps/notes/`** (9) — `filing.ts`,
`filing.test.ts`, `format.ts`, `link-targets-table.ts`,
`link-targets-table.test.ts`, `queries/link-targets.ts`, `version-chain.ts`,
`version-chain.test.ts`, `view-copy.ts`

**Blueprint Agenda — `packages/blueprints/apps/agenda/`** (10) — `Chrome.tsx`,
`app-root.tsx`, `components/MoreSheet.module.css`, `components/MoreSheet.tsx`,
`components/Shared.module.css`, `components/Shared.tsx`, `frame.tsx`,
`view-copy.ts`, `views.ts`, `views.test.ts`

**Blueprint Locker and the registers** (3) —
`packages/blueprints/apps/locker/route-copy.ts` (one string: a draft the border
recognised nothing in is a refusal, distinct from no draft waiting),
`packages/blueprints/src/handler-reachability.test.ts`,
`packages/blueprints/manifest.json` (generated, and it moves with the modules it
indexes)

**Gates and evidence** (2) — `scripts/accessibility-contract.test.mjs` (the
virtualization pin follows the board list off `TasksHome.tsx`, which is now a
router, onto the Tasks files that own a `FlatList`),
`apps/web/tests/e2e/agenda-compact-band.spec.ts` (new: the compact-viewport
regression test for the band defect, and the emitter of this change's UI evidence)

**Docs and this receipt** (5) — `docs/decisions.md`,
`docs/design-divergences.md`, `CHANGELOG.md`, `QUALITY.md`,
`receipts/issue-882-handoff-gaps.md`

### Test rewrites carried by the gate work

`bun run test:hygiene-ratchet` holds a down-only budget on `toHaveBeenCalled*`,
whose point is that a test should assert the outcome a call produced rather than
that a mock ran. This branch's new tests pushed it over, so four Locker test files
— `LockerExportView.test.tsx`, `LockerImportView.test.tsx`, `locker-export.test.ts`
and `locker-surfaces.test.ts`, all new against `origin/main` and reworked in-branch
before landing — assert recorded call arrays, the status text a surface posts, and
the vault state held afterwards, rather than that a spy fired. The assertion that
no secret reaches the rendered output lives one file over, in
`LockerAccessView.test.tsx`.

## State at the time of this commit

The commits on this branch were pushed with the governance hooks bypassed, at the
maintainer's explicit instruction, so the record has to be exact about what was
actually run.

Green, run directly against the final tree:

```
bun run test:comment-density   ok — no pin rose, no unpinned file over cap
bun run test:accessibility     5/5
bun run test:hygiene-ratchet   1488 test files at budget (785, at the cap)
bun run check:ui-receipt       evidence verified
bun run --cwd packages/blueprints test src/handler-reachability.test.ts   17
```

Plus the Tasks, Notes, Agenda and Locker blueprint suites and the `apps/mobile`
suite (246 files / 2110 tests) as of each slice's own run.

**Two things cannot run in this sandbox at all**, both for the same reason: the
Playwright headless-shell build is absent from `/opt/pw-browsers`, so each dies at
`browserType.launch` before any assertion executes. One is `design:gallery`, which
is unrelated to this diff. The other is **this change's own regression spec**,
`apps/web/tests/e2e/agenda-compact-band.spec.ts` — so the band fix is proven here
only by `packages/blueprints/apps/agenda/views.test.ts`, and the browser-level
proof plus the UI-impact PNG are CI's to produce.

**The full `check:push` lane was not re-run end to end after the final fixes.**
It last ran at 44/48 mid-work; the four it named are the four discussed above,
three now green and one environmental. CI is the judge.

## User impact

Someone using the phone gets the halves of four apps that were designed but never
drawn. A task opens, so its dates, reminder, priority, effort, tags and vault are
editable where the task is — and a repeating task finally exposes its **anchor**,
the choice between "every Monday whether or not I did it" and "three days after I
last finished it", which decides what a missed period means. Six destinations
that previously rendered as an unpressable list — Anytime, All, Search, the
Logbook, Catch up, Reminders — now go somewhere. Adding a task asks when, where,
how urgent and which vault, and says where it will land before you commit.
Notes gets Notebooks, Tags and the version History with restore, and a band
instead of chips. Locker's Access history, Import and Export stop naming another
device and do the work here.

On a narrow browser window, Agenda's band no longer offers a Month tab that draws
the Day grid, and carries Search as a labelled destination rather than hiding it
inside More.

**First-run:** nothing here changes what a new member sees on day one. Every new
surface is reached from a band or a row that already existed, each app's day-one
empty state is unchanged, and no new consent, grant or permission is requested —
these are controls for data the member already has. A first-run vault simply has
no notebooks, no versions, no access history and no tasks to open, and each of
those places states its own emptiness in its own words rather than appearing
broken.

Evidence: `apps/web/tests/e2e/agenda-compact-band.spec.ts`, the compact-viewport
regression test for the band defect at the seat where it was user-visible. It
asserts the band's exact tab list, `Month` at count zero, that each destination
lands on the view it names, and that the compact Search withdrawal is a swap
rather than a loss; it emits
`artifacts/e2e/ui-impact/issue-882-agenda-compact-band.png`.

**That spec has not run in this environment and the PNG was not captured here.**
Playwright's headless-shell build is absent from `/opt/pw-browsers`, so the run
dies at `browserType.launch` before any assertion executes. CI owns that proof.
`check:ui-receipt` passing is not counter-evidence: it greps a changed e2e file
for the directory, the filename and a `screenshot(` call, and cannot tell a
passing spec from one that never ran.

## Decisions

**Notes claims the phone band.** The recorded Keep predated the places existing;
with Library, Notebooks, Journal and Search the cover has exactly the frame's cap
of four plus More, and chips would now be a second navigation vocabulary for no
reason.

**Agenda's touch view set is day, schedule and waiting.** The handoff's own reason
for coercing Month and Week — seven columns at 390px are unreadable — argues for
not offering them, and a destination that renders a different view is worse than
an absent one. Search is a destination, not a view, on both seats.

**`docs.action.edit` stays agent-only on web.** Drawing a web editor is a new
capability, not a gap in this handoff; the ruling that the web drive holds,
versions and files a document without opening one to type into is unchanged.

**Two register entries stay rather than being cleaned.** Tasks' and Notes'
`attach`/`detach` remain assistant-reachable because neither cover has a native
file picker. Each entry dies when the phone draws its control; neither is allowed
to become a button that opens nothing.

## Approved deviations

**One, and it is the unchecked box in the checklist.** #882's acceptance criterion
asked for all four dead register entries to be gone and for every remaining
`NATIVE_FALLBACK` entry to name a handler the cover does not dispatch.
`locker.action.export` is kept instead: the phone does dispatch it, through the
shared builder in `apps/locker/writes.ts` where the one-computation rule wants the
name to live, so the native tree names nothing and the scan cannot see it. The
criterion was written too narrowly — the register also marks handlers dispatched
but invisible to the scan — and the entry moved into that block with a corrected
rationale rather than being deleted and re-added later.

No deviation was taken on the ratchets. The comment-density gate went red across
roughly 28 files under parallel work, and Slice G repaired it by **trimming
prose**, not by hand-raising a pin or allowlisting a file — the two outs the gate
offers and this repo's standing rule forbids.

## Verification

Every slice ran package-filtered checks rather than the full suite, because six
agents worked in parallel (docs/multi-agent.md G2). The root ran the gate loop
over the integrated tree.

```sh
bun run --cwd packages/blueprints test apps/tasks apps/notes apps/agenda apps/locker
bun run --cwd packages/blueprints test src/handler-reachability.test.ts
bun run --cwd packages/blueprints typecheck
bun run --cwd apps/mobile test
bun run --cwd apps/mobile typecheck
bun run test:comment-density
bun run check:push
```

The two gates that carry this issue's substance:

- `packages/blueprints/apps/agenda/views.test.ts` fails if any band destination
  resolves to a view other than itself, or if the app bar withdraws Search on
  compact while the band does not carry it. Both were demonstrated red by putting
  `month` back in the table.
- `packages/blueprints/src/handler-reachability.test.ts` fails if a handler is
  reached only by a name that is not in a dispatch position. Seeded red against
  Locker's `access`, which is the case that motivated it.

## Audit

Independent sub-agent, fresh context; inputs were the diff, this receipt and issue #882. Re-audit after remediation of an earlier REFUTED audit.

1. **What changed faithfully describes the diff** — PASS, after a second
   remediation pass re-verified against the tree (this verdict was REFUTED on one
   claim in the first pass of this re-audit). Verified true, file by file: the inventory now
   accounts for all 108 changed files and every per-group count matches the tree
   (Tasks 24, Notes 14, Locker 21, Agenda+kit 3+3, blueprint Tasks 14 / Notes 9 /
   Agenda 10, Locker+registers 3, gates 2, docs 5); `hasLiteral` is gone and every
   accepted `hasDispatch` position is a strict subset of it, so the gate only got
   stricter; `WEBVIEW_APPS` and its whole mobile branch are deleted; the register
   deltas read exactly as described (Tasks drops five, Photos drops `tag-asset`,
   Locker drops `query.access`, Notes gains `attach`/`detach`, `NATIVE_QUERY_UI`
   gains `notes` and `photos.people` and loses `locker`/`tally`); `BAND_DESTINATIONS`
   is one table feeding both seats with Month absent by type; and
   `scripts/accessibility-contract.test.mjs` is now named in the inventory and was
   **strengthened, not weakened** — one `TasksHome.tsx` pin became seven Tasks pins
   under the identical `/<FlatList/u` regex. The four Locker tests are described and
   do assert outcomes (recorded call arrays, `postStatus` text, a `SECRET` constant
   asserted absent), not defanged. `tests/comment-density-ratchet.json` and
   `tests/hygiene-budgets.json` are untouched by the diff, and the working tree
   carries no code change vs HEAD.

   What had refuted this was the account of what was *run*: "State" claimed
   "**One gate cannot run in this sandbox**" while naming only `design:gallery`, and
   "User impact" said the PNG was "**captured by**" the new spec. Both are now
   corrected, and I re-verified every sentence of the correction rather than taking
   it as read. I reproduced both failures myself —
   `npx playwright test -c tests/e2e/playwright.config.ts agenda-compact-band` and
   `bun run design:gallery` each die at Playwright's missing browser under
   `/opt/pw-browsers`, so "two things, both for the same reason" is exact; and
   `design:gallery` is the only browser-dependent gate in `check:push`, so nothing
   else is being passed over. The rest of the new text holds against the tree: the
   spec really does assert the exact tab list, `Month` at count zero, each
   destination landing on the view it names, and the compact Search withdrawal as a
   swap; it emits that PNG and has not run here, so the PNG was not captured;
   `check:ui-receipt` really does only grep a changed e2e file for the directory,
   the filename and a `screenshot(` call, and cannot tell a passing spec from one
   that never ran; and the band fix really is proven here by
   `agenda/views.test.ts` alone, which pins every destination resolving and lighting
   as itself, `month` absent from `BAND_DESTINATIONS`, `bandActiveId` undefined for
   month and week, and the bar-withdrawal/band-Search coupling. `Approved
   deviations` now names the `locker.action.export` deviation, and the claim behind
   it checks out: `exportWrite` in `apps/locker/writes.ts` holds the literal and
   `locker-writes.ts:193` dispatches through it.

   One imprecision survives, too small to refute on and left recorded rather than
   fixed: the "Test rewrites" paragraph credits the four named Locker files with
   asserting "the absence of any secret in what it renders". None of the four does —
   that assertion is `LockerAccessView.test.tsx:92`, a fifth file from the same
   slice. What the four actually assert (recorded call arrays, the status text
   posted, and the vault state held afterwards) is real and verified.

2. **Each checked item is realized in the diff** — PASS. All eleven checked criteria
   land in code: the row opens (`TaskRow.tsx:96`) and `TaskDetailFields.tsx:84`
   draws the anchor cards; `TasksMoreSheet.tsx:31` presses every row through
   `morePlace` over the shared shelf segments; quick add carries
   `FIELDS.when|where|priority|landsIn` with the lands-in foot;
   `TasksToolbar.tsx:46` is one `horizontal` ScrollView; `TasksProjects.tsx` asks
   for area and scope and both literal-name writes are gone; the overdue part alone
   takes `styles.numAttention` while priority rides the title line;
   `NotesHome.tsx:491` dispatches `restore-note-version` and
   `version-chain.test.ts:97` asserts the pre-restore chain survives inside the new;
   `locker-gateway.ts:147` dispatches `appQuery("locker","access",…)` and
   `LockerAccessView.test.tsx:92` asserts no secret is rendered; the divergences doc
   carries the replacement Tasks/Notes phone-scope rows. Run against this tree:
   `apps/mobile` 246 files / 2110 tests, blueprint Tasks/Notes/Agenda/Locker 50 / 978,
   `handler-reachability` 17, both package typechecks and the e2e tsconfig clean,
   `test:comment-density` ok, `test:accessibility` 5/5, `test:hygiene-ratchet` at
   budget (785) with no budget file touched. Slice G's claim now holds.

3. **The checklist mirrors the issue** — PASS. All twelve of #882's acceptance
   criteria appear, in the issue's order, in the issue's own words; the slice plan
   was demoted to prose below the list. The one unchecked box is the honest one:
   `locker.action.export` is genuinely still in `NATIVE_FALLBACK`, and the stated
   reason checks out — `exportWrite` in `packages/blueprints/apps/locker/writes.ts`
   holds the literal, `locker-writes.ts:193` calls it and posts
   `action: write.action`, so the phone does dispatch it and the mobile scan cannot
   see it. The other three dead entries are gone. One residue: "Approved deviations —
   None" now sits alongside an acceptance criterion the receipt itself marks as
   deviated; that line should name it.

## Out of scope

- **`attach` / `detach` on the Tasks and Notes phone covers** — they need a native
  file picker. Registered, not drawn.
- **The web seat's own Tasks toolbar and quick-add chips.** Slice B added the
  arithmetic to the blueprint but did not rewire the pointer seat onto it, which
  would widen the slice; `Screens.tsx` still inlines its own area and section
  grouping, so `projects.ts` has one consumer today.
- **Access history narrowed to one item.** The web offers an all-items/narrow pair
  driven by the query's `item_id`; the phone's route carries no param and
  `navigation.ts` was off-limits to every slice, so it reads every item. No dead
  chip was drawn.
- **A shared-vault project's own scope on the per-section add.** `Project` declares
  no `scope_id` — only `Task` carries the cross-scope stamp — so those writes go to
  the default write target. Filing into a project living in another vault needs a
  scope stamp on the project row first.

**What the phone covers still owe, now recorded honestly in the register rather
than passing on a collision.** Locker: no archive shelf, duplicate act,
custom-field editor or passkey slot (eight actions). Docs: `tag`, `untag`,
`replace`, `query.activity`. Photos: `restore-album`, `untag-asset`. Agenda:
`attach`/`detach`. Each is reachable through the Assistant under the same consent
and receipt contract, and each entry dies the day the phone draws its control.

**A matcher limitation, registered rather than papered over.** A query named after
an app collides with the app-id argument of `useReplicaQuery`/`appQuery` —
`photos.query.people` is the live case. It now carries an honest
`NATIVE_QUERY_UI` entry, so the register is right whichever way the matcher
resolves it.

**One gate could not be run in this environment.** `design:gallery` fails at
`chromium.launch` because the headless-shell build it wants is absent from
`/opt/pw-browsers`; the failure is before any repo code executes and is unrelated
to this diff. CI runs it with the browser present.

**A doc row outside this change to check.** `docs/design-divergences.md`'s
Tally/Locker (#872) table still says the leave/archive/simplification/export/
import/access commits are "drawn against the ask, with the commit inert". Locker's
`export` handler exists and the phone now issues it, so at least that clause is
stale on the phone; whether the web leg is still inert belongs to whoever owns
that row.
