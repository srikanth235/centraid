# Places: where the photographs were taken

How Photos answers "where have I been" on both surfaces, why the web and the phone now draw the same picture, and why there is no basemap under it.

## The three layers

Places is built in three layers that ship independently. Each is useful without the ones above it, which is why they were built in this order.

| Layer | What | Where |
| --- | --- | --- |
| **Names** | A coordinate adopts a nearby place the member already named | `findOrCreatePlaceTx` |
| **Geometry** | Coordinates become pin positions, shared by both surfaces | [`place-map.ts`](../packages/blueprints/apps/photos/place-map.ts) |
| **Cartography** | The pin is a photograph; a scale bar and north say the rest | The two renderers |

## Layer 1 — names

A place row is minted the moment a photograph arrives carrying GPS, by `findOrCreatePlaceTx` ([`packages/vault/src/commands/media.ts`](../packages/vault/src/commands/media.ts)). It resolves a coordinate in three steps, in falling order of how much the vault actually knows:

1. **A place the member already named, within ~170m.** This is the one that makes Places readable on day one with no geocoding at all. The vault holds named places from the rest of the product — a home, an office, a venue on an event — and a photograph taken at one of them belongs to it. Without this, a member who carefully named where they live still gets a shelf of coordinate strings. The radius is deliberately far looser than the identity rung below: those are different questions. "Is this the same coordinate" is ~11m; "is this that place" has to cover a house and its garden.
2. **The exact rounded coordinate (~11m).** The identity rung that stops a burst of frames minting a row per shutter click. The row keeps the precise coordinates of whichever asset created it; only identity is rounded.
3. **A new row labelled with its own coordinates**, e.g. `39.0021, -120.1131`.

Step 3 remains an unnamed placeholder. Automatic coordinate-to-settlement naming is not part of the current recognition-automations architecture: unlike OCR, faces, or embeddings it needs a separately licensed gazetteer and carries no member bytes to recognise. If that capability returns, it must be designed as a self-contained automation against the current architecture. A member-entered name must remain authoritative and must never be overwritten by derived data.

## Layer 2 — one projection, two renderers

The geometry lives in [`place-map.ts`](../packages/blueprints/apps/photos/place-map.ts) and imports nothing: no React, no stylesheet, no token. Both surfaces run it and draw the result with the primitive they have — SVG in the browser, `react-native-svg` on the phone. The two Places surfaces agree because they execute the same arithmetic, not because someone kept them in step.

What the projection is careful about:

- **Longitude is scaled by the cosine of the centre latitude.** Ignoring this is what makes naive plots of northern trips look stretched; a Tahoe roll at 39°N comes out 29% too wide.
- **One scale on both axes.** Fitting each axis independently would stretch a north–south trip into a square and lie about its shape.
- **Merging happens in PIXELS, not degrees.** Two places 11m apart are two rows in the ledger and one dot on any map wide enough to hold a trip. Whether they collide is a question about the drawing, so it is asked in the drawing's units. The phone's predecessor used a fixed 0.1° bucket, which merged two towns on a country-wide map and split one street on a city one.
- **The surviving name after a merge is the largest place's**, not whichever was read first.

## Layer 3 — cartography, and the basemap that is not there

**Each pin is a photograph taken at that place**, with the count on it. This replaced outline dots on a graticule labelled in degrees down both margins — which was accurate, drawn to scale, and unreadable. Nobody remembers a weekend as `39.0°N`, and until a gazetteer is installed the place's _name_ is a coordinate too, so the first version said the same unhelpful thing twice. Recognition does what labelling could not: you know your own kitchen window on sight, and you can see it sits a long way south of the lake.

Consequences worth knowing:

- **A name is printed only when it is one a person would recognise.** `readableName` refuses a coordinate-shaped label on both surfaces and in the shelf headings; a place with nothing better to say is "A place with no name yet". Never the coordinate — that looks like an answer. This is the display-side twin of `isCoordinateLabel`, deliberately duplicated because a blueprint does not link the vault package.
- **The merge distance is a pin's full width**, not a dot's. Measured on the seeded roll: at 40px two Tahoe pins landed 54px apart and covered 45×15px of each other. Centres closer than the widest pin cannot both be seen, and a merged pin at least says how many places it stands for.
- **The grid carries no numbers.** It is rhythm. Labelled, it starts asking to be read in a vocabulary the reader never chose; the scale bar answers "how far apart" in one phrase instead.
- **`img-src 'self' data:` is what makes this safe.** The pins are images now, so "no `<image>` in the markup" was the wrong test — the real claim, asserted in `PlaceMap.test.tsx`, is that every source is same-origin or inline.

Under the pins is a grid at a chosen degree step, a scale bar, and a north mark. There is no land.

That is a decision, not a gap. A browser basemap means requesting tiles from a third-party server, and **every tile URL is a location** — `/z/x/y` at z16–18 pins a viewer to roughly 150m, one request per tile per pan. In a product whose gateway refuses a non-loopback enrichment URL specifically so bytes cannot leave the host, the map would be the only feature that emits anything about vault contents. Mechanically it is also blocked: served blueprints get `img-src 'self' data:` ([`security.ts`](../packages/app-engine/src/http/security.ts)), and [blueprint-csp.md](traps/blueprint-csp.md) names "relax CSP to make an app work" as fixing the wrong layer.

The phone used to be the leaky one. `PlacesMap.tsx` drew `react-native-maps`, so opening Places asked the OS map vendor for the neighbourhoods the member had photographed. It now draws the shared projection instead. The dependency itself is still in `package.json` pending a native rebuild — see the entry in [QUALITY.md](../QUALITY.md).

Note also that `tile.openstreetmap.org` is not an option even setting privacy aside: the OSMF usage policy rules out app and heavy use, so "just use OSM" means a commercial tile host with an API key.

**If a basemap is ever wanted**, the projection being separate from the rendering is what makes it a layer under the same pins rather than a rewrite. In rising order of cost: gateway-proxied tiles (the browser talks only to the gateway, which caches — CSP stays `'self'`); the same behind an opt-in consent gate; or owner-imported PMTiles/MBTiles for a region, which is the only one with genuinely zero egress. Any of them needs a Web Mercator mode in `projectPlaces` to register with tile pyramids — at trip scale the two projections differ by under a pixel, but they are not the same function.

A vendored coastline outline (Natural Earth 110m is ~100–200KB as TopoJSON) is the cheaper middle path: real land, no network, no tile pyramid. It is not in yet because vendoring it needs a download the work could not perform.

## Seeded data

The photos scenario seeds 16 located frames across 9 places ([`seed.js`](../packages/blueprints/apps/photos/seed.js)), with three properties chosen rather than incidental: several frames share a coordinate so grouping is visible, portraits share coordinates with landscapes so People and Places intersect, and three frames stay unlocated because a roll where every frame knows where it was is not a roll anyone has. Pinned in `demo-seed.test.ts`.
