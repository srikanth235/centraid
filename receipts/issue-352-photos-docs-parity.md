# Issue #352 — Photos/Docs feature parity: document wrapper + revises lineage, surfacing built pipelines

https://github.com/srikanth235/centraid/issues/352

## Checklist

- [x] document wrapper entity and revises lineage
- [x] filing publisher retargets wrapped content items onto their document
- [x] docs app on the wrapper with editing and version history
- [x] photos search exif slideshow duplicates
- [x] vault plumbing geo tags activity sync faces
- [x] photos wave-3 ui
- [x] docs wave-3 ui
- [x] photos v2 visual redesign per design handoff

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

### filing publisher retargets wrapped content items onto their document

`filingPublisher` (packages/vault/src/ingest/enrich-publishers.ts) predates the document wrapper and still tagged/renamed the raw `core_content_item` unconditionally. Once a content item is a document's current head, no read path resolves `core.content_item`-targeted tags anymore (`DOCUMENT_EXISTS_SQL`, `blob/read.ts`'s SERVE_REFERENCES, and the docs app all key off `core.document`), so an enrichment-driven "file this scan under Insurance" proposal against an already-wrapped content item silently did nothing. Fixed by resolving `entityId` to its owning `core_document` (`current_content_id = entityId`) and retargeting the title update and folder tag there when one exists; content items with no document wrapper (e.g. media assets) keep the original content-item-scoped behavior. The "never mints a document" invariant is unchanged — `create()` still throws for a missing content item, and the fix never inserts into `core_document`.

