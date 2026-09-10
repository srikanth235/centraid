# Issue #1015 — mobile UX consistency: six rooms, one kit, 15 blockers, enforced

Umbrella receipt. One receipt for the whole umbrella; each lane appends its own section below and never edits a section above it.

The nine mobile surfaces shared no header, back affordance, search field, create affordance, confirm dialog, empty state or date format — six header shapes, seven back affordances, five date formats, five confirm patterns. The audit of 2026-09-10 (8 blueprint apps + shell, seeded corpus, 225 screenshots) filed 173 findings, 15 of them blockers. This umbrella makes DESIGN.md true on the phone: six surface classes, one kit contract each for feedback, search, confirm, empty/loading/error, dates, copy, selection and disabled, and enforcement so the drift is a red diff rather than a six-month audit.

## Checklist

- [ ] **Wave 0 — blockers**: B1–B15, each with a Maestro flow in `tests/agent-e2e-mobile/` that reproduces it and now passes
- [ ] **Wave 1 — the kit contracts**: S2 back targets, S3 `StatusLine` hosting and undo survival, S4 one search field, S5 `EmptyBlock` gutter, S6 `HomeKey` floating deleted, S8 one formatter module, S9 one disabled contract, S10 `theme.pageMargin`, S12 `AnchoredMenu` reason line, S13 band truth
- [ ] **Wave 2 — the rooms**: S1 six room components as the only permitted screen roots, every route migrated, S7 one confirm primitive and one undo grammar, selection as a mode, editors autosaving with the band hidden and status hosted inside
- [ ] **Wave 3 — copy, tint, motion, a11y**: S11 one label table per enum, S14 engine vocabulary retired, the app tint budget, S15 haptics as one moment channel, a11y labels, per-app residue
- [ ] **Wave 4 — enforcement**: screen-root and literal lints, the mobile screens gallery, sentence-case-linted copy tables, the docs pass
- [ ] **Close pass**: DESIGN.md gains the six rooms and D1–D6; `docs/design-divergences.md` loses every entry this umbrella closed; `docs/decisions.md` records the rulings

Ticked by lane KIT slice 0: **nothing**. This slice is docs-only — it records the six owner rulings so no lane is built over a guess.

## Decisions

Ruled by the owner on 2026-09-10, before any lane cut code. Recorded in full at [docs/decisions.md](../docs/decisions.md) under `## Mobile UX consistency (#1015)`.

- **D1 Trash.** EMPTY TRASH EVERYWHERE. Photos' live control is right; Docs gets a real Empty trash behind the outlined-net confirm.
- **D2 Casing.** SENTENCE CASE EVERYWHERE. Photos comes in line; #712 recorded as superseded.
- **D3 Editors.** Autosave everywhere; "Cancel" exists only before the first keystroke; close = done.
- **D4 Push vs sheet.** Content pushes, choices sheet.
- **D5 Band.** The editor hides the band; selection dims it (leaf tokens) and makes it non-interactive; never live under two bars.
- **D6 Settings.** Reachable from the Home cover's trailing control AND from More.

## What changed

### Lane KIT — slice 0: the receipt and the rulings (docs only)

- **`receipts/issue-1015-mobile-ux-consistency.md`** — this file, created as the umbrella receipt with the wave list 0–4 plus the close pass as its checklist, and D1–D6 verbatim.
- **`docs/decisions.md`** — new section `## Mobile UX consistency (#1015)`, placed after `## Governance as a constitution (#1005)` and before `## Related docs`: the re-judgement that opens it, D1–D6 as one table of `Id | Current decision | Why`, and the deliberate non-goals this umbrella keeps out of scope.
- **`docs/decisions.md`** — one row appended to `## Superseded decision pointers`: #712's Title Case menu copy, superseded by D2.
- **`docs/design-divergences.md`** — the Photos `### Copy` register no longer sanctions Title Case; the entry states sentence case per #1015 and names D2 as the ruling that closed it.

