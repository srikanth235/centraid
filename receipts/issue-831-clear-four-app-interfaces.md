# Issue #831 — clear the Agenda, Notes, Tally and Tasks interfaces

GitHub issue: [#831](https://github.com/srikanth235/centraid/issues/831)

Agenda, Notes, Tally and Tasks are getting interfaces designed from
scratch. Their existing web/desktop and native covers are removed whole
rather than migrated, and everything below the surface — manifests,
grants, `actions/`, `queries/`, pending projections, seeds — is left
untouched. ~13k lines of interface out; the four apps stay installed and
every handler stays reachable through the assistant.

## Checklist

- [x] `packages/blueprints/apps/{agenda,notes,tally,tasks}` keep only their non-UI graph; each `app-root.tsx` is a `Root` that paints one empty element and keeps `CHANGE_TABLES`
- [x] `app-inline.tsx` descriptors unchanged — `pendingProjection`, `changeTables`, `queries`, `kitAsk`, Tasks' `multiScope` all stand
- [x] `apps/mobile/src/apps/{agenda,notes,tally,tasks}` keep their five routes; each screen paints the themed page ground and declares the props its route hands it
- [x] `handler-reachability`'s `AWAITING_HANDOFF` names all four on web and mobile; the justification test still proves every id is a real manifest
- [x] Desktop and web offline journeys retargeted onto Docs; `desktop.offline` keeps an owner and `web-pending-overlay`'s floor is taken over one-to-one
- [x] `bun run check:push`: 41/43 green; the two reds are this container's missing Electron and Chromium headless-shell binaries (see below)

## Decisions

#831 removes interfaces, not capabilities. `app.json`, `actions/`,
`queries/`, `pending-projection.ts` and `seed.js` are untouched for all
four apps, so the apps stay installed, home tiles and palette search keep
reading, and the assistant still invokes every action. The suspension is
recorded in `handler-reachability.test.ts`'s `AWAITING_HANDOFF` — the
register that exists for exactly this state — not as ~70 per-handler
exceptions.

A check whose subject was deleted is dropped, never softened to a
conditional read. State honesty, shared CSS, untrusted rendering, the
app-boot journeys, Tally's placement call sites and the accessibility
contract's modal pair all lose the four apps' rows outright, each with a
note naming what the rebuilt app owes back. A test that skips itself when
its subject is missing passes for the wrong reason.

Two bans got STRONGER rather than weaker where their subject left. The
retired-chrome-selector ban now scans each app's whole source tree
instead of one `Chrome.module.css`, so it survives the rebuild wherever
the new chrome lands; the served-entrypoint and `wall.css` bans now walk
the apps directory instead of a curated list, so an app with no chrome
yet is still caught reintroducing one.

The offline journeys moved seats rather than lapsing.
`apps/desktop/tests/e2e/pending-overlay.spec.ts` and
`apps/web/tests/e2e/offline-reconnect.spec.ts` both drove Tasks/Tally/
Agenda and now drive Docs, the one remaining app whose production rows
render the shared pending overlay. Their offline write is issued through
`window.centraid.write` because Docs' rename affordances live in the
sidebar the inline seat hides and behind Quick Look's info panel; every
observable after that write — optimistic title, `.kit-pending-chip`,
survival across the reload, settlement on reconnect — is the production
UI's. `web-pending-overlay`'s floor is absorbed by a new
`web-offline-pending-row` flow over the retargeted journey, one-to-one.

`@react-native-community/datetimepicker` stays a dependency and is
recorded in knip's `apps/mobile` `ignoreDependencies`. Its JS importers
went with Agenda's and Tasks' native editors, but it is still autolinked
into `ios/Podfile.lock` and the committed native fingerprints; removing
it is a native-state change needing CocoaPods and a fingerprint refresh,
not a frontend cleanup.

#831 removes the copy-allowlist entry for
`packages/blueprints/apps/tasks/components/Board.tsx`. The file was
deleted with the Tasks interface, so the entry excused a string that no
longer exists — an allowlist shrinking with its subject, not a rule being
relaxed. No other entry changes and `copyRatchet` is untouched.

#831 re-pins the `tests/matrix.json` fingerprint in
`tests/quality/classification-ratchet.json` after retargeting the two
offline flows and re-noting `desktop.offline`. Qualities, demonstratedRed
and matrixGovernanceFingerprint are unchanged. Prior: #825.

## What changed

`packages/blueprints/apps/{agenda,notes,tally,tasks}` lose `Chrome.tsx`,
`Chrome.module.css`, `components/`, `logic.ts`, `format.ts`, `icons.ts`,
`types.ts`, Tally's `search-groups.ts` and `logic-commons.test.ts`, and
Tasks' `scope-declaration.ts` and `scope-fanout.ts` (with
`src/tasks-scope-fanout.test.ts`). Each `app-root.tsx` is now a `Root`
returning `<div ref={rootRef} />` plus the app's `CHANGE_TABLES`, so the
shell's `data-app-*` knobs still land on a real node and the change
subscription is unchanged. `app-inline.tsx` is untouched apart from
Tasks' `multiScope` comment, which named the deleted `scope-declaration.ts`.

