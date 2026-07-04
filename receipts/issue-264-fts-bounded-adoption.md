# issue-264 — vault search/browse: adopt FTS5 + bounded windows in the remaining apps

GitHub issue: [#264](https://github.com/srikanth235/centraid/issues/264)

Adoption round for the primitives #261 (ctx.vault.search over the FTS5
plane) and #262 (ReadRequest.orderBy + limit windows) landed:
notes/docs/threads/leads/tasks were the converted exemplars; this issue
converts the rest — every remaining app that greps a whole projection in
memory, the two pickers that filter capped shortlists client-side, and the
small follow-ups.

## Checklist

- [x] Commit 1 — vault: home.asset_item joins the FTS index
- [x] Commit 2 — blueprints: remaining apps browse bounded windows and search through the vault FTS index
- [x] Commit 3 — blueprints: pickers reach the whole directory through as-you-type party search
- [x] Commit 4 — blueprints: threads inbox tops up quiet threads per-thread
- [x] Commit 5 — blueprints: automation handler stubs teach ctx.vault.search

## What changed

### Commit 1 — vault: home.asset_item joins the FTS index

- `packages/vault/src/schema/fts.ts` — `home.asset_item` joins `SPECS`
  (indexed columns `name` + `serial_no`, id `item_id`). No
  `deletedColumn`: disposal keeps the row as history, and "where did that
  old thing go" is exactly a search question, so disposed items stay
  searchable. `SEARCHABLE`/DDL derive from the spec — no gateway change.
- `packages/vault/src/gateway/search.test.ts` — new
  `home.asset_item surface` describe: name and serial match, disposal
  keeps the row searchable (3 seeded items, 2 queries).

### Commit 2 — blueprints: remaining apps browse bounded windows and search through the vault FTS index

Every converted browse query reads an ordered window (caller-sized
`limit` input, `truncated` + `window` outputs) and joins content items /
attachments / edges only for the fetched rows (`op: 'in'`, empty-list
guarded); every new `search` query asks the vault's FTS5 index and
returns only the ranked matches in the browse query's row shape plus a
⟦…⟧ `snippet`; each UI gets a debounced (250ms, staleness-guarded)
as-you-type search and a Show-more window footer.

- **agenda** — `packages/blueprints/apps/agenda/queries/search.js` (new:
  FTS over core.event, cancelled filtered post-match, event_ext/
  attachment/content joins `in`-bounded by matched ids),
  `packages/blueprints/apps/agenda/queries/upcoming.js` (event_ext,
  attachments and content items now `in`-bounded by the date-windowed
  events — content_item was a whole-table read),
  `packages/blueprints/apps/agenda/app.json`,
  `packages/blueprints/apps/agenda/app.js` (client substring filter →
  vault search with snippet highlighting; search stays list-view, chips
  still filter matches).
- **budgets** — `packages/blueprints/apps/budgets/queries/search.js`
  (new: FTS over core.transaction, all history),
  `packages/blueprints/apps/budgets/queries/overview.js` (attachments
  bounded by windowed txn ids; content_item was a whole-table read, now
  scoped to attachment content ids),
  `packages/blueprints/apps/budgets/app.json`,
  `packages/blueprints/apps/budgets/app.js` (payee search now reaches all
  history; month math/budget rings stay on the selected month; matches
  re-sorted by posted_at for day grouping),
  `packages/blueprints/apps/budgets/app.css` (`mark` rule).
- **people** — `packages/blueprints/apps/people/queries/directory.js`
  (window: newest 500 by core.party.updated_at, clamp 20..2000;
  identifiers/cards/attachments `in`-bounded by windowed party ids),
  `packages/blueprints/apps/people/queries/search.js` (new: core.party +
  social.contact_card hits union in rank order, joined to the directory
  row shape), `packages/blueprints/apps/people/app.json`,
  `packages/blueprints/apps/people/app.js` (search list is rank-ordered —
  no A–Z regrouping; letter rail hides mid-search; Show-more footer),
  `packages/blueprints/apps/people/app.css` (`mark` + `.window-footer`).
