# Issue #274 — ontology: one judgment, one mechanism

## Checklist

The issue is a decision rule plus five kinks, sequenced into phases. All five landed.

- [x] Kink 1 — starred is one flags-scheme tag, decision rule codified in the ontology doc
- [x] Kink 4 — employment is a works-for link, not card columns
- [x] Kink 3 — one collection mechanism: album and notebook unified
- [x] Kink 2 — owner memos become annotations on the canonical entity
- [x] Kink 5 — uniform trash: the deleted_at + purge_at pair adopted where touched
- [x] Acceptance moments — the healed-silo star and a Paris trip collection holding a photo and a note

## What changed

**The decision rule (codified in `duaility-ontology.html`).** New principle **P5** ("Entity-scoped meaning joins, surface-scoped state rides") and hard rule **10** ("One judgment, one mechanism"): an owner judgment *about an entity* lives in a universal join (`core.tag` / `knowledge.annotation` / `core.link`) keyed to the canonical row; surface-scoped state (pinned, position, cover) rides the domain row; a flag never mints a column, a row or a table.

**Kink 1 — starred is one flags-scheme tag, decision rule codified in the ontology doc** (`feat(vault): starred is one flags-scheme tag`, `feat(blueprints): the healed-silo star`).
- `packages/vault/src/commands/flags.ts` (new): flags scheme `https://centraid.dev/schemes/flags` bootstrapped on first use like folders; the `starred` concept carries SKOS altLabel `"Favorite"`. `setStarred` (delete-then-insert, idempotent, keeps `tagged_by`/`tagged_at` provenance a boolean discards) and `starredExistsSql` (the `https://` URI dodges the colon-literal condition-SQL trap).
- `social.update_card` and `media.update_asset` keep their `favorite` inputs; storage is a starred tag on the **canonical** entity (`core.party` / `core.content_item`, not the asset row). New `core.star_document` / `core.unstar_document` in the documents pack. Dropped `social_contact_card.favorite` + `media_media_asset.favorite`.
- Docs' honest-empty Starred section goes live with a real count, star indicators, a details toggle and a menu item. People + Photos decorate `favorite` from the tag (+`core.tag`/`concept`/`concept_scheme` read scopes). The healed-silo moment: favorite a photo in Photos and the same `content_item` reads as starred in Docs.

**Adjacent fix (`fix(vault): lifecycle purge drops tags`).** The purge sweep end-dated links onto a purged row but left `core_tag` rows (folder filings, stars) dangling. Tags are classification, not history — they now delete with the row. (Later extended to `core_collection_entry` in the collections commit.)

**Kink 4 — employment is a works-for link, not card columns** (`refactor(vault): employment is a works-for link`). `contact_card` carried `related_org_party_id` despite the social boundary text saying employment is a core.link. The claim now rides `core.link_entities` with the seeded `works-for` relation; the card keeps `org_title` as a display label only, and `update_card` finally accepts it. Dropped `related_org_party_id`.

**Kink 3 — one collection mechanism: album and notebook unified** (`feat(vault): one collection mechanism`). `media.album` and `knowledge.notebook` were the same shape forked by member type. Both dissolve into `core.collection` + `core.collection_entry` — owner-curated, ordered, optionally nested, members as gateway-validated `(target_type, target_id)` refs. The album and notebook commands keep their exact contracts as surface views; a collection may mix types ("Paris trip" = photo + lease PDF + packing note). Covers are content ids. Dropped `media_album`, `media_album_entry`, `knowledge_notebook`, `knowledge_note_placement`. `core.collection_entry` joined the polymorphic-ref rules; the card resolver + kit picker swap `knowledge.notebook` → `core.collection`. Photos/notes queries read the new tables, app row shapes unchanged. **Circles (audience) and folders (classification) deliberately stay separate** — they pass the same "means the same everywhere" test differently.

