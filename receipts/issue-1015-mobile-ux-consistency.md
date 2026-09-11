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
### Lane KIT — slice 1: S3, one status line hosted per presentation, and undo that survives the next write

Answers audit **B3** (`tasks/findings.md#1`) and **B5**. Two halves of invariant 5 the phone was missing: a note has to be visible, and a door back has to still be there when the member reaches for it.

- **`apps/mobile/src/kit/components/status-host.ts`** — new. The host stack: `ROOT_STATUS_HOST`, `claimStatusHost` (returns an idempotent release that removes by identity, because presentations do not unmount in the order they mounted), `activeStatusHost`, `subscribeStatusHost`, `resetStatusHosts`. Module-scoped and imperative, like the channel itself. **One channel still** — this says only WHERE the line paints.
- **`apps/mobile/src/kit/components/status-host.test.ts`** — new. Root until a claim; newest claim wins; release by identity under an out-of-order dismiss; a second release is a no-op; subscribers fire on claim and release.
- **`apps/mobile/src/kit/components/StatusLine.tsx`** — takes an optional `hostId` (default the root) and renders only when it is the active host, so two mounted hosts never paint the same note twice and the root goes quiet under a modal.
- **`apps/mobile/src/kit/components/StatusLineHost.tsx`** — new. What a `Modal`-presented editor or sheet mounts inside its own tree: claims a host in an effect, renders `StatusLine` bound to it, drops the claim on unmount.
- **`apps/mobile/src/kit/components/StatusLine.test.tsx`** — new. Quiet with no note; root paints when unclaimed; root goes quiet under a claim; the presentation's own host paints; the root takes the line back on close.
- **`apps/mobile/src/kit/replica/write-outcome.ts`** — a queued or in-flight outcome is **suppressed while the line carries an action**, rather than queued behind it: DESIGN.md gives one line with at most one inline action, so deferring would need a second slot, and the queued fact is still readable in Pending changes while a painted-over undo is unrecoverable. A parked or failed outcome still posts — those are the answer to the write, not news about its transport. The reasoning is a comment at the branch.
- **`apps/mobile/src/kit/replica/write-outcome.test.ts`** — the mock gains `readStatus`; new cases pin the suppression for queued and in-flight, that news still posts on a quiet or action-free line, and that a refusal and a failure still post over a live action. The first two **fail on base** and pass here.
- **`apps/mobile/src/apps/tasks/TasksHome.tsx`** — check-off posts `Task done` + `Undo` **before** issuing the write, so the ordering the suppression relies on is stated rather than raced against admission. This is B3's fix.

### Lane KIT — slice 2: S5 the empty block's gutter, S6 the floating home key, S12 a refusal that says why

Answers audit **S5** (`docs/findings.md#3`), **B14** and **S12** (`photos/findings.md#5`, `docs/findings.md#14`).

- **`apps/mobile/src/kit/components/EmptyBlock.styles.ts`** — `block` takes `paddingHorizontal: theme.pageMargin`. Both registers get the same gutter; the difference between them is rung and measure, never margin.
- **`apps/mobile/src/kit/components/EmptyBlock.test.tsx`** — a new `describe` pins the gutter on both registers. **Fails on base.**
- **`apps/mobile/src/kit/components/HomeKey.tsx`** — the `floating` variant is **deleted**, with it the `variant` prop, the `FLOAT_SIZE` plate, the absolute wrap and the safe-area read. One placement remains: the leading control in the page's own head row. The file header says why.
- **`apps/mobile/src/screens/data/Data.tsx`**, **`apps/mobile/src/screens/data/Data.styles.ts`** — the key moves into the head row beside `PlaceHeader` (`head` becomes a row with a `headBar` that takes the rest), and `BOTTOM_ROOM` drops from 96 to 64: it was reserving room for a plate that no longer floats.
- **`apps/mobile/src/screens/devices/Devices.tsx`**, **`apps/mobile/src/screens/devices/Devices.styles.ts`** — the same move; `HOME_KEY_CLEARANCE` (54 + 8, invented per screen) is deleted and the dock takes one rhythm step.
- **`apps/mobile/src/kit/components/FeatureOffPlace.tsx`**, **`apps/mobile/src/screens/SystemOnPhone.tsx`**, **`apps/mobile/src/screens/Approvals.tsx`**, **`apps/mobile/src/screens/SignalNotification.tsx`**, **`apps/mobile/src/screens/connectors/Connectors.tsx`**, **`apps/mobile/src/apps/insights/Insights.tsx`**, **`apps/mobile/src/apps/insights/GatewayAlerts.tsx`**, **`apps/mobile/src/apps/automations/Automations.tsx`**, **`apps/mobile/src/apps/automations/AutomationThread.tsx`** — `variant="leave"` dropped; the prop is gone, not renamed.
- **`apps/mobile/src/kit/components/AnchoredMenu.tsx`** — `MenuActionRow` gains `reason`, rendered as a second **wrapping** line under the label inside a new `lines` column; `flex: 1` moves from `label` to that column so trailing glyphs stay put. `rowSpeech()` reads verb, then answer, then reason.
- **`apps/mobile/src/kit/components/AnchoredMenu.test.tsx`** — a case pins the two lines and the spoken label. **Fails on base.**
- **`apps/mobile/src/kit/replica/row-provenance.ts`** — `refusedLabel` is **deleted** (v0, no compat shim): a refusal is a row's own line, not a string concatenated into a one-line truncating label.
- **`apps/mobile/src/kit/replica/row-provenance.test.ts`** — the concatenation case becomes a source check that Docs hands the sentence over as a `reason`.
- **`apps/mobile/src/apps/docs/doc-menu.ts`**, **`apps/mobile/src/apps/docs/doc-menu.test.ts`** — the only `refusedLabel` caller. `refuse()` now spreads `{ reason }`, so a writable row carries no key at all; the submenu parent stops carrying a refusal and each Move target carries its own, which is what the code comment there already claimed.
- **`apps/mobile/src/kit/components/StatusLine.tsx`** — its header no longer cites the floating key as one of the three bottom-edge occupants.
- **`apps/mobile/src/apps/people/people-writes.test.tsx`**, **`apps/mobile/src/apps/tally/PendingRestartJourney.test.tsx`** — their `status-line` mocks gain `readStatus`, which slice 1 made part of the module's surface.

### Lane KIT — slice 3: S4, one search field

Answers audit **S4**. Eight hand-rolled fields across nine surfaces: five placements, three keyboard contracts, four ways of saying how many matched, and one with no way to clear the term.

- **`apps/mobile/src/kit/components/SearchField.tsx`** — new. Controlled `value`/`onChangeText`; Locker's keyboard contract (`autoCapitalize="none"`, `autoCorrect={false}`, `returnKeyType="search"`), which is the only one that was fully right — a capitalised or auto-corrected term searches for something the member did not type. A clear control that appears only when there is something to clear, an optional `count` line in the caller's own words, `onSubmit` for search-on-return (omitted means search-as-you-type), and a spoken label that defaults to the placeholder. The props are documented in the file header, including what this is NOT: the no-match state stays an `EmptyBlock` in the routine register, rendered by the list.
- **`apps/mobile/src/kit/components/SearchField.styles.ts`** — new. The gutter is the field's own, at `theme.pageMargin`; a 44×44 clear control.
- **`apps/mobile/src/kit/components/SearchField.test.tsx`** — new. The keyboard contract (from source — the host stub drops unmapped props, so a DOM assertion would pass whatever the field set), the spoken label and its override, no clear control while the term is empty, clearing through `onChangeText` plus `onClear`, the count line present and absent.

**Not done, deliberately**: no app call site is migrated. Adoption is each app lane's, per R-KIT-1.

### Lane KIT — slice 4: S8 one formatter module, S9 the disabled contract, S10 the kit's own margins

