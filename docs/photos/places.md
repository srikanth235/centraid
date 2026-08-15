# Places: where the photographs were taken

How Photos answers "where have I been" on both surfaces, why the web and phone draw the same projection, and why there is no basemap under it.

## The three layers

Places has three independently owned layers. Each remains useful without the layers above it.

| Layer | What | Where |
| --- | --- | --- |
| **Names** | A coordinate adopts a nearby place the member already named | `findOrCreatePlaceTx` |
| **Geometry** | Coordinates become pin positions, shared by both surfaces | [`place-map.ts`](../../packages/blueprints/apps/photos/place-map.ts) |
| **Cartography** | The pin is a photograph; a scale bar and north say the rest | The two renderers |

## Layer 1 — names

A place row is minted the moment a photograph arrives carrying GPS, by `findOrCreatePlaceTx` ([`packages/vault/src/commands/media.ts`](../../packages/vault/src/commands/media.ts)). It resolves a coordinate in three steps, in falling order of how much the vault actually knows:

1. **A place the member already named, within ~170m.** This is the one that makes Places readable on day one with no geocoding at all. The vault holds named places from the rest of the product — a home, an office, a venue on an event — and a photograph taken at one of them belongs to it. Without this, a member who carefully named where they live still gets a shelf of coordinate strings. The radius is deliberately far looser than the identity rung below: those are different questions. "Is this the same coordinate" is ~11m; "is this that place" has to cover a house and its garden.
2. **The exact rounded coordinate (~11m).** The identity rung that stops a burst of frames minting a row per shutter click. The row keeps the precise coordinates of whichever asset created it; only identity is rounded.
3. **A new row labelled with its own coordinates**, e.g. `39.0021, -120.1131`.

Step 3 remains an unnamed placeholder. Automatic coordinate-to-settlement naming is not part of the current recognition-automations architecture: unlike OCR, faces, or embeddings it needs a separately licensed gazetteer and carries no member bytes to recognise. If that capability returns, it must be designed as a self-contained automation against the current architecture. A member-entered name must remain authoritative and must never be overwritten by derived data.

## Layer 2 — one projection, two renderers

The geometry lives in [`place-map.ts`](../../packages/blueprints/apps/photos/place-map.ts) and imports nothing: no React, no stylesheet, no token. Both surfaces run it and draw the result with the primitive they have — SVG in the browser, `react-native-svg` on the phone. The two Places surfaces agree because they execute the same arithmetic.

What the projection is careful about:

- **Longitude is scaled by the cosine of the centre latitude.** Ignoring this is what makes naive plots of northern trips look stretched; a Tahoe roll at 39°N comes out 29% too wide.
- **One scale on both axes.** Fitting each axis independently would stretch a north–south trip into a square and lie about its shape.
- **Merging happens in PIXELS, not degrees.** Two places 11m apart are two rows in the ledger and one dot on any map wide enough to hold a trip. Whether they collide is a question about the drawing, so it is asked in the drawing's units.
- **The surviving name after a merge is the largest place's**, not whichever was read first.

## Layer 3 — cartography, and the basemap that is not there

**Each pin is a photograph taken at that place**, with the count on it. The map is intentionally photographic rather than a coordinate-labelled graticule: a member can recognise a kitchen window or a lake view without learning a coordinate vocabulary.

Consequences worth knowing:

- **A name is printed only when it is one a person would recognise.** `readableName` refuses a coordinate-shaped label on both surfaces and in the shelf headings; a place with nothing better to say is "A place with no name yet". Never the coordinate — that looks like an answer. This is the display-side twin of `isCoordinateLabel`, deliberately duplicated because a blueprint does not link the vault package.
- **The merge distance is a pin's full width**, not a dot's. Measured on the seeded roll: at 40px two Tahoe pins landed 54px apart and covered 45×15px of each other. Centres closer than the widest pin cannot both be seen, and a merged pin at least says how many places it stands for.
- **The grid carries no numbers.** It is rhythm. Labelled, it starts asking to be read in a vocabulary the reader never chose; the scale bar answers "how far apart" in one phrase instead.
- **`img-src 'self' data:` is what makes this safe.** The pins are images now, so "no `<image>` in the markup" was the wrong test — the real claim, asserted in `PlaceMap.test.tsx`, is that every source is same-origin or inline.

Under the pins is a grid at a chosen degree step, a scale bar, and a north mark. There is no land.

That is a deliberate non-goal. A browser basemap means requesting tiles from a third-party server, and **every tile URL is a location** — `/z/x/y` at z16–18 pins a viewer to roughly 150m, one request per tile per pan. The shell's own CSP is what holds the line now that #799 retired the per-app blueprint CSP; `PlaceMap.test.tsx` asserts the product claim directly — every pin source is same-origin or inline.

The phone draws the shared projection as well. The `react-native-maps` dependency remains in `package.json` pending a native rebuild; the open quality item is recorded in [QUALITY.md](../../QUALITY.md).

Note also that `tile.openstreetmap.org` is not an option even setting privacy aside: the OSMF usage policy rules out app and heavy use, so "just use OSM" means a commercial tile host with an API key.

**If a basemap is ever wanted**, the projection being separate from the rendering is what makes it a layer under the same pins rather than a rewrite. In rising order of cost: gateway-proxied tiles (the browser talks only to the gateway, which caches — CSP stays `'self'`); the same behind an opt-in consent gate; or owner-imported PMTiles/MBTiles for a region, which is the only one with genuinely zero egress. Any of them needs a Web Mercator mode in `projectPlaces` to register with tile pyramids — at trip scale the two projections differ by under a pixel, but they are not the same function.

A vendored coastline outline (Natural Earth 110m is ~100–200KB as TopoJSON) is the cheaper middle path: real land, no network, no tile pyramid. It is not in yet because vendoring it needs a download the work could not perform.

## Seeded data

The Photos scenario seeds 16 located frames across 9 places ([`seed.js`](../../packages/blueprints/apps/photos/seed.js)); `demo-seed.test.ts` pins shared coordinates, People/Places overlap, and unlocated frames.