**Kink 2 — owner memos become annotations on the canonical entity** (`refactor(vault): owner memos are annotations`). `contact_card.note` and `core.activity.note` carried the gesture `knowledge.annotation` already models (its own example is "a note about a transaction"). Both migrate to memo annotations on the canonical entity. `packages/vault/src/commands/annotations.ts` (new): `annotate` (append) + `replaceMemo` (one memo per author per entity, empty clears — the running-card-note semantic). FTS drops `contact_card.note` and indexes `knowledge.annotation.body_text`, so people search still finds "wedding" via the memo's target party. Dropped `social_contact_card.note` + `core_activity.note`. **`txn_split.memo` deliberately kept** — it describes the split row itself, not an entity.

**Kink 5 — uniform trash: the deleted_at + purge_at pair adopted where touched** (`feat(vault): uniform trash`). `deleted_at` + `purge_at` is now the codified soft-delete convention. `media_media_asset` gains `purge_at` with the standard CHECK; delete stamps it, restore/re-upload clear it. The lifecycle sweep purges a lapsed trashed asset on the asset's own clock even while its bytes stay rented elsewhere (asset meaning and byte custody have independent lifecycles); `SweepResult` reports `assetsPurged`. Photos' trash shelf derives its countdown from the asset's own `purge_at`.

## Out of scope

- **Notes and cards remain hard-delete.** The issue calls uniform trash a convention adopted "opportunistically / as tables are touched." Assets were the concrete gap (bare `deleted_at`, no grace); notes/cards were not otherwise in play, so they keep their current lifecycle for a future touch.
- **Annotation lifecycle (`status open→resolved`) untouched.** The issue flags an *actionable* annotation could link to a `schedule.task` instead of growing its own status; left as the noted seam.
- **Circles and folders unchanged** — deliberate: audience and classification are different mechanisms that pass the decision rule on their own terms.
- **No data migration.** v0 pre-release: every phase drops/renames columns in-place; dev vaults recreate. This is precisely the cheap window the issue calls out.

## Decisions

- **`flags.ts` / `annotations.ts` are shared mechanism, not command packs.** They are the helpers the domain packs write through (the way `knowledge.ts` already borrows `releaseContentIfUnreferenced` from `media.ts`), so no new registered command surface beyond `star_document`/`unstar_document` (which the drive genuinely needs as owner-invocable verbs).
- **Contracts stay per-domain and consent-legible; only storage unifies.** `update_card` keeps `favorite`/`note`/`org_title`; `update_asset` keeps `favorite`; album/notebook commands keep their names and shapes. Apps and grants read as before — the healing is under the contract, not across it.
- **Covers are content ids, not asset ids.** A `core.collection` cover points at canonical bytes (`cover_content_id`), so a mixed collection's cover isn't tied to the media domain.
- **`delete_album` refuses nested collections.** The album surface only manages flat collections; a nested one came from the notebook surface and keeps its children until they move — mirroring `delete_notebook`.
- **Purge drops `core_tag` and `core_collection_entry`, NULLs `core_collection.cover_content_id`.** Classification and curation on a gone row are noise; the FK on cover would otherwise refuse the content delete. Links stay temporal (end-dated), provenance stays in the journal.

## Verification

- `packages/vault`: `bun run test` → **202 passed**; `bun run typecheck` clean. New/changed tests cover: starred as a single provenance-carrying tag across party/content/document with trash-survives-restore; employment as a `works-for` link with the card holding only a label; a mixed "Paris trip" collection holding a photo and a note in one ordered list; the running memo replacing on edit and clearing on empty, plus the activity memo landing on `core.activity`; a lapsed asset purging on its own clock while rented bytes live on; and the purge sweep dropping tags/entries.
- `packages/blueprints`: `bun run build:manifest` (regenerated) + `bun run test` → **94 passed**.
- `packages/gateway`: `bun run test` → **141 passed / 1 skipped** (portability enumerates tables from `VAULT_TABLES`, so the new/dropped tables flow through export automatically).
- Full workspace `bun run test` → **21/21 tasks successful**.
- Acceptance moments — the healed-silo star and a Paris trip collection holding a photo and a note are both covered by tests: `update_asset toggles favorite as a starred tag on the canonical content item` (a photo favorited in Photos reads as starred in Docs, same flags-scheme tag) and `one collection holds a photo and a note together`.

