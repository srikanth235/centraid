# issue-261 — Apps search via SQLite FTS5, not whole-vault pulls

GitHub issue: [#261](https://github.com/srikanth235/centraid/issues/261)

Owner directive: apps search must use SQLite FTS5 — matching happens inside
the vault, because vault data has no upper bound and "read everything, grep
in JS" does not scale and over-ships the owner's data.

## Checklist

- [x] Commit 1 — vault: FTS5 search plane (shadow tables, sync triggers, gateway.search())
- [x] Commit 2 — ctx.vault.search through both bridge planes
- [x] Commit 3 — blueprints: five apps search through the vault index

## What changed

### Commit 1 — vault: FTS5 search plane (shadow tables, sync triggers, gateway.search())

- `packages/vault/src/schema/fts.ts` (new) — one FTS5 shadow table per
  text-bearing entity (knowledge.note, core.content_item, social.thread,
  social.message, core.party, social.contact_card, schedule.task,
  core.event, core.transaction), synced by AFTER INSERT/UPDATE/DELETE
  triggers on the base tables; the `SEARCHABLE` registry names each
  entity's fts table, join column, mask columns and folded-in consent
  entities. Canonical `data:`-URI bodies decode through the
  `vault_content_text` app-defined function; `packages/vault/src/db.ts`
  registers it before migrations run. Soft-deleted content items fall out
  of the index.
- `packages/vault/src/schema/migrate.ts` — migration rung 2 creates the
  index and backfills pre-index vaults (a no-op on fresh files);
  `packages/vault/src/schema/migrate.test.ts` now asserts `user_version`
  equals the ladder length instead of a literal.
- `packages/vault/src/gateway/search.ts` (new) + `search()` on
  `packages/vault/src/gateway/gateway.ts` — read's consent pipeline over
  the index: identity → consent → clamps → receipted execution. Two clamps
  beyond read: folded-in canonical text needs its own read consent (a
  note-body match IS reading core.content_item), and a grant field mask
  hiding any indexed column fails the search closed. Owner-typed words
  compile to quoted prefix phrases so FTS operators stay literals. Results
  are bm25-ranked with `_rank` and a `⟦…⟧`-marked `_snippet`, receipted as
  action `search`.
- `packages/vault/src/gateway/types.ts` — `SearchRequest` / `SearchResult`;
  `packages/vault/src/gateway/filters.ts` — `applyFieldMask` gained an
  alias parameter for the joined SELECT; `packages/vault/src/index.ts`
  exports the new types and the `SEARCHABLE` registry.
- `packages/vault/src/gateway/search.test.ts` (new) — 14 tests: match
  compilation, index-backed matching/snippets/prefixes, trigger-driven
  re-index on edit/delete, caller where-clauses, operator-injection
  safety, contract clamps, consent denials with receipts, folded-in
  content consent, row filters, field-mask fail-closed, and the v1→v2
  backfill path.

### Commit 2 — ctx.vault.search through both bridge planes

- `packages/app-engine/src/handlers/vault-bridge.ts` — `search` joined the
  `VaultOp` contract; `packages/app-engine/src/worker/runner.ts` and
  `packages/automation/src/worker/runner.ts` grew the worker-side
  `ctx.vault.search` method (same wire mechanism as read).
- `packages/app-engine/src/handlers/build-extra-prompt.ts` — the builder
  prompt's vault block documents search (searchable entities, snippet
  markers, escape-first rendering) and instructs generated handlers to
  never read a whole entity to grep it.
- `packages/gateway/src/serve/vault-plane.ts` — `bridgeFor` and
  `agentBridgeFor` dispatch `op: 'search'` to `gateway.search()`;
  `packages/gateway/src/serve/vault-plane.test.ts` drives the op through
  both planes (deny-before-grant, hit-with-markers after).

### Commit 3 — blueprints: five apps search through the vault index

- Each of notes, docs, threads, leads, tasks gained a `search` query
  handler that asks `ctx.vault.search` and joins only the matched ids
  (`op: 'in'` reads) back into the app's existing row shape plus the hit
  snippet: `packages/blueprints/apps/notes/queries/search.js`,
  `packages/blueprints/apps/docs/queries/search.js`,
  `packages/blueprints/apps/threads/queries/search.js`,
  `packages/blueprints/apps/leads/queries/search.js`,
  `packages/blueprints/apps/tasks/queries/search.js` (all new). Each
  manifest declares the query: `packages/blueprints/apps/notes/app.json`,
  `packages/blueprints/apps/docs/app.json`,
  `packages/blueprints/apps/threads/app.json`,
  `packages/blueprints/apps/leads/app.json`,
  `packages/blueprints/apps/tasks/app.json`.
- Each UI's search box now debounces into the vault query with a
  stale-reply sequence guard, renders the vault match set while a term is
  active (notebook chips, kanban stages, channel chips, status buckets
  still compose client-side), and renders snippets from text nodes only
  (⟦…⟧ pairs become `<mark>`; vault text never parses as HTML):
  `packages/blueprints/apps/notes/app.js`,
  `packages/blueprints/apps/docs/app.js` (+ a `.doc-snippet` rule in
  `packages/blueprints/apps/docs/app.css`),
  `packages/blueprints/apps/threads/app.js`,
  `packages/blueprints/apps/leads/app.js`,
  `packages/blueprints/apps/tasks/app.js`. The in-memory
  `.toLowerCase().includes()` filters are gone.
