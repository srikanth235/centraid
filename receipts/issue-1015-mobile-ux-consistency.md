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
