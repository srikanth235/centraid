# Places: where the photographs were taken

How Photos answers "where was this" and "where have I been" on both surfaces, why a location is a phrase before it is a point, and what is drawn under the pins on each ground.

## The four layers

Places has four independently owned layers. Each remains useful without the layers above it.

| Layer | What | Where |
| --- | --- | --- |
| **Names** | A coordinate adopts a nearby place the member already named | `findOrCreatePlaceTx` |
| **Phrases** | A place becomes something a person would say out loud | [`place-phrase.ts`](../../packages/blueprints/apps/photos/place-phrase.ts) |
| **Geometry** | Coordinates become pin positions and a zoom tier, shared by every ground | [`place-map.ts`](../../packages/blueprints/apps/photos/place-map.ts) |
| **Cartography** | The pin is a photograph; the ground under it is one of two | The three renderers |

## Layer 1 — names

A place row is minted the moment a photograph arrives carrying GPS, by `findOrCreatePlaceTx` ([`packages/vault/src/commands/media.ts`](../../packages/vault/src/commands/media.ts)). It resolves a coordinate in three steps, in falling order of how much the vault actually knows:

1. **A place the member already named, within ~170m.** This is the one that makes Places readable on day one with no geocoding at all. The vault holds named places from the rest of the product — a home, an office, a venue on an event — and a photograph taken at one of them belongs to it. Without this, a member who carefully named where they live still gets a shelf of coordinate strings. The radius is deliberately far looser than the identity rung below: those are different questions. "Is this the same coordinate" is ~11m; "is this that place" has to cover a house and its garden.
2. **The exact rounded coordinate (~11m).** The identity rung that stops a burst of frames minting a row per shutter click. The row keeps the precise coordinates of whichever asset created it; only identity is rounded.
3. **A new row labelled with its own coordinates**, e.g. `39.0021, -120.1131`.

Step 3 mints a row whose stored name is a coordinate — and that name is never what a member reads. What they read is Layer 2's phrase.

Two commands write a place's name, and the split between them is the whole authority rule:

- **`media.name_place`** is the member's. It writes `name` and `kind` and nothing else. `kind` is how the ladder learns which place is Home.
- **`media.set_place_gazetteer`** ([`media-gazetteer.ts`](../../packages/vault/src/commands/media-gazetteer.ts)) is the opt-in gazetteer automation's. It `json_set`-merges a settlement name into `address_json.gazetteer` and records `{ none: true, checked_at }` for a miss. It cannot reach `core_place.name` at all.

So **a member-entered name is authoritative and derived naming never overwrites it** — by construction rather than by convention. That supersedes the older ruling here that coordinate-to-settlement naming needed a separately licensed gazetteer and so could not exist: it ships as a self-contained, opt-in, zero-egress recognition automation over a vendored open dataset ([`docs/recognition-automations.md`](../recognition-automations.md), [`docs/decisions.md`](../decisions.md) P-gazetteer).

## Layer 2 — the phrase ladder

Nobody experiences their life in coordinates, so no surface in Photos prints one as a name. [`place-phrase.ts`](../../packages/blueprints/apps/photos/place-phrase.ts) resolves a place to a phrase in falling order of what the vault knows:

1. **The member's own name for it** — "Grandma's house".
2. **A gazetteer name, hedged** — "near South Lake Tahoe, CA". The hedge is honest: the settlement table resolves to a town within 50 km, not to the spot.
3. **A phrase relative to a place the member did name** — "3.4 km NE of Home". Bands: `at home` under 0.5 km, `around town` under 25 km, `away` beyond. Inside 100m the bearing is dropped ("At Home") because a compass point is noise at that range, and past 250 km the rung gives up rather than print a direction nobody thinks in.
4. **"A place with no name yet"** — never the coordinate, which would look like an answer.

Two properties of this module are load-bearing:

- **It is pure and import-free**, exactly as `place-map.ts` is. Both surfaces execute the same arithmetic, so the web panel and the phone sheet cannot drift on what they say about one place. That is also why the "A place with no name yet" string and the coordinate-shaped-label regex are _duplicated_ rather than imported, with a comment at both ends of every copy.
- **It takes a context.** In `context: "shared"` the relative rung is skipped entirely — see Layer 4. A distance and a bearing from the reader's own home is worse in an export than the coordinate it replaced, because it reads as harmless.

Because every surface phrases a place through the ladder rather than through a stored string, **naming a place re-phrases every surface at once** — the lightbox row, the shelf heading, the search hit, the memory card. There is no backfill and no cache to invalidate. The "Name this place?" and "This is home" prompts sit over clusters of photographs at unnamed places on both surfaces.