- **photos** — `packages/blueprints/apps/photos/queries/library.js`
  (live window: deleted_at is-null, captured_at desc, default 500; trash:
  deleted_at desc, fixed 200; content_item — previously every photo's
  data:-URI bytes on every refresh — and album_entry now `in`-bounded by
  the windowed assets; no text index, so window-only per the issue),
  `packages/blueprints/apps/photos/app.json`,
  `packages/blueprints/apps/photos/app.js` (Show-more footer; honest
  per-view labels since album/favorite/search views filter the loaded
  slice), `packages/blueprints/apps/photos/app.css` (`.window-footer`).
- **home-inventory** —
  `packages/blueprints/apps/home-inventory/queries/inventory.js` (owned
  window: disposed_on is-null, item_id desc — UUIDv7 = newest-first,
  default 500; disposed shelf: disposed_on desc, fixed 200; warranty/
  maintenance/attachment joins `in`-bounded by windowed item ids),
  `packages/blueprints/apps/home-inventory/queries/search.js` (new: FTS
  over home.asset_item; owned matches in the inventory row shape, matched
  disposed items in their own list),
  `packages/blueprints/apps/home-inventory/app.json`,
  `packages/blueprints/apps/home-inventory/app.js` (client filter → vault
  search; disposed shelf follows the active source; room headers show
  match counts mid-search instead of window-derived totals; Show-more
  footer), `packages/blueprints/apps/home-inventory/app.css` (`mark` +
  `.window-footer`).
- **subscriptions** — audited per the issue:
  `packages/blueprints/apps/subscriptions/queries/list.js` (series
  window: series_id desc — UUIDv7, default 500; counterparty names from
  the picker shortlist plus one targeted `in` read for those beyond it;
  the add-form payee picker becomes the newest-300 shortlist; attachments
  bounded by windowed series ids; content_item was a whole-table read,
  now scoped; docblock states the monthly total and 30-day runway cover
  the window), `packages/blueprints/apps/subscriptions/app.json`,
  `packages/blueprints/apps/subscriptions/app.js` (Show-more footer whose
  label says totals count the loaded slice),
  `packages/blueprints/apps/subscriptions/app.css` (`.window-footer`).
- `packages/blueprints/manifest.json` regenerated — the template file
  lists carry the new query handlers (this issue's four `search.js`
  files plus commit 3's two picker queries; regenerated once from the
  finished tree).

### Commit 3 — blueprints: pickers reach the whole directory through as-you-type party search

- **threads** — `packages/blueprints/apps/threads/queries/find-people.js`
  (new: FTS over core.party, owner excluded via core.vault, rank order,
  limit 50), `packages/blueprints/apps/threads/app.json`,
  `packages/blueprints/apps/threads/app.js` (New-message picker: zero
  term = the shipped 500-newest shortlist; a typed term asks the vault —
  in-flight or failed lookups fall back to the client-filtered shortlist
  so keystrokes never blank the list).
- **leads** — `packages/blueprints/apps/leads/queries/find-candidates.js`
  (new: FTS over core.party with enrolled parties dropped via one
  `in`-bounded business.client read — same exactness rationale as the
  pipeline shortlist), `packages/blueprints/apps/leads/app.json`,
  `packages/blueprints/apps/leads/index.html` (the add-lead picker gains
  a search input — it was a bare select),
  `packages/blueprints/apps/leads/app.js` (zero term = 300-newest
  shortlist; typed term = ranked vault matches; selection preserved
  across re-renders; filter cleared after a successful add).

### Commit 4 — blueprints: threads inbox tops up quiet threads per-thread

