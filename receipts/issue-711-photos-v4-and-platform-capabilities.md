# issue-711 — Photos v4 rewrite and the platform capabilities it proved missing

GitHub issue: [#711](https://github.com/srikanth235/centraid/issues/711)

## Checklist

- [x] S6 — the #599 vocabulary gate outranks the handoff's verbatim copy; offenders reworded, gate green
- [x] S7 — info panel stays on paper, keeps Albums + Activity, loses its `Move to trash`
- [x] S8 — `source_asset_id` is a real column, written by the editor and read by the viewer
- [x] S9 — enrichment policy enforced before dispatch, fail-closed; per-capability consent scope
- [x] Web: Sharing body
- [x] Web: Import surface + deduped/restored outcome panels
- [x] Web: duplicate-review flow
- [x] Web: Picker reachability
- [x] Web + mobile: `Empty trash` on a real purge mutation
- [x] Web: Storage backup health, custody breakdown, free-up statement
- [x] Web: unnamed face proposals on the People shelf
- [x] Mobile: Picker, Permission, Duplicates shelf
- [ ] Mobile: single video transport, zoom ladder + pan, band on every non-lightbox screen — the transport and zoom ladder landed; the band claim is REFUTED by `## Audit` (five pushed More-sheet destinations draw none), so the box stays open until the claim or the code moves
- [x] Six latent defects in already-passing code (see **What changed**)
- [ ] Device and browser verification

## What changed

**Rulings.** `docs/decisions.md` gains S6–S9. `docs/blueprint-seats.md`, `docs/glossary.md` and `docs/platform-gating.md` carry the seat model (S1–S5) the rewrite is built on.

**New platform capability.**

- `media.purge_asset` — permanent destruction of an already-trashed asset. Refuses a live asset, an unknown id, and any asset another asset still names as its source. Poly-refs go through the #441 registry; album covers hand off; bytes release by collapsing the grace window rather than deleting the row, because `HandlerCtx.blobs` has no CAS delete and an inline delete would strand the blob.
- `source_asset_id` self-FK on `media_media_asset` with a covering index (`fk-index.test.ts` requires it) and a `CHECK` against self-reference. Not stamped on the dedupe path — identical bytes are an existing asset, and overwriting its provenance would rewrite history.
- Enrichment enforcement in `runFire`, after the manifest resolves and **before** `openDispatch`, so a refused run starts no agent process and reaches no provider. Fail-closed on an absent seam, a throwing seam, and an unknown tier. The seam reads the vault registry, not the agent bridge — a guard must not be answerable by the grants of the party it guards.
- Owner-facing tier control (Settings → Enrichment), per domain, one domain per write. Refusal notices keyed by **domain, not automation** — seven enrichers refusing is one fact — written once per `(domain, tier)` because `NoticeStore.put` clears `read_at` and re-putting each tick would be the nag #647 D6 forbids.
- `blob_custody_rollup` projection, with a free-up safety predicate **stricter** than `BlobCache.runEviction`'s: it additionally requires a configured remote tier and narrows replica evidence to `store='cas'`, because a `derived` row is evidence about a thumbnail and must never license deleting the original.
- `--on-stage-soft` — light `--text-soft` was 2.85:1 on the stage, an AA failure.

**Defects found in code that was already passing.**

1. The on-demand enrichment queue had **never drained**: all three enricher drains filtered on `entity_type`/`entity_id`, columns `enrich_request` does not have (it carries `target_type`/`target_id`). `doc-text-extractor`'s `deviceOwned` set was therefore always empty, so the gateway backstop ran over live on-device leases instead of yielding to them.
2. `timeline-engine` carried `permission` in its snapshot and **nothing read it** — a denied grant produced a blank grid with no sentence and no route back.
3. Import counted a dedupe as both `added` and `deduped`, so four already-present files read `Added 4 photographs (4 already in the library)`.
4. `trashDuplicateAssets` wrote to a **second** status surface and offered **no undo** — the only irreversible delete in Photos.
5. The lifecycle sweep hard-deleted asset rows ignoring the new self-FK, raising `FOREIGN KEY constraint failed` and **aborting the whole pass**. Fixed by peeling derived copies first and skipping-and-reporting what ordering cannot save; `assetsPurged`/`contentPurged` now count rows actually purged, so a skip can no longer be reported as a purge.
6. The editor read an edited copy's *save* date back as its **capture** date.

### Checklist crosswalk

Each checked item above, quoted verbatim, against where it landed. The governance crosswalk matches on substring, so this block is also what makes a silently-flipped box impossible to hide.

- S6 — the #599 vocabulary gate outranks the handoff's verbatim copy; offenders reworded, gate green — `photos-vocabulary.test.ts` plus the reworded copy across both clients.
- S7 — info panel stays on paper, keeps Albums + Activity, loses its `Move to trash` — `LightboxInfo.tsx` / `PhotoInfoSheet.tsx`.
- S8 — `source_asset_id` is a real column, written by the editor and read by the viewer — the `media_media_asset` self-FK, the editor save path, and the viewer read.
- S9 — enrichment policy enforced before dispatch, fail-closed; per-capability consent scope — `packages/automation/src/fire/enrich-gate.ts` + `fire.ts`, and `enrich_request.capability`.
- Web: Sharing body — `packages/blueprints/apps/photos/` Sharing shelf.
- Web: Import surface + deduped/restored outcome panels — the Import surface and its deduped/restored outcome panels.
- Web: duplicate-review flow — the web duplicate-review flow, matching mobile's.
- Web: Picker reachability — the Picker, no longer reachable only from an empty album.
- Web + mobile: `Empty trash` on a real purge mutation — `media.purge_asset`, wired on both clients.
- Web: Storage backup health, custody breakdown, free-up statement — the web Storage surface: backup health, custody breakdown, free-up statement.
- Web: unnamed face proposals on the People shelf — the People shelf's unnamed-proposal rows.
- Mobile: Picker, Permission, Duplicates shelf — the three mobile surfaces that previously dead-ended.
- Six latent defects in already-passing code (see **What changed**) — the six numbered defects under **Defects found in code that was already passing**.

**Design parity, measured rather than eyeballed.** Device pixels sampled off the simulator and compared against the handoff's own CSS, not against a screenshot by eye.

- `borders.hairline` — the Binding Layer draws every edge as `border: 1px solid`. React Native's `StyleSheet.hairlineWidth` is one *physical* pixel: 0.33pt at 3×, so every rule in the mobile app shipped at a third of its specified weight. The width is now a design token emitted through the native lowering and applied at 86 sites across 44 files, with `lint:hairline` keeping `hairlineWidth` out of `apps/mobile/src`. Ten RN test mocks declared `hairlineWidth: 1`, which is why the unit suites had always agreed with the handoff while the device did not.
- Position insets — RN still *types* the legacy `start:`/`end:` pair, but `insetInlineStart`/`insetInlineEnd` take unconditional precedence in the New Architecture. An absolutely-positioned band declared with `start: 0, end: 0` therefore type-checked, lint-passed, and laid out with no horizontal constraint at all. 23 props across 9 files; `lint:logical-insets` is the guard.
- Springboard order is a design statement, not the catalog's: `SPRINGBOARD_ORDER` mirrors desktop's `HOME_TILE_ORDER` so Photos leads on both clients, applied *before* pins so a member's pin still wins.
- Tile bodies now take the handoff's **explicit mobile** value wherever it declares one, instead of the ramp role: read-tile serif 15/24 (the ramp's 17.5/31 spent 93pt of a 152pt tile), event title 14, checkbox 13pt with the done state a filled box and no glyph, faces at 30pt with a 1.5pt ring, −7 overlap and a single initial.
- People faces take a saturated identity fill derived from `party_id` (a stored `avatar_color` wins) with AA-solved inverse ink. They had been `bgSunken` discs with grey letters — the identity wheel was never reached.

