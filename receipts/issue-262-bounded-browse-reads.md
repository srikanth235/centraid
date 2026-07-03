# issue-262 — Apps browse: bounded, ordered reads instead of whole-entity pulls

GitHub issue: [#262](https://github.com/srikanth235/centraid/issues/262)

Follow-up to #261: search moved into the vault's FTS5 index; browsing was
the remaining unbounded pull — every app's initial query read whole
entities, capped only by the gateway's 10k LIMIT.

## Checklist

- [x] Commit 1 — vault: ReadRequest.orderBy — validated ordering for bounded windows
- [x] Commit 2 — blueprints: browse queries read bounded recent windows + Show more

## What changed

### Commit 1 — vault: ReadRequest.orderBy — validated ordering for bounded windows

- `packages/vault/src/gateway/types.ts` — `OrderBy { column, dir? }` on
  `ReadRequest`; without ordering, a bounded read picks arbitrary rows, so
  ordering is what makes a window a RECENT window. UUIDv7 PKs sort by time,
  so tables with no timestamp column order by their id.
- `packages/vault/src/gateway/filters.ts` — `compileOrderBy`: the column
  must be a real column of the table (same allow-list discipline as
  FilterClause), the direction one of two literals — no caller string
  reaches SQL. `packages/vault/src/gateway/gateway.ts` appends the ORDER BY
  fragment before LIMIT in `read()`. `packages/vault/src/index.ts` exports
  the `OrderBy` type.
- `packages/vault/src/gateway/read-order.test.ts` (new) — 5 tests: recent
  window vs arbitrary rows, default ascending, UUIDv7-id time order,
  injection/direction validation, composition with caller filters.

### Commit 2 — blueprints: browse queries read bounded recent windows + Show more

- Every browse query now reads an ordered window (caller-sized via a
  schema-declared `limit` input, since query inputs are validated) and
  joins content items / attachments / placements only for the fetched rows
  (`op: 'in'`, guarded against empty id lists); each returns `truncated` +
  `window` so the UI can offer growth. Handlers:
  `packages/blueprints/apps/notes/queries/library.js` (newest 200 by
  updated_at; pinned notes ride beside the window so a pin survives aging
  out), `packages/blueprints/apps/docs/queries/drive.js` (tags-first:
  folders-scheme tags newest-filed-first bound the content join — every
  blob in the vault used to ride the RPC),
  `packages/blueprints/apps/threads/queries/inbox.js` (newest 100 threads
  by last_message_at; snippet/draft/unread derive from the newest 1000
  messages across them, quiet threads degrade gracefully; the New-message
  recipients directory caps at the 500 newest parties),
  `packages/blueprints/apps/leads/queries/pipeline.js` (newest 500 clients
  by UUIDv7 client_id; the add-lead shortlist is the 300 newest parties
  with enrolment checked exactly via an `in`-bounded client lookup),
  `packages/blueprints/apps/tasks/queries/board.js` (newest 500 open tasks;
  the logbook read is capped at the 50 rows the UI shows; families stay
  whole across the window edge — missing parents fetched by id, all
  children of windowed top-level tasks fetched so `done_children` counts
  the truth).
- Each UI grows its window with a Show more footer, shown only when
  truncated and no search term is active — notebook/folder/kanban counts
  describe the loaded window, honest next to the footer:
  `packages/blueprints/apps/notes/app.js`,
  `packages/blueprints/apps/docs/app.js`,
  `packages/blueprints/apps/threads/app.js`,
  `packages/blueprints/apps/leads/app.js`,
  `packages/blueprints/apps/tasks/app.js`, with a shared `.window-footer`
  rule in each app's stylesheet (`packages/blueprints/apps/notes/app.css`,
  `packages/blueprints/apps/docs/app.css`,
  `packages/blueprints/apps/threads/app.css`,
  `packages/blueprints/apps/leads/app.css`,
  `packages/blueprints/apps/tasks/app.css`) and the query's `limit` input +
  `truncated`/`window` output declared in each manifest
  (`packages/blueprints/apps/notes/app.json`,
  `packages/blueprints/apps/docs/app.json`,
  `packages/blueprints/apps/threads/app.json`,
  `packages/blueprints/apps/leads/app.json`,
  `packages/blueprints/apps/tasks/app.json`).