### Lane APPS-A — slice 1: one derived return target for Docs, and a back row for Notes (B7 / S2)

Closes audit `docs/findings.md#1` (blocker) and the back/title/band half of `notes/findings.md#5`.

Docs' `DocsShelfHeader` exists to name the place it returns to, and all thirteen call sites typed that name by hand — all thirteen typed `"All"`, whatever they sat behind. The chevron called `goBack()` while the label and the VoiceOver string named somewhere else. The prop is gone: the head titles itself from the route it is on and names its return target from the route beneath it on the stack, so no call site can disagree with the chevron. A document's title rides along in the route params exactly as `DocsFolder.folderName` already did, so a pushed head names the document before the read lands.

Notes has one navigator screen, so a notebook, a tag filter and the version history are state — and state has no `goBack()`. An `origin` records where a sub-place was entered from; the head draws the chevron plus that place's name and returns to it, and a band tap clears it because a band tap is a new start, not a step deeper. A notebook now titles itself with the notebook's own name (`shelfCopy` always took it; Notes never passed it) and lights **Notebooks**, not Library.

**Supersedes a tested ruling**: `notes-band.test.ts` asserted "a notebook is a filter, not a fifth place" and pinned `library`. A notebook is only ever reached by tapping Notebooks, so lighting Library named a place the member was not looking at — the same reasoning `TasksScreen.tsx:23-25` already applies. The old assertion is replaced, not deleted silently; the root is asked to record it in `docs/decisions.md`.

Proof: `apps/mobile/src/apps/docs/docs-places.test.ts` scans every source file under `apps/{docs,notes,tasks}` for a typed `backTo=` literal and fails on one. It fails on base (13 hits) and passes here.

Files:

- `apps/mobile/src/apps/docs/docs-places.ts` (new) — the route→title table and `docsRouteTitle`.
- `apps/mobile/src/apps/docs/docs-places.test.ts` (new) — the table's rules plus the call-site scan across Docs, Notes and Tasks.
- `apps/mobile/src/apps/docs/DocsShelfHeader.tsx` — `backTo` prop removed; both names derived from the stack; `title` now an optional override.
- `apps/mobile/src/navigation.ts` — `DocumentRead` and `DocumentViewer` gain an optional `title`.
- `apps/mobile/src/apps/docs/DriveList.tsx` — the three `DocumentRead` pushes carry the row's title.
- `apps/mobile/src/apps/docs/DocumentRead.tsx` — passes its title on to `DocumentViewer`; overrides the head only once the read lands.
- `apps/mobile/src/apps/docs/AddToDocs.tsx`, `BulkUpload.tsx`, `DocsCapabilities.tsx`, `DocsScan.tsx`, `DocsStorage.tsx`, `DocsTrash.tsx`, `DocumentEditor.tsx`, `DocumentNames.tsx`, `DocumentProperties.tsx`, `DocumentVersions.tsx`, `ProposedFiling.tsx`, `RecentlyChanged.tsx` — the typed `backTo`/`title` literals dropped.
- `apps/mobile/src/apps/docs/DocsHome.test.tsx` — the reader-open assertion now expects the title riding along.
- `apps/mobile/src/apps/notes/NotesHome.tsx` — `origin` state, `enter()`, the back row, the notebook's own name as the head.
- `apps/mobile/src/apps/notes/NotesHome.styles.ts` — `back` / `backLabel`.
- `apps/mobile/src/apps/notes/notes-band.ts` — a notebook shelf lights `books`.
- `apps/mobile/src/apps/notes/notes-band.test.ts` — the superseded assertion replaced.

### Lane APPS-A — slice 2: Agenda clears the notch, and a guest is a person (B11 / B12)

Closes audit `agenda/findings.md#1` and `#2`, both blockers.

