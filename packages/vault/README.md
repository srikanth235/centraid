# @centraid/vault

The **vault**: Centraid's person-owned ontology as STRICT SQLite DDL, plus the **gateway** — the single consent-checked door every read and every write passes through. The model's design is the published page at [centraid.dev/docs/ontology](https://centraid.dev/docs/ontology/) (authored in `scripts/docs-site/src/content/ontology-body.html`, logical model 1.0); its engineering state, commitments and drift register are [docs/vault-ontology.md](../../docs/vault-ontology.md).

## What's here

**The ontology** — ONE file per vault, one ACID boundary:

- `vault.db` — the sovereign asset. The `core` spine (party, place, event, account and transaction, content item, document, activity, link, concept, tag, collection) with the `core_entity` supertype every entity has a row in, seven life-domain packs (`schedule`, `social`, `knowledge`, `media`, `people`, `locker`, `tally`), the `access` and `agent` planes, and the machinery bands (`share`, `sync`, `enrich`, `outbox`, `notifications`, `blob`, `audit`, `ledger`). Engine-enforced FKs throughout — including the composite keys that replaced every polymorphic `(type, id)` pointer.
- The `audit` band is the append-only evidence stream: `access.receipt` (hash-chained), `access.provenance` (W3C PROV, chained per entity), `agent.command_invocation` / `invocation_check` / `evidence` / `explanation`, and the archive manifests that seal old segments into the CAS. Append-only is enforced by triggers, not by convention.
- The `ledger` band is the conversation transcript (`conversation ⊃ turn ⊃ item`); the vault package owns the tables, `@centraid/server` owns the store code over them.
- Both bands are excluded from the portable export and from the replica BY BAND, and both are kept small by retention (`RETENTION_WINDOWS` in `src/schema/audit.ts`), not by living in a second file.

**The schema is a baseline, then rungs.** `VAULT_MIGRATIONS` in `src/schema/migrate.ts` holds rung one — the #916 baseline, stated rather than reconstructed, because v0 had no files in the field — and rungs two through four, added by [#929](https://github.com/srikanth235/centraid/issues/929), the first change that had to reach a file that already existed — the subscription seat, `share_delivery_config`'s re-cut with `departure_policy`, and the drop of `core_share_origin`. A fresh vault stamps `PRAGMA user_version = 4`. Rung one is history and does not grow; a change that must reach an existing file adds the next rung.

SQLite has no namespaces, so logical `core.party` is physical `core_party`. The entity registry (`src/schema/entity-catalog.ts`, resolved through `tables.ts`) is the only translation point, an allow-list, and since [#883](https://github.com/srikanth235/centraid/issues/883) the one owner of every entity's member-facing name. An unregistered table is outside every export, replica trigger, access scope and Atlas census — the registry is the model. It is also where each entity declares its lifecycle (`append-only` / `mutable` / `trash` / `machinery`), its revision retention, and whether it is a _projection_ — a part of an entity rather than an entity, keyed by its parent and holding no supertype row.

**The gateway (§10)** — sole holder of connections. Every request walks:

1. **Identity** — callers authenticate as rows (`access.app`, `access.agent`, `access.device`); unknown callers are dropped at transport, no receipt.
2. **Access** — active grant, scope covers the dotted entity + verb (`read`, `read+act`, `act`, `reveal`), row filters, field masks, purpose policy, command risk vs `risk_ceiling`. A deny is a receipted outcome, not an exception.
3. **Contract** — JSON-Schema input validation, preconditions evaluated as real queries and recorded as `invocation_check` rows _before_ anything mutates, lifecycle refusals (an append-only entity refuses UPDATE; a restore past `purge_at` is refused), `ontology_version` equality on the command contract.
4. **Execution** — invocation → core rows → domain rows → receipt, all in ONE transaction of ONE file; idempotent replay off caller invocation ids; postconditions verified with rollback on failure. `(type, id)` pointers are composite foreign keys, so the engine refuses a ghost target and cascades a purge without a sweep.
5. **Evidence** — receipt per read and command (allowed or denied), provenance per write, evidence + explanation rows.

**Standing duties** run on the gateway clock: the lifecycle sweep (`purge_at` deletions, grant and share expiry, retention policy, stored-projection heals — each row in its own transaction, so one refused purge cannot wedge the pass), the archival pass that holds the audit and ledger bands to `RETENTION_WINDOWS`, the revocation cascade (projections scrubbed, parked invocations dropped, an uninstalled app's `ext.<app_id>.*` band retained then purged), confirmation routing for invocations above the caller's risk ceiling, ingest customs (`src/ingest/`: ICS, vCard, CSV, mbox, Takeout, password CSVs — dedupe on external ids, handle→identity resolution, per-row provenance), export and portability (`src/gateway/portable-export.ts`, lossless round-trip proven by hash equality; sealed cells ride as ciphertext and the DEK leaves only inside a password-wrapped custody kit, `src/gateway/portable-custody.ts`), file custody (checkpoint, backup, WAL shipping, blob custody and the remote tier), and the sealed-column class (`src/schema/sealed.ts`: AES-GCM at rest, placeholder on read, receipted reveal, structurally barred from FTS).

**Command packs** — every write is a registered `agent.command` with declared pre/postconditions, hosted and checked by the gateway: `schedule` (events, RSVP, tasks, projects, sections, recurrence), `social` (contact channels, identity resolution, threads and drafts), `knowledge` (notes, notebooks over `core.collection`), `media` (assets, albums over `core.collection`, faces, places, memories), `documents` (a drive with no new tables: content items filed by folder-scheme tags), `people` (profiles, lists as SKOS tags, important dates, interactions as `core.activity`), `locker` (typed secret items, fields, export; history is `core.entity_revision`, retained forever for this pack), `tally` (expenses, splits, payers, settlements that post to `core.transaction`, obligations, nudges), `parties`, `attachments`, `tags`, `links`, `share` (the one writer of `share.authority`), `sync`, `enrich`, `outbox`, and `atlas` (the journalled Browse editor). Every pack has a consumer: the `health`, `finance` and `judgment` packs left in [#916](https://github.com/srikanth235/centraid/issues/916) with the DDL they wrote — see the drift register in [docs/vault-ontology.md](../../docs/vault-ontology.md).

**Other planes in this package**: device replicas (`src/replica/`, change-log triggers generated from the registry), sharing (`src/share/`: closure read and projection, commons, placement), the grant plane (`src/grant/`), enrichment policy and derivations (`src/enrich/`), blob custody (`src/blob/`), the vault identity keypair (`src/schema/vault-identity.ts`), `vaultDoctor` (`src/doctor.ts`), and the golden-vault corpus under `tests/golden/` (re-frozen at `issue-916`) that every PR opens.

## Usage

```ts
import * as vault from "@centraid/vault";

const db = vault.openVaultDb({ dir: "/path/to/vault" }); // omit dir for in-memory
const boot = vault.bootstrapVault(db, { ownerName: "Priya" });
const gw = vault.createGateway(db);
vault.registerScheduleCommands(gw);

const owner = {
  kind: "device",
  deviceId: boot.deviceId,
  deviceKey: boot.deviceKey,
} as const;
const outcome = gw.invoke(owner, {
  command: "schedule.propose_event",
  input: {
    summary: "Standup",
    dtstart: "2026-07-03T09:00:00Z",
    dtend: "2026-07-03T09:15:00Z",
    calendar_id,
  },
});
```

Apps and agents get scoped, expiring grants (`enrollApp` / `enrollAgent` + `createGrant`) and go through the same door; nothing else holds a connection.

## Changing the model

Same PR, every time: the DDL in its band module, the registry entry with its label, the entity-pointer entry if the table carries a `(type, id)` pair, the content-reference entry if it rents bytes, the FTS spec if it has text, the command pack and app scope, and the §03 entry on the published page — `src/schema/ontology-doc.test.ts` compares that page with the live schema and prints the column tuples it expects.