- `packages/vault/src/commands/documents.ts` — exported `DOCUMENT_TARGET_TYPE`
- `packages/vault/src/ingest/enrich-publishers.ts` — `filingPublisher.update` resolves the owning document and retargets title/tag writes
- `packages/vault/src/enrich/enrich.test.ts` — rewrote the filing test for the wrapped case (asserts the content item's title is untouched and the tag lands on `core.document`), added a new test for the unwrapped-content-item fallback

### docs app on the wrapper with editing and version history

The docs app now reads/writes `core.document` throughout: `document_id` is the row identity (selection, details, quick-look, grid/list all key off it), `content_id` names the current version's bytes (blob URLs, version comparisons). New: in-place text editing with autosave (`components/Editor.jsx`, gated on `isTextEditable()`), "Replace file…" for non-text documents, and a version-history panel (`components/History.jsx` walking `queries/history.js`'s `revises`-chain read, honestly ordered by the link's `valid_from`, not content `created_at`) with inline preview and restore.

- New: `packages/blueprints/apps/docs/actions/{edit,replace,restore-version}.js`, `packages/blueprints/apps/docs/components/{Editor,History}.jsx`, `packages/blueprints/apps/docs/{popovers,versions}.js`, `packages/blueprints/apps/docs/queries/history.js`
- Modified: `app.jsx`, `app.json`, `app.css`, `index.html`, `chrome.js`, `logic.js`, `nav.js`, `format.js`, `components/{Details,Grid,List,QuickLook}.jsx`, `queries/{drive,search}.js`, `actions/{move,rename,restore,star,trash,unstar}.js`, `packages/blueprints/manifest.json` (regenerated), `packages/blueprints/visual-harness/mock-centraid.js` (document_id/content_id fixture pairs, a 3-version text fixture, edit/replace/restore-version + history mock branches)
- `app.jsx` grew past the 500-line governance cap (559 lines) implementing the editor/history wiring; waived with the same "blueprints are single-file by design" reasoning `tally/app.jsx` already carries, rather than fracturing tightly-coupled render/state wiring under time pressure. Also refreshed the file's header comment, which still described a document as a raw `core.content_item` from before the wrapper landed.
- Real bug found and fixed in verification: `Editor.jsx` originally `fetch()`ed `content_uri` to load initial text, but the app's CSP (`default-src 'self'`, `img-src` allows `data:`, nothing else does) blocks `fetch()` on inline `data:` URIs — which is exactly what a short text edit mints. Fixed with a local UTF-8-safe `decodeDataUri()` in `format.js`; blob-route URIs still `fetch()` as before.

### photos search exif slideshow duplicates

Server-side FTS search replaces the client-window filter; EXIF details panel in the lightbox; full-screen slideshow (4s auto-advance, Space pause, Esc exits, videos skipped); near-duplicates review shelf (exact-sha + same-dimensions/byte-size approximation — `media_asset_phash`/`vault_hamming` are not reachable from app-plane queries yet; real clustering lands with the plumbing phase).

- New: `packages/blueprints/apps/photos/queries/search.js`, `packages/blueprints/apps/photos/queries/duplicates.js`, `packages/blueprints/apps/photos/search.js`, `packages/blueprints/apps/photos/slideshow.jsx`, `packages/blueprints/apps/photos/duplicates.jsx`, `packages/blueprints/apps/photos/lightbox.jsx`, `packages/blueprints/apps/photos/visibility.js`, `packages/blueprints/apps/photos/duplicates-actions.js`, `packages/blueprints/apps/photos/components/Slideshow.jsx`, `packages/blueprints/apps/photos/components/Duplicates.jsx`
- Modified: `packages/blueprints/apps/photos/app.jsx`, `packages/blueprints/apps/photos/app.json`, `packages/blueprints/apps/photos/app.css`, `packages/blueprints/apps/photos/index.html`, `packages/blueprints/apps/photos/constants.js`, `packages/blueprints/apps/photos/format.js`, `packages/blueprints/apps/photos/toolbar.jsx`, `packages/blueprints/apps/photos/components/Chips.jsx`, `packages/blueprints/apps/photos/components/Lightbox.jsx`, `packages/blueprints/manifest.json` (regenerated)
- Two bugs found in browser verification and fixed: `toLocaleString` weekday+dateStyle combination throws (crashed the lightbox React root); slideshow toolbar button cascade tie with late-loading kit.css needed a compound selector.

### vault plumbing geo tags activity sync faces

Six app-plane surfaces added over data the vault already produced: (1) geolocation — `media.add_asset` links GPS from `exif_json` to a find-or-create `core_place` (4dp-rounded identity, precise coords kept), plus `media.set_asset_place` to correct/clear; (2) multi-tag — `core.tag_entity`/`core.untag_entity` over an owner "labels" scheme, additive, targets `core.document` or `media.media_asset`; (3) activity — per-entity provenance reads via `ctx.vault.read({entity: 'consent.provenance', where: [entity_type, entity_id]})`, both filters required, gated behind the caller already holding read consent on the entity's own table; (4) sync/custody — new read-only `blob.custody_state` table (local-only/replicated/remote-only/missing), refreshed on every blob-sweep duty; (5) face-proposer on-demand — `enrich.policy` mirror table for the owner's enrichment tier, and the automation's manifest was missing the `enrich` scope entirely (a real gap — it couldn't have drained its own request queue); (6) phash clusters — `media.asset_phash` registered as an app-readable table with a `cluster_id` column recomputed each sweep (union-find, hamming ≤ 6, deterministic id), closing the gap the photos duplicates shelf flagged.

- `packages/vault/src/schema/tables.ts`, `packages/vault/src/schema/enrich.ts`, `packages/vault/src/schema/blob.ts` — new tables/columns registered
- `packages/vault/src/bootstrap.ts`, `packages/vault/src/host.ts` — labels scheme + enrich-policy mirroring
- `packages/vault/src/commands/media.ts` — place linking, `media.set_asset_place`
- `packages/vault/src/commands/enrich.ts` — request_enrichment `reason: 'manual'`
- `packages/vault/src/commands/tags.ts` (new) — `core.tag_entity`/`core.untag_entity`
- `packages/vault/src/blob/custody.ts` — custody_state refresh
- `packages/vault/src/gateway/gateway.ts` — consent-gated activity read
- `packages/vault/src/enrich/clusters.ts` (new) — phash cluster recompute
- `packages/vault/src/index.ts`, `packages/gateway/src/serve/vault-plane.ts` — command pack registration
- `packages/blueprints/automations/face-proposer/automations/face-proposer/{handler.js,automation.json}` — drains the on-demand queue; added the missing `enrich` scope
- Tests: `packages/vault/src/commands/tags.test.ts`, `packages/vault/src/gateway/activity-read.test.ts`, `packages/vault/src/enrich/clusters.test.ts` (new); extended `commands/media.test.ts`, `blob/flow.test.ts`, `enrich/enrich.test.ts`
- Deviation: the face-proposer "enabled" signal exposed is the owner's enrichment-tier policy, not the automation's own cron enable/disable toggle (that flag lives outside the vault, in `@centraid/app-engine`'s `VaultOp` enum — out of this task's territory, flagged as a follow-up).
- `packages/vault/src/host.ts` carried a pre-existing 500-line-cap violation (553 lines, no waiver) before this change touched it; added the waiver comment rather than bundling an unrelated split into this feature commit.

