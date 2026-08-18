# Issue #822 — fix red main after #819/#820

GitHub issue: [#822](https://github.com/srikanth235/centraid/issues/822)

`main` (`35d5c9b9c`, #819/#820) left required `ci.yml` red: `static`
typecheck, `gates` quality-knobs, and `client-e2e / web-e2e` Docs Preview.

## Checklist

- [x] `bun run --cwd apps/web typecheck` is green (no TS2769 in `web-health.test.ts`)
- [x] `bun run lint:quality-knobs` is green; `tests/matrix.json` whole-file fingerprint re-pinned
- [x] Docs `QuickLookText` exposes `article` named for the file with heading + body paragraphs
- [x] Unit test drives the shipped reading sheet; web `docs-drive.spec.ts` assertions stay

## Decisions

#822 re-pins the tests/matrix.json whole-file fingerprint after #819 renamed two pending-overlay flow names (four apps → Tally, Tasks, and Agenda). Qualities, demonstratedRed, and matrixGovernanceFingerprint are unchanged. Prior: #807 (chain preserved in receipts/issue-807-enrichment-generic.md and git history of this file).

## What changed

**Web health mock types** in `apps/web/src/web-health.test.ts`.
`vi.fn<typeof gatewayJson>` is not a `<T>(…) => Promise<T>`: the mock
collapses to `Promise<unknown>`. The factory now wraps the hoisted mock so
`tsc` accepts the typed `vi.mock(import(…))`. `bun run --cwd apps/web
typecheck` is green (no TS2769 in `web-health.test.ts`).

**Matrix fingerprint** in `tests/quality/classification-ratchet.json`.
#819 renamed two pending-overlay flow names and did not re-pin the
whole-file hash. `bun run lint:quality-knobs` is green; `tests/matrix.json`
whole-file fingerprint re-pinned. Qualities / `demonstratedRed` /
`matrixGovernanceFingerprint` untouched.

**Docs reading sheet** in
`packages/blueprints/apps/docs/components/QuickLookText.tsx` and
`packages/blueprints/apps/docs/components/QuickLook.module.css`. v11 moved
text onto the QuickLook paper but left it as an unnamed `div`, so Preview
never produced `getByRole("article", { name: "lease-notes.txt" })`. Docs
`QuickLookText` exposes `article` named for the file with heading + body
paragraphs. The first heading drops its extra top margin.

Unit test drives the shipped reading sheet; web `docs-drive.spec.ts`
assertions stay. `packages/blueprints/src/docs-reading-surface.test.ts`
mounts shipped `QuickLookText`. `apps/web/tests/e2e/docs-drive.spec.ts`
keeps the Preview article assertions and now also emits
`artifacts/e2e/ui-impact/issue-822-docs-drive.png`.
`docs/apps/docs-scenarios.md` records the unit owner.
`CHANGELOG.md` Unreleased/Fixed names the member-visible reading sheet and
the CI repair.

**Desktop e2e locators.** #819 unmounted the frame App-settings gear and
made Settings a modal whose h1 is always "Settings".
`apps/desktop/tests/e2e/delete-app.spec.ts` and
`apps/desktop/tests/e2e/onboarding-home.spec.ts` pin the missing gear
(eight cases, floor unchanged).
`apps/desktop/tests/e2e/settings-enrichment.spec.ts` expects the shipped
"Declined · built-in engine only" copy.
`apps/desktop/tests/e2e/settings-gateways.spec.ts` finds the Agents h2.
The Enrichment Faces switch track in
`packages/client/src/react/screens/SettingsEnrichmentScreen.module.css`
no longer intercepts the input underneath it.

## User impact

Opening a text document in Docs shows the file title on the reading paper
and names the sheet for assistive tech. Upload → reload → Preview still
returns the same bytes.

First-run: after Preview on `lease-notes.txt`, the reading article is
visible with the file title as a heading and both body paragraphs painted.
Evidence: `artifacts/e2e/ui-impact/issue-822-docs-drive.png`, emitted by
`apps/web/tests/e2e/docs-drive.spec.ts` after those assertions.

## Out of scope

- Restoring the v11-unmounted App-settings gear.
- Nightly / scheduled workflows.

## Verification

```sh
bun run --cwd apps/web typecheck
bun run lint:quality-knobs
bun run --cwd apps/web test src/web-health.test.ts
bun run --cwd packages/blueprints test src/docs-reading-surface.test.ts
bun run --cwd apps/web e2e -- tests/e2e/docs-drive.spec.ts
bun run check:ui-receipt
```

- `apps/web` typecheck: exit 0, no TS2769.
- `lint:quality-knobs`: exit 0, no stale fingerprint.
- `web-health.test.ts`: 1/1 passed.
- `docs-reading-surface.test.ts`: 1/1 passed (article, heading, both paragraphs).
- web `docs-drive.spec.ts`: passed twice locally, including after the screenshot emitter.
- `check:ui-receipt`: evidence verified.

## Audit

- (1) What changed vs diff: PASS — Working tree vs `35d5c9b9c` (`fix/822-main-ci` and `main` share that SHA) matches the receipt: `apps/web/src/web-health.test.ts` wraps the hoisted `gatewayJson` mock; `tests/quality/classification-ratchet.json` re-pins only the `tests/matrix.json` whole-file hash and rewrites `approvedDeviation` while leaving `matrixGovernanceFingerprint` and the other fingerprints alone; `QuickLookText.tsx` is an `article` labelled by an `h1` title plus body blocks; `QuickLook.module.css` adds `.readHead:first-child { margin-block-start: 0 }`; new `packages/blueprints/src/docs-reading-surface.test.ts` imports the shipped module; `docs-drive.spec.ts` keeps the article/heading/paragraph asserts and adds the `issue-822-docs-drive.png` emitter; `docs/apps/docs-scenarios.md` and `CHANGELOG.md` Unreleased/Fixed match those claims. The only extra path is the receipt itself (and the gitignored screenshot it names as evidence).
- (2) Checked items realized in the diff: PASS — The typed mock wrapper is the TS2769 fix; the ratchet hash is the matrix re-pin; `QuickLookText` now exposes a file-named `article` with heading and body paragraphs; the new unit test mounts shipped `QuickLookText`, and the web e2e Preview assertions are unchanged.
- (3) Checklist mirrors the issue: PASS — The receipt’s four `- [x]` items are the same four issue #822 checklist lines, same order and wording.

Verdict: PASS — the receipt’s What changed and checked items match the working-tree change, and the checklist is a copy of issue #822.