- `packages/blueprints/manifest.json` regenerated — #261's new
  `queries/search.js` files were missing from the template file lists, so
  fresh installs would not have copied them.

## Decisions

- No cursor/offset pagination: apps grow the window (re-read with a larger
  limit) — simpler, dedup-free, and cheap at these scales; a cursor can
  land later without changing the surface.
- Windows are per-app product choices, not one constant: notes/docs 200,
  threads 100, leads/tasks 500 — sized to what each surface actually
  renders, all caller-growable to 2000.
- Threads accepts a documented degradation: a thread whose entire history
  fell outside the newest-1000-messages read renders with an empty snippet
  and unread=false; its inbox position and timestamp come from the thread
  row itself, so nothing is misordered.

## Out of scope

- Cursor/offset pagination (limit-growth is enough at these scales).
- The recipient/candidate pickers' in-memory filtering.
- Remaining projection-filtering apps (people, agenda, budgets, photos,
  home-inventory, subscriptions).

## Verification

```bash
cd packages/vault && npx vitest run && npm run typecheck   # 178 tests, incl. 5 in gateway/read-order.test.ts
cd packages/blueprints && npx vitest run                   # 82 tests (manifest gate validates the new limit inputs)
npx oxfmt --check $(git diff --name-only) && npx oxlint $(git diff --name-only)
```

End-to-end smokes (real VaultPlane → app bridge → the real query handlers;
scratch scripts, session-local): notes library — a window of 20 over 60
notes returns the newest 20 plus an old pinned note, truncated flags the
edge, bodies decode for exactly the windowed rows, a covering window is not
truncated; tasks board — a parent outside the window is pulled in for its
windowed child, open siblings ride along, `done_children` is exact, the
logbook caps at 50, growing the window reaches older open tasks.

## Steering

- Verdict: PASS
- Evidence: Two human messages in session ebbf4c46-af9f-44e5-b10a-49ab9071508f. First is guidance on issue #261 (FTS search). Second is task assignment for #262 ("In /Users/srikanth/gitspace/centraid (work on main directly): the blueprint apps' initial browse queries…") — a new task, not a mid-task correction or interrupt. No steering events.

## Audit

- What-changed fidelity: PASS — All 27 files in git diff match receipt's file list. Spot-checked: OrderBy type definition + compileOrderBy validation in vault; bounded reads with orderBy + content joins only for windowed rows in all 5 apps; manifest includes new search.js entries; all app manifests declare limit input + truncated/window outputs; all app.js include Show more footer.
- Checklist realized in diff: PASS — Vault commit 1299066 on main includes OrderBy type, compileOrderBy, ORDER BY injection, read-order.test.ts with 5 tests. All 5 blueprint apps refactored to bounded windows with Show more UI, manifest regenerated.
- Checklist mirrors issue: PASS — Issue Plan (1) vault OrderRequest.orderBy with validated columns/dir, (2) blueprints bounded windows + in-filtered content joins, (3) UX Show more + window-counted lists. All realized.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-ebbf4c46-af9-1783106558-1 | claude-code | ebbf4c46-af9f-44e5-b10a-49ab9071508f | #262 | claude-fable-5 | 137097 | 2029424 | 91571698 | 423792 | 2590313 | 139.5001 | 137097 | 2029424 | 91571698 | 423792 | feat(vault): ReadRequest.orderBy — validated ordering for bounded windows (#262) |
| claude-code-ebbf4c46-af9-1783107731-1 | claude-code | ebbf4c46-af9f-44e5-b10a-49ab9071508f | #262 | claude-fable-5 | 57851 | 146457 | 43675467 | 104604 | 308912 | 51.3149 | 194948 | 2175881 | 135247165 | 528396 | feat(blueprints): browse queries read bounded recent windows + Show more (#262)E |
| claude-code-ebbf4c46-af9-1783107757-1 | claude-code | ebbf4c46-af9f-44e5-b10a-49ab9071508f | #262 | claude-fable-5 | 2 | 8004 | 461276 | 143 | 8149 | 0.5685 | 194950 | 2183885 | 135708441 | 528539 | x (#262) |