The ladder is also the search vocabulary. A place answers to the member's name for it, to its gazetteer name, and — for places inside the `at home` / `around town` bands of the `kind = 'home'` place — to "home", "at home" and "near home". Photographs carrying no place at all get a browsable bucket, "No location yet", under one reserved key spelled identically on both surfaces.

And it is how a trip gets its title. Trip cards ([`trips.ts`](../../packages/blueprints/apps/photos/trips.ts)) use the **top two rungs only** and drop the "near" hedge, because a title is a claim rather than a caption: "Weekend in South Lake Tahoe, CA", "A week in …", "N days in …". A title never carries a relative phrase or a coordinate. The day-span grammar (weekend, week) is display-side and tunable; the vault's own `TRIP_GAP_DAYS` / `TRIP_MIN_AWAY_DAYS` are not, and the vault's day count wins when it disagrees with the frames.

## Layer 3 — one projection, three grounds

The geometry lives in [`place-map.ts`](../../packages/blueprints/apps/photos/place-map.ts) and imports nothing: no React, no stylesheet, no token. Three renderers run it — the web's SVG, the phone's SVG sketch, and the phone's basemap overlay — and they agree because they execute the same arithmetic.

What the projection is careful about:

- **Longitude is scaled by the cosine of the centre latitude.** Ignoring this is what makes naive plots of northern trips look stretched; a Tahoe roll at 39°N comes out 29% too wide.
- **One scale on both axes.** Fitting each axis independently would stretch a north–south trip into a square and lie about its shape.
- **Merging happens in PIXELS, not degrees.** Two places 11m apart are two rows in the ledger and one dot on any map wide enough to hold a trip. Whether they collide is a question about the drawing, so it is asked in the drawing's units.
- **The surviving name after a merge is the largest place's**, not whichever was read first.

### The zoom tier

A map that merges only by pin width is honest at trip scale and useless once a member zooms in, so the module also owns a camera and a tier: **`countries` → `cities` → `spots`**, chosen by km-per-pixel. The merge distance is `max(pin width, tier floor ÷ km-per-pixel)` — the _drawing_ decides while pins are the bigger constraint, and the _ground_ decides once a member zooms past what the ledger can resolve.

The consequence worth stating plainly: **the map never splits two places closer than 50m**, because the place ledger's identity rung is ~11m and pretending to resolve below that would draw a distinction the data does not carry. Both surfaces print the tier beside the scale bar, so the grouping a member is looking at is named rather than guessed at.

Pin separation at a given camera is **box-independent** — a 358pt phone map and a 640px web figure merge the same places — and `place-map.test.ts` asserts exactly that, which is what makes "three grounds, one projection" a claim rather than a hope.

## Layer 4 — cartography, and which ground

**Each pin is a photograph taken at that place**, with the count on it, on every ground. The map is intentionally photographic rather than a coordinate-labelled graticule: a member can recognise a kitchen window or a lake view without learning a coordinate vocabulary.

Consequences worth knowing, on every ground:

- **A name is printed only when it is one a person would recognise.** `readableName` refuses a coordinate-shaped label on both surfaces and in the shelf headings; a place with nothing better to say falls to the ladder. This is the display-side twin of `isCoordinateLabel`, deliberately duplicated because a blueprint does not link the vault package.
- **The merge distance is a pin's full width**, not a dot's — floored by the tier, as above. Measured on the seeded roll: at 40px two Tahoe pins landed 54px apart and covered 45×15px of each other. Centres closer than the widest pin cannot both be seen, and a merged pin at least says how many places it stands for.
- **Clustering is ours on both platforms.** `expo-maps` ships none at all, and MapLibre's `GeoJSONSource` clusterer is deliberately unused because it is a different function with different answers. The providers are handed pins and never decide grouping — which is the reason the two platforms cannot disagree with each other or with the web.

### The phone: a real map by default, a sketch by choice

Cartography is two-mode on mobile, and the real map is the **default** ([`docs/decisions.md`](../decisions.md) P-cartography):

- **iOS renders Apple MapKit through `expo-maps`** (`~57.0.1`, pinned by `expo/bundledNativeModules.json`; dev client only — the package is still alpha).
- **Android renders MapLibre** (`@maplibre/maplibre-react-native` 11.3.6) over OpenFreeMap's `liberty` vector style.

