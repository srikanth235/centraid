# Centraid City — Landmark Kit contract

Fixes the #1 complaint: 44 buildings currently share 9 `kind` silhouettes, so Gateway Plaza and the Automation Yard are the same box with a roof. Every building now gets **bespoke geometry that depicts what its subsystem actually does**.

## Aesthetic direction — "precision architectural model"

A basswood-and-brass massing model on a blueprint table: warm bone concrete, patinated copper, smoked glass, dark slate, brass fittings. Restrained materials, _lavish_ silhouettes. Think Aldo Rossi's city models and old industrial survey drawings — civic gravity, not toys.

**Four rules that kill the sameness (non-negotiable):**

1. **District color is an ACCENT, never the body.** Bodies are the neutral material palette below. `color` may only appear on: signage bands, glowing seams/ports, door lights, roof trim, beacons, and window emissive tint. A building tinted entirely in district color is a bug.
2. **Silhouette first.** Each landmark must be recognizable in pure black at 40 px. Vary the primitive: drums, cylinders, domes, vaults, lattices, sawtooth, gables, arches, hulls. If your building's outline is "box + flat roof", redo it.
3. **No two landmarks share a roof profile within a district**, and no two share one with their assigned neighbours in the archetype table.
4. **Depict the function.** The FTS tower is an openwork lattice of index frames; the sealed vault has a bank-vault door; the journal steps up like stacked pages. A viewer should be able to guess the subsystem from the shape.

## Materials

`kit.mat` — prebuilt, cached, shared (do NOT create your own `MeshStandardMaterial`):

| key | look | use |
| --- | --- | --- |
| `bone` | #e8e2d6 warm off-white concrete | primary civic bodies |
| `concrete` | #cfc9bd | secondary mass, plinths |
| `plaster` | #ded6c6 | infill walls |
| `slate` | #5d6570 | roofs, heavy caps |
| `darkSlate` | #3b424c | bases, shadow mass, bunkers |
| `steel` | #97a1ad metal .6 | frames, trusses, rails |
| `brass` | #c08a3e metal .85 rough .3 | fittings, trim, handles |
| `copper` | #7fae9b patina metal .5 | roofs, domes, weathervanes |
| `glass` | #2b3440 smoked, metal .35 rough .12 | curtain walls, lantern rooms |
| `timber` | #a97d4f | decking, cabins, crates |
| `terracotta` | #b4674d | brick, chimneys, campanile |
| `rubber` | #2f333a | belts, tyres, seals |

Plus factories: `kit.matWindows(hex)` (facade with night-emissive window map), `kit.matGlow(hex, base)` (unlit accent glow, night-aware), `kit.matTint(baseKey, hex, amt)` (neutral material nudged toward an accent hue — for subtle district identity).

## Kit API

`makeKit(THREE, { facadeMat, plainMat, glowMat, animated })` → kit. All builders **return a `THREE.Object3D`** which the caller adds to `g`. All accept a final optional `opts` object. Y=0 is ground at the building's plate; build upward. Every returned mesh must have `castShadow = true; receiveShadow = true` unless glass/glow.

### Volumes

- `box(w, h, d, mat, opts?)` — opts `{ y, x, z, windows, bevel }`; `bevel` chamfers top edges.
- `drum(rTop, rBot, h, mat, opts?)` — `{ seg = 16, y, open }` cylinder/frustum.
- `dome(r, mat, opts?)` — `{ y, ratio = 0.6, seg = 18 }` hemisphere.
- `vault(w, h, d, mat, opts?)` — barrel-vaulted volume (half-cylinder on its side).
- `prismShape(points, depth, mat, opts?)` — extrude an arbitrary 2D footprint (L/T/U/cross plans). `points` = `[[x,z], …]`. `{ y, rotY, bevel }`.
- `wedge(w, h, d, mat, opts?)` — tapered/battered mass (wider at base) for lighthouses, silos.
- `hull(len, beam, depth, mat)` — a boat hull (barge).

### Roofs — pick a DIFFERENT one per building

- `roofGable(w, d, rise, mat, opts?)`
- `roofHipped(w, d, rise, mat)`
- `roofSawtooth(w, d, rise, bays, mat, opts?)` — north-light studio roof (glazed faces).
- `roofBarrel(w, d, rise, mat, opts?)` — with optional `{ clerestory: true }`.
- `roofPyramid(w, d, rise, mat)` — campanile/tower caps.
- `roofStepped(w, d, h, steps, mat)` — ziggurat.
- `roofMansard(w, d, h, mat)`
- `roofParapet(w, d, mat, opts?)` — flat roof with a raised edge + coping.
- `roofCone(r, h, mat)` — silo caps.
- `roofDomeRibbed(r, mat, opts?)` — ribbed copper dome.

### Facades & structure