Re-runnable from the repo root:

```sh
( cd packages/vault && bun run test && bun run typecheck )
( cd packages/blueprints && bun run build:manifest && bun run test )
( cd packages/gateway && bun run test )
bun run test   # whole workspace: 21/21 tasks
```

## Files touched

Vault engine (shared helpers, commands, schema, gateway):
- `packages/vault/src/commands/flags.ts` (new), `packages/vault/src/commands/annotations.ts` (new) — shared mechanism helpers
- `packages/vault/src/commands/documents.ts`, `packages/vault/src/commands/documents.test.ts` — star/unstar document commands
- `packages/vault/src/commands/social.ts`, `packages/vault/src/commands/social.test.ts` — card favorite→tag, note→annotation, org_title label, employment via link
- `packages/vault/src/commands/media.ts`, `packages/vault/src/commands/media.test.ts` — asset favorite→tag, albums over collections, asset purge_at pair
- `packages/vault/src/commands/knowledge.ts`, `packages/vault/src/commands/knowledge.test.ts` — notebooks/placement over collections
- `packages/vault/src/commands/health.ts`, `packages/vault/src/commands/business.ts`, `packages/vault/src/commands/business.test.ts` — activity note→annotation
- `packages/vault/src/schema/core.ts` — core_collection + core_collection_entry, activity note dropped
- `packages/vault/src/schema/domains-social-knowledge-media.ts` — favorite/note/related_org dropped, album/notebook/placement dropped, asset purge_at added
- `packages/vault/src/schema/tables.ts` — logical registry (collection tables in, notebook/placement/album out)
- `packages/vault/src/schema/fts.ts` — contact_card.note dropped, knowledge.annotation indexed
- `packages/vault/src/gateway/execution.ts` — collection_entry joins polymorphic-ref rules
- `packages/vault/src/gateway/duties.ts`, `packages/vault/src/gateway/gateway.test.ts` — purge drops tags/entries, NULLs covers, sweeps lapsed assets
- `packages/vault/src/gateway/cards.ts` — notebook card → collection card
- `packages/vault/src/index.ts` — flags exports

Blueprint apps:
- `packages/blueprints/apps/docs/actions/star.js` (new), `packages/blueprints/apps/docs/actions/unstar.js` (new), `packages/blueprints/apps/docs/app.json`, `packages/blueprints/apps/docs/app.js`, `packages/blueprints/apps/docs/app.css`, `packages/blueprints/apps/docs/queries/drive.js`, `packages/blueprints/apps/docs/queries/search.js`
- `packages/blueprints/apps/people/app.json`, `packages/blueprints/apps/people/app.js`, `packages/blueprints/apps/people/queries/directory.js`, `packages/blueprints/apps/people/queries/search.js`
- `packages/blueprints/apps/photos/app.json`, `packages/blueprints/apps/photos/queries/library.js`
- `packages/blueprints/apps/notes/app.json`, `packages/blueprints/apps/notes/queries/library.js`, `packages/blueprints/apps/notes/queries/search.js`
- `packages/blueprints/kit/kit.js` (picker label), `packages/blueprints/manifest.json` (regenerated)

Design doc: `duaility-ontology.html` (P5 + rule 10, table/section edits).

## Steering

**PASS** — Transcript scanned; one genuine steering event identified and recorded as ledger row. An interrupt marker at ordinal 655 (2026-07-04T14:12:52.942Z) cut short an ongoing assistant turn, followed immediately by a user `/model` switch to claude-opus-4-8 and resume. This qualifies as a structural interrupt (runtime-emitted sentinel), properly recorded in the ledger below with tier `structural` and no user-reason field. No non-steering messages were mis-recorded.

## Audit