- `packages/blueprints/apps/threads/queries/inbox.js` — the documented
  degradation (a quiet thread whose whole history fell outside the
  newest-1000-messages bulk read rendered with an empty snippet and
  unread=false) is gone: windowed threads with a last_message_at but no
  bulk-read message get a parallel per-thread top-up read (sent_at desc,
  limit 30) folded through the same snippet/draft/unread derivation,
  before the one bounded content fetch. The top-up set is provably empty
  unless the bulk read hit its cap, so the common case costs nothing.

### Commit 5 — blueprints: automation handler stubs teach ctx.vault.search

- All 15 bundled automation handler docblocks' "Available on `ctx`"
  sections now read `ctx.vault.read/search/invoke` with full-text search
  mentioned (the builder prompt already taught it; the stubs now agree):
  `packages/blueprints/automations/booking-prep/automations/booking-prep/handler.js`,
  `packages/blueprints/automations/briefing/automations/briefing/handler.js`,
  `packages/blueprints/automations/dependency-update-check/automations/dependency-update-check/handler.js`,
  `packages/blueprints/automations/email-triage/automations/email-triage/handler.js`,
  `packages/blueprints/automations/evening-wrap-up/automations/evening-wrap-up/handler.js`,
  `packages/blueprints/automations/flaky-test-tracker/automations/flaky-test-tracker/handler.js`,
  `packages/blueprints/automations/invoice-chaser/automations/invoice-chaser/handler.js`,
  `packages/blueprints/automations/issue-triage/automations/issue-triage/handler.js`,
  `packages/blueprints/automations/lead-follow-up/automations/lead-follow-up/handler.js`,
  `packages/blueprints/automations/meeting-prep/automations/meeting-prep/handler.js`,
  `packages/blueprints/automations/pr-review-digest/automations/pr-review-digest/handler.js`,
  `packages/blueprints/automations/release-notes-drafter/automations/release-notes-drafter/handler.js`,
  `packages/blueprints/automations/renewals-digest/automations/renewals-digest/handler.js`,
  `packages/blueprints/automations/system-health-check/automations/system-health-check/handler.js`,
  `packages/blueprints/automations/vitals-nudge/automations/vitals-nudge/handler.js`.
  The scaffold templates in `packages/blueprints/src` carry no such
  docblock, so nothing to update there.

## Decisions

- No cursor/keyset pagination (issue item 3): the issue itself gates it
  on "real vaults showing cost here", which none do yet — Show-more stays
  a grown re-read, O(window) but simple and dedup-free. Revisit when a
  real vault demonstrates the cost.
- `home.asset_item` indexes `name` + `serial_no` and keeps disposed items
  in the index — disposal keeps the row as history.
- The FTS DDL rung (v2) is edited in place rather than adding a v3
  migration: Centraid is pre-release with an explicit no-migrations
  stance, so dev vaults created before this branch need recreation to get
  the `fts_home_asset_item` shadow table.
- photos stays window-only (no FTS entity for media assets yet); its
  Show-more labels never promise search.
- subscriptions keeps its counterparty picker as a capped shortlist — the
  issue scopes as-you-type pickers to threads and leads.

## Out of scope

- Cursor/keyset pagination (deliberately conditional in the issue; see
  Decisions).
- The pre-existing governance-gate violations on main (issue-256/260
  receipt format, >500-line file caps, format drift in
  packages/vault/src/gateway/search.ts) — repo hygiene, tracked
  separately per the issue.
- bookings/studio/vitals/docs/notes/tasks apps: already converted in
  #261/#262 or not listed in #264.
- A media/photos text index and a vault-side group-wise "latest message
  per thread" view — the per-thread top-up removes the need for now.

## Verification

```bash
cd packages/vault && bun run vitest run        # 179 tests (incl. the new home.asset_item search coverage)
cd packages/blueprints && bun run build:manifest && bun run vitest run   # 82 tests; manifest gate validates every new query + handler file
bun run test                                   # all 19 workspace test tasks green
bun run typecheck && bun run lint && bun run lint:types   # clean
node --check <every touched .js>               # clean (all app + query + automation handlers)
bun run format:check                           # clean except packages/vault/src/gateway/search.ts, format drift inherited from main (file untouched by this branch)
```

