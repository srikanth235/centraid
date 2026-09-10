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