`apps/mobile/src/apps/{agenda,notes,tally,tasks}` are five empty screens
— `AgendaHome`, `AgendaEvent`, `NotesHome`, `TallyHome`, `TasksHome` —
each painting `colors.bg` and declaring its `*ScreenProps`. An unpainted
native view shows whatever sits behind it, which reads as a broken screen
rather than an empty one. `apps/mobile/src/kit/replica/PendingRowStatus.tsx`
went with them: its only callers were those covers.

`packages/blueprints/src/app-boot-harness.ts` loses the Agenda fixture,
its pending-chip journey over the production intent-invalidation
derivation, the Tally trash-shelf leg, and the now-unused `expectReplica`
option; `docs`, `locker`, `people` and `photos` still boot.

`tests/matrix.json`: `desktop-pending-overlay` renamed to its Docs
journey, `web-pending-overlay` removed with its floor taken over by the
new `web-offline-pending-row`, and `desktop.offline`'s note re-written to
say what the rebuilt journey proves and what still keeps the cell
partial. `apps/desktop/tests/e2e/SCENARIOS.md` drops the retired row.

`tests/hygiene-budgets.json` tightens `toHaveBeenCalled` 800 → 795 with
the deleted suites.

### Checklist crosswalk

Added under #676. The `receipt-per-issue` crosswalk is skipped while any
required section is missing, so it never ran against this receipt until
`## Out of scope` was restored; the six items below then had no citation.
Each is quoted from `## Checklist` and pointed at the paragraph that already
evidences it. Nothing new is claimed about #831's work here.

- `packages/blueprints/apps/{agenda,notes,tally,tasks}` keep only their non-UI graph; each `app-root.tsx` is a `Root` that paints one empty element and keeps `CHANGE_TABLES`
  → the first paragraph above.
- `app-inline.tsx` descriptors unchanged — `pendingProjection`, `changeTables`, `queries`, `kitAsk`, Tasks' `multiScope` all stand
  → same paragraph, last sentence, and the `## Decisions` note on what stays
  installed.
- `apps/mobile/src/apps/{agenda,notes,tally,tasks}` keep their five routes; each screen paints the themed page ground and declares the props its route hands it
  → the second paragraph above.
- `handler-reachability`'s `AWAITING_HANDOFF` names all four on web and mobile; the justification test still proves every id is a real manifest
  → the `## Decisions` paragraph recording the suspension in that register
  rather than as ~70 per-handler exceptions.
- Desktop and web offline journeys retargeted onto Docs; `desktop.offline` keeps an owner and `web-pending-overlay`'s floor is taken over one-to-one
  → the `tests/matrix.json` paragraph above and the offline-journeys paragraph
  in `## Decisions`.
- `bun run check:push`: 41/43 green; the two reds are this container's missing Electron and Chromium headless-shell binaries (see below)
  → `## Verification`.

## Out of scope

Section added under #676, which found this receipt failing the
`receipt-per-issue` gate for its absence. It restates boundaries #831
already drew in `## Decisions`; no claim about #831's work is added or
changed.

- **The replacement interfaces.** #831 clears the four covers; designing
  and building what replaces them is the separate work this clearing
  makes room for. Until then each `app-root.tsx` paints one empty
  element and the four apps are reachable only through the assistant,
  the palette and home tiles.
- **Everything below the surface.** `app.json`, `actions/`, `queries/`,
  `pending-projection.ts` and `seed.js` are untouched for all four apps.
  No handler, grant, manifest or seed is removed or renamed.
- **Removing `@react-native-community/datetimepicker`.** Its JS
  importers left with the Agenda and Tasks native editors, but it is
  still autolinked into `ios/Podfile.lock` and the committed native
  fingerprints. Dropping it is a native-state change needing CocoaPods
  and a fingerprint refresh, so it stays a dependency and is recorded in
  knip's `apps/mobile` `ignoreDependencies`.
- **Executing the two retargeted Playwright journeys.** Not run in the
  authoring container for want of the Electron and Chromium
  headless-shell binaries — see `## Verification`. (They have since been
  run: #676 replays `apps/desktop/tests/e2e/pending-overlay.spec.ts` and
  the web lane green.)

## Verification

`bun run check:push` — 41 of 43 gates green. Two fail on missing binaries
in this container, both unrelated to the diff: `test:affected` fails only
`apps/desktop/src/main/ipc-core.test.ts` with "Electron failed to install
correctly", and `design:gallery` cannot find
`/opt/pw-browsers/chromium_headless_shell-*/chrome-headless-shell`. Every
other package suite is green: blueprints 3934, client 2304, mobile 1630.

The two retargeted Playwright journeys are NOT executed here — the e2e
lanes need the same missing browser and Electron binaries — so they carry
review risk their unit-tested neighbours do not.