### Audit 1: `## What changed` faithfully describes the diff
**PASS** — The receipt accurately captures all material changes. Five kinks are each traced to specific files: (1) Kink 1 adds `packages/vault/src/commands/flags.ts` (new), stars `core.star_document`/`unstar_document` in documents pack, rewires social/media/docs apps; verified in diff. (2) Kink 4 migrates employment from `contact_card.related_org_party_id` to `core.link_entities` with relation concept, keeps `org_title` as label only; verified in `commands/social.ts` diff. (3) Kink 3 replaces `media_album`/`knowledge_notebook` with `core_collection`+`core_collection_entry`; verified dropped in `schema/domains-social-knowledge-media.ts`, created in `schema/core.ts`. (4) Kink 2 adds `commands/annotations.ts` (new), migrates `contact_card.note` and `activity.note` to annotations on canonical entity; verified in social.ts/business.ts diffs. (5) Kink 5 adds `purge_at` CHECK to `media_media_asset`, activates lifecycle sweep; verified in `schema/domains-social-knowledge-media.ts`. Adjacent fix (purge drops dangling tags) verified in `gateway/duties.ts`. The decision rule (P5 + rule 10) is added to `duaility-ontology.html` with exact principle language. No material change is omitted.

### Audit 2: Each checked `[x]` item is realized in the diff
**PASS** — All six checklist items are realized: (1) Kink 1 ✓ (flags scheme, starred concept with SKOS altLabel "Favorite", `setStarred` idempotent, storage on canonical row, Docs Starred live, healed-silo star). (2) Kink 4 ✓ (employment as works-for link, card holds org_title label only, updated `social.update_card`). (3) Kink 3 ✓ (album and notebook dissolve, `core.collection` with ordered typed entries, mixed collections like "Paris trip", covers as content ids). (4) Kink 2 ✓ (memos become annotations, `contact_card.note` and `activity.note` migrate, `replaceMemo` per-author-per-entity, txn_split.memo deliberately kept). (5) Kink 5 ✓ (uniform trash: `deleted_at`+`purge_at` adopted on media_asset with CHECK, lifecycle sweep purges lapsed assets). (6) Acceptance moments ✓ (healed-silo star verified via tag unification; "Paris trip" collection holding photo+note testable in schema and commands).