**A second parity pass, after a six-slice audit of every mobile surface against the handoff's literal CSS.** Every finding below was measured — device pixels sampled off the simulator, or the prototype's own computed styles read in a browser — never eyeballed from a screenshot.

- **Two more missing tokens, same failure shape as the border width.** The handoff carries a page-margin scale separate from its gap scale (`R.margin`, :3356); we had only `spacing` (4/8/12/16/24/32), so mobile's 18 was unrepresentable — Home hardcoded the literal in four places and got it right, Photos never learned the convention and substituted 16 and 10. Now `pageMargin`. The stage had no sunken rung, so the viewer's transport track borrowed the hairline colour; now `stageSunken` (#1A1A19, :4552). The scrim was also simply wrong — `rgba(20,20,20,.48)` against the handoff's `rgba(26,24,21,.3)` (:5101), heavier and colder in both schemes, corrected at the shared source so web and native move together.
- **The glass idiom is gone.** The handoff has no `backdrop-filter`, no `blur()` and no soft shadow on any product surface; DESIGN.md said the same and `--glass-sheen` was already `none`. `GlassBar` (BlurView + tint + sheen + `elevation:6` + a 16pt shadow) nonetheless shipped on six app covers through `HomeKey`, still carrying a teal wash the ink flip retired, and `AppIcon` painted a sheen and `elevation:3` that DESIGN.md forbids by name. `HomeKey` is now the same opaque plate as the band's capsule, `GlassBar` is deleted, `AppIcon` is flat, and `expo-blur` is out of the app.
- **The claimed band was the wrong object.** The handoff draws it as TWO plates in a transparent row (`appBandStyle` :4955-4964) — the frame's capsule on the frame's page colour, the app's five destinations on `t.surf`, an 8pt gap between them carrying the group boundary. We drew one plate with the capsule nested inside, which is why "these are two groups" never read. Rebuilt to the real anatomy; both bands now share one ground, and the active mark is the absolute 2pt rule across the tab's top edge (:4974) rather than an in-flow rounded stub.
- **Content ran under the band.** The band was an absolute overlay, so a reserve padded onto each scroll surface could only clear the END of the content — mid-scroll a day header and a caption still passed beneath, which is what the device showed. The handoff makes the band a `flex:none` sibling below the scroll region, so the viewport is genuinely shorter. It is now, on both Photos frames, and the reserve plumbing that existed only to compensate is gone.
- **Controls.** A disabled filled button stayed filled, in direct violation of D19 ("a filled control that cannot be pressed stops being filled"); the recipe now has a real disabled variant. Buttons rendered at the 48pt touch minimum instead of the 34pt control height — the visible box is now 34 with a 7pt `hitSlop` carrying the target. Secondary was filled where the spec is transparent; quiet carried soft ink where the spec is full ink.
- **`Icon`'s `strokeWidth` prop was dead code** — declared, then ignored by a hardcoded 1.5. Honouring it would have applied thirty never-before-rendered weights (1.2 to 4.4) at once, so the default became the system's own stated rule instead (1.6, 1.75 below 16px, per `icons.ts`'s header) and the arbitrary per-call overrides were removed, keeping only the deliberate ones.
- **The heart glyph was drawn wrong.** Its lobes were centred at x=9.25 while the point stayed at x=12, so it leaned left and the right lobe collapsed into a notch — at every size, on both clients, under two registry keys carrying the same bad curve. Measured with `getBBox()` against the handoff's symmetric path and replaced. The other nine glyphs we share with the handoff also differ, but each is a defensible equivalent, and the handoff labels that batch "placeholder stroke paths" in its own notes — so the false "shares their exact artwork" comment was replaced with the real per-icon reasoning rather than the paths being copied.
- **Sheets** gained the head the spec gives them (title + 34pt ✕ close), lost a grabber the handoff never draws, and took their row rules, 16pt faint icons and mono foot.
- **The app bar is chrome again.** It scrolled away with no seam; the handoff makes it `flex:none` above the scroll region with a 1px `t.lineS` bottom rule (:5532-5533), which is why the prototype's scrollbar starts below that line.
- **The editor's provenance note collapsed to one word per line** — `min-width: 220px` had been translated as `flexBasis: 220` with `flexShrink: 1`, which has no floor.

**A third pass, from three defects the device showed that no unit test could.**

- **The way home opened as a card sheet.** Tapping Home from Photos presented an inset modal over Photos instead of dismissing it. Not a drawer, and not a Photos bug: React Navigation 7 changed `navigate` so it no longer returns to a route already in the stack — it PUSHES a second copy, because `StackRouter`'s NAVIGATE only reuses a route when the action carries `pop`, which is what `popTo` sets. A screen pushed above a `presentation: "fullScreenModal"` is then presented modally by UIKit, which is the card. Five call sites shared the defect (`PhotosHome`, `PhotosScreen` ×2, `Approvals`, the notification deep-link responder). `goBack` would have been the wrong fix: Photos can be entered by deep link, where there is nothing to go back TO, and §3.1 makes the way home the one thing an app may never take away. `popTo` covers both — it pops to Home when Home is beneath and REPLACES the cover when it is not. The two rewritten tests assert `popTo` fired **and** `navigate` did not, so the old call cannot come back green.
- **Per-tile custody captions, deleted.** Every tile carried a prose line — `on this device only` or `on the gateway` — under the photograph. Three stacked deviations: it labelled the *steady* state (`remote-only` is where bytes are designed to live, so in a synced vault every single tile carried an identical sentence), it labelled the *default* (`local-only` fires on every photograph in a fresh camera roll), and it did both in prose where the handoff draws a small inset chip. The custody triple stays a data model; the tile now renders a **binary** — a `CloudOff` mark for `local-only`, the one state a member can lose something to, and silence otherwise. `on the gateway` survives only where it is news: an unreachable gateway, where it is the whole explanation for a tile that cannot paint. The exclusion is structural — `StateOverlay` is a discriminated union, so a tile cannot stack a glyph under a caption — and `docs/blueprint-seats.md` records the altitude rule: custody belongs per-shelf (counts) and per-photograph (info sheet), and on a tile only as an exception mark, never a sentence. `BackupHealth` gained a legend redrawing the chip at the tile's exact geometry, so the mark is taught somewhere.
- **The grid ignored the page margin, and the hit test with it.** Rows packed to the full window width while day headers were inset 18, so every row was justified 36pt too wide — worse than a margin bug, because `justify` distributes error across a row. Packing now takes `width - 2 * pageMargin`. The consequential defect was silent: `assetAt` hit-tests in gesture coordinates, so once the row was padded, every tap without a compensating offset would have resolved one tile to the left.

Measured, not eyeballed: the corrected margin was confirmed by pixel-scanning the device screenshot — 18.00pt both sides, ground `(240,239,237)` = `#F0EFED`.

Two constants were also collapsed to one definition each, because the wave proved the cost of the alternative: the band's height was being derived independently in the band and in the scroll surface that had to clear it (they had drifted to 74 against 84), and the icon registry stores several glyphs twice under two spellings — which is how one bad heart curve came to live in two places.

### Every file this change set touches

Listed in full because the receipt is the audit trace for a change set this wide, and a path named nowhere is scope no reviewer can check.

**Design system, its gates, and the desktop e2e evidence harness** (31)

- `DESIGN.md`
- `apps/desktop/tests/e2e/onboarding-home.spec.ts`
- `packages/design/kit/kit.css`
- `packages/design/src/blueprint.ts`
- `packages/design/src/borders.ts` — new
- `packages/design/src/css-properties.test.ts`
- `packages/design/src/css.ts`
- `packages/design/src/density.ts`
- `packages/design/src/design-md.test.ts`
- `packages/design/src/icons-contract.test.ts`
- `packages/design/src/icons.ts`
- `packages/design/src/identity.test.ts` — new
- `packages/design/src/identity.ts`
- `packages/design/src/index.ts`
- `packages/design/src/native-contract.test.ts`
- `packages/design/src/native.ts`
- `packages/design/src/recipes/css.ts`
- `packages/design/src/recipes/index.ts`
- `packages/design/src/recipes/native.ts`
- `packages/design/src/recipes/recipes.test.ts`
- `packages/design/src/roles.ts`
- `packages/design/src/stage.test.ts` — new
- `packages/design/src/themes/centraid.ts`
- `packages/design/src/themes/index.ts`
- `packages/design/src/themes/shared.ts`
- `packages/design/src/typography.ts`
- `scripts/accessibility-contract.test.mjs`
- `scripts/lint-hairline.mjs` — new
- `scripts/lint-hairline.test.mjs` — new
- `scripts/lint-logical-insets.mjs` — new
- `scripts/lint-logical-insets.test.mjs` — new

**Platform: vault, gateway, automation, app-engine** (36)

- `packages/app-engine/src/index.ts`
- `packages/app-engine/src/registry/manifest.test.ts`
- `packages/app-engine/src/registry/manifest.ts`
- `packages/automation/src/fire/enrich-gate.test.ts` — new
- `packages/automation/src/fire/enrich-gate.ts` — new
- `packages/automation/src/fire/enrich-refusal-outcome.test.ts` — new
- `packages/automation/src/fire/fire.ts`
- `packages/automation/src/handler/runner.ts`
- `packages/automation/src/index.ts`
- `packages/automation/src/manifest/manifest.ts`
- `packages/gateway/src/routes/scopes-routes.test.ts`
- `packages/gateway/src/routes/scopes-routes.ts`
- `packages/gateway/src/routes/vault-routes.test.ts`
- `packages/gateway/src/routes/vault-routes.ts`
- `packages/gateway/src/serve/build-gateway.ts`
- `packages/gateway/src/serve/enrich-tier-control.test.ts` — new
- `packages/gateway/src/serve/notices.ts`
- `packages/gateway/src/serve/share-target.ts` — new
- `packages/vault/src/blob/custody-rollup.test.ts` — new
- `packages/vault/src/blob/custody-rollup.ts` — new
- `packages/vault/src/commands/enrich.ts`
- `packages/vault/src/commands/media-purge.test.ts` — new
- `packages/vault/src/commands/media.test.ts`
- `packages/vault/src/commands/media.ts`
- `packages/vault/src/enrich/enrich.test.ts`
- `packages/vault/src/enrich/policy.ts` — new
- `packages/vault/src/gateway/duties.test.ts`
- `packages/vault/src/gateway/duties.ts`
- `packages/vault/src/gateway/gateway.ts`
- `packages/vault/src/gateway/portable-export.ts`
- `packages/vault/src/index.ts`
- `packages/vault/src/schema/blob.ts`
- `packages/vault/src/schema/domains-social-knowledge-media.ts`
- `packages/vault/src/schema/enrich.ts`
- `packages/vault/src/schema/tables.ts`
- `packages/vault/src/share/closure.ts`

**Web: blueprints** (169)

- `packages/blueprints/apps/_shared/download-on-demand.ts` — new
- `packages/blueprints/apps/agenda/app.json`
- `packages/blueprints/apps/docs/app.json`
- `packages/blueprints/apps/inline-types.ts`
- `packages/blueprints/apps/locker/app.json`
- `packages/blueprints/apps/notes/app.json`
- `packages/blueprints/apps/people/app.json`
- `packages/blueprints/apps/photos/Chrome.module.css`
- `packages/blueprints/apps/photos/Chrome.tsx`
- `packages/blueprints/apps/photos/actions/purge-asset.ts` — new
- `packages/blueprints/apps/photos/actions/request-enrichment.ts`
- `packages/blueprints/apps/photos/actions/upload.ts`
- `packages/blueprints/apps/photos/app-inline.tsx`
- `packages/blueprints/apps/photos/app-root.tsx`
- `packages/blueprints/apps/photos/app.json`
- `packages/blueprints/apps/photos/assets-actions.ts`
- `packages/blueprints/apps/photos/components/AlbumBar.module.css` — new
- `packages/blueprints/apps/photos/components/AlbumBar.tsx` — new
- `packages/blueprints/apps/photos/components/AlbumGrid.module.css`
- `packages/blueprints/apps/photos/components/AlbumGrid.tsx`
- `packages/blueprints/apps/photos/components/DuplicateReview.module.css` — new
- `packages/blueprints/apps/photos/components/DuplicateReview.tsx` — new
- `packages/blueprints/apps/photos/components/Duplicates.module.css`
- `packages/blueprints/apps/photos/components/Duplicates.tsx`
- `packages/blueprints/apps/photos/components/Editor.module.css`
- `packages/blueprints/apps/photos/components/Editor.tsx`
- `packages/blueprints/apps/photos/components/EmptyTrash.module.css` — new
- `packages/blueprints/apps/photos/components/EmptyTrash.tsx` — new
- `packages/blueprints/apps/photos/components/Enrichment.module.css`
- `packages/blueprints/apps/photos/components/Enrichment.tsx`
- `packages/blueprints/apps/photos/components/EnrichmentConsent.module.css` — new
- `packages/blueprints/apps/photos/components/EnrichmentConsent.tsx` — new
- `packages/blueprints/apps/photos/components/FaceReview.module.css` — new
- `packages/blueprints/apps/photos/components/FaceReview.tsx` — new
- `packages/blueprints/apps/photos/components/Import.module.css` — new
- `packages/blueprints/apps/photos/components/Import.tsx` — new
- `packages/blueprints/apps/photos/components/Lightbox.module.css`
- `packages/blueprints/apps/photos/components/Lightbox.tsx`
- `packages/blueprints/apps/photos/components/LightboxInfo.module.css`
- `packages/blueprints/apps/photos/components/LightboxInfo.tsx`
- `packages/blueprints/apps/photos/components/LoadingGrid.module.css` — new
- `packages/blueprints/apps/photos/components/LoadingGrid.tsx` — new
- `packages/blueprints/apps/photos/components/Memories.module.css`
- `packages/blueprints/apps/photos/components/MoreSheet.module.css` — new
- `packages/blueprints/apps/photos/components/MoreSheet.tsx` — new
- `packages/blueprints/apps/photos/components/OfflineBanner.module.css` — new
- `packages/blueprints/apps/photos/components/OfflineBanner.tsx` — new
- `packages/blueprints/apps/photos/components/People.module.css` — new
- `packages/blueprints/apps/photos/components/People.tsx` — new
- `packages/blueprints/apps/photos/components/Permission.module.css` — new
- `packages/blueprints/apps/photos/components/Permission.tsx` — new
- `packages/blueprints/apps/photos/components/Picker.module.css`
- `packages/blueprints/apps/photos/components/Picker.tsx`
- `packages/blueprints/apps/photos/components/Places.module.css` — new
- `packages/blueprints/apps/photos/components/Places.tsx` — new
- `packages/blueprints/apps/photos/components/ScrubRail.module.css` — new
- `packages/blueprints/apps/photos/components/ScrubRail.tsx` — new
- `packages/blueprints/apps/photos/components/SearchShelf.module.css` — new
- `packages/blueprints/apps/photos/components/SearchShelf.tsx` — new
- `packages/blueprints/apps/photos/components/SelectionBar.module.css`
- `packages/blueprints/apps/photos/components/SelectionBar.tsx`
- `packages/blueprints/apps/photos/components/Sharing.module.css` — new
- `packages/blueprints/apps/photos/components/Sharing.tsx` — new
- `packages/blueprints/apps/photos/components/ShelfStrip.module.css` — new
- `packages/blueprints/apps/photos/components/ShelfStrip.tsx` — new
- `packages/blueprints/apps/photos/components/Sidebar.module.css` — deleted
- `packages/blueprints/apps/photos/components/Sidebar.tsx` — deleted
- `packages/blueprints/apps/photos/components/Slideshow.module.css`
- `packages/blueprints/apps/photos/components/Slideshow.tsx`
- `packages/blueprints/apps/photos/components/Storage.module.css` — new
- `packages/blueprints/apps/photos/components/Storage.tsx` — new
- `packages/blueprints/apps/photos/components/Tile.module.css` — new
- `packages/blueprints/apps/photos/components/Tile.tsx` — new
- `packages/blueprints/apps/photos/components/Timeline.module.css`
- `packages/blueprints/apps/photos/components/Timeline.tsx`
- `packages/blueprints/apps/photos/components/Toolbar.module.css`
- `packages/blueprints/apps/photos/components/Toolbar.tsx`
- `packages/blueprints/apps/photos/components/ViewerActions.tsx` — new
- `packages/blueprints/apps/photos/components/ViewerStage.tsx` — new
- `packages/blueprints/apps/photos/custody-store.ts` — new
- `packages/blueprints/apps/photos/duplicate-decision.ts` — new
- `packages/blueprints/apps/photos/duplicates-actions.ts`
- `packages/blueprints/apps/photos/duplicates.tsx`
- `packages/blueprints/apps/photos/enrichment-consent.test.ts` — new
- `packages/blueprints/apps/photos/enrichment-consent.ts` — new
- `packages/blueprints/apps/photos/face-crop.test.ts` — new
- `packages/blueprints/apps/photos/face-crop.ts` — new
- `packages/blueprints/apps/photos/faces.ts`
- `packages/blueprints/apps/photos/filters.ts` — new
- `packages/blueprints/apps/photos/frame.tsx` — new
- `packages/blueprints/apps/photos/grouping.ts` — new
- `packages/blueprints/apps/photos/icons.tsx`
- `packages/blueprints/apps/photos/layout.ts`
- `packages/blueprints/apps/photos/lightbox.tsx`
- `packages/blueprints/apps/photos/media.ts`
- `packages/blueprints/apps/photos/member-prefs.ts` — new
- `packages/blueprints/apps/photos/memories.ts` — new
- `packages/blueprints/apps/photos/outcomes.ts`
- `packages/blueprints/apps/photos/people.ts` — new
- `packages/blueprints/apps/photos/picker-actions.ts`
- `packages/blueprints/apps/photos/picker.tsx`
- `packages/blueprints/apps/photos/pinch.ts` — new
- `packages/blueprints/apps/photos/queries/face-queue.ts` — new
- `packages/blueprints/apps/photos/queries/people.ts` — new
- `packages/blueprints/apps/photos/queries/storage.ts` — new
- `packages/blueprints/apps/photos/scopes.ts`
- `packages/blueprints/apps/photos/search-entry.test.ts` — new
- `packages/blueprints/apps/photos/search-groups.test.ts` — new
- `packages/blueprints/apps/photos/search-groups.ts` — new
- `packages/blueprints/apps/photos/search.ts`
- `packages/blueprints/apps/photos/selection-actions.ts`
- `packages/blueprints/apps/photos/selection.tsx` — new
- `packages/blueprints/apps/photos/shared-copy.ts` — new
- `packages/blueprints/apps/photos/sharing.ts` — new
- `packages/blueprints/apps/photos/shelves.ts` — new
- `packages/blueprints/apps/photos/sidebar.tsx` — deleted
- `packages/blueprints/apps/photos/slideshow.tsx`
- `packages/blueprints/apps/photos/storage-model.test.ts` — new
- `packages/blueprints/apps/photos/storage-model.ts` — new
- `packages/blueprints/apps/photos/tile-state.ts` — new
- `packages/blueprints/apps/photos/trash-actions.test.ts` — new
- `packages/blueprints/apps/photos/trash-actions.ts` — new
- `packages/blueprints/apps/photos/types.ts`
- `packages/blueprints/apps/photos/upload.ts`
- `packages/blueprints/apps/photos/view-copy.ts` — new
- `packages/blueprints/apps/photos/view-state.ts` — new
- `packages/blueprints/apps/photos/viewer.test.ts` — new
- `packages/blueprints/apps/photos/viewer.ts` — new
- `packages/blueprints/apps/tally/app.json`
- `packages/blueprints/apps/tasks/app.json`
- `packages/blueprints/automations/doc-entity-linker/automations/doc-entity-linker/automation.json`
- `packages/blueprints/automations/doc-filer/automations/doc-filer/automation.json`
- `packages/blueprints/automations/doc-text-extractor/automations/doc-text-extractor/automation.json`
- `packages/blueprints/automations/doc-text-extractor/automations/doc-text-extractor/handler.js`
- `packages/blueprints/automations/face-proposer/automations/face-proposer/automation.json`
- `packages/blueprints/automations/face-proposer/automations/face-proposer/handler.js`
- `packages/blueprints/automations/obligation-extractor/automations/obligation-extractor/automation.json`
- `packages/blueprints/automations/photo-captioner/automations/photo-captioner/automation.json`
- `packages/blueprints/automations/photo-captioner/automations/photo-captioner/handler.js`
- `packages/blueprints/automations/screenshot-extractor/automations/screenshot-extractor/automation.json`
- `packages/blueprints/automations/trip-albums/automations/trip-albums/automation.json`
- `packages/blueprints/manifest.json`
- `packages/blueprints/scripts/build-manifest.mjs`
- `packages/blueprints/src/app-boot-harness.ts`
- `packages/blueprints/src/blueprint-seats.test.ts` — new
- `packages/blueprints/src/download-on-demand.test.ts` — new
- `packages/blueprints/src/handler-reachability.test.ts`
- `packages/blueprints/src/photos-asset-key.test.ts`
- `packages/blueprints/src/photos-duplicate-review.test.ts` — new
- `packages/blueprints/src/photos-duplicates.test.ts` — new
- `packages/blueprints/src/photos-editor-guard.test.ts` — new
- `packages/blueprints/src/photos-face-review.test.ts` — new
- `packages/blueprints/src/photos-faces.test.ts` — new
- `packages/blueprints/src/photos-frame.test.ts` — new
- `packages/blueprints/src/photos-import-outcomes.test.ts` — new
- `packages/blueprints/src/photos-layout.test.ts` — new
- `packages/blueprints/src/photos-people.test.ts` — new
- `packages/blueprints/src/photos-picker.test.ts` — new
- `packages/blueprints/src/photos-readonly-album.test.ts` — new
- `packages/blueprints/src/photos-selection-bar.test.ts` — new
- `packages/blueprints/src/photos-sharing-body.test.ts` — new
- `packages/blueprints/src/photos-shelves-v4.test.ts` — new
- `packages/blueprints/src/photos-tile.test.ts` — new
- `packages/blueprints/src/photos-view-state.test.ts` — new
- `packages/blueprints/src/photos-viewer.test.ts` — new
- `packages/blueprints/src/state-honesty.test.ts`
- `packages/blueprints/src/token-purity-allowlist.ts`
- `packages/blueprints/src/types.ts`
- `packages/blueprints/types/centraid.d.ts`

**Web: client shell** (43)

- `packages/client/src/enrich-policy.ts` — new
- `packages/client/src/gateway-client-enrich.contract.test.ts` — new
- `packages/client/src/gateway-client-seam-fixtures.ts`
- `packages/client/src/gateway-client-vault.ts`
- `packages/client/src/home-copy.ts`
- `packages/client/src/react/blueprints/centraid-inline.ts`
- `packages/client/src/react/host-platform.ts`
- `packages/client/src/react/screens/HomeSpringboard.module.css`
- `packages/client/src/react/screens/HomeSpringboard.test.tsx`
- `packages/client/src/react/screens/HomeSpringboard.tsx`
- `packages/client/src/react/screens/OnboardingScreen.test.tsx`
- `packages/client/src/react/screens/SettingsEnrichmentScreen.module.css` — new
- `packages/client/src/react/screens/SettingsEnrichmentScreen.test.tsx` — new
- `packages/client/src/react/screens/SettingsEnrichmentScreen.tsx` — new
- `packages/client/src/react/shell/App.test.tsx`
- `packages/client/src/react/shell/App.tsx`
- `packages/client/src/react/shell/AppBand.tsx` — new
- `packages/client/src/react/shell/ShellApp.tsx`
- `packages/client/src/react/shell/ShellFrame.tsx`
- `packages/client/src/react/shell/Stem.tsx`
- `packages/client/src/react/shell/chrome.module.css`
- `packages/client/src/react/shell/inlineFrame.test.tsx` — new
- `packages/client/src/react/shell/inlineFrame.ts` — new
- `packages/client/src/react/shell/routes/ApprovalsRoute.tsx`
- `packages/client/src/react/shell/routes/ConnectFlow.test.tsx`
- `packages/client/src/react/shell/routes/InlineAppRoute.module.css`
- `packages/client/src/react/shell/routes/InlineAppRoute.test.tsx`
- `packages/client/src/react/shell/routes/InlineAppRoute.tsx`
- `packages/client/src/react/shell/routes/SettingsRoute.tsx`
- `packages/client/src/react/shell/routes/connectFlowIO.test.ts`
- `packages/client/src/react/shell/routes/homeTileContent.ts`
- `packages/client/src/react/shell/routes/homeTiles.test.ts`
- `packages/client/src/react/shell/routes/homeTiles.ts`
- `packages/client/src/react/shell/routes/homeTileContent.test.ts`
- `packages/client/src/react/shell/routes/inlineAppFlows.ts` — new
- `packages/client/src/react/shell/routes/inlineAppFrame.tsx` — new
- `packages/client/src/react/shell/routes/inlineAppSeats.test.ts` — new
- `packages/client/src/react/shell/routes/inlineAppSeats.ts` — new
- `packages/client/src/react/shell/routes/settingsEnrichmentData.ts` — new
- `packages/client/src/react/shell/routes/useAppScopes.test.ts`
- `packages/client/src/react/shell/routes/useAppScopes.ts`
- `packages/client/src/react/shell/routes/vaultModals.test.ts`
- `packages/client/src/react/shell/useBandOwner.ts` — new
- `packages/client/src/react/shell/useMemberScopes.test.tsx`

**Mobile** (186)

- `apps/mobile/App.tsx`
- `apps/mobile/ios/Podfile.lock`
- `apps/mobile/native-fingerprints.json`
- `apps/mobile/package.json`
- `apps/mobile/src/apps/insights/Insights.styles.ts`
- `apps/mobile/src/apps/locker/LockerHome.styles.ts`
- `apps/mobile/src/apps/notes/NotesHome.styles.ts`
- `apps/mobile/src/apps/photos/AlbumDetail.tsx`
- `apps/mobile/src/apps/photos/BackupHealth.styles.ts`
- `apps/mobile/src/apps/photos/BackupHealth.tsx`
- `apps/mobile/src/apps/photos/DuplicateReview.tsx`
- `apps/mobile/src/apps/photos/DuplicatesShelf.tsx` — new
- `apps/mobile/src/apps/photos/EnrichmentConsent.styles.ts` — new
- `apps/mobile/src/apps/photos/EnrichmentConsent.test.tsx` — new
- `apps/mobile/src/apps/photos/EnrichmentConsent.tsx` — new
- `apps/mobile/src/apps/photos/FaceReview.styles.ts` — new
- `apps/mobile/src/apps/photos/FaceReview.test.tsx` — new
- `apps/mobile/src/apps/photos/FaceReview.tsx`
- `apps/mobile/src/apps/photos/MediaPage.tsx`
- `apps/mobile/src/apps/photos/PhotoEditor.styles.ts` — new
- `apps/mobile/src/apps/photos/PhotoEditor.test.tsx` — new
- `apps/mobile/src/apps/photos/PhotoEditor.tsx` — new
- `apps/mobile/src/apps/photos/PhotoFilmstrip.tsx` — new
- `apps/mobile/src/apps/photos/PhotoInfoSheet.tsx` — new
- `apps/mobile/src/apps/photos/PhotoLightbox.styles.ts`
- `apps/mobile/src/apps/photos/PhotoLightbox.tsx`
- `apps/mobile/src/apps/photos/PhotoLightboxToolbar.tsx`
- `apps/mobile/src/apps/photos/PhotoPermission.tsx` — new
- `apps/mobile/src/apps/photos/PhotoPicker.tsx` — new
- `apps/mobile/src/apps/photos/PhotoStateView.tsx`
- `apps/mobile/src/apps/photos/PhotoTile.tsx` — new
- `apps/mobile/src/apps/photos/PhotoTimeline.tsx`
- `apps/mobile/src/apps/photos/PhotosBand.tsx` — new
- `apps/mobile/src/apps/photos/PhotosCollectionsView.tsx`
- `apps/mobile/src/apps/photos/PhotosDrawer.tsx` — deleted
- `apps/mobile/src/apps/photos/PhotosHome.test.tsx` — new
- `apps/mobile/src/apps/photos/PhotosHome.tsx`
- `apps/mobile/src/apps/photos/PhotosLibrary.styles.ts`
- `apps/mobile/src/apps/photos/PhotosLibrary.tsx`
- `apps/mobile/src/apps/photos/PhotosMoreSheet.test.tsx` — new
- `apps/mobile/src/apps/photos/PhotosMoreSheet.tsx` — new
- `apps/mobile/src/apps/photos/PhotosPeopleView.test.tsx` — new
- `apps/mobile/src/apps/photos/PhotosPeopleView.tsx` — new
- `apps/mobile/src/apps/photos/PhotosScreen.test.tsx` — new
- `apps/mobile/src/apps/photos/PhotosScreen.tsx` — new
- `apps/mobile/src/apps/photos/PhotosSearch.tsx`
- `apps/mobile/src/apps/photos/PhotosToolbar.tsx` — new
- `apps/mobile/src/apps/photos/PlaceDetail.tsx` — new
- `apps/mobile/src/apps/photos/PlacesMap.tsx`
- `apps/mobile/src/apps/photos/PlacesView.tsx` — new
- `apps/mobile/src/apps/photos/ScrubRail.tsx` — new
- `apps/mobile/src/apps/photos/duplicate-clusters.test.ts` — new
- `apps/mobile/src/apps/photos/duplicate-clusters.ts` — new
- `apps/mobile/src/apps/photos/face-crop.test.ts` — new
- `apps/mobile/src/apps/photos/face-crop.ts` — new
- `apps/mobile/src/apps/photos/face-review-queue.test.ts` — new
- `apps/mobile/src/apps/photos/face-review-queue.ts` — new
- `apps/mobile/src/apps/photos/full-quality-gate.test.ts` — deleted
- `apps/mobile/src/apps/photos/full-quality-gate.ts` — deleted
- `apps/mobile/src/apps/photos/justify.test.ts` — new
- `apps/mobile/src/apps/photos/justify.ts` — new
- `apps/mobile/src/apps/photos/lightbox-gestures.ts`
- `apps/mobile/src/apps/photos/photo-access.test.ts` — new
- `apps/mobile/src/apps/photos/photo-access.ts` — new
- `apps/mobile/src/apps/photos/photo-edit-gestures.ts` — new
- `apps/mobile/src/apps/photos/photo-edit-model.test.ts` — new
- `apps/mobile/src/apps/photos/photo-edit-model.ts` — new
- `apps/mobile/src/apps/photos/photo-edit-save.ts` — new
- `apps/mobile/src/apps/photos/photos-backup.ts` — new
- `apps/mobile/src/apps/photos/photos-band.test.ts` — new
- `apps/mobile/src/apps/photos/photos-band.ts` — new
- `apps/mobile/src/apps/photos/photos-more-router.test.ts` — new
- `apps/mobile/src/apps/photos/photos-rung-store.ts` — new
- `apps/mobile/src/apps/photos/photos-rungs.test.ts` — new
- `apps/mobile/src/apps/photos/photos-rungs.ts` — new
- `apps/mobile/src/apps/photos/photos-selection-writes.ts` — new
- `apps/mobile/src/apps/photos/photos-selection.test.ts` — new
- `apps/mobile/src/apps/photos/photos-selection.ts` — new
- `apps/mobile/src/apps/photos/photos-trash.test.ts` — new
- `apps/mobile/src/apps/photos/photos-trash.ts` — new
- `apps/mobile/src/apps/photos/photos-vaults.ts` — new
- `apps/mobile/src/apps/photos/search-hits.test.ts` — new
- `apps/mobile/src/apps/photos/search-hits.ts` — new
- `apps/mobile/src/apps/photos/skeleton-rows.test.ts` — new
- `apps/mobile/src/apps/photos/skeleton-rows.ts` — new
- `apps/mobile/src/apps/photos/tile-overlays.test.ts` — new
- `apps/mobile/src/apps/photos/tile-overlays.ts` — new
- `apps/mobile/src/apps/photos/timeline-engine.ts`
- `apps/mobile/src/apps/photos/timeline-model.ts`
- `apps/mobile/src/apps/photos/timeline-rows.test.ts` — new
- `apps/mobile/src/apps/photos/timeline-rows.ts` — new
- `apps/mobile/src/apps/photos/trash-purge-countdown.test.ts` — new
- `apps/mobile/src/apps/photos/viewer-model.test.ts` — new
- `apps/mobile/src/apps/photos/viewer-model.ts` — new
- `apps/mobile/src/apps/photos/viewer-read-only-reason.test.ts` — new
- `apps/mobile/src/components/OutboxDecisionCard.tsx`
- `apps/mobile/src/kit/band-surface.ts` — new
- `apps/mobile/src/kit/components/AppHeader.tsx`
- `apps/mobile/src/kit/components/AppIcon.tsx`
- `apps/mobile/src/kit/components/AudiencePlacementSheet.tsx`
- `apps/mobile/src/kit/components/Button.tsx`
- `apps/mobile/src/kit/components/GlassBar.tsx` — deleted
- `apps/mobile/src/kit/components/HomeKey.tsx`
- `apps/mobile/src/kit/components/Icon.test.tsx`
- `apps/mobile/src/kit/components/Icon.tsx`
- `apps/mobile/src/kit/components/OptionSheet.tsx`
- `apps/mobile/src/kit/components/OutOfRoom.tsx`
- `apps/mobile/src/kit/components/StatusLine.tsx`
- `apps/mobile/src/kit/components/icon-stroke-width.ts` — new
- `apps/mobile/src/kit/fetch-gate/FetchChoice.tsx` — new
- `apps/mobile/src/kit/fetch-gate/gate.test.ts` — new
- `apps/mobile/src/kit/fetch-gate/gate.ts` — new
- `apps/mobile/src/kit/fetch-gate/index.ts` — new
- `apps/mobile/src/kit/fetch-gate/pin.test.ts` — new
- `apps/mobile/src/kit/fetch-gate/pin.ts` — new
- `apps/mobile/src/kit/fetch-gate/policy.ts` — new
- `apps/mobile/src/kit/replica/ReplicaStateCard.test.tsx` — new
- `apps/mobile/src/kit/replica/ReplicaStateCard.tsx`
- `apps/mobile/src/kit/replica/ReplicaStatusBar.test.tsx` — new
- `apps/mobile/src/kit/replica/ReplicaStatusBar.tsx`
- `apps/mobile/src/kit/replica/replica-mount.ts`
- `apps/mobile/src/kit/theme/generate.test.ts`
- `apps/mobile/src/kit/theme/generate.ts`
- `apps/mobile/src/kit/theme/index.ts`
- `apps/mobile/src/kit/theme/resolve.test.ts`
- `apps/mobile/src/kit/theme/resolve.ts`
- `apps/mobile/src/kit/theme/tokens.generated.ts`
- `apps/mobile/src/kit/transfer/transfer-consent.test.ts` — new
- `apps/mobile/src/kit/transfer/transfer-consent.ts` — new
- `apps/mobile/src/kit/transfer/transfer-policy.test.ts` — new
- `apps/mobile/src/kit/transfer/transfer-policy.ts` — new
- `apps/mobile/src/kit/transfer/transfer-queue.ts` — new
- `apps/mobile/src/kit/transfer/transfer-run.test.ts` — new
- `apps/mobile/src/kit/transfer/transfer-run.ts` — new
- `apps/mobile/src/lib/daily-brief.ts`
- `apps/mobile/src/lib/notifications.tsx`
- `apps/mobile/src/lib/replica/multi-vault-reader.ts`
- `apps/mobile/src/lib/seat.ts` — new
- `apps/mobile/src/lib/upload/native-policy.ts`
- `apps/mobile/src/lib/vault-links.test.ts`
- `apps/mobile/src/lib/vault-links.ts`
- `apps/mobile/src/navigation.ts`
- `apps/mobile/src/screens/Approvals.tsx`
- `apps/mobile/src/screens/Home.tsx`
- `apps/mobile/src/screens/Onboarding.test.tsx`
- `apps/mobile/src/screens/Settings.tsx`
- `apps/mobile/src/screens/home/AllAppsSheet.tsx`
- `apps/mobile/src/screens/home/AttentionLine.tsx` — deleted
- `apps/mobile/src/screens/home/DailyBriefCard.tsx` — deleted
- `apps/mobile/src/screens/home/FirstMoves.tsx` — new
- `apps/mobile/src/screens/home/FirstRunGrid.tsx` — deleted
- `apps/mobile/src/screens/home/GreetingHeader.tsx` — deleted
- `apps/mobile/src/screens/home/HomeBand.tsx`
- `apps/mobile/src/screens/home/HomeStatusLine.tsx` — new
- `apps/mobile/src/screens/home/HomeTitleRow.tsx` — new
- `apps/mobile/src/screens/home/LauncherGrid.tsx`
- `apps/mobile/src/screens/home/LauncherIconGrid.tsx` — deleted
- `apps/mobile/src/screens/home/SearchOverlay.test.tsx` — new
- `apps/mobile/src/screens/home/SearchOverlay.tsx`
- `apps/mobile/src/screens/home/TileBody.tsx`
- `apps/mobile/src/screens/home/VaultDrawer.tsx` — deleted
- `apps/mobile/src/screens/home/VaultHeader.tsx` — new
- `apps/mobile/src/screens/home/VaultsSwitcher.tsx`
- `apps/mobile/src/screens/home/band-cap.test.ts` — deleted
- `apps/mobile/src/screens/home/band-pins.test.ts` — deleted
- `apps/mobile/src/screens/home/band-pins.ts` — deleted
- `apps/mobile/src/screens/home/band.test.ts`
- `apps/mobile/src/screens/home/band.ts`
- `apps/mobile/src/screens/home/catalog.test.ts`
- `apps/mobile/src/screens/home/catalog.ts`
- `apps/mobile/src/screens/home/first-moves.test.ts` — new
- `apps/mobile/src/screens/home/first-moves.ts` — new
- `apps/mobile/src/screens/home/grid-packing.test.ts` — new
- `apps/mobile/src/screens/home/grid-packing.ts` — new
- `apps/mobile/src/screens/home/home-pins.ts` — new
- `apps/mobile/src/screens/home/home-status.test.ts` — new
- `apps/mobile/src/screens/home/home-status.ts` — new
- `apps/mobile/src/screens/home/places.test.ts` — new
- `apps/mobile/src/screens/home/places.ts` — new
- `apps/mobile/src/screens/home/search-model.test.ts`
- `apps/mobile/src/screens/home/search-model.ts`
- `apps/mobile/src/screens/home/tile-model.test.ts`
- `apps/mobile/src/screens/home/tile-model.ts`
- `apps/mobile/src/screens/home/useSearchRecents.ts`
- `apps/mobile/src/screens/home/useSpringboardTiles.ts`
- `apps/mobile/src/screens/onboarding-styles.ts`

**Docs** (4)

- `docs/blueprint-seats.md` — new
- `docs/decisions.md`
- `docs/glossary.md`
- `docs/platform-gating.md`

**Other** (8)

- `AGENTS.md`
- `QUALITY.md`
- `bun.lock`
- `package.json`
- `packages/agent-runtime/src/automation/run-automation.ts`
- `tests/experience-budgets/client-query-counts.json`
- `tests/quality/classification-ratchet.json`
- `tests/schema-export-fingerprint.json`

## Decisions

- **The sweep cannot refuse, so it does both halves.** `media.purge_asset` refuses a lineage source outright; the sweep instead orders descendants first and re-arms the purge window on what it must skip. NULLing the child would forge "camera original" (the schema says NULL means exactly that); cascading would destroy a photograph the member never trashed.
- **Custody reaches Photos through the entity registry, not an HTTP route.** A blueprint may never import `@centraid/client`, and an inline app's only data door is `ctx.vault.read` — a route plus reader would have been dead code that knip-strict fails, and would not have made the number reachable.
- **`local` does not mean "a local model".** Every `RunnerKind` is a coding-agent harness talking to a remote provider; the only on-device lane is the device work-lease lane. `local` therefore permits deterministic and device-lease work and refuses a model turn, with `ctx.agent` sealed as a backstop. An omitted lane reads as `model` — assuming the cheaper lane would be assuming consent.
- **Consequence, recorded rather than softened:** `local` is the seeded default and 7 of 8 shipped enrichers are model-routed, so they do not run until an owner raises the tier. That is why the tier control ships in the same change.
- **#711 Atlas first-paint budget rebase: registering blob_custody_rollup adds one deterministic countRows query; the measured 124-statement baseline is approved.** The new custody rollup is a registered canonical table and the extra read is the cost of measuring that real table, not an unbounded query increase.
- **#711 Photos v4 manifest classification rebase: the governed automation manifest changed with the PR's new Photos action surface; the reviewed fingerprint is intentionally updated.** The ratchet records the reviewed manifest bytes so future classification changes remain visible.
- **Explicit file-size waivers are part of the review.** Six cohesive v4 surfaces remain above the repository's 625-line hygiene threshold: `AlbumDetail.tsx`, `PhotoLightbox.tsx`, `PhotosHome.tsx`, `PhotosLibrary.tsx`, `tile-model.ts`, and `gateway-client-vault.ts`. Each carries a first-ten-line `governance: allow-repo-hygiene file-size-limit #711` waiver; splitting these interaction/policy modules solely to satisfy the threshold would add structural churn without changing the reviewed behavior.
- **SonarCloud reliability/maintainability findings are closed in-tree.** The v4 viewer and Photos paths now preserve NaN-safe guards while using Sonar-approved operators, readonly fields, nullish coalescing, `Math.max`, a `Set` membership guard, an explicit reduction callback, and a shallow album-position helper; no new-code issue is waived.

## Demonstrated red

Sabotage-verified — defect reintroduced, test confirmed red, reverted:

| Guard | Result when broken |
| --- | --- |
| `purge_asset`'s trashed + no-derived preconditions | 5 of 7 red, incl. "a live asset is refused" and "purging an edit's source is refused" |
| The sweep's lineage ordering and skip | 3 red, all `FOREIGN KEY constraint failed`, incl. the ordering test |
| The enrichment gate's `local` refusal | the `local`-refuses-remote test alone red (1 failed / 384) |
| All four free-up vetoes (remote tier, `cas`-only evidence, outbox, offer width) | 4 for 4 red, each restored to green |

## User impact

Photos is rebuilt against the v4 handoff on both clients, so a member sees a different app: a justified timeline with the handoff's page margin, a viewer with one video transport and a real zoom ladder, People with identity-coloured faces, and a Trash that can actually be emptied. The three surfaces that previously dead-ended — Picker, Permission, Duplicates — are reachable.

**First-run:** on a fresh vault Photos opens on the day-one empty state, not a grey grid; enrichment does **not** run until the member answers the §8 consent gate, and the seeded `local` tier means no photograph reaches a provider before that answer. A member who never opens Settings → Enrichment gets a Photos that never sends anything anywhere.

Two changes a member will feel immediately, both fixed here: the Home control in Photos returned as an inset card sheet over Photos instead of going home, and every tile carried a custody sentence (`on this device only` / `on the gateway`) under the photograph — now a single `CloudOff` mark on the one custody state a member can lose something to, and silence otherwise.

Visual evidence: `artifacts/e2e/ui-impact/issue-711-photos-v4.png`, emitted by `apps/desktop/tests/e2e/onboarding-home.spec.ts` (test 2.6b) with Photos open in the app view.

## Out of scope

- **Slideshow transport controls.** `createSlideshow` mounts; play/pause/interval are unbuilt.
- **Host band toggle.** `setBandOwner` has no caller on either client — both read the stored value and never write it.
- **"Surfaces and asks"** (prototype tab 24).
- **Mobile Import surface.**

Not built because no backend can make them honest — each renders the honest statement or nothing, never a dead control: backup policy switches, "Back up now", a "backup failing" verdict, a free-up button, per-copy provenance, cross-person face grouping, and **Sharing's grant roster** (`InlineScope` carries nothing about who else can reach a scope — the largest remaining hole, and a platform change rather than a Photos one).

## Verification

```
packages/blueprints   typecheck clean   71 files / 1017 tests
packages/vault        typecheck clean   137 files / 1104 (1 skipped)
packages/gateway      typecheck clean   193 files / 1301 (6 skipped)
packages/client       typecheck clean   230 files / 2003
apps/mobile           typecheck clean   109 files / 796
packages/automation   typecheck clean   27 files / 388
packages/app-engine   typecheck clean   58 files / 625
```

Green: `lint:css` (no dead classNames), `lint:mobile-design`, `lint:design-tokens`, `lint:aria-labels`, `lint:type-floor`, `knip`, `photos-vocabulary.test.ts`.

Every figure above was re-run directly rather than relayed from an agent report: three separate agent reports in this work misattributed a sibling's mid-edit state as a pre-existing failure.

After the parity passes, re-run at the end of the wave:

```
packages/design       typecheck clean   32 files / 331 tests
apps/mobile           typecheck clean   109 files / 816 tests
```

Green: `lint:hairline` (new), `lint:logical-insets` (new), `lint:mobile-design`, `lint:design-tokens`, `lint:design-md`, `lint:css`, and `knip` after removing the four genuinely unreachable mobile symbols/files (`AppIcon.tsx`, `lib/seat.ts`, `LauncherIconGrid.tsx`, `hydratePlacePins`).

Two regression gates were added and sabotage-verified (defect reintroduced → red → reverted → green): `lint:hairline` refuses `StyleSheet.hairlineWidth` anywhere in `apps/mobile/src`, and `lint:logical-insets` refuses the legacy `start:`/`end:` position props. The band's flex-sibling structure is likewise sabotage-verified by a test that fails when the band is re-wrapped in an absolute container.

**Device verification: done for the mobile Home and Photos surfaces.** Measured on an iPhone 17 Pro simulator by sampling device pixels, not by eye — page grounds (`#FDFDFC` neutral, `#F0EFED` mat, `#F5F4F2` cards, each matching the handoff's own `TONES`/`INK` tables), the app-bar seam (1.0pt `#EFEEEB`), control edges (1.0pt `#E5E4E1`), avatar geometry (30pt disc, 23.0pt overlap pitch, single initial), and the band (two plates, content ending above it with nothing clipped). The handoff's rendered values were read from its computed styles in a browser rather than from screenshots.

**Still not done: browser verification of the web surfaces.** The blueprint/client side of this issue remains unit-green only.

## Audit

Performed **in-session by the implementing agent**, not by a fresh-context sub-agent. Recording that plainly because the directive's intent is an independent reader, and a self-audit is weaker evidence — a reviewer should weight it accordingly and re-run the sub-agent pass if they want the stronger form.

- **(1) `## What changed` faithfully describes the diff — PASS with a stated limit.** Every claim in `## What changed` was written against work performed in-session, and `### Every file this change set touches` was generated mechanically from `git status`, so the inventory cannot drift from the diff. The limit: the narrative covers the *reasons* for 459 files at the level of themes, not per-file, so "no omission" is verified for the file list and asserted for the prose.
- **(2) Each `- [x]` item is realized in the diff — PASS.** Each completed item names a surface or capability with a corresponding path in the manifest. The one unchecked item (`Device and browser verification`) is deliberately unchecked: mobile is device-verified, the web half is unit-green only, and that asymmetry is stated in `## Verification` rather than hidden by a tick.
- **(3) The `## Checklist` mirrors the issue's checklist — PASS with a known divergence.** The receipt's items are abbreviated forms of #711's, and #711 additionally carries four "remaining" items (`enforceRetention`'s independent self-FK exposure, `vault-plane.ts`'s unlogged lineage counters, mobile Permission as a timeline takeover, and the final `manifest.json` regeneration) that are **not** claimed here and remain open on the issue.
- **REFUTED — the receipt over-claims band coverage.** `Mobile: … band on every non-lightbox screen` is checked, but `PlacesView`, `PlaceDetail`, `DuplicatesShelf`, `BackupHealth` and `PhotoPermission` render no band. The pattern is consistent across all five pushed More-sheet destinations, so it may be the intended detail-screen treatment — but the checklist item as written is not true of the diff. Tracked as P8 on [#712](https://github.com/srikanth235/centraid/issues/712); the claim or the code has to move before this merges.

## Steering

Recorded **in-session by the implementing agent**, not by a fresh-context sub-agent — same limitation, and same caveat, as `## Audit` above.

No row-level ledger table is emitted here: the accounting rows require a verified `(session, ordinal, timestamp)` triple per event, and this session's earlier steering happened across a compaction boundary where the exact timestamps are not recoverable. Inventing them to satisfy the row shape would put fabricated data in an audit ledger, which is worse than an absent one. The events themselves are recorded in prose instead.

- **Steering table completeness: PARTIAL.** Three corrections are attested for session `48c81d14-2c33-4329-8434-f0bc53e8729b`, all on the enrichment-tier design and all folded into [#712](https://github.com/srikanth235/centraid/issues/712) C5 rather than this change set: (1) *structural* — "the gateway is completely owned by user … when we say local, gateway is part of local infra", which refuted the `local`-excludes-gateway framing this receipt's own `## Decisions` still records as shipped; (2) *classifier* — the `off | local | model` naming is confusing; (3) *classifier* — three tier values suffice, no separate `provider` tier, because the member already wired their own runners. Earlier-session steering predates a context compaction and is not enumerated.
- **No non-steering message is recorded as a steering event: PASS** — only the three above are claimed.
- **Consequence a reviewer should know:** ruling (1) means the `local`-tier rationale in `## Decisions` ("`local` does not mean 'a local model'" … "the gateway is the thing that performs the egress") is **superseded**. The shipped *behaviour* is unaffected — every runner in the roster is remote, so the refusal stands — but the stated reason is wrong and the rename to `off | device | gateway` is tracked as #712 C5.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019fd2d3-c7e-1785952006-1 | codex | 019fd2d3-c7ed-7560-ad1d-fba528508aa1 | #711 | gpt-5.6-luna | 588178 | 0 | 28321024 | 62385 | 650563 | 9.4865 | 588178 | 0 | 28321024 | 62385 | fix(ci): restore PR gate invariants (#711) |
| codex-019fd2d3-c7e-1785952320-1 | codex | 019fd2d3-c7ed-7560-ad1d-fba528508aa1 | #711 | gpt-5.6-luna | 53700 | 0 | 1323776 | 8063 | 61763 | 0.5861 | 641878 | 0 | 29644800 | 70448 | fix(ci): restore PR gate invariants (#711) |
| codex-019fd2d3-c7e-1785952986-1 | codex | 019fd2d3-c7ed-7560-ad1d-fba528508aa1 | #711 | gpt-5.6-luna | 102302 | 0 | 6660608 | 13244 | 115546 | 2.1196 | 744180 | 0 | 36305408 | 83692 | fix(quality): close Sonar reliability findings (#711) |
