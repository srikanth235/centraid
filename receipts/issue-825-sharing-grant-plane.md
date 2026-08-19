# issue-825 — sharing v1: the grant plane

GitHub issue: [#825](https://github.com/srikanth235/centraid/issues/825)

One umbrella, one receipt, nine waves (0–8). Wave 0 records the rulings in the durable docs before any code moves, per the issue's execution plan.

## Checklist

- [x] `grant` + `fulfillment` tables exist with the live-grant uniqueness and lifecycle above; migration lands existing commons grants and bindings with zero semantic loss (proven by pre/post fixture tests).
- [ ] Sharing an album/folder covers later additions: an item added to a granted container reaches the audience without a new grant.
- [ ] An origin edit on a `view`-granted subject follows to the audience replica (test: caption/body edit visible after sync).
- [ ] Revoking a grant stops sync and drives fulfillment to `remove_sent`/`removed`; a compliant peer removes the replica (integration test), and the UI copy states the best-effort nature verbatim.
- [ ] A grant to an unlinked person parks at `awaiting_channel` and mints the channel invitation as its first step — no separate link ceremony required of the member.
- [ ] `edit`-capability writes route back via the command routing table; a subject type without a routing answer cannot be offered (mechanical test, #750).
- [ ] Docs and Photos share/unshare through the one shared kit on web **and** mobile; no app-private share plumbing remains.
- [ ] People's person screen lists every live grant for that party and offers `Share` and `Revoke`; the three #821 withholding rows in `docs/design-divergences.md` are closed or rewritten with this issue as the cause.
- [ ] `peer-edge-give-route` and the give/edge-answer verbs are gone from the public surface; `readShareClosure`/`projectShareClosure` remain internal-only fulfillment transport.
- [ ] Absent-never-empty holds everywhere grants are read (`null` vs `[]` distinguished on every surface).
- [ ] `docs/decisions.md` records the eight rulings + supersessions; glossary, `ARCHITECTURE.md`, protocol docs updated in the same waves that change the facts.
- [ ] One receipt (`receipts/issue--sharing-grant-plane.md`) with per-wave crosswalk and a fresh-context adversarial audit.

## What changed

### Wave 0 — rulings first (docs only)

- `docs/decisions.md` gains `## Sharing v1 — the grant plane (#825)`: the eight `G-` rulings (G-membership, G-view, G-edit, G-revoke, G-channel, G-copy, G-audience, G-subject) as an Id table, the `share_grant` / `share_fulfillment` shapes, the v1 defaults (hard-delete removal, `tally.group`-only edit co-contribution, per-grant size ceilings carried unchanged). Two rows added to `## Superseded decision pointers`: the #726 "Give is a receiver-owned snapshot" half, and the link-ceremony-as-prerequisite (#726 / #821 L-write), each pointing at #825. The #726 "Ownership, sharing, and peer transport" paragraph and the #821 **L-write** row are amended in place to the new current answer, per that file's stated convention.
- `docs/glossary.md`: the sharing section is retitled to `## Sharing: the grant plane, commons, links, and the peer plane (#726, #731, #825)` (no inbound anchors existed) and gains **grant**, **fulfillment**, **channel**, **subject** rows. The **give** row is retired into the section's closing retired-vocabulary paragraph beside **lend**. The Owners section's "Sharing is residency" bullet now states grants and the `edit` strategy. Forbidden-synonym rows added: "copy-as-share" / "give a copy" → **grant**; "link ceremony" as a member prerequisite → **channel**; the lend row stops pointing at give.

The `docs/decisions.md records the eight rulings + supersessions` checklist item stays unchecked: its decisions/glossary half is realized here, but the item also binds `ARCHITECTURE.md` and the protocol docs to the waves that change those facts, so it closes when the last of them lands. Two sentence-level pointer rewrites ride along: the #821 section's closing sentence now points at the grant plane, and the glossary sharing-section intro now leads with what a member shares rather than how bytes cross.

### Wave 1 — the grant plane in the vault (schema + store)

- `packages/vault/src/schema/share-grant.ts` (new): `SHARE_GRANT_DDL` — two STRICT tables. `share_grant` (grant_id, audience_kind `party|circle` + audience_id, subject_type/subject_id, capability `view|edit`, granted_at/revoked_at, granted_by → `core_party`, max_size_bytes) with a partial UNIQUE index enforcing **one live grant per audience × subject** (revoked rows are history; a re-grant inserts). `share_fulfillment` (grant_id → share_grant CASCADE, peer_vault_id, state `awaiting_channel|syncing|delivered|remove_sent|removed`, updated_at, detail; PK grant_id+peer_vault_id). Same file: `SHARE_GRANT_BACKFILL_DDL`, migration rung three — pure-SQL restatement of live commons grants into standing grants (mapping under Decisions).
- `packages/vault/src/schema/migrate.ts`: `SHARE_GRANT_DDL` joins the rung-one baseline after `COMMONS_RESILIENCE_DDL`; `SHARE_GRANT_BACKFILL_DDL` is rung three (`VAULT_MIGRATIONS` length now 3); header re-worded for "every rung". `schema/migrate.test.ts`: length/user_version assertions to 3, the two tables added to the fresh-vault walk, and the rung-two fixture test pinned to `slice(0, 2)` (its minimal v1 file has no commons tables; rung three has its own upgrade test). `packages/vault/src/schema/migrate-share-grant.test.ts` (new): pre/post fixture upgrade tests — uniform named circle stays one circle grant, variant/implicit circles decompose per party, refused member gets no grant, collision ranking, fulfillment state derivation, revoked/give-plane rows ignored, fresh-file no-op.
- `packages/vault/src/grant/` (new): `grant-store.ts` (create/read/revoke/list grants; ensure/set/read/list fulfillment; `resolveAudienceParties`; `listLiveGrantsReachingParty` party∪circle-roster union; `createShareGrant` throws `UnofferableSubjectError` on a subject × capability pair without a fulfillment answer — the #750 gate enforced at the write door, not merely declared; surfaces consult the registry before drawing the verb), `subject-registry.ts` (`SHARE_SUBJECT_REGISTRY`, `isOfferableSubjectType`, `fulfillmentAnswerFor`; `locker.item` deliberately absent), `channel.ts` (`channelForParty`: `live|invited|severed` derived from `share_party_vault_binding` plus pending `share_commons_invitation` rows for the `invited` state, no new table) — each with its own test file.
- Registration: `packages/vault/src/schema/tables.ts` `share:` block gains `grant` + `fulfillment` (canonical walk carries both); `packages/vault/src/schema/poly-refs.ts` excludes `share_grant`'s subject pair beside `share_circle_grant`'s container pair; `packages/vault/src/index.ts` re-exports the grant plane; `packages/vault/src/gateway/portable-export.ts` carries the #825 export audit note; `tests/schema-export-fingerprint.json` re-pinned with the #825 approvedDeviation prose.
- Full file list for this wave: `packages/vault/src/schema/share-grant.ts`, `packages/vault/src/schema/migrate.ts`, `packages/vault/src/schema/migrate.test.ts`, `packages/vault/src/schema/migrate-share-grant.test.ts`, `packages/vault/src/schema/tables.ts`, `packages/vault/src/schema/poly-refs.ts`, `packages/vault/src/grant/grant-store.ts`, `packages/vault/src/grant/grant-store.test.ts`, `packages/vault/src/grant/subject-registry.ts`, `packages/vault/src/grant/subject-registry.test.ts`, `packages/vault/src/grant/channel.ts`, `packages/vault/src/grant/channel.test.ts`, `packages/vault/src/index.ts`, `packages/vault/src/gateway/portable-export.ts`, `tests/schema-export-fingerprint.json`.

Realized here, word for word: `grant` + `fulfillment` tables exist with the live-grant uniqueness and lifecycle above; migration lands existing commons grants and bindings with zero semantic loss (proven by pre/post fixture tests). The tables are `share_grant`/`share_fulfillment` (the consent plane owns the bare `grant` name), the uniqueness is the partial index, the lifecycle is `granted_at`/`revoked_at` plus the five fulfillment states, and the pre/post fixture tests are `migrate-share-grant.test.ts`'s seeded v2 vault asserted row-for-row after the rung, with the commons snapshot proving byte-identical survival.

## Decisions

The judgment calls the diff cannot show.

**Rulings land ahead of code, deliberately.** Wave 0 records the #825 decisions as current answers while the grant tables do not exist yet; the issue's execution plan orders it so ("docs coherent before any code moves"), and the G-section says so in one line. Glossary Code cells name the table names the schema wave ships (`share_grant`, `share_fulfillment`), not file paths that do not exist yet.

**Edge/closure vocabulary stays put until the code dies.** The glossary's `edge`, `closure`, `projection` rows and the `placement_intents` synonym row still describe live code; they are wave-8 retirement-sweep work, not wave-0 work.

**Give row deleted, not annotated.** Following the file's own precedent for **lend**, the retired vocabulary moved to the closing paragraph rather than surviving as a struck-through table row.

**Audience is `audience_kind + audience_id`, not `audience_party_id`.** The issue's sketch says "who (person or circle)", but a circle is not a party (`social_circle`, not `core_party`), so one FK column could not be honest about both. The kind column makes the polymorphism explicit; `granted_by` stays a real `core_party` FK.

**Migration is hybrid, not per-party-for-everything.** A named circle whose members agree on one capability **and contain no refusal** stays **one circle-audience grant** — this also keeps a live grant over an empty named circle alive (at the conservative `view` floor) where per-party decomposition would silently drop it. Implicit circles, capability-variant circles, and circles containing a refused member decompose per party (`read→view`, `read+write→edit`): a circle-audience row over a roster containing a refused party would keep reaching that party through the roster union, so a refusal forces decomposition, and refused members — never a standing permission — get no grant. The limit case is a deliberate, tested ruling: a live named-circle grant **every** member refused permits no one and migrates to nothing; the commons row and the refusals survive untouched as the record, and re-sharing the circle re-creates it. Collisions (two commons grants reaching the same party × subject) are ranked deterministically: strongest capability, earliest granted_at, then source grant id — tested. One consequence decomposition accepts: a decomposed grant no longer follows the circle's roster, so a party added to that circle later is not reached until the owner shares again — the price of never reaching a refused party; wave 2's roster-recompile work records this in `docs/decisions.md` when it lands.

**A member with no binding row gets no fulfillment row.** The fulfillment PK needs a `peer_vault_id` and there is none to name; absence simply means "no channel yet" — the channel question is answered separately by `channelForParty` over bindings and pending invitations, so nothing needs a placeholder row. A member whose only binding is revoked keeps that vault id at `awaiting_channel`. This is the absent-never-empty rule applied at the schema layer, not a data loss.

**`packages/vault/src/grant/` is deliberately outside `share-reachability.json` in this wave.** The reachability gate demands a production caller for every export of the listed share modules, and the grant store's production callers arrive in waves 2–3; adding the glob now would force a fake caller. The glob lands with the engine.

**Writers take input objects, readers stay positional.** Every write needs a caller-supplied timestamp (no host clock in the vault), matching `share/party-vault-binding.ts`'s house style.

## Out of scope

Named so the omissions are not read as oversights.

- **Delivery.** Wave 1 stores grants and records fulfillment state; nothing here projects bytes, routes commands, or mints invitations — that is wave 2's engine over the existing closure/commons transports. Waves 3–8 own routes, kits, app integrations, and retirement.
- **`share-reachability.json`** stays untouched (see Decisions): the grant store gains production callers in waves 2–3, and the reachability glob lands with them.
- **`ARCHITECTURE.md`, `SECURITY.md`, `docs/protocol.md`, `docs/blueprint-seats.md`, `docs/design-divergences.md`** — updated in the waves that change those facts, per the docs-describe-current-state rule.
- Contact-card sharing, a "give a copy" verb, `comment` capability, federation beyond linkable vaults, CRDT conflict resolution — out of the issue's scope entirely.

## User impact

Waves 0–1 change no running surface: wave 0 is docs only, and wave 1 adds vault tables and a store nothing calls yet — an upgraded vault gains two tables and backfilled rows, but no screen or route reads them. User-facing impact begins with the UI kit and app waves.

## Verification

```sh
bun run format:check   # all matched files use oxfmt code style
node scripts/ci/run-gates.mjs format:check lint   # both green
bun run --cwd packages/vault test        # 178 files, 1358 passed | 2 skipped
bun run --cwd packages/vault typecheck   # tsc -p tsconfig.test.json --noEmit, clean
bun run lint:schema-export               # ratchet f2991949… matches the re-pinned fingerprint
bun run knip                             # exit 0, no unused-export findings for grant/
```

Link integrity: every relative link added resolves (`decisions.md#sharing-v1--the-grant-plane-825` anchor matches the file's em-dash slug convention; `../packages/vault/src/share/{commons-routing,read-closure,project-closure}.ts` all exist).

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-19 | claude-code | 0fabaf8f-2be9-5a2b-bb49-7c33fe55c22a |

## Audit

Fresh-context sub-agent attestation (governance directive `receipt-per-issue` rule 7). The auditor is handed only the diff, this receipt, and issue #825, instructed to default to REFUTED when uncertain.

### Wave 0 — one pass after three findings, each fixed

- (1) `## What changed` faithfully describes the diff — PASS. Two benign pointer-sentence rewrites were initially unmentioned; both are now named in `## What changed`.
- (2) Every `- [x]` item is realized in the diff — PASS after fix. The auditor refuted the initially-checked docs item: the glossary's give paragraph asserted a completed retirement ("left the product surface") while the give/edge code still exists, and `ARCHITECTURE.md` / `docs/blueprint-seats.md` still state the old semantic. Fixes applied: the give paragraph is re-tensed to the ruling ("retires under #825 … leave the product surface in that issue's retirement wave"), and the checklist item is unchecked until the last doc wave lands. No `- [x]` items remain in the wave-0 change set.
- (3) The `## Checklist` mirrors the issue's checklist — PASS. All 12 items verbatim, in order, including the issue's own `receipts/issue--sharing-grant-plane.md` path in item 12 (faithful mirroring).

Verdict: PASS

### Wave 1 — first pass REFUTED on four findings, each fixed, second pass below

- (1) **Refusal widened through circle audiences — fixed in SQL.** The auditor proved a uniform named circle containing a refused member migrated to one circle-audience grant whose roster union (`listLiveGrantsReachingParty`) reached the refused party again. Fix: a refusal now forces per-party decomposition (`NOT EXISTS … status = 'refused'` joined into the audience-kind decision), and the fixture gained `circle-club` (uniform, one refusal → decomposes; the refused member gets nothing).
- (2) **All-refused live circle grant silently dropped — now a disclosed, tested ruling.** A live named-circle grant every member refused decomposes to nothing and does not migrate: it permits no one, the commons row and the refusals survive untouched as the record (asserted by the before/after commons snapshot), and re-sharing re-creates it. Fixture gained `circle-refused`/`grant-solo` proving the drop is deliberate, not accidental. Checklist item 1 stays checked on this reading of "zero semantic loss": no standing permission and no historical record is lost — the one thing not carried is a live row that permitted nobody.
- (3) **Channel prose overstated — fixed.** `invited` derives from `share_commons_invitation` as well as bindings (receipt now says so), and `grant/channel.ts` never reads `share_fulfillment` — the "absence is no channel yet" DDL comment and receipt sentence no longer attribute that reading to `channel.ts`.
- (4) **#750 gate was declared, not seated — now enforced.** `createShareGrant` throws `UnofferableSubjectError` on a subject × capability pair without a fulfillment answer (nothing inserted; reaching the store with such a pair is an upstream contract violation, since surfaces consult the registry before drawing the verb), tested for `locker.item` view and `media.asset` edit. Checklist item 6 stays unchecked: the routing-back half is wave 2.

The auditor also independently re-ran the Verification battery (green) and confirmed the backfill SQL against the real commons schema, the collision ranking, the empty-circle `view` floor, and the reachability decision.

**Second pass** (fresh context) confirmed all four fixes sound — the refusal `NOT EXISTS` is per-grant not per-circle (probed with a two-grants-one-circle fixture), the all-refused drop is disclosed and the commons snapshot covers the new rows, the #750 throw precedes any read/insert with an acyclic import graph, the empty-circle floor survives the SQL change — and REFUTED only two stale numbers in the `## Verification` block (pre-fix test count and fingerprint), both corrected above. It also surfaced a consequence the receipt had not named — a decomposed grant no longer follows roster drift — now recorded under Decisions. Gates re-run green by the auditor: vault 178 files / 1358 passed, typecheck clean, ratchet `f2991949…`.

Verdict: PASS
