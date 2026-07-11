# Issue #352 — Photos/Docs feature parity: document wrapper + revises lineage, surfacing built pipelines

https://github.com/srikanth235/centraid/issues/352

## Checklist

- [x] document wrapper entity and revises lineage
- [ ] docs app on the wrapper with editing and version history
- [x] photos search exif slideshow duplicates
- [ ] vault plumbing geo tags activity sync faces
- [ ] photos wave-3 ui
- [ ] docs wave-3 ui

## Decisions

- An entity whose bytes can change wraps a content item; it never IS one. `core_content_item` stays immutable-by-address.
- Version lineage is a `revises` `core.link` between successive content items — the same machinery merges use for `same-as`; no bespoke revision table.
- Superseded bodies are durable facts: kept while their document lives, purged with it; never silently orphaned.
- Sharing/collaboration deliberately out of scope (no vault signal).

## What changed

### document wrapper entity and revises lineage

Documents get identity separate from their bytes: new `core_document` table wrapping `core_content_item` (`current_content_id` FK, not unique — sha256 dedupe means two documents may share bytes), full trash/purge lifecycle on the document row, and a walkable `revises` version chain recorded as `core.link` rows between successive content items. `knowledge.edit_note` records the same `revises` link, healing the notes/docs divergence. ONTOLOGY_VERSION 1.2 → 1.3; pre-release v0, no migrations, dev vaults recreate.

- `packages/vault/src/schema/core.ts` — `core_document` DDL
- `packages/vault/src/schema/tables.ts` — `core.document` registered
- `packages/vault/src/schema/migrate.ts`, `packages/vault/src/schema/migrate.test.ts` — version bump
- `packages/vault/src/schema/fts.ts` — docs FTS retargeted to `core.document`
- `packages/vault/src/schema/blob.ts` — derivative FTS trigger fans out to documents over a content id
- `packages/vault/src/bootstrap.ts` — `revises` seeded into the relations scheme
- `packages/vault/src/commands/documents.ts` — pack rewritten onto the wrapper; new `core.edit_document`, `core.replace_document_content`, `core.restore_document_version`
- `packages/vault/src/commands/revisions.ts` — shared recordRevision/revisesConceptId helper (new)
- `packages/vault/src/commands/knowledge.ts` — editNote records revises
- `packages/vault/src/commands/media.ts` — `core_document.current_content_id` joins CONTENT_REFERENCES rentals
- `packages/vault/src/commands/links.ts` — RELATIONS_SCHEME_URI_SQL export
- `packages/vault/src/gateway/duties.ts` — lapsedDocuments purge pass; seen-set BFS chain walk (a restore can cycle the revises graph — real bug caught in test)
- `packages/vault/src/gateway/cards.ts` — core.document card
- `packages/vault/src/gateway/assistant-context.ts` — wrapper contract note
- `packages/vault/src/blob/read.ts` — byte-serving covers the whole revises chain (recursive CTE)
- `packages/gateway/src/serve/vault-plane.ts` — sweep log includes documentsPurged
- `scripts/docs-site/src/content/ontology-body.html` — document contract added, knowledge state line updated, v1.3
- Tests: `packages/vault/src/commands/documents.test.ts`, `packages/vault/src/commands/knowledge.test.ts`, `packages/vault/src/gateway/duties.test.ts`, `packages/vault/src/blob/flow.test.ts`, `packages/vault/src/enrich/enrich.test.ts`

### photos search exif slideshow duplicates

Server-side FTS search replaces the client-window filter; EXIF details panel in the lightbox; full-screen slideshow (4s auto-advance, Space pause, Esc exits, videos skipped); near-duplicates review shelf (exact-sha + same-dimensions/byte-size approximation — `media_asset_phash`/`vault_hamming` are not reachable from app-plane queries yet; real clustering lands with the plumbing phase).

- New: `packages/blueprints/apps/photos/queries/search.js`, `packages/blueprints/apps/photos/queries/duplicates.js`, `packages/blueprints/apps/photos/search.js`, `packages/blueprints/apps/photos/slideshow.jsx`, `packages/blueprints/apps/photos/duplicates.jsx`, `packages/blueprints/apps/photos/lightbox.jsx`, `packages/blueprints/apps/photos/visibility.js`, `packages/blueprints/apps/photos/duplicates-actions.js`, `packages/blueprints/apps/photos/components/Slideshow.jsx`, `packages/blueprints/apps/photos/components/Duplicates.jsx`
- Modified: `packages/blueprints/apps/photos/app.jsx`, `packages/blueprints/apps/photos/app.json`, `packages/blueprints/apps/photos/app.css`, `packages/blueprints/apps/photos/index.html`, `packages/blueprints/apps/photos/constants.js`, `packages/blueprints/apps/photos/format.js`, `packages/blueprints/apps/photos/toolbar.jsx`, `packages/blueprints/apps/photos/components/Chips.jsx`, `packages/blueprints/apps/photos/components/Lightbox.jsx`, `packages/blueprints/manifest.json` (regenerated)
- Two bugs found in browser verification and fixed: `toLocaleString` weekday+dateStyle combination throws (crashed the lightbox React root); slideshow toolbar button cascade tie with late-loading kit.css needed a compound selector.

## Out of scope

Sharing, collaboration, comments. On-device face detection models. Smart albums / memories / scene recognition. Data migrations (pre-release v0: dev vaults recreate; ONTOLOGY_VERSION equality-enforced).

## Verification

document wrapper entity and revises lineage — vault suite green after the rewrite; the restore-cycle hang was reproduced and fixed (UNION-dedup recursive CTE + seen-set BFS):

```
packages/vault:  bunx vitest run  → 426/426 passed (41 files)
packages/vault:  tsc (tsconfig.json + tsconfig.test.json) → clean
packages/gateway: tsc → clean; vitest → 166 passed, 1 skipped, 0 failed
                  (22 test files fail to LOAD from pre-existing unbuilt sibling dists in this
                   cold worktree — confirmed identical without these changes)
bunx oxlint <22 changed .ts files> → 0 warnings, 0 errors
```

photos search exif slideshow duplicates — lint + transpile + live-browser harness pass:

```
node packages/blueprints/scripts/lint-apps.mjs → 0 problems (135 files)
esbuild --loader:.jsx=jsx on 16 new/changed files → no syntax errors
visual harness (bun packages/blueprints/visual-harness/server.mjs):
  search merge, duplicates empty state, lightbox Details, slideshow
  pause/resume/Esc, ?denied=1, ?empty=1, dark theme, 375px — all clean,
  no console errors
```

## Audit

(attested before final commit)

## Steering

(attested before final commit)
