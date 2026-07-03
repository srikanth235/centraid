# @centraid/vault

Implementation of the **Duaility personal ontology** (`duaility-ontology.html`, logical model v1.1): a person-owned, self-hostable canonical data model of a whole life, plus the **gateway** — the single consent-checked choke point through which every read and every write passes.

## What's here

**The ontology (§03)** — all eleven schemas as STRICT SQLite DDL across the two-file physical layout:

- `vault.db` — the sovereign asset: `core` (party, place, event, account/transaction, content_item, activity, observation, link, concept — 16 tables), the `consent` plane model (apps, grants, scopes, shares, policy, devices, export jobs), the `agent` plane model (agents, commands, capabilities, corrections, judgments), and eight life domains (`health`, `finance`, `schedule`, `social`, `knowledge`, `media`, `home`, `business`). 68 tables, engine-enforced FKs, one ACID boundary.
- `journal.db` — the append-only audit stream: `consent.receipt` (hash-chained), `consent.provenance` (W3C PROV, chained per entity), `agent.command_invocation` / `invocation_check` / `evidence` / `explanation`.

SQLite has no namespaces, so logical `core.party` is physical `core_party`; `resolveEntity()` is the only translation point and doubles as an allow-list.

**The gateway (§10)** — sole holder of connections. Every request walks:

1. **Identity** — callers authenticate as rows (`consent.app`, `agent.agent`, `consent.device`); unknown callers are dropped at transport, no receipt.
2. **Consent** — active grant, scope covers schema+verb, row filters, field masks, purpose policy, command risk vs `risk_ceiling`. A deny is a receipted outcome, not an exception.
3. **Contract** — JSON-Schema input validation, preconditions evaluated as real queries and recorded as `invocation_check` rows *before* anything mutates, `agent.judgment` consulted as constraints.
4. **Execution** — journal invocation → vault rows write order, idempotent replay off caller invocation ids, postconditions verified with rollback on failure.
5. **Evidence** — receipt per read and command (allowed or denied), provenance per write, evidence + explanation rows.

**Standing duties** — all eight from §10:

- **View service** (`gw.registerView` / `gw.queryView`) — declarative `consent.app_view` definitions compiled at registration (joins must follow declared FKs per `PRAGMA foreign_key_list`), clamped at execution to the app's grant scopes per touched entity: field masks intersect the view's columns, scope row filters AND with the view's own, an unconsented join denies. Live views only; materialization refresh is the remaining seam.
- **Confirmation routing** — invocations above the caller's risk ceiling park for owner confirmation; the pause is gateway state.
- **Revocation cascade** — grant revoked → views invalidated, parked invocations dropped, and on the app's last grant its `appext_<app_id>.db` is deleted (uninstall = revoke + delete file, R09); model and receipts remain.
- **Lifecycle sweeps** — `purge_at` deletions, grant/share expiry, and `consent.policy` retention rows (`retention_days` + `rule_json.timestamp_column`).
- **Ingest customs** (`gw.importIcs` / `gw.importVcards`) — dedupe on `ical_uid` / identifier, handle→identity resolution so a person is never duplicated per channel, per-row provenance with `agent_kind='import'`.
- **Export & portability** (`gw.exportVault` / `importVaultExport`) — sha256-verifiable artifact, lossless round-trip proven by hash equality + `foreign_key_check` (the §11 gate, as a test).
- **Version brokering** — S3 refuses any command contract whose `ontology_version` the gateway doesn't serve; compatibility windows for older contracts are the remaining seam.
- **File custody** (`gw.checkpoint` / `gw.backup` / `gw.createAppExt`) — WAL truncation, consistent `VACUUM INTO` backups with verify hashes, per-app extension files.

S4 additionally validates **polymorphic refs** inside the transaction: any `core.link` / `core.attachment` / `core.tag` / `knowledge.annotation` row a command writes must point at live rows or the invocation rolls back.

**Domain commands** — registered as `agent.command` rows with declared pre/postconditions and domain-owned handlers the gateway hosts and checks:

- **schedule** (§11 first boundary): `propose_event`, `reschedule_event` (SEQUENCE bump on the same identity), `respond_rsvp` (RFC 5545 PARTSTAT state machine)
- **social**: `resolve_identity` (binds a raw handle to one party and backfills unresolved participants/senders — handles stay for audit; refuses handles claimed by another party), `draft_message` (thread + body as sha256-deduped `core.content_item`), `send_message` (**risk=high** — the model's confirmation showcase: agents park, the owner releases; only `draft → sent` is command-reachable), `update_card`
- **finance**: `categorize_txn` (classification with provenance, amounts unreachable by construction), `split_txn` (postcondition enforces **Σ splits = parent amount**, rollback on violation), `set_budget` (upsert; progress stays a projection), `flag_anomaly` (a `core.tag`, not a column)
- **health**: `log_vital` (the reading IS a `core.observation` + `health.vital` with Open mHealth/LOINC/UCUM codes), `import_workout` (one span, two lenses: `core.activity` + `health.workout`), `adjust_course` (medication state via `started_at`/`ended_at`; **never writes events** — reminders are flagged stale for `schedule.propose_event`, honoring the §07 boundary), `summarize_trends` (the observation window becomes an owned, cited `core.content_item` — the §09 doctor-visit pattern). Plus the consent-plane rule: a seeded **minimization policy** makes `health.condition` invisible to schema-wide scopes — only a grant naming the table explicitly covers it.

This is the §11 **foundation release** — schedule, social, finance and health — complete.

Later packs extend the same contract to the rest of the projection band: **tasks** (`schedule.add_task`/`edit_task`/`set_task_status`) and `schedule.cancel_event` (a SEQUENCE-bumping revision, risk medium like reschedule), **knowledge** (`create_note`/`edit_note`/`move_note`/`create_notebook`/`delete_note`), **business** (the client → project → time → invoice loop), **attachments** (`core.attach`/`detach`), **bookings**, **subscriptions**, **parties** (`core.add_party`/`update_party` — apps mint and revise contacts; identifier forks are refused), **media** (the photo-library loop: `add_asset` through `remove_from_album`, bytes soft-deleting only when the last canonical reference lets go), **documents** (a drive with no new tables: content items filed by `core_tag` into folder concepts under the `https://centraid.dev/schemes/folders` scheme, trash = the content item's own `deleted_at`/`purge_at` lifecycle), and **home** (`add_item`/`update_item`/`dispose_item`/`add_warranty`).

## Usage

```ts
import * as vault from '@centraid/vault';

const db = vault.openVaultDb({ dir: '/path/to/vault' }); // omit dir for in-memory
const boot = vault.bootstrapVault(db, { ownerName: 'Priya' });
const gw = vault.createGateway(db);
vault.registerScheduleCommands(gw);

const owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey } as const;
const outcome = gw.invoke(owner, {
  command: 'schedule.propose_event',
  input: { summary: 'Standup', dtstart: '2026-07-03T09:00:00Z', dtend: '2026-07-03T09:15:00Z', calendar_id },
  purpose: 'dpv:ServiceProvision',
});
```

Apps and agents get scoped, expiring grants (`enrollApp` / `enrollAgent` + `createGrant`) and go through the same door; nothing else holds a connection.