## Steering

- Verdict: PASS
- Evidence: Session transcript contains exactly one human input prior to task completion: the /goal invocation at 2026-07-03T19:47:45 ("work on the entire issue and create PR"). All subsequent user messages are task-notifications (background agents completing work) and a single "continue" message on 2026-07-04T01:33:53 after a token-limit reset — a session continuation, not a mid-task correction or interrupt. Zero steering events detected.

## Audit

- What-changed fidelity: PASS — All 47 files in git status match receipt's file list. Commit 1: fts.ts adds home.asset_item to SPECS with name+serial_no indexing and disposed-items comment; search.test.ts adds home.asset_item surface describe (3 seeded items, 2 queries testing name/serial match and disposal searchability). Commit 2: 5 apps (agenda, budgets, people, photos, home-inventory) + subscriptions each have bounded window in their browse queries (`windowed` variable holding the limited read, empty-list guarded joins with `op: 'in'`), search queries in new files ask `ctx.vault.search`, and app.json manifests declare limit input + truncated/window outputs; manifest.json regenerated with new search handlers. Commit 3: threads' find-people.js and leads' find-candidates.js search core.party via ctx.vault.search (50 limit each), with owner excluded in threads; app.json manifests declare the queries; index.html gains search input for leads; app.js files show rank-ordered results with fallback to shortlist on error. Commit 4: threads/inbox.js extracts fold() closure, adds per-thread top-up for missed threads (Promise.all over 30-message per-thread reads), folds through same derivation before content fetch. Commit 5: all 15 automation handler.js files updated to document ctx.vault.read/search/invoke in docblock "Available on ctx" section.
- Checklist realized in diff: PASS — Commit 1 (fts.ts + search.test.ts) adds home.asset_item to FTS index with 3 test cases. Commit 2 (7 apps) each have bounded window reads + in-guarded joins + search queries + manifest updates. Commit 3 (threads + leads) have picker searches reaching full core.party via FTS. Commit 4 (threads inbox) has per-thread top-up logic for quiet threads. Commit 5 (15 automations) all have updated docblocks teaching ctx.vault.search.
- Verification commands all pass: PASS — `cd packages/vault && bun run vitest run` = 179 tests (includes 3-test home.asset_item surface). `cd packages/blueprints && bun run build:manifest && bun run vitest run` = 82 tests, manifest regenerated with 6 new query handlers (4 search.js + 2 find-*.js). `bun run test` = 19 workspace test tasks, all green. `bun run typecheck && bun run lint && bun run lint:types` = clean. `node --check` on sampled .js files (agenda/search, home-inventory/search, threads/find-people) = clean. `bun run format:check` = clean except packages/vault/src/gateway/search.ts, untouched file with pre-existing drift from main.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-776ec24c-89b-1783129771-1 | claude-code | 776ec24c-89ba-48e7-ba5f-d29a23dee5de | #264 | claude-fable-5 | 90574 | 2382715 | 32308974 | 273109 | 2746398 | 76.6541 | 90574 | 2382715 | 32308974 | 273109 | feat(vault): home.asset_item joins the FTS index (#264)Inventory items become te |
| claude-code-776ec24c-89b-1783129798-1 | claude-code | 776ec24c-89ba-48e7-ba5f-d29a23dee5de | #264 | claude-fable-5 | 2 | 4778 | 247557 | 370 | 5150 | 0.3258 | 90576 | 2387493 | 32556531 | 273479 | feat(vault): home.asset_item joins the FTS index (#264)Issue: #264Co-Authored-By |
| claude-code-776ec24c-89b-1783129830-1 | claude-code | 776ec24c-89ba-48e7-ba5f-d29a23dee5de | #264 | claude-fable-5 | 6 | 3495 | 757005 | 1791 | 5292 | 0.8903 | 90582 | 2390988 | 33313536 | 275270 | x (#264) |
