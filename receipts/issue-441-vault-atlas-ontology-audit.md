# issue-441 — Ontology audit fixes + the Vault Atlas (Kinds / Relations / Browse)

GitHub issue: [#441](https://github.com/srikanth235/centraid/issues/441)

Two halves of one problem: the model had drifted from its own rules (#274), and
no surface existed that would have shown us. Part A fixes the audit findings;
Part B ships the Vault Atlas Operations screen — Kinds census, Relations
orrery, and a journalled Browse editor. The hinge between them is the
polymorphic-reference registry: it completes the purge sweep by construction
AND feeds Browse's dependent-aware deletes (engine FKs alone cannot see
`core_tag`/`consent_share`-style dependents).

## Checklist

- [x] Commit 1 — Part A audit fixes: poly-ref registry + generic purge, P2 cheap bleeds, P7 conventions
- [x] Commit 2 — Part B backend: atlas stats/graph/pulse + journalled Browse CRUD
- [x] Commit 3 — Part B UI: Vault Atlas screen — Kinds, Relations orrery, Browse editor

## What changed

(This receipt, `receipts/issue-441-vault-atlas-ontology-audit.md`, lands with
Commit 1.)

### Commit 1 — Part A audit fixes: poly-ref registry + generic purge, P2 cheap bleeds, P7 conventions

**The registry (A1).** `packages/vault/src/schema/poly-refs.ts` +
`packages/vault/src/schema/poly-refs.test.ts`: every polymorphic `(type, id)`
reference in vault.db is now registered with a cleanup policy (`end-date` for
`core_link`, `delete` for tags/entries/attachments/annotations/embeddings/
sync-maps/open enrich requests/`consent_seed_row`, `revoke` for
`consent_share`), with documented exclusions (journal.db audit tables are
append-only by design; `agent_correction` is a historical record;
`sync_import_row` is immutable import history; `outbox_item` has its own drain
lifecycle). A closure test scans the live schema for `_type`/`_id` column
pairs and fails on any unregistered mechanism — the class is closed, not the
instances. `packages/vault/src/gateway/duties.ts` +
`packages/vault/src/gateway/duties.test.ts`: every purge path (content item,
note, document, media asset, lapsed assets) now walks the registry via one
generic `cleanupPolyRefs`, extending coverage to the three never-cleaned
mechanisms (`consent_share`, `enrich_embedding`, `sync_external_entity`) and
to annotations/attachments on non-note entities.

**P2 cheap bleeds.** `packages/vault/src/commands/media.ts` +
`packages/vault/src/commands/media.test.ts`: `media.set_favorite` and
`media.update_asset` now mirror the flags-scheme starred tag onto the
canonical `core.content_item` (postcondition asserts column and tag agree) —
the #274 healed-silo behavior restored. `packages/vault/src/commands/people.ts`
+ `packages/vault/src/commands/people.test.ts` +
`packages/vault/src/commands/parties.ts`: birthdays are single-writer — a
birthday-labeled important date writes through to `core_party.birth_date`
(year-preserving; year-less `--MM-DD` when unknown) and a party `birth_date`
update refreshes the People row; a test asserts the two can never disagree.
`packages/vault/src/schema/domains-tally.ts` +
`packages/vault/src/commands/tally.ts` +
`packages/vault/src/commands/tally.test.ts`: `tally_friend.avatar_color` is
dropped — one stored hue per party (on `people_profile`); the tally app
derives its display hue deterministically from the party id
(`packages/blueprints/apps/tally/format.js`,
`packages/blueprints/apps/tally/queries/dashboard.js`,
`packages/blueprints/apps/tally/actions/add-friend.js`,
`packages/blueprints/apps/tally/app.json`,
`packages/blueprints/apps/tally/components/FriendModal.jsx`,
`packages/blueprints/apps/tally/logic.js`,
`packages/blueprints/apps/tally/seed.js`).
`packages/vault/src/schema/domains-home-business.ts` +
`packages/vault/src/commands/business.ts` +
`packages/vault/src/commands/business.test.ts`: `business_invoice_line` gains
`qty_scale` (0–9, written as 2 = hundredths of an hour) and
`CHECK (amount_minor >= 0)`. `packages/vault/src/schema/fts.ts` +
`packages/vault/src/gateway/search.test.ts`: People text bodies
(`people.interaction`, `people.journal_entry`, `people.task`, `people.gift`)
are now FTS-indexed and searchable.

**P7 conventions.** `packages/vault/src/schema/domains-people.ts`,
`packages/vault/src/schema/domains-tally.ts`,
`packages/vault/src/schema/domains-locker.ts`,
`packages/vault/src/schema/domains-social-knowledge-media.ts`: the soft-delete
pair `deleted_at`/`purge_at` + its CHECK guard is now uniform across
owner-deletable People/Tally content rows, and the missing guard is added to
`knowledge_note` and `locker_item`; DDL headers document which rows stay
hard-delete and why (`people_profile`, `tally_friend`, `tally_group` are
identity/structural decorations). `tally.delete_expense` is a reversible
soft-delete with a new `tally.restore_expense`; a trashed expense still blocks
group deletion. The sweep purges lapsed domain trash table-driven, cleaning
polymorphic refs per row. People's classification mechanism is renamed apart
from the `social_circle` audience: circles → **lists** end-to-end
(`LIST_SCHEME_URI`, `people.create_list`/`rename_list`/`delete_list`,
`packages/vault/src/gateway/assistant-context.ts`, and the people app:
`packages/blueprints/apps/people/actions/create-list.js`,
`packages/blueprints/apps/people/actions/rename-list.js`,
`packages/blueprints/apps/people/actions/delete-list.js` replacing
`packages/blueprints/apps/people/actions/create-circle.js`,
`packages/blueprints/apps/people/actions/rename-circle.js`,
`packages/blueprints/apps/people/actions/delete-circle.js`;
`packages/blueprints/apps/people/actions/add-person.js`,
`packages/blueprints/apps/people/actions/move-person.js`,
`packages/blueprints/apps/people/app.json`,
`packages/blueprints/apps/people/app.jsx`,
`packages/blueprints/apps/people/app.css`,
`packages/blueprints/apps/people/index.html`,
`packages/blueprints/apps/people/format.js`,
`packages/blueprints/apps/people/logic.js`,
`packages/blueprints/apps/people/components/AddPersonModal.jsx`,
`packages/blueprints/apps/people/components/Details.jsx`,
`packages/blueprints/apps/people/components/List.jsx`,
`packages/blueprints/apps/people/components/NewMenu.jsx`,
`packages/blueprints/apps/people/components/Sidebar.jsx`,
`packages/blueprints/apps/people/queries/dashboard.js`,
`packages/blueprints/apps/people/queries/journal.js`,
`packages/blueprints/apps/people/queries/people.js`,
`packages/blueprints/apps/people/queries/person.js`,
`packages/blueprints/apps/people/queries/search.js`;
`packages/blueprints/manifest.json` regenerated). Stored projections resolved:
`social_thread.last_message_at` documented as a rebuildable projection with a
sweep heal; `people_profile.last_contacted_at` documented as a ground fact
(stamped only by the explicit log-interaction gesture).

### Commit 2 — Part B backend: atlas stats/graph/pulse + journalled Browse CRUD

`packages/vault/src/schema/atlas.ts` + `packages/vault/src/schema/atlas.test.ts`:
table → kind → pack mapping derived from the tables registry (never
hand-listed; unclassified schemas fail loud).
`packages/vault/src/schema/atlas-census.ts` +
`packages/vault/src/schema/atlas-census.test.ts`: the three payload builders —
census (dbstat rows/bytes with estimate fallback), graph (PRAGMA
foreign_key_list walk with per-edge fill, fill-based ghost semantics, directed
reverse-FK hop distances from `core_party`, the locker/sync island, and
authored `core_link` aggregation as a SEPARATE collection), and pulse (30-day
per-table write counts from journal provenance). Tests assert no NOT NULL
edge with a non-empty child table is ever a ghost, and derive expected edge
counts from an independent PRAGMA walk — no hardcoded 122/46.

`packages/vault/src/schema/atlas-browse.ts`: Browse read side — keyset
pagination (composite-PK tables fall back to rowid; NULL-aware tuple
predicates for nullable order columns), column metadata with FK targets and
sealed flags, FK reference search with a display-field heuristic, dependent
preview merging the reverse engine-FK walk with the poly-ref registry.
`packages/vault/src/commands/atlas.ts` +
`packages/vault/src/commands/atlas.test.ts`: the write trio
`atlas.insert_row`/`atlas.update_row`/`atlas.delete_row` registered through
the §10 command pipeline — the journalled write path — so every Browse edit
is captured by the replica change-log triggers and stamped with
`agent_kind='owner'` provenance; sealed columns refuse writes; machinery
bands refuse writes without an explicit unlock; deletes are blocked by engine
FKs and sweep polymorphic pointers on success.
`packages/gateway/src/routes/vault-routes.ts` +
`packages/gateway/src/routes/vault-routes.atlas.test.ts` +
`packages/gateway/src/routes/vault-routes.browse.test.ts` +
`packages/gateway/src/serve/vault-plane.ts`: `GET /_vault/atlas/{stats,graph,pulse}`
plus nine `/_vault/atlas/browse/*` routes (reads + writes, 409 with the
dependents payload). Typed client wrappers live in a new
`packages/client/src/gateway-client-atlas.ts` (split from
`packages/client/src/gateway-client-vault.ts` to stay within the repo's
file-size cap; both re-exported via `packages/client/src/gateway-client.ts`).
`packages/vault/src/index.ts`: exports.

### Commit 3 — Part B UI: Vault Atlas screen — Kinds, Relations orrery, Browse editor

`packages/client/src/react/screens/AtlasScreen.tsx` +
`packages/client/src/react/screens/AtlasScreen.module.css` +
`packages/client/src/react/screens/AtlasScreen.test.tsx`: the three-tab
screen (Kinds / Relations / Browse) with the cross-tab `openBrowse` seam.
`packages/client/src/react/screens/AtlasKindsTab.tsx` +
`packages/client/src/react/screens/AtlasKindsTab.module.css`: census sentence,
per-pack periodic table with permanent cells and dashed ghost cards,
rows/bytes toggle, 30-day pulse sparklines with dormancy hints, collapsed
machinery shelf; kind card click lands in Browse.
`packages/client/src/react/screens/AtlasRelationsTab.tsx` +
`packages/client/src/react/screens/AtlasRelationsTab.module.css` +
`packages/client/src/react/screens/AtlasRelationsTab.test.tsx` +
`packages/client/src/react/screens/atlasOrreryGeometry.ts`: the orrery —
party-centred radial star chart with fixed per-pack bearings (re-centre
animates radius only), fill-weighted edges, dotted ghosts, self-ref curl
glyphs, the unreached island ring, relation-vocabulary chips overlaying
authored links as a separate mechanism, and a fixed side-panel readout.
`packages/client/src/react/screens/AtlasBrowseTab.tsx` +
`packages/client/src/react/screens/AtlasBrowseTab.module.css` +
`packages/client/src/react/screens/AtlasBrowseTab.test.tsx` +
`packages/client/src/react/screens/atlasBrowseData.ts`: the editor — grouped
table picker, keyset grid with Load more and sortable headers, inline row
editor with FK reference pickers and sealed chips, dependent-aware delete
confirmation with FK/poly mechanism badges, machinery unlock switch.
Shell wiring: `packages/client/src/react/shell/routes/AtlasRoute.tsx`,
`packages/client/src/react/shell/App.tsx`,
`packages/client/src/react/shell/Sidebar.tsx` (Vault Atlas under Operations),
`packages/client/src/react/shell/router.ts`,
`packages/client/src/app-shell-context.ts`.

## Out of scope

- **P8 — the People-pack table consolidation (A2.2's big refactor)**: the
  issue itself says "split into its own issue when picked up." The FTS
  blindspot half of A2.2 IS fixed here; the table-grain consolidation
  (debts→Tally, tasks→schedule, relationships→core_link) is not.
- **A4 items not acceptance-gated**: `updated_at` on every editable row,
  polymorphic column-name unification (`entity_`/`target_`/`subject_`), and
  the rrule-vs-weekday_mask recurrence split stay as documented drift; the
  poly-ref registry makes the naming drift survivable.
- **Follow-ups surfaced during the work**: `gateway/demo.ts` purge and
  `commands/merge.ts` POLY_COLUMNS should adopt the registry; domain command
  hard-deletes (locker, concepts) could clean poly refs at the command layer;
  a trash-shelf UI for `tally.restore_expense`; a UI-level test for
  `browseUpdateRow` (the journalled update path is backend-tested).
- No DDL/schema editing, bulk import/export, or SQL console in Browse (v0
  cuts per the issue).

## Decisions

- **Favorite mirror, not column removal**: the `media_media_asset.favorite`
  column stays as the Photos replica read model (#419's win) but is now a
  mirror with a single writer; the starred tag on the canonical content item
  is the cross-surface truth. Both directions asserted by postcondition.
- **Browse writes are commands**: `atlas.*` rides the §10 pipeline rather
  than raw primitives — journal, provenance, replica capture, seal sweep and
  rollback come wholesale, and a side-channel UPDATE stays impossible.
- **Tally hue derives, not reads people_profile**: the tally app's grants do
  not cover the `people` schema; reading `people.profile` there would cross
  an app-consent boundary for a display hue. Deterministic derivation from
  the party id keeps the invariant (one stored hue) without a new grant.
- **People has no in-app trash commands**: its UI exposes no content-row
  delete, so the rows get the uniform DDL pair + trash-aware reads + sweep
  purge without minting ~14 unreachable commands; Browse's generic delete
  exercises the same path.
- **A trashed expense still blocks tally group deletion**: recoverable money
  history must not be stranded by tearing out its group.
- **Circles → lists (rename, not unify)**: People's mechanism is
  classification (SKOS tags), `social_circle` is audience — #274 rules they
  stay separate mechanisms; the rename removes only the name collision.
- **Orrery FK edges are pack-neutral ink**: the wire payload carries no
  relation semantics for FK edges, and colouring them would re-invite the
  FK≠core_link conflation; colour is reserved for the authored-link overlay.
- **Directed reverse-FK hop distances server-side**: an undirected walk
  falsely bridges the locker/sync island via shared parents; the directed
  walk matches the audit's island finding.

## Verification

```bash
bun run ci                                   # format, oxlint, turbo lint, typecheck, lint:types, lint:css — exit 0
cd packages/vault && bunx vitest run         # 89 files, 798 passed | 1 skipped
cd packages/gateway && bunx vitest run       # 96 files, 712 passed | 2 skipped
cd packages/blueprints && bunx vitest run    # 30 files, 222 passed
cd packages/client && bunx vitest run        # 125 files, 966 passed
```

Key targeted proofs: `packages/vault/src/schema/poly-refs.test.ts` (registry
closure over the live schema), `packages/vault/src/gateway/duties.test.ts`
(purge cleans consent_share/enrich_embedding/sync_external_entity + non-note
annotations/attachments), `packages/vault/src/schema/atlas-census.test.ts`
(fill-based ghosts, no hardcoded counts),
`packages/vault/src/commands/atlas.test.ts` (replica change-log visibility +
owner provenance for Browse writes, sealed refusal, machinery unlock),
`packages/vault/src/commands/media.test.ts` (favorite ↔ starred tag
agreement), `packages/vault/src/commands/people.test.ts` (birthday
single-writer both directions).

## Audit

Fresh-context sub-agent verdict against the full diff and issue #441:

**Verdict: PASS** — Every Part A and Part B acceptance criterion is
implemented and backed by a test that exercises real behavior (not a stub).
All spot-checked suites are green: poly-refs closure (3), duties purge (14),
atlas-census ghost semantics (8), atlas command incl. replica-visibility (14),
browse routes (6), atlas routes (4), 3 Atlas UI suites (32), media (19),
search (19).

Per-criterion highlights (full table in the audit transcript): the registry +
generic purge duty verified in `duties.ts` with the hand-written sweeps
deleted; the closure test scans the live DDL with a `detected.length >= 10`
vacuity guard; purge regression per never-cleaned mechanism (share revoked,
embedding + sync map deleted); the favorited-photo-appears-in-starred-query
test restored (#274's acceptance test); Browse writes proven journalled by
asserting `readReplicaChanges` sees the insert and `consent_provenance`
records `agent_kind='owner'` / `prov_activity='command.atlas.insert_row'`;
the only occurrences of 122/46 in atlas code are comments forbidding
hardcoding. Scope cuts confirmed legitimate against the issue text (P8
explicitly deferred; A4 non-gated items satisfied via the registry path the
issue itself names).

Caveats recorded by the auditor:
- `last_contacted_at` is resolved by reclassification (documented
  single-writer ground fact), not derivation or a rebuild sweep — a
  defensible third reading, but asymmetric with `last_message_at`.
- The closure test's "closed by construction" guarantee depends on two
  documented allow-lists (`POLY_REF_EXCLUSIONS`, `NON_POLY_PAIRS`); future
  additions to those lists silently narrow the closure and deserve review
  scrutiny.

## Steering

Fresh-context sub-agent attestation of session `9d3ca257-3f72-41be-943a-cae898992375` against the agent-steering-accounting directive:

**Check 1 — every steering event is recorded**: **PASS** — Three steering events identified (each a user message that redirected mid-task work, per the README definition of correction). All three recorded as rows under `## Accounting` → `### Steering`: event at ordinal 78 (redirect to graph view), ordinal 469 (pivot to audit), ordinal 616 (fold into #441).

**Check 2 — no non-steering recorded**: **PASS** — Transcript screened for interrupts (`[Request interrupted by user`) and corrections (user messages that redirected agent work). Excluded: ordinary task requests (initial brainstorm, "create mockup", "file issue"), status queries ("is orrery done?"), local commands (/model, /compact, /goal), task notifications, and context-summary injections. Only three user messages met the correction criterion (re-directed in-flight work away from agent's path).

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-9d3ca257-3f7-1784304724-1 | claude-code | 9d3ca257-3f72-41be-943a-cae898992375 | #441 | claude-fable-5 | 873 | 3832075 | 84991034 | 681240 | 4514188 | 166.9627 | 873 | 3832075 | 84991034 | 681240 | fix(vault): ontology audit Part A — poly-ref registry, generic purge, silo bleed |
| claude-code-9d3ca257-3f7-1784305029-1 | claude-code | 9d3ca257-3f72-41be-943a-cae898992375 | #441 | claude-fable-5 | 12 | 28413 | 1975539 | 10167 | 38592 | 2.8392 | 885 | 3860488 | 86966573 | 691407 | fix(vault): ontology audit Part A — poly-ref registry, generic purge, silo bleed |
| claude-code-9d3ca257-3f7-1784305074-1 | claude-code | 9d3ca257-3f72-41be-943a-cae898992375 | #441 | claude-fable-5 | 2 | 1151 | 335955 | 165 | 1318 | 0.3586 | 887 | 3861639 | 87302528 | 691572 | probe (#441)Issue: #441 |
| claude-code-9d3ca257-3f7-1784311722-1 | claude-code | 9d3ca257-3f72-41be-943a-cae898992375 | #441 | claude-fable-5 | 56 | 960268 | 8614089 | 16078 | 976402 | 21.4219 | 943 | 4821907 | 95916617 | 707650 | fix(vault): ontology audit Part A — poly-ref registry, generic purge, silo bleed |
| claude-code-9d3ca257-3f7-1784311776-1 | claude-code | 9d3ca257-3f72-41be-943a-cae898992375 | #441 | claude-fable-5 | 6 | 14529 | 1031421 | 3309 | 17844 | 1.3785 | 949 | 4836436 | 96948038 | 710959 | fix(vault): audit Part A — poly-ref registry, generic purge, silo bleeds, unifor |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-9d3ca257-1784294119-1 | 9d3ca257-3f72-41be-943a-cae898992375 | #441 | correction | classifier | Redirect to add graph view of ontology relations | pending | 78 | 2026-07-17T13:15:19.184Z |
| steer-9d3ca257-1784294119-2 | 9d3ca257-3f72-41be-943a-cae898992375 | #441 | correction | classifier | Pivot to full ontology audit before filing issues | pending | 469 | 2026-07-17T14:12:11.276Z |
| steer-9d3ca257-1784294119-3 | 9d3ca257-3f72-41be-943a-cae898992375 | #441 | correction | classifier | Fold issue work into existing GitHub issue #441 | pending | 616 | 2026-07-17T14:39:25.045Z |