Both are keyless: no account, no vendor API key in the app, no location permission asked for by either. The split is not taste — `expo-maps`' Android side is Google Maps plus Play Services plus a key, which is the exact dependency the ruling avoids, so it is iOS-only here; the MapLibre plugin keeps `locationEngine: "default"` so no Play Services arrive on Android either.

**OSM attribution renders on the Android map** as a permanent line, `© OpenStreetMap contributors`, rather than behind MapLibre's attribution button, which is disabled. iOS carries no OSM credit because it uses no OSM data — MapKit draws its own legal notice.

**"Use real maps"** is a device-persisted member preference (`photos.placesMapMode`, default `real`) on the same `Store.hydrate` + `useSyncExternalStore` precedent as the tile-size rung, and its control is a two-row menu on the Places map's own header. Switching it off swaps in the **Private sketch**: the same shared projection, drawn with `react-native-svg`, with no map SDK constructed at all.

A note on `expo-maps` that is a product fact rather than a workaround: its marker and annotation press events are **iOS 18+**, and the app's deployment target is deliberately left at 17.5. So a pin tap is not an SDK event — it is `onMapClick`'s coordinate, projected through `place-map.ts` and hit-tested against our own pin positions. The same arithmetic that draws the pins is the arithmetic that finds the tapped one.

### What the base layer sees, and what it does not

In real-map mode the map provider is handed **a viewport and nothing else**. The pins are drawn over the basemap by the app, so no photograph, name, phrase, or unshown coordinate reaches the provider on either platform. What it can infer is which areas a member opens — and that is disclosed as a permanent line under the map rather than behind a consent gate, because it is base-layer traffic a member turns off with one switch (P-egress). Turned off, and on web always, the map constructs no SDK and fetches nothing; `PlacesMap.test.tsx` asserts both halves of that as mode-shaped claims — the old "the map fetches nothing" assertion was widened in the same change that shipped the real map, never deleted ahead of it.

Trip-card covers always render the offline projection, in either mode: a card is an artifact rather than a live view, and it has to draw with no network.

### The web: still no land, for the reason that was always true

Under the pins on the web is a grid at a chosen degree step, a scale bar, a north mark, and no land. That remains a deliberate non-goal, and the no-basemap ruling that once covered every surface is now scoped to the one it was actually derived for.

A browser basemap means requesting tiles from a third-party server, and **every tile URL is a location** — `/z/x/y` at z16–18 pins a viewer to roughly 150m, one request per tile per pan. The shell's own CSP is what holds the line now that #799 retired the per-app blueprint CSP; `PlaceMap.test.tsx` asserts the product claim directly — every pin source is same-origin or inline.

- **`img-src 'self' data:` is what makes this safe.** The pins are images, so "no `<image>` in the markup" was the wrong test — the real claim is that every source is same-origin or inline.
- **The grid carries no numbers.** It is rhythm. Labelled, it starts asking to be read in a vocabulary the reader never chose; the scale bar and the tier name answer "how far apart" in one phrase instead.

Note that `tile.openstreetmap.org` is not an option even setting privacy aside: the OSMF usage policy rules out app and heavy use, so "just use OSM" means a commercial tile host with an API key. OpenFreeMap is precisely the answer to that — free planet-wide OSM-derived vector tiles, no key, no account, no usage cap, donation-funded and self-hostable — which is why it is what the phone talks to on Android and why it does not resolve the web question, where the CSP is the constraint rather than the vendor.

**If land is ever wanted on the web**, the projection being separate from the rendering is what makes it a layer under the same pins rather than a rewrite. In rising order of cost: gateway-proxied tiles (the browser talks only to the gateway, which caches — CSP stays `'self'`); the same behind an opt-in consent gate; or owner-imported PMTiles/MBTiles for a region, which is the only one with genuinely zero egress. Any of them needs a Web Mercator mode in `projectPlaces` to register with tile pyramids — at trip scale the two projections differ by under a pixel, but they are not the same function. (`tileZoomFor` is not that: it is a scale conversion for handing an SDK an opening viewport.)

A vendored coastline outline (Natural Earth 110m is ~100–200KB as TopoJSON) remains the cheaper middle path for the sketch, and is not in.

## Seeded data

The Photos scenario seeds 16 located frames across 9 places ([`seed.js`](../../packages/blueprints/apps/photos/seed.js)); `demo-seed.test.ts` pins shared coordinates, People/Places overlap, and unlocated frames. The frames sit at day _offsets_ from today, so whether the seeded Tahoe run covers a weekend depends on the day it is seeded — the card honestly reads `Weekend in …` or `N days in …` accordingly, and the exit-criterion test pins explicit Saturday/Sunday fixtures rather than depending on the clock.