Answers audit **§3.13**, **S9** and **S10** (the kit's half).

- **`apps/mobile/src/kit/format.ts`** — new. `formatRelative(value, now)` **delegates** to `dueLabel` in `@centraid/blueprints/apps/tasks/when` rather than re-implementing it, so the register is literally Tasks' and the web seat reads the same module; it adds Docs' sub-hour past grain (`moments ago`, `12 minutes ago`, `3 hours ago`), which is the only information the day grain does not carry. `formatDateShort` prints the year only when it is not the current one. `formatBytes` re-exports `@centraid/design`'s. An unreadable stamp returns `""` — an absent clause, never an invented one. The file header records why the register is Tasks' and that a caller owns its own preposition.
- **`apps/mobile/src/kit/format.test.ts`** — new. The day register case by case, the sub-hour and hour grains, the future-today case, the year rule, the byte register, and every unreadable-input path.
- **`apps/mobile/src/lib/insights.ts`** — `formatBytes` now re-exports the kit module's, so the seat has one byte register with one owner.
- **`apps/mobile/src/kit/components/Button.tsx`** — the disabled contract written down at the component that defines it, and the responder half fixed: the control now passes `disabled` to `Pressable` as well as reporting `accessibilityState.disabled`; `onPress={undefined}` alone still let the press ripple through.
- **`apps/mobile/src/kit/components/Tappable.tsx`** — the same contract stated for the bare target, where the caller owns the leaf and therefore owns putting `textDisabled` on it.
- **`apps/mobile/src/kit/components/StatusLine.tsx`**, **`OutOfRoom.tsx`**, **`SelectChip.tsx`**, **`apps/mobile/src/kit/replica/ReplicaStateCard.tsx`**, **`ReplicaStatusBar.tsx`** — the kit's eight `paddingHorizontal` literals (14, 9, 20, 16, 8) become `spacing` steps. App sites are the app lanes'.
- **`apps/mobile/src/kit/replica/ReplicaStateCard.test.tsx`**, **`ReplicaStatusBar.test.tsx`** — their theme mocks gain `spacing`.

**Not done, and why**: **S13** (band truth) is not in this commit. Its two halves contradict each other as written — D5 says the editor HIDES the band, while S13 says `hideBand` must never drop the Home capsule, and the only way to keep a capsule with no band is a docked plate on the bottom edge, which is exactly the affordance S6 deleted three commits ago. The band is also per-app (`DocsScreen`, `TallyScreen`, `LockerTrashScreen` each render their own), so there is no kit half to change without inventing a component no caller asks for yet. Raised to the root as a question.

## Verification

Per lane, appended as each lane finishes; the umbrella's own run is the root's at close.

### Lane KIT

| Check | Result |
| --- | --- |
| `bunx vitest run src/kit` (apps/mobile) | 64 files, 488 passed |
| `bunx vitest run src/apps/tasks src/screens/data src/screens/devices` | 7 files, 73 passed |
| `bunx vitest run src` (whole seat) | 282 files, 2365 passed; **1 file failed to load**: `src/lib/replica/expo-seat-driver.test.ts`, which fails identically on the base head with the lane stashed — inherited, not measured as ours |
| `bun run --cwd apps/mobile typecheck` | exit 0 |
| `node scripts/lint-mobile-design.mjs` · `lint-container-opacity.mjs` · `lint-aria-labels.mjs` | all ok; `apps/mobile/src` still at container-opacity budget 0 |
| `bun run format` then `bun run check:push:static` | 4/4 gates passed (format:check, lint, turbo:lint, typecheck:affected) |
| `node .governance/law/run.mjs --brief-digest 514cb2fed327` | law green apart from `receipt-per-issue` (this section and the audit below) and `registry-completeness` (the changelog line added with them) |
| Red-first proof | The `write-outcome` suppression cases, the `EmptyBlock` gutter case and the `AnchoredMenu` reason case fail on base and pass here |

The two runs the rest hang off, as they printed:

```
$ bunx vitest run src            # from apps/mobile
 Test Files  1 failed | 282 passed (283)
      Tests  2365 passed (2365)
# the one failed file is src/lib/replica/expo-seat-driver.test.ts, which
# fails identically on the base head with this lane stashed.

$ bun run check:push:static
✓ 4/4 gates passed in 45.4s — slowest: typecheck:affected 45.4s,
  format:check 13.4s, lint 13.2s, turbo:lint 1.6s
# exit 0
```

## Audit

Per lane. The umbrella's fresh-context attestation is the root's at close.

### Lane KIT

| Check | Verdict | Notes |
| --- | --- | --- |
| What changed faithfully describes the diff | PASS | Each of the four lane sections above names every file it touched by full path, and the diff contains nothing else. |
| Each claim is realized in the diff | PASS | `variant="floating"` and `refusedLabel` are gone from `apps/mobile/src`; `SearchField.tsx`, `status-host.ts` and `format.ts` exist with tests; `EmptyBlock.styles.ts` insets at `pageMargin`. |
| Nothing outside the lane's slice was changed to go green | PASS | The only files touched outside `kit/` are the call sites a deleted prop or a deleted export forced (`HomeKey`'s nine callers, Docs' menu, two test mocks) and the two shell places S6 names. No lint config, budget, baseline or ledger was edited. |
| Unfinished work is stated, not implied | PASS | S13 is recorded as not done, with the contradiction between D5, S13 and S6 that stops it, and raised to the root. |

Verdict: PASS / PASS / PASS / PASS.
### Lane APPS-B — Photos, Tally, Shell, People, Locker (B1, B2, B9, B10, B13, B15, D2, D6, S2)

Five commits, one per seam: `bd3c77c51` Photos · `be8287400` Tally · `4157c829c` Shell · `f4232e487` People · `dc2c7d268` Locker.

**B9 · the album stated the opposite of the truth** (photos/findings #1). `apps/mobile/src/apps/photos/AlbumDetail.tsx` printed the constant `"Excluded from Free up vault"` under the Keep-originals switch — a live-status shape that was false whenever the switch was off, which is its default on every album in the seed set. New pure module `apps/mobile/src/apps/photos/album-keep-originals.ts` derives it from `keepOriginals`, and claims neither state before the pin store has hydrated. Test: `apps/mobile/src/apps/photos/album-keep-originals.test.ts`.

**B10 · four of five viewer controls disabled at full opacity** (photos/findings #2). The enabled/reason table moved out of the component into `apps/mobile/src/apps/photos/viewer-toolbar-states.ts`, where the contract is assertable without a renderer: no control enabled without being able to run, none disabled without a reason. `apps/mobile/src/apps/photos/PhotoLightboxToolbar.tsx` reads it; `apps/mobile/src/apps/photos/PhotoLightbox.tsx`'s pager circles now take `--on-stage-soft` like every other refused control on the stage instead of the page-ramp `textDisabled` the chrome's own comment says vanishes there. Test: `apps/mobile/src/apps/photos/viewer-toolbar-states.test.ts`.

**D2 · Photos' second casing system** (photos/findings #8; #712 superseded). `photos-library-menu.ts`, `viewer-menu.ts`, `photos-collections-menu.ts` and the selection bar (extracted to `apps/mobile/src/apps/photos/photos-selection-copy.ts`) came into sentence case; `packages/blueprints/apps/photos/enrichment-consent.ts` ships one English (`Prioritize faces`, like `favorite`). The sweep test `apps/mobile/src/apps/photos/photos-copy-case.test.ts` walks every Photos copy table and fails on a mid-label capital that names nothing.

**S2 · pushed screens with no way back.** New `apps/mobile/src/apps/photos/PhotosBackControl.tsx`, drawn by `PhotosPeopleView.tsx`, `PlacesView.tsx` and `PhotoStateView.tsx` (Trash, Archive, Favorites, videos, person) — the seven screens whose only exit was a band tab lit on `More`, a destination none of them is reached from. `PlacesMap.tsx`'s chevron now names Places, where it actually returns. In People, `BackRow` (`apps/mobile/src/apps/people/PeopleKit.tsx`) grows a title rung with `accessibilityRole="header"`, and Trash, the person editor, Merge and Log a touch name themselves from the new `ROUTE_TITLES` in `packages/blueprints/apps/people/people-copy.ts`.

**people/findings #7 · the unguarded channel `✕`.** `apps/mobile/src/apps/people/PersonView.tsx` destroyed a phone number on one tap from a target beside the row's own open-the-person target. It goes through `PeopleConfirm` now, like Trash and Merge — `CONFIRMS.removeChannel` — and wears the word `Remove` rather than the glyph the search field uses to clear its text. Judgement: the register sanctions the absence of a FAKE undo (there is no reverse write), not the absence of both guards.

**B2 · Tally could not record an expense** (tally/findings #1). `navigate("TallyAdd")` had three call sites, none reachable on a populated vault without a group. `apps/mobile/src/kit/components/AppHeader.tsx` grows one optional trailing verb — quiet, never filled — and `apps/mobile/src/apps/tally/TallyScreen.tsx` draws it from `onAddExpense`, passed by the four band destinations in `TallyHome.tsx` and by nothing behind the denied gate. Label is `ADD_COMMIT`, so bar and composer cannot drift. Tests in `apps/mobile/src/apps/tally/TallyHome.test.tsx`.

**B13 · three contradictory backup claims** (shell/findings #1). Root cause found: `apps/mobile/src/screens/home/origin-health.ts` summed `local-only + missing` itself, while Backup health reads `custodyDurability`, the #996 R7 ruling under which `local-only` IS backed up and only `missing` is not — so the same `8` meant opposite things on two screens. Home now reads that one arithmetic, and its verified line comes from `backupVerdict` rather than a second reading of the same rollup. `apps/mobile/src/screens/BackupHealth.tsx`'s header names its subject: the last upload from THIS PHONE is a different claim from whether the vault holds the bytes, and a bare "Never" read as a third verdict contradicting the hero below it. Tests: `apps/mobile/src/screens/home/origin-health.test.ts` (three, including one asserting Home's count equals `custodyDurability(...).notBackedUp.count`).

**B15 + D6 · Settings unreachable, Starred pinnable** (shell/findings #3). `apps/mobile/src/screens/home/HomeTitleRow.tsx` carries Settings as the cover's one trailing control (`TEST_IDS.home.settings`), and it stays in More. Starred is deleted from `apps/mobile/src/screens/home/places.ts` and `apps/mobile/src/screens/Home.tsx`: `pin: false` did not stop a member pinning it, because every place without `law` is offered in the pin sheet, and v0 drops a tab onto nothing rather than dimming it. PLACES is ten rows now. Tests: `apps/mobile/src/screens/home/HomeTitleRow.test.tsx`, `places.test.ts`.

**B1 · Locker could never unlock** (locker/findings #1). Verified from source: `storeLockerVaultKey` (`apps/mobile/src/apps/locker/locker-device-auth.ts`) has no non-test caller in the repo — nothing in pairing, onboarding or Locker writes `K` to this keychain — so the wall's one primary refused every press, and its "yet" was the whole of the lie. The key plane that would hand `K` over is #996 wave 6, unbuilt and out of this lane's scope (R-B-3), so the door is made honest instead: `locker-door.ts` refuses with `DEVICE_NOT_ENROLLED_BODY`, `locker-store.ts` carries `notEnrolled`, and `LockerWall.tsx` states the absence as its heading and offers neither the unlock nor the Forget verb — there is no key on this phone to drop. Tests in `apps/mobile/src/apps/locker/LockerWall.test.tsx`. **Owner item: Locker is unusable on the phone until #996 W6 lands.**

Also changed: `apps/mobile/src/kit/test-ids.ts` (`home.settings`), `apps/mobile/src/apps/photos/{PhotosCollectionsView,PhotosPeopleView,PlacesMap,PlacesView,people-model,photos-collections-menu,photos-library-menu,viewer-menu}.test.*`, `packages/blueprints/apps/photos/{components/People.test.tsx,enrichment-consent.test.ts,queries/enrichment-status.ts}`, `docs/photos/dogfood.md`.

Verification, from the lane worktree: `bunx vitest run src/apps/photos src/apps/people src/apps/locker src/apps/tally src/screens` → 124 files, 1237 tests, green. `bun run --cwd apps/mobile typecheck` → 0. `node scripts/lint-mobile-design.mjs && node scripts/lint-container-opacity.mjs && node scripts/lint-aria-labels.mjs` → 0. `bun run format` then `bun run check:push:static` → 4/4 gates green. `node .governance/law/run.mjs --brief-digest 514cb2fed327` → clean except the umbrella-owned `receipt-per-issue` (`## Verification` / `## Audit`) and `registry-completeness` (CHANGELOG entry), both the close pass's.

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
## Lane APPS-B, round 2 — adopting the round-1 kit in Photos, People, Locker, Tally and the shell

**S4 · eight hand-rolled search fields, five of them here.** `apps/mobile/src/kit/components/SearchField.tsx` replaces the raw fields in `apps/mobile/src/apps/locker/LockerSearchView.tsx`, `apps/mobile/src/apps/people/PeopleHome.tsx`, `apps/mobile/src/apps/photos/PhotosSearch.tsx`, `apps/mobile/src/screens/home/AllAppsSheet.tsx` and `apps/mobile/src/screens/home/SearchOverlay.tsx`. The keyboard contract was the finding: Photos' field carried no `autoCapitalize` and no `autoCorrect={false}`, so a term the member typed in lower case was searched for capitalised. Result semantics are each app's own and unchanged — Locker still searches on a verb, because the matching is server-side over fields the payload never returns, and Photos keeps its bottom-docked route (#712). Each caller now cancels its own gutter so the field's is the single inset; the five disagreed by up to 6pt, and `AllAppsSheet` was on a hand-typed 20 against the 18 page margin. Locker gained the no-match `EmptyBlock` it never had (`SEARCH_NO_MATCH`, `SEARCH_NO_MATCH_BODY` in `packages/blueprints/apps/locker/route-copy.ts`) — a search that matched nothing used to show an empty list under "0 matched" and never repeated that note bodies are excluded by design. Test: `apps/mobile/src/apps/search-field-adoption.sweep.test.ts`, a source sweep over which component each surface reaches for. `apps/mobile/src/screens/home/SearchOverlay.test.tsx` needed the `react-native-svg` stub the kit field's magnifier pulls in, and its opaque-paper check now asserts the anti-glass invariant directly (the paper is the first painted layer; every painted colour is alpha-free and drawn from the palette) rather than counting painted controls.

**S8 · two byte registers and a relative ladder typed out twice.** `formatBytes` in `apps/mobile/src/screens/home/tile-model.ts` said `2 KB` and `512 bytes` where `@centraid/design` said `2.0 KB` and `512 B`; it is deleted, and the tile composes a size clause over `apps/mobile/src/kit/format.ts`. That clause keeps `""` rather than the register's `—` for a document with no content row, because a dash reads as a size the vault knows to be nothing. `agoPhrase` was byte-identical in `apps/mobile/src/screens/approvals/approvals-model.ts` and `apps/mobile/src/screens/connectors/connectors-model.ts`, and both said `10 September` where the product says `10 Sep`; both delegate to `formatRelative` now, and `just now` becomes `moments ago`. Tally's date split (tally/findings #5) collapses at four sites — `ActivityView.tsx` and `TallyTrashScreen.tsx`'s "trashed …" take the relative register, `TallyExpenseScreen.tsx`'s eyebrow and "purges on …" take `formatDateShort`, the copy's own grammar picking which, since "purges on tomorrow" is not a sentence. `WaitingView.tsx` takes the vault clock as a prop instead of slicing a stamp. Tests: `tile-model.test.ts` (register moved; two new cases for the unknown-cell guard), `approvals-model.test.ts`, `WaitingView.test.tsx`.

**S9 · nothing to do, and that is the finding.** Every disabled control in these apps already carries the leaf-ink contract plus `accessibilityState.disabled` — `textDisabled`, or `onStageSoft` in `PhotoLightboxChrome.tsx` and `PhotoLightbox.tsx` where the chrome's own comment records that page-ramp disabled ink vanishes on the stage. `lint-container-opacity` holds `apps/mobile/src` at budget 0; the ten remaining `opacity: 0.x` sites are all press feedback.

**S10 · 33 `paddingHorizontal` literals** across `apps/mobile/src/apps/photos/{PhotoGrainView,PhotosHome.styles,PhotosMoreSheet,PhotosScreen,ScrubRail,TimelineGrainControl,places-pin}` and `apps/mobile/src/screens/home/{AllAppsSheet,FirstMoves,HomeBand,LauncherGrid,SearchOverlay,TileBody,VaultsSwitcher}` now read `pageMargin` or a `spacing` rung. Most were the scale spelled as numbers; the sweep also turned up sheet gutters on 20 against the 18 page margin, and a 28, a 14 and a 10 belonging to no rung, now 24, 16 and 12. Two sub-base values stay literal WITH a comment claiming the exception: the segmented plate's seam in `TimelineGrainControl.tsx` (paired with its own `gap: 2`) and proto:4019's chip padding in `PhotoTile.tsx`. `@centraid/design`'s `subBase` names exactly this case — "seams, not rhythm steps" — but is re-exported through neither `kit/theme` nor the design package's public entry. Three theme mocks gained the `spacing` their subject reads.

**S14 · the engine's sentence on the member's screen.** Six sites spliced a raw exception into member copy — `The new photograph was not saved: AbortError…`, `mint link ticket failed (503)`. Each keeps its noun, drops the tail and takes the shared `RETRY_ACTION`; the reason goes to the log rather than nowhere. New copy: `PHOTOS_ERROR_EDIT_NOT_SAVED`, `PHOTOS_ERROR_EXPORT_FAILED`, `PHOTOS_ERROR_FREE_UP_PAUSED`, `PHOTOS_ERROR_IN_CLOUD`, `PHOTOS_ERROR_WRITE_NOT_SAVED` in `packages/blueprints/apps/photos/shared-copy.ts`; `SHARING_LINK_NOT_MADE`, `SHARING_CHANGE_NOT_SAVED` in `packages/client/src/sharing-copy.ts`. Call sites: `apps/mobile/src/apps/photos/{PhotoEditor,PhotoLightbox,PhotosLibrary}.tsx`, `apps/mobile/src/apps/photos/viewer-export.ts`, `apps/mobile/src/screens/{Sharing,SharingLinkRow}.tsx`. Judgement: `LocationNotRemovableError` carries AUTHORED copy — a loud, specific refusal a member can act on — so it still speaks for itself, and the iCloud case is named rather than folded into the generic noun because it is a cause the member can do something about. `kit/replica/PendingChangesSheet.tsx` is lane KIT's and was not touched.

Verification, from the lane worktree: `bunx vitest run src/apps/photos src/apps/people src/apps/locker src/apps/tally src/screens` → 124 files, 1236 tests, green. `bun run --cwd apps/mobile typecheck` → 0. `node scripts/lint-mobile-design.mjs && node scripts/lint-container-opacity.mjs && node scripts/lint-aria-labels.mjs` → 0. `bun run format` then `bun run check:push:static` → 4/4 gates green. `node .governance/law/run.mjs --brief-digest 514cb2fed327` → `commit-message-format` red on TWO merge subjects inherited from the umbrella (`7e07b614`, `d1e59f87`), identical on the clean base head and not this lane's to rewrite; the round's five commits conform.

## What changed — round 2

### Lane KIT — round 2, slice 1: S1 the six rooms

Answers **Wave 2 / S1** and the Decision table in #1015.

- **`apps/mobile/src/kit/rooms/README.md`** — new. The six rooms, their anatomies from the issue's Decision table, what a room decides that a screen may not, and why `OptionSheet` is not the sheet room.
- **`apps/mobile/src/kit/rooms/place.ts`** — new. `PlaceRef` carries a `unique symbol` brand, so `backTo` cannot be written down: it is minted by `place()` from a route entry and read with `parentPlace()` / `currentPlace()` over the stack. Audit **B7** was thirteen Docs screens hardcoding `backTo="All"`, twelve of them wrong in the label and the VoiceOver word together.
- **`apps/mobile/src/kit/rooms/room-contracts.ts`** — new, framework-free. `RoomAction`, `RoomLoading`, `RoomError`, `RoomEmpty`, `RoomSelection`, `BandState`, plus `bandStateFor()` and `selectedSentence()`.
- **`apps/mobile/src/kit/rooms/RoomBody.tsx`** — new. One state order for every room: error, loading, empty, content. An empty state drawn over a failed read tells a member their vault is empty when it is only unreachable.
- **`apps/mobile/src/kit/rooms/SelectionBars.tsx`** — new. Selection as a mode per **D5**: the header swaps in place to "N selected · Cancel", the verbs sit in one foot row, a destructive verb is outlined `--net`.
- **`apps/mobile/src/kit/rooms/HomeRoom.tsx`**, **`AppPlace.tsx`**, **`PushedPage.tsx`**, **`EditorRoom.tsx`**, **`SheetRoom.tsx`**, **`SystemPlace.tsx`** — new: the six rooms. The band is the app's, so a room takes it as a render prop and hands it `BandState`; `EditorRoom` takes no band prop at all and hosts `StatusLineHost` inside itself (**R-KIT-2**, audit **B5**), as does `SheetRoom`.
- **`apps/mobile/src/kit/rooms/rooms.styles.ts`** — new. Every room gutter is `pageMargin`; colourless, ink resolves at the call site.
- **`apps/mobile/src/kit/rooms/index.ts`** — new. The six rooms and the place/contract helpers.
- **`apps/mobile/src/kit/rooms/rooms.test.tsx`** — new, 18 cases: the state order, the parent-not-a-literal rule, the no-parent case, the selection swap and the band standing down, search hidden under a selection, Done-versus-Cancel, the editor taking no band, and the grid plate landing in the header.

### Lane KIT — round 2, slice 2: S7 the one confirm

- **`apps/mobile/src/kit/components/ConfirmSheet.tsx`** — new. `confirmTitle()` puts the noun and the count in the question ("Delete 3 documents?"), the destructive verb is outlined `--net` and never the view's filled commit, and `useConfirmDestructive()` makes asking as cheap as the `Alert.alert` it replaces — which is the only reason the alert won in 21 files. Undo stays the other half: `showUndoStatus` in `kit/components/status-line.ts` is already the one undo grammar (audited this round, unchanged), and a reversible write takes it *instead of* a confirm, never both.
- **`apps/mobile/src/kit/components/ConfirmSheet.test.tsx`** — new, 4 cases.

Call sites are NOT migrated: the 21 `Alert.alert` files live under `apps/mobile/src/apps` and `src/screens`, which the app lanes own this round.

### Lane KIT — round 2, slice 3: Wave 4 enforcement, written and unwired

- **`scripts/lint-mobile-rooms.mjs`** — new, five rules: `screen-root`, `back-literal`, `page-margin`, `identity-tint`, `copy-title-case`. Report-only by default (exit 0); `--enforce` and `--max <n>` are what Wave 4 turns on. Not added to `package.json`, `check:push` or CI. A silent no-op is a failure: zero screen files scanned exits 1.
- **`scripts/lint-mobile-rooms.test.mjs`** — new, 7 cases, run with `node --test`; it holds the READER against the real tree, because a dead walker would make every rule vacuous.

**The Wave 3 baseline, as it printed on this head** (558 files under `apps/mobile/src/{apps,screens}`):

```
  screen-root      180
  back-literal      47
  page-margin      135
  identity-tint      0
  copy-title-case    0
report-only lint-mobile-rooms — 362 finding(s) over 558 file(s)
```

`identity-tint` at 0 is a real zero. `copy-title-case` at 0 is a SCOPE limit, not a clean bill: the rule reads `*copy*.ts` tables as the brief specifies, and the mobile copy tables are already sentence case — Photos' Title Case (D2) lives in menu option tables inside `.tsx`, which this rule does not read. Raised to the root.

### Lane KIT — round 2 verification

| Check | Result |
| --- | --- |
| `bunx vitest run src/kit` (apps/mobile) | 66 files, 510 passed |
| `bun run --cwd apps/mobile typecheck` | exit 0 |
| `node scripts/lint-mobile-rooms.mjs` | exit 0, counts above |
| `node --test scripts/lint-mobile-rooms.test.mjs` | 7 pass, 0 fail |
| `node scripts/lint-mobile-design.mjs` · `lint-container-opacity.mjs` · `lint-aria-labels.mjs` | all ok; `apps/mobile/src` still at container-opacity budget 0 |
| `bun run format` then `bun run check:push:static` | 4/4 gates passed in 27.5s |
| `bun run knip` | clean of this lane: `kit/rooms/index.ts` is reached through the test that imports the barrel, and no room export is unused. The two unused exports it still lists (`verifyModelAssets`, `hasDisplayRung`) are on the base head with this lane stashed |
| `node .governance/law/run.mjs --brief-digest 514cb2fed327` | 10 rules, no findings. The blocker recorded while this round was in progress — `commit-message-format` on the umbrella's own merge commit `7e07b614` — was cleared by the root re-wording it to `Merge …` (`794a5dd34`); every commit in this round passed the pre-commit hook unforced. |

### Lane KIT — round 2 audit

| Check | Verdict | Notes |
| --- | --- | --- |
| What changed faithfully describes the diff | PASS | Every file above is named by full path; the diff contains nothing else. |
| Each claim is realized in the diff | PASS | `kit/rooms/` exports six rooms with a test that mounts each; `ConfirmSheet.tsx` exists with a test; `scripts/lint-mobile-rooms.mjs` runs and prints the baseline. |
| Nothing outside the lane's slice was changed to go green | PASS | Nothing under `apps/mobile/src/apps` or `src/screens` was touched; no lint config, budget, baseline or ledger was edited. |
| Unfinished work is stated, not implied | PASS | Screen migration (Wave 2), the 21 `Alert.alert` call sites, and the `copy-title-case` scope limit are all recorded above. |

Verdict: PASS / PASS / PASS / PASS.

### Lane KIT — round 2 decisions

| Id | Ruling | Reason |
| --- | --- | --- |
| **R-KIT-3** | `ConfirmSheet` is built on `SheetRoom`, not on `OptionSheet`. Accepted. | `OptionSheet`'s iOS path is `ActionSheetIOS`, a platform surface that can draw neither an outlined `--net` verb (DESIGN.md: a destructive verb is outlined, never filled) nor host a `StatusLine`. A confirm that cannot show its own undo afterwards is not the confirm this issue asks for. `OptionSheet` keeps the choice-list job (**D4**); the confirm is a room. |
| **R-KIT-4** | Widening `copy-title-case` to read menu option tables in `.tsx` is Wave 3 copy-lane work, not this lane's. | The rule as briefed reads `*copy*.ts` tables and prints a true 0 over them. Photos' Title Case (**D2**) lives in `.tsx` option tables, so the 0 is a scope limit, not a clean bill — recorded above rather than papered over. Widening the reader is a change to the finding set the copy lane burns down, so it belongs with that lane, not ahead of it. |
| **R-KIT-5** | **S13 is closed** by `PlaceRef` + `BandState`. | S13 asked that band `current` be computed and never literal. `PlaceRef` carries a `unique symbol` brand minted only by `place()`, so `backTo`/`current` cannot be written as a string at all — the rule is a type error, not a lint. `bandStateFor()` derives the band's state from the room, and `EditorRoom` takes no band prop (**R-KIT-2**, **D5**). `scripts/lint-mobile-rooms.mjs`'s `back-literal` rule (47 findings) measures the un-migrated screens for Wave 3; the kit contract itself is closed. |

## Wave 2 — lane APPS-A (Agenda, Tasks, Notes, Docs), the rooms migration

Branch `lane/1015-apps-a`, from umbrella `3e5299b60`. Four apps into the six
rooms, plus the five Agenda findings this lane owns.

### What landed, commit by commit

| Commit | What |
| --- | --- |
| `28b74d3bc` | `AppPlace`/`PushedPage` take `chrome`: the vault lockup is true on every route of an app, and the rooms replace the frames that drew it. A node, not an import — a room reaching for `VaultBar` would pull the launcher catalog into `kit/`. |
| `fb643dbb3` | `EditorRoom` gains `presented`/`visible` (an editor that is state, not a route, presents its own page sheet and hosts the status line inside it) and `foot` (the acts of the thing being edited, in one row). |
| `d942b4d0a` | `AppPlace`/`PushedPage` take `overlay`: a confirm sheet and a presented editor cannot live in `RoomBody`, whose empty state replaces the children. |
| `7174eb0d6` | **Notes** into the rooms; `RoomAction`/`PlaceVerb` gain `testID` and `EditorRoom` a `leaveTestID`, so `notes-capture` and `notes-editor-close` survive the move. **Closes B5.** |
| `02626edd5` | **Tasks** into the rooms; both `Alert.alert` exits become `useConfirmDestructive`. |
| `ec0d2ea2b` | `kit/format.ts` gains `formatTime`, `formatDateTime`, `formatMonth`. |
| `68e49028a` | `AppPlace`/`PushedPage` take `toolbar` — the controls that pick WHICH content the body shows, above the body and outside its state machine. |
| `140e26f10` | **Agenda** into the rooms, closing agenda findings **#3 #4 #5 #6 #7** (and **#8** with the room). |
| `8c34fea45` | `AppPlace` gains `secondary`; `bandStateFor` treats the selection OBJECT as the mode rather than `count > 0`. |
| `ead84b32a` | **Docs** — nineteen surfaces into the rooms, `DriveList`'s bulk bar into the room's selection (**closes B8 for Docs**), Empty trash onto `SheetRoom`. |

### Files changed

Added: `apps/mobile/src/apps/agenda/AgendaDayRow.tsx`,
`apps/mobile/src/apps/agenda/agenda-day-model.ts`,
`apps/mobile/src/apps/docs/docs-room.tsx`,
`apps/mobile/src/apps/docs/drive-selection.ts`.

Deleted: `apps/mobile/src/apps/docs/BulkVerb.tsx`,
`apps/mobile/src/apps/docs/DocsScreen.tsx`,
`apps/mobile/src/apps/docs/DocsShelfHeader.tsx`,
`apps/mobile/src/apps/notes/NotesScreen.tsx`,
`apps/mobile/src/apps/tasks/TasksPlaceHeader.tsx`,
`apps/mobile/src/apps/tasks/TasksScreen.tsx`. Every caller is gone: `grep -rn
"DocsScreen\b\|DocsShelfHeader\|BulkVerb\|NotesScreen\|TasksScreen\b\|TasksPlaceHeader"
apps/mobile/src` returns only the route-props type aliases `DocsScreenProps`,
`NotesScreenProps` and `TasksScreenProps` in `navigation.ts`, which are
navigation types and not the frames.

Modified: `apps/mobile/src/apps/agenda/AgendaBand.tsx`,
`AgendaCreateModal.tsx`, `AgendaEvent.tsx`, `AgendaEventEditor.tsx`,
`AgendaHome.styles.ts`, `AgendaHome.test.tsx`, `AgendaHome.tsx`;
`apps/mobile/src/apps/docs/AddToDocs.tsx`, `BulkUpload.tsx`,
`DocsCapabilities.test.tsx`, `DocsCapabilities.tsx`, `DocsDueView.tsx`,
`DocsFoldersView.tsx`, `DocsHome.test.tsx`, `DocsHome.tsx`,
`DocsMoreSheet.tsx`, `DocsScan.tsx`, `DocsSearchView.tsx`, `DocsStorage.tsx`,
`DocsTrash.test.tsx`, `DocsTrash.tsx`, `DocumentEditor.tsx`,
`DocumentNames.tsx`, `DocumentProperties.tsx`, `DocumentRead.tsx`,
`DocumentVersions.tsx`, `DocumentViewer.tsx`, `DriveList.styles.ts`,
`DriveList.tsx`, `FolderView.tsx`, `INTEGRATION-NOTES.md`,
`ProposedFiling.tsx`, `RecentlyChanged.tsx`, `docs-places.test.ts`,
`docs-places.ts`, `document-read-model.test.ts`, `document-read-model.ts`;
`apps/mobile/src/apps/notes/NoteEditor.tsx`, `NotesHistory.test.tsx`,
`NotesHistory.tsx`, `NotesHome.styles.ts`, `NotesHome.test.tsx`,
`NotesHome.tsx`, `NotesPowerbox.tsx`, `notes-band.test.ts`;
`apps/mobile/src/apps/tasks/TaskDetail.tsx`, `TasksHome.styles.ts`,
`TasksHome.test.tsx`, `TasksHome.tsx`, `TasksProject.tsx`, `TasksSearch.tsx`;
`apps/mobile/src/kit/components/PlaceHeader.tsx`, `apps/mobile/src/kit/format.test.ts`,
`apps/mobile/src/kit/format.ts`, `apps/mobile/src/kit/rooms/AppPlace.tsx`,
`apps/mobile/src/kit/rooms/EditorRoom.tsx`, `apps/mobile/src/kit/rooms/PushedPage.tsx`,
`apps/mobile/src/kit/rooms/README.md`, `apps/mobile/src/kit/rooms/room-contracts.ts`,
`apps/mobile/src/kit/rooms/rooms.test.tsx`, `apps/mobile/src/navigation.ts`;
`tests/agent-e2e-mobile/flows/agenda-week.md`,
`tests/agent-e2e-mobile/flows/agenda-week.mjs`.

### Red-first proofs

| Claim | Test | Fails on base because |
| --- | --- | --- |
| **B5** — a note posted from inside an editor is visible | `NotesHome.test.tsx` → "paints a note posted from inside the editor, in the editor" | On base the editor is a bare `Modal` with no `StatusLineHost`; `postStatus` paints on the root host, under the presentation. |
| Agenda **#3** — a day other than today is reachable | `AgendaHome.test.tsx` → "reaches another day, and only then offers the way back to today" | On base there is no "Next day" control at all, and "Go to today" is drawn unconditionally over an anchor nothing can move. |
| A failed read never reads as an empty shelf | `NotesHome.test.tsx` → "draws a failed read as the room's error, never as an empty shelf" | On base `ReplicaStateCard` and the list's empty slot render together. |
| Selection is a mode | `DocsHome.test.tsx` → "makes selection a MODE" (updated to the room's contract) | The room now owns the header swap, the count sentence and the foot row. |

### Exit list

| Check | Result |
| --- | --- |
| `bunx vitest run src/apps/{agenda,tasks,notes,docs} src/kit/rooms src/kit/format.test.ts src/kit/components` | 56 files, **390 pass**, 0 fail |
| `bunx vitest run src/apps` (whole app tree) | **1261 pass**, 0 fail |
| `bun run --cwd apps/mobile typecheck` | **0** |
| `node scripts/lint-mobile-rooms.mjs` | `screen-root 152` · `back-literal 32` · `page-margin 16` · `identity-tint 0` · `copy-title-case 0` (from `181 / 47 / 107` at the lane's start). For THIS lane's four trees: `back-literal 0`, `page-margin 0`, `screen-root 28` — see the residue note below. |
| `grep -rn "Alert.alert" apps/mobile/src/apps/{agenda,tasks,notes,docs}` | **0** |
| `node scripts/lint-mobile-design.mjs` · `lint-container-opacity.mjs` · `lint-aria-labels.mjs` | all ok; `apps/mobile/src` still at container-opacity budget **0** |
| `bun run format` then `bun run check:push:static` | **4/4 gates passed** in 105.7s |
| `node .governance/law/run.mjs --brief-digest 514cb2fed327` | 10 rules, **no findings** |

### The `screen-root 28` residue, stated rather than papered over

Every SCREEN in these four trees is now rooted in a room. The 28 remaining
`screen-root` findings are all COMPONENTS, which the rule cannot tell apart
from screens because it matches text rather than a render tree (its own header
says so). They are: rows (`DocRow`, `TaskRow`, `TasksRows`, `AgendaDayContext`),
bands (`AgendaBand`, `DocsBand`, `NotesBand`, `TasksBand`), panes embedded in a
room (`TasksProject`, `TasksProjects`, `TasksCatchUp`, `TasksReminders`,
`TasksSearch`, `TasksMoreSheet`, `TasksToolbar`, `TasksQuickAdd`,
`TasksDenied`, `TaskDetail`, `TaskDetailFields`, `NotesHistory`,
`DocsDueView`, `DocsFoldersView`, `DocsSearchView`, `DocsSharedView`,
`DocsStarredView`, `DriveList`, `OfflinePinButton`) and one sheet
(`DocsMoreSheet`). Making any of them a room would be false. **This is a
question for the owner, not a claim that the count is fine:** the rule needs a
screen/component distinction (a route-registration census, or a `*.screen.tsx`
convention) before Wave 4 can enforce it at zero.

### Outside `apps/mobile`, and why

  - `apps/mobile/src/navigation.ts` — `AgendaHome` gains a `destination`
    param, the same longhand `DocsHome` and `PhotosHome` already carry. The
    band on the pushed event page (agenda finding #8) has to pop back to the
    place it names; without the param it could only pop to whichever place the
    list was last left on.
  - `tests/agent-e2e-mobile/flows/agenda-week.{mjs,md}` — the flow pressed
    "Save this event". Under **D3** the composer has no Save: the room's leave
    key reads "Cancel" while the draft is untitled and "Done" once it has a
    title, which is how agenda finding #6 (the dead always-armed Save) closes.
    The flow presses "Done"; `node scripts/lint-e2e-flows.mjs` is ok.

### Lane APPS-A — Wave 2 decisions

| Id | Ruling | Reason |
| --- | --- | --- |
| **R-A-6** | Docs' Empty trash is a hand-spelled `SheetRoom`, not `useConfirmDestructive`. | The hook's title is `confirmTitle(verb, noun, count)`, which cannot produce the shared table's `Delete 3 documents forever?` — "forever" belongs in the question for the one irreversible act in Docs, and `EMPTY_TRASH_COPY` is the web seat's words too. The sheet keeps every rule the hook enforces: the noun and the count in the title, the verb outlined `--net`, the status line hosted inside. |
| **R-A-7** | The selection MODE is the object, not the count. | `bandStateFor` read `count > 0`, so the moment between "Select" and the first pick had a live band, a header still naming the shelf, and no way out — with the primary act already stood down. A screen that is not choosing passes no selection at all. |
| **R-A-8** | `DocumentViewer` is a `PushedPage` that passes no `band`, and its own dark bar is gone. | Deviation 2 said the stage drops the band; it now says so by omitting a prop rather than by an opt-out on a frame that no longer exists. The head and the way out are the room's, so the stage stops being the one Docs surface with a bespoke close control. **Worth the owner's eye:** the media area keeps `colors.stage`, but the header above it is now the room's ink. |
| **R-A-9** | Agenda's event editor refuses an inverted range on the status line rather than disabling the leave key. | D3 says close is done; a leave key that refuses to close would be the dead control finding #6 is about, moved. Moving the start carries the end, the field says so inline, and the refusal paints inside the editor because the room hosts the line. |

### Lane SHELL — the sub-base seams, the search field's focus, and the test handle (R-B-6, R-B-7)

Changed:

- `packages/design/src/index.ts` — `subBase` joins the `./density` export block. It was defined and used inside the package (`contract.ts`, `css.ts`, `blueprint.ts`) but never published, which is why two call sites could only eyeball a `2` and leave a comment saying so.
- `apps/mobile/src/kit/theme/native.ts` · `apps/mobile/src/kit/theme/index.ts` — `subBase` re-exported through the mobile design boundary. It is deliberately NOT folded into `NativeTheme`: it is a named list of seams, not a rhythm scale, and a scale is what a call site would then reach for.
- `apps/mobile/src/kit/theme/native.test.ts` — pins the re-export equal to the canonical object (`gutter` 2, `hair` 1).
- `apps/mobile/src/apps/photos/TimelineGrainControl.tsx` · `apps/mobile/src/apps/photos/PhotoTile.tsx` — the two documented seams claim the name: `gap: subBase.gutter` and `paddingVertical: subBase.gutter`. One token each, plus the comment that pointed at the missing export.
- `apps/mobile/src/kit/components/SearchField.tsx` · `.test.tsx` — `autoFocus?: boolean` (default `false`) and `testID?: string` pass-throughs.
- `apps/mobile/src/screens/home/SearchOverlay.tsx` — `autoFocus` restored. The overlay IS the search: the member opened it in order to type.
- `apps/mobile/src/test/react-native-stub.tsx` — records `autoFocus` as `data-autofocus` rather than applying it; jsdom would take focus off the runner.

**`TEST_IDS.photos.searchField` is NOT deleted.** The brief's condition was "if no caller remains", and one does: `tests/agent-e2e-mobile/flows/photos-search.mjs` takes the query field by that handle twice, and `flows/photos-search.md` records why it is a handle and not the word "Search". `node scripts/lint-mobile-testids.mjs` fails on this head with two `unapplied-id` breaks — `photos-search-field` and `locker-gate-field` — both because the adopting screen dropped its `testID` when it moved onto the kit field. Deleting the entry would break the flow instead of fixing it, so the pass-through is added here and the two screens (both outside this lane's trees) must apply it. Raised to the root; the lint is red on the base head with this lane stashed, not caused by it.

### Lane SHELL — the kit-native places move into `SystemPlace` (Wave 2, S1)

Seven screens whose whole frame was already a hand-copy of one shape — safe area, a head row with `HomeKey` beside a `PlaceHeader`, a `ScrollView` with its own gutter, a docked `HealthLine`, and each with its own order for loading/error/empty. All of that is `SystemPlace` now; the screens supply content and copy.

Migrated (root is `<SystemPlace>`, gutter and states are the room's):

- `apps/mobile/src/screens/SystemOnPhone.tsx` — 49 lines to 27; its whole `StyleSheet` deleted.
- `apps/mobile/src/screens/SignalNotification.tsx` — 63 lines to 38; its whole `StyleSheet` deleted.
- `apps/mobile/src/screens/data/Data.tsx` (+ `data/Data.styles.ts`, trimmed to the record sheet's plate).
- `apps/mobile/src/screens/devices/Devices.tsx` (+ `devices/Devices.styles.ts`, trimmed to the dock and the rename dialog).
- `apps/mobile/src/screens/connectors/Connectors.tsx`.
- `apps/mobile/src/screens/Approvals.tsx` (+ `screens/approvals/view-types.ts`).
- `apps/mobile/src/apps/automations/Automations.tsx`.

Deleted, with the grep proving no caller remains (`grep -rn FeatureOffPlace apps/mobile/src` → 0):

- `apps/mobile/src/kit/components/FeatureOffPlace.tsx` · `FeatureOffPlace.styles.ts` — it drew a whole place frame of its own (a second header, a second leave key, a second gutter) to say one sentence. A closed feature gate is a room STATE, so it is now `featureOffEmpty(feature)` in `apps/mobile/src/kit/rooms/feature-off.ts`, a `RoomEmpty` the screen passes to its own `SystemPlace`. Same copy, from the same compatibility core.

Room props this wave added, each named by the screen that needed it (`apps/mobile/src/kit/rooms/`):

- `SystemPlace` — `onRefresh`/`refreshing` (Data, Connectors, Approvals, Automations all pulled to re-read), `bodyRef` (Automations scrolls itself to the suggestions section it just named), and `placeBody` in `rooms.styles.ts`: the ROOM owns the scrolling gutter now.
- `RoomLoading.note` — the reflow sentence four of these screens drew under their skeleton (`SKELETON_NOTE`). A skeleton cannot know a fraction, so it is prose.
- `RoomError.secondary` — the unpaired phone's "Open Settings" on Approvals; quiet, never a second filled verb.
- `RoomError.detail` — ONE more sentence of the app's own when the general body cannot say which of two things went wrong ("This phone is not paired with a gateway yet."). Documented as never an exception string, which is the S14 rule it must not become a hole in.
- `RoomBody`'s error eyebrow was a hardcoded `"THIS PAGE COULD NOT LOAD"`. It is `ERROR_HEALTH` from `@centraid/client/surface-copy` now — the same word every other seat says, and sentence case like every other label (**D2**).

Two judgement calls, both visible in the diff:

- **Approvals keeps its EMPTY in the body, not on the room.** It is the QUEUE that is empty; the standing grants below it are still the record the page exists to show, and a room empty replaces the body wholesale. `RoomBody`'s fixed order is right for a page-level empty and wrong for a section's — `screens/approvals/view-types.ts` says so where `reviewGrants` is declared.
- **Automations is a `SystemPlace`, not an `AppPlace`.** The brief said `AppPlace`, but the screen draws `PlaceHeader` + `HomeKey` and no app mark, and `screens/home/places.ts` lists `autos` as one of the ten PLACES. A place spends no colour on itself (`kit/rooms/README.md`); giving it an app mark and an identity hue would be a new product claim, not a migration. Raised to the root.

Tests: `apps/mobile/src/screens/shell-rooms.test.ts` is new — it reads `scripts/lint-mobile-rooms.mjs`'s own rules (one definition of "a room", not a second copy) and asserts, per migrated file, that the root is a room and the gutter is the room's, plus tree-wide that no shell file writes `backTo`/`current` down as a string. `MIGRATED` only ever grows, so a screen cannot quietly fall back out of its room later. `scripts/lint-mobile-rooms.mjs` gained a real JSDoc shape for `lintTree`'s findings so the test typechecks against it.

### Lane SHELL — Activity and its alerts (Wave 2, S2)

- `apps/mobile/src/apps/insights/Insights.tsx` — root is `SystemPlace`. Loading and error are room states; the EMPTY stays in the body, because the window chips sit above it and a member must still be able to widen the window that found nothing. `AnalyticsBody` now returns `null` while the read is not ready — the narrowing the two deleted branches left behind, never a second error plate. Its private `ERROR_EYEBROW = "THIS PAGE COULD NOT LOAD"` is deleted; the room says `ERROR_HEALTH`.
- `apps/mobile/src/apps/insights/Insights.test.tsx` — the eyebrow assertion moves to `"This page could not load"`. This is the **D2** correction landing, not a test loosened to pass: the same string, sentence case, from the copy module every other seat reads.
- `apps/mobile/src/apps/insights/GatewayAlerts.tsx` — the biggest single reduction in this lane. It drew its own `TopSafeArea`, its own header row with a `display` title and a subtitle nothing else in the shell has, its own gutter, and three bare `Text` lines standing in for loading, error and empty. **Its error line was the exception**: `state.message` was `memberFacingError(error.message)` printed as the whole page. That is exactly S14. The `State` union no longer carries a `message` at all — `{ kind: "error" }` — so there is no longer anywhere for an exception to be stored, let alone shown; the room says one noun and one verb. Loading is a skeleton, empty is the routine block, and the subtitle is a `NoteBlock` in the body. Seven style keys deleted (`empty`, `header`, `headerCopy`, `list`, `safe`, `subtitle`, `title`).

`apps/mobile/src/screens/shell-rooms.test.ts` — both files added to `MIGRATED`.

### Lane SHELL — every system alert in the shell, replaced (Wave 2, S7/D4)

`grep -rn "Alert.alert" apps/mobile/src/screens apps/mobile/src/apps/{assistant,automations,insights}` → **0 call sites** (the seven remaining matches are the comments naming what was replaced). A new sweep test, `src/screens/shell-rooms.test.ts` → "asks with the kit confirm, never a system alert", holds it there over the whole tree, not just the seven files.

Five were destructive confirms and are `useConfirmDestructive` now — the noun in the title, an outlined `--net` verb, and a sheet that can host the status line the undo would post into:

- `apps/mobile/src/screens/devices/DeviceActions.tsx` — "Revoke this device?" / "Sign out this device?".
- `apps/mobile/src/screens/Settings.tsx` — "Unpair this device?".
- `apps/mobile/src/screens/home/VaultsSwitcher.tsx` — "Remove this vault from this phone?". The old title was "Remove from this phone?", which names no noun at all.
- `apps/mobile/src/screens/BackupHealth.tsx` — "Stop backing up this device?", keeping "Keep backing up" as the way out.
- `apps/mobile/src/screens/PhoneStorage.tsx` — "Free up the offline thumbnails?".

Two were a CHOICE, not a confirm, and are a `SheetRoom` (**D4**): `apps/mobile/src/apps/assistant/ConsentSheet.tsx` is new, and `Assistant.tsx` and `AssistantCompanionSheet.tsx` both mount it. It replaces two spellings of one question in two files. The ink verb is the ALLOW and the quiet way out declines, which the system alert could not express — it gave both buttons the same weight, so the consent ask read as a destructive confirm on one screen and as a neutral prompt on the other. Dismissing still declines: silence is not consent, and both `useEffect`s (the whole imperative-alert-in-an-effect pattern) are gone.

Kit: `ConfirmSheet` gained `cancelLabel`, passed through to `SheetRoom`, because "Keep backing up" is a truer word for staying than "Cancel" — and `SheetRoom`'s own default moved from a parameter default to a `??` so an explicit `undefined` still resolves.

Two test fixtures completed, neither loosened: `src/screens/home/VaultsSwitcher.test.tsx`'s partial `@centraid/design` and `kit/theme` mocks gained `borders`, `metrics`, `targetMin` and `radii.sm` — the switcher mounts the kit confirm now, so its tree genuinely reads them. No assertion changed.

Verification on this head: `bunx vitest run src` → 2469 passed, 295 files; the single failing file is the inherited `src/lib/replica/expo-seat-driver.test.ts` load failure, which fails identically on the base head. `bun run --cwd apps/mobile typecheck` → 0. `lint-mobile-rooms` → `screen-root 172` (from 181 at the start of this lane), `back-literal 47`, `page-margin 107`, `identity-tint 0`, `copy-title-case 0`.

### Lane SHELL — doctrine citation for the `subBase` export

`packages/design/src/index.ts` publishes `subBase` under [docs/decisions.md#typography-and-design-contracts](../docs/decisions.md#typography-and-design-contracts). It adds no value and changes no metric: `subBase` was already defined in `density.ts` beside `spacing`, already read by `contract.ts`, `css.ts` and `blueprint.ts`, and already the answer the contract gives for a seam below the 4px base. What was missing was the door — so the two mobile call sites that needed one could only write a bare `2` and leave a comment saying the right name existed and was unreachable. Publishing the existing name is what keeps the design contract enforceable at the call site rather than aspirational.

### Lane SHELL — the rest of the shell moves into its rooms (Wave 2, round 2)

Six commits, one surface family each. What was hand-drawn on every one of them, and is now the room's: the safe area, the head, the back or close affordance, the gutter, and the order of loading / error / empty.

**Settings → `SystemPlace`** (`15b8fea32`). `apps/mobile/src/screens/Settings.tsx` drew a cover with `useSafeAreaInsets`, an arrow labelled "Back to home", a `display`-serif title and a body gutter of `spacing[5]` under a header gutter of the same — two values that had to be kept equal by hand. All four are the room's. Settings stays reachable from Home's trailing control AND from More (**D6**); nothing about that door changed. Its three hand-typed insets (14, 12, 12) take tokens, and so do the two in `apps/mobile/src/screens/settings/VaultSection.tsx` and `apps/mobile/src/screens/settings/YouSection.tsx`.

The `screens/settings/**` files are SECTIONS, not pages — there is no sub-page under that directory to migrate. Per **R-SH-4** they stay leaves; only their gutters moved.

Two room props, both because Settings needed them and neither invented for symmetry:
- `overlay` on `SystemPlace` — the confirm sheet and the full-screen pairing camera. Nested in the scrolling body a `Modal` is still a modal, but its measurement is the scroller's, and the scanner is full-screen. It hangs outside `RoomBody` instead.
- `testID` on `SystemPlace` — `tests/agent-e2e-mobile/flows/sharing-reach.mjs` and `native-v0-resilience.mjs` both wait on `settings-screen`.

**Backup health, On this phone → `SystemPlace`** (`7f6d0f321`). `apps/mobile/src/screens/BackupHealth.tsx` and `apps/mobile/src/screens/PhoneStorage.tsx` each drew a chevron labelled **"Back to Settings"** — a string, and one that was right only because nothing else pushes them yet. `apps/mobile/src/screens/shell-places.ts` is new: `useShellParent()` reads the parent off the navigator (the same technique `DocsShelfHeader` already uses) and mints a `PlaceRef`, which no screen can write down. The title table is explicit and a route it does not know yields NO place, so the room draws no back control rather than one naming a guess. Backup health's `ReplicaStatusBar` docks in the room's `footer`, beside where `Data` and `Devices` put their health lines. Ten style keys deleted across the two files and `apps/mobile/src/screens/BackupHealth.styles.ts`.

**Sharing, Quick capture, Scan → `PushedPage`** (`cc2fa1a39`, **D4**). `apps/mobile/src/screens/Sharing.tsx` (a chevron and the bare word "Back"), `apps/mobile/src/screens/Capture.tsx` (a close X with a centre-aligned serif title) and `apps/mobile/src/screens/Scan.tsx`. `CloseHeader` is **deleted** from `apps/mobile/src/screens/scan-ui.tsx` — `grep -rn "CloseHeader" apps/mobile/src` → 0. Two titles come into sentence case with the word spelled out (**D2**): "People & circles" → "People and circles", "Scan & review" → "Scan and review". Sharing's header count line is dropped for the reason `PlaceHeader` states in its own file: the count it carried is the first section's own count, one screen inch below. `PushedPage` gains the same `overlay` and `testID` (`TEST_IDS.sharing.screen`). Gutters in `apps/mobile/src/screens/SharingLinkRow.tsx` and `apps/mobile/src/screens/scan-ui.tsx` take tokens.

**Home → `HomeRoom`** (`93254c1be`). `apps/mobile/src/screens/Home.tsx` was a `View` with an explicit `insets.top` and five pieces of chrome in file order. The room states that order — vault lockup, head, ONE status line, the grid, the band flush at the foot — and takes the sheets Home owns as `overlay`, so no `Modal` is nested in the scroller's content. `HomeStatusLine` is the room's `status` prop rather than a line the cover places for itself (**B5**). The alarm-blank branch returns an empty `HomeRoom`: it mounts no band, so `HOME_READY_MARKER` still never appears and the quarterly alarm still sounds.

**Deviation, stated:** `HomeTitleRow` is KEPT and passed as `HomeRoom.head`, not replaced by `HomeRoom.trailing`. It is a leaf (**R-SH-4**), it already carries the D6 door with `TEST_IDS.home.settings` and its own test, and it is named in `tests/inventory.json`. So `HomeRoom` gained `head` as the alternative to `trailing`, and draws never both.

**The cover's sheets and its search** (`556193035`). `apps/mobile/src/screens/home/AllAppsSheet.tsx` and `apps/mobile/src/screens/home/VaultsSwitcher.tsx` are `SheetRoom`s; five style keys and a grabber deleted from each, and the switcher's bespoke `Animated` slide/fade goes with them — one sheet motion for the seat. `apps/mobile/src/screens/home/SearchOverlay.tsx` is a `PushedPage`: it was never a choice, it was a page, so it pushes with the kit field (`search`, with `count` on the field) and ONE named verb. **Its scrim is gone**, and with it the `absoluteFill` a member could tap through onto whatever sat behind — `apps/mobile/src/screens/home/VaultChrome.tsx` raises the page in a `Modal` instead. `SheetRoom` gained a `maxHeight` ceiling so a browsing sheet's list bounds inside it, and `overlay` for the confirm the switcher raises over itself.

**The pending sheet, and the last exception string** (`1976109cb`). `apps/mobile/src/kit/replica/PendingChangesSheet.tsx` is a `SheetRoom`. And `pendingChangeExplanation` in `apps/mobile/src/kit/replica/pending-copy.ts` returned `change.reason` — the gateway's own words under a failed row, which is an exception string wearing a sentence's clothes. That is **S14** for the shell. The states the kit has words for keep them (parked names the steward, a conflict prints both versions, and the `offline-chain-journey` test still asserts the version numbers); everything else gets `PENDING_CHANGE_NOT_ACCEPTED` — one noun and "Try again". `RowsBlock.styles.ts`'s private `TITLE_SEAM = 1` becomes `subBase.hair` (**R-B-6**, the last of the two documented sub-base seams; [docs/decisions.md#typography-and-design-contracts](../docs/decisions.md#typography-and-design-contracts)).

**Test fixtures completed, none loosened.** Every mobile suite that now mounts a room reaches leaves it did not before, so six partial mocks gained the exports the tree genuinely reads (`metrics`, `pageMargin`, `density`, `nativeButtonStyle`, `react-native-svg`, `react-native-safe-area-context`) in `Sharing.test.tsx`, `Scan.test.tsx`, `Home.test.tsx`, `home/SearchOverlay.test.tsx`, `home/VaultsSwitcher.test.tsx`, `kit/replica/ReplicaStatusBar.test.tsx` and `Onboarding.test.tsx`. Two assertions changed, both because the claim under them changed: `SearchOverlay.test.tsx` loses "closes on a tap outside the field" (a page has no scrim — that is the fix, and the surviving Cancel test is the whole dismissal contract now), and `apps/mobile/src/apps/search-field-adoption.sweep.test.ts` accepts a surface that declares `search` on a room as reaching for the kit field, which is the same claim one level up.

Files changed, in full: `apps/mobile/src/kit/rooms/{HomeRoom,PushedPage,SheetRoom,SystemPlace}.tsx`, `apps/mobile/src/kit/rooms/rooms.styles.ts`, `apps/mobile/src/kit/rooms/rooms.test.tsx`, `apps/mobile/src/kit/components/RowsBlock.styles.ts`, `apps/mobile/src/kit/replica/{PendingChangesSheet.tsx,pending-copy.ts,ReplicaStatusBar.test.tsx}`, `apps/mobile/src/screens/{Settings,BackupHealth,PhoneStorage,Sharing,SharingLinkRow,Capture,Scan,Home}.tsx`, `apps/mobile/src/screens/{scan-ui.tsx,onboarding-styles.ts,BackupHealth.styles.ts}`, `apps/mobile/src/screens/shell-places.ts` (new), `apps/mobile/src/screens/shell-rooms.test.ts`, `apps/mobile/src/screens/settings/{VaultSection,YouSection}.tsx`, `apps/mobile/src/screens/home/{AllAppsSheet,VaultsSwitcher,SearchOverlay,VaultChrome}.tsx`, `apps/mobile/src/screens/home/{SearchOverlay,VaultsSwitcher}.test.tsx`, `apps/mobile/src/screens/{Home,Scan,Sharing}.test.tsx`, `apps/mobile/src/apps/assistant/Assistant.styles.ts`, `apps/mobile/src/apps/search-field-adoption.sweep.test.ts`. Deleted: `CloseHeader` (an export, not a file) from `scan-ui.tsx`.

**Verification on this head.** `bunx vitest run src` → 2470 passed over 295 files; the one failing file is the inherited `src/lib/replica/expo-seat-driver.test.ts` load failure, which fails identically on the base. `bun run --cwd apps/mobile typecheck` → 0. `bun run lint` → 0. `node scripts/lint-mobile-design.mjs`, `lint-container-opacity.mjs`, `lint-aria-labels.mjs` → ok. `grep -rn "Alert.alert"` over `screens/` and `apps/{assistant,automations,insights}` → **0 call sites** (six matches, all comments naming what was replaced). `node scripts/lint-mobile-rooms.mjs` → `screen-root 162` (from 172 at the start of this round, 181 at the start of the lane), `back-literal 47`, `page-margin 98`, `identity-tint 0`, `copy-title-case 0`. **For this lane's trees: `back-literal 0`, `page-margin 0`.** `screen-root` in these trees is 24, every one of them a LEAF component (`settings/*Section.tsx`, `home/{HomeBand,HomeStatusLine,HomeTitleRow,LauncherGrid,TileBody,VaultBar,VaultChrome,VaultHeader,FirstMoves}.tsx`, `data/RecordSheet.tsx`, `devices/DeviceActions.tsx`, `Onboarding.tsx`, `SharingLinkRow.tsx`) rather than a route component — **R-SH-4**: the rule is scoped to route components at Wave 4.

**Final numbers for the section above**, re-measured on the lane head after the last fixture completion: `bunx vitest run src` → **2471 passed over 295 files**, one failing file (`src/lib/replica/expo-seat-driver.test.ts`, inherited, fails identically on the base). `SKIP_CHECK_PR=1 bun run check:push:static` → **4/4 gates passed** (format:check, lint, turbo:lint, typecheck:affected). `node .governance/law/run.mjs --brief-digest 514cb2fed327` → **10 rules, no findings**.
## Wave 2 — lane APPS-B: Tally, Locker, People, Photos into the rooms

Four apps, five commits, one shape. Each app kept a **frame** component — `TallyScreen`, `LockerScreen`, `PeopleScreen`, `PhotosScreen` — that every one of its routes wrapped itself in, and each frame hand-rolled the header, the back affordance, the safe-area inset and (in Photos) a second bottom bar. All four are now `AppPlace` on a band destination and `PushedPage` over one, so a route supplies content and copy and nothing else.

**The prop that could lie is gone.** Thirty-two surfaces across the four apps wrote down which band tab they sat under — `current="more"`, `current="activity"`, `current="people"` — a fact no screen is in a position to know. It is derived now, per app, from the route the surface already declares (`tally-places.ts`, `locker-places.ts`, `people-places.ts`, `photos-places.ts`), together with the `PlaceRef` the back key speaks. `back-literal` over the four trees: **32 → 0**.

Where those tables put a member back:

- A receipt descends from its **expense**, not from the Activity tab the expense sits under.
- A Locker or Tally surface opened through **More** descends from the app, because the More sheet is the frame's — "Back to Tally" is the one answer that is never a guess.
- A People surface that is ABOUT one person descends from **that person**, minted as a place from their name; everything else from the roster.
- A Photos place detail descends from the **Places shelf** and a duplicate review from **Duplicates**. Seven pushed Photos surfaces used to light `More` — a destination none of them was reached from — and then draw their own chevron to say so.

**Selection is a mode (D5, audit B8).** `PhotosScreen` used to REPLACE the band with a second bar, which left the Home capsule live under a foot bar on every surface that kept one. The room swaps the header in place to "N photographs selected · Cancel", and `PhotosBand` and `BandCapsule` take the state the room hands them: dim through `textDisabled` on the leaf, deaf through `disabled`. Never a container opacity. Pinned by a sabotage test that presses Home mid-selection and asserts no navigation.

**Confirms and choices.** Fourteen `Alert.alert` calls in Photos: nine confirms are `useConfirmDestructive`, and five pickers are a `SheetRoom` (`PhotosChoiceSheet`, D4). Locker's two hand-rolled confirm panels and People's `PeopleConfirm` are the same primitive. `Alert.alert` over the four trees: **21 → 0** (of the 21 the audit counted repo-wide, these four apps held 14 plus Locker's inline panels). Album pickers show the WHOLE list now; the six Album detail and the timeline sliced to were the alert's row cap, never a product rule.

**Deletions, with the grep that proves no caller remains.** `apps/mobile/src/apps/photos/PhotosBackControl.tsx` (added in round 1; `PushedPage` subsumes it) and `BackRow` in `apps/mobile/src/apps/people/PeopleKit.tsx`. Its `[law:people-pushed-title]` suite is retired in place with a note pointing at `kit/rooms/rooms.test.tsx`, which pins the same law on the room. `grep -rn "PhotosBackControl\|BackRow" apps/mobile/src/apps` → the two frames' own comments only.

**Kit, three additive props, each named for the screen that needed it.** `AppPlaceProps.lockup` and `PushedPageProps.lockup` (all four apps draw `VaultBar`, and outside the room's safe area the room and the app both inset the status bar); `AppPlaceProps.secondary`, which `PushedPage` already had (People's roster reaches Trash from that slot and nowhere else); `RoomSelection.note`, so the read-only reason keeps a line of its own, as §6 requires it to have somewhere other than the disabled control's hint. No existing prop renamed.

**Copy consolidated.** `apps/mobile/src/apps/photos/photos-confirm-copy.ts`: the sentence a trash confirm must carry — the device original survives — was spelled into five files and dropped from a sixth.

**What a pushed page gave up, deliberately.** Tally's and Locker's pushed routes no longer carry the ambient `routeStatus` line: `PlaceHeader` has no meta line, by its own comment, and the two apps come in line rather than keeping a header shape of their own.

**Test fixtures completed, none loosened.** `PersonGrants.test.tsx` gained a `react-native-safe-area-context` mock and its `status-line` mock became partial — `PeopleConfirm` is a `SheetRoom` now, which HOSTS the status line, so the real reader and subscriber must stay real; only `postStatus` is still spied, and no assertion changed. `PlaceDetail.test.tsx`'s `PhotosScreen` stub renders the title and the back key it no longer draws itself, with the back key's real spoken name computed the way `PushedPage` computes it. `PhotosScreen.test.tsx` is rewritten onto the shared `test/react-native-stub` rather than its own bespoke one.

Files changed or deleted, by full path:

- Kit: `apps/mobile/src/kit/rooms/AppPlace.tsx`, `apps/mobile/src/kit/rooms/PushedPage.tsx`, `apps/mobile/src/kit/rooms/SelectionBars.tsx`, `apps/mobile/src/kit/rooms/room-contracts.ts`, `apps/mobile/src/kit/rooms/rooms.styles.ts`, `apps/mobile/src/kit/rooms/rooms.test.tsx`, `apps/mobile/src/kit/band/BandCapsule.tsx`.
- Tally: `TallyScreen.tsx`, `TallyBand.tsx`, `TallyAskSheet.tsx`, `TallyMoreSheet.tsx`, `TallyHome.tsx`, `TallyAddScreen.tsx`, `TallyExpenseScreen.tsx`, `TallyFriendScreen.tsx`, `TallyGroupScreen.tsx`, `TallyReceiptScreen.tsx`, `TallyRecurringScreen.tsx`, `TallySearchScreen.tsx`, `TallySettleScreen.tsx`, `TallySpendingScreen.tsx`, `TallySurfaceScreen.tsx`, `TallyTrashScreen.tsx`, and new `tally-places.ts` + `tally-places.test.ts` — all under `apps/mobile/src/apps/tally/`.
- Locker: `LockerScreen.tsx`, `LockerBand.tsx`, `LockerMoreSheet.tsx`, `LockerScanSheet.tsx`, `LockerItemScreen.tsx`, `LockerTrashScreen.tsx`, `LockerHome.tsx`, `LockerEditScreen.tsx`, `LockerAccessScreen.tsx`, `LockerSurfaceScreen.tsx`, and new `locker-places.ts` + `locker-places.test.ts` — all under `apps/mobile/src/apps/locker/`.
- People: `PeopleScreen.tsx`, `PeopleBand.tsx`, `PeopleConfirm.tsx`, `PeopleHome.tsx`, `PeopleKit.tsx`, `PeopleKit.test.tsx`, `PeopleTrash.tsx`, `PersonView.tsx`, `PersonEditor.tsx`, `PersonGrants.test.tsx`, `MergeView.tsx`, `LogTouch.tsx`, and new `people-places.ts` + `people-places.test.ts` — all under `apps/mobile/src/apps/people/`.
- Photos: `PhotosScreen.tsx`, `PhotosScreen.test.tsx`, `PhotosBand.tsx`, `PhotosHome.tsx`, `PhotosLibrary.tsx`, `PhotosSearch.tsx`, `PhotosPeopleView.tsx`, `PlacesView.tsx`, `PlaceDetail.tsx`, `PlaceDetail.test.tsx`, `MemoriesView.tsx`, `AlbumDetail.tsx`, `DuplicatesShelf.tsx`, `DuplicateReview.tsx`, `PhotoStateView.tsx`, `PhotoPicker.tsx`, `PhotoLightbox.tsx`, `PhotoLightboxToolbar.tsx`, `PhotoTile.tsx`, `TimelineGrainControl.tsx`, `viewer-menu.ts`, new `photos-places.ts` + `photos-places.test.ts` + `PhotosChoiceSheet.tsx` + `photos-confirm-copy.ts`, deleted `PhotosBackControl.tsx` — all under `apps/mobile/src/apps/photos/`.

### Verification on this head

`bunx vitest run src/apps src/kit` → **205 files, 1808 passed, 0 failed**. `bun run --cwd apps/mobile typecheck` → **0**, after `bun run --cwd packages/design build`: the SHELL lane published `subBase` from `packages/design/src/index.ts`, but `packages/design/dist/index.d.ts` on the umbrella head predates it, so `apps/mobile` typecheck resolves the stale declarations and fails on `kit/theme/native.ts` and `native.test.ts` until the package is rebuilt. Measured failure-for-failure on `umbrella/1015-mobile-ux` itself before touching anything; not this lane's, and not a code change. `bun run lint` → clean. `lint-mobile-design`, `lint-container-opacity`, `lint-aria-labels` → 0.

`lint-mobile-rooms` → `screen-root 162` (from 181 at the start of Wave 2), `back-literal 15` (from 47), `page-margin 106` (from 135), `identity-tint 0`, `copy-title-case 0`. Over the four trees this lane owns: **`back-literal 0`, `page-margin 2`, `screen-root 71`**.

The two `page-margin` findings left are the same `paddingHorizontal: 3` chip inset in `PhotoTile.tsx`, twice. `subBase` names 2 (`gutter`) and 1 (`hair`); a third value there is a design-system change and not a call-site one, so the literal stays and is stated at the seam. `TimelineGrainControl.tsx`'s `2` is `subBase.gutter` now that the SHELL lane published the door.

`screen-root 71` is the rule reading text rather than a render tree, and it splits cleanly: **22** are routes whose root is their own app frame — `<TallyScreen>`, `<LockerScreen>`, `<PeopleScreen>`, `<PhotosScreen>` — each of which IS one of the six rooms, one level of indirection the matcher cannot follow; **49** are leaf components and body views (`PhotoTile`, `BalancesView`, `LockerRow`, the bands, the map views) that are not screens and must not be rooted in a room. Driving this number to a literal zero would mean either deleting the four frames and repeating their gate, band and lockup wiring across forty routes, or wrapping leaf components in rooms. Neither is the rule's intent, so neither was done, and the count is stated here rather than engineered away.

### Lane APPS-A — the merge round: the rooms reconciled, and R-A-12

`umbrella/1015-mobile-ux` and `lane/1015-apps-a` extended the same three room
files in parallel. Merged as a union, one definition per prop, nothing
renamed:

- `apps/mobile/src/kit/rooms/AppPlace.tsx` · `apps/mobile/src/kit/rooms/PushedPage.tsx`
  — `chrome` (APPS-A) and `lockup` (APPS-B) are both kept and both rendered,
  in that order, above the header. They were added for the same slot by two
  lanes that could not see each other; renaming or collapsing either would
  have broken its callers silently, which is the one thing the wave's rule
  about room props forbids. `secondary` keeps ONE definition carrying both
  lanes' reasons (Docs' drive needs the pair; People's roster reaches Trash
  from here and nowhere else), with the `testID` pass-through APPS-A added.
- `apps/mobile/src/kit/rooms/rooms.test.tsx` — every test from both sides
  kept. The chrome claim (`words[0]`, so the order is pinned) and the lockup
  claim (`toContain`) now stand side by side on both rooms.
- `packages/blueprints/apps/notes/view-copy.ts` — `HISTORY_UNREADABLE`
  deleted (R-A-12). `grep -rn HISTORY_UNREADABLE packages apps`, with `dist`
  and sourcemaps set aside, returns the definition and no caller on any
  seat, web included.

**R-A-9 verified read-only across Photos, and it does not hold there.** Four
screens build their `selectionBar` object unconditionally and pass it on every
render, so `PhotosScreen` lowers a `RoomSelection` with `count: 0` while the
member is merely looking: `AlbumDetail.tsx:313`/`:354`,
`DuplicateReview.tsx:120`/`:159`, `DuplicatesShelf.tsx:112`/`:167`,
`PhotoStateView.tsx:222`/`:266`. Under R-A-9 that is a dimmed band and a
swapped header at rest. Not edited here — another worker holds those files;
raised to the root as an owner item.
## Lane APPS-B, Wave 2 round 4 — Photos' home into the room, and the testID contract

Commits `d8dfe78a3`, `977de0a83`, `9f228ddcb` on `lane/1015-apps-b`.

**R-B-9 — `PhotosHome` is an `AppPlace`.** It was the last Photos surface drawing its own furniture: a hand-rolled header row, its own `paddingTop: insets.top` under the frame's `VaultBar`, its own band mount, and a second bar at the foot UNDER A LIVE BAND — audit B8, the case where a tap aimed at "Trash" lands on a band destination and navigates away. The room owns all four now. Selection is the room's `selection` prop (D5): the header swaps in place to "N photographs selected · Cancel", the band is handed `dimmed`/`interactive` off `bandStateFor` (leaf tokens, never a container opacity), and the verbs live in the room's ONE foot row. "Back up to the gateway" moved out of the old header into that row, where it belongs — it is a verb on the selection, not on the page. The lockup arrives as the room's `lockup`, inside the room's safe area, so the app no longer insets the status bar a second time.

**Split under the ceiling, not around it.** 756 → 612 lines, by naming what came out rather than by moving lines: `apps/mobile/src/apps/photos/PhotosLibraryBody.tsx` (the library destination's state order — loading, empty library, emptied-by-filter, content — which decides nothing and is handed every state), `apps/mobile/src/apps/photos/photos-home-effects.ts` (`usePinnedThumbnailPack` with its signature gate, `useOnThisDayNotice`), `apps/mobile/src/apps/photos/photos-meta.ts` (the identity both Photos frames resolve; two `resolveAppMeta` calls is how a header and a springboard tile come to disagree). `photos-selection-copy.ts` is DELETED: `selectedSentence` writes that sentence now, and a copy table with one caller left is dead weight.

**Two kit props, each named by the screen that needed them.** `RoomAction.testID` — a verb the room draws is still the verb a Maestro flow selects, and Photos carried three handles (`photos-select`, `photos-selection-album`, `photos-selection-trash`) into the room. `AppPlace.trailingRef` — Photos' view options is an ANCHORED MENU, not a sheet, because a sheet moves the grid underneath; the room lends the trailing verbs' node (`collapsable={false}`, or Android flattens it and it cannot be measured) and the screen measures it on the press. Neither renames anything.

**One kit copy fix, found by adopting it.** `selectedSentence` took a plural noun, so a caller had to spell the plural itself and "1 photographs selected" was what a one-photograph selection said. It takes the SINGULAR noun now and pluralises like `confirmTitle` does; `PhotosScreen`'s `noun` and the two rooms tests came with it. That is a contract change, stated here, not a test loosened.

**The testID contract, both ends.** `node scripts/lint-mobile-testids.mjs` was RED on this head with two `unapplied-id` findings, and they had different causes. `photos-search-field` is this lane's: the S4 pass in round 2 replaced Photos' hand-rolled query box with the kit's `SearchField` and left the handle behind, so `tests/agent-e2e-mobile/flows/photos-search.mjs` had been selecting nothing since — applied to the kit field. `locker-gate-field` is INHERITED and predates the umbrella (`git show af9ceac6d:…/LockerWall.tsx` has no such handle): #1002 made the Locker gate the device's own authentication, and the passphrase field it named no longer exists. It is retired rather than re-applied — applying a handle to a control no screen renders is the paper coverage this linter exists to catch — and no flow selects it. The gate is green.

**R-B-10 stands, R-B-11 not touched.** `PeopleConfirm` on `SheetRoom` is unchanged from round 3; the `screen-root` predicate is Wave 4 and was left alone.

**Slice 3 — the pushed routes' ambient line: left, and noted.** Both Tally and Locker pass `routeStatus`/`ROUTE_STATUS` as the room's `subtitle` on their PLACE branches (`TallyScreen.tsx:177`, `LockerScreen.tsx:212`). `PushedPage` has no `subtitle` and no status prop, so the pushed branches carry no ambient sentence — which `LockerScreen.tsx`'s header already states as deliberate ("a pushed surface carries no ambient subtitle"). Per the ruling, the room has no such prop to restore it onto, so nothing was added: inventing one would be a room prop with one caller and a fresh divergence between the two branches of the same header.

Files changed or deleted, by full path:

- `apps/mobile/src/kit/rooms/AppPlace.tsx`, `apps/mobile/src/kit/rooms/room-contracts.ts`, `apps/mobile/src/kit/rooms/SelectionBars.tsx`, `apps/mobile/src/kit/rooms/rooms.test.tsx`, `apps/mobile/src/kit/test-ids.ts`.
- `apps/mobile/src/apps/photos/PhotosHome.tsx`, `apps/mobile/src/apps/photos/PhotosHome.styles.ts`, `apps/mobile/src/apps/photos/PhotosHome.test.tsx`, `apps/mobile/src/apps/photos/PhotosScreen.tsx`, `apps/mobile/src/apps/photos/PhotosSearch.tsx`, `apps/mobile/src/apps/photos/photos-copy-case.test.ts`.
- New: `apps/mobile/src/apps/photos/PhotosLibraryBody.tsx`, `apps/mobile/src/apps/photos/photos-home-effects.ts`, `apps/mobile/src/apps/photos/photos-meta.ts`.
- Deleted: `apps/mobile/src/apps/photos/photos-selection-copy.ts`.

### Verification on this head

`bun run --cwd packages/design build` first — the stale `dist` against the SHELL lane's `subBase` is still inherited and still not a code change.

1. `cd apps/mobile && bunx vitest run src/apps/photos src/kit/rooms src/apps/locker` → **81 files, 834 passed, 0 failed**. `PhotosHome.test.tsx` gained the room-root assertion (the room's back key and the app's word, neither of which the screen draws any more).
2. `bun run --cwd apps/mobile typecheck` → **0**.
3. `node scripts/lint-mobile-rooms.mjs` → `screen-root 163`, `back-literal 15`, `page-margin 106`, `identity-tint 0`, `copy-title-case 0`. Over this lane's four trees: `back-literal 0`, `page-margin 2`, `screen-root 74`. The two `page-margin` are the same ruled `paddingHorizontal: 3` chip inset in `PhotoTile.tsx` (R-B-6, sub-base, not a page gutter); `screen-root` is unchanged in kind from round 3 — app frames and leaf views the text matcher cannot tell from screens (R-B-11, Wave 4). It rose by one because this round adds one body view (`PhotosLibraryBody`), which is a leaf and must not be rooted in a room.
4. `grep -rn "Alert.alert" apps/mobile/src/apps/{photos,people,locker,tally}` → **0 calls** (two matches, both prose in comments naming what was replaced).
5. `node scripts/lint-mobile-design.mjs`, `node scripts/lint-container-opacity.mjs`, `node scripts/lint-aria-labels.mjs` → **0**.
6. `node scripts/lint-mobile-testids.mjs` → **ok**, 123 selectors across 37 flow files resolve, 84 vocabulary entries applied.
7. `bun run format` then `bun run check:push:static` → **4/4**.
8. `node .governance/law/run.mjs` at each commit door → 6 rules, no findings.

## Lane SHELL, Wave 3 + Wave 4 — the moment channel, one noun, and the gate that holds all of it

Merged `umbrella/1015-mobile-ux` (`e52e69962`) into the lane at `c83144ccc`. One conflict, `apps/mobile/src/kit/rooms/PushedPage.tsx`: three lanes had each added a prop to the same room (`overlay`/`testID` here, `lockup` from APPS-B). Union, one definition each, nothing renamed, every test kept. `bun run --cwd packages/design build` after the merge.

### The one moment channel (`b085611cf`)

`apps/mobile/src/kit/haptics.ts` is new, with `apps/mobile/src/kit/haptics.test.ts` and `apps/mobile/src/test/haptics-stub.ts` (the device seam for the stub tier — the RNTL tier already had one, and eight app-lane tests would otherwise each restate the literal).

`expo-haptics` was reached for directly in seven files, each picking its own feedback for its own reason: a launcher tile buzzed on **every press-in**, a first-move buzzed on press, onboarding fired a **success notification for arriving at a screen**, and a real destructive write that landed said nothing at all. Haptics had stopped meaning anything because everything meant it. The module names exactly three moments — `hapticSelect()` on a band selection, `hapticMode()` on a mode-changing long-press, `hapticLanded()` on a landed destructive write — and every call swallows an absent or rejecting native module, because a silenced phone is not an error worth a member's attention and must never take down the interaction the buzz was decorating.

Adopted in the kit at the two places the kit owns: the band's place select (`screens/home/HomeBand.tsx`) and the one confirm's destructive verb, **where the write actually lands** rather than where the sheet opened (`kit/components/ConfirmSheet.tsx`). Deleted everywhere else in this lane's trees (`dabba1919`, shell/findings 23): `screens/Onboarding.tsx` (two sites), `screens/home/LauncherGrid.tsx` (the 0.97 scale IS the press feedback), `screens/home/FirstMoves.tsx`.

### The shell says one noun, and no exception (`323dd1e8a`)

**S11 — one noun per destination (shell/findings 6).** The Alerts place wore four names at once: `Alerts` in the band, `Notifications` in More and in its own bar (clipped to `Notificati…`), and a Settings section headed NOTIFICATIONS over a row reading "Decisions and updates". Worse, `HomeBand` set `accessibilityLabel={tab.name}` while painting `tab.short`, so a VoiceOver member and a sighted member were told different words for the same tab. `places.ts` names it **Alerts**, the band **speaks what it paints**, and `screens/shell-copy.ts` is new: the tables a sweep can read, rather than a `switch` buried in a render. The one remaining swap (`autos`: name "Automations", band "Rules") is written down in `SHORT_NAME_DIVERGENCES` with its reason and is an open question for the owner — see the report.

**S14 — no engine vocabulary, no payloads (shell/findings 13, 18, 22).** The desktop-link row read `Connected (port 8787)` and, on failure, `Error: <the module's own sentence>`; pairing, connectors, alerts, vault settings, enrichment, an automation thread, Scan, the sharing read and the kit's own `ReplicaStateCard` each printed `error.message`. `devices-model.ts` was the sharpest case: it **lowered the vocabulary** of an exception and printed it — "Gateway returned HTTP 503" became "home machine returned HTTP 503", which reads better and is still a fact about the program. Each surface says one noun from `SHELL_ERROR`; `ReplicaStateCard`'s `error` prop is documented as the SIGNAL it always was and is never rendered. `Retry` becomes `RETRY_ACTION` ("Try again") in `PendingChangesSheet` and `ReplicaStateCard`. Settings' `Advanced (developer)` and `Gateway connection` lose the developer's words.

**a11y.** `screens/shell-copy.test.ts` is the sweep: sentence case over the tables AND over `.tsx` option arrays (proper nouns exempted from the word-shape heuristic by the tables themselves, so a label can only borrow a name the product HAS), the one-noun rule, the S14 sinks, no `accessibilityLabel` on a container that carries its own text, and a role on every pressable — **twelve role-less pressables** fixed across `Onboarding`, `PhoneStorage`, `Settings` and `data/RecordSheet`.

Tests updated because they were fixtures for the defect, not because they were in the way: `ReplicaStateCard.test.tsx` (asserted the raw error was shown), `ReplicaStatusBar.test.tsx` (`Retry`), `Connectors.test.tsx` (asserted `connect ECONNREFUSED` reached the member), `EnrichmentSection.test.tsx`, `devices-model.test.ts`, `useAssistant.test.ts`, `Onboarding.test.tsx`.

### Shell residue (`1d7098e80`)

- **21 — four date registers inside one navigation stack.** Backup health counted with `toLocaleString()` (locale-numeric, with SECONDS: "10/09/2026, 2:11:39 PM"), Access with its own option bag, Copies with a third ("10 September"). All three take `kit/format.ts`.
- **16 — the Vault page disagreed with itself.** Header `KINDS 61`, footer `38 kinds`, 25pt apart: one counted the rows the page renders, the other read `totals.populatedKinds`. `censusDetail` derives from `censusKinds` — the list a member can count is the one that wins.
- **15 — destructive grammar.** `Unpair` was a `secondary` button visually identical to "Pair another" directly above it; it is `destructive` (outlined `--net`). `Archive` drops to `quiet` so a notice row has a hierarchy rather than three buttons at one weight.
- **24 — the icon registry.** The New-chat glyph was an inline `<Svg>` with a hardcoded `strokeWidth={1.5}`, bypassing the registry and the stroke ramp. `NewChat` is in `packages/design/src/icons.ts` ([docs/decisions.md#typography-and-design-contracts](../docs/decisions.md#typography-and-design-contracts)).

### Wave 4 — the gate (`ea022320e`, `8f3add239`)

**The predicate (R-SH-4 / R-B-11).** `screen-root` fired on every `.tsx` under the two trees: **153 findings, roughly ninety-six of them leaf components** — a row, a card, a section block. None of those is a screen, none may be a room, and every one was a finding. A rule that cries about a hundred non-problems does not get wired; it gets ignored. A file is a screen iff the app REGISTERS it: `apps/mobile/lazy-screens.tsx` names the module in a `lazyScreen(() => import("./src/…"))` — that file is the composition root's screen registry, and a `component=` prop is the only way any of those bindings is reachable — or it is a `*Screen.tsx` / `*Home.tsx` frame. The registry is READ, not restated, so a screen added to the app is a screen to the rule in the same commit. **153 → 56**, and every one of the 56 is a real screen outside a room.

**The sixth rule (R-SH-2).** `error-detail`: `error.message` / `String(err)` / `err.toString()` on the same line as a copy sink (a room's `error`/`detail`/`secondary`, a `message`, a `reason`, `postStatus`, `showUndoStatus`). Line-scoped, so `catch (error) { log(error.message) }` beside an unrelated `message:` is not a finding — capturing an exception is fine, rendering one is not. 23 at first measure, **10 of them in this lane's trees and now 0**. `Assistant.tsx` also takes `PushedPage`, the last hand-rolled root here; `PushedPage` gains a `footer` for its composer.

**Wired.** `bun run lint:product` runs `node scripts/lint-mobile-rooms.mjs --enforce` (`package.json` `lint:mobile-rooms`, `scripts/lint-product.mjs`, `scripts/ci/gate-classes.json` — the last in its own commit, because `gate-classes.json` is law and everything else is territory). Adding a gate is a change inside the settled PR-gate doctrine ([docs/decisions.md#the-pr-gate-loop-892](../docs/decisions.md#the-pr-gate-loop-892), [#892](https://github.com/srikanth235/centraid/issues/892)): `lint:mobile-rooms` is a **rung-1 product** gate in the `lint:product` bundle, not a new name in `check:push` and not a hygiene-lane member, which is what that doctrine asks of a new gate.

Enforcement is **per rule**, not per tree, and this is the ruled allowlist question answered honestly: `identity-tint` and `copy-title-case` are **0 tree-wide** and any new finding fails outright. The other four carry a recorded ratchet in `scripts/lint-mobile-rooms.baseline.json` — `screen-root 56`, `page-margin 93`, `back-literal 15`, `error-detail 13` — every one of them an APPS-A/APPS-B Wave-3 tree whose lane had not merged when this was measured, each entry naming the wave that clears it. A baseline may only go DOWN: above it fails, under it prints the number to lower it to. **A new hand-rolled screen root, back literal, gutter literal, tint on a control, Title Case label or rendered exception fails the push gate today** — verified by planting one and reading exit 1, then removing it and reading exit 0. What the baseline does not yet do is force the burn-down, and it must not become a licence: when the app lanes land, every entry goes to 0.

`scripts/lint-mobile-rooms.test.mjs` gains four cases the `selfTest` cannot make: a leaf is not a screen, the registry names real existing modules (>40 of them), the recorded baseline names only rules that exist and no rule is above it, and a logged exception is not a finding. It is registered in `scripts:test` — it was reachable by no runner before, which `lint:test-reachability` had been red about.

### Wave 4 — docs (`95e66952d`)

- **DESIGN.md** gains `### The six rooms (mobile)` under Components: the room table, what the room owns versus what an app supplies, D1–D6 by pointer, and the gate named. The recipe inventory said what a control looks like and never what a SCREEN is; that was the half the audit found missing.
- **docs/decisions.md** `#1015` later-rulings table gains **21 dated rows** — R-KIT-2, R-KIT-6, R-A-6, R-A-7, R-B-4 … R-B-14, R-SH-1 … R-SH-7 — read out of the umbrella's own merge bodies. **R-A-8 … R-A-14 are not on this head**; the root holds them.
- **docs/design-divergences.md** is a state doc, so the closed row is GONE rather than annotated. Removed: **"Photos menu and control copy in Title Case"** (closed by D2). Revised: the Docs trash paragraph, which said the platform has no way to bring a purge date forward — D1 and `core.empty_document_trash` made that false. Added: a paragraph at the top stating that the phone's FRAME has no rows in that register at all, because it is the six rooms and the gate fails a screen that hand-rolls one.
- **docs/mobile-offline.md**: the retained conflict `reason` is retained, not shown (R-SH-7).
- **CHANGELOG.md**: one new Unreleased bullet for the rooms half; the existing #1015 bullet says "this wave is the kit half" and is untouched.

### Findings ledger — `shell/findings.md`, every id

| id | closed by | or the reason it is left |
| --- | --- | --- |
| 1 three backup claims | Wave 0 (`B13`, one custody arithmetic) | — |
| 2 floating Home key over the health line | Wave 1 (the floating variant is deleted) | — |
| 3 Settings unreachable, Starred pinnable | Wave 0 (`B15`/D6) | — |
| 4 nine kit-native places, eleven hand-rolled screens | Wave 2 (every shell screen is a room) | — |
| 5 four back affordances, four title rungs | Wave 2 (the room owns both) | — |
| 6 "Notifications" names four things | `323dd1e8a` | the `autos` band word is an open question for the owner |
| 7 the Access dashboard | — | **Left.** It needs a revoke command the vault does not expose and a grouping model over principals; that is product work, not a copy wave. Its two copy defects (the ~17-word read failure, the raw `last used` format) ARE fixed here. |
| 8 the clipped health sentence | — | **Left.** The fix is to drop `APPROVALS_HEALTH_DETAIL`, which is `packages/client` copy shared with the web seat; a mobile-only edit would fork it. Raised to the root. |
| 9 Browse changes the page 60 rows below the tap | — | **Left.** Needs a scroll-to or a pushed route on `Data.tsx`; it is a navigation change, not a consistency fix. |
| 10 the More sheet's header contradicts the screen | `323dd1e8a` (pinned apps **come first**, not **appear**) | — |
| 11 Assistant is two products behind one name | partly `ea022320e` (the full screen is a `PushedPage` with a real back target) | **The two-surfaces question is left**: which of the sheet and the screen survives is a product decision. |
| 12 global search wears the opposite treatment | Wave 2 (`SearchOverlay` is a `PushedPage` with the kit's `SearchField`) | — |
| 13 engine vocabulary on six surfaces | `323dd1e8a`, `ea022320e` | the Access ids ride finding 7 |
| 14 four gutters, arithmetic on a token | Wave 2 (the room's gutter) | — |
| 15 destructive grammar | `1d7098e80` | the "Never move bytes off this device" switch no longer exists on that screen |
| 16 header and footer disagree about kinds | `1d7098e80` | — |
| 17 four names for Sharing | partly `323dd1e8a` (`SHELL_TITLES.sharing`) | the page's own "People & circles" title is APPS-lane copy |
| 18 Retry vs Try again | `323dd1e8a` | the web seat's own `Retry` is out of this umbrella's scope |
| 19 Automations and Connectors unreachable | — | **Left.** It is a gateway capability gate, not a UI defect; a member cannot reach a place the gateway does not serve. The NAMING half rides finding 6. |
| 20 six empty registers | Wave 2 (`RoomEmpty`) + `ea022320e` (Assistant's) | Settings/Access/Backup section-level empties stay per-screen (**R-SH-3**) |
| 21 four date formats, two identity marks | `1d7098e80` (dates) | the vault-lockup vs switcher mark is APPS/design work |
| 22 copy-budget breaches | `323dd1e8a` | — |
| 23 haptics in three files | `b085611cf`, `dabba1919` | — |
| 24 cover, mark and elevation nits | `1d7098e80` (the inline SVG) | the mark-hue and half-cover truncation nits are APPS-lane and design work |

### Exit list

1. `cd apps/mobile && bunx vitest run src/screens src/apps/{assistant,automations,insights} src/kit` → **962 passed, 107 files**.
2. `bun run --cwd apps/mobile typecheck` → **0**.
3. `node scripts/lint-mobile-rooms.mjs` → `screen-root 56 · back-literal 15 · page-margin 93 · identity-tint 0 · copy-title-case 0 · error-detail 13`. This lane's trees are **0 on every rule**; all 177 are APPS-A/APPS-B trees, recorded in the baseline with the wave that clears them.
4. `grep -rn "expo-haptics"` over `screens`, `apps/{assistant,automations,insights}` → **0**; `kit/haptics.ts` is the only importer.
5. `lint-mobile-design`, `lint-container-opacity`, `lint-aria-labels`, `lint-mobile-testids` → **ok**.
6. `bun run lint:mobile-rooms` (the wired gate) → **exit 0**; with a planted hand-rolled screen root → **exit 1**.
7. `bun run format` then `bun run check:push:static` → see below.
8. `node .governance/law/run.mjs --brief-digest 514cb2fed327` → see below.

Files changed by this lane's Wave 3 + Wave 4 commits, in full: `CHANGELOG.md`, `DESIGN.md`, `docs/decisions.md`, `docs/design-divergences.md`, `docs/mobile-offline.md`, `package.json`, `packages/design/src/icons.ts`, `scripts/ci/gate-classes.json`, `scripts/lint-product.mjs`, `scripts/lint-mobile-rooms.mjs`, `scripts/lint-mobile-rooms.test.mjs`, `scripts/lint-mobile-rooms.baseline.json` (new), `apps/mobile/src/kit/haptics.ts` (new), `apps/mobile/src/kit/haptics.test.ts` (new), `apps/mobile/src/test/haptics-stub.ts` (new), `apps/mobile/src/screens/shell-copy.ts` (new), `apps/mobile/src/screens/shell-copy.test.ts` (new), `apps/mobile/src/kit/components/{ConfirmSheet.tsx,ConfirmSheet.test.tsx}`, `apps/mobile/src/kit/replica/{PendingChangesSheet.tsx,ReplicaStateCard.tsx,ReplicaStateCard.test.tsx,ReplicaStatusBar.test.tsx}`, `apps/mobile/src/kit/rooms/PushedPage.tsx`, `apps/mobile/src/apps/assistant/{Assistant.tsx,AssistantCompanionSheet.tsx,useAssistant.ts,useAssistant.test.ts}`, `apps/mobile/src/apps/automations/AutomationThread.tsx`, `apps/mobile/src/screens/{Approvals,BackupHealth,BackupHealth.custody,Onboarding,PhoneStorage,Scan,Settings,SignalNotification}.tsx`, `apps/mobile/src/screens/{Onboarding.test.tsx,shell-places.ts,shell-rooms.test.ts}`, `apps/mobile/src/screens/approvals/{RowParts.tsx,useApprovals.ts}`, `apps/mobile/src/screens/connectors/{Connectors.test.tsx,useConnectors.ts}`, `apps/mobile/src/screens/data/{RecordSheet.tsx,VaultSections.tsx,data-model.ts}`, `apps/mobile/src/screens/devices/{devices-model.ts,devices-model.test.ts}`, `apps/mobile/src/screens/home/{AllAppsSheet,FirstMoves,HomeBand,LauncherGrid,VaultHeader}.tsx`, `apps/mobile/src/screens/home/{VaultsSwitcher.test.tsx,places.ts}`, `apps/mobile/src/screens/settings/{AccessSection.tsx,EnrichmentSection.tsx,EnrichmentSection.test.tsx,VaultSection.tsx}`. Deleted: `NewChatIcon` and `NEW_CHAT_PATHS` (exports, not files) from `screens/home/VaultHeader.tsx`; `tunnelStatusLabel` from `screens/Settings.tsx`.
## Lane APPS-A, merge round 2 + Wave 3 — Agenda, Tasks, Notes, Docs

Branch `lane/1015-apps-a`. Two merges of `umbrella/1015-mobile-ux`, two
carried round-2 items, one Wave-3 kit seam, one commit per app, and the
haptics adoption once `kit/haptics.ts` reached the umbrella.

### Merge round 2 — `510d6d87d`

Three conflicts, all in the rooms kit, all resolved as a union: one definition
per prop, nothing renamed, every test from both sides kept.

- `apps/mobile/src/kit/rooms/AppPlace.tsx` — APPS-B's `trailingRef` wrapper is
  a strict superset of this lane's bare trailing verbs, so the quiet verb and
  the action now sit inside the `collapsable={false}` node the room lends out
  for Photos' anchored menu.
- `apps/mobile/src/kit/rooms/room-contracts.ts` — `RoomAction.testID`'s doc is
  the union of both rationales (Notes' write door, Photos' Select chip,
  `lint-mobile-testids`). `selectedSentence` is the union of both BEHAVIOURS:
  the zero case is still the instruction ("Choose photographs"), and the noun
  now agrees with the count ("1 photograph selected").
- `apps/mobile/src/kit/rooms/rooms.test.tsx` — all six `AppPlace` tests kept:
  toolbar-above-empty, both testID passthroughs, the anchored-menu quiet verb,
  the overlay, the frame chrome.

`bun run --cwd packages/design build` run AFTER the merge, not before.

Second merge `0e9762c9b`, for the haptics channel: one conflict in
`apps/mobile/src/kit/rooms/PushedPage.tsx`, where both sides added a prop to
the room's root. Union — the page keeps SHELL's `testID` and this lane's
`chrome`. `overlay` arrived from both sides and git kept BOTH copies, prop
and render; one definition survives, rendering where `AppPlace` renders it
(after the body, before the selection bar and the band), so a confirm sheet
sits in the same place in both rooms. A second `{overlay}` would have
double-mounted every confirm on every pushed page.

### R-A-13 — the back key's test handle — `bb7385bd9`

`apps/mobile/src/kit/rooms/PushedPage.tsx` gains `backTestID` (and `BackKey` a
`testID`). The back key is chrome an end-to-end flow selects BY HANDLE rather
than by words, and the rooms migration swallowed the two handles the flows
already used. Applied at their one screen each:
`apps/mobile/src/apps/docs/DocumentRead.tsx` (`docs-breadcrumb`, which
`tests/agent-e2e-mobile/flows/docs-drive.mjs` asserts GONE to prove the Docs
band POPS rather than pushes — a negative asserted on copy passes forever the
day the copy is re-worded) and
`apps/mobile/src/apps/agenda/AgendaEvent.tsx` (`agenda-event-back`, from
`flows/agenda-week.mjs`). Test: `rooms.test.tsx`.

`node scripts/lint-mobile-testids.mjs` now prints `ok`, not FAIL. **For Wave
4:** the brief said it exits 0 either way — it does NOT. It exits 1 on FAIL
and 0 on ok, so it is already usable as a gate.

### R-A-14 — Photos enters the selection mode once — `0c42ae3cd`

Presence IS the mode (`bandStateFor`), so a screen that is not choosing passes
no selection. Four Photos screens passed their selection bar unconditionally —
an object at rest — and sat permanently in the mode: the header swapped for
the instruction, the band was dimmed and non-interactive, and the foot row
stood there before a single photograph had been picked.

- `apps/mobile/src/apps/photos/AlbumDetail.tsx`
- `apps/mobile/src/apps/photos/DuplicateReview.tsx`
- `apps/mobile/src/apps/photos/DuplicatesShelf.tsx`
- `apps/mobile/src/apps/photos/PhotoStateView.tsx`

One ternary each on `selection.size > 0`, matching `PhotosHome.tsx`, which was
always right. Nothing else in Photos touched — APPS-B is live in that tree.
Test: `apps/mobile/src/apps/photos/selection-presence.test.ts`, which pins the
guard at all four call sites AND why it belongs there rather than in the room
(an empty selection is still a selection — Docs' drive is choosing at zero).

### The Wave-3 kit seam — `c879a7c87`

- `apps/mobile/src/kit/rooms/read-failure.ts` + `.test.ts` (S14). The member
  never reads the exception. `useSeatPages` catches whatever the engine threw
  and hands it on as `caughtError.message` — or `String(caughtError)` when it
  is not even an Error — and Notes and Agenda both put that string into the
  room's body verbatim. `readFailure` takes a BOOLEAN, not the message, so a
  caller cannot leak one by mistake.
- `apps/mobile/src/kit/hooks/useSeatPages.ts` — the raw string is not lost: it
  is logged at the catch, where a debug session starts (docs/logs.md).
- `apps/mobile/src/kit/copy-case.ts` + `.test.ts` (S11/D2). Photos wrote the
  sentence-case sweep first; `titleCaseWords` lifts it out so each app's sweep
  is the SAME check with its own proper nouns rather than four near-copies
  that drift apart. Photos' own file untouched.

### Notes — `4c7b101fa`

Changed: `apps/mobile/src/apps/notes/notes-copy.ts` (new),
`notes-copy-case.test.ts` (new), `notes-a11y.test.ts` (new), `NotesHome.tsx`,
`NoteEditor.tsx`, `NotesPlaces.tsx`, `NotesHistory.tsx`;
`packages/blueprints/apps/notes/view-copy.ts` + `view-copy.test.ts`.

| finding | closed by | or reason left |
| --- | --- | --- |
| #1 status swallowed | Wave 2 `7174eb0d6` (`EditorRoom` hosts its line) | |
| #2 no autosave | Wave 2 `7174eb0d6` (D3) | |
| #3 caption printed twice | | Layout, not copy — the caption is a room `subtitle` on one route and a rail head on another. Needs a ruling on which surface owns it; Wave 3 is copy/tint/haptics/a11y. |
| #4 `+` says New note everywhere | | Behaviour: the action must be withheld per place, and the Journal create must write the journal marker. Not a Wave-3 item. |
| #5 notebook loses its name | Wave 2 `7174eb0d6` | |
| #6 bare-text buttons | Wave 2 `7174eb0d6` (kit `Button`) | |
| #7 four empty shapes | partly Wave 2 | `NotesPlaces` still hand-rolls two; empty Tags and empty Notebooks draw header-over-void. Behaviour, not copy. |
| #8 markdown raw | | A renderer is a feature, not Wave 3. |
| #9 `10/09/2026` | Wave 2 (`formatRelative`; `toLocaleDateString` gone from the tree) | |
| #10 stylesheet drops type tokens | | Token debt across 12 rules; a design-machinery slice. |
| #11 searches the phone, says nothing | | Behaviour + a scope line; needs a ruling on which library Notes searches. |
| #12 `[[` probe placement | | Layout. |
| #13 naked destructive icon on every row | | Layout/affordance ruling (Photos and Docs put it behind a menu). |
| #14 cannot file while writing | | Behaviour. |
| #15 `"1 versions"` | **this wave** — `editorStatus`/`historyStatus` agree with the count | |
| #16 auto-capitalise everywhere | search closed in Wave 2 (kit `SearchField`) | The title and body are PROSE and should capitalise; the tag field is the one that is genuinely wrong, and it is layout-coupled. |
| #17 title truncates | | Layout. |
| #18 Version history dead end | partly Wave 2 (a back control exists) | Its origin is the place, not the note — a navigation ruling. |
| #19 long-press does nothing | | Behaviour; and S15 says a long-press only buzzes where it changes a MODE, which Notes has none of. |

Also this wave, beyond the findings: S14 — `NotesHome` stopped piping
`state.error` into the room body, and its two failure titles ("Not applied",
"Action failed") gained their noun. A11y — six sites: `SeatList` REQUIRES a
name and Notes was handing it the rail's whole explanatory caption, the
sentence the screen already draws underneath, so the rotor read a paragraph
and the member heard it twice; the lists are NAMED now. Three `Pressable`s
were labelled with the very word inside them, which makes VoiceOver read the
label INSTEAD of the children and dropped the More rows' meta line.
`NotesHistory` exposes the version being read as `accessibilityState.selected`
rather than the loose word "current".

### Tasks — `1813e2d26`

Changed: `apps/mobile/src/apps/tasks/tasks-copy-case.test.ts` (new),
`TaskRow.tsx`, `tasks-row-model.ts`, `TasksHome.tsx`, `TasksHome.test.tsx`;
`packages/blueprints/apps/tasks/view-copy.ts` + `view-copy.test.ts`,
`app-root.tsx`.

| finding | closed by | or reason left |
| --- | --- | --- |
| #1 undo destroyed | Wave 1 `3c61b4e2c` | |
| #2 no due date / reminder | Wave 1 `9b0a756ab` | |
| #16 `NOW`/`HOUSE` marks | **this wave** — `VAULT_MARKER` is "House"; the sweep forbids ALL-CAPS literals | |
| #19 effort mixes bare numbers with units | **this wave** — every chip carries its unit | |
| #23 checkbox and body share a label | **this wave** — `checkboxLabel` names the ACT, and the opposite one once closed | |
| #3 filtered-empty lies | | Behaviour: a lens-filtered empty state and a way back. |
| #4 sort dressed as a filter chip | | Layout ruling. |
| #5 two counts for one list | | Two denominators, `shownItems.total` vs `inboxMeta(unfiled.length)`; needs a ruling on which is the board's count. |
| #6 completed task scolded for being late | | `isOverdueWhen` is date-only and `metaParts` has no `isClosed` guard — a model change. |
| #7 bulk verbs fire unconfirmed | | Behaviour: the four bulk verbs need `useConfirmDestructive`, which is a Wave-2-shaped slice, not copy. |
| #8 Projects bare, filing mode has no exit | | Behaviour. |
| #9 disabled primary is white on near-white | | `primaryOff` swaps the ground but not `colors.onAccent`; a design-token slice, and DESIGN.md wants `textDisabled` on the leaf. |
| #10 More is a full screen here | | Layout: adopt `apps/_shared/MoreSheet`. |
| #11 quick add expands over the board | | Layout; the room's `overlay` is an in-flow sibling. |
| #12 snooze options are inert text | | Behaviour. |
| #13 overdue red 8° off destructive | | Token slice. |
| #14 no haptic on any gesture | **this wave** — see the haptics commit | |
| #15 two fields auto-capitalise | | Layout-coupled; search closed by the kit's `SearchField`. |
| #17 bare weekday group heads | | Copy, but it needs a ruling: "Tomorrow"/"Today" vs the weekday, and the group is generated in `tasks-groups.ts`. |
| #18 detail header says "Task" | | Behaviour: the leaf title is a constant from `shelfCopy`. |
| #20 subtasks cannot be created | | Feature. |
| #21 Catch up denies a premise | | Copy, but two registers for one class of reassurance; needs the owner's voice. |
| #22 quick-add hint advertises parsing | | Copy, and the fix is to DELETE a promise — an owner call. |

Also this wave: the check-off posted the bare word "Done", a fact about
nothing. `TASK_DONE` is the status line's own string on BOTH seats (mobile and
`app-root`); `DONE` stays the logbook group's word, because that one heads a
list of them. `doneNext` carries the noun too.

### Agenda — `dc630f916`

Changed: `apps/mobile/src/apps/agenda/agenda-copy-case.test.ts` (new),
`AgendaEvent.tsx`, `AgendaHome.tsx`, `AgendaDayContext.tsx`;
`packages/blueprints/apps/agenda/view-copy.ts`, `day-context-copy.ts`.

| finding | closed by | or reason left |
| --- | --- | --- |
| #1 lockup under the status bar | Wave 2 `140e26f10` | |
| #2 agents offered as guests | Wave 1 | |
| #3 no way to reach another day | Wave 2 `140e26f10` (verified, not trusted) | |
| #4 no month header | Wave 2 `140e26f10` | Residue: the header subtitle is the anchor's month, not the scroll position. |
| #5 end-before-start saved | Wave 2 `140e26f10` | |
| #6 dead Save | Wave 2 `140e26f10` (D3 removed it) | |
| #7 three date formats | Wave 2 `140e26f10` + `ec0d2ea2b` | |
| #8 event route loses lockup, band, Home | Wave 2 `140e26f10` | |
| #16 raw partstat printed | **this wave** — `PARTSTAT_SAID`/`PARTSTAT_CHOOSE`, and an unknown value reads as unanswered | |
| #18 error card calls the app "Calendar" | **this wave** — `readFailure({ noun: "Agenda" })` | |
| #22 band is silent | **this wave** — see the haptics commit | |
| #9 missing event is a permanent skeleton | | Behaviour: the room needs an `empty`/`error` for a row that is not there. |
| #11 Search and More dressed as tabs | | `accessibilityRole="tab"` on two things that are not places — a band ruling, shared with every app's band. |
| #12 due shelf gives no sign it is a control | | Layout. Its a11y half IS closed this wave. |
| #13 More sheet titled "Calendars" | | Three defects in one: a misplaced preference, a title, and `OptionSheet` dropping `selectedId` on iOS. The third is a kit bug — RAISED below. |
| #14 composer and editor are two forms | | Behaviour. |
| #15 neither form handles the keyboard | | Wave 2 moved it into the kit rather than closing it: no room handles the keyboard. RAISED below. |
| #17 cancel not marked as cancel | Wave 2 (`ConfirmSheet`) | |
| #19 gutters retyped | Wave 2 `140e26f10` | |
| #20 header target under 44pt | Wave 2 `140e26f10` (kit `Button`) | |
| #21 identity hue never appears | partly | The hue reaches the app mark chip now, which is where DESIGN.md wants it. `AgendaDayRow`'s identity rule stays `colors.text`; `identity-tint` is 0 and this lane keeps it there. |

### Docs — `d7c200566`

Changed: `apps/mobile/src/apps/docs/docs-copy.ts`, `docs-copy-case.test.ts`
(new), `DocumentProperties.tsx`, `BulkUpload.tsx`, `DocsHome.tsx`,
`DocsCapabilities.tsx`, `DocumentRead.tsx`, `DocumentViewer.tsx`,
`DriveList.tsx`, `DocsSearchView.tsx`.

| finding | closed by | or reason left |
| --- | --- | --- |
| #1 "Back to All" everywhere | Wave 2 `ead84b32a` (`PlaceRef`) | |
| #2 two bars and a live band | Wave 2 `ead84b32a` | |
| #3 empty states touch the bezel | Wave 2 (kit `EmptyBlock`) | |
| #7 Docs cannot empty its trash | round 2 `41e3b1df1` (D1) | |
| #10 invisible fields, silent discard | Wave 2 `ead84b32a` (`EditorRoom`) | |
| #13 Docs and Photos disagree on case | closed from Photos' side (APPS-B) | Docs' menu was already sentence case; the sweep now holds it. |
| #14 refusals inherit the truncation trap | Wave 2 (kit `AnchoredMenu`) | |
| #16 one navigating row has no chevron | Wave 2 (`LinkRow`) | |
| #17 "New" is the only filled primary | Wave 2 `ead84b32a` | |
| #18 `BulkVerb` bypasses `NativeText` | Wave 2 (the component is gone) | |
| S11 five inline enums | **this wave** — custody, upload, arrangement, capability, each a table with a total reader | |
| S14 four raw exceptions | **this wave** — three hand-over paths and the search refusal; the raw string goes to the log | |
| the `205 B` / `205 bytes` split | **already closed** — one formatter, `formatBytes` via `fmtBytes`; every Docs call site goes through it and no ` bytes` string is rendered anywhere in the tree | |
| #4 toolbar controls under 44pt | | The header verbs go through the kit's `Button` (44 floor); the filter/sort/arrangement row does not. Layout slice. |
| #5 grid hides the row menu | | Behaviour: `DocGridTile` draws no `···`. |
| #6 list container fills the viewport | | Layout: `containerEmbedded` exists but only the embedded branch takes it. |
| #8 ontology explained five times | | Copy, but a DELETION across four surfaces — an owner call on which one keeps it. |
| #9 markdown unrendered, title thrice | | Feature + layout. |
| #11 three names for one entry | | Copy, and a naming ruling: "New" / "Add to Docs" / "Add a document", and "Details" / "Properties". RAISED below. |
| #12 plumbing printed as metadata | partly **this wave** — the custody enum stopped saying gateway, tier, cloud and sweep (a sabotage in the sweep holds it). The `Gateway` host:port row remains: it is a real fact a member may need, and deleting it is an owner call. |
| #15 two statuses under every list | | Behaviour. |
| #19 Viewer removes the Home capsule | | `DocumentViewer` passes no `band` to `PushedPage`. Behaviour; the same defect moved rather than closed. |

### Haptics — `8f7c65b02`

`hapticSelect()` on all four bands; `hapticMode()` on the one long-press in
these four apps that changes a MODE (picking a task up puts the board into
filing). Docs' long-press opens the row menu — a presentation, not a mode —
so it stays silent. `hapticLanded()` is adopted by NO app here on purpose:
every destructive write in these trees goes through `useConfirmDestructive`,
and `kit/components/ConfirmSheet.tsx` already fires it when the write is
issued. An app firing it too would double the buzz.
`apps/mobile/src/apps/tasks/tasks-haptics.test.ts` sweeps all four trees.
`apps/mobile/src/apps/docs/DocsTrash.test.tsx` stands the documented stub-tier
seam in front of the native module its graph now reaches.

### Verification

1. `bunx vitest run src/apps/agenda src/apps/tasks src/apps/notes src/apps/docs src/kit` — 855 green.
2. `bun run --cwd apps/mobile typecheck` — 0.
3. `node scripts/lint-mobile-rooms.mjs` — `screen-root 124`, `back-literal 0`,
   `page-margin 2`, `identity-tint 0`, `copy-title-case 0`. This lane's trees:
   `back-literal 0`, `page-margin 0`, `identity-tint 0`, `copy-title-case 0`.
   The 28 `screen-root` findings in these trees are all COMPONENTS (rows,
   bands, panes, fields, toolbars) rather than screens — the heuristic cannot
   tell. The two `page-margin` are Photos' `PhotoTile`, not this lane's.
4. `grep -rn "expo-haptics" <my trees>` — 0 outside the sweep test's own
   assertions and the documented `DocsTrash` stub seam. `Alert.alert` — 0.
5. `lint-mobile-design`, `lint-container-opacity`, `lint-aria-labels`,
   `lint-mobile-testids` — all ok. testids: 123 selectors across 37 flow files
   resolve, 84 vocabulary entries applied.
6. `bun run format` then `bun run check:push:static` — 4/4 green.

### Open for the root

- **`kit/components/OptionSheet.tsx` drops `selectedId` on the iOS branch.**
  Agenda's More sheet passes it and no checkmark is drawn (agenda/findings#13,
  third defect). A kit bug affecting every app that uses an option sheet — not
  this lane's file to change mid-wave.
- **No room handles the keyboard.** agenda/findings#15 was not closed by Wave
  2; the defect MOVED into the kit. No `KeyboardAvoidingView` or
  `keyboardShouldPersistTaps` in `EditorRoom`, `SheetRoom` or `PushedPage`.
- **`surfaceWriteFailure` interpolates `error.message` into the status line**
  (`apps/mobile/src/kit/replica/write-outcome.ts`), and the conflict path
  prints `expectedVersion`/`actualVersion`. That is the same S14 break this
  wave closed everywhere else, but it has ~40 call sites across every lane's
  tree, and `apps/mobile/src/apps/locker/locker-writes.ts` passes a refusal
  reason AS an Error to get it shown — so dropping the message silently
  changes Locker. It needs one ruling and one commit, not four lanes each
  guessing.
- **`BIRTHDAY_LEADS` produces "your phone tells you same day ahead."**
  `packages/blueprints/apps/agenda/day-context-copy.ts` mixes registers
  ("same day", "2 days", "1 week") and `birthdayNotificationBody` reads them
  all as a lead phrase. Not an audit finding; found in passing.
- **Docs' three-names-for-one-entry (#11) and the five-times ontology (#8)**
  are copy fixes that are DELETIONS or renames — they need the owner's word on
  which name survives, not a lane's guess.
- **`TasksDenied` renders the vault's refusal string verbatim**, documented as
  "the refusal the vault gave, which IS the receipt on both seats". Left as
  ruled; flagging it because S14 forbids raw payloads and a refusal receipt is
  the one place the raw string may be the point. Confirm or overturn.
## Wave 3 — lane APPS-B: Tally, Locker, People, Photos — copy, tint, a11y, haptics, residue

Five commits: `aec968bcb` Tally · `94951d4ae` Locker · `0c9648d5a` People · `deade19aa` Photos · haptics (S15) last, after `kit/haptics.ts` landed on the umbrella.

**S11, the shape of the answer.** Four apps, four defects of the same kind: an enum written down twice, or printed raw where a label belonged. Tally held the nine categories in `draft-model.ts` AND `spending-model.ts` and the expense record printed neither — an expense entered under `Fun` was recorded as `fun`. People used `ContactChannel["kind"]` as its own chip and field labels and printed the stored touch kinds in Recent, so one event read `Met up` where it was written and `visit` where it was listed. Locker typed five field labels and notes at the call site against its own module header's stated rule. Photos' search resting state typed three sentences the copy table also held, and the two had already drifted. Each is now one table with one reader: `category-labels.ts` + `categoryLabel()`, `channelKindLabel()` + `touchKindLabel()`, `FIELD_LABEL`/`FIELD_NOTE`, `SEARCH_COPY.resting`.

**A sweep test per app.** `tally-copy-case.test.ts`, `locker-copy-case.test.ts`, `people-copy-case.test.ts` are new; `photos-copy-case.test.ts` gains the half `copy-title-case` cannot see — a source sweep of the tree's own `.tsx` for a Title Case `label:` literal, which is where Photos' Title Case lived. **R-KIT-4 is closed.** Each sweep also pins the app's own residue claims (the kind tables, the count grammar, the apostrophe, the route titles), so a fix cannot silently regress into a copy table.

**S14.** No new engine vocabulary reached member copy in these four trees; round 2 closed Photos' six sites and `RoomError.detail` takes none of them. `tally-store.ts`'s `readError` still stores `error.message`, and **nothing renders it** — see the register below.

**Tint.** `identity-tint 0` on the baseline and 0 after. Tally's hand-rolled chips (tally/findings #7) were already on `bgSel`/`lineSel` rather than an indigo ground before this wave. One `--net` misuse was a tint defect and is fixed: People painted the `Upcoming` birthday count in `colors.net`, the same red the app spends on overdue and on the read-only refusal.

**S15 haptics.** Adopted at the three moments and nowhere else. `hapticSelect()` on band select in all four app bands (mirroring `HomeBand`); `hapticMode()` once when a long-press drag puts the Photos grid into selection, never again as the same drag sweeps on; `hapticLanded()` needs no app call — every destructive confirm in these four apps goes through the kit's `useConfirmDestructive`, which fires it. Three off-contract direct calls are deleted: a successful backup's success buzz, a favorite toggle's tick, and a tick on every tap that added a photograph to a selection already under way. `grep -rn "expo-haptics" apps/mobile/src/apps/{tally,locker,people,photos}` → two matches, both `hapticsStub()` seams in stub-tier tests.

**A11y.** People's collapse caret was the literal characters `−` and `+` and its starred filter chip's whole accessible name was `★`; both are words or kit glyphs now. Photos' tiles announced a bare filename while painting a red `could not decode` line — `tileLabel()` appends every state the tile draws, so the one member who cannot see the red is told. Locker's `Forget this vault's key` had no guard at all and now takes the kit confirm with an `accessibilityState`-carrying outlined verb.

### Residue register — every finding not closed by Waves 0–2

**Tally** (`tally/findings.md`)

| finding | closed by | or reason left |
| --- | --- | --- |
| #1 no way to add an expense | `be8287400` (Wave 1, B2) | |
| #2 settle opens invalid · bank line printed twice | `aec968bcb` | |
| #3 Export from More is permanently empty | `aec968bcb` | |
| #4 `Remove` beside "cannot be removed" | `aec968bcb` | |
| #5 dates as raw ISO | output `d40637786` (Wave 2, S8); input `aec968bcb` | |
| #6 placeholder reads as a filled value | `aec968bcb` | |
| #7 a hue on a chip | — | already false: `TallyChips` lights on `bgSel`/`lineSel`, and `identity-tint` is 0 |
| #8 detail screens do not name their subject | — | **left**: `PushedPage` has no subject slot and the room owns the header (R-B-9, Wave 2 slice 3). A room prop for it is a kit change; raised to the root |
| #9 dead rows in Activity | `aec968bcb` | |
| #10 counts disagree with the rows | `aec968bcb` | |
| #11 category case flips | `aec968bcb` | |
| #12 Tally's roster is a second, shorter People | — | **left**: a merge flow for Tally friends is a product feature, not a consistency fix. Out of this umbrella's scope |
| #13 Groups tab is Balances' section plus an empty one | — | **left**: deleting a band destination is a band-shape decision; raised to the root |
| #14 no loading state | — | **left**: `SkeletonRows` adoption across ten Tally routes is its own slice, not copy work |
| #15 search capitalises and autocorrects | `aec968bcb` (the kit's `SearchField`) | |
| #16 no pending-changes pill | — | **left**: mounting `ReplicaStatusBar` in a third app is a replica-surface decision; raised to the root |
| #17 composers discard silently | — | **left**: D3 rules autosave everywhere and "close = done", which is the opposite of a discard prompt. Superseded by the ruling |
| #18 section metas wrap and break the baseline | — | **left**: `TallyParts.Section` geometry, not copy; a layout slice |

**Locker** (`locker/findings.md`)

| finding | closed by | or reason left |
| --- | --- | --- |
| #1 nothing stores the vault key, so Locker never unlocks | — | **left**: enrolment is a product capability with no seat on this phone. The dead `offer` styles it left behind are deleted here |
| #2 the wall states the opposite of what it just said | earlier wave | `DEVICE_NOTE` and the forget verb are both conditional on `!notEnrolled` |
| #3 forget key: no confirm, no feedback | `94951d4ae` | |
| #4 four buttons in one non-wrapping row | `94951d4ae` | |
| #5 three search behaviours | `aec968bcb` + `db5141839` | keyboard contract is one across all three apps now. Locker still SUBMITS where the others search live, which its own comment justifies: matching is server-side over fields the payload never returns |
| #6 two names for the root · `Add / edit` | `94951d4ae` | |
| #7 prose in the monospace register | `94951d4ae` | sixteen files; numerals, timestamps and the sealed run keep `mono` |
| #8 a fifth confirm pattern | `eec6fe36b` (Wave 2) | |
| #9 labels and notes typed at the call site | `94951d4ae` | |
| #10 mixed apostrophes | `94951d4ae` | |
| #11 `SectionBlock` as a form field label | `94951d4ae` | |
| #12 no haptics | haptics commit | band select only: a reveal boundary is not one of the three moments the channel names |

**People** (`people/findings.md`)

| finding | closed by | or reason left |
| --- | --- | --- |
| #1 the editor cannot represent the person it edits | — | **left**: minting a chip for a stored value the set cannot express is a control change in `PersonEditor`, not copy; raised to the root |
| #2 two `Save` buttons, opposite validation | — | **left**: D3 rules autosave everywhere, which makes both `Save` buttons a question the ruling reopens. Raised to the root rather than fixed under a superseded shape |
| #3 `Trash` the place and `Trash` the act | `0c9648d5a` | |
| #4 `Shared with them` needs two taps | `0c9648d5a` | |
| #5 search fights the query | `db5141839` (Wave 2, S4) | |
| #6 every pushed screen untitled | `53d4f2933` (Wave 2) | |
| #7 the channel `✕` destroys with no confirm | earlier wave | the word, through `PeopleConfirm` |
| #8 birthdays painted `--net` and "upcoming" at 338 days | `0c9648d5a` (the hue) | the 30/60-day bound on the section is a query change, left |
| #9 four iconography systems | `0c9648d5a` (caret, chip) | the hand-rolled star is **left**: `kit/Icon` is stroke-only and cannot express the filled/unfilled state the star carries. Raised to the root |
| #10 header verbs vanish · one filter for two rails | — | **left**: both are `PeopleHome` state and header shape, not copy; raised to the root |
| #11 `1 of 7 match` | `0c9648d5a` | |
| #12 raw vault vocabulary as UI copy | `0c9648d5a` | |
| #13 Merge's RESULT rows inverted | `0c9648d5a` | both seats |
| #14 `Log a touch` selects the wrong band tab | Wave 2 rooms | `LogTouch` no longer writes `current` |
| #15 filter chips announced as tabs | — | **left, and NOT this lane's**: `kit/components/ChipsBlock.tsx` is the kit lane's file; the `★` half is closed here. Raised to the root |
| #16 no haptics | haptics commit | band select |

**Photos** (`photos/findings.md`)

| finding | closed by | or reason left |
| --- | --- | --- |
| #1–#7, #10–#12, #17, #19 | Waves 1–2 (`bd3c77c51`, `773ee9bc9`, `62fc18ac4`, `977de0a83`) | |
| #8 two Englishes and three cases | labels `bd3c77c51` (D2); identifiers `deade19aa` (**R-B-5**) | |
| #9 internal vocabulary on member surfaces | `deade19aa` — `replica`, `Photo vault`, `Asset id` | `Nothing typed` **left**: Docs, Notes and `_shared/SearchScaffold` all print it, so a one-app fix trades a copy defect for a cross-app inconsistency. Recorded in `view-copy.ts` beside the string; raised to the root |
| #13 search auto-capitalises · two Clears | Wave 2 (`SearchField`) | |
| #14 place tiles all read `A place with n…` | — | **left**: `places-model.ts` names a place from its own facts; a real name needs a reverse-geocode the seat does not have. Raised to the root |
| #15 the 30-day rule three times | — | **left**: three surfaces (header subtitle, body line, per-tile plate) each state it for a different reader; choosing which two to drop is an owner call. Raised to the root |
| #16 More's footer is untrue | `deade19aa` | the band slot itself is left: deleting a destination is a band-shape decision |
| #18 tile labels are raw filenames · a failed tile never says so | `deade19aa` (the state half) | the NAME half is **left**: `PhotoAsset` carries no caption, so `filename` is the only name a tile has, and whether it is descriptive is a fact about the file |
| #20 `PhotosBand` re-declares two kit tokens | `deade19aa` | |

### Files

- **Tally** — `apps/mobile/src/apps/tally/{ActivityView,TallyAddScreen,TallyChips,TallyExpenseScreen,TallyGroupScreen,TallyHome,TallySearchScreen,TallySettleScreen,TallySurfaceScreen,TallyBand}.tsx`, `ActivityView.test.tsx`, `PendingRestartJourney.test.tsx`, new `tally-copy-case.test.ts`; `packages/blueprints/apps/tally/{compose-copy,draft-model,spending-model,types,view-copy}.ts`, `draft-model.test.ts`, `spending-model.test.ts`, `components/{AddExpense,Screens}.tsx`, new `category-labels.ts`.
- **Locker** — `apps/mobile/src/apps/locker/{LockerAccessView,LockerEditScreen,LockerExportView,LockerFields,LockerGenView,LockerImportView,LockerItemScreen,LockerItemsView,LockerMoreSheet,LockerNotice,LockerReviewView,LockerRow,LockerScanSheet,LockerScreen,LockerSearchView,LockerSurfaceScreen,LockerTrashScreen,LockerBand}.tsx`, `locker-places.ts`, `locker-places.test.ts`, `locker-seat-copy.ts`, new `locker-copy-case.test.ts`; `packages/blueprints/apps/locker/{route-copy,view-copy}.ts`.
- **People** — `apps/mobile/src/apps/people/{MergeView,PeopleHome,PeopleKit,PersonView,PeopleBand}.tsx`, new `people-copy-case.test.ts`; `packages/blueprints/apps/people/people-copy.ts`, `components/MergeRoute.tsx`, `states.test.tsx`.
- **Photos** — `apps/mobile/src/apps/photos/{PeopleEmptyState,PhotoInfoSheet,PhotoLightboxToolbar,PhotoTile,PhotoTimeline,PhotosBand,PhotosHome,PhotosPeopleView,PhotosSearch,PhotosSearchRestingState}.tsx`, `photos-band.ts`, `tile-overlays.ts`, `tile-overlays.test.ts`, `photos-copy-case.test.ts`, `PhotosMoreSheet.test.tsx`, `PhotosScreen.test.tsx`, `PhotosHome.test.tsx`, `PeopleEmptyState.test.tsx`, `PhotosPeopleView.test.tsx`; `packages/blueprints/apps/photos/{app.json,enrichment-consent.ts,enrichment-gate.ts,selection.tsx,shelves.ts,view-copy.ts}`, `enrichment-consent.test.ts`, `components/{People.tsx,People.test.tsx}`.

### Judgement calls, visible in the diff

- **`shelves.ts` stopped type-importing through a React component.** Reaching Photos' `view-copy` from the phone meant reading `shelves.ts`, which type-imported `SelectionShelfKind` from `components/SelectionBar.tsx` — a web component that pulls a CSS module the native program has no declaration for. The type already lived in the pure `_shared/selection-engine.ts`; both readers import it from there now. A shelf table is read by both seats and may not depend on either one's renderer.
- **Tally's `expense_id` was in the payload and not in the type.** `queries/activity.ts` has carried it since #872; `ActivityRow` never declared it, which is the whole of why the feed's rows could not open the expense they name. The declaration is the fix, not a new read.
- **A refusal waits for the member's first touch, and the commit stays disabled throughout.** Nothing can be committed on the strength of a hidden refusal — pressing the disabled commit reveals it.
- **`ConfirmSheet` fires `hapticLanded()` when the member presses the verb, not when the write lands.** That is the kit's file and the kit lane's call; noted for the root rather than changed from an app lane.

### Verification, from the lane worktree

1. `cd apps/mobile && bunx vitest run src/apps/photos src/apps/people src/apps/locker src/apps/tally src/kit` → **168 files, 1507 passed, 0 failed**. Blueprints: `bunx vitest run packages/blueprints/apps/{tally,locker,people,photos}` → **65 files, 925 passed**.
2. `bun run --cwd apps/mobile typecheck` → **0**.
3. `node scripts/lint-mobile-rooms.mjs` → `screen-root 153`, `back-literal 15`, `page-margin 93`, `identity-tint 0`, `copy-title-case 0`. Over this lane's four trees: `back-literal 0`, `identity-tint 0`, `copy-title-case 0`, `page-margin 2` — both the same ruled `paddingHorizontal: 3` chip inset in `PhotoTile.tsx` (R-B-6, sub-base, not a page gutter).
4. `grep -rn "expo-haptics" apps/mobile/src/apps/{tally,locker,people,photos}` → **2**, both `hapticsStub()` device seams in stub-tier tests; no app source imports it.
5. `node scripts/lint-mobile-design.mjs && node scripts/lint-container-opacity.mjs && node scripts/lint-aria-labels.mjs && node scripts/lint-mobile-testids.mjs` → **all four ok**.
6. `bun run format` then `bun run check:push:static` → **4/4**.
7. `node .governance/law/run.mjs --brief-digest 514cb2fed327` → see below.

## Wave 3 round 2 — lane APPS-B: three rulings, and what the owner still holds

Three commits, one ruling each: `1ef57b0dc` R-B-15 (the resting search eyebrow) · `42812b1f4` R-B-16 (`Icon`'s fill, and People's hand-rolled star) · `27c424a63` R-B-18 (`hapticLanded()` at the write's resolution).

**R-B-15 — one eyebrow, in the app's own noun.** `Nothing typed` was a state report printed as signage, and the previous round left it in place on the ground that fixing one app would trade a copy defect for a cross-app inconsistency. It is fixed in the shared source instead: `_shared/search-scaffold.ts` gains `searchRestingEyebrow(noun)` — "Search your photos" — and `SearchStateCopy.resting.eyebrow` is **deleted from the type**, so a seat supplies only its plural noun and cannot type a state report back in (v0, no compat field). Five seats came into line, not three: Docs (`documents`), Notes (`notes`), Photos (`photos`) all said `Nothing typed`; Tally (`expenses`) and Locker (`keys`) said `Search`, which is the same defect in a shorter word. Both mobile surfaces that printed the eyebrow themselves — `PhotosSearchRestingState.tsx` and `TallySearchScreen.tsx` — now call the shared helper. Closes photos/findings #9's last half, and the same string on Docs and Notes.

**R-B-16 — filled is the icon's contract.** `kit/Icon` takes `fill`: one tone, the glyph's own stroke ink, because there is no second fill colour in the system. The rule lives in `icon-fill.ts` for the reason `icon-stroke-width.ts` does — no `react-native-svg` or theme import, so the node tier asserts it directly. Two defaults keep every existing glyph exactly where it is: `fill` is off, and a registry path that already declares `fill: "currentColor"` (`Compass`'s needle) still fills unasked. People's `StarButton` drew its own `<Svg>` at stroke 1.5 over a path that was **not** the registry's `Star`; it is deleted, and the row draws the house glyph, filled when starred. Closes people/findings #9's last half.

**R-B-18 — the buzz belongs to the write.** `ConfirmSheet` fired `hapticLanded()` inside the press handler, before `onConfirm` ran: it promised "the thing is gone" while the vault was still being asked, and buzzed just as confidently when the write failed. `onConfirm` may now return `Promise<void>`, and the buzz rides its resolution — never its rejection, which the caller surfaces on StatusLine itself. Two tests in `ConfirmSheet.test.tsx` fail on the old ordering and pass on the new one (measured: reverting the handler turns both red). This supersedes the "noted for the root rather than changed from an app lane" judgement call in the section above.

### Files

- `packages/blueprints/apps/_shared/{search-scaffold.ts,SearchScaffold.tsx,SearchScaffold.test.tsx}`
- `packages/blueprints/apps/docs/drive-copy.ts`, `packages/blueprints/apps/notes/view-copy.ts`, `packages/blueprints/apps/photos/view-copy.ts`, `packages/blueprints/apps/tally/view-copy.ts`, `packages/blueprints/apps/locker/route-copy.ts`
- `packages/blueprints/src/search-scaffold-reach.test.ts`
- `apps/mobile/src/apps/photos/{PhotosSearchRestingState.tsx,PhotosHome.test.tsx}`, `apps/mobile/src/apps/tally/TallySearchScreen.tsx`
- `apps/mobile/src/apps/people/PeopleKit.tsx`
- `apps/mobile/src/kit/components/{Icon.tsx,Icon.test.tsx,ConfirmSheet.tsx,ConfirmSheet.test.tsx}`, new `apps/mobile/src/kit/components/icon-fill.ts`

### What the owner still holds — the four apps' residue, with a recommendation each

Every row below is left deliberately; none is a defect this lane could close without making a product or kit decision that is not its to make.

| item | what it is | recommendation |
| --- | --- | --- |
| **R-B-17a** · tally #13 | Groups is a band destination holding Balances' own section plus an empty one | **Delete the tab.** Four destinations is the band's shape everywhere else, and a destination that restates a section teaches a member the app has two answers |
| **R-B-17b** · photos #16 | Photos' More slot, whose footer claimed destinations that are not there (the footer is fixed; the slot is not) | **Keep the slot, drop nothing.** Photos genuinely has more places than a band holds; the fix already landed is the honest footer |
| tally #8 | detail screens do not name their subject | `PushedPage` owns the header and has no subject slot. **A kit prop** (`subject`, under the title) is the fix; it is a kit-lane change, and it would serve Locker's item screens too |
| tally #14 | no loading state on ten Tally routes | **`SkeletonRows` adoption as its own slice.** Not copy work; each route needs its own row shape |
| tally #16 | no pending-changes pill | Mounting `ReplicaStatusBar` in a third app is a **replica-surface decision** (which apps show the pill at all), owed a ruling before adoption |
| people #1 | the editor cannot represent the person it edits — a stored channel kind the chip set cannot express | **Widen the chip set from the stored vocabulary**, in `PersonEditor`; a control change, and it needs the owner's view on which kinds are member-facing |
| people #2 | two `Save` buttons with opposite validation | D3 (autosave everywhere, close = done) **supersedes the shape**, so the fix is to delete both buttons, not to reconcile them. That is a People editor rewrite |
| people #10 | header verbs vanish · one filter serves two rails | `PeopleHome` state and header shape. **Own slice**; the filter's second rail needs a product answer about what it filters |
| people #15 | filter chips announced as tabs | `kit/components/ChipsBlock.tsx` — **the kit lane's file**, not this one's. The `★`-as-a-name half is already closed |
| photos #14 | place tiles all read `A place with n…` | A real name needs a **reverse-geocode the seat does not have**. Either ship the lookup or accept the honest generic name |
| photos #15 | the 30-day rule stated three times | Three surfaces each state it for a different reader. **Owner call** on which two to drop; the header subtitle is the one I would keep |
| tally #12, #17, #18 · locker #1, #5, #12 · photos #18 | recorded in the Wave 3 register above with their reasons; unchanged | — |

`tally-store.ts:192`'s dead `readError` is **APPS-A's** lane-wide `surfaceWriteFailure` sweep (R-A-15), and `packages/blueprints/apps/docs/view-copy.ts`'s apostrophes are theirs too; neither is touched here.

**One more, found this round and not in any findings file.** No caller of `useConfirmDestructive` in these four trees can yet return a landing-truthful promise: `confirmFreeSpace` and `runTrash` catch their own failure and resolve either way, and `writeReason` resolves **with** the refusal string. Returning any of them today would re-create exactly the false buzz R-B-18 removes. The primitive is correct and the contract is documented; adopting it per caller means giving each write an honest resolution first, which is a slice of its own.

### Verification, from the lane worktree

1. `cd apps/mobile && bunx vitest run src/apps/photos src/apps/people src/apps/locker src/apps/tally src/kit` → **171 files, 1541 passed, 0 failed**.
2. `bun run --cwd apps/mobile typecheck` → **0**.
3. `node scripts/lint-mobile-rooms.mjs` → `screen-root 124`, `back-literal 0`, `page-margin 2`, `identity-tint 0`, `copy-title-case 0`. The two `page-margin` findings are the same ruled sub-base `paddingHorizontal: 3` chip inset in `PhotoTile.tsx` (R-B-6).
4. `grep -rn "expo-haptics" apps/mobile/src/apps/{tally,locker,people,photos}` → **3**, all test seams or a comment about one; no app source imports it.
5. `node scripts/lint-mobile-design.mjs && node scripts/lint-container-opacity.mjs && node scripts/lint-aria-labels.mjs && node scripts/lint-mobile-testids.mjs` → **all four ok**.
6. `bun run format` then `bun run check:push:static` → **4/4**.
7. Blueprints: `bunx vitest run packages/blueprints/apps/{tally,locker,people,photos,docs,notes,_shared} packages/blueprints/src` → **191 passed, 3 failed**. All three are **inherited from the umbrella base**, measured failure-for-failure by detaching this worktree at `6924fb797` and rerunning the same three files (`3 failed | 12 passed` there and here): `src/photos-vocabulary.test.ts` (`PHOTOS_ERROR_FREE_UP_PAUSED`'s storage noun), `src/one-computation.test.ts` (`kit: subscribeStatus,subscribeVitals ↔ subscribeStatusHost`), `src/pending-projection-tripwire.test.ts` (Docs' action count 15 → 16, which is D1's Empty trash). None is in this lane's slice and none is touched here.
## Lane SHELL, final round — the last merge, one noun for the place, and the ratchet at its floor

Commits `95e38b8b8` (merge), `305dd80a5` (R-SH-8), `e24d9cf6c` (R-SH-10 + baselines).

### What changed

**The merge (`95e38b8b8`).** `umbrella/1015-mobile-ux` at `6924fb797` (APPS-A Wave 3 and APPS-B Wave 3) into `lane/1015-kit`. One conflict, `apps/mobile/src/kit/rooms/PushedPage.tsx`: this lane's `footer` and `overlay` against the app lanes' `backTestID`, `chrome` and `lockup`. Resolved as a union — one definition per prop, nothing renamed, every test kept. `overlay` had been declared on both sides; the duplicate is gone and the surviving declaration is the app lanes' (its comment says why a presentation mounts outside `RoomBody`). In the JSX, `{footer}` stays a sibling directly under the body and `{overlay}` stays LAST, after the band: a modal that renders before the band is a modal the band can paint over.

**R-SH-8 — the place is Rules (`305dd80a5`).** Option (a) of the question this lane raised at Wave 3. `apps/mobile/src/screens/home/places.ts`: `autos.name` "Automations" → "Rules" (`short` was already "Rules"), and `what` re-worded so the row does not repeat its own name. `SHORT_NAME_DIVERGENCES` — the register that wrote the exception down — is DELETED, and `apps/mobile/src/screens/shell-copy.test.ts` now asserts the invariant unconditionally: a `short` may drop words from `name`, never swap one in, with no allowlist to consult. `apps/mobile/src/screens/home/places.test.ts` pins `name` as well as `short`.

The screen followed: `apps/mobile/src/apps/automations/Automations.tsx` (both `title=`, the error `eyebrow=`, the `SectionBlock label=`, the `RowsBlock accessibilityLabel=`), `apps/mobile/src/apps/assistant/assistant-companion.ts` (`PAGE_LABELS`), and the feature-off wall in `apps/mobile/src/lib/replica/mobile-gateway-compatibility-core.ts` ("Rules are off"), which is member copy and not a wire fact ([decisions.md#one-vault-every-seat-996](../docs/decisions.md#one-vault-every-seat-996) — one replica contract, seat-local signage). `apps/mobile/src/apps/automations/Automations.test.tsx` asserts the screen says "Rules" and NOT "Automations".

The wire capability flag, the route key, the deep-link path and the module name stay `automations`. Those are identifiers; renaming them is churn with no member on the other end.

**R-SH-10 and the ratchet (`e24d9cf6c`).** Twenty-one rulings that existed only in merge-commit bodies are rows in `docs/decisions.md` → `## Mobile UX consistency (#1015)` → **Later rulings**: R-A-8..R-A-20, R-B-15..R-B-18, R-SH-8, R-SH-9, R-SH-10.

`scripts/lint-mobile-rooms.baseline.json` re-measured on this head, after every lane merged:

| Rule | Wave 3 baseline | Now | Owner |
| --- | --- | --- | --- |
| `screen-root` | 56 | **33** | #1015, unclosed — Locker (6), People (6), Photos (9), Tally (12). The shell, Agenda, Docs and Notes are at 0. |
| `page-margin` | 93 | **2** | **Nobody.** Both are `PhotoTile.tsx`'s `paddingHorizontal: 3`, the sub-base exceptions ruled at Wave 3. This entry is an allowlist wearing the ratchet's shape, and the file says so. |
| `error-detail` | 13 | **12** | #1015 R-A-15, ruled and not landed — Docs (2), Locker (4), Photos (5), Tally (1). |
| `back-literal` | 15 | **0 — entry deleted** | Closed. |
| `identity-tint` | (absent) | **0** | Closed. |
| `copy-title-case` | (absent) | **0** | Closed. |

A rule absent from the file is at zero and unconditional, so deleting `back-literal` is the ratchet tightening, not loosening. Each of the six rules was checked with a planted violation under `--enforce`: `back-literal` (`backTo="All"`), `identity-tint` (`<Button appIdentity>`), `copy-title-case` ("Empty Trash Now" in a `*copy*.ts`), `page-margin` (a 19th `paddingHorizontal`), `error-detail` (a `detail:` taking `error.message`), `screen-root` (`AgendaHome`'s root swapped to `<View>`). All six failed the gate; every plant was reverted.

### Not done, and why

- **R-SH-9 (`kit/member-error.ts` dies) — SKIPPED, as the brief instructs.** It waits on R-A-15, and R-A-15 has not landed: `apps/mobile/src/kit/replica/write-outcome.ts:101` still reads `error instanceof Error ? error.message : …`. Five callers remain (`kit/transfer/backup-verdict.ts`, `kit/transfer/transfer-queue.ts`, `screens/home/origin-health.ts`, `apps/insights/Insights.tsx`, `apps/insights/GatewayAlerts.tsx`), so deleting the module now would delete a filter that is still the only thing lowering engine vocabulary on those five paths.
- **The ITEM noun is still "automation".** R-SH-8 renamed the DESTINATION. The row's noun is untouched in `apps/mobile/src/apps/automations/{Automations.tsx,AutomationThread.tsx,automations-model.ts}` and `apps/mobile/src/screens/approvals/approvals-model.ts:131`, and one of its sentences — `AUTOMATIONS_EMPTY_BODY`, "An automation is a trigger and a thing to do." — lives in `packages/client/src/.../automations-copy.ts`, shared with the desktop overview, which names the whole place "Automations" (`packages/client/src/react/shell/launcherModel.ts`: `label: "Automations"`, `shortLabel: "Autos"`). Renaming half a shared pool is worse than the divergence. Owner item, with the sites above.
- **`DESTINATION_MARKS.automations` was NOT renamed.** `packages/design/src/destinations.ts` types the key as "a place named the way a member would name it", so it does name it — but both seats map their own place onto that key and the desktop's word is still "Automations". Out of this lane's ruled diff scope and an owner item, not a silent choice.
- **`docs/design-divergences.md` gained no row for any of the above.** A divergence a lane would keep gets an explicit question to the owner, not a register row that reads as settled.

### Files

- `apps/mobile/src/kit/rooms/PushedPage.tsx` (merge resolution)
- `apps/mobile/src/screens/home/places.ts`, `apps/mobile/src/screens/home/places.test.ts`, `apps/mobile/src/screens/shell-copy.test.ts`
- `apps/mobile/src/apps/automations/Automations.tsx`, `apps/mobile/src/apps/automations/Automations.test.tsx`
- `apps/mobile/src/apps/assistant/assistant-companion.ts`
- `apps/mobile/src/lib/replica/mobile-gateway-compatibility-core.ts`
- `docs/decisions.md`
- `scripts/lint-mobile-rooms.baseline.json`

### Verification, from the lane worktree

1. `cd apps/mobile && bunx vitest run src/screens src/kit src/apps/automations src/apps/assistant src/lib/replica/mobile-gateway-compatibility` → **108 files, 941 passed, 0 failed**.
2. `bun run --cwd apps/mobile typecheck` → **0**.
3. `node scripts/lint-mobile-rooms.mjs` → `screen-root 33`, `back-literal 0`, `page-margin 2`, `identity-tint 0`, `copy-title-case 0`, `error-detail 12` — 47 over 594 files. `--enforce` → **pass**.
4. `grep -rn "expo-haptics" apps/mobile/src` → no product source; only `kit/haptics.ts`, `src/test/native-device-seams.ts` and stub-tier test mocks. `apps/tasks/tasks-haptics.test.ts`'s SABOTAGE case holds it.
5. `node scripts/lint-mobile-design.mjs && node scripts/lint-container-opacity.mjs && node scripts/lint-aria-labels.mjs && node scripts/lint-mobile-testids.mjs` → **all four ok** (`lint-mobile-testids` was red on the base at Wave 2 and is green here).
6. `bun run format` then `bun run check:push:static` → **4/4**.
7. `bun run lint:product` → **38/43**. `lint:mobile-rooms` passes. Five red, none of them this umbrella's: `lint:no-nul-bytes` (`packages/server/src/preview/fixtures/hevc-photo.heic`), `lint:quality-knobs` (stale fingerprints for `packages/server/src/automation/manifest/manifest.ts`, `packages/server/src/serve/health-registry.ts`), `lint:e2e-wiring` (`mobile-volume-proof` claimed by the ledger and scheduled by no lane) — none of those four files is touched between `main` and this head — plus `lint:hairline` (`apps/mobile/src/apps/photos/PhotosChoiceSheet.tsx:87` uses `hairlineWidth`, arrived with APPS-B's `62fc18ac4`) and `check:ui-receipt`, which is the umbrella's own PR-window gate and needs a screenshot from a changed e2e harness — no lane has a simulator.
8. `node .governance/law/run.mjs --brief-digest 514cb2fed327` → **10 rules, 0 errors, 1 warning** — `estate-separation`, unchanged in kind since Wave 4 and now larger: the umbrella edits `scripts/ci/gate-classes.json` (law) and 430 territory files in one PR. It is the root's to waive or split.
9. `bunx vitest run src/lib/replica/expo-seat-driver.test.ts` → **red on the base**: "Flow is not supported" parsing `node_modules/react-native/index.js` under the stub-tier project. The file is byte-identical to `main`, as are `vitest.config.ts` and `vitest.projects.ts`; re-running it with `main`'s copy of the one `lib/replica` file this lane touched reproduces the failure exactly. Inherited, measured, not fixed.

## Lane SHELL, closing round — one item noun, the ratchet at its floor, and the umbrella reconciled

Commits `80d1e893c` (R-SH-11 + R-SH-12), `62ce3c980` (R-SH-13), and this docs pass. This is the last section of the run.

### What changed

**R-SH-11 — the item noun is "rule", on both seats (`80d1e893c`).** R-SH-8 named the PLACE Rules and left its rows called automations; a place named one thing whose contents are called another is the divergence this umbrella exists to end, and it was the last one standing. The noun is now "rule" everywhere a member reads it:

- `apps/mobile/src/apps/automations/automations-model.ts` — the count sentence, the two failing labels, both gateway detail lines.
- `apps/mobile/src/apps/automations/AutomationThread.tsx` — both error nouns ("This rule could not be read", "This rule did not run. Try again.").
- `apps/mobile/src/apps/automations/Automations.tsx` — the no-runs note, the two `accessibilityLabel`s ("Reading your rules", "Filter rules"), the filtered-empty note.
- `apps/mobile/src/screens/approvals/approvals-model.ts:131` — `callerPhrase` says "the rule <name>".
- `apps/mobile/src/apps/insights/insights-model.ts` and `packages/client/src/react/format.ts` — the run-kind label is "Rule" on both seats.
- `packages/client/src/automations-copy.ts` — `AUTOMATIONS_EMPTY_BODY` is "A rule is a trigger and a thing to do."; `packages/client/src/approvals-copy.ts` — `APPROVALS_DENY_SUB`; `packages/client/src/insights-copy.ts` — `INSIGHTS_EMPTY_BODY`. Fixed at the source, which is what the previous round said the fix had to be: renaming half a shared pool is worse than the divergence.
- `packages/client/src/react/shell/launcherModel.ts` — `label: "Rules"`, and `shortLabel: "Autos"` is DELETED (a short form exists to drop words from a name; "Rules" has none to drop). `packages/client/src/react/shell/opsBar.ts` — `title: "Rules"`, `commit: "New rule"`. `packages/client/src/access-lens.ts` — the principal group. `packages/client/src/react/screens/AutomationsOverviewScreen.tsx` — the desktop overview's four count sentences.

**Copy only.** `automations` is untouched as the wire capability flag, the route key, the deep-link path, the module names, the file names, the persisted pin key and the test ids. No member reads any of them.

**The sweep.** `apps/mobile/src/screens/shell-copy.test.ts` gains two cases: no SENTENCE (a string literal containing a space, with comments stripped) in the four shell trees or the five shared copy modules may say "automation"; and the three shared constants are asserted as VALUES, so a re-export cannot hide a rename. Proven red before green — restoring "An automation is a trigger and a thing to do." turns both cases red, and the sentence heuristic is what lets `case "automation-thread":`, `sourceType === "automation"` and `featureOffEmpty("automations")` stay exactly as they are.

**R-SH-12 — `DestinationConcept`'s keys are ids, decided from the evidence (`80d1e893c`).** The key stays `automations` and the type comment is re-worded. The comment claimed "a place named the way a member would name it", and that was the drift: three of the twelve keys already diverge from what the surfaces print (`analytics` is "Activity", `data` is "Vault", `devices` is "Household"), every use in both seats is a static property lookup, and nothing dynamic or persisted keys off the string. Renaming it would have made one key agree with one seat's word while the family's contract stayed "id". `packages/design/src/destinations.ts` now says so, and names where the label does live.

**R-SH-13 — the container-opacity budgets take the measured value (`62ce3c980`).** `packages/client/src` 21 → 13, `packages/blueprints` 4 → 2, `packages/design/src/elements` 12 → 3, each read off `node scripts/lint-container-opacity.mjs`, which had been printing the "lower the budget to N" note for all three. Nothing was reclassified and no exception was added; the room wave and the kit's leaf-token disabled state removed the fades the numbers were holding room for. The gate's own header asks for exactly this when a change removes counted occurrences — a budget lowered to the measurement is the ratchet, not policy weakened to go green.

### The issue's checklist, box by box

**Owner decisions D1–D6** — all six ruled by the owner on 2026-09-10 and recorded in [docs/decisions.md § Mobile UX consistency (#1015)](../docs/decisions.md#mobile-ux-consistency-1015). **Ticked.**

**Wave 0 (B1–B15)** — B1–B15 all landed across the lanes. **The wave's own exit is NOT met**: only one Maestro flow was added in this umbrella (`tests/agent-e2e-mobile/flows/agenda-week.{md,mjs}`), not one per blocker. No lane had a simulator, and the run ended before an e2e wave. **Unticked, and the reason is the tooling, not the fixes.**

**Wave 1 (S2, S3, S4, S5, S6, S8, S9, S10, S12, S13)** — all ten landed. Its exit — "a story in the mobile gallery and a parity test" — is met on the parity half only; **no mobile screens gallery exists**. See Wave 4 below.

**Wave 2 (S1, the three migration lines, S7, selection, editors)** — all landed. Its exit, "grep finds zero hand-rolled headers, back controls or search fields; every screen root is a room", is met for back controls (`back-literal 0`) and search (one `SearchField`), and **NOT for screen roots: `screen-root` stands at 33** — Locker 6, People 6, Photos 9, Tally 12. Ratcheted in `scripts/lint-mobile-rooms.baseline.json`, unclosed, owner-visible. **Partly ticked.**

**Wave 3 (S11, S14, tint, S15, a11y, per-app residue)** — all six landed. Its exit — "a re-run of the audit brief over one simulator reports zero majors" — **was never run**: no lane had a simulator and the owner ended the run after Wave 4. **Unticked.**

**Wave 4 (five lint boxes + the docs pass)** — the two lint boxes are one gate, `scripts/lint-mobile-rooms.mjs --enforce`, wired into `bun run lint:product`: hand-rolled screen roots, `backTo` literals, `pageMargin` literals, identity tint on a control, Title Case in copy tables, and an exception rendered as member copy. Each of the six rules was verified with a planted violation. Blueprint copy tables are swept per app (`apps/mobile/src/apps/*/*-copy-case.test.ts`, eight of them). The docs pass is this section plus `95e66952d`. **The mobile screens gallery box is NOT done** — `design:gallery` has no mobile lane and the room lint took its place as the drift detector; a gallery is a screenshot harness and needs a simulator. **Four of five ticked.**

### Every finding id — where its row lives, and what is still open

Each app's id-level ledger is already in this receipt; this is the roll-up over all 173. "Partly" means a named half closed and the rest is in the app's own row with its reason.

| App | ids | closed (incl. partial) | still open |
| --- | --- | --- | --- |
| shell (24) | ledger above, "Findings ledger — `shell/findings.md`, every id" | 20 | 7, 8, 9, 19 |
| agenda (22) | "Agenda — `dc630f916`" | 16 | 9, 11, 12, 13, 14, 15 |
| tasks (23) | "Tasks — `1813e2d26`" | 6 | 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 17, 18, 20, 21, 22 |
| notes (19) | "Notes — `4c7b101fa`" | 9 | 3, 4, 8, 10, 11, 12, 13, 14, 17, 19 |
| docs (19) | "Docs — `d7c200566`" | 11 | 4, 5, 6, 8, 9, 11, 15, 19 |
| photos (20) | APPS-B residue register | 18 | 14, 15 |
| people (16) | APPS-B residue register | 12 | 1, 2, 10, 15 |
| tally (18) | APPS-B residue register | 11 | 8, 12, 13, 14, 16, 17, 18 |
| locker (12) | APPS-B residue register | 11 | 1 |
| **total** | **173** | **114** | **59** |

**One correction to a lane ledger.** `agenda/findings.md#10` (Agenda's search field is the only one without `autoCapitalize="none"`, `autoCorrect={false}`, `returnKeyType="search"`) appears in no lane's table — the one gap in the nine ledgers. It is **closed**: `AgendaHome.tsx` passes a `search` prop to `AppPlace`, and the room renders `kit/components/SearchField.tsx`, which sets all three (lines 95, 96, 104). Counted as closed above.

Every open id above already carries its reason in its app's own row. None was silently dropped; the shapes are (a) behaviour or a feature, not a consistency fix; (b) a layout slice; (c) a kit change an app lane may not make; (d) an owner call about what the product should say or offer.

### Inherited red, measured on this head and not fixed

| Gate / test | What is red | Measured how |
| --- | --- | --- |
| `lint:no-nul-bytes` | `packages/server/src/preview/fixtures/hevc-photo.heic` | untouched between `main` and this head |
| `lint:quality-knobs` | stale fingerprints for `packages/server/src/automation/manifest/manifest.ts`, `packages/server/src/serve/health-registry.ts` | untouched between `main` and this head |
| `lint:e2e-wiring` | `mobile-volume-proof` claimed by the ledger, scheduled by no lane | untouched between `main` and this head |
| `lint:hairline` | `apps/mobile/src/apps/photos/PhotosChoiceSheet.tsx:87` uses `hairlineWidth` | arrived with APPS-B's `62fc18ac4`; **this umbrella's own, and open** |
| `check:ui-receipt` | the umbrella's PR-window gate; needs a screenshot from a changed e2e harness | no lane has a simulator |
| `apps/mobile` `src/lib/replica/expo-seat-driver.test.ts` | "Flow is not supported" parsing `node_modules/react-native/index.js` under the stub tier | file byte-identical to `main`; reproduced on a detached base |
| `apps/mobile` `src/apps/tasks/tasks-haptics.test.ts` | the SABOTAGE case expects `hapticLanded();` in `useConfirmDestructive.tsx` | reproduced by `git stash` on this head — red on the base, APPS-B's |
| blueprints `src/photos-vocabulary.test.ts` | `PHOTOS_ERROR_FREE_UP_PAUSED`'s storage noun | reproduced at `6924fb797` |
| blueprints `src/one-computation.test.ts` | `kit: subscribeStatus,subscribeVitals ↔ subscribeStatusHost` | reproduced at `6924fb797` |
| blueprints `src/pending-projection-tripwire.test.ts` | Docs' action count 15 → 16, which is D1's Empty trash | reproduced at `6924fb797` |

`lint:hairline` and `pending-projection-tripwire` are the two this umbrella caused; the other eight predate it.

### Docs verified against the tree as it now is

- **[docs/decisions.md](../docs/decisions.md)** — R-SH-11, R-SH-12 and R-SH-13 added to the #1015 later-rulings table, each dated with its reasoning. Every ruling this lane made is now in the table; R-SH-9 is the one row whose condition is unmet, and it says so.
- **[DESIGN.md](../DESIGN.md)** — § Copy gains **one noun per thing, and the same noun on every seat**: a short form may drop words, never swap one in; identifiers are exempt and are not copy; a shared copy module is fixed at the source. It names the sweep that holds it and the rulings behind it. The six-room table under Components (from `95e66952d`) still describes the tree exactly.
- **[docs/design-divergences.md](../docs/design-divergences.md)** — re-read in full; no row is made stale by this round, and no row is added. The one occurrence of "automations" in the file (§ Docs, "per-app automations" among what the deleted settings gear used to open) is the desktop's per-app automation packs, a different thing from the Rules place, and is correct as written.

### Files

`apps/mobile/src/apps/automations/{Automations.tsx,AutomationThread.tsx,automations-model.ts,Automations.test.tsx,automations-model.test.ts}`, `apps/mobile/src/apps/insights/{insights-model.ts,Insights.test.tsx,insights-model.test.ts}`, `apps/mobile/src/screens/approvals/{approvals-model.ts,approvals-model.test.ts,Approvals.test.tsx}`, `apps/mobile/src/screens/shell-copy.test.ts`, `apps/desktop/tests/e2e/{automations.spec.ts,appview-templates-insights.spec.ts}`, `apps/web/tests/e2e/settings-access.spec.ts`, `packages/client/src/{access-lens.ts,approvals-copy.ts,automations-copy.ts,insights-copy.ts}`, `packages/client/src/react/{format.ts,format.test.ts,screen-contracts.ts}`, `packages/client/src/react/screens/{AutomationsOverviewScreen.tsx,AutomationsOverviewScreen.test.tsx,InsightsScreen.test.tsx}`, `packages/client/src/react/shell/{launcherModel.ts,opsBar.ts,opsBar.test.ts,App.test.tsx,App.capabilities.test.tsx,StatusLine.test.tsx,routeVitals.test.ts,statusChannel.test.ts}`, `packages/design/src/destinations.ts`, `scripts/lint-container-opacity.mjs`, `docs/decisions.md`, `DESIGN.md`, `receipts/issue-1015-mobile-ux-consistency.md`.

### Verification, from the lane worktree

1. `cd apps/mobile && bunx vitest run src/apps src/screens src/kit` → **250 files, 2297 passed, 1 failed** — the one is `tasks-haptics.test.ts`, red on the base (table above). `bunx vitest run src/apps/automations src/apps/insights src/screens` → **37 files, 425 passed, 0 failed**.
2. `bunx vitest run` in `packages/client` → **275 files, 2479 passed, 0 failed**. `packages/design` → **32 files, 384 passed**.
3. `bun run --cwd apps/mobile typecheck` → **0**; `bun run --cwd packages/client typecheck` → **0**.
4. `node scripts/lint-mobile-rooms.mjs` → `screen-root 33 · back-literal 0 · page-margin 2 · identity-tint 0 · copy-title-case 0 · error-detail 12`, 47 over 594 files — unchanged from the previous round, as a copy-only change should leave it.
5. `grep -rn "expo-haptics"` over this lane's trees → **0**; `kit/haptics.ts` is the only importer.
6. `node scripts/lint-mobile-design.mjs && node scripts/lint-container-opacity.mjs && node scripts/lint-aria-labels.mjs && node scripts/lint-mobile-testids.mjs` → **all four ok**, with the three tightened budgets **at** their floors rather than under them.
7. `bun run format` then `bun run check:push:static` → see the report.
8. `bun run lint:product` and `node .governance/law/run.mjs --brief-digest 514cb2fed327` → see the report.

### Not done, and why

- **R-SH-9 (`kit/member-error.ts` dies)** — its condition is APPS-A's R-A-15, and R-A-15 had not landed on `umbrella/1015-mobile-ux` when this run ended: `apps/mobile/src/kit/replica/write-outcome.ts:105` still reads `error instanceof Error ? error.message : "Please try again."`. Five callers of `memberFacingError` remain (`kit/transfer/backup-verdict.ts`, `kit/transfer/transfer-queue.ts`, `screens/home/origin-health.ts`, `apps/insights/Insights.tsx`, `apps/insights/GatewayAlerts.tsx`), so the module is not deletable on any reading. **Outstanding**, with the baseline `error-detail 12` un-re-measured.
- **The desktop's automation EDITOR, VIEWER, TEMPLATES and RUN screens still say "automation" in 45 sentences across 20 files** — measured with `grep -rnoE '"[^"]*[Aa]utomations?\b[^"]*"' packages/client/src/react` filtered to literals containing a space: `AutomationEditorRoute.tsx`, `AutomationViewRoute.tsx`, `AutomationEditorScreen.tsx`, `AutomationEditorHarnessPicker.tsx`, `AutomationThreadScreen.tsx`, `AutomationCompilePane.tsx`, `automationEditorTriggers.ts`, `automationLiveMessages.ts`, `automationTurnMessages.ts`, `automationThreadData.ts`, `RunViewRoute.tsx`, `RunViewScreen.tsx`, `runViewData.ts`, `TemplatesRoute.tsx`, `SettingsDiagnosticsScreen.tsx`, `SettingsAppearanceScreen.tsx`, `AssistantScreen.tsx`, `Gallery.tsx`, `CapabilityWall.tsx`, `useCapabilities.tsx`. R-SH-11's ruled scope was the shared pool and the launcher; these are a desktop-only surface with no mobile counterpart, no e2e run available this round, and no simulator. Held deliberately, not missed — see the hand-off below. (The Rules OVERVIEW screen's own two a11y labels, "Loading automations" and "Filter automations", ARE fixed here: it is the desktop twin of the mobile screen this lane renamed.)
## Lane APPS-A — Wave 3 round 2: the S14 sweep, the two room defects, and two overturned rulings (#1015)

Commits: `65c3be517` (R-A-15 sweep) · `4d4a6c4c8` (R-A-16, R-A-17) · `606d69da3` (R-A-18, R-A-19) · `7d0dc915c` (merge of `umbrella/1015-mobile-ux`) · `d0588d26c` (the `error-detail` ratchet to zero).

### R-A-15 — no exception ever reaches a member

`surfaceWriteFailure` interpolated `error.message` into the one status line at every one of its ~40 call sites, so what a member read when a write failed was whatever the transport, the SQLite driver or the intent admitter threw. It now logs the raw (`[write] failed`, docs/logs.md) and says the surface's noun plus the product's one retry word — the twin of `readFailure`, which already worked this way. Three more doors in the same class went with it:

| Door | Before | After |
| --- | --- | --- |
| `surfaceWriteFailure` | `${title}: ${error.message}` | `${title}. Try again.` + `console.warn` |
| the conflict line | `… Expected version 3; found 5. Open Pending changes…` | the reason and the route; no version numbers on the phone |
| a refusal | `new Error(reason)` handed to the failure door (locker ×3, tally ×1) | `surfaceWriteRefusal(kind, title, detail)` — a typed channel, two true routes, raw to the log |
| `grant-seat`'s link ticket | the gateway's throw, printed by `PersonGrants` and `TallyShareGroup` | `LINK_TICKET_NOT_MADE` |

Every noun-less title got its noun: "Not written" → "Locker change not written", "Not exported" → "Locker not exported", "Not recorded" → "Expense not recorded", "RSVP failed" → "Reply not sent", "Cancellation failed" → "Event not cancelled". `TRY_AGAIN` is now `@centraid/client`'s `RETRY_ACTION` rather than a second copy of the same word.

`apps/mobile/src/raw-error-copy.sweep.test.ts` is the pin — a source sweep over `apps/**` and `screens/**` that reads the ARGUMENT of every `postStatus` call by counting parentheses, plus the two doors themselves, plus `new Error(` reaching the failure door, plus a noun on every literal title. **It fails 4 of its 6 cases on `0a20ae0f3` and passes here.**

The `error-detail` ratchet the umbrella's rooms gate carries named this ruling in its `clearedBy`; `d0588d26c` takes it from 12 to **0** and deletes the entry, which makes the rule unconditional. Those eleven were invisible to the `postStatus` sweep because each stores the raw in state first — Docs' failed-transfer row and "Refused · …" line, Locker's `readError`/`revealError`/`accessError`/`importNote`, Photos' per-file import reason and the timeline engine's `error` signal, Tally's spine. The picker's own refusals stay verbatim: `ImportFileRefusedError` carries authored copy, so it speaks for itself, exactly as `LocationNotRemovableError` does in Photos. Four tests that asserted the engine's words reaching copy ("replica not mounted", "Could not reach the gateway", "Gateway returned HTTP 404", "stage failed: 500") now assert the member's sentence — they were pinning the defect.

### R-A-16, R-A-17 — the two room defects

| Ruling | Closed by | What it was |
| --- | --- | --- |
| R-A-16 | `4d4a6c4c8` | `OptionSheet` passed `selectedId` to its Android rows and dropped it on the iOS branch, so a member opening "Birthday reminder" on a phone could not see which lead was already theirs. `ActionSheetIOS` has no selected-row API, so the ✓ rides in the label. `OptionSheet.test.tsx` covers both branches. |
| R-A-17 | `4d4a6c4c8` | agenda/findings#15. Neither Agenda form wrapped anything in a `KeyboardAvoidingView` and both autofocused a field. `EditorRoom` and `SheetRoom` now avoid the keyboard once, and leaving by any door — Done, Cancel, the scrim, hardware back — dismisses it, so an editor cannot leave the keyboard up over the band behind it. `rooms-keyboard.test.tsx`. |

### R-A-18, R-A-19 — two rulings overturned or corrected

| Ruling | Closed by | What it was |
| --- | --- | --- |
| R-A-18 | `606d69da3` | `TasksDenied` printed a row labelled "Receipt" whose value was `board.error` — `caughtError.message` from `useSeatPages`. The gateway seat's gate keeps the label (a desk, with room for it); the phone drops the row, and `useSeatPages` already logs the raw at the catch. `deniedFacts` loses the input with it: the phone was its only caller. |
| R-A-19 | `606d69da3` | `BIRTHDAY_LEADS` labels were glued to " ahead", so the same-day lead read "your phone tells you same day ahead" and "Inner circle · same day ahead". `birthdayLeadPhrase` is the sentence form beside the sheet's label; `birthdayNotificationBody` takes the days. `leadLabel` had no caller left and is gone. |

### R-A-20 — Docs #8 and #11, owner items

Both are OUT OF SCOPE for this umbrella and are listed here with the options and a recommendation, per the ruling.

- **docs/findings#8 — "a folder is a label, not a place" is printed five times, and the 30-day purge rule three.** Three of the five are on ONE screen with three rows on it. Options: (a) state each ontology fact once, at the place a member first meets it, and let the status line carry the count alone — **recommended**; (b) keep the repetition as deliberate reinforcement for an unfamiliar model and record it as a divergence. (a) is four deletions in `docs-copy.ts` and `DocsFoldersView.tsx`; it deletes explanation, which is the owner's to authorise.
- **docs/findings#11 — three names for the create entry, three for the same detail screen.** "New" / "Add to Docs" / "Add a document"; "Details" / "Details" / "Properties"; "Shared" / "Shared with you". Options: (a) one noun per destination, the screen's title winning ("Add a document", "Properties", "Shared") — **recommended**, and the cheapest of the three; (b) the control's word winning, which means retitling two screens; (c) leave it. The vocabulary is the owner's, so nothing was edited.

### Files

`apps/mobile/src/raw-error-copy.sweep.test.ts` (new) · `apps/mobile/src/kit/rooms/rooms-keyboard.test.tsx` (new) · `apps/mobile/src/kit/components/OptionSheet.test.tsx` (new) · `apps/mobile/src/kit/components/OptionSheet.tsx` · `apps/mobile/src/kit/replica/write-outcome.ts`, `…/write-outcome.test.ts` · `apps/mobile/src/kit/rooms/read-failure.ts`, `…/EditorRoom.tsx`, `…/SheetRoom.tsx`, `…/rooms.test.tsx` · `apps/mobile/src/kit/replica/ReplicaStatusBar.test.tsx` · `apps/mobile/src/kit/share/grant-seat.ts`, `…/grant-seat.test.ts` · `apps/mobile/src/test/react-native-stub.tsx` · `apps/mobile/src/screens/home/VaultsSwitcher.test.tsx` · `apps/mobile/src/lib/notifications.tsx`, `…/lib/birthday-notifications.ts`, `…/lib/birthday-notifications.test.ts` · `apps/mobile/src/apps/agenda/AgendaEvent.tsx`, `…/AgendaHome.tsx` · `apps/mobile/src/apps/automations/AutomationThread.tsx` · `apps/mobile/src/apps/docs/useDocs.ts`, `…/BulkUpload.tsx`, `…/DocumentEditor.tsx`, `…/editor-outcome.ts` · `apps/mobile/src/apps/locker/locker-writes.ts`, `…/locker-export.test.ts`, `…/locker-door.ts`, `…/locker-store.ts`, `…/locker-surfaces.ts`, `…/locker-surfaces.test.ts` · `apps/mobile/src/apps/notes/notes-copy.ts` · `apps/mobile/src/apps/people/people-writes.ts` · `apps/mobile/src/apps/photos/viewer-export.ts`, `…/camera-roll-import.ts`, `…/camera-roll-import.test.ts`, `…/camera-roll-import-run.ts`, `…/camera-roll-import-rungs.test.ts`, `…/timeline-engine.ts` · `apps/mobile/src/apps/tally/tally-writes.ts`, `…/tally-store.ts`, `…/tally-store.test.ts`, `…/tally-airplane.test.ts` · `apps/mobile/src/apps/tasks/useTasks.ts`, `…/TasksDenied.tsx`, `…/TasksHome.tsx`, `…/tasks-haptics.test.ts` · `packages/blueprints/apps/tasks/board-view.ts`, `…/board-view.test.ts`, `…/view-copy.ts` · `packages/blueprints/apps/agenda/day-context-copy.ts`, `…/view-copy.ts` · `scripts/lint-mobile-rooms.baseline.json`

### Verification, from the lane worktree

1. `cd apps/mobile && bunx vitest run src` → **316 files, 2681 passed, 0 failed**, plus the inherited `src/lib/replica/expo-seat-driver.test.ts` load failure measured in the round above and unchanged here.
2. `bun run --cwd apps/mobile typecheck` → **0**. `bun run --cwd packages/blueprints typecheck` → **0**.
3. `node scripts/lint-mobile-rooms.mjs` → `screen-root 33`, `back-literal 0`, `page-margin 2`, `identity-tint 0`, `copy-title-case 0`, **`error-detail 0`** — 35 over 595 files. `--enforce` → **pass**; `node scripts/lint-mobile-rooms.test.mjs` → pass.
4. `grep -rn "expo-haptics" apps/mobile/src/apps/{notes,tasks,agenda,docs}` → **no product source**; the five hits are the SABOTAGE sweep's own text and one test mock.
5. `node scripts/lint-mobile-design.mjs && node scripts/lint-container-opacity.mjs && node scripts/lint-aria-labels.mjs && node scripts/lint-mobile-testids.mjs` → **all four ok**.
6. `bun run format` then `CENTRAID_GATE_STAMPS=0 bun run check:push:static` → **4/4**.
7. `node .governance/law/run.mjs --brief-digest 514cb2fed327` → **10 rules, 0 errors, 1 warning**: `waiver-docket` says the merge's `estate-separation` waiver names docket row **D-11**, whose authority is still "pending owner grant". The row records the ask; only the owner answers it. Not self-granted.
8. `bunx vitest run packages/blueprints` → 3 inherited failures (`one-computation` on a `kit` pair, `pending-destructive-projection`, a storage-noun copy sweep), **identical on `606d69da3`** and none of them in a file this round touched.

### Out of the lane's own trees, named

- `kit/share/grant-seat.ts` (+ its test): the SOURCE of the raw leak into `PersonGrants` and `TallyShareGroup`, and not a file any ruling named. Fixed under the lane-wide S14 licence rather than left as a known leak with two app-tree consumers. **Flagged for the root.**
- `apps/{locker,photos,tally,people,automations}` and `screens/**` call sites, and the four tests that pinned the old strings: the R-A-15 sweep is lane-wide by the root's design.
- The merge of `umbrella/1015-mobile-ux` needed one `governance: allow-estate-separation` waiver: the umbrella's own law file (`scripts/ci/gate-classes.json`) and its territory arrive in the same merge, which cannot be split.

## Lane SHELL, closing round — addendum: APPS-A merged, and R-SH-9 answered

Merge `db418b6f4` brought `umbrella/1015-mobile-ux` at `b59b6b1cc` (APPS-A's final round, R-A-15) into `lane/1015-kit` after the section above was written. This addendum corrects it where the merge changed the facts.

**The merge.** One conflict, `apps/mobile/src/apps/automations/AutomationThread.tsx`: APPS-A's R-A-15 removed the glued `Try again.` from `AUTOMATION_NOT_RUN` because the failure door adds the product's one retry word; this lane's R-SH-11 changed its noun. Both are kept — `"This rule did not run"` with APPS-A's comment and R-SH-11 named beside it.

**The one-noun sweep went red on the merge, and was narrowed rather than weakened.** APPS-A's S14 rework logs the exception with the module's own tag, `console.warn("[automations] thread read failed", error)`. That is not member copy — it is the other half of S14's contract, the log a debug session starts from ([docs/logs.md](../docs/logs.md)), and `[automations]` there is the MODULE, which R-SH-11 explicitly leaves alone. `shell-copy.test.ts`'s sweep now scans line by line and skips a line containing a `console.*` call; block comments are blanked to spaces keeping newlines, the convention `scripts/lint-container-opacity.mjs` uses. Re-proven after the narrowing: planting `"An automation is a trigger and a thing to do."` back into `packages/client/src/automations-copy.ts` AND `"This automation did not run"` back into `AutomationThread.tsx` turns it red on both, plus the value-level case; both plants reverted.

**R-SH-9 — `kit/member-error.ts` STAYS. The ruling's condition is not met.** R-A-15 landed and did what it said: `apps/mobile/src/kit/replica/write-outcome.ts` no longer interpolates `error.message` anywhere, `surfaceWriteRefusal` is its new channel, and `error-detail` is **0** on this head (APPS-A's `scripts/lint-mobile-rooms.baseline.json` already records it as gone from the file, which makes the rule unconditional). But R-SH-9 said the module dies "once R-A-15 leaves it with no caller", and it has **five product callers, none of them an exception at the call site**:

| caller | what it lowers | why R-A-15 does not reach it |
| --- | --- | --- |
| `apps/mobile/src/kit/transfer/backup-verdict.ts:102` | the first failure in a backup verdict | a stored verdict string, not a thrown error |
| `apps/mobile/src/kit/transfer/transfer-queue.ts:59` | a queue item's `lastError` | persisted on the item by the transfer engine |
| `apps/mobile/src/screens/home/origin-health.ts:52` | `queue.failures[0].lastError` in the Home notification cause | the same persisted string, read a second time |
| `apps/mobile/src/apps/insights/Insights.tsx:264, 291` | the run-log load reason and the export error | gateway-supplied strings on the wire |
| `apps/mobile/src/apps/insights/GatewayAlerts.tsx:123, 169` | an alert headline and its detail | the gateway's own alert text, the whole page |

Every one of them lowers vocabulary in a string the seat RECEIVED — from the transfer engine's own record or from the gateway over the wire — not one it threw. R-A-15 fixed the class where the seat manufactured the string, which is the class the ruling's reasoning describes ("a string that should never have carried the vocabulary"). These five are a different class and deleting the filter would put engine words straight onto five member surfaces. **Recommendation to the owner: R-SH-9 is answered NO on the evidence, and should be recorded as superseded rather than left as a pending condition.** The honest follow-up is not "delete the filter" but "does the gateway owe the seat a member-facing string?", which is a protocol question, not a copy one.

**Corrections to the section above.**

- `error-detail 12` → **0**. `node scripts/lint-mobile-rooms.mjs` on this head reads `screen-root 33 · back-literal 0 · page-margin 2 · identity-tint 0 · copy-title-case 0 · error-detail 0` — **35 findings over 594 files**, and `--enforce` passes.
- The inherited-red table loses one row: `apps/mobile` `src/apps/tasks/tasks-haptics.test.ts` is **green** after the merge. The full mobile run on this head is **252 files, 2307 passed, 0 failed**.
- The docs pass's claim that R-SH-9 is "outstanding, with the baseline `error-detail 12` un-re-measured" is superseded by this addendum on both halves.

### Verification, from the lane worktree, on the merged head

1. `cd apps/mobile && bunx vitest run src/screens src/apps src/kit` → **252 files, 2307 passed, 0 failed**.
2. `bun run --cwd apps/mobile typecheck` → **0**; `bun run --cwd packages/client typecheck` → **0**.
3. `node scripts/lint-mobile-rooms.mjs` → the six counts above; `--enforce` → **exit 0**.
4. `node scripts/lint-mobile-design.mjs && node scripts/lint-container-opacity.mjs && node scripts/lint-aria-labels.mjs && node scripts/lint-mobile-testids.mjs` → see the report.
5. `bun run format` then `bun run check:push:static`, `bun run lint:product`, `node .governance/law/run.mjs --brief-digest 514cb2fed327` → see the report.

STOPPED here per the owner: no `check:push`, no push, no PR, no simulator.

## Simulator re-audit of Alerts — two kit layout defects fixed, the rest scoped (#1015)

The owner opened Alerts on the simulator after the draft PR and reported it broken. The re-audit the Verification section listed as not run found 16 gaps on that one screen; two were kit defects that every `SystemPlace` and `PushedPage` inherits, and no Wave 4 rule could see them, because `lint-mobile-rooms` reads structure, not rendered geometry.

- **`PlaceHeader` had no gutter.** Neither room that draws it pads it, so the title sat on the screen edge and the trailing verb ran off it. The bar now owns `paddingHorizontal: pageMargin`, like the back row above and the body below (`PlaceHeader.styles.ts`).
- **`Button` top-aligned its label.** The plate is a column held to the 44pt floor with a one-line label inside, and had no `justifyContent`, so every button in the app drew its word against the top edge. It is now `center` (`Button.tsx`).

`PlaceHeader.test.tsx` holds both: the bar's gutter equals `pageMargin` and a verb's plate centres. Seen on the simulator (dev client, cleared Metro cache): title and verbs on the 20pt gutter, labels centred in History, Review all, Open and Mark read.

The other 14 gaps (raw engine errors as notice headlines, background failures filed under "Waiting on you", the always-on empty grants section, the contradicting health line, a "Review all" that only scrolls, the band vanishing on a band destination, and the rest) are copy, model and navigation work, scoped on the umbrella issue as a follow-up round rather than fixed here.

## Round NY — Lane C: `screen-root` 33 → 1 and `page-margin` 2 → 0 (R-NY-6, R-NY-7)

Commits `5e9be1078` (C1, the lint), `b7105c04b` (Tally), `f7e0932ac` (Locker), `d8d163493` (People), `642af3e48` (Photos), `747601ccd` (C3, the tile inset) and the C4 commit that carries this section (the baseline, the rooms README).

### C1 — the four frames, and one level of resolution

All four app frames root in a room: `LockerScreen`, `PeopleScreen`, `PhotosScreen` and `TallyScreen` each return `<AppPlace …>` for a place and `<PushedPage …>` for anything pushed over one. So the screens rooted in them are room screens (R-NY-7), and the lint now knows it: `lintFile` takes a `readSource`, resolves the root tag's relative default import (`frameModuleOf`), and passes the screen when that module's own root is one of the six — exactly one level. `selfTest` plants three cases on every run: a frame rooted in a room (no finding), a frame rooted in `<View>` (fires), and a frame rooted in another frame (fires, because two hops no longer prove which room the member stands in). `scripts/lint-mobile-rooms.test.mjs` proves the same both ways on the committed `LockerTrashScreen`. **33 → 11.**

The suite's tree-walk test proved the reader alive by asserting that `screen-root` and `page-margin` still had findings. R-NY-6 and R-NY-7 take both to zero, which a dead reader would also report, so it now proves the reader by reading real roots instead: more than 40 registered screens answer a tag, and the four frames answer a room.

### C2 — the eleven left, and what they actually were

**Seven were not hand-rolled.** Each already rooted in its app's frame; `rootTagOf` reads the FIRST `return (<` after `export default`, and each had an earlier one.

| Screen | Read as | Why | Fix |
| --- | --- | --- | --- |
| `TallyExpenseScreen`, `TallyFriendScreen`, `TallyGroupScreen`, `TallyHome` | `<View>`, `<ScrollView>`, `<ScrollView>` (then `<LedgerRow>`), `<ActivityView>` | a render IIFE; in `TallyGroupScreen` a member-row `map` callback too | the body is one expression, same branches and props |
| `LockerHome` | `<LockerReviewView>` | the destination switch returned JSX inside `useMemo` | one expression, same memo and dependencies |
| `PersonView` | `<SkeletonRows>` | a render function whose first branch drew the skeleton | the skeleton is the ROOM's `loading` state (`PeopleScreen` forwards it); the record is one expression |
| `PhotosLibrary` | `<View>` | a comment between `return (` and `<PhotosScreen` | the comment sits above the `return` |

**Four were hand-rolled.**

- **`FaceReview`** roots in `PhotosScreen` as a pushed page, route `faceReview` (parent Photos). It gains the computed back key and the Photos band with More lit, like every surface opened from More; its "N of M" moves under the title, because the room's header carries no count.
- **`PlacesMap`** roots in `PhotosScreen`, route `placesMap` (parent Places), titled "Map": it said "Places" beside a "Back to Places" chevron. The count and the map-mode chip ride the room's `toolbar`, which `PhotosScreen` now forwards; the chip keeps its anchor ref for `AnchoredMenu`.
- **`PhotosSearch` — the route is DELETED, not migrated.** Nothing pushed it; `PhotosHome` renders `PhotosSearchView` in place, and the registration was kept only "so App.tsx does not dangle". Wrapping it in `PhotosScreen` made `PhotosHome.test.tsx` fail to LOAD, because the view's module then imported the frame and `@react-navigation/native` with it. Removed from `navigators.tsx`, `lazy-screens.tsx` and `PhotosStackParamList` (v0, no legacy); the view stays.
- **`PhotoLightbox` — STOPPED.** It stays in the baseline; see the owner item below.

### C3 — R-NY-6

`tileChipInset` (3) is a named, commented constant in `apps/mobile/src/kit/theme/native.ts`, exported from the theme index; `PhotoTile` uses it for the custody and state chips' inline inset (proto:4019). It is mobile-kit only, not a third `subBase` seam: no other surface draws a chip on a tile. **`page-margin` 2 → 0.**

### C4 — the ratchet

`page-margin` is deleted from `scripts/lint-mobile-rooms.baseline.json`, which makes it unconditional. `screen-root` goes 33 → **1**, with `PhotoLightbox` named in `clearedBy`. `apps/mobile/src/kit/rooms/README.md` § Adoption now describes the rule as it stands: rooms directly or through one frame level, and the one exception.

### Owner item — `PhotoLightbox` has no honest room

It is a full-bleed `--stage` ground in both themes: a dismiss gesture over the whole screen, floating chrome that carries its own insets, and the band hidden. `AppPlace` and `PushedPage` draw a header and paint `colors.bg` inside `TopSafeArea`, which would letterbox the stage. `EditorRoom` draws a title bar with a Done key over the photograph. `SheetRoom` is a partial modal. Options:

- **(a) A seventh room, `StageRoom` — recommended.** Full-bleed, no header, band hidden, status line hosted, dismiss gesture owned. The slideshow, video and edit-on-stage modes are the same shape.
- **(b) A named exception in the lint**, one ruled entry, with the baseline entry deleted.
- **(c) Force it into `EditorRoom`.** Not recommended: the bar covers the image.

### Finding outside the slice

The root reader's first-`return` heuristic misread seven of the eleven screens the census called hand-rolled. A depth-aware reader — the default function's own top-level `return` — would have seen through all seven without touching the code. That change is outside R-NY-7's one-level licence, so it is recorded here, not made.

### Files

- `scripts/lint-mobile-rooms.mjs`
- `scripts/lint-mobile-rooms.test.mjs`
- `scripts/lint-mobile-rooms.baseline.json`
- `apps/mobile/src/apps/tally/TallyExpenseScreen.tsx`
- `apps/mobile/src/apps/tally/TallyFriendScreen.tsx`
- `apps/mobile/src/apps/tally/TallyGroupScreen.tsx`
- `apps/mobile/src/apps/tally/TallyHome.tsx`
- `apps/mobile/src/apps/locker/LockerHome.tsx`
- `apps/mobile/src/apps/people/PeopleScreen.tsx`
- `apps/mobile/src/apps/people/PersonView.tsx`
- `apps/mobile/src/apps/photos/FaceReview.tsx`
- `apps/mobile/src/apps/photos/FaceReview.styles.ts`
- `apps/mobile/src/apps/photos/FaceReview.test.tsx`
- `apps/mobile/src/apps/photos/PlacesMap.tsx`
- `apps/mobile/src/apps/photos/PlacesMap.test.tsx`
- `apps/mobile/src/apps/photos/PhotosSearch.tsx`
- `apps/mobile/src/apps/photos/PhotosLibrary.tsx`
- `apps/mobile/src/apps/photos/PhotosScreen.tsx`
- `apps/mobile/src/apps/photos/photos-places.ts`
- `apps/mobile/src/apps/photos/PhotoTile.tsx`
- `apps/mobile/navigators.tsx`
- `apps/mobile/lazy-screens.tsx`
- `apps/mobile/src/navigation.ts`
- `apps/mobile/src/kit/theme/native.ts`
- `apps/mobile/src/kit/theme/index.ts`
- `apps/mobile/src/kit/rooms/README.md`
- `receipts/issue-1015-mobile-ux-consistency.md`

No file is deleted. The `PhotosSearch` route registration is removed; its module stays as the view.

### Verification, from the lane worktree

1. `node scripts/lint-mobile-rooms.mjs` → `screen-root 1 · back-literal 0 · page-margin 0 · identity-tint 0 · copy-title-case 0 · error-detail 0`, 1 finding over 594 files (`PhotoLightbox.tsx`). `--enforce` → **exit 0** with the new baseline.
2. `node --test scripts/lint-mobile-rooms.test.mjs` → **11 passed, 0 failed**.
3. `bun run --cwd apps/mobile typecheck` → **0**.
4. `cd apps/mobile && bunx vitest run src/apps/locker src/apps/people src/apps/photos src/apps/tally` → the only failures are in `LockerHome.test.tsx`, `PeopleHome.test.tsx`, `PhotosHome.test.tsx` and `TallyHome.test.tsx`, every one `Unknown mobile icon name: NewChat`. **The failing test names are identical at `1919bd6ab`.**
5. `cd apps/mobile && bunx vitest run src/screens src/apps src/kit` → **252 files, 2256 passed, 52 failed**, in 9 files: the four above plus `AgendaHome`, `DocsHome`, `NotesHome`, `TasksHome` and `kit/components/icon-resolver.sweep.test.ts`. Inherited: with `1919bd6ab`'s `apps/` and `scripts/` checked out in this worktree, the same nine files fail **52 of 70** — measured, then restored.
6. `bun run format`, then `bun run check:push:static` and `node .governance/law/run.mjs --brief-digest bf847b5c4982` → see the report.

### Falsification

1. **Claim: the one-level resolution cannot be fooled into passing a frame that hand-rolls its root.** Throwaway check: `lintFile` on the committed `LockerTrashScreen.tsx`, with a `readSource` that serves `LockerScreen.tsx` with `<AppPlace` swapped for `<View>`. Result: `root is <LockerScreen>, not one of the six rooms`; the unmutated frame gives no finding. **Holds.**
2. **Claim: the misread fixes and the migrations add no red beyond room chrome.** Throwaway check: failing test names in the four app suites, diffed between `1919bd6ab` (changes stashed) and this head. The first diff found one regression, `PhotosHome.test.tsx` failing to load after `PhotosSearch` imported the frame; deleting the dead route fixed it. The re-diff and the nine-file base run above match failure for failure. **Holds, after one fix the check itself found.**
## Round NY — Lane B: the Home band on every place root (R-NY-1)

**What holds now.** Every frame place root draws the Home band at its foot, with its own tab active when that place is pinned, and draws no grid `HomeKey`: the band's Home tab is the way home. A sub-page pushed inside a place keeps its back key and draws no band. Apps keep their own bands; the Home band never appears inside one.

- **`SystemPlace` has a `band` slot** (`band?: React.ReactNode`), drawn under the footer where `PushedPage` draws an app's. When a band is present, `onHome` is ignored. The band is a node the screen hands in, because the kit may not reach the pin model or the navigator.
- **Band navigation is one hook, not Home's private switch.** `screens/home/band-navigation.ts` is pure: `bandStack(routes, target)` returns the ROOT stack as the one Home (its existing route and key) plus the target. The Home tab gives Home alone; More gives Home with `params.sheet = "all-apps"`. `usePlaceNavigation` climbs to the root navigator and dispatches `CommonActions.reset` with that stack; Home and `PlaceBand` share it. Reset was chosen over pop-then-navigate: it is one transition, it keeps Home's key so Home is not remounted, and it bounds the stack from any depth, including a place pushed from a place (Vault → Copies) and a rule's thread over Rules. `navigate` was never an option, because React Navigation 7 pushes a second copy of a route already in the stack.
- **More from a place returns to the ONE Home with the sheet open.** `RootStackParamList.Home` carries `{ sheet?: "all-apps" }`. Home opens the sheet from the param as state adjusted to a prop, not in an effect, and an effect clears the param on the navigator.
- **`PlaceBand`** (`<PlaceBand place="stats" />`) draws `HomeBand` with that tab active and ignores a press on the tab already active. It draws nothing when its screen sits above the bottom of a nested stack (Settings → On this phone), and nothing outside a navigator. It reads the navigator from `NavigationContext`, not `useNavigation()`, which throws outside one.
- **Wired roots:** Needs you (`Approvals.tsx`: the band line and its import only, since lane A owns the rest), Activity (`Insights.tsx`), Vault, Copies, Rules (the list and the feature-off root), Connectors (both roots), Settings' home, On this phone, and System. **System (`gateway`) gets the band, with no tab active**: it is one of the ten places but can never be pinned, and its Home tab replaces the Home key it had.

**Not done, and why.**
- **Needs you pushed from Settings now has no visible back key.** `PlaceBand` correctly draws nothing there, and `SystemPlace` drops the Home key because a band prop is present. `Approvals.tsx` has never had a `backTo`, and its other lines are lane A's. The same holds when a push notification pushes Needs you onto an open Settings stack. The swipe-back gesture still works. Recommendation at merge: give Approvals `backTo={useShellParent()}` and `onBack={() => navigation.goBack()}`, as `PhoneStorage` and `BackupHealth` have.
- **Activity's alerts view (`GatewayAlerts.tsx`) keeps its Home key**, because that file is lane A's. Once lane A lands, it should take `band={<PlaceBand place="stats" />}`.
- **`HOME_READY_MARKER` and the `home-band*` handles now also render on place roots.** The flows that wait for the marker do so after `launchApp`, where the app is on Home, so no flow is known to be affected. `TESTING.md` now says the marker proves that a band is up, not that the member is on Home.
- **CHANGELOG** is left to the umbrella's close-out doc pass, so that three lanes do not append at the same line.

**Verification on this head.** `bun run --cwd apps/mobile typecheck` → 0. `bunx vitest run src/screens/home/band-navigation.test.ts src/screens/home/PlaceBand.test.tsx src/screens/Home.test.tsx src/kit/rooms/rooms.test.tsx` → green; the four place-screen suites (`Connectors`, `Automations`, `Insights`, `Approvals`) → 39 passed. `node scripts/lint-mobile-rooms.mjs --enforce` → exit 0 at `screen-root 33 · back-literal 0 · page-margin 2 · identity-tint 0 · copy-title-case 0 · error-detail 0`, unchanged from the start of the round.

**Files changed.** New: `apps/mobile/src/screens/home/band-navigation.ts`, `apps/mobile/src/screens/home/band-navigation.test.ts`, `apps/mobile/src/screens/home/usePlaceNavigation.ts`, `apps/mobile/src/screens/home/PlaceBand.tsx`, `apps/mobile/src/screens/home/PlaceBand.test.tsx`. Modified: `apps/mobile/src/kit/rooms/SystemPlace.tsx`, `apps/mobile/src/kit/rooms/rooms.test.tsx`, `apps/mobile/src/kit/rooms/README.md`, `DESIGN.md`, `TESTING.md`, `apps/mobile/src/navigation.ts`, `apps/mobile/src/screens/Home.tsx`, `apps/mobile/src/screens/Home.test.tsx`, `apps/mobile/src/screens/home/HomeBand.tsx`, `apps/mobile/src/screens/Approvals.tsx`, `apps/mobile/src/screens/approvals/Approvals.test.tsx`, `apps/mobile/src/screens/Settings.tsx`, `apps/mobile/src/screens/PhoneStorage.tsx`, `apps/mobile/src/screens/SystemOnPhone.tsx`, `apps/mobile/src/screens/data/Data.tsx`, `apps/mobile/src/screens/devices/Devices.tsx`, `apps/mobile/src/screens/connectors/Connectors.tsx`, `apps/mobile/src/screens/connectors/Connectors.test.tsx`, `apps/mobile/src/apps/insights/Insights.tsx`, `apps/mobile/src/apps/insights/Insights.test.tsx`, `apps/mobile/src/apps/automations/Automations.tsx`, `apps/mobile/src/apps/automations/Automations.test.tsx`, and this receipt. Deleted: no file. `Home.tsx`'s private `goToPlace` switch is removed (moved into `placeRoute`).

**Falsification.** The two riskiest claims, each run against a throwaway mutation that was then restored with `git checkout`:
1. *Switching band tabs never grows the stack past Home + one place.* `bandStack` was mutated to push the target onto the existing routes instead of resetting. Result: `band-navigation.test.ts` went **red, 6 failed / 5 passed**. The fold over 40 presses and every multi-route starting stack caught it.
2. *A sub-page pushed inside a place draws no band, and a place root does.* `isPushedSubPage` was mutated to always return `false`. Result: `PlaceBand.test.tsx` went **red on exactly "draws nothing on a sub-page pushed inside a place"** (1 failed / 16 passed). After both restores, the two files are 28 passed.

### Lane B addendum — a place pushed from a place keeps its back key (root review)

The root's review found that `isPushedSubPage` counted every root-stack screen as a place root, so Copies pushed from Vault (`Data.tsx`'s "Copies" row) drew the band and had no way back. **The rule now:** a place screen is a place root only when it stands directly on Home (or has no Home beneath it, as after a cold deep link). The bottom of Settings' stack stands where Settings' route stands. The band's own reset always produces exactly Home + one place, so every screen a tab press lands on is a root, and `place-frame.test.ts` pins that the two agree.

**The back key is generic.** `usePlaceFrame(place)` (`screens/home/usePlaceFrame.tsx`) gives every place root except Needs you (whose `backTo` is lane A's) either the band, or a `BackKey` to what is beneath. The parent is computed from the live stack: a root place by its own name (Vault, Activity, …), a Settings-stack screen by `shell-places`' table. When nothing beneath has a sayable name (Settings opened from an app's chrome), the screen gets the grid key, which still goes back, because `goBack` bubbles out of Settings' stack. `PlaceBand` applies the same rule, `placeStanding` (`screens/home/place-frame.ts`). `PhoneStorage` drops its hand-rolled `useShellParent` back key for the frame. `shell-places.ts` imports `kit/rooms/place` directly, so the rule loads without the rooms. The reset stays one transition.

**Falsification.** `standingIn` was mutated to call anything beneath a root, which is the pre-review behaviour. Result: **4 red**, including "makes Copies pushed from Vault a sub-page of Vault" and `PlaceBand`'s "(Vault → Copies)". Restored, the three band files are green again.

Files: new `apps/mobile/src/screens/home/place-frame.ts`, `apps/mobile/src/screens/home/place-frame.test.ts`, `apps/mobile/src/screens/home/usePlaceFrame.tsx`. Modified: `apps/mobile/src/screens/home/PlaceBand.tsx`, `apps/mobile/src/screens/home/PlaceBand.test.tsx`, `apps/mobile/src/screens/shell-places.ts`, `apps/mobile/src/kit/rooms/README.md`, `apps/mobile/src/apps/insights/Insights.tsx`, `apps/mobile/src/apps/insights/Insights.test.tsx`, `apps/mobile/src/apps/automations/Automations.tsx`, `apps/mobile/src/apps/automations/Automations.test.tsx`, `apps/mobile/src/screens/connectors/Connectors.tsx`, `apps/mobile/src/screens/connectors/Connectors.test.tsx`, `apps/mobile/src/screens/data/Data.tsx`, `apps/mobile/src/screens/devices/Devices.tsx`, `apps/mobile/src/screens/Settings.tsx`, `apps/mobile/src/screens/PhoneStorage.tsx`, `apps/mobile/src/screens/SystemOnPhone.tsx`, and this receipt.
