# issue-260 — Blueprint UI/UX parity with consumer benchmarks

GitHub issue: [#260](https://github.com/srikanth235/centraid/issues/260)

A 14-app audit against the consumer products regular users know (full
report linked from the issue) found 84 P0 gaps, ~105 P1s, and 7
correctness bugs, with one repeated insight: the vault commands and app
manifests already support far more than the UIs surface. This receipt
tracks the wave-by-wave close-out. Per owner direction each app keeps
its own look and feel, modeled on its popular benchmark.

## Checklist

- [x] Commit 1 — Wave 0: correctness fixes (timezones, currency totals, video, silent no-ops)
- [x] Commit 2 — Wave 1: shared blueprint kit (toast/aria-live, skeletons, arm-confirm, parked rows, charts, avatars), linked by all 14 apps
- [x] Commit 3 — Wave 2: benchmark-parity UI wave across all 14 apps (one agent per app; per-app details in the commit message)
- [x] Commit 4 — Wave 3: bookings decline/cancel/reschedule scopes + leads contact info scope
- [x] Commit 5 — Wave 4a: vault command batch (new columns + 13 new/extended commands, 155 vault tests green)
- [x] Commit 6 — Wave 4b: the nine apps surface the new commands (renewal dates, delete reading, rooms/values, favorites/trash, notebook management, unread, task notes, availability/budget removal)

## Deferred to future issues

- `core.archive_party` / merge-duplicates (referential integrity across all domains — needs its own design)
- Circles CRUD (labels/groups for People), message reply-to, rrule-respawning tasks, all-day events, `core.purge_document` / `move_folder`, business timer + time-entry editing
- `home.update_item` cannot CLEAR a place_id once set (minLength 1, no null path) — flagged by the Wave 4b agent
- Platform seam: a "my parked invocations" read surface (all seven audit tracks asked for it; apps fake pending state session-locally today)

## Wave 0 — what changed

- **studio**: `log-time` was stamping the owner's wall clock with a `Z`
  suffix; now converts via `new Date(...).toISOString()`. Hours no
  longer shift by the UTC offset in day grouping and invoicing.
- **bookings**: same local-as-UTC bug on `request-booking` dtstart/dtend.
- **agenda**: day keys (list grouping, month cells, "Today") are now the
  viewer's local dates instead of UTC slices; the calendar select keeps
  a mid-form choice across focus refreshes (same fix bookings already
  had via `fillSelect`).
- **budgets**: month bucketing (ring spend math and `set-budget`
  `starts_on`) uses the local month, not the UTC month.
- **subscriptions**: the "Active, per month" total no longer sums minor
  units across currencies into one number — it totals per currency and
  renders e.g. `$42.99 + €9.99`.
- **photos**: uploads tag `kind` from the file's MIME type; video assets
  render as `<video>` (muted preview tile with a ▶ badge, controls in
  the lightbox) instead of unviewable placeholder tiles.
- **notes**: quick-add and edit no longer silently no-op on empty
  fields; a title-less quick note derives its title from the first line
  of the body, like every consumer notes app.

## Out of scope

- All parity gaps from the audit (Waves 1–4) — tracked in the checklist
  above and specified in the issue-linked report.
- Cross-midnight time entries (studio) and range validation (bookings)
  remain P1 UX items, not correctness fixes.

## Verification

- `bun run test` in packages/blueprints — 77/77 pass.
- `oxfmt --check` clean on the package; `node --check` clean on all
  seven edited `app.js` files.
- Manual reasoning on TZ math: `new Date('YYYY-MM-DDTHH:MM')` parses as
  local wall clock, `.toISOString()` converts to the true instant;
  local render keys derived from `getFullYear/Month/Date` components.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-44bf2527-5fe-1783086949-1 | claude-code | 44bf2527-5fe5-4d38-941c-e7d12c616689 | #260 | claude-fable-5 | 35688 | 1381814 | 24094260 | 293310 | 1710812 | 56.3893 | 35688 | 1381814 | 24094260 | 293310 | fix(blueprints): timezone, currency and media correctness across seven apps (#26 |