- `curtainWall(w, h, d, mat, opts?)` — mullion grid glazing on chosen faces `{ faces: 'front'|'all' }`.
- `punchedWindows(w, h, d, cols, rows, mat, opts?)` — recessed window openings.
- `ribbedFacade(w, h, d, fins, mat, opts?)` — vertical fin/pilaster rhythm.
- `louvers(w, h, d, count, mat, opts?)` — angled slats (plant rooms, sheds).
- `masonryBands(w, h, d, mat, opts?)` — horizontal course lines.
- `colonnade(count, r, h, span, mat, opts?)` — a row of columns; `{ fluted, entablature }`.
- `arcade(count, w, h, d, mat)` — repeated arched openings.
- `pilotis(w, d, h, mat)` — building raised on legs.
- `truss(len, h, mat, opts?)` — lattice beam; `{ segments }`.
- `latticeMast(h, w, mat, opts?)` — openwork tower (crane masts, index towers).
- `gantry(span, h, mat)` — portal frame straddling a track.
- `catwalk(r, y, mat)` / `railing(points, y, mat)` / `stairFlight(w, rise, run, mat)`
- `spiralStair(r, h, mat)` / `steps(w, d, count, mat)` — entry stairs.
- `buttress(h, d, mat, opts?)`

### Props & fittings

`pipeRun(points, r, mat)`, `ductRun(w, len, mat)`, `dish(r, mat, opts?)` (aimable), `mast(h, mat)`, `aerial(h, mat)`, `vent(r, h, mat)`, `fan(r, mat)` (registers a spinner), `chimney(r, h, mat)`, `tank(r, h, mat, opts?)` (horizontal on saddles if `{ lying: true }`), `silo(r, h, mat)`, `crateStack(w, h, d, mat, opts?)`, `container(w,h,d,hex)` (shipping container with ribs + doors), `bollards(points, mat)`, `planter(r, mat)`, `tree(h, opts?)`, `streetlamp(h, mat)`, `flagpole(h, mat)`, `signBand(w, h, hex, opts?)` (glowing fascia band — **the primary place district color belongs**), `plaqueWall(w, h, cols, rows, mat)`, `gaugeBoard(w, h, mat, hex)`, `splitFlapBoard(w, h, mat, hex)`, `clockFace(r, mat, hex)` (registers hands), `weathervane(h, mat)`, `solarArray(w, d, mat)`, `wheel(r, mat)` (registers a spinner), `piston(len, r, mat)` (registers a reciprocator).

### Animation

- `beacon(x, y, z, hex, r?)` — pulsing lamp.
- `seam(points, hex, opts?)` — a glowing line/edge (data seams, vault door glow).
- `spin(obj, speed, axis?)` — registers into `animated` as `{ type:'spin' }`.
- `bob(obj, amp, speed)` — registers as `{ type:'bob' }`.
- `activityLamp(hex)` — brightens with district activity (`{ type:'activity' }`).

**The kit author must also add handlers for the new `animated` types** (`spin`, `bob`, `reciprocate`, `clockhands`) to `src/world/world.ts`'s update loop — those are the only two lines you may change in the world update seam; the landmark dispatch seam is already wired.

## Archetype assignments (authoritative — build exactly these)

### Lane A — `src/world/landmarks-core.ts` (clients, gateway, runtime)

| id | archetype |
| --- | --- |
| `clients-desktop` | Workstation monolith: heavy bone frame, deep-set smoked curtain wall, one chamfered corner, roof plant + dish aimed at the gateway. Flat parapet. |
| `clients-web` | **Cylindrical** glass drum — full-height curtain wall, thin brass ring cap, small install-canopy awning at the door. Breaks the box rhythm. |
| `clients-mobile` | Slender portrait slab, rounded corners, a notch cut into the top edge, on a low plinth, whip antenna. |
| `gateway-frontdesk` | **The civic landmark of the city.** Wide bone portico: fluted colonnade of 8 columns, broad entry steps spanning the full front, shallow glazed barrel-vault roof with clerestory, brass cornice, two lower flanking wings. Train-station gravity. |
| `gateway-router` | Airport-style control cabin: octagonal 360°-glazed drum on a splayed pier, catwalk ring, aerials. |
| `gateway-vaultregistry` | Card-index tower: facade is a grid of protruding drawer fronts with brass pulls; stepped ziggurat top. |
| `gateway-health` | Scoreboard: low base carrying a large tilted board of glowing cells on a truss frame. |
| `runtime-ledger` | Archive basilica: long barrel-vaulted hall, clerestory windows, repeating structural bays, facade expressed as stacked shelf bands. Reads as a library. |
| `runtime-acp1` | Reactor/kiln: cylindrical shell, external pipework, catwalk ring, glowing seam at the base. |
| `runtime-acp2` | Same family, clearly different: compact louvered block with an exhaust stack and a smaller catwalk. Family resemblance ≠ duplicate. |
| `runtime-registry` | Pigeonhole rack: open steel frame of labeled cubbies, some slots deliberately empty. |
| `runtime-models` | Fuel depot: a row of horizontal tanks on saddles behind a gauge board. |

### Lane B — `src/world/landmarks-data.ts` (consent, vault, wal, backup)

