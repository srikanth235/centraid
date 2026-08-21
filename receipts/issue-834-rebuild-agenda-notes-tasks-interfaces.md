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

The `day-context` literal appears only in `app.json` and `app-inline.tsx`
— the two files `handler-reachability.test.ts` skips — because Agenda is
still in `AWAITING_HANDOFF` and that gate asserts its handler names are
ABSENT from the rendered tree. No `NATIVE_QUERY_UI` / `WEB_EXCEPTIONS` row
is added: those must name a live handler dispatch, which wave 1 supplies.

## What changed

`docs/decisions.md` gains `## Rebuilding Agenda, Notes and Tasks (#834)` —
a dated ruling paragraph, the four-row `R-*` table, and the closing
operational-consequence sentence. `docs/blueprint-seats.md`'s Tasks row is
Todoist alone and links the ruling.

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

`packages/blueprints/apps/tasks/app.json` and
`packages/blueprints/index.json` replace "A Things-style task manager"
with the Todoist-consistent phrasing; `packages/blueprints/manifest.json`
is regenerated and picks up both that copy and the new query file.

`packages/blueprints/src/day-context-journal-queries.test.ts` is new: nine
tests over a mocked `ctx.vault` that records every read.

## Out of scope

The rebuilt interfaces themselves. Agenda, Notes and Tasks stay in
`handler-reachability.test.ts`'s `AWAITING_HANDOFF` and paint nothing on
either surface; nothing dispatches `day-context` yet. A holiday source for
the vault is not designed here — the field ships empty and honest. Notes'
Journal place (the filter over the journal scheme that these excluded
notes now depend on for their one home) is wave 1 work. The Things-shaped
task vocabulary is not renamed.

## Verification

Handler and manifest gates, all green:

```sh
bunx vitest run packages/blueprints/src/day-context-journal-queries.test.ts
bunx vitest run packages/blueprints/src/query-handlers.test.ts \
  packages/blueprints/src/handler-reachability.test.ts \
  packages/blueprints/src/app-manifests.test.ts \
  packages/blueprints/src/blueprint-seats.test.ts
bun run --cwd packages/blueprints typecheck
bunx vitest run --config vitest.quality.config.ts -t "P3"
```

`day-context-journal-queries.test.ts` — 9 passed. The four manifest /
reachability / seats suites — 133 passed (`app-manifests.test.ts` needs
`bun run --cwd packages/server build` first; it imports
`@centraid/server/engine` from `dist`). `packages/blueprints` typecheck —
clean, both `tsconfig.test.json` and `tsconfig.apps.json`. The P3
boundedness gate passes with `tests/quality/unbounded-query-waivers.json`
still empty.

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
  packages/blueprints/apps/_shared/journal-scheme.ts \
  packages/blueprints/apps/notes/queries packages/blueprints/apps/agenda \
  packages/blueprints/src/day-context-journal-queries.test.ts
```

`internal-doc-links` passes. `oxlint` is clean and every touched file is
`oxfmt`-formatted. `repo-hygiene` reports one violation,
`packages/core/src/time/recurrence-properties.test.ts` at 660 lines
against the 625 limit — that file belongs to the recurrence-summariser
slice, not to this one, and is fixed there.