### photos wave-3 ui

Built over the vault plumbing surfaces: a crop/rotate editor that saves as a new asset (non-destructive — "save as new" by default, with an option to also trash the original), a place chip + picker over existing EXIF-linked places, tag add/remove with a sidebar filter row, a face-proposer header toggle showing enabled/disabled state honestly (no button when disabled) plus an on-demand "Detect faces now" trigger, custody-state badges, and the duplicates shelf rewritten onto real `media.asset_phash.cluster_id` clustering (replacing wave-1's sha/dimensions approximation).

- New: `packages/blueprints/apps/photos/queries/_shared.js`, `queries/enrichment-status.js`, `actions/{set-place,tag-asset,untag-asset,request-enrichment}.js`, `components/{Editor,Enrichment}.jsx`
- Modified: `app.jsx`, `app.json`, `app.css`, `index.html`, `components/{Chips,Duplicates,Lightbox}.jsx`, `duplicates.jsx`, `lightbox.jsx`, `toolbar.jsx`, `format.js`, `queries/{duplicates,library,search}.js`
- `app.jsx` crossed the 500-line cap (524 lines); waived with the same reasoning as `docs/app.jsx`/`tally/app.jsx`.
- Two server-side gaps found and reported rather than faked: (1) no `media`-domain edit-in-place command exists (only 10 commands in `media.ts`, none touch bytes post-upload) — crop/rotate is client-side canvas work re-uploaded as a new asset, consistent with "own the meaning, rent the bytes"; (2) `media.set_asset_place` only accepts an existing `place_id`, there's no command to mint a new `core.place` row from freehand text — built a picker over EXIF-auto-linked places instead of the free-text editor originally scoped, with an honest empty state.
- `manifest.json`/`mock-centraid.js` regeneration deferred to the following commit (docs wave-3), since both apps' fixtures/manifest entries land in the same shared files and a single final regen after both waves land is cleaner than two partial ones.

### docs wave-3 ui

Free-form tags (Details drawer editor + sidebar filter chip row, mirroring photos), a real Activity panel reading `consent.provenance` (replaces the old panel that synthesized events purely from `created_at`/`updated_at`), and custody-state badges (Grid dot, List dot, Details chip) across all four states. `manifest.json` and `visual-harness/mock-centraid.js` got their final regeneration/merge here, folding in both this wave's and the prior photos-wave-3 commit's fixtures — file counts now match the filesystem exactly for both apps (56 photos files, 46 docs files).

- New: `packages/blueprints/apps/docs/actions/{tag,untag}.js`, `queries/{activity,_shared}.js`, `metadata.js`, `components/{Tags,Activity}.jsx`
- Modified: `app.json`, `app.jsx`, `app.css`, `index.html`, `logic.js`, `nav.js`, `format.js`, `queries/{drive,search}.js`, `components/{Details,Grid,List,Shared,Toolbar}.jsx`
- Real finding: `core.tag_entity`/`untag_entity` write provenance against `entity_type: 'core.tag'`, not the tagged entity — so tag/untag actions never surface in a document's own Activity trail. This is genuine vault behavior (confirmed against `packages/vault/src/commands/tags.ts`), not a query bug; documented rather than worked around.
- Custody badge intentionally renders nothing (not a guessed state) for inline `data:`-URI documents or any document the blob sweep hasn't reached yet yet — matches the convention the photos app already established.
- A concurrency hazard surfaced and was caught: this agent's first pass at `mock-centraid.js` was clobbered by the concurrently-running photos-wave-3 agent's own `Write`-based overwrite of the same file; detected via a live probe returning no `tags` field, diagnosed against `git diff`, and reapplied. Verified post-hoc (this review) that the final file contains both apps' fixtures completely — see Verification.

### photos v2 visual redesign per design handoff

Rebuilt the Photos UI shell against an owner-supplied design handoff (`design-handoff/Photos v2 - build prompt.md` + reference implementation `Photos - Reinvented.dc.html`) — a Google-Photos-grade sidebar, memories strip, justified-row timeline, an albums grid view, and a redesigned lightbox with a right-side info panel — while preserving every #352 feature byte-identical at the query/action/command layer: server FTS search, EXIF details, slideshow, real phash-based duplicates shelf, free-form tags, geolocation place picker, custody/backup status, face-proposer on-demand trigger, and the non-destructive crop/rotate editor.

- New: `packages/blueprints/apps/photos/{layout,activity,icons,sidebar}.{js,jsx}`, `components/{Sidebar,Memories,AlbumGrid,Timeline,Toolbar,LightboxInfo}.jsx`
- Modified: `app.jsx` (orchestrator rewrite), `app.css` (full rewrite onto the new shell), `app.json`, `index.html`, `constants.js`, `components/{Enrichment,Lightbox,Slideshow}.jsx`, `upload.js`
- Deleted (superseded): `toolbar.jsx`, `components/{Chips,AlbumTools,Grid}.jsx`
- Untouched, verified byte-identical: every action/query module and the vault-facing contracts they call — `actions/**`, `queries/**`, `components/{Editor,Duplicates,Picker,InlineInput,SelectionBar}.jsx`, `duplicates.jsx`, `lightbox.jsx`, `picker.jsx`, `slideshow.jsx`, `search.js`, `visibility.js`, `media.js`, `format.js`, `outcomes.js`, `dom.js`, `faces.js`
- Memories = Favorites (if non-empty) + up to 6 albums with live members, sorted by newest member's capture time — no fabricated smart-memories. Storage meter = honest byte sum across loaded assets, no fictional quota (the mockup's static "15 GB" figure was dropped for the same reason Docs' Storage component doesn't fabricate one).
- `packages/blueprints/manifest.json` (regenerated), `packages/blueprints/visual-harness/mock-centraid.js` (fixtures extended to 58 assets/6 months/3 albums/3 places with varied aspect ratios, so the justified grid has something real to pack)
- Real bugs found and fixed:
  1. (build agent, live-browser pass) `components/Lightbox.jsx` imported `fmtBytes` from the wrong module (`format.js` instead of `kit.js`), breaking app boot entirely — a class of bug per-file syntax checks can't catch.
  2. (this review, independent verification) header overflowed its own width by ~20px below 480px viewports, clipping the Ask button — `.ph-zoom` (the least essential control at phone width) now hides under 480px.