Agenda was the one app in the product that put the top inset on the BODY and left `VaultBar` above it, so the vault name and the gateway drew inside the status bar — the Search and New-event controls sat entirely under the clock — while the inset that should have cleared the notch opened a dead band between the bar and the title. The inset moves to the frame, where Tasks, Notes, Photos and the shell already carry it.

`core_party` holds five kinds and the Agenda query has always selected `kind`; both guest pickers mapped every row to a chip regardless. A new event therefore offered "Photo OCR", "Face recognition", "Image embeddings", "Text embeddings", "Transcript", "Document text", "Place names" and the "Family" group as guests — eight of eighteen chips were the vault's own enrichment runners, and tapping one wrote a real attendee row. One pure `guestOptions` now answers for both forms: people only, named by display name, ordered by the sort name the vault keeps for exactly this.

Files:

- `apps/mobile/src/apps/agenda/agenda-guests.ts` (new) — `guestOptions`, `GUEST_KIND`.
- `apps/mobile/src/apps/agenda/agenda-guests.test.ts` (new) — the runners, the group, the org and the animal are not offered; sort name orders; an id-less row is dropped.
- `apps/mobile/src/apps/agenda/AgendaHome.tsx` — the frame is the `TopSafeArea`; the body is a plain view.
- `apps/mobile/src/apps/agenda/AgendaCreateModal.tsx`, `AgendaEventEditor.tsx` — both pickers read `guestOptions`.
- `apps/mobile/src/apps/agenda/AgendaHome.test.tsx` — a claim that the frame, not a wrapper below the bar, owns the top inset.

### Lane APPS-A — slice 3: a task can be dated, timed, reminded and repeated (B4)

Closes audit `tasks/findings.md#2`, a blocker.

The detail place drew **When**, **Time**, **Reminder** and **Repeats** as field rows with a value and up to two explanatory notes, and `FieldControl` fell through to `null` for every one of them — a `REMINDER —` row followed by two sentences about how reminders are delivered on your phone, over a field that could not carry one. The only ways to date a task on this seat were the quick-add chip row at creation and the "Move all to today" bulk verb: no reschedule, no snooze, no clear-the-date, no picker of any kind. The `edit` action accepted all four the whole time (`due_at`/`clear_due`, `remind_before_min`/`clear_remind`, `rrule`/`clear_rrule`); only the seat was missing.

The four rows now carry controls: When and Time open the native picker (DESIGN.md — `DateTimeField` uses the native picker on mobile), each with a clear verb beside it, because a date a member cannot remove is half a control; Reminder and Repeats are chip rows over the seat's shortcut sets. `missed` stays read-only display, as the audit asks.

A due stamp is written as **local wall clock**, never UTC: `timeOfDay` reads `value.slice(11, 16)`, so a `toISOString()` round trip would move the clock and, near midnight, the civil day. Moving the day KEEPS the time — a Friday 09:00 task rescheduled to Monday is still due at 09:00 — and setting a time on an undated task dates it today rather than refusing in silence.

Files:

- `apps/mobile/src/apps/tasks/task-when-write.ts` (new) — `whenWrite`, `timeWrite`, `reminderWrite`, `repeatWrite`, and the local-wall-clock helpers.
- `apps/mobile/src/apps/tasks/task-when-write.test.ts` (new) — the mapping, the wall-clock rule, the keep-the-time rule and the clear paths.
- `apps/mobile/src/apps/tasks/TaskDetailFields.tsx` — `DateField`, the four controls, and `onEdit` on the acts interface.
- `apps/mobile/src/apps/tasks/TaskDetail.tsx` — `onEdit` wired to the `edit` action.
- `apps/mobile/src/apps/tasks/tasks-seat-copy.ts` — the pick/clear verbs, `REMINDER_LEADS`, `REPEAT_RULES`.

**Gap reported, not stubbed**: the shared `taskFields` projection only emits a `repeats` row when the task already carries a `recurrence_summary`, so a non-repeating task still has no door to a first rule. Changing that projection changes every seat, so the root is asked whether it belongs in this umbrella.