| id | archetype |
| --- | --- |
| `consent-arch` | Customs gatehouse: heavy masonry arch over the road, glowing scan curtain in the opening, two guard booths, boom barriers. |
| `consent-parking` | Open-air parking deck on columns, marked bays, a few parked crates (violet accent). |
| `consent-ledger` | Record office: low block, deep recessed arcade, a wall of small brass plaques. |
| `vault-core` | **Rotunda hub**: circular drum + low ribbed dome, radiating spoke walls at plinth level, ring of glowing ports (FKs into core_party). |
| `vault-journal` | Append-only strip: long low slab stepping up in even increments like stacked pages; newest end glows. |
| `vault-fts` | Index tower: openwork lattice of stacked grid frames — very see-through, brass. |
| `vault-sealed` | Bank vault: windowless monolith with a large circular vault door, radial bolts, minimal light. |
| `vault-spokes` | Yard of standing stelae at varied heights linked by low walls. |
| `wal-conveyor` | Inclined belt gallery on trestles feeding a hopper (use the existing conveyor texture + `{type:'conveyor'}`). |
| `wal-checkpointer` | Pumping station: squat drum, big external flywheel + piston, pressure gauges. |
| `wal-shipper` | Sorting house: angled chute aimed at the harbour, segment crates queued on rails. |
| `backup-bunker1` | Earth-bermed bunker: sloped berm skirt, blast door, low profile. |
| `backup-bunker2` | Silo cluster: 3–4 vertical cylinders with conical caps and a link bridge. |
| `backup-bunker3` | Deliberately domestic contrast: small brick office, pitched roof, chimney, records annex. |

### Lane C — `src/world/landmarks-edge.ts` (apps, automation, cas, sync)

| id | archetype |
| --- | --- |
| `apps-locker` | Strongbox shop: ribbed metal front with a rolling shutter and an oversized padlock motif. |
| `apps-tally` | Counting house: facade of horizontal rods with sliding beads (abacus), gable roof. |
| `apps-people` | Townhouse row: three narrow bays, each with a different pitched roofline and its own stoop. |
| `apps-photos` | Gallery studio: **sawtooth north-light roof**, big glazed panels with image-tile mullions. |
| `apps-agenda` | Calendar house: 7×5 grid of recessed date cells, small campanile at one corner. |
| `apps-crane` | Proper tower crane: lattice mast, counterweight jib, hook; blueprint scaffold below. Keep `{type:'crane'}`. |
| `automation-clock` | **Campanile** — tall slender terracotta/bone tower, arched belfry openings, four clock faces, pyramidal copper roof + weathervane. Must read unmistakably as a clock tower. |
| `automation-shed1` | Signal hut: trackside lever frame, semaphore signal arms, small gabled hut. |
| `automation-line` | Factory shed: long **sawtooth** roof, external gantry, covered loading bay, long glazed strip showing the line. (Differs from `apps-photos` by scale, gantry, and bay rhythm.) |
| `automation-scheduler` | Timetable wall: low block fronted by a large split-flap departure board. |
| `cas-containers` | Stacked shipping containers, staggered, varied hues, straddled by a small gantry. Not a tank. |
| `cas-press` | Hydraulic press house: squat block with a massive external ram and compression rings. |
| `cas-s3crane` | **Portal gantry crane** straddling rails (visibly different from `apps-crane`'s tower crane). |
| `cas-barge` | Actual barge: hull, deck containers, wheelhouse, wake. |
| `sync-lighthouse` | True lighthouse: battered tapered tower, gallery railing, glazed lantern room, rotating beam. |
| `sync-bridge` | Cable-stayed bridge: two A-frame pylons, fanned cables, deck. |
| `sync-island` | Stilted cabin on piles with a dish aimed back at the city. |
| `sync-island2` | Smaller, different: A-frame cabin, mast, solar array. |

## Constraints

- Landmark lanes add no dependencies and make no runtime network requests. The package's `three` dependency is declared in `package.json`; source remains ES modules.
- **Perf budget**: total draw calls must stay under ~900 and triangles under ~180k. Prefer low segment counts (drums ≤ 16, domes ≤ 18), reuse kit materials (they are cached), and merge repeated small props where trivial. No shadows on glow/glass meshes.
- Landmarks must be **self-contained**: read only from the passed api object; never import `src/core/content.ts`; never touch the DOM.
- Sizes: respect the passed `w/h/d` as the building's approximate bounding envelope. You may exceed it by ≤ 25% for expressive elements (spires, jibs, cables, berms).

## Landmark signature

```js
// landmarks-<lane>.ts
export const LANDMARKS_<LANE> = {
  'gateway-frontdesk'({ g, w, h, d, color, districtId, data, kit, THREE, animated }) {
    g.add(kit.box(w, h * 0.6, d, kit.mat.bone, { y: h * 0.3 }));
    g.add(kit.colonnade(8, 0.5, h * 0.55, w * 0.9, kit.mat.bone, { fluted: true, z: d / 2 }));
    g.add(kit.signBand(w * 0.7, 0.5, color, { y: h * 0.62, z: d / 2 + 0.1 }));
    // …
  },
};
```

`src/world/landmarks.ts` merges the three lane objects into `LANDMARKS`.
