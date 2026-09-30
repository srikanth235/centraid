# Places: where the photographs were taken

How Photos answers "where was this", and why a location is a phrase before it is a point. Places is a facet of the Photos library, not an app: there is no separate crate for it ([D-1020-P5](../decisions.md#wave-4-lane-rulings-1020)).

## The layers

| Layer | What | Where |
| --- | --- | --- |
| **Names** | A coordinate adopts a nearby place the member already named | `find_or_create_place` in [`crates/vault/src/commands/media.rs`](../../crates/vault/src/commands/media.rs) |
| **Phrases** | A place becomes something a person would say out loud | [`crates/apps/photos/src/places.rs`](../../crates/apps/photos/src/places.rs) |
| **Disclosure** | What a place does, and does not, do when a copy leaves | the share half of the same module |

**There is no basemap, and a basemap remains a non-goal.** A tile request's URL _is_ a bounding box, so fetching one tells a tile server roughly where a member photographs — which is the disclosure this whole document exists to refuse. No map SDK is linked in either shell and none should be.

What the mobile shell _does_ draw is a **zero-egress coordinate plot**: `photos.places` under `PRESENTATION_MAP` plots `core_place`'s own `geo_lat`/`geo_lng` on a `Canvas` — equirectangular, normalised to the plotted rows' own bounding box, no network of any kind — and says so on the screen ("Nothing is fetched — this is drawn here from your own coordinates"). That is a picture of the member's own rows and not a map of the world; cards and plot are one screen with a `Presentation` parameter, not two.

Two more pictures are drawn the same way. **A plot pin is the place's newest photograph** with its count in the corner (v0's `places-pin.tsx`), and **a trip memory carries a sketch of its route** — its photographs' places in the order they were taken, drawn beside the trip's name from the member's own coordinates (`MemoryRow.route`, `PhotosMemoriesMachine.sketch`). Photographs with no place are a door, not only a count: the footer's sentence opens their shelf (`PhotoShelf.Place.unplaced`).

A place still reaches a member primarily as **words**. The plot is a second reading of rows the cards already show, and a place with no coordinate is omitted from it and counted in the footer rather than silently dropped — `PlaceRow.has_coordinate` is the only honest signal, because proto3 implicit presence puts neither double on the wire for a row at 0.0/0.0 and 0,0 is a real point in the Gulf of Guinea.

## Layer 1 — names

A place row is minted the moment a photograph arrives carrying GPS, by `find_or_create_place` on the `media` commit path. It resolves a coordinate in three steps, in falling order of how much the vault actually knows:

1. **A place the member already named, within ~170m** (`NAMED_PLACE_RADIUS_DEG`, a bounding box widened by `cos(lat)`). This is the one that makes Places readable on day one with no geocoding at all. The vault holds named places from the rest of the product — a home, an office, a venue on an event — and a photograph taken at one of them belongs to it. A named place whose name is itself coordinate-shaped does not count. The radius is deliberately far looser than the identity rung below: those are different questions. "Is this the same coordinate" is ~11m; "is this that place" has to cover a house and its garden.
2. **The exact rounded coordinate (~11m, four decimal places).** The identity rung that stops a burst of frames minting a row per shutter click. The row keeps the precise coordinates of whichever asset created it; only identity is rounded.
3. **A new row labelled with its own coordinates**, e.g. `39.0021, -120.1131`.

Step 3 mints a row whose stored name is a coordinate — and that name is never what a member reads. What they read is Layer 2's phrase.

Two commands write a place's name, and the split between them is the whole authority rule:

- **`media.name_place`** is the member's. It writes `name` and `kind` (`home | work | venue | city | region | other`) and nothing else. `kind` is how the ladder learns which place is Home. A blank name is refused, and 120 characters is the ceiling.
- **`media.set_place_gazetteer`** is the `place-names` recognition recipe's. It merges a settlement name into `address_json.gazetteer` (source `geonames-cities15000`) and records `{ none: true }` for a miss. It cannot reach `core_place.name` at all, and it carries no media bytes.

So **a member-entered name is authoritative and derived naming never overwrites it** — by construction rather than by convention. Coordinate-to-settlement naming is an opt-in, zero-egress recognition automation over a vendored open dataset ([recognition automations](../recognition-automations.md), [P-gazetteer](../decisions.md)).

## Layer 2 — the phrase ladder

Nobody experiences their life in coordinates, so no phrase prints one as a name. `place_phrase` resolves a place in falling order of what the vault knows, and always answers:

1. **The member's own name for it** — "Grandma's house".
2. **A gazetteer name, hedged** — "near South Lake Tahoe". The hedge is honest: the settlement table resolves to a town, not to the spot.
3. **A phrase relative to a place the member did name** — "3.4 km NE of Home". Home is preferred as the anchor within 25 km; otherwise the nearest named place. Inside 100m the bearing is dropped ("At Home") because a compass point is noise at that range, and past 250 km the rung gives up rather than print a direction nobody thinks in. The home bands are `at home` under 0.5 km and `around town` under 25 km (`AT_HOME_KM`, `AROUND_TOWN_KM`).
4. **"A place with no name yet"** (`PLACE_NO_NAME`) — never the coordinate, which would look like an answer.

**The text is never coordinate-shaped, for any input.** `printable_name` refuses a coordinate-shaped label at every rung, which is why a gazetteer that wrote digits into a name cannot leak them through the phrase. `exact_location` is the one function that prints digits, behind an explicit member action.

**It takes a context.** In `PhraseContext::Shared` the relative rung is skipped entirely — see Layer 3. A distance and a bearing from the reader's own home is worse in an export than the coordinate it replaced, because it reads as harmless.

Because a place is phrased through the ladder rather than through a stored string, **naming a place re-phrases every read at once**. There is no backfill and no cache to invalidate. The places read is `photos.shared.places`, a walk over `core_place` with a stated ceiling; a malformed `address_json` reads as no gazetteer name rather than failing the shelf.

## Layer 3 — what leaves with a copy

A photograph on the member's screen and the same photograph in somebody else's hands are two different disclosures. `SharePrecision` has three rungs, safest first and the default:

| Rung | What travels |
| --- | --- |
| **`None`** (default) | Nothing. The file's own location is to be removed. |
| **`Name`** | The ladder's phrase in the shared context, as words. The location is still removed (`share_place_strips_location`). |
| **`Exact`** | The original file, fix and all. |

There is no separate "city" rung because the granularity a share can carry is the granularity the ladder already has: rung 2 _is_ the settlement name. The default is the one that discloses nothing, because "they could have turned it off" is not consent. `share_place_receipt` states what went, `None` included, every time.

The Home-relative rung never leaves: `shared_place_phrase` hard-wires the shared context, and `share_place_name` is the only name a share may carry.

Renditions are a separate guarantee: a `thumb` or `preview` is re-encoded from decoded pixels, so it carries no EXIF, XMP or ICC at all ([Photos](README.md#derivatives)).