### Audit 3: The `## Checklist` mirrors issue #274's scope
**PASS** — The receipt's six checklist items directly map to issue #274's declared scope: the five kinks (1, 4, 3, 2, 5) and the acceptance moments. The decision rule (P5 + "One judgment, one mechanism") is the governing principle stated in the issue and confirmed added to the ontology. The "Out of scope" section correctly mirrors the issue's own deferrals (notes/cards hard-delete, annotation.status untouched, circles/folders unchanged, no data migration). Phases are sequenced as promised (starred + decision rule first, then employment, then collections, then memos, then trash opportunistically).

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-cca13a7e-cb0-1783172429-1 | claude-code | cca13a7e-cb04-4d81-bf16-26c5ea4ed20e | #274 | claude-fable-5 | 93516 | 1080098 | 17152913 | 129235 | 1302849 | 38.0510 | 93516 | 1080098 | 17152913 | 129235 | feat(vault): starred is one flags-scheme tag, not three favorite columns (#274)O |
| claude-code-cca13a7e-cb0-1783172898-1 | claude-code | cca13a7e-cb04-4d81-bf16-26c5ea4ed20e | #274 | claude-fable-5 | 6134 | 210162 | 21483441 | 93800 | 310096 | 28.8618 | 99650 | 1290260 | 38636354 | 223035 | feat(blueprints): the healed-silo star — Docs Starred goes live, People/Photos r |
| claude-code-cca13a7e-cb0-1783172996-1 | claude-code | cca13a7e-cb04-4d81-bf16-26c5ea4ed20e | #274 | claude-fable-5 | 4206 | 16015 | 4151138 | 8019 | 28240 | 4.7943 | 103856 | 1306275 | 42787492 | 231054 | fix(vault): lifecycle purge drops tags on purged rows instead of dangling (#274) |
| claude-code-cca13a7e-cb0-1783173097-1 | claude-code | cca13a7e-cb04-4d81-bf16-26c5ea4ed20e | #274 | claude-fable-5 | 8984 | 19514 | 3978367 | 19074 | 47572 | 5.2658 | 112840 | 1325789 | 46765859 | 250128 | refactor(vault): employment is a works-for link, not card columns (#274)The soci |
| claude-code-cca13a7e-cb0-1783173146-1 | claude-code | cca13a7e-cb04-4d81-bf16-26c5ea4ed20e | #274 | claude-fable-5 | 382 | 16120 | 1455670 | 2296 | 18798 | 1.7758 | 113222 | 1341909 | 48221529 | 252424 | refactor(vault): employment is a works-for link, not card columns (#274)The soci |
| claude-code-cca13a7e-cb0-1783173876-1 | claude-code | cca13a7e-cb04-4d81-bf16-26c5ea4ed20e | #274 | claude-fable-5 | 21659 | 149141 | 27118300 | 103556 | 274356 | 34.3770 | 134881 | 1491050 | 75339829 | 355980 | feat(vault): one collection mechanism — album and notebook were the same table t |
| claude-code-cca13a7e-cb0-1783174140-1 | claude-code | cca13a7e-cb04-4d81-bf16-26c5ea4ed20e | #274 | claude-fable-5 | 31944 | 58713 | 9288336 | 26908 | 117565 | 11.6871 | 166825 | 1549763 | 84628165 | 382888 | refactor(vault): owner memos are annotations, not prose columns (#274)knowledge. |
| claude-code-cca13a7e-cb0-1783174291-1 | claude-code | cca13a7e-cb04-4d81-bf16-26c5ea4ed20e | #274 | claude-fable-5 | 11552 | 24744 | 5350495 | 26037 | 62333 | 7.0772 | 178377 | 1574507 | 89978660 | 408925 | feat(vault): uniform trash — the soft-delete pair becomes the convention (#274)p |
| claude-code-cca13a7e-cb0-1783174490-1 | claude-code | cca13a7e-cb04-4d81-bf16-26c5ea4ed20e | #274 | claude-opus-4-8 | 1912 | 1487227 | 9313256 | 17225 | 1506364 | 14.3920 | 180289 | 3061734 | 99291916 | 426150 | docs(receipts): narrative for the #274 ontology unification (#274)Checklist, per |
| claude-code-cca13a7e-cb0-1783174826-1 | claude-code | cca13a7e-cb04-4d81-bf16-26c5ea4ed20e | #274 | claude-opus-4-8 | 8486 | 75702 | 14793404 | 30092 | 114280 | 8.6646 | 188775 | 3137436 | 114085320 | 456242 | docs(receipts): narrative + attestations for the #274 ontology unification (#274 |
| claude-code-cca13a7e-cb0-1783174976-1 | claude-code | cca13a7e-cb04-4d81-bf16-26c5ea4ed20e | #274 | claude-opus-4-8 | 1522 | 36054 | 9181760 | 18568 | 56144 | 5.2880 | 190297 | 3173490 | 123267080 | 474810 | docs(receipts): narrative + attestations for the #274 ontology unification (#274 |
| claude-code-cca13a7e-cb0-1783175033-1 | claude-code | cca13a7e-cb04-4d81-bf16-26c5ea4ed20e | #274 | claude-opus-4-8 | 9721 | 18671 | 2680730 | 7912 | 36304 | 1.7035 | 200018 | 3192161 | 125947810 | 482722 | docs(receipts): narrative + attestations for the #274 ontology unification (#274 |
| claude-code-cca13a7e-cb0-1783175911-1 | claude-code | cca13a7e-cb04-4d81-bf16-26c5ea4ed20e | #274 | claude-opus-4-8 | 8806 | 17485 | 11058766 | 6614 | 32905 | 5.8480 | 208824 | 3209646 | 137006576 | 489336 | style(vault): oxfmt the #274 files edited out-of-band (#274)Five vault files wer |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-cca13a7ecb04-1783174372-1 | cca13a7e-cb04-4d81-bf16-26c5ea4ed20e | #274 | interrupt | structural |  | 9907f65 | 655 | 2026-07-04T14:12:52.942Z |