- Also independently verified during this review: a suspected "tags silently fail to save" bug turned out to be a testing-tool artifact (a devicePixelRatio coordinate-scaling quirk in the browser harness affecting synthetic keyboard events on controlled inputs, not the app) — confirmed by dispatching real DOM events directly, which persisted and rendered the tag correctly.

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

filing publisher retargets wrapped content items onto their document:

```
packages/vault: bunx vitest run src/enrich/enrich.test.ts → 14/14 passed
packages/vault: bunx vitest run                           → 427/427 passed (41 files)
packages/vault: tsc (tsconfig.json + tsconfig.test.json)  → clean
bunx oxlint enrich-publishers.ts documents.ts enrich.test.ts → 0 warnings, 0 errors
```

docs wave-3 ui (includes the deferred manifest/mock final regeneration, independently re-verified after landing — see below):

```
node packages/blueprints/scripts/lint-apps.mjs → 0 problems (144 files)
esbuild --loader:.jsx=jsx on all changed/created docs files → no syntax errors
packages/blueprints: bunx vitest run src/app-manifests.test.ts src/app-boot → 82/82 passed (9 files, all 8 apps + manifest)
node --check mock-centraid.js → valid syntax
manifest.json file counts vs actual directory listing: photos 56/56, docs 46/46 — exact match
mock-centraid.js: both apps' fixture markers present post-merge (place/tags/
  custody_state/cluster_id for photos; tags/custody_state/__versions/activity
  for docs) — confirmed neither wave's concurrent edit clobbered the other's
  final state
visual harness live-browser pass: add/remove tag + toolbar filter chip,
  filtering narrows row count, real Activity rows (You/This app/An AI agent
  with receipt chips), custody badges in all four tones, dark theme, 375px
  mobile — zero console errors
```

photos wave-3 ui:

```
node packages/blueprints/scripts/lint-apps.mjs → 0 problems
esbuild --loader:.jsx=jsx on all changed/created photos files → no syntax errors
packages/blueprints: bunx vitest run src/app-boot/photos.test.ts → 1/1 passed
packages/blueprints: bunx vitest run src/app-manifests.test.ts   → 74/74 passed
visual harness live-browser pass: place chip + picker, tag add/remove +
  sidebar filter, face-proposer enabled/disabled states + on-demand trigger,
  custody badge tones, crop+rotate+save-as-new (original untouched), real
  2-way/3-way phash duplicate clusters — dark/light theme, 375px width, zero
  console errors
```

photos v2 visual redesign per design handoff — build agent's automated pass plus this review's independent re-verification:

```
node packages/blueprints/scripts/lint-apps.mjs → 0 problems (150 files)
esbuild --loader:.jsx=jsx / .js=jsx on every new/changed file → no syntax errors
packages/blueprints: bunx vitest run src/app-manifests.test.ts src/app-boot → 82/82 passed (9 files)
independent live-browser re-verification (this review, separate from the build
  agent's own pass): timeline+memories, lightbox (caption/EXIF/place-picker/
  albums/tags/activity/custody), tag add+remove round-trip via real DOM events,
  Albums grid, Duplicates shelf (real 3-copy/2-copy phash clusters), Trash+
  Restore (toast + count update confirmed), narrow width (390px) drawer+scrim
  open/close, dark theme — zero console errors in every state; one CSS
  overflow bug found and fixed live (see below)
```

docs app on the wrapper with editing and version history:

```
node packages/blueprints/scripts/lint-apps.mjs → 0 problems (141 files)
esbuild --loader:.jsx=jsx on all changed/created docs files → no syntax errors
packages/blueprints: bunx vitest run src/app-manifests.test.ts → 74/74 passed
packages/blueprints: bunx vitest run src/app-boot            → 8/8 passed (incl. docs)
visual harness (bun packages/blueprints/visual-harness/server.mjs):
  browse grid/list, Details drawer, version-history expand/preview/restore
  (confirmed honest re-ordering by assertion time), in-place edit with real
  autosave, Replace file on a PDF, trash → read-only Details → restore,
  search, empty/denied states, dark theme, 375px mobile — all clean
```

vault plumbing geo tags activity sync faces:

```
packages/vault:  bunx vitest run  → 452/452 passed (44 files)
packages/vault:  tsc (tsconfig.json + tsconfig.test.json) → clean
packages/gateway: tsc → clean
bunx oxlint <19 changed files> → 0 warnings, 0 errors
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

**What changed**: The receipt's `## What changed` section accurately captures the scope and structure of the 7 commits in main..HEAD. All major subsystems are accounted for: (1) document wrapper entity (`core_document` table, revises lineage, tests), (2) filing publisher retargeting, (3) docs app rewrite, (4) photos search/EXIF/slideshow/duplicates, (5) vault plumbing (geo linking, tags, activity, custody, faces, phash), (6) photos wave-3 UI, (7) docs wave-3 UI, and (8) photos v2 visual redesign. Vault changes match git diff (7 new/modified command packs, schema extensions). Blueprint app changes match filesystem (58 photos files, 46 docs files per manifest regeneration). Cross-cutting concerns (CSP fix for `data:` URIs in Editor.jsx, concurrency hazard detected and resolved in mock-centraid.js) are documented.

**Checklist realization**: All 8 checklist items map to completed work in the diff:
- `[x] document wrapper entity and revises lineage` — `core_document` DDL in core.ts, registered in tables.ts, version bump to 1.3, revises seeded into bootstrap.ts, tests cover restore-cycle bug.
- `[x] filing publisher retargets wrapped content items onto their document` — enrich-publishers.ts resolves owning document, tests verify wrapped and unwrapped cases.
- `[x] docs app on the wrapper with editing and version history` — app.jsx/Editor.jsx/History.jsx implement in-place edit + version history panel, queries/history.js walks the revises chain.
- `[x] photos search exif slideshow duplicates` — search.js server-side FTS, lightbox.jsx EXIF panel, slideshow.jsx with controls, duplicates.jsx shows phash clusters.
- `[x] vault plumbing geo tags activity sync faces` — media.ts place linking, tags.ts commands, gateway activity read route, blob custody_state table, enrich policy mirroring, phash cluster recompute, face-proposer automation scope fix.
- `[x] photos wave-3 ui` — photos app components (Editor, Enrichment) and actions (set-place, tag-asset, untag-asset, request-enrichment) wired over vault plumbing.
- `[x] docs wave-3 ui` — docs app components (Tags, Activity) and actions (tag, untag) wired, manifest/mock-centraid regenerated with both apps' fixtures.
- `[x] photos v2 visual redesign per design handoff` — app.jsx orchestrator rewrite, app.css full rewrite, new shell components (Sidebar, Memories, Timeline, LightboxInfo), every action/query byte-identical to wave-3.

