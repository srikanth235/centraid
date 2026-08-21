# Issue #834 — rebuild the Agenda, Notes and Tasks interfaces

GitHub issue: [#834](https://github.com/srikanth235/centraid/issues/834)

Three of the four interfaces cleared by
[#831](https://github.com/srikanth235/centraid/issues/831) are drawn again
from scratch, on every seat #831 emptied. Stage 0 settled the four
contract questions the screens would otherwise be drawn over and landed
the two read-only backend deltas the rebuilt Agenda and Notes need. Wave 1
drew the three rooms — Tasks, Notes, Agenda — web and phone. Wave 2 laid
the cross-app context spine on the seams wave 1 left for it. Wave 3 drained
the gates, brought `tests/matrix.json` and the docs to current state, and
closed this receipt.

One umbrella, one receipt, no child issues. Slices were sub-agents under
the root agent's plan (AGENTS.md, [docs/multi-agent.md](../docs/multi-agent.md)).

## Checklist

Stage 0 — rulings and contract deltas:

- [x] Four rulings land in `docs/decisions.md` as `## Rebuilding Agenda, Notes and Tasks (#834)` — R-northstar, R-journal, R-daycontext, R-shelf-scope
- [x] Tasks' north star reads Todoist and only Todoist in `docs/blueprint-seats.md`, `packages/blueprints/apps/tasks/app.json` and `packages/blueprints/index.json`
- [x] Agenda gains the read-only `day-context` query, registered in its manifest and inline descriptor, with `CHANGE_TABLES` grown to match
- [x] Notes' `library`, `search` and `link-targets` exclude journal-scheme notes through one shared `apps/_shared/journal-scheme.ts`
- [x] Handler tests cover the day-context projection, its boundedness and denial shape, and the journal exclusion across all three Notes queries
- [x] The shared recurrence engine lands before the apps, as one humanised summariser and one missed-period collapse
- [x] `collapseMissedOccurrences` is threaded through every `TimeApi` declaration and mounted on the inline query ctx
- [x] No surface renders a raw rule: Tally's dashboard drops its RRULE fallback and Agenda's rows carry `recurrence_summary`
- [x] The recurrence properties file is back under the 625-line hygiene limit, split rather than trimmed

Wave 1 — the three rooms:

- [x] Wave 1a — the rebuilt Tasks interface at the Todoist depth bar — twelve routes and twelve states, the one task row, quick add, re-entry, the logbook, the anchor control; `queries/board.ts` and `queries/search.ts` carry `recurrence_summary` / `missed` / `next_due`; scope declaration and fan-out restored; native board with `FlatList` and a claimed band (`packages/blueprints/apps/tasks/**`, `apps/mobile/src/apps/tasks/**`; 208 tests across 6 files)
- [x] Wave 1b — the rebuilt Notes interface, including the Journal place that is now these notes' one home — ten routes, first-line promotion, the `[[` powerbox with Locker excluded, anchored passages, the append-only version chain, capture and voice states; native cover over the same replica sharing the blueprint's pure logic (`packages/blueprints/apps/notes/**`, `apps/mobile/src/apps/notes/**`; 65 web + 1 mobile tests)
- [x] Wave 1c — the rebuilt Agenda interface dispatches `day-context` — five views on the now-line anchor, the event editor with the one recurrence summary, the scope panel, RSVP, the parked cancellation stated honestly; native Day/Schedule, the editor's `datetimepicker` restored and its knip ignore dropped; the app-boot Agenda journey back with its replica fixture and pending-chip assertions (`packages/blueprints/apps/agenda/**`, `apps/mobile/src/apps/agenda/**`)

Wave 2 — the cross-app context spine:

- [x] Birthdays ride the day as a ribbon, tiered by the one closeness fact the vault stores; due tasks collapse into one shelf; holidays take the same ribbon shape; layer toggles read as layers and not as calendars
- [x] The one inner-circle birthday notification on the existing Expo machinery, with a member-tunable lead and a deep link
- [x] Notes' **Send to Tasks** is a real acting control over a new notes-side action, and `window.centraid.openApp` is the one door a projection uses to hand the member to the owning room

Wave 3 — sweep:

- [x] `AWAITING_HANDOFF` is empty for the three apps on both surfaces; only Tally remains
- [x] The rows #831 dropped return: `state-honesty`, `shared-css`, `untrusted-rendering`, the accessibility contract, and the app-boot lane
- [x] `packages/blueprints/manifest.json` regenerated over every wave-1/2 file
- [x] `tests/matrix.json` notes brought to current state and `fingerprints["tests/matrix.json"]` re-pinned in `tests/quality/classification-ratchet.json` with an `approvedDeviation`
- [x] Copy ratchet audited with **no new allowlist entries** — U2 and U4 pass over the three rebuilt trees as they stand
- [x] `packages/blueprints/apps/**` coverage blend clears its 20/14 floor with room (measured 42.21 lines / 33.08 branches)
- [x] `check:ui-receipt` evidence: a changed e2e harness emitting under `artifacts/e2e/ui-impact/`
- [x] Docs to current state — `docs/blueprint-seats.md`, `docs/decisions.md`, `docs/glossary.md`, `docs/design-divergences.md`, `CHANGELOG.md`, and one `QUALITY.md` observation
- [x] `bun run check:push` across the finished waves (results and the two environment reds in `## Verification`)

## Decisions

#834 R-northstar rules Tasks' north star to be **Todoist alone**. The
manifest already said so (`seats.northStar: "todoist"`) while the
catalogue copy said "Things-style" and `docs/blueprint-seats.md` named two
products; the copy and the doc move to the manifest's answer rather than
the reverse, because a tie is not an answer a designer can consult. The
ruling names the DEPTH bar, not the vocabulary: the backend keeps its
Things-shaped words (areas; today / upcoming / anytime / all; the
completion anchor) and nothing here renames them. `docs/blueprint-seats.md`
requires the doc and `app.json` to move together, so
`packages/blueprints/apps/tasks/app.json`,
`packages/blueprints/index.json` and the regenerated
`packages/blueprints/manifest.json` land in the same change.

#834 R-journal excludes journal-scheme-tagged notes from Notes' `library`
and `search` defaults and from the `link-targets` powerbox. The vault has
no `not-in` where-op, so the exclusion is in-handler over a bounded marker
read. Two facts came out of writing it that the ruling's prose did not
anticipate. First, the exclusion cannot be trusted to the `in`-bounded
join: `packages/blueprints/apps/notes/queries/library.ts` re-narrows both
its tag rows and its concept rows to the surviving window in memory,
because the tag → concept → chip chain is exactly where a journal-only
concept leaks back as a library filter chip. The test that proves this
was written first and failed on both links before the re-narrowing landed.
Second, `link-targets` has no `vaultDenied` contract, so a denied marker
read makes the Notes column ABSENT — the same outcome every other failing
target already gets from its `Promise.allSettled` — rather than a silently
unfiltered one. `readJournalNoteIds` therefore throws on denial instead of
answering "nothing is a journal entry"; failing open would leak the very
notes the ruling protects.

`truncated` in `library.ts` stays measured PRE-exclusion, and the contract
comment says so. The window is what the vault returned, so a slice made
entirely of journal entries still reports "there is more behind this"
rather than claiming the library ends. The honest corollary — `notes` may
hold fewer than `window` rows while `truncated` is true — is written into
the same comment.

#834 R-daycontext ships `packages/blueprints/apps/agenda/queries/day-context.ts`
with two limits the ruling could not have named before the vault was read.
There is **no relationship tier stored anywhere in the ontology**: the
flags-scheme `starred` tag on a party is the only closeness judgment the
vault holds (`packages/vault/src/commands/flags.ts`, mirrored by People's
own `starred` projection), so `tier` is `inner` when the owner starred that
person and `outer` otherwise. And there is **no holiday source at all** —
no holiday feed, no subscribed-calendar mechanism (`schedule.calendar` is
owner-authored and its `external_uri` is a label, not a poller), no
provider pull that would write one. `holidays` is therefore always `[]`,
with a comment naming the absence; inventing storage for it is a separate
ruling. The layer still ships with its switch drawn, because the shape is
what the rail promises and an absent switch would be a second thing to
add later; the register row is in `docs/design-divergences.md`.

Birthdays come from `core.party.birth_date`, which the vault reconciles
with `people.important_date` on every birthday write
(`packages/vault/src/commands/people.ts`), so **the People projection is
read from the canonical spine and no People-side surface is grown for it**
— a People projection of its own is deferred, deliberately: Agenda already
holds a scope on the party spine, and a second projection would be a
second place for the same fact to drift.

Answering a tier needs the flag vocabulary, so Agenda grows three
read-only scopes — `core.tag`, `core.concept`, `core.concept_scheme`.
`schedule.task` needed none: Agenda already holds a schema-wide
`{schema: "schedule", verbs: "read+act"}` scope. The four new entities
join `CHANGE_TABLES` so a completed task or a newly starred person
re-decorates the grid instead of leaving it stale until the next nav.

#834 R-shelf-scope keeps the due-task day shelf on this vault's tasks.
There is no cross-vault aggregation behind those counts and no peer read
in the handler, on a Tasks app that otherwise mounts every visible scope:
the shelf is personal attention, and a cross-vault count reintroduces the
"someone should, so no one does" failure the Tasks brief bans.

**The send-to-tasks action, and its scope.** Notes' checklist line reaches
Tasks through a NOTES-side action (`apps/notes/actions/send-to-tasks.ts`),
not through a Tasks import or a shared writer: two commands on one spine —
`schedule.add_task` mints the canonical row, `core.link_entities` puts the
edge back on the note — and **Notes keeps no copy of the task**. That is
what makes the action honest under the projection doctrine, and it has one
consequence a reviewer must not "fix": the action is `excluded` from the
pending-write overlay in `apps/notes/pending-projection.ts`, with the
reason recorded there, because the row it mints is a `schedule.task` owned
by Tasks whose id is minted at the vault — there is no Notes row to project
it onto. The undated default is deliberate: the task takes a due date only
when the line itself carried one.

**The `openApp` door.** A projection that draws another app's fact needs a
way to hand the member to the room that owns it, or the fact becomes
editable in two places. `window.centraid.openApp(appId, focus?)`
(`packages/client/src/react/blueprints/centraid-inline.ts`,
`packages/blueprints/types/centraid.d.ts`,
`packages/client/src/react/shell/routes/InlineAppRoute.tsx`) is that one
door, and it is navigation only — no write, no payload beyond the focus
id. Where a host does not supply it, `DayShelf` draws its rows as text
rather than as controls: an affordance that cannot act is the thing this
product refuses.

**Notes' native cover is a native screen, not a WebView.**
`handler-reachability.test.ts` still files Notes under `WEBVIEW_APPS`, and
the name is now a misnomer — #799 retired the WebView host entirely. The
register's MEANING is intact (this seat's dispatch is answered by the web
source), so the rebuild kept the register and wrote the correction into
the file's header instead of renaming a repo-wide register inside an app
rebuild. What ships is a native cover over the same replica, importing the
blueprint's pure logic (`promote`) rather than re-deriving it, so first-line
promotion cannot mean two things on two seats.

**The band roster gains Agenda and Tasks, and not Notes.**
`apps/mobile/src/kit/band/band-owner.ts`'s `BAND_CLAIMING_APPS` is a
hand-maintained mirror — mobile has no inline-app channel like web's
`frame.claimBand`, so the frame cannot enumerate who claimed. Agenda and
Tasks draw bands and are listed; Notes' rebuilt cover draws none, so
listing it would offer a settings row to hand back a band nobody claimed.
It joins the day it renders one, and the file says so.

**Four new `governance: allow-repo-hygiene file-size-limit` markers**, each
on an app-root or its native equivalent, each carrying its reason in the
marker itself: `apps/agenda/app-root.tsx` (859), `apps/notes/app-root.tsx`
(901), `apps/tasks/app-root.tsx` (993), and
`apps/mobile/src/apps/notes/NotesHome.tsx` (552). The shape is the one
#505 already sanctions for an app root: every screen's BODY lives in its
own module under `components/`, and what stays in the root is the routing,
the reads and the frame contributions. An allow-marker is a policy fact, so
it is recorded here rather than left to be discovered. No budget was
raised to accommodate them: `tests/hygiene-budgets.json` is untouched at
`toBeTruthyFalsy: 378` / `toHaveBeenCalled: 795`, and the two truthy
assertions wave 1 added to Agenda's copy tests were rewritten as value
assertions rather than bought with budget.

**Gate rows returned in their original shapes, not softened ones.** The
suites #831 emptied — `state-honesty`, `shared-css`, `untrusted-rendering`,
the accessibility contract, and the app-boot lane — carry the three apps
again as ordinary rows, and `AWAITING_HANDOFF` is down to `tally` on both
surfaces. Two shapes are worth naming. Agenda re-enters the app-boot lane
with `expectLive: true` — it and Photos are the only two apps held to the
live-read journey — and its pending-chip assertions consume the PRODUCTION
intent-invalidation derivation (`packages/client/src/replica/intent-invalidations.ts`,
loaded by path, because `@centraid/client` already depends on
`@centraid/blueprints` and the reverse edge would make Turbo's `^build`
graph cyclic), so the harness cannot invent a terminal signal the real
coordinator would never publish. And the `send-to-tasks` action shipped in
wave 2 without its pending-projection row, which
`apps/_shared/pending-overlay.test.ts` caught in this sweep: it is a real
red, fixed by declaring the exclusion with its reason, never by relaxing
the law that every declared action has a projection.

**Four reds the sweep found and fixed at the source.** The wave slices
verified their own trees; the repo-wide gates found four things none of
them could see, and each was fixed in the code rather than in the gate.
(1) `packages/blueprints/manifest.json` and the pending-overlay law
disagreed about Notes' new `send-to-tasks` action — fixed by declaring the
projection (above). (2) `bun run lint` at the root was red on eleven
findings across the wave trees: `unicorn(prefer-export-from)` on the
`when.ts` / `day-context-copy.ts` re-export leaves (`apps/tasks/format.ts`,
`apps/tasks/logic.ts`, `apps/mobile/src/lib/birthday-notifications.ts`),
duplicate type/value imports in `apps/agenda/components/DayContext.tsx`,
`vitest(prefer-strict-equal)` and `prefer-describe-function-title` across
five wave suites, an unused `sentToTasks` import in `apps/notes/logic.ts`,
and a shadowed `days` in `AgendaHome.tsx`. All fixed; the three `when.ts`
symbols that turned out to be re-exported but never used locally
(`dayKey`, `isDateOnly`, `timeOfDay`) left the import list rather than
being suppressed. (3) `lint:engine-conformance` flagged Tasks' `pendingWrites`
as an app-owned pending-row collection. It never was one — it is a COUNT
(`.length`) handed to the notices line — so the identifier and its prop are
renamed `pendingWriteCount`, which is both accurate and outside the
linter's collection vocabulary; the allowlist was NOT touched. (4) U4
flagged the first draft of the `send-to-tasks` exclusion reason as
over-long two-sentence copy: the reason was shortened to one sentence and
the detail moved into a comment above it, rather than allowlisted.

**The offline e2e journeys stay on Docs.** #831 retargeted the desktop and
web offline journeys off Tally/Tasks/Agenda; the rebuilt apps do NOT take
them back. Those journeys prove the shared pending overlay, not app
chrome, and the rebuilt apps' pending honesty is proven at the boot tier
instead — which is a cheaper seat for the same contract than a second
Electron journey. `tests/matrix.json`'s two deviation paragraphs and the
`desktop.offline` note say this in current-state terms rather than
narrating the removal that is now undone.

The matrix re-pin carries this `approvedDeviation`, verbatim in
`tests/quality/classification-ratchet.json`:

#834 re-pins the `tests/matrix.json` fingerprint in
`tests/quality/classification-ratchet.json` after bringing four matrix
notes to current state: the three interfaces #831 cleared exist again, so
`desktop.offline`, `blueprints.performance`, the `web-offline-pending-row`
deviation and the `desktop-delete-app-journey` deviation say so, and
#831/#834 join `trackingIssues`. No cell assessment, floor, owner or flow
moves — the offline journeys stay on Docs, which is #834's own ruling.
Qualities, demonstratedRed and matrixGovernanceFingerprint are unchanged.
Prior: #831.

**No other gate knob moved.** `tests/quality/copy-allowlist.json` gains no
entry — U2 and U4 pass over the three rebuilt trees as written, which is
what a copy table per room bought. `tests/coverage-floors.json`,
`tests/hygiene-budgets.json`, `tests/quality/unbounded-query-waivers.json`
and every classification fingerprint other than the matrix one are
untouched.

## What changed

Every file committed since `e40f060e`, by tree.

### Rulings and docs

- `docs/decisions.md` — the four `R-*` rulings as `## Rebuilding Agenda, Notes and Tasks (#834)`, and the amendment recording that the three apps left `AWAITING_HANDOFF` on both surfaces (only Tally is still held back), that their rows returned to `state-honesty` / `shared-css` / `untrusted-rendering` / the accessibility contract, and that the rebuild added no `agent-only` withholding.
- `docs/blueprint-seats.md` — Tasks' north star is Todoist alone, linking the ruling.
- `docs/glossary.md` — a new **Projection doctrine** section: `projection`, `day context`, `ribbon / shelf`, `re-entry`; Tasks added to the north-star row's examples.
- `docs/design-divergences.md` — a new **Agenda, Notes and Tasks — rebuild divergences (#834)** section (Tasks' own row rungs, the sourceless holiday layer, the binary relationship tier, the `WEBVIEW_APPS` misnomer, Notes' absent band claim, Send to Tasks keeping no copy, the own-scope shelf); the #831 density paragraph refreshed to current state and the file's title widened.
- `CHANGELOG.md` — one `### Added` entry under `[Unreleased]` for the three restored interfaces, saying plainly that Tally is not part of it.
- `QUALITY.md` — one observation opened by this sweep: a parallel wave's slices each verified their own tree and reported clean, and four repo-wide reds surfaced only at integration; the norm worth considering is that a slice's exit condition is the repo-wide gate for the lanes its tree participates in.
- `receipts/issue-834-rebuild-agenda-notes-tasks-interfaces.md` — this receipt.

### The shared recurrence engine, ahead of the apps

Agenda and Tasks both have to say when a thing repeats, so the engine
landed before the rooms — otherwise the rebuild grows two grammars that
drift.

- `packages/core/src/time/recurrence-summary.ts` (new) — THE member-facing summariser: day and month names spelled out, an ordinal month-day, an "every other" cadence, a count or an until clause, and `null` for a rule it cannot phrase. The terse version is excised from `packages/core/src/time/recurrence.ts`, which keeps a comment saying where the two moved.
- `packages/core/src/time/recurrence-collapse.ts` (new) — `collapseMissedOccurrences` answers `{missed, nextDue}` so a repeating item never stacks; capped at `MAX_MISSED`, clock injected.
- `packages/core/src/time/index.ts` — re-exports both, drops `describeRecurrence` from the `recurrence.js` line.
- `packages/server/src/engine/types.ts` (also gains the `shiftTemporal` row it was missing), `packages/blueprints/types/centraid.d.ts`, `packages/server/src/engine/worker/runner.ts` (the frozen `time` bag and its `unavailableTime` fallbacks) — `collapseMissedOccurrences` threaded through every `TimeApi` declaration.
- `packages/client/src/react/blueprints/inlineQueryCtx.ts` — mounts a `time` facade on the inline query ctx where there was none, the same five pure functions the gateway worker mounts.
- `packages/blueprints/apps/tally/queries/dashboard.ts` — drops its `?? template.rrule` fallback: an unphrasable rule ships `preview: null` rather than putting RRULE syntax on a member-facing surface.
- `packages/core/src/time/recurrence.test.ts`, `recurrence-properties.test.ts`, and the new `recurrence-lifecycle-properties.test.ts` (the split that took the properties file 660 → 425 lines); `packages/core/stryker.time.config.mjs`, `packages/core/vitest.time.mutation.config.ts`, `scripts/mutation/seeds.mjs` follow the file list.

### Agenda — `packages/blueprints/apps/agenda/`

Chrome and rooms: `Chrome.tsx`, `Chrome.module.css`, `app-root.tsx`,
`frame.tsx`, `views.ts`, `views.test.ts`, `logic.ts`, `format.ts`,
`edits.ts`, `edits.test.ts`, `types.ts`, `member-prefs.ts`,
`view-copy.ts`, `view-copy.test.ts`.

Components: `components/Grid.tsx` + `Grid.module.css`,
`components/ListViews.tsx` + `.module.css`, `components/EventDetail.tsx` +
`.module.css`, `components/EventEditor.tsx` + `.module.css`,
`components/QuickAdd.tsx` + `.module.css`, `components/Rail.tsx` +
`.module.css`, `components/MoreSheet.tsx` + `.module.css`,
`components/Shared.tsx` + `.module.css`, and the wave-2
`components/DayContext.tsx` + `DayContext.module.css`.

Day context and queries: `day-context.ts`, `day-context.test.ts`,
`day-context-copy.ts` (import-free leaf, so the seat boundary duplicates no
definition), `queries/day-context.ts` (new, read-only, bounded to a
400-day span, `vaultDenied` as data), `queries/upcoming.ts` and
`queries/search.ts` (rows decorate with `recurrence_summary`, absent rather
than raw on an older gateway), `app.json` (the query, its schemas, the
three read-only flag-vocabulary scopes), `app-inline.tsx` (the queries
map).

### Notes — `packages/blueprints/apps/notes/`

Chrome and rooms: `Chrome.tsx` + `Chrome.module.css`, `app-root.tsx`,
`frame.tsx`, `logic.ts`, `shelves.ts`, `shelves.test.ts`, `format.ts`,
`format.test.ts`, `powerbox.ts`, `powerbox.test.ts`, `types.ts`,
`view-copy.ts`, `view-copy.test.ts`.

Components: `components/Library.tsx` + `.module.css`,
`components/Editor.tsx` + `.module.css`, `components/Places.tsx` +
`.module.css`, `components/Overlays.tsx` + `.module.css`,
`components/States.tsx` + `.module.css`,
`components/history-order.test.tsx`.

Queries and actions: `queries/journal.ts` + `queries/journal.test.ts`
(new, read-only, include-only over the same marker set the other three
exclude), `queries/library.ts`, `queries/search.ts`,
`queries/link-targets.ts` (the journal exclusion),
`actions/send-to-tasks.ts` (new), `send-to-tasks.ts` +
`send-to-tasks.test.ts` (the page-side half), `pending-projection.ts` (the
`send-to-tasks` exclusion with its reason), `app.json`, `app-inline.tsx`.

Shared: `packages/blueprints/apps/_shared/journal-scheme.ts` (new — the
People-journal scheme URI, the `entry` notation, and `readJournalNoteIds`).
The two pre-existing copies of the scheme URI
(`packages/vault/src/commands/people.ts`,
`packages/blueprints/apps/people/queries/journal.ts`) are deliberately left
alone — they are other packages' trees.

### Tasks — `packages/blueprints/apps/tasks/`

Chrome and rooms: `Chrome.tsx` + `Chrome.module.css`, `app-root.tsx`,
`frame.tsx`, `logic.ts`, `logic.test.ts`, `shelves.ts`, `format.ts`,
`format.test.ts`, `types.ts`, `when.ts` (import-free leaf),
`routes.test.ts`, `view-copy.ts`, `view-copy.test.ts`,
`scope-declaration.ts`, `scope-fanout.ts`.

Components: `components/Board.tsx` + `Board.module.css`,
`components/TaskRow.tsx`, `components/Rail.tsx`, `components/Screens.tsx`,
`components/Panels.tsx`, `components/Editor.tsx`,
`components/States.tsx`, `components/Confirm.tsx`.

Queries and manifest: `queries/board.ts`, `queries/search.ts` (rows carry
`recurrence_summary`, `missed`, `next_due` from `ctx.time`), `app.json`.

### Blueprints registry and guards — `packages/blueprints/`

- `index.json`, `manifest.json` — regenerated over every wave-1/2 file (the queries, the actions, the new modules) and over the Todoist-alone catalogue copy.
- `src/handler-reachability.test.ts` — `AWAITING_HANDOFF` drained to `tally` on web and mobile; Agenda's `day-context` reached natively.
- `src/state-honesty.test.ts`, `src/shared-css.test.ts`, `src/untrusted-rendering.test.ts` — the three apps' rows back.
- `src/app-boot-harness.ts`, `src/app-boot/agenda.test.ts`, `src/app-boot/notes.test.ts`, `src/app-boot/tasks.test.ts` — the boot lane, with Agenda's populated replica fixture and its pending-chip journey over the production intent-invalidation derivation.
- `src/day-context-journal-queries.test.ts` (new, nine tests over a mocked `ctx.vault` that records every read), `src/query-handlers.test.ts` (`collapseMissedOccurrences` on the `ctx.time` it builds).
- `types/centraid.d.ts` — the `TimeApi` row and `openApp`.
- `scripts/accessibility-contract.test.mjs` — the modal pair's rows for the rebuilt apps.

### Client shell — `packages/client/src/react/`

- `blueprints/centraid-inline.ts`, `shell/routes/InlineAppRoute.tsx` — the `openApp` door, navigation-only.
- `blueprints/inlineQueryCtx.ts` — the `time` facade (above).
- `shell/routes/homeTiles.ts`, `shell/routes/homeTileContent.ts`, `shell/routes/homeTileContent.test.ts`, `screens/HomeSpringboard.tsx` — the Tasks tile's glance (`3 today`, `next · …`), importing Tasks' own predicates. Both halves are absent rather than zero: "0 today" is a score, and this is a pile the member can look at — no badge, no dot, nothing red.

### Mobile — `apps/mobile/src/`

- Agenda: `apps/agenda/AgendaHome.tsx` + `AgendaHome.styles.ts`, `AgendaEvent.tsx`, `AgendaEventEditor.tsx`, `AgendaCreateModal.tsx`, `AgendaBand.tsx`, `agenda-band.ts`, `AgendaDayContext.tsx`, `day-context.ts`, `day-context.test.ts`, `useAgenda.ts`.
- Notes: `apps/notes/NotesHome.tsx` + `NotesHome.styles.ts`, `notes-model.ts`, `notes-model.test.ts`, `useNotes.ts`.
- Tasks: `apps/tasks/TasksScreen.tsx`, `TasksHome.tsx` + `TasksHome.styles.ts`, `TasksBand.tsx`, `tasks-band.ts`, `tasks-band.test.ts`, `useTasks.ts`.
- Band roster: `kit/band/band-owner.ts`, `kit/band/band-owner.test.ts`.
- The one birthday notification: `lib/birthday-notifications.ts` + `lib/birthday-notifications.test.ts` (new), `lib/notification-model.ts`, `lib/notifications-core.ts`, `lib/notifications.tsx` — member-tunable lead, deep link, inner circle only.
- `knip.json` — the `@react-native-community/datetimepicker` ignore dropped, because the rebuilt native editor imports it again.

### Gates and evidence (wave 3)

- `tests/matrix.json` — `desktop.offline` and `blueprints.performance` notes, the `web-offline-pending-row` and `desktop-delete-app-journey` deviation paragraphs, and #831/#834 registered in `trackingIssues`.
- `tests/quality/classification-ratchet.json` — `fingerprints["tests/matrix.json"]` re-pinned with the `approvedDeviation` quoted above.
- `apps/web/tests/e2e/rebuilt-apps.spec.ts` (new) — two Playwright journeys over the SHIPPED components on the SHIPPED tokens and `kit.css`, emitting `artifacts/e2e/ui-impact/issue-834-tasks-board.png` and `artifacts/e2e/ui-impact/issue-834-agenda-day-context.png`.
- `packages/blueprints/apps/notes/pending-projection.ts` — the `send-to-tasks` exclusion.
- The four sweep fixes above, in their own files: `packages/blueprints/apps/tasks/format.ts`, `packages/blueprints/apps/tasks/logic.ts`, `packages/blueprints/apps/tasks/app-root.tsx`, `packages/blueprints/apps/tasks/components/States.tsx`, `packages/blueprints/apps/notes/logic.ts`, `packages/blueprints/apps/notes/send-to-tasks.test.ts`, `packages/blueprints/apps/agenda/components/DayContext.tsx`, `packages/blueprints/apps/agenda/day-context.test.ts`, `packages/blueprints/apps/agenda/view-copy.test.ts`, `apps/mobile/src/lib/birthday-notifications.ts`, `apps/mobile/src/lib/birthday-notifications.test.ts`, `apps/mobile/src/apps/agenda/AgendaHome.tsx`, `apps/mobile/src/apps/agenda/day-context.test.ts`.

## User impact

Agenda, Notes and Tasks open to real rooms again, on desktop, web and the
phone. **Tasks** is drawn to Todoist's depth: projects and areas, families
kept whole so a windowed parent never looks like it lost its work, and a
repeating task shown as ONE live occurrence with the periods you missed
collapsed beside it — `missed 4 · next is Friday` — instead of a stack of
copies. Overdue is one group that offers to catch up, in quiet verbs beside
its header; `won't do` is a respectable exit, not a failure. Nothing counts
at you: no badge, no dot, no red. **Notes** promotes your first line as the
title everywhere, links notes with `[[`, keeps an append-only version chain
whose restore never loses what it replaced, holds deleted notes for 30
days, and gives journal entries their own **Journal** place — they no
longer surface as ordinary notes in the library, in search, or in the link
powerbox. A checklist line can be handed to **Tasks** in one gesture; the
task is minted in Tasks and linked back, never copied. **Agenda** draws
day, week, month, schedule and search over the same events, states a
recurrence in words rather than a rule, and says plainly when a
cancellation is waiting for your confirmation instead of pretending it is
done. On top of it the calendar learns three facts other apps own without
copying any of them: birthdays ride the day as a ribbon (`🎂 Dana`,
collapsing to `2 birthdays` in a month cell) and only people you have
starred earn the one notification; due tasks collapse into a single
`3 due` line above the day that opens to their names and hands you to
Tasks; holidays take the same ribbon shape. Layers are read-only and say so
once, under the switches: none of them is a fourth calendar. Tally is
unchanged — it keeps the empty pane #831 left it.

First-run: a vault with nothing in it says what it is and offers exactly
one way in. Tasks' first day says "Add the first thing you must not
forget." with two acts and no rows; a day with everything done says
"Everything due today is done." rather than an ambiguous all-clear, and a
day with nothing scheduled says so and names where undated work actually
lives. Agenda's layer switches are all on with nothing behind them: the
ribbon and the shelf simply do not draw, and the holidays layer stays empty
because there is no holiday source to subscribe to yet — the switch is
present and honest rather than absent. Notes opens on an empty library
with the Journal place already there. No spinner-forever, no error tone, no
invented rows anywhere in the empty case.

Screenshot evidence: `artifacts/e2e/ui-impact/issue-834-tasks-board.png`
and `artifacts/e2e/ui-impact/issue-834-agenda-day-context.png`, emitted by
`apps/web/tests/e2e/rebuilt-apps.spec.ts`. Stated honestly: the Playwright
chromium binary is absent in this container, so the journey RUNS IN CI
(`bun run --cwd apps/web e2e`); here each harness entry was bundled with
the same esbuild call the spec makes and rendered in jsdom, and every
string and role the spec asserts was verified present in that render — the
attention tone on the overdue group and on its due phrase and nowhere
else, `every Friday` with no `RRULE` anywhere, the whole family under its
parent, `3 of 214 · this is a window, not everything open`, the three
layer switches with their sources, `Layers decorate a day; none of them is
writable.`, the collapsed `2 birthdays` ribbon, and the `2 due` shelf
closed by default.

## Out of scope

**Tally.** The fourth #831 app has no design brief yet; its interface stays
in `AWAITING_HANDOFF`, untouched on every seat, and the matrix and
decisions docs say so.

**A holiday source for the vault.** The layer ships with the switch drawn
and the list always empty. Designing a feed, a subscription mechanism or a
poller is a separate ruling.

**A People-side day-context surface.** Birthdays are read from the
canonical `core.party.birth_date` spine; People grows no projection of its
own here, and `add_note` stays an annotation on the party — person-notes
are deliberately out of the Notes library.

**Time-blocking.** A due date has no time cost, so it takes shelf shape
and never grid shape. A task earns grid shape only through a deliberate
time-blocking gesture, which this umbrella does not draw.

**Backlinks as a reverse query.** Notes links forward with `[[` and the
edge is real (`core.link_entities`), but no "what links here" reverse
projection is drawn.

Also untouched: action semantics on all three apps, the replica/outbox
engine, vault consent, the Things-shaped task vocabulary in the backend,
native fingerprint / CocoaPods state (the `datetimepicker` module was
always autolinked — only its knip ignore moved), and any notification
machinery beyond the single inner-circle birthday one.

## Verification

Every command below was run at the finished tree.

The blueprint package — the three rebuilt trees, their guards, the boot
lane and the manifest law:

```sh
bun run --cwd packages/blueprints test
```

132 files, **4511 passed**. This is where the sweep's one red surfaced and
was fixed: `apps/_shared/pending-overlay.test.ts`'s
`[law:pending-overlay] all eight blueprints declare every action` failed
with `- "send-to-tasks"` — wave 2's new Notes action had no
pending-projection row — and passes now that the exclusion is declared
with its reason.

The time engine, both new modules and the split properties file:

```sh
bunx vitest run packages/core/src/time/
```

4 files, 86 passed.

The matrix, its wiring, and the quality-knob governance:

```sh
bun run test:matrix
bun run lint:quality-knobs
```

`matrix: 15 surfaces × 11 dimensions, 128 canonical flows` /
`135 owned cells graded from evidence, 25 inventoried skips`; nightly and
release wiring pass. `lint:quality-knobs` reports
`quality knob governance: no silent widening` with the re-pinned matrix
fingerprint and this receipt's `approvedDeviation`.

The user-facing quality gates, including both copy gates:

```sh
bunx vitest run --config vitest.quality.config.ts tests/quality/user-facing-qualities.test.ts
```

15 passed — U2 (the nav-literal ban) and U4 (the copy ratchet) both green
over the three rebuilt trees with **no new allowlist entry**, and P3's
unbounded-query waiver file still empty.

The coverage blend the three apps land in
(`packages/blueprints/apps/{_shared,agenda,docs,locker,notes,people,tally,tasks}/**`,
floor 20 lines / 14 branches), measured over the blueprints project with
the repo's own include/exclude:

```sh
bunx vitest run --coverage   # scoped to the blend glob; see tests/coverage-floors.json
```

**42.21% lines / 33.08% branches** (3916/9276 lines, 2870/8674 branches) —
clear of the floor with margin, so no floor moved and no test was written
to buy one.

The UI-receipt gate:

```sh
bun run check:ui-receipt
```

`UI receipt gate: evidence verified`.

Typechecks:

```sh
bun run typecheck
```

Clean across the workspace, including `packages/blueprints`' two projects
(`tsconfig.test.json` and `tsconfig.apps.json`) and `apps/web` with the new
spec.

The push gate:

```sh
bun run check:push
```

**40 of 43 green.** Three reds, none of them a product failure and none
left unexplained:

- `test:affected` — ENVIRONMENT. `Error: Electron failed to install
  correctly` in `@centraid/desktop:test`; the sibling packages report exit
  130 because the runner cancels them once one fails. The same packages are
  green when run directly (`packages/blueprints` 4511, `apps/mobile` 1659).
- `design:gallery` — ENVIRONMENT. It drives Playwright chromium, which is
  not downloaded in this container (`npx playwright install`).
- `format:check` — ENVIRONMENT, and only under the 43-gate concurrent
  runner: `apps/mobile/package.json` is rewritten (script keys reordered)
  while the mobile lane runs, so the formatter sees a file nothing in this
  change touched. It is not reproducible from `check:mobile-native-state`,
  `apps/mobile test`, or `test:affected` run singly, and the file is
  reverted and clean here. Run on its own, `bun run format:check` reports
  `All matched files use the correct format.` over all 4448 files.

Every other gate is green, including the ones this sweep repaired: `lint`,
`scripts:test` and `lint:engine-conformance` were red on the first
`check:push` of the finished tree and are green now, fixed in the code
(see `## Decisions`). The three environment reds are green in CI, which is
also where `apps/web/tests/e2e/rebuilt-apps.spec.ts` runs its browser.

The individual gates this sweep is responsible for, each re-run on its own
after the tree settled:

```sh
bun run format:check     # all 4448 files correct
bun run lint             # clean, --deny-warnings
bun run test:matrix      # 15 surfaces × 11 dimensions, 128 flows
bun run lint:quality-knobs   # no silent widening
bun run check:ui-receipt     # evidence verified
bun run lint:engine-conformance  # one door per verb
```

Demonstrated red, seeded and recorded across the umbrella: the library leg
of the journal test failed twice before the handler was correct — first
`['concept-errands', 'concept-entry'] !== ['concept-errands']` from the
unfiltered tag rows, then again from the unfiltered concept rows — and
passed only once `library.ts` re-narrowed both to the surviving window.
The pending-overlay law's failure above is the second, found by this
sweep rather than by CI.

## Audit

**REFUTED** — 2026-08-21. Second fresh-context audit, re-adjudicated from
scratch against the committed range `e40f060e..HEAD` (HEAD is now
`02dd1ec4`) on `claude/issue-834-integration-prompt-co5z19`, this receipt
and issue [#834](https://github.com/srikanth235/centraid/issues/834); the
dirty working tree was excluded.

What the repair fixed, and what holds on re-reading the code:

- File coverage over the first six commits (`a7023f24..59144dce`) is now
  complete — every file of that sub-range is named, including the whole
  recurrence-summariser slice, `inlineQueryCtx.ts`'s new `time` facade and
  Tally's dropped `?? template.rrule` fallback.
- Every `- [x]` row is realized in code. `docs/decisions.md` carries the
  four `R-*` rulings; Todoist-alone lands in `docs/blueprint-seats.md`,
  `apps/tasks/app.json`, `index.json` and the regenerated `manifest.json`
  (no "Things-style" survives there); the journal exclusion runs in all
  three Notes queries via `apps/_shared/journal-scheme.ts`; exactly one
  `describeRecurrence` definition exists repo-wide, in
  `packages/core/src/time/recurrence-summary.ts`;
  `collapseMissedOccurrences` is present in all three `TimeApi`
  declarations and on the inline ctx; Agenda's `upcoming` and `search`
  really do carry `recurrence_summary`.
- Two claims that read as overclaims are exact:
  `recurrence-properties.test.ts` was 660 lines at `681d264d` and is 425
  at HEAD, and `manifest.json` is genuinely NOT regenerated over the
  wave-1 files — it carries `day-context` and no Notes `journal` entry,
  as the receipt itself confesses.

Why the verdict is still REFUTED — a seventh commit, `02dd1ec4` ("wip
(#834): wave 1 builder snapshot"), is in the committed range and the
receipt does not describe it at all:

- **54 of the 104 changed files in the range are unnamed**, all from that
  commit: ~11.4k lines of Agenda/Notes/Tasks chrome, components, CSS
  modules, `frame.tsx`, `logic.ts`, `views.ts`, `edits.ts` and
  `apps/tasks/routes.test.ts`.
- **Two statements are now positively false, not merely incomplete.**
  `### Wave 1, in progress` says "no `app-root.tsx` paints them" and
  `## Out of scope` says "no `app-root.tsx` renders them … paint nothing
  on either surface". At HEAD `apps/notes/app-root.tsx` (850 lines) and
  `apps/tasks/app-root.tsx` are full rendering trees importing
  `./logic.ts`, `./shelves.ts`, `./view-copy.ts` and `./components/*`.
  Only Agenda's root still paints an empty `<div>`, its Chrome and
  components committed but unmounted.
- **A third backend delta is unnamed**: `apps/tasks/queries/board.ts` and
  `apps/tasks/queries/search.ts` now decorate rows with
  `recurrence_summary`, `missed` and `next_due` from `ctx.time`. The
  receipt names only Agenda's two queries as carrying summariser output.
- **An unnamed governance waiver landed**: `apps/notes/app-root.tsx`
  opens with `governance: allow-repo-hygiene file-size-limit`. Whatever
  its merits, an allow-marker is a policy fact a receipt must record.
- `## Verification` covers none of the wave-1 UI — no route, render or
  design-lint run is recorded for 11.4k committed lines.

`## Checklist` still mirrors the issue honestly: the unchecked wave-1 and
`check:push` rows are expected mid-umbrella, and no checked row
overclaims. As before the refutation is description, not inflation — but
it is now sharper, because the receipt asserts the absence of interfaces
the committed diff contains.