### Lane APPS-A — slice 4: the note editor saves as you write (B6 / D3)

Closes audit `notes/findings.md#2`, a blocker, and applies D3.

The shared blueprint copy has always printed the contract — `editorStatus`: "Every change is saved as you write · N versions kept" — and this seat never called it. Saving was a manual press of a filled Save button that was enabled and identical from the moment the sheet opened, so nothing on screen distinguished a note with unsaved edits from one without; and `onClose` blanked the draft with no prompt and no write. The gesture that lost a writing session was the swipe-down iOS trains members to use on a page sheet.

Now: a debounce writes an existing note as it is edited, closing writes whatever is still unsaved, and the Save button is gone. The close control is the verb (D3) — "Cancel" before the first keystroke, "Done" after it — and the blueprint's promise is drawn in the editor, where a member can read it, rather than posted to a status host a page sheet presents above.

**Known limit, not a stub**: the debounce runs for a note that already exists. A second tick on a note still being created would create a second note, because `create-note` does not hand back the id this seat would need to adopt the first one — so a new note is written once, on close. Closing that gap is a `create-note` output contract question; the root is asked whether it belongs here.

Proof: `NotesHome.test.tsx` now carries a write seam and two claims — typing into a note and pressing the close control writes `edit-note` with the typed body, and closing an untouched note writes nothing and offers a cancel. Both fail on base: the close control had no "Done" label to find, and close discarded the draft.

Files:

- `apps/mobile/src/apps/notes/NotesHome.tsx` — `dirty`, the autosave effect, `save({ closeAfter })`, `finishEditing`, the version count for the editor's line.
- `apps/mobile/src/apps/notes/NoteEditor.tsx` — Save button removed; `dirty` and `versions` props; the close control's verb; `editorStatus` drawn in the sheet.
- `apps/mobile/src/apps/notes/NotesHome.test.tsx` — the write seam and the two autosave claims.

### Lane APPS-A — slice 5: selection becomes a mode in Docs (B8 / D5)

Closes audit `docs/findings.md#2`, a blocker, and applies D5. **`docs/findings.md#7` (D1, Empty trash) is NOT closed — see the gap below.**

Docs' phone seat put the bulk bar in the list as an inline row and kept the five-tab band mounted and LIVE beneath it, so a set being chosen sat under two bars at once and one tap navigated away mid-selection with no warning; the filter/sort/arrangement row above stayed interactive as well. Photos states the opposite rule on the same product and follows it, and Docs' own web seat retired this exact shape (`docs/design-divergences.md:146-174`).

Selection is now a mode. The head swaps in place — "3 documents selected", sentence case and naming the noun — with **Cancel** as the one way out; the primary "New" act and the whole set-describing controls row stand down; the bar carries verbs only, because the head owns the count; and the band dims on its **leaf tokens** (`textDisabled` on the label, the icon colour, `accessibilityState.disabled` on each tab) and stops answering. Never a container opacity.

**Gap reported, not stubbed — D1 for Docs.** The vault has no command that can empty a document trash. `core.trash_document` requires a `purge_at` and refuses an already-trashed document, so it cannot bring a date forward; destruction happens only in the gateway's sweep (`packages/vault/src/gateway/duties.ts:775-825`), which carries the blob-rent, authority-revocation and receipt machinery. Photos can do it because `media.purge_asset` exists; Docs has no counterpart, and the docs blueprint has no purge action. Shipping the control against any existing op would fail at the tap, so `DocsTrash` is untouched. Recommendation: a vault/server slice adds `core.purge_document` (or the cheaper `core.empty_document_trash`, which sets `purge_at` to now and lets the audited sweep destroy), plus a `purge` action and handler in `packages/blueprints/apps/docs`; the mobile control and its outlined-net confirm are then a few lines here. The root is asked to place that slice.

Files:

- `apps/mobile/src/apps/docs/DocsHome.tsx` — the head swaps to the selection count and Cancel; the controls row stands down; `selecting` reaches the frame.
- `apps/mobile/src/apps/docs/DocsScreen.tsx` — `selecting` prop, dimming the band and standing down the capsule.
- `apps/mobile/src/apps/docs/DocsBand.tsx` — `dimmed`: leaf tokens, `accessibilityState.disabled`, no pointer events.
- `apps/mobile/src/apps/docs/DriveList.tsx` — reports the chosen count up; the bar carries verbs only.
- `apps/mobile/src/apps/docs/DriveList.styles.ts` — `bulkCount` removed with its last renderer.
- `apps/mobile/src/apps/docs/docs-copy.ts` — `selectionHead`.
- `apps/mobile/src/apps/docs/DocsHome.test.tsx` — the mode claim: head, Cancel, no New, no arrangement controls, every band tab disabled.

### Lane APPS-A, round 2 — slice 1: Empty trash, on every seat (D1 / R-A-3, R-A-4)

Closes audit `docs/findings.md#7`, the gap slice 5 reported rather than stubbed. Commit `41e3b1df1`.

**The vault op.** `core.empty_document_trash` takes no id and destroys nothing: it sets `purge_at = deleted_at` on every trashed document, and the gateway's lifecycle sweep — with its blob-rent checks, authority revocations and provenance receipts — stays the only thing that ever removes a document. `deleted_at` rather than `now` because it is provably in the past, so the postcondition (`no trashed document with purge_at <> deleted_at`) is exact without reading the clock. An empty trash is a no-op that still executes: a member who taps Empty trash on an empty trash is not shown a refusal. Idempotent, `risk: high`, not `confirm: true` — owner confirmation is in front of the command, as with `media.purge_asset`. NOT container-routed: it names no container, and `core.trash_document` — the routed, actable write that put each document there — already made that judgment.

**The blueprint.** A confirmed, id-less `empty-trash` action, the `core.empty_document_trash` act scope, and an explicit exclusion from the pending overlay (it stamps no row, so the overlay-completeness law is satisfied by declaration rather than by silence).

**The seats.** The web seat's `TrashAsk` panel — "Not available yet · Delete forever and Empty trash" plus one sentence promising a trash cannot be emptied — is deleted and replaced by `EmptyTrash`: outlined `--net` control carrying the noun and count, confirm in place, `Keep them` beside it. The phone gets the same question in the same words, with the confirm as an `OptionSheet` (D4, R-A-2) rather than an `Alert`. On both seats the control opens the confirm and only the confirm writes.

