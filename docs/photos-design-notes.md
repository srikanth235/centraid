# Photos — sanctioned design divergences

Photos is the pattern-setter for the v9 design system: 22 of its 26 specified screens match the brief metric for metric, and the places where it _doesn't_ are, with two exceptions, settled product decisions rather than drift.

This file exists so the next agent does not "fix" them. Everything below is a divergence from the v9 Photos brief that a reviewer will notice, plus the decision, the reason and where the reason is enforced. If you are about to make the repo match the brief on one of these lines, read the row first — and if you still think the brief is right, change the decision in the open (an issue, a receipt, this file), never quietly in a component.

Related: [docs/decisions.md](decisions.md) (settled #468 decisions), [DESIGN.md](../DESIGN.md) (the binding rulebook), [docs/design-machinery.md](design-machinery.md) (lowering ownership), [docs/glossary.md](glossary.md) (vocabulary and forbidden synonyms).

## Copy

| Divergence | Decision | Why |
| --- | --- | --- |
| The brief's storage noun **"vault"** does not appear in Photos copy. Search's unreachable state reads `Cannot reach the gateway` / `Search needs the gateway`, not "Cannot reach the vault"; the enrichment-consent strings say "library". | Keep. Enforced mechanically by `packages/blueprints/src/photos-vocabulary.test.ts`. | Issue #599: Photos mounts over several scopes at once, so "this vault" stops being unambiguous the moment a household exists. The fact survives the word — the index lives on the gateway, and that is what the copy says. Settled as S6 in [docs/decisions.md](decisions.md). |
| **Storage says less than the brief's Storage screen.** No figure display, no backup-policy block, no "Back up now", no failing verdict, and no cause-split for offloaded originals. | Keep. See the file header in `packages/blueprints/apps/photos/components/Storage.tsx` and the annotations in `view-copy.ts` (`STORAGE_COPY`). | Every number on that screen is read, never invented. The brief's numbers are sample data; the projection this seat can actually read (`blob.custody_rollup`, issue #711) carries no attempt count, no radio state and no OS-offload cause. A control that reported nothing and moved nothing would be a lie with a hit target. |
| **Search's miss body** is `Nothing in captions, people, places, things or album names.` — mobile's wording plus one word. | Keep. Annotated in `SEARCH_COPY.miss` (issue #711 reconciliation). | Mobile's replica has no tag entity, so its honest list omits "things"; this client genuinely matches free-form tags. The two surfaces say the same thing everywhere they agree and differ only where the truth differs. |
| **People's pending-faces note carries a live count**, not the brief's fixed "54" — and omits the number entirely until the count has loaded. | Keep. `peoplePendingNote()` in `view-copy.ts`. | A count that never changed would eventually lie, and a zero that has not been read is a claim, not a default (§14). |
| **Import counts "photographs", not "assets"**, and says what a dedupe did rather than what it imported. | Keep. `components/Import.tsx`. | "Asset" is the schema's word, not the member's ([docs/glossary.md](glossary.md)). Identical bytes become one photograph; the copy reports that outcome instead of a file count that would overstate what arrived. |
| **The permission screen carries two fact rows, not the brief's three.** The missing row is "What is true right now" / "6,214 photographs, all still in the vault" / meta "unchanged". | Keep, for now. Annotated at `PERMISSION_COPY` in `packages/blueprints/apps/photos/view-copy.ts` (issue #765). | A denial arrives as `own.denied` on the own scope and the read it rides in on carries no rows, so at render time this app holds no count to print. A count kept from before the grant went is exactly the stale copy the screen exists to refuse. If the host ever hands the denial a library count, the row goes in as specified and the annotation comes out. |

The two remaining brief screens Photos does **not** implement at all — the `sharing` screen and the `system` design-rationale appendix — are also decisions, not gaps. Sharing consolidated into the vault sharing plane (#750, #726); the appendix is documentation, and it lives here and in [DESIGN.md](../DESIGN.md) rather than as a screen inside a product.

## Mobile (G2–G4)

The phone is a different surface, not a narrower copy of the desktop. Three deliberate departures:

- **G2 — the band set is `Library · Collections · Search · More`,** not the desktop shelf strip's destinations. Albums, Places, People, Memories and Duplicates are _collections_; folding them into one destination is what keeps the band inside its five-destination cap (`BAND_MAX_DESTINATIONS`) with room for More. Model in `apps/mobile/src/apps/photos/photos-band.ts`, rendered by `PhotosBand.tsx` (issue #712).
- **G3 — the More sheet is one row, and it does not carry tile size.** Tile size is a member preference the grid already takes by pinch, and a stepper you may press once is not a stepper, so it left the sheet (`PhotosMoreSheet.tsx`, asserted by `PhotosMoreSheet.test.tsx`).
- **G4 — the frame's Home capsule sits at the LEADING edge, outside the app's tab group.** Two separate plates in a transparent row with an 8pt seam between them, never one plate with a capsule inside it. CHANGELOG §F's prose says trailing; README §3.1 and the shipped web shell both say leading, and leading is what mirrors correctly under RTL (§18). The reasoning is in the header of `photos-band.ts` and the anatomy block in `PhotosBand.tsx`.

Also deliberate on the phone: the Library's **grain control (Years · Months · All) is permanent** — never scroll-armed, never on a timer, never dimmed by activity, because it is the only path to a whole feature and an invisible front door means the rooms behind it do not exist (`TimelineGrainControl.tsx`). The grid skeleton is drawn at the packed geometry the photographs will occupy, so nothing reflows when bytes land.

## Colour-role decisions (v9, issue #765)

**`--seam` is adopted for the expiring and in-flight states, and only those.** The role names "not yet, and not wrong: pending, expiring, invited", which is exactly what three figures in Photos are:

- Trash's per-tile purge countdown, on both surfaces (`components/Tile.module.css` `.state.expiring`; `apps/mobile/src/apps/photos/tile-overlays.ts` tone `seam`).
- Storage's `pending` backup verdict and its "Queued to be copied elsewhere" row (`components/Storage.module.css` `.pending`).

In every case it is **ink only**: same slot, same size, same numeric register. The point of the role is that these states no longer have to choose between looking settled and borrowing `--net`, which would paint a shelf of perfectly ordinary trashed photographs as an alarm.

**`--net-wash` is deliberately NOT used in Photos.** The wash is a real role — the one tint of `--net` the system permits — and the control library uses it for a destructive control's hover ground and a destructive menu row. Photos has neither. What Photos has is a set of _panels_:

- the offline banner (`components/OfflineBanner.module.css`),
- the refused-write panel in the lightbox info rail (`components/LightboxInfo.module.css`),
- the permission screen's refusal rule (`components/Permission.module.css`).

All three stay border-and-ink. The brief itself draws them bordered, and Photos' own rule — stated in three separate file headers before v9 — is that `--net` is a border or a 2px rule and never a ground. Offline in particular is a state the product is _designed for_: everything behind the banner is still true, and tinting the banner's interior would turn an expected state into an alarm. Border-only is spec-blessed, so this is a decision, not debt. Revisit only if Photos grows a genuinely destructive or egress _panel_ (not a control, not a notice) — and record it here.

## Controls

- **Tile size is a 4-segment control (XS S M L), not a − / + stepper** (issue #765, `components/Toolbar.tsx`). The rung model is unchanged: one member preference, one clamp (`stepTileSize`), walked by a delta — pinch on the phone and the segments on the pointer surface are two ways into the same property. The group is named `Tile size N of 4`; the segments are named by their own visible text and carry `aria-pressed`, because they are one property's four rungs and not four named views.
- **Mobile keeps its own `TimelineGrainControl`** and does not adopt the segmented shape. Grain on the phone is a different property from tile size on a pointer surface, and it is reachable by pinch as well.
- **Album and People grids state a column COUNT, not a card width** (`AlbumGrid.module.css` 4/2, `People.module.css` 6/3, same breakpoint). `auto-fill` with a minimum width was right at the two window sizes anybody checked and wrong either side of them.

## What is verified metric-perfect — do not "improve" it

Packing (gutter 2, rungs 92/128/176/248 pointer and 64/88/120/168 touch, 0.28 overshoot, 1.25 last-row cap), the tile's four overlay slots and their rung gates, the loading skeleton's packed geometry, the viewer stack, the scrub rails (14 pointer / 44 phone overlay), the filmstrip (84/60 and 58/40), the info rail (320 / 64% sheet), the memories strip (250×120 and 200×96), and the mono direction ruling. These match the brief exactly; a change here is a regression until a test says otherwise.
