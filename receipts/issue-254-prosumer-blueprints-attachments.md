# Issue #254 — writable projections, file attachments, and prosumer apps

Expand the §01 projection band from read-only shells into a working prosumer
app gallery, add file-attachment support across every app, and retire the three
legacy sample blueprints. Follows up the vault + gateway integration in #252.

## Checklist
- [x] Vault command packs for the projection band: schedule tasks, knowledge (notes), business (studio + leads)
- [x] Core attachments command pack (core.attach / core.detach) with inline data-URI content items
- [x] Writable Tasks, Notes, and Studio blueprints (the roadmap's first three phases)
- [x] UI richness pass: Agenda month grid, Vitals sparkline, Budgets progress rings, Threads bubbles
- [x] People blueprint wiring: resolve-identity, draft-message, send-message
- [x] File attachments (any media) on all thirteen apps
- [x] Three new prosumer apps: Bookings, Subscriptions, Leads
- [x] Retire the legacy hydrate, journal, and todos sample blueprints (todos superseded by the writable Tasks blueprint)

## What changed

**Vault command packs for the projection band: schedule tasks, knowledge
(notes), business (studio + leads).** New typed command packs under
`packages/vault/src/commands/`: `tasks.ts` (schedule add/set-status/edit),
`knowledge.ts` (notes: create/edit/move + create_notebook), and `business.ts`
(studio + leads: add_client, update_client, add_project, log_time,
create_draft_invoice, send_invoice, mark_invoice_paid). Each is
consent-checked, contract-checked, receipted, and registered in `index.ts` +
the gateway's `vault-plane.ts`. Conventions fixed in-file: qty_scaled = hours×100,
issued_on stamped at draft, mark_invoice_paid links an existing posted credit.

**Core attachments command pack (core.attach / core.detach) with inline
data-URI content items.** `attachments.ts` stores file bytes inline as
sha256-deduped base64 `data:` URIs in `core_content_item`, linked to any
canonical row through a polymorphic `core_attachment` edge, size-capped with a
receipted deny above the cap. This is what makes File attachments (any media)
on all thirteen apps possible.

**Writable Tasks, Notes, and Studio blueprints (the roadmap's first three
phases).** Tasks got a bucketed board, Notes a full create/edit/file/pin
surface, Studio the whole client → project → time → invoice → payment loop,
each writing through the packs above with per-command act scopes.

**UI richness pass: Agenda month grid, Vitals sparkline, Budgets progress
rings, Threads bubbles.** Pure app.js/app.css rendering work — a CSS-grid month
calendar with a list toggle, an inline-SVG trend line, SVG donut budget rings
with threshold colours, and owner-aligned chat bubbles (thread.js reads
core.vault for an honest `mine` flag).

**People blueprint wiring: resolve-identity, draft-message, send-message.**
Three previously-unwired social commands got action handlers and a compose UI;
draft and send both park under the app's low risk ceiling and narrate it.

**File attachments (any media) on all thirteen apps.** Every app gained the
shared attachment pattern — a query that projects an `attachments` array, an
attach/detach action pair, the manifest read+act scopes, and an image-thumbnail
/ download-tile UI strip with an "Attach file" control.

**Three new prosumer apps: Bookings, Subscriptions, Leads.** Bookings
(schedule.availability_rule + request_booking, which parks for owner
confirmation), Subscriptions (finance.recurring_series, monthly-normalized
totals), and Leads (a lead → active → past pipeline over business_client with
notes on the contact card and no new schema). Their packs `bookings.ts` and
`subscriptions.ts` plus `business.update_client` back them.

**Retire the legacy hydrate, journal, and todos sample blueprints (todos
superseded by the writable Tasks blueprint).** Three old
sample apps were deleted from `packages/blueprints/apps/`: hydrate and journal
outright, and todos — which the writable Tasks blueprint supersedes, so its
directory (app.json, app.js, index.html, migrations, actions, queries,
automations) is removed in favour of `apps/tasks`.

## Out of scope
- Photos was deliberately left out of the attachment roll-out — it is the
  byte-custody special case and wants its own reimagining now that inline bytes
  exist.
- Drag-to-reorder in Tasks (needs a schedule_task ordering column) and PDF
  invoice generation in Studio remain deferred seams.
- knowledge_annotation has no command yet (no consuming UI surface).

## Verification
Full vault test suite (all command packs, including the new attachments,
bookings, and subscriptions packs):

```bash
cd packages/vault && npx vitest run
# Test Files  15 passed (15)   Tests  107 passed (107)
```

End-to-end proofs over a live gateway (clone → grant → drive the write surface
→ read the projection back), including the parked-confirmation path and the
attachment round-trip:

```bash
node scratchpad/new-apps-e2e.mjs      # Bookings/Subscriptions/Leads + budgets receipt roll-out
node scratchpad/notes-attach-e2e.mjs  # attach → project → detach through Notes
```

Typecheck of the two touched packages:

```bash
cd packages/vault && npx tsc -p tsconfig.json
cd packages/gateway && npx tsc -p tsconfig.json
```

## Decisions
- **Attachment bytes live inline as base64 data: URIs, size-capped**, rather
  than behind a blob store. It is the only viable path without new
  infrastructure and it genuinely supports every media format; large-file
  custody stays a deferred seam.
- **Leads invents no schema** — business_client's lead/active/past status *is*
  the pipeline, with one new `business.update_client` command and notes on the
  existing contact card.
- **studio/app.js carries a repo-hygiene file-size waiver** (562 > 500 lines):
  blueprints are single-file by design so an agent can read one wholesale, and
  Studio is the fullest app; splitting it would break that contract.
- Each app's attach/detach action purpose must equal its manifest purpose
  (budgets/studio/subscriptions/leads = Billing, vitals = HealthMonitoring,
  rest = ServiceProvision); one rollout mismatch was found and fixed.

## File coverage
Every path in this change set, for the coverage crosswalk:

```
apps/desktop/src/main/gateway-paths.ts
apps/desktop/src/main/local-gateway.ts
apps/desktop/src/renderer/app-appview.ts
apps/desktop/src/renderer/app-vault.ts
apps/desktop/src/renderer/gateway-client-vault.ts
apps/desktop/src/renderer/gateway-client.ts
apps/desktop/src/renderer/styles.css
packages/blueprints/apps/agenda/actions/attach.js
packages/blueprints/apps/agenda/actions/detach.js
packages/blueprints/apps/agenda/app.css
packages/blueprints/apps/agenda/app.js
packages/blueprints/apps/agenda/app.json
packages/blueprints/apps/agenda/index.html
packages/blueprints/apps/agenda/queries/upcoming.js
packages/blueprints/apps/bookings/actions/attach.js
packages/blueprints/apps/bookings/actions/confirm-booking.js
packages/blueprints/apps/bookings/actions/detach.js
packages/blueprints/apps/bookings/actions/request-booking.js
packages/blueprints/apps/bookings/actions/set-availability.js
packages/blueprints/apps/bookings/app.css
packages/blueprints/apps/bookings/app.js
packages/blueprints/apps/bookings/app.json
packages/blueprints/apps/bookings/index.html
packages/blueprints/apps/bookings/package.json
packages/blueprints/apps/bookings/queries/board.js
packages/blueprints/apps/bookings/wall.css
packages/blueprints/apps/budgets/actions/attach.js
packages/blueprints/apps/budgets/actions/detach.js
packages/blueprints/apps/budgets/app.css
packages/blueprints/apps/budgets/app.js
packages/blueprints/apps/budgets/app.json
packages/blueprints/apps/budgets/index.html
packages/blueprints/apps/budgets/queries/overview.js
packages/blueprints/apps/home-inventory/actions/attach.js
packages/blueprints/apps/home-inventory/actions/detach.js
packages/blueprints/apps/home-inventory/app.css
packages/blueprints/apps/home-inventory/app.js
packages/blueprints/apps/home-inventory/app.json
packages/blueprints/apps/home-inventory/index.html
packages/blueprints/apps/home-inventory/queries/inventory.js
packages/blueprints/apps/hydrate/actions/set-cups.js
packages/blueprints/apps/hydrate/actions/weekly-encouragement.js
packages/blueprints/apps/hydrate/app.css
packages/blueprints/apps/hydrate/app.js
packages/blueprints/apps/hydrate/app.json
packages/blueprints/apps/hydrate/automations/weekly-encouragement.json
packages/blueprints/apps/hydrate/index.html
packages/blueprints/apps/hydrate/migrations/0001_init.sql
packages/blueprints/apps/hydrate/queries/get-today.js
packages/blueprints/apps/journal/actions/delete.js
packages/blueprints/apps/journal/actions/save.js
packages/blueprints/apps/journal/actions/weekly-recap.js
packages/blueprints/apps/journal/app.css
packages/blueprints/apps/journal/app.js
packages/blueprints/apps/journal/app.json
packages/blueprints/apps/journal/automations/weekly-recap.json
packages/blueprints/apps/journal/index.html
packages/blueprints/apps/journal/migrations/0001_init.sql
packages/blueprints/apps/journal/queries/get.js
packages/blueprints/apps/journal/queries/list-dates.js
packages/blueprints/apps/leads/actions/add-lead.js
packages/blueprints/apps/leads/actions/attach.js
packages/blueprints/apps/leads/actions/detach.js
packages/blueprints/apps/leads/actions/save-note.js
packages/blueprints/apps/leads/actions/update-client.js
packages/blueprints/apps/leads/app.css
packages/blueprints/apps/leads/app.js
packages/blueprints/apps/leads/app.json
packages/blueprints/apps/leads/index.html
packages/blueprints/apps/leads/package.json
packages/blueprints/apps/leads/queries/pipeline.js
packages/blueprints/apps/leads/wall.css
packages/blueprints/apps/notes/actions/attach.js
packages/blueprints/apps/notes/actions/create-note.js
packages/blueprints/apps/notes/actions/create-notebook.js
packages/blueprints/apps/notes/actions/detach.js
packages/blueprints/apps/notes/actions/edit-note.js
packages/blueprints/apps/notes/actions/move-note.js
packages/blueprints/apps/notes/app.css
packages/blueprints/apps/notes/app.js
packages/blueprints/apps/notes/app.json
packages/blueprints/apps/notes/index.html
packages/blueprints/apps/notes/queries/library.js
packages/blueprints/apps/people/actions/attach.js
packages/blueprints/apps/people/actions/detach.js
packages/blueprints/apps/people/actions/draft-message.js
packages/blueprints/apps/people/actions/resolve-identity.js
packages/blueprints/apps/people/actions/send-message.js
packages/blueprints/apps/people/app.css
packages/blueprints/apps/people/app.js
packages/blueprints/apps/people/app.json
packages/blueprints/apps/people/index.html
packages/blueprints/apps/people/queries/directory.js
packages/blueprints/apps/photos/app.json
packages/blueprints/apps/studio/actions/add-client.js
packages/blueprints/apps/studio/actions/add-project.js
packages/blueprints/apps/studio/actions/attach.js
packages/blueprints/apps/studio/actions/create-draft-invoice.js
packages/blueprints/apps/studio/actions/detach.js
packages/blueprints/apps/studio/actions/log-time.js
packages/blueprints/apps/studio/actions/mark-invoice-paid.js
packages/blueprints/apps/studio/actions/send-invoice.js
packages/blueprints/apps/studio/app.css
packages/blueprints/apps/studio/app.js
packages/blueprints/apps/studio/app.json
packages/blueprints/apps/studio/index.html
packages/blueprints/apps/studio/queries/studio.js
packages/blueprints/apps/subscriptions/actions/add-subscription.js
packages/blueprints/apps/subscriptions/actions/attach.js
packages/blueprints/apps/subscriptions/actions/detach.js
packages/blueprints/apps/subscriptions/actions/set-status.js
packages/blueprints/apps/subscriptions/app.css
packages/blueprints/apps/subscriptions/app.js
packages/blueprints/apps/subscriptions/app.json
packages/blueprints/apps/subscriptions/index.html
packages/blueprints/apps/subscriptions/package.json
packages/blueprints/apps/subscriptions/queries/list.js
packages/blueprints/apps/subscriptions/wall.css
packages/blueprints/apps/tasks/actions/add.js
packages/blueprints/apps/tasks/actions/attach.js
packages/blueprints/apps/tasks/actions/detach.js
packages/blueprints/apps/tasks/actions/edit.js
packages/blueprints/apps/tasks/actions/set-status.js
packages/blueprints/apps/tasks/app.css
packages/blueprints/apps/tasks/app.js
packages/blueprints/apps/tasks/app.json
packages/blueprints/apps/tasks/index.html
packages/blueprints/apps/tasks/queries/board.js
packages/blueprints/apps/tasks/queries/list.js
packages/blueprints/apps/threads/actions/attach.js
packages/blueprints/apps/threads/actions/detach.js
packages/blueprints/apps/threads/app.css
packages/blueprints/apps/threads/app.js
packages/blueprints/apps/threads/app.json
packages/blueprints/apps/threads/index.html
packages/blueprints/apps/threads/queries/thread.js
packages/blueprints/apps/todos/actions/add.js
packages/blueprints/apps/todos/actions/daily-digest.js
packages/blueprints/apps/todos/actions/delete.js
packages/blueprints/apps/todos/actions/toggle.js
packages/blueprints/apps/todos/app.css
packages/blueprints/apps/todos/app.js
packages/blueprints/apps/todos/app.json
packages/blueprints/apps/todos/automations/daily-digest.json
packages/blueprints/apps/todos/index.html
packages/blueprints/apps/todos/migrations/0001_init.sql
packages/blueprints/apps/todos/queries/list.js
packages/blueprints/apps/vitals/actions/attach.js
packages/blueprints/apps/vitals/actions/detach.js
packages/blueprints/apps/vitals/app.css
packages/blueprints/apps/vitals/app.js
packages/blueprints/apps/vitals/app.json
packages/blueprints/apps/vitals/index.html
packages/blueprints/apps/vitals/queries/readings.js
packages/blueprints/index.json
packages/blueprints/manifest.json
packages/blueprints/src/index.ts
packages/blueprints/src/types.ts
packages/gateway/src/cli/cli.test.ts
packages/gateway/src/cli/paths.ts
packages/gateway/src/serve/vault-plane.test.ts
packages/gateway/src/serve/vault-plane.ts
packages/vault/src/commands/attachments.test.ts
packages/vault/src/commands/attachments.ts
packages/vault/src/commands/bookings.test.ts
packages/vault/src/commands/bookings.ts
packages/vault/src/commands/business.test.ts
packages/vault/src/commands/business.ts
packages/vault/src/commands/knowledge.test.ts
packages/vault/src/commands/knowledge.ts
packages/vault/src/commands/subscriptions.test.ts
packages/vault/src/commands/subscriptions.ts
packages/vault/src/commands/tasks.test.ts
packages/vault/src/commands/tasks.ts
packages/vault/src/gateway/gateway.test.ts
packages/vault/src/gateway/gateway.ts
packages/vault/src/gateway/types.ts
packages/vault/src/index.ts
```

## Audit
**Verdict: PASS**

I verified the receipt against `gh issue view 254` and the staged `git diff --cached`. All three whole-app deletions are now correctly stated (hydrate, journal, AND todos superseded by Tasks) — the diff shows `D` on all three `app.json` files and `git ls-files` confirms no residual files remain under any of the three dirs, matching the corrected "## What changed" prose. The six new command packs (`attachments/bookings/business/knowledge/subscriptions/tasks.ts`) and three new prosumer app dirs (bookings 12, subscriptions 11, leads 12 files) all exist as claimed, and `attachments.ts` genuinely implements the `core.attach`/`core.detach` + sha256-deduped `data:` URI content-item design described. The receipt's checklist is byte-identical to the issue's checklist, and the file-coverage crosswalk is exact: 178 staged files (excluding the receipt), 178 listed, zero uncovered and zero fabricated.

— audited independently against issue #254 and the staged `git diff --cached`.

## Steering

**Verdict: PASS**

One human-steering event (interrupt) was identified at ordinal 16 and recorded. No tool denials or ordinary task messages were recorded — only the explicit interrupt marker counted as a steering event.

— steering audited from session 2e7b5550 against receipts/issue-254-prosumer-blueprints-attachments.md

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-2e7b5550-48b-1783073842-1 | claude-code | 2e7b5550-48bd-4287-8223-effda0355938 | #254 | claude-opus-4-8 | 468715 | 5783709 | 236046615 | 916066 | 7168490 | 179.4167 | 468715 | 5783709 | 236046615 | 916066 |  |
| claude-code-2e7b5550-48b-1783074163-1 | claude-code | 2e7b5550-48bd-4287-8223-effda0355938 | #254 | claude-opus-4-8 | 11739 | 56736 | 18627798 | 33976 | 102451 | 10.5766 | 480454 | 5840445 | 254674413 | 950042 |  |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-2e7b5550-1783074076-1 | 2e7b5550-48bd-4287-8223-effda0355938 | #254 | interrupt | structural |  | PENDING | 16 | 2026-07-03T08:05:33.398Z |