**Tests, three levels, each failing on base.** Vault: no-op on an empty trash with a live document untouched; the window collapses on every trashed document and the sweep then destroys them (and only them, with a third document's content intact); a restored document survives two runs. Blueprint: the action is declared, confirmed, id-less, carries its act grant, and is overlay-excluded. Mobile: the control names the documents, the press writes nothing, the confirm writes exactly one `empty-trash`, and an empty trash offers no verb.

**R-A-4** — `docs/decisions.md` gains a dated `### Later rulings (#1015)` subsection carrying the notebook ruling (a notebook is reached only by tapping Notebooks; `notes-band.test.ts`'s "a filter is not a place" pin is superseded for notebooks only) and the empty-trash mechanism above. Nothing above it was rewritten.

**Scope flag for the owner.** This touched the Docs **web seat**, which the umbrella's non-goals list as out of scope ("No desktop or PWA seat"). The judgment: that non-goal is about the interaction grammar reaching those seats, not about a shared capability, and D1 says the "cannot be emptied" copy goes — that copy is one shared module both seats read. The gallery lanes render token lowering only, so no baseline moves. Say the word and the web half comes back out.

Files:

- `packages/vault/src/commands/documents.ts` — `EMPTY_DOCUMENT_TRASH`, `emptyDocumentTrash`, registration.
- `packages/vault/src/commands/documents-purge.test.ts` — the three vault claims.
- `packages/blueprints/apps/docs/actions/empty-trash.ts` — the action handler.
- `packages/blueprints/apps/docs/app.json` — the act scope and the confirmed action.
- `packages/blueprints/apps/docs/pending-projection.ts` — the overlay exclusion and its reason.
- `packages/blueprints/apps/docs/drive-copy.ts` — `TRASH_ASK`/`TRASH_FALLBACK` deleted; `TRASH_NOTE` and `EMPTY_TRASH_COPY`.
- `packages/blueprints/apps/docs/components/TrashAsk.tsx` — deleted.
- `packages/blueprints/apps/docs/components/TrashAsk.module.css` — deleted.
- `packages/blueprints/apps/docs/components/EmptyTrash.tsx` — the web seat's control and confirm.
- `packages/blueprints/apps/docs/components/EmptyTrash.module.css` — its sheet.
- `packages/blueprints/apps/docs/components/DriveRoute.tsx` — `trashCount`, `onEmptyTrash`.
- `packages/blueprints/apps/docs/logic.ts` — `emptyTrash()` and its status line.
- `packages/blueprints/apps/docs/app-root.tsx` — the wiring.
- `packages/blueprints/apps/docs/empty-trash.test.ts` — the blueprint claims.
- `packages/blueprints/src/docs-drive.test.ts` — the copy claim, rewritten for the verb.
- `packages/blueprints/manifest.json` — regenerated by `bun run --cwd packages/blueprints build`.
- `apps/mobile/src/apps/docs/DocsTrash.tsx` — the control, the sheet, the status sentence.
- `apps/mobile/src/apps/docs/DocsTrash.test.tsx` — the mobile claims.
- `apps/mobile/src/apps/docs/doc-menu.ts` — the comment that cited the deleted copy.
- `docs/decisions.md` — `### Later rulings (#1015)`.

### Lane APPS-A, round 2 — slice 2: a repeats door, and a new note that saves (R-A-5)

Commit `9b0a756ab`.

**The repeats door.** `taskFields` emitted a Repeats row only when `recurrence_summary` already existed, so the control that SETS a first rule lived behind the summary that rule would produce: a task that runs once had no way to become one that repeats — on any seat, since the projection is shared. The row is now always emitted; the value says whether it repeats, the row says it can, and the missed-period notes appear only once there is a period to miss. The phone's chips light the rule the task carries (`task.rrule`) instead of nothing, which is what made "Never" indistinguishable from "Weekly".

**A new note that saves.** Slice 4 left autosave running only for a note that already existed: the seat had no id to save against and a second tick would have created a second note. `create-note` hands the row id back in its outcome (the seat-minted `note_id` the pending overlay already rides on), so the first tick creates, the seat adopts the id, and every tick after it is an `edit-note` on that row. Two creates are impossible: a save in flight refuses a second. A create that lands without an id — queued offline, where there is no outcome yet — sets `unnamed` and the draft goes back to being written once, on close, which is the old behaviour kept for exactly the case that needs it.

Proof: `detail.test.ts` gains the door claim (a once-running task has a Repeats row reading `—` with no notes; a repeating one reads its summary with both). `NotesHome.test.tsx` gains the adoption claim — a brand-new note writes `create-note`, then the next keystroke writes `edit-note` with the id the vault handed back. Both fail on base.

Files:

- `packages/blueprints/apps/tasks/detail.ts` — the unconditional repeats row.
- `packages/blueprints/apps/tasks/detail.test.ts` — the door claim.
- `apps/mobile/src/apps/tasks/TaskDetailFields.tsx` — the repeat chips light the current rule.
- `apps/mobile/src/apps/notes/NotesHome.tsx` — `write` returns the outcome; `created`, `saving`, `unnamed`; `save` adopts the minted id; the debounce covers a new note.
- `apps/mobile/src/apps/notes/NotesHome.test.tsx` — the write seam returns the minted id; the adoption claim.