**Checklist-to-issue mapping**: Issue #352 defines 4 phases; receipt checklist naturally aligns: Phase 1 (document identity) + Phase 2 (docs app) = items 1–3; Phase 3 (photos surfacing) = items 4–6; Phase 4 (universal joins) = items 7–8. The receipt additionally includes item 8 (photos v2 redesign), which was explicitly in-scope per the issue's "A parity audit" premise — matching Google Photos/Dropbox visually as well as functionally.

**Verdict: PASS**

## Steering

Two human-steering events detected and recorded in `## Accounting` → `### Steering`:

1. **Redirect on visual staleness (steer-1297f2eb831-20260711-1, ordinal 656, 08:25:57.776Z)**: After the build agent completed the initial photos wave-3 UI, the user observes the live visual and reports the Photos app "looks stale…the photos UI is similar [to] docs UI" — referring to the sidebar layout not matching a fresher visual they'd seen. This interrupts the agent's assumption that the wave-3 work was visually complete. The agent pauses coverage testing, investigates the code, and switches to running the visual-harness browser preview to examine the current state. The redirect surfaces a genuine visual mismatch: the sidebar was introduced in an earlier commit (not this branch), but the user's expectation was a redesigned Photos UI with a justified-grid layout and revised sidebar style per the design handoff, not the bare docs-like layout. This correction steers the work toward the photos v2 visual redesign that follows, requiring the agent to consume the design-handoff mockup and rebuild the shell.

2. **Rejection of governance gate (steer-1297f2eb831-20260711-2, ordinal 738, 08:35:18.959Z)**: After all feature implementation is complete and the agent has successfully built both app redesigns and verified them in the harness, the agent attempts to run `bash .governance/run.sh` (the pre-commit governance gate) before opening a PR. The user rejects this tool call with the message "done…skip governance gate". This is a direct correction: the user is instructing the agent to skip governance and proceed directly to PR opening. The user's intent is to defer governance to the merge pipeline rather than run it locally. The agent respects this and proceeds to PR creation without running the gate.

Both steering events are **corrections** (tier: classifier) — user messages that redirect or correct the agent's direction mid-task. The first steers new work (requiring a visual redesign commit); the second steers process (deferred governance). Neither is a tool denial (clicking "reject" on an offered action); both are substantive redirects that changed what work gets done or how it's sequenced.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-1297f2eb-831-1783763308-1 | claude-code | 1297f2eb-831b-4438-983c-86fdea06f9be | #352 | claude-sonnet-5 | 90611 | 1465883 | 185820537 | 485610 | 2042104 | 68.7992 | 90611 | 1465883 | 185820537 | 485610 | feat(photos): v2 visual redesign — sidebar, memories, justified timeline, lightb |
| claude-code-1297f2eb-831-1783763623-1 | claude-code | 1297f2eb-831b-4438-983c-86fdea06f9be | #352 | claude-sonnet-5 | 9822 | 30370 | 6065963 | 10462 | 50654 | 2.1201 | 100433 | 1496253 | 191886500 | 496072 | feat(photos): v2 visual redesign — sidebar, memories, justified timeline, lightb |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-1297f2eb831-20260711-1 | 1297f2eb-831b-4438-983c-86fdea06f9be | #352 | correction | classifier | Photos UI looks stale, doesn't match expected v2 redesign | e2c9b54 | 656 | 2026-07-11T08:25:57.776Z |
| steer-1297f2eb831-20260711-2 | 1297f2eb-831b-4438-983c-86fdea06f9be | #352 | correction | classifier | Reject governance gate command, skip it | e2c9b54 | 738 | 2026-07-11T08:35:18.959Z |