- Entity mapping: notes → knowledge.note; docs → core.content_item clamped
  to folders-scheme tags; threads → social.message ∪ social.thread by
  thread; leads → core.party ∪ social.contact_card clamped to
  business.client parties; tasks → schedule.task.

## Decisions

- Indexing rides base-table triggers plus a connection-registered decode
  UDF rather than gateway-side upserts: every write path (commands, ingest,
  import, sweeps) keeps the index true, and the gateway is the sole holder
  of connections so the UDF is always present.
- Field masks fail search closed instead of column-filtering the MATCH:
  provably no leak through match-existence or snippets, at the cost of
  masked grants losing search — acceptable for v0 where manifest scopes
  carry no field masks.
- The five apps' initial library/board reads are unchanged (still bounded
  only by read's 10k LIMIT); bounding browse needs read orderBy +
  pagination UX and is deferred (see Out of scope) so search landed whole.

## Out of scope

- Bounding the apps' initial browse reads (read `orderBy` + pagination UX).
- Search adoption in the remaining apps that filter loaded projections
  (people, agenda, budgets, photos, home-inventory, subscriptions).
- The automation handler stubs' ctx docblocks (no bundled automation
  searches today; the builder prompt documents search for generated ones).
- Pre-existing governance violations (file-size caps, older receipts).

## Verification

```bash
cd packages/vault && npx vitest run && npm run typecheck        # 173 tests, incl. 14 in gateway/search.test.ts
cd packages/app-engine && npx vitest run && npm run typecheck   # 318 tests
cd packages/automation && npx vitest run && npm run typecheck   # 142 tests
cd packages/gateway && npx vitest run && npm run typecheck      # 131 tests, incl. the search-op vault-plane test
cd packages/blueprints && npx vitest run                        # 82 tests (manifest gate covers the new queries)
```

End-to-end smoke (real VaultPlane → app bridge → the notes app's
`queries/search.js`): prefix match over title+body, decoded bodies,
⟦…⟧ snippet, notebook join, no false matches, empty-term short-circuit,
FTS-operator injection stays literal, revocation surfaces as `vaultDenied`
— all pass (scratch script, session-local).

## Steering

- Verdict: PASS
- Evidence: Single human directive at session start ("for apps search, please use FTSS of sqlite..."); no mid-task interrupts or corrections found in transcript. Zero steering events is correct; the session executed the single initial directive as planned.

## Audit

- What-changed fidelity: PASS — Receipt lists all 11 files in commit 1 (vault FTS schema, gateway search, tests, types, filters, migration); all 6 files in commit 2 (app-engine/automation/gateway bridge planes); all 18 files in commit 3 staged (5 search.js, 5 app.json manifests, 5 app.js/app.css UI updates, receipt). Spot-checked 3 files (notes search.js, notes app.js, notes app.json): contents match descriptions (FTS-backed search, snippet rendering, no in-memory grep).
- Checklist realized in diff: PASS — Commit 1 creates `packages/vault/src/gateway/search.ts` + triggers in fts.ts + migration rung 2. Commit 2 adds VaultOp 'search' contract to bridge planes + ctx.vault.search in worker runtimes. Commit 3 (staged) adds search.js queries and search entries in app.json manifests for notes/docs/threads/leads/tasks, UI integration in app.js files.
- Checklist mirrors issue: PASS — Issue's 3-item Plan (vault FTS, bridge ctx.vault.search, blueprints apps) maps exactly to 3 receipt checklist items; all three realized in commits (two merged, one staged).

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-ebbf4c46-af9-1783104072-1 | claude-code | ebbf4c46-af9f-44e5-b10a-49ab9071508f | #261 | claude-fable-5 | 62677 | 576695 | 16571201 | 195108 | 834480 | 34.1621 | 62677 | 576695 | 16571201 | 195108 | feat(vault): FTS5 search plane — shadow tables, sync triggers, gateway.search()  |
| claude-code-ebbf4c46-af9-1783105398-1 | claude-code | ebbf4c46-af9f-44e5-b10a-49ab9071508f | #261 | claude-fable-5 | 23940 | 266893 | 41966158 | 143730 | 434563 | 52.7282 | 86617 | 843588 | 58537359 | 338838 | feat(blueprints): notes/docs/threads/leads/tasks search through the vault's FTS5 |
| claude-code-ebbf4c46-af9-1783105912-1 | claude-code | ebbf4c46-af9f-44e5-b10a-49ab9071508f | #261 | claude-fable-5 | 13690 | 26670 | 4681848 | 19607 | 59967 | 6.1325 | 110232 | 903436 | 66698553 | 363788 | feat(blueprints): notes/docs/threads/leads/tasks search through the vault's FTS5 |
| claude-code-ebbf4c46-af9-1783105959-1 | claude-code | ebbf4c46-af9f-44e5-b10a-49ab9071508f | #261 | claude-fable-5 | 2 | 5536 | 342258 | 124 | 5662 | 0.4177 | 110234 | 908972 | 67040811 | 363912 | x (#261) |
