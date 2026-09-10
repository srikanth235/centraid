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
