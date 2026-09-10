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
