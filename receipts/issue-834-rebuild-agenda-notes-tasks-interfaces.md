# Issue #834 — rebuild the Agenda, Notes and Tasks interfaces

GitHub issue: [#834](https://github.com/srikanth235/centraid/issues/834)

Three of the four interfaces cleared by
[#831](https://github.com/srikanth235/centraid/issues/831) are drawn again
from scratch. Stage 0 settles the four contract questions the screens
would otherwise be drawn over — which product Tasks is measured against,
where journal entries live inside Notes, how a calendar day learns facts
other apps own, and whose work a due-task shelf may count — and lands the
two read-only backend deltas the rebuilt Agenda and Notes need before any
UI exists to call them. Later waves grow this receipt.

## Checklist

- [x] Four rulings land in `docs/decisions.md` as `## Rebuilding Agenda, Notes and Tasks (#834)` — R-northstar, R-journal, R-daycontext, R-shelf-scope
- [x] Tasks' north star reads Todoist and only Todoist in `docs/blueprint-seats.md`, `packages/blueprints/apps/tasks/app.json` and `packages/blueprints/index.json`
- [x] Agenda gains the read-only `day-context` query, registered in its manifest and inline descriptor, with `CHANGE_TABLES` grown to match
- [x] Notes' `library`, `search` and `link-targets` exclude journal-scheme notes through one shared `apps/_shared/journal-scheme.ts`
- [x] Handler tests cover the day-context projection, its boundedness and denial shape, and the journal exclusion across all three Notes queries
- [x] The shared recurrence engine lands before the apps, as one humanised summariser and one missed-period collapse
- [x] `collapseMissedOccurrences` is threaded through every `TimeApi` declaration and mounted on the inline query ctx
- [x] No surface renders a raw rule: Tally's dashboard drops its RRULE fallback and Agenda's rows carry `recurrence_summary`
- [x] The recurrence properties file is back under the 625-line hygiene limit, split rather than trimmed
- [ ] Wave 1 — the rebuilt Agenda interface dispatches `day-context` and leaves `AWAITING_HANDOFF`
- [ ] Wave 1 — the rebuilt Notes interface, including the Journal place that is now these notes' one home
- [ ] Wave 1 — the rebuilt Tasks interface at the Todoist depth bar
- [ ] `bun run check:push` across the finished waves

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
ruling. Birthdays come from `core.party.birth_date`, which the vault
reconciles with `people.important_date` on every birthday write
(`packages/vault/src/commands/people.ts`), so Agenda reads the canonical
spine it already has a scope on rather than growing a People-side one.

Answering a tier needs the flag vocabulary, so Agenda grows three
read-only scopes — `core.tag`, `core.concept`, `core.concept_scheme`.
`schedule.task` needed none: Agenda already holds a schema-wide
`{schema: "schedule", verbs: "read+act"}` scope. The four new entities
join `CHANGE_TABLES` so a completed task or a newly starred person
re-decorates the grid instead of leaving it stale until the next nav.

#834 R-shelf-scope keeps the due-task day shelf on this vault's tasks.
There is no cross-vault aggregation behind those counts and no peer read
in the handler.

No live `day-context` dispatch exists yet. The name is registered
(`packages/blueprints/apps/agenda/app.json`, `app-inline.tsx`), reasoned
about in prose (`app-root.tsx`'s `CHANGE_TABLES` comment,
`docs/decisions.md`) and exercised by
`packages/blueprints/src/day-context-journal-queries.test.ts`, but nothing
in the rendered tree calls it — which is what `handler-reachability.test.ts`
asserts while Agenda sits in `AWAITING_HANDOFF`. No `NATIVE_QUERY_UI` /
`WEB_EXCEPTIONS` row is added either: those must name a live handler
dispatch, which wave 1 supplies.

## What changed

Four rulings land in `docs/decisions.md` as
`## Rebuilding Agenda, Notes and Tasks (#834)` — R-northstar, R-journal,
R-daycontext, R-shelf-scope: a dated ruling paragraph, the four-row `R-*`
table, and the closing operational-consequence sentence.

Agenda gains the read-only `day-context` query, registered in its manifest
and inline descriptor, with `CHANGE_TABLES` grown to match.
`packages/blueprints/apps/agenda/queries/day-context.ts` is new: a
read-only projection answering `{birthdays, due, holidays}` (plus
`vaultDenied` on denial, as data rather than a throw) over an inclusive
`YYYY-MM-DD` range that defaults to today plus 45 days and is capped at a
400-day span. Every read carries a `limit:` or an `op: "eq"|"in"`.
`packages/blueprints/apps/agenda/app.json` registers it with
`additionalProperties: false` input and output schemas and adds the three
read-only flag-vocabulary scopes;
`packages/blueprints/apps/agenda/app-inline.tsx` adds it to the queries
map; `packages/blueprints/apps/agenda/app-root.tsx` adds `schedule.task`,
`core.tag`, `core.concept` and `core.concept_scheme` to `CHANGE_TABLES`.

Notes' `library`, `search` and `link-targets` exclude journal-scheme notes
through one shared `apps/_shared/journal-scheme.ts`.
`packages/blueprints/apps/_shared/journal-scheme.ts` is new: the
People-journal scheme URI, the `entry` notation, and `readJournalNoteIds`
— three bounded reads resolving the marker to a set of note ids.
`packages/blueprints/apps/notes/queries/library.ts`,
`packages/blueprints/apps/notes/queries/search.ts` and
`packages/blueprints/apps/notes/queries/link-targets.ts` import it and drop
journal notes before any preview, tally, tag chip or link target is
derived. The two pre-existing copies of the scheme URI
(`packages/vault/src/commands/people.ts`,
`packages/blueprints/apps/people/queries/journal.ts`) are deliberately left
alone — they are other packages' trees.

Tasks' north star reads Todoist and only Todoist in
`docs/blueprint-seats.md`, `packages/blueprints/apps/tasks/app.json` and
`packages/blueprints/index.json`: the seats row is Todoist alone and links
the ruling, and the two catalogue entries replace "A Things-style task
manager" with the Todoist-consistent phrasing.
`packages/blueprints/manifest.json` is regenerated and picks up both that
copy and the new query file.

Handler tests cover the day-context projection, its boundedness and denial
shape, and the journal exclusion across all three Notes queries:
`packages/blueprints/src/day-context-journal-queries.test.ts` is new, nine
tests over a mocked `ctx.vault` that records every read. This receipt,
`receipts/issue-834-rebuild-agenda-notes-tasks-interfaces.md`, is the
umbrella's one receipt and grows with each wave.

### The shared recurrence engine, ahead of the apps

Agenda and Tasks both have to say when a thing repeats, so the shared
recurrence engine lands before the apps, as one humanised summariser and
one missed-period collapse — otherwise the rebuild grows two grammars
that drift.

`packages/core/src/time/recurrence-summary.ts` is new and is THE
member-facing summariser: day and month names spelled out, an ordinal
month-day, an "every other" cadence, a count or an until clause, and
`null` for a rule it cannot phrase. The terse version is excised from
`packages/core/src/time/recurrence.ts`, which keeps a comment saying
where the two moved and that they reach the engine from there and never
the other way round. `packages/core/src/time/recurrence-collapse.ts` is
also new: `collapseMissedOccurrences` answers `{missed, nextDue}` so a
repeating item never stacks — elapsed unactioned periods collapse into a
count beside the single live occurrence, capped at `MAX_MISSED`, with the
clock injected rather than read. `packages/core/src/time/index.ts`
re-exports both and drops `describeRecurrence` from the `recurrence.js`
line.

`collapseMissedOccurrences` is threaded through every `TimeApi`
declaration and mounted on the inline query ctx, rather than reaching one
plane: `packages/server/src/engine/types.ts` (which also gains the
`shiftTemporal` row it was missing),
`packages/blueprints/types/centraid.d.ts`, and
`packages/server/src/engine/worker/runner.ts`, where the frozen `time`
bag and its `unavailableTime` fallbacks both grow the member.
`packages/client/src/react/blueprints/inlineQueryCtx.ts` mounts a `time`
facade on the inline query ctx where there was none — the same five pure
functions the gateway worker mounts, imported straight from
`@centraid/core/time`, so the inline plane summarises a rule identically
instead of escalating to the gateway.

`packages/blueprints/apps/tally/queries/dashboard.ts` drops its
`?? template.rrule` fallback: a rule the summariser cannot phrase now
ships `preview: null` rather than putting RRULE syntax on a member-facing
surface. No surface renders a raw rule: Tally's dashboard drops its RRULE
fallback and Agenda's rows carry `recurrence_summary` (below). The Tally
change is member-visible and is made here because the summariser is the
thing that decides what "unphrasable" means.

`packages/core/src/time/recurrence.test.ts` and
`packages/core/src/time/recurrence-properties.test.ts` grow cases for the
new grammar and the collapse; the lifecycle properties then move out into
the new `packages/core/src/time/recurrence-lifecycle-properties.test.ts`.
The recurrence properties file is back under the 625-line hygiene limit,
split rather than trimmed — 660 lines before, 425 now. The three places
that name the time suite's files follow it:
`packages/core/stryker.time.config.mjs` (which also adds the two new
modules to `mutate`), `packages/core/vitest.time.mutation.config.ts` and
`scripts/mutation/seeds.mjs`. `packages/blueprints/src/query-handlers.test.ts`
adds `collapseMissedOccurrences` to the `ctx.time` it builds for handlers.

### Wave 1, in progress

The wave-1 rows above stay unchecked, but builder snapshots for the three
rooms are in the range and are not finished interfaces: no `app-root.tsx`
paints them, nothing dispatches `day-context`, and all three apps remain
in `AWAITING_HANDOFF`.

What is committed is the pure, DOM-free half each room is derived from:
route tables over `apps/_shared/shelves.ts`, page-side shapes grounded in
the queries that already exist, clock-injected formatters, Tasks' twelve
board states, its record-only scope declaration and board fan-out, and
each room's copy table. Every file of it, by path:

- Agenda — `packages/blueprints/apps/agenda/types.ts`,
  `packages/blueprints/apps/agenda/view-copy.ts`
- Notes — `packages/blueprints/apps/notes/types.ts`,
  `packages/blueprints/apps/notes/shelves.ts`,
  `packages/blueprints/apps/notes/format.ts`,
  `packages/blueprints/apps/notes/powerbox.ts`,
  `packages/blueprints/apps/notes/view-copy.ts`
- Tasks — `packages/blueprints/apps/tasks/types.ts`,
  `packages/blueprints/apps/tasks/shelves.ts`,
  `packages/blueprints/apps/tasks/format.ts`,
  `packages/blueprints/apps/tasks/logic.ts`,
  `packages/blueprints/apps/tasks/scope-declaration.ts`,
  `packages/blueprints/apps/tasks/scope-fanout.ts`,
  `packages/blueprints/apps/tasks/view-copy.ts`

Two backend deltas came with them. Notes gains the Journal place as a real
query — `packages/blueprints/apps/notes/queries/journal.ts`, read-only and
include-only over the same marker set the other three projections exclude
— registered in `packages/blueprints/apps/notes/app.json` and
`packages/blueprints/apps/notes/app-inline.tsx`. And Agenda's
`packages/blueprints/apps/agenda/queries/upcoming.ts` and
`packages/blueprints/apps/agenda/queries/search.ts` now decorate each row
with `recurrence_summary` from `ctx.time.describeRecurrence` (absent, not
raw, on an older gateway without the helper), with
`packages/blueprints/apps/agenda/app.json`'s two descriptions saying so.
`packages/blueprints/manifest.json` is NOT regenerated over these wave-1
files — it still carries only the stage-0 regeneration — so the manifest
gate is a wave-1 close-out item, recorded here rather than left to be
discovered.

## Out of scope

The FINISHED interfaces. The pure halves named above are committed, but
no `app-root.tsx` renders them, no native screen imports them and no
route dispatches `day-context`; Agenda, Notes and Tasks all stay in
`handler-reachability.test.ts`'s `AWAITING_HANDOFF` and paint nothing on
either surface. Mobile is untouched in this range. A holiday source for
the vault is not designed here — the field ships empty and honest. The
Things-shaped task vocabulary is not renamed. Nothing in `packages/vault`
or in People's own journal projection is touched: the two pre-existing
copies of the scheme URI stay where they are.

## Verification

The time engine, both new modules and the split properties file:

```sh
bunx vitest run packages/core/src/time/
```

4 files, 86 passed — `recurrence.test.ts`,
`recurrence-properties.test.ts`, the new
`recurrence-lifecycle-properties.test.ts` and `timezone-properties.test.ts`.

Handler, manifest and seat gates:

```sh
bunx vitest run packages/blueprints/src/day-context-journal-queries.test.ts \
  packages/blueprints/src/query-handlers.test.ts
bunx vitest run packages/blueprints/src/handler-reachability.test.ts \
  packages/blueprints/src/app-manifests.test.ts \
  packages/blueprints/src/blueprint-seats.test.ts
bunx vitest run --config vitest.quality.config.ts -t "P3"
```

The two handler suites — 22 passed (9 day-context/journal, 13
query-handlers, the latter now building its `ctx.time` with
`collapseMissedOccurrences`). The manifest / reachability / seats suites —
133 passed at stage 0 (`app-manifests.test.ts` needs
`bun run --cwd packages/server build` first; it imports
`@centraid/server/engine` from `dist`); they are re-run at the wave-1
close-out, when `manifest.json` is regenerated over the new query. The P3
boundedness gate passes with `tests/quality/unbounded-query-waivers.json`
still empty.

Typechecks, over each package this range touched:

```sh
bun run --cwd packages/core typecheck
bun run --cwd packages/server typecheck
bun run --cwd packages/blueprints typecheck
```

All three clean; `packages/blueprints` covers both `tsconfig.test.json`
and `tsconfig.apps.json`, so the wave-1 modules typecheck as well as the
queries.

Demonstrated red, seeded and recorded: the library leg of the journal
test failed twice before the handler was correct — first
`['concept-errands', 'concept-entry'] !== ['concept-errands']` from the
unfiltered tag rows, then again from the unfiltered concept rows — and
passed only once `library.ts` re-narrowed both to the surviving window.

Governance directives over the change:

```sh
bash .governance/packs/governance-kit/foundation/directives/internal-doc-links/check.sh
bash .governance/packs/governance-kit/foundation/directives/repo-hygiene/check.sh
bunx oxlint -c oxlint.config.ts --disable-nested-config --deny-warnings \
  $(git diff --name-only e40f060e..HEAD | grep -E '\.(ts|tsx|mjs)$')
```

`internal-doc-links` passes. `repo-hygiene` passes: the 660-line
`recurrence-properties.test.ts` violation reported at stage 0 is fixed in
this same range by the lifecycle-properties split, and the file is now
425 lines. `oxlint` over every source file this range commits exits 0, and
every touched file is `oxfmt`-formatted.

`bun run check:push` across the finished waves is still owed — the wave-1
row above is unchecked, and this range is a builder snapshot.

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
