# issue-310 — Ontology drift audit: silo re-introductions + structural blind spots

GitHub issue: [#310](https://github.com/srikanth235/centraid/issues/310)

The full-scope implementation of the #310 audit: the four silo
re-introductions closed (tally shadow ledger, opaque outbox, locker island,
three group mechanisms), the universal mechanisms extended to the new
domains, the dead corners of the agent/consent planes brought to life
(judgment loop, per-class enrichment consent, convergence sweep), and the
doc of record regenerated to v1.2 with the standing stances written down.

Owner directive mid-flight: **v0 has no past to migrate** — no v16+ patch
rungs; the migration ladder collapsed to one composed rung and every schema
module now carries its final shape. Dev vaults are recreated, not migrated.

## Checklist

- [x] Commit 1 — schema: collapse the migration ladder to one rung (v0)
- [x] Commit 2 — S1: tally→finance bridge (settle_up emits, bind_txn adopts)
- [x] Commit 3 — S2: outbox graph refs + drained sends publish back to canon
- [x] Commit 4 — S3: locker connection anchor + tags→core_tag (item_tag deleted)
- [x] Commit 5 — S4: tally groups decorate social.circle (group_member deleted)
- [x] Commit 6 — C6: FTS + memos for locker/tally
- [x] Commit 7 — C1: judgment loop write surface (record/distill/revoke)
- [x] Commit 8 — C3: per-class standing consent for enrichment
- [x] Commit 9 — C4: core.find_duplicate_parties (the convergence sweep)
- [x] Commit 10 — A/S5/C5/C6: doc v1.2, stances, domain admission checklist
- [x] Commit 11 — this receipt + demo-purge/lint/typecheck fixes
- [x] C2 — sharing design FILED as [#311](https://github.com/srikanth235/centraid/issues/311)

## What changed

Eleven commits plus the filed design, mirroring the checklist:

- Commit 1 — schema: collapse the migration ladder to one rung (v0)
- Commit 2 — S1: tally→finance bridge (settle_up emits, bind_txn adopts)
- Commit 3 — S2: outbox graph refs + drained sends publish back to canon
- Commit 4 — S3: locker connection anchor + tags→core_tag (item_tag deleted)
- Commit 5 — S4: tally groups decorate social.circle (group_member deleted)
- Commit 6 — C6: FTS + memos for locker/tally
- Commit 7 — C1: judgment loop write surface (record/distill/revoke)
- Commit 8 — C3: per-class standing consent for enrichment
- Commit 9 — C4: core.find_duplicate_parties (the convergence sweep)
- Commit 10 — A/S5/C5/C6: doc v1.2, stances, domain admission checklist
- Commit 11 — this receipt + demo-purge/lint/typecheck fixes
- C2 — sharing design FILED as [#311](https://github.com/srikanth235/centraid/issues/311)

## Decisions of record

- **Groups unify on social.circle, not core.collection** — the #274 comment
  in core.ts already decided audiences deliberately stay separate from
  collections; a tally group IS an audience, so it decorates a circle.
- **Owner-involved settlements emit; third-party settlements don't** — a
  friend-paying-friend movement is not the owner's money and core
  transactions require an owner account; those stay tally ground facts.
  Expenses BIND (Studio pattern) rather than emit — the bank import is the
  canonical row, and emitting would double-count it.
- **Locker `notes` stays a domain column and out of FTS** — it routinely
  carries recovery codes; the plaintext, searchable remark ABOUT an item is
  the new `locker.set_memo` annotation instead.
- **transcripts.db stays outside the graph** (S5, stance recorded in the
  doc): the door in, if ever, is a thin core.activity projection.
- **Version brokering is equality until v1** (C5, stance recorded in the
  doc and at the check in execution.ts). ONTOLOGY_VERSION bumped to 1.2.
- **Outbox drain-side publish covers message-shaped artifacts only** — a
  calendar payload is not a message; other verb families join when their
  canonical shapes are clear.

## Out of scope

- Typed `(actor, target)` columns on `outbox_grant` — the standing-grant
  key stays TEXT; flagged in #310 as adjacent to the #308 self-escalation
  thread, better handled there.
- FTS for outbox items — operational queue rows, statuses churn; search
  value unproven. Considered and skipped.
- Automatic judgment distillation (a model proposing rules from correction
  streams) — assistant-side work that lands on the new command surface.
- Sharing implementation — design filed as #311; `consent_share` stays
  schema-only until that lands.
- The pre-existing 23 oxlint errors on main (blob/local.ts, mbox.ts,
  connections-routes.test.ts, …) — untouched; this branch is lint-neutral.
- Blueprint app UI affordances for the new inputs (connection anchor
  picker, memo fields) — commands and scopes are live; UI is a follow-up.

## Verification

- `bun run test` (turbo battery): **21/21 tasks green** — vault 403,
  gateway 195 (+1 skipped), app-engine 225, automation 217, blueprints 123,
  desktop 91, agent-runtime 68, tunnel 12, skills 6, openclaw-plugin 10.
- `bun run typecheck`: clean across all packages.
- `bun run lint`: 23 errors, byte-identical set to `origin/main` (verified
  by checkout comparison) — zero introduced.
- New tests: tally bridge (3), outbox graph joins + publish (4), locker
  anchor/tags/memo/FTS (3), groups-as-circles (2), tally memo+FTS (1),
  judgment loop (2), per-class enrichment consent (1), convergence sweep
  (1). Demo-seed purge regression caught by the existing gateway test and
  fixed by declaring membership writes (`ctx.wrote`) — provenance-honest
  and purge-clean.
- Blueprints manifest regenerated; locker/tally app queries and scopes
  updated in the same commits as their schema changes.
