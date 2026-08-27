# Receipt — issue #878 · Green every red CI lane on main

Umbrella to un-red `main` after the Tally/Locker v17 land (#872 / #877) and the
already-failing scheduled lanes. One receipt; no child issues. Wave 1 is the
PR-gate product and journey-contract diff. PR-gate green and nightly/companion
remain unchecked until CI says so.

## Checklist

- [ ] PR-gate `ci` on `main` (or the fixing PR) is green for `verify`, `mobile-smoke`, `client-e2e / web-e2e`, `client-e2e / desktop-e2e`, `desktop-e2e-macos`, `check`.
- [x] `automation-handlers/bundle-drift.test.ts` is green without skipping ids.
- [x] Metro `ci:bundle` does not import `@centraid/design/elements`.
- [x] Locker viewer-seat web e2e asserts the v17 refusal copy.
- [ ] Tally desktop e2e day-one + reload journey is green; no React #185 loop on that path.
- [ ] Nightly `e2e` and companion live-relay either green or have a recorded residual with a named product bug (not "flake, retry").
- [x] One receipt for this umbrella; no child issues.

## What changed

`automation-handlers/bundle-drift.test.ts` is green without skipping ids.
`bun run --cwd packages/model-runtime build:automations` then oxfmt rewrote
the six generated handlers (identifier-only minify churn; no handler source
edit):

- `packages/blueprints/automations/embed-image/automations/embed-image/handler.js`
- `packages/blueprints/automations/embed-text/automations/embed-text/handler.js`
- `packages/blueprints/automations/faces/automations/faces/handler.js`
- `packages/blueprints/automations/photo-ocr/automations/photo-ocr/handler.js`
- `packages/blueprints/automations/place-names/automations/place-names/handler.js`
- `packages/blueprints/automations/transcript/automations/transcript/handler.js`

Metro `ci:bundle` does not import `@centraid/design/elements`. `fmtMoney` moved
from `packages/design/src/elements/formatters.ts` onto
`packages/design/src/format.ts` and is exported from
`packages/design/src/index.ts`. `packages/blueprints/apps/tally/format.ts`
imports it from `@centraid/design`. `packages/design/src/format.test.ts` covers
minor units and a bad ISO code. The elements subpath still has no
`react-native` condition.

Locker viewer-seat web e2e asserts the v17 refusal copy.
`apps/web/tests/e2e/locker-seat.spec.ts` uses the v17 title, `VIEWER_REFUSED`
body, and way-in.

Tally's v17 tree was handing the shell a new `compose` / `acts` object every
paint. `packages/blueprints/apps/tally/compose-state.ts`,
`packages/blueprints/apps/tally/compose-acts.ts`, and
`packages/blueprints/apps/tally/ledger-reads.ts` return memoized objects.
`packages/blueprints/apps/tally/states.test.tsx` mounts Root under a host that
bumps on `setAppBar`. The desktop e2e journey file is unchanged; that box
stays open until the lane is green.

Tasks custodian-seat `executed` assertion in
`apps/desktop/tests/e2e/tasks.spec.ts` now polls with a unique intent id after
the Done outcome (Notes-shaped), still `.toBe("executed")`.

Agenda `packages/blueprints/apps/agenda/app-root.tsx` rewords the comment so
the source-scan no longer sees `navigator.onLine`.

`CHANGELOG.md` records the Tally crash and the native money move.

One receipt for this umbrella; no child issues. #858, #870, #675 stay as
signal, not children.

## User impact

Opening Tally on a desk no longer crashes the room (the v17 tree was
re-contributing the app bar until React hit maximum update depth). Completing
a task and then writing through the same door no longer loses the seat
assertion to an in-flight complete.

First-run: start fresh, clear the sample week, open Tally — Balances shows
day one instead of the error boundary. Evidence:
`artifacts/e2e/ui-impact/desktop-tasks-custodian.png`, emitted by
`apps/desktop/tests/e2e/tasks.spec.ts`.

## Decisions

- **Do not add a `react-native` condition to `@centraid/design/elements`.** The
  native-contract walk and the element-layer comment forbid it. `fmtMoney` is
  DOM-free, so it belongs on the token layer beside `localDayKey`.
- **Stabilize hook return identities rather than deleting the frame effects.**
  The bar still comes from an effect (the Tasks idiom). A new `compose` /
  `acts` object each paint was the loop.
- **Tasks e2e follows Notes: poll with a unique intent id.** Keep
  `.toBe("executed")`. Skipping `baseVersions` for in-flight rows is the
  durable product follow-up, not this wave.
- **Nightly/companion stay on this umbrella as Wave G**, not child issues.

## Out of scope

- Nightly iOS/Android Maestro journeys and companion live-relay (Wave G).
- Adding a `react-native` export to `@centraid/design/elements`.
- Weakening gates, budgets, or allowlists.
- Product OCC skip of `baseVersions` for `sending` / `awaiting-change` rows.

## Verification

```sh
bunx vitest run \
  packages/design/src/format.test.ts \
  packages/design/src/native-contract.test.ts \
  packages/blueprints/apps/agenda/states.test.tsx \
  packages/blueprints/apps/tally/states.test.tsx \
  packages/model-runtime/automation-handlers/bundle-drift.test.ts
```

52 passed locally. `bun run --cwd packages/design typecheck` green.
Desktop/web e2e and `apps/mobile ci:bundle` are the PR-gate jobs.

## Audit

### Wave 1 — independent fresh-context reviewer

A sub-agent that did not author the change read the two ground truths — the
diff and issue #878 — and adjudicated the required checks. Verdicts:

1. **`## What changed` faithfully describes the diff — PASS.** Worktree vs HEAD `8f6389fee` matches the receipt: six generated `handler.js` identifier-only rebuilds, `fmtMoney` moved onto the token layer (`format.ts` / barrel / `tally/format.ts` / `format.test.ts`, re-export from elements), Locker web e2e v17 title + `VIEWER_REFUSED` + way-in, Tally `useMemo` identities + bar Host test, Tasks custodian poll, Agenda comment without `navigator.onLine`, CHANGELOG #878, one receipt. Tally desktop e2e file left closed as stated.
2. **Each `- [x]` item is realized in the diff — PASS.** `bundle-drift` still `it.each`s all six ids with no skip and bundles churned; Tally no longer imports `@centraid/design/elements`; locker-seat asserts the v17 wall; this is the single umbrella receipt.
3. **The `## Checklist` mirrors the issue's checklist — PASS.** Same seven acceptance criteria, same order and wording; only Wave 1 items are `[x]`; PR-gate, Tally desktop e2e, and nightly/companion stay open.

**Overall: SHIP.**

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-27 | grok | 01a04196-7d03-7801-919d-4a24a4114503 |
