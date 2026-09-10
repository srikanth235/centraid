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
