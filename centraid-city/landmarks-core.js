// governance: allow-repo-hygiene file-size-limit — one bespoke model per building id.
// Already split three ways by district; each entry is independent of the others.
// landmarks-core.js — clients, gateway, runtime. See KIT_API.md.
//
// Lane A. Twelve bespoke silhouettes. The four rules, as applied here:
//   1. District color is an ACCENT only — sign bands, door glow, seams, beacons, board
//      cells, window tint. Every body mass uses the neutral kit material palette.
//   2. Silhouette first — monolith / glass drum / portrait slab / porticoed hall /
//      control cabin / card-index ziggurat / scoreboard / basilica vault / reactor /
//      louvered plant block / open rack / tank farm. No two read alike at 40 px.
//   3. No repeated roof profile in this lane: flat parapet, brass ring, notched shoulder
//      slab, glazed barrel vault, cone, stepped ziggurat, tilted board, extruded vault,
//      shallow copper dome, hipped, open louvered canopy, cylinder farm.
//   4. Each shape depicts its subsystem — drawers for the vault registry, shelf bands for
//      the ledger, gauges for the model catalog, a live scoreboard for health.
//
// Defensive by construction: kit.js is authored in parallel, so every kit call goes
// through `add()`. A kit member that is missing or throws costs one detail,
// never the whole building (the dispatch seam in world.js drops a landmark that throws).

/** Build a part, position it, add it to the group. Returns the object or null. */
function add(g, make, x, y, z) {
  let o = null;
  try {
    o = make();
  } catch {
    return null;
  }
  if (!o || !o.isObject3D) return null;
  if (typeof x === "number") {
    o.position.set(
      x,
      typeof y === "number" ? y : 0,
      typeof z === "number" ? z : 0
    );
  }
  g.add(o);
  return o;
}

/** Rotate a part that was already added. */
function turn(o, rx, ry, rz) {
  if (!o || !o.rotation) return o;
  o.rotation.set(rx || 0, ry || 0, rz || 0);
  return o;
}

/** A closed ring of [x, y, z] points, for seams and pipe runs. */
function ringPoints(r, y, count) {
  const pts = [];
  const n = Math.max(4, count | 0);
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([Math.cos(a) * r, y, Math.sin(a) * r]);
  }
  return pts;
}

export const LANDMARKS_CORE = {
  // ── Client Approach ──────────────────────────────────────────────────────────────
  // Three towers that must be told apart instantly: heavy chamfered monolith,
  // glass cylinder, slender notched portrait slab.

  "clients-desktop"({ g, w, h, d, color, kit }) {
    const m = kit.mat || {};
    const bodyH = h * 0.84;
    const topY = 0.7 + bodyH;

    add(g, () => kit.box(w * 1.06, 0.7, d * 1.06, m.concrete), 0, 0.35, 0);
    // Heavy load-bearing frame with the glazing set deep behind it.
    add(
      g,
      () => kit.box(w, bodyH, d, m.bone, { bevel: true }),
      0,
      0.7 + bodyH / 2,
      0
    );
    add(
      g,
      () => kit.ribbedFacade(w * 1.01, bodyH * 0.94, d * 1.01, 5, m.bone),
      0,
      0.7 + bodyH / 2,
      0
    );
    add(
      g,
      () =>
        kit.curtainWall(w * 0.8, bodyH * 0.78, d * 0.8, m.glass, {
          faces: "all",
        }),
      0,
      0.7 + bodyH * 0.46,
      0
    );
    // The single chamfered corner — front-left, cut back 45°.
    turn(
      add(
        g,
        () => kit.box(w * 0.3, bodyH, d * 0.3, m.concrete, { bevel: true }),
        -w * 0.5,
        0.7 + bodyH / 2,
        d * 0.5
      ),
      0,
      Math.PI / 4,
      0
    );
    add(
      g,
      () => kit.masonryBands(w * 1.02, bodyH, d * 1.02, m.concrete),
      0,
      0.7 + bodyH / 2,
      0
    );

    // Flat parapet roof, plant deck, and a dish aimed down the approach at the gateway.
    add(g, () => kit.roofParapet(w, d, m.slate), 0, topY, 0);
    add(
      g,
      () => kit.box(w * 0.42, 1.5, d * 0.34, m.darkSlate),
      -w * 0.16,
      topY + 0.75,
      -d * 0.18
    );
    add(
      g,
      () => kit.louvers(w * 0.43, 1.2, d * 0.35, 5, m.steel),
      -w * 0.16,
      topY + 0.75,
      -d * 0.18
    );
    turn(
      add(g, () => kit.dish(1.5, m.steel), w * 0.26, topY + 1.6, d * 0.14),
      -0.55,
      Math.PI,
      0
    );
    add(g, () => kit.vent(0.4, 0.9, m.steel), w * 0.3, topY + 0.45, -d * 0.3);

    // Accent: fascia band + lit lobby door.
    add(
      g,
      () => kit.signBand(w * 0.6, 0.6, color),
      0,
      topY - 0.9,
      d * 0.5 + 0.08
    );
    add(
      g,
      () => kit.box(w * 0.26, 2.4, 0.25, kit.matGlow(color, 0.55)),
      0,
      1.9,
      d * 0.5 + 0.1
    );
    add(g, () => kit.steps(w * 0.34, 1.2, 3, m.concrete), 0, 0, d * 0.5 + 0.7);
    add(g, () => kit.beacon(w * 0.26, topY + 2.4, d * 0.14, color, 0.4));
  },

  "clients-web"({ g, w, h, color, kit }) {
    const m = kit.mat || {};
    const r = w * 0.44;
    const shaftH = h * 0.88;
    const topY = 0.6 + shaftH;

    // Full-height glass drum — the only cylinder on the approach.
    add(
      g,
      () => kit.drum(r * 1.16, r * 1.22, 0.6, m.concrete, { seg: 16 }),
      0,
      0.3,
      0
    );
    add(
      g,
      () => kit.drum(r * 0.34, r * 0.34, shaftH, m.bone, { seg: 12 }),
      0,
      0.6 + shaftH / 2,
      0
    );
    add(
      g,
      () => kit.drum(r, r, shaftH, m.glass, { seg: 16, open: true }),
      0,
      0.6 + shaftH / 2,
      0
    );
    // Mullion rings read as floor plates through the glass.
    for (let i = 1; i <= 3; i++) {
      const ringY = 0.6 + (shaftH * i) / 4;
      add(
        g,
        () =>
          kit.drum(r * 1.02, r * 1.02, 0.14, m.steel, { seg: 16, open: true }),
        0,
        ringY,
        0
      );
    }
    // Thin brass ring cap — no parapet, no gable; the roof is a rim.
    add(
      g,
      () => kit.drum(r * 1.1, r * 1.02, 0.45, m.brass, { seg: 16 }),
      0,
      topY + 0.22,
      0
    );
    add(
      g,
      () => kit.drum(r * 0.94, r * 0.94, 0.16, m.slate, { seg: 16 }),
      0,
      topY + 0.52,
      0
    );
    add(g, () => kit.mast(h * 0.22, m.steel), 0, topY + 0.6, 0);

    // Install canopy over the door — the "add to home screen" awning.
    turn(
      add(
        g,
        () => kit.box(w * 0.42, 0.18, w * 0.24, m.copper),
        0,
        3.1,
        r + w * 0.13
      ),
      -0.16,
      0,
      0
    );
    add(g, () => kit.box(0.18, 3, 0.18, m.steel), -w * 0.18, 1.5, r + w * 0.22);
    add(g, () => kit.box(0.18, 3, 0.18, m.steel), w * 0.18, 1.5, r + w * 0.22);

    add(g, () => kit.signBand(w * 0.38, 0.5, color), 0, 3.5, r + 0.06);
    add(
      g,
      () => kit.box(w * 0.22, 2.3, 0.22, kit.matGlow(color, 0.55)),
      0,
      1.15,
      r - 0.05
    );
    add(g, () => kit.seam(ringPoints(r * 1.03, topY + 0.02, 16), color));
    add(g, () => kit.beacon(0, topY + h * 0.24, 0, color, 0.36));
  },

  "clients-mobile"({ g, w, h, d, color, kit }) {
    const m = kit.mat || {};
    const slabW = w * 0.5;
    const slabD = d * 0.3;
    const plinth = 0.8;
    const shaftH = h * 0.86;
    const topY = plinth + shaftH;

    // Low wide plinth, slender portrait slab, rounded vertical edges.
    add(
      g,
      () => kit.box(w * 0.9, plinth, d * 0.72, m.concrete, { bevel: true }),
      0,
      plinth / 2,
      0
    );
    add(
      g,
      () => kit.box(slabW, shaftH, slabD, m.bone, { bevel: true }),
      0,
      plinth + shaftH / 2,
      0
    );
    add(
      g,
      () => kit.drum(slabD * 0.5, slabD * 0.5, shaftH, m.bone, { seg: 10 }),
      -slabW / 2,
      plinth + shaftH / 2,
      0
    );
    add(
      g,
      () => kit.drum(slabD * 0.5, slabD * 0.5, shaftH, m.bone, { seg: 10 }),
      slabW / 2,
      plinth + shaftH / 2,
      0
    );
    // The screen.
    add(
      g,
      () =>
        kit.curtainWall(slabW * 0.82, shaftH * 0.8, slabD * 1.04, m.glass, {
          faces: "front",
        }),
      0,
      plinth + shaftH * 0.5,
      0
    );

    // The notch: two shoulder caps with a gap between them instead of a full top edge.
    add(
      g,
      () => kit.box(slabW * 0.3, 0.9, slabD, m.bone, { bevel: true }),
      -slabW * 0.35,
      topY + 0.45,
      0
    );
    add(
      g,
      () => kit.box(slabW * 0.3, 0.9, slabD, m.bone, { bevel: true }),
      slabW * 0.35,
      topY + 0.45,
      0
    );
    add(
      g,
      () => kit.box(slabW, 0.22, slabD * 0.62, m.slate),
      0,
      topY + 0.11,
      -slabD * 0.2
    );
    add(g, () =>
      kit.seam(
        [
          [-slabW * 0.2, topY + 0.24, slabD * 0.5],
          [slabW * 0.2, topY + 0.24, slabD * 0.5],
        ],
        color
      )
    );

    // Whip antenna — the iroh tunnel home.
    add(g, () => kit.mast(h * 0.42, m.steel), slabW * 0.35, topY + 0.9, 0);
    add(g, () => kit.aerial(h * 0.2, m.brass), -slabW * 0.35, topY + 0.9, 0);
    add(g, () =>
      kit.beacon(slabW * 0.35, topY + 0.9 + h * 0.42, 0, color, 0.34)
    );
    add(
      g,
      () => kit.signBand(slabW * 0.7, 0.42, color),
      0,
      plinth + 1.4,
      slabD * 0.5 + 0.06
    );
    add(
      g,
      () => kit.box(slabW * 0.34, 1.5, 0.22, kit.matGlow(color, 0.5)),
      0,
      plinth + 0.75,
      slabD * 0.5 + 0.08
    );
    add(g, () =>
      kit.bollards(
        [
          [-w * 0.34, d * 0.34],
          [0, d * 0.4],
          [w * 0.34, d * 0.34],
        ],
        m.steel
      )
    );
  },

  // ── Gateway Plaza ────────────────────────────────────────────────────────────────

  // The civic landmark of the city: a train-station front desk. Every client walks
  // through this one door, so it gets the portico, the broad steps, and the glazed vault.
  "gateway-frontdesk"({ g, w, h, d, color, kit }) {
    const m = kit.mat || {};
    const pod = 1;
    const hallW = w * 0.66;
    const hallD = d * 0.76;
    const hallH = h * 0.62;
    const hallTop = pod + hallH;
    const wingW = w * 0.16;
    const wingH = h * 0.4;
    const wingD = d * 0.58;
    const front = hallD * 0.5;

    // Podium the whole composition stands on.
    add(g, () => kit.box(w * 1.08, pod, d * 1.04, m.concrete), 0, pod / 2, 0);
    add(
      g,
      () => kit.masonryBands(w * 1.09, pod, d * 1.05, m.concrete),
      0,
      pod / 2,
      0
    );

    // Central concourse.
    add(g, () => kit.box(hallW, hallH, hallD, m.bone), 0, pod + hallH / 2, 0);
    add(
      g,
      () => kit.masonryBands(hallW * 1.01, hallH * 0.7, hallD * 1.01, m.bone),
      0,
      pod + hallH * 0.35,
      0
    );
    add(
      g,
      () =>
        kit.punchedWindows(
          hallW * 1.02,
          hallH * 0.5,
          hallD * 1.02,
          7,
          2,
          kit.matWindows(color)
        ),
      0,
      pod + hallH * 0.58,
      0
    );

    // Brass cornice + shallow glazed barrel vault with a clerestory — the concourse roof.
    add(
      g,
      () => kit.box(hallW * 1.06, 0.4, hallD * 1.06, m.brass),
      0,
      hallTop + 0.2,
      0
    );
    add(
      g,
      () =>
        kit.roofBarrel(hallW, hallD, h * 0.34, m.glass, { clerestory: true }),
      0,
      hallTop + 0.4,
      0
    );
    add(g, () =>
      kit.seam(
        [
          [-hallW * 0.46, hallTop + h * 0.34 + 0.42, 0],
          [hallW * 0.46, hallTop + h * 0.34 + 0.42, 0],
        ],
        color
      )
    );

    // Fluted colonnade of eight standing clear of the facade, carrying an entablature.
    add(
      g,
      () =>
        kit.colonnade(8, 0.46, hallH * 0.82, w * 0.86, m.bone, {
          fluted: true,
          entablature: true,
        }),
      0,
      pod,
      front + 1.6
    );
    add(
      g,
      () => kit.box(w * 0.9, 0.5, 1.6, m.brass),
      0,
      pod + hallH * 0.82 + 0.7,
      front + 1.6
    );
    add(
      g,
      () => kit.signBand(w * 0.52, 0.72, color),
      0,
      pod + hallH * 0.82 + 0.72,
      front + 2.45
    );

    // Broad steps spanning the entire front.
    add(g, () => kit.steps(w * 0.94, 3.2, 5, m.concrete), 0, 0, front + 4.4);
    add(
      g,
      () => kit.box(w * 0.3, 3.4, 0.3, kit.matGlow(color, 0.6)),
      0,
      pod + 1.7,
      front + 0.1
    );

    // Two lower flanking wings, arcaded, with flat coping and a copper plant box.
    for (let s = -1; s <= 1; s += 2) {
      const x = s * w * 0.42;
      add(g, () => kit.box(wingW, wingH, wingD, m.bone), x, pod + wingH / 2, 0);
      add(
        g,
        () => kit.arcade(3, wingW * 0.94, wingH * 0.62, 0.9, m.bone),
        x,
        pod,
        wingD * 0.5
      );
      add(
        g,
        () => kit.box(wingW * 1.12, 0.34, wingD * 1.08, m.slate),
        x,
        pod + wingH + 0.17,
        0
      );
      add(
        g,
        () => kit.box(wingW * 0.5, 0.5, wingD * 0.4, m.copper),
        x,
        pod + wingH + 0.55,
        -wingD * 0.2
      );
    }

    // Plaza furniture — the civic scale cues.
    add(g, () => kit.flagpole(h * 0.8, m.steel), -w * 0.44, 0, front + 5.4);
    add(g, () => kit.flagpole(h * 0.8, m.steel), w * 0.44, 0, front + 5.4);
    add(g, () => kit.streetlamp(4.2, m.steel), -w * 0.3, 0, front + 6.2);
    add(g, () => kit.streetlamp(4.2, m.steel), w * 0.3, 0, front + 6.2);
    add(g, () =>
      kit.bollards(
        [
          [-w * 0.2, front + 6.6],
          [0, front + 6.9],
          [w * 0.2, front + 6.6],
        ],
        m.steel
      )
    );
    add(g, () => kit.beacon(0, hallTop + h * 0.36, 0, color, 0.5));
    add(
      g,
      () => kit.activityLamp(color),
      0,
      pod + hallH * 0.82 + 1.1,
      front + 1.6
    );
  },

  "gateway-router"({ g, w, h, d, color, kit }) {
    const m = kit.mat || {};
    const pierH = h * 0.62;
    const cabH = h * 0.26;
    const rCab = w * 0.5;
    const cabY = 0.5 + pierH + 0.35;
    const capY = cabY + cabH;

    // Splayed pier — a control-tower shaft that widens at its foot.
    add(g, () => kit.box(w * 1.05, 0.5, d * 1.05, m.concrete), 0, 0.25, 0);
    add(g, () => kit.wedge(w * 0.46, pierH, d * 0.46, m.concrete), 0, 0.5, 0);
    add(
      g,
      () => kit.ribbedFacade(w * 0.42, pierH * 0.9, d * 0.42, 4, m.bone),
      0,
      0.5 + pierH * 0.45,
      0
    );
    add(g, () => kit.spiralStair(w * 0.3, pierH, m.steel), 0, 0.5, 0);

    // Octagonal 360°-glazed cabin, oversailing the pier so it looks over the plaza.
    add(
      g,
      () => kit.drum(rCab * 0.9, rCab * 0.7, 0.35, m.darkSlate, { seg: 8 }),
      0,
      0.5 + pierH + 0.18,
      0
    );
    add(
      g,
      () => kit.drum(rCab, rCab * 0.86, cabH, m.glass, { seg: 8 }),
      0,
      cabY + cabH / 2,
      0
    );
    add(
      g,
      () =>
        kit.drum(rCab * 1.02, rCab * 0.88, 0.14, m.steel, {
          seg: 8,
          open: true,
        }),
      0,
      cabY + cabH * 0.5,
      0
    );
    add(g, () => kit.catwalk(rCab * 1.24, 0.5 + pierH + 0.2, m.steel));

    // Shallow cone cap bristling with aerials and dishes — the only cone in the lane.
    add(g, () => kit.roofCone(rCab * 1.05, h * 0.16, m.slate), 0, capY, 0);
    add(g, () => kit.mast(h * 0.3, m.steel), 0, capY + h * 0.16, 0);
    add(
      g,
      () => kit.aerial(h * 0.16, m.steel),
      rCab * 0.5,
      capY + h * 0.1,
      -rCab * 0.4
    );
    turn(
      add(g, () => kit.dish(0.85, m.steel), rCab * 1.1, 0.5 + pierH + 0.6, 0),
      -0.4,
      -Math.PI / 2,
      0
    );
    turn(
      add(g, () => kit.dish(0.7, m.steel), -rCab * 1.1, 0.5 + pierH + 0.6, 0),
      -0.4,
      Math.PI / 2,
      0
    );

    add(g, () => kit.signBand(w * 0.4, 0.44, color), 0, 3, d * 0.24);
    add(g, () =>
      kit.seam(ringPoints(rCab * 1.24, 0.5 + pierH + 0.42, 8), color)
    );
    add(g, () => kit.beacon(0, capY + h * 0.46, 0, color, 0.46));
  },

  "gateway-vaultregistry"({ g, w, h, d, color, kit }) {
    const m = kit.mat || {};
    const base = 0.6;
    const bodyH = h * 0.66;
    const bodyTop = base + bodyH;

    // A card-index cabinet blown up to building scale.
    add(g, () => kit.box(w * 1.08, base, d * 1.08, m.concrete), 0, base / 2, 0);
    add(
      g,
      () => kit.box(w * 0.92, bodyH, d * 0.92, m.bone),
      0,
      base + bodyH / 2,
      0
    );
    // Drawer fronts: a dense plaque grid on the two visible faces …
    add(
      g,
      () => kit.plaqueWall(w * 0.86, bodyH * 0.86, 4, 6, m.plaster),
      0,
      base + bodyH * 0.5,
      d * 0.46 + 0.06
    );
    turn(
      add(
        g,
        () => kit.plaqueWall(d * 0.86, bodyH * 0.86, 4, 6, m.plaster),
        w * 0.46 + 0.06,
        base + bodyH * 0.5,
        0
      ),
      0,
      Math.PI / 2,
      0
    );
    // … plus four real drawers with brass pulls, one pulled open and lit inside.
    for (let i = 0; i < 4; i++) {
      const y = base + bodyH * (0.22 + i * 0.19);
      const out = i === 1 ? 0.7 : 0.18;
      add(
        g,
        () => kit.box(w * 0.2, bodyH * 0.12, out, m.plaster),
        -w * 0.24,
        y,
        d * 0.46 + out / 2
      );
      add(
        g,
        () => kit.box(w * 0.06, 0.14, 0.16, m.brass),
        -w * 0.24,
        y,
        d * 0.46 + out + 0.06
      );
    }
    add(
      g,
      () => kit.box(w * 0.18, bodyH * 0.06, 0.12, kit.matGlow(color, 0.6)),
      -w * 0.24,
      base + bodyH * 0.41 + 0.09,
      d * 0.46 + 0.62
    );

    // Stepped ziggurat top — mounted planes stacked over the warm map.
    add(
      g,
      () => kit.roofStepped(w * 0.92, d * 0.92, h * 0.3, 4, m.concrete),
      0,
      bodyTop,
      0
    );
    add(
      g,
      () => kit.box(w * 0.2, 0.5, d * 0.2, m.brass),
      0,
      bodyTop + h * 0.3 + 0.25,
      0
    );
    add(
      g,
      () => kit.signBand(w * 0.6, 0.5, color),
      0,
      base + 0.4,
      d * 0.46 + 0.12
    );
    add(
      g,
      () => kit.box(w * 0.22, 2, 0.2, kit.matGlow(color, 0.5)),
      w * 0.2,
      base + 1,
      d * 0.46 + 0.1
    );
    add(g, () => kit.beacon(0, bodyTop + h * 0.3 + 0.7, 0, color, 0.34));
  },

  "gateway-health"({ g, w, h, d, color, kit }) {
    const m = kit.mat || {};
    const baseH = h * 0.46;

    // Low equipment base …
    add(
      g,
      () => kit.box(w * 0.94, baseH, d * 0.7, m.darkSlate),
      0,
      baseH / 2,
      0
    );
    add(
      g,
      () => kit.louvers(w * 0.96, baseH * 0.72, d * 0.72, 6, m.steel),
      0,
      baseH * 0.46,
      0
    );
    add(
      g,
      () => kit.box(w * 0.98, 0.26, d * 0.74, m.slate),
      0,
      baseH + 0.13,
      0
    );

    // … carrying a big tilted board of live cells on a lattice truss frame.
    add(
      g,
      () => kit.latticeMast(h * 1.05, 0.5, m.steel),
      -w * 0.36,
      baseH,
      -d * 0.16
    );
    add(
      g,
      () => kit.latticeMast(h * 1.05, 0.5, m.steel),
      w * 0.36,
      baseH,
      -d * 0.16
    );
    add(
      g,
      () => kit.truss(w * 0.8, 0.5, m.steel, { segments: 6 }),
      0,
      baseH + h * 1,
      -d * 0.16
    );
    turn(
      add(
        g,
        () => kit.gaugeBoard(w * 0.9, h * 0.86, m.steel, color),
        0,
        baseH + h * 0.62,
        d * 0.06
      ),
      -0.3,
      0,
      0
    );
    add(
      g,
      () => kit.box(w * 0.94, 0.22, 0.5, m.brass),
      0,
      baseH + h * 1.06,
      -d * 0.02
    );
    add(
      g,
      () => kit.signBand(w * 0.5, 0.42, color),
      0,
      baseH * 0.42,
      d * 0.36 + 0.06
    );
    add(g, () => kit.activityLamp(color), 0, baseH + h * 1.18, -d * 0.16);
    add(g, () => kit.beacon(-w * 0.36, baseH + h * 1.1, -d * 0.16, color, 0.3));
    add(g, () => kit.beacon(w * 0.36, baseH + h * 1.1, -d * 0.16, color, 0.3));
  },

  // ── Agent Runtime Row ────────────────────────────────────────────────────────────

  "runtime-ledger"({ g, w, h, d, color, kit }) {
    const m = kit.mat || {};
    const pod = 0.7;
    const naveSpan = d * 0.66;
    const naveLen = w * 0.74;
    const aisleH = h * 0.44;

    // An archive basilica: aisles, clerestory, and a long barrel-vaulted nave whose
    // barrel runs down the length of the hall (hence the quarter turn).
    add(g, () => kit.box(w * 1.02, pod, d * 1.02, m.concrete), 0, pod / 2, 0);
    turn(
      add(g, () => kit.vault(naveSpan, h * 0.92, naveLen, m.bone), 0, pod, 0),
      0,
      Math.PI / 2,
      0
    );

    for (let s = -1; s <= 1; s += 2) {
      const z = s * (naveSpan * 0.5 + d * 0.1);
      add(
        g,
        () => kit.box(naveLen * 0.98, aisleH, d * 0.2, m.bone),
        0,
        pod + aisleH / 2,
        z
      );
      add(
        g,
        () => kit.box(naveLen * 1, 0.28, d * 0.22, m.slate),
        0,
        pod + aisleH + 0.14,
        z
      );
      // Repeating structural bays down both flanks.
      for (let i = -2; i <= 2; i++) {
        add(
          g,
          () => kit.buttress(aisleH * 1.1, d * 0.12, m.concrete),
          i * naveLen * 0.2,
          pod,
          z + s * d * 0.11
        );
      }
      // Clerestory strip riding above the aisle roofs.
      add(
        g,
        () =>
          kit.curtainWall(naveLen * 0.9, h * 0.16, 0.4, m.glass, {
            faces: "front",
          }),
        0,
        pod + aisleH + h * 0.13,
        s * naveSpan * 0.48
      );
    }

    // Facade expressed as stacked shelf bands — it should read as a library.
    add(
      g,
      () =>
        kit.masonryBands(naveLen * 0.99, h * 0.6, naveSpan * 1.01, m.plaster),
      0,
      pod + h * 0.3,
      0
    );
    turn(
      add(
        g,
        () => kit.plaqueWall(naveSpan * 0.8, h * 0.5, 3, 7, m.plaster),
        naveLen * 0.5 + 0.06,
        pod + h * 0.28,
        0
      ),
      0,
      Math.PI / 2,
      0
    );
    add(
      g,
      () => kit.arcade(5, naveLen * 0.6, h * 0.38, 1.1, m.bone),
      0,
      pod,
      naveSpan * 0.5 + 0.5
    );
    add(
      g,
      () => kit.box(naveLen * 0.62, 0.36, 1.3, m.brass),
      0,
      pod + h * 0.38 + 0.18,
      naveSpan * 0.5 + 0.5
    );
    add(
      g,
      () => kit.steps(naveLen * 0.62, 1.6, 3, m.concrete),
      0,
      0,
      naveSpan * 0.5 + 1.7
    );

    // Accent: the append point glows at the newest end of the hall.
    add(
      g,
      () => kit.signBand(naveLen * 0.44, 0.6, color),
      0,
      pod + h * 0.46,
      naveSpan * 0.5 + 0.62
    );
    add(
      g,
      () => kit.box(1, h * 0.7, 0.3, kit.matGlow(color, 0.6)),
      naveLen * 0.5 + 0.1,
      pod + h * 0.35,
      0
    );
    add(g, () =>
      kit.seam(
        [
          [-naveLen * 0.5, pod + h * 0.93, 0],
          [naveLen * 0.5, pod + h * 0.93, 0],
        ],
        color
      )
    );
    add(g, () => kit.beacon(naveLen * 0.5, pod + h * 0.95, 0, color, 0.4));
  },

  "runtime-acp1"({ g, w, h, color, kit }) {
    const m = kit.mat || {};
    const r = w * 0.42;
    const base = 0.8;
    const shellH = h * 0.72;
    const topY = base + shellH;

    // Reactor / kiln: a cylindrical shell wearing its plumbing on the outside.
    add(
      g,
      () => kit.drum(r * 1.24, r * 1.32, base, m.darkSlate, { seg: 16 }),
      0,
      base / 2,
      0
    );
    add(
      g,
      () => kit.drum(r * 0.92, r, shellH, m.concrete, { seg: 16 }),
      0,
      base + shellH / 2,
      0
    );
    add(
      g,
      () => kit.masonryBands(r * 2.02, shellH * 0.9, r * 2.02, m.plaster),
      0,
      base + shellH * 0.45,
      0
    );
    add(
      g,
      () => kit.dome(r * 0.98, m.copper, { ratio: 0.4, seg: 16 }),
      0,
      topY,
      0
    );
    add(g, () => kit.vent(0.42, 1, m.steel), 0, topY + r * 0.42, 0);

    add(g, () => kit.catwalk(r * 1.2, base + shellH * 0.62, m.steel));
    add(
      g,
      () => kit.spiralStair(r * 1.18, base + shellH * 0.62, m.steel),
      0,
      base,
      0
    );
    add(g, () =>
      kit.pipeRun(
        [
          [r * 0.9, base + 0.6, 0],
          [r * 1.8, base + 0.6, 0],
          [r * 1.8, base + shellH * 0.8, 0],
          [r * 0.95, base + shellH * 0.8, 0],
        ],
        0.2,
        m.steel
      )
    );
    add(
      g,
      () => kit.tank(0.7, shellH * 0.5, m.steel),
      -r * 1.5,
      base + shellH * 0.25,
      r * 0.6
    );
    add(
      g,
      () => kit.chimney(0.45, h * 0.34, m.terracotta),
      r * 1.2,
      base,
      -r * 0.9
    );

    // Accent: the fire line at the base of the shell.
    add(g, () => kit.seam(ringPoints(r * 1.02, base + 0.35, 16), color));
    add(
      g,
      () => kit.signBand(w * 0.4, 0.42, color),
      0,
      base + shellH * 0.2,
      r + 0.1
    );
    add(g, () => kit.activityLamp(color), 0, topY + r * 0.5, 0);
    add(g, () => kit.beacon(0, topY + r * 0.9, 0, color, 0.4));
  },

  "runtime-acp2"({ g, w, h, d, color, kit }) {
    const m = kit.mat || {};
    const base = 0.5;
    const bodyH = h * 0.58;
    const bodyTop = base + bodyH;

    // Same family as acp1 — plant, not office — but compact, louvered and hip-roofed.
    add(
      g,
      () => kit.box(w * 1.06, base, d * 1.06, m.darkSlate),
      0,
      base / 2,
      0
    );
    add(
      g,
      () => kit.box(w * 0.84, bodyH, d * 0.84, m.concrete),
      0,
      base + bodyH / 2,
      0
    );
    add(
      g,
      () => kit.louvers(w * 0.86, bodyH * 0.78, d * 0.86, 7, m.steel),
      0,
      base + bodyH * 0.48,
      0
    );
    add(
      g,
      () => kit.roofHipped(w * 0.92, d * 0.92, h * 0.2, m.slate),
      0,
      bodyTop,
      0
    );
    add(
      g,
      () => kit.fan(0.85, m.steel),
      -w * 0.2,
      bodyTop + h * 0.21,
      d * 0.16
    );

    // Exhaust stack with its own smaller catwalk.
    add(
      g,
      () => kit.chimney(0.55, h * 0.62, m.steel),
      w * 0.3,
      base + bodyH * 0.4,
      -d * 0.28
    );
    add(
      g,
      () => kit.catwalk(w * 0.26, base + bodyH * 0.86, m.steel),
      w * 0.3,
      0,
      -d * 0.28
    );
    add(
      g,
      () => kit.ductRun(0.8, w * 0.7, m.steel),
      0,
      base + bodyH * 0.86,
      -d * 0.28
    );
    add(
      g,
      () => kit.vent(0.4, 0.7, m.steel),
      -w * 0.28,
      bodyTop + h * 0.1,
      -d * 0.2
    );
    add(
      g,
      () => kit.crateStack(w * 0.3, 1.2, d * 0.24, m.timber),
      -w * 0.42,
      0,
      d * 0.5
    );

    add(
      g,
      () => kit.signBand(w * 0.44, 0.4, color),
      0,
      base + bodyH * 0.18,
      d * 0.43
    );
    add(
      g,
      () => kit.box(w * 0.2, 1.8, 0.2, kit.matGlow(color, 0.5)),
      -w * 0.12,
      base + 0.9,
      d * 0.43
    );
    add(g, () =>
      kit.beacon(w * 0.3, base + bodyH * 0.4 + h * 0.62, -d * 0.28, color, 0.34)
    );
  },

  "runtime-registry"({ g, w, h, d, color, kit }) {
    const m = kit.mat || {};
    const pad = 0.4;
    const rackH = h * 0.82;

    // A pigeonhole rack: open steel frame, labelled cubbies, some slots empty on purpose.
    add(g, () => kit.box(w * 1.04, pad, d * 1.04, m.concrete), 0, pad / 2, 0);
    for (let sx = -1; sx <= 1; sx += 2) {
      for (let sz = -1; sz <= 1; sz += 2) {
        add(
          g,
          () => kit.box(0.28, rackH, 0.28, m.steel),
          sx * w * 0.44,
          pad + rackH / 2,
          sz * d * 0.34
        );
      }
    }
    for (let i = 0; i < 4; i++) {
      const y = pad + (rackH * i) / 3.2 + 0.1;
      add(g, () => kit.box(w * 0.94, 0.16, d * 0.72, m.steel), 0, y, 0);
    }
    for (let i = -1; i <= 1; i++) {
      add(
        g,
        () => kit.box(0.14, rackH * 0.94, d * 0.7, m.steel),
        i * w * 0.28,
        pad + rackH * 0.47,
        0
      );
    }
    // Occupied slots are installed, pinned runner kinds; the gaps are the ones you have not got.
    add(
      g,
      () => kit.crateStack(w * 0.22, rackH * 0.26, d * 0.5, m.timber),
      -w * 0.36,
      pad + 0.18,
      0
    );
    add(
      g,
      () => kit.box(w * 0.24, rackH * 0.24, d * 0.52, m.timber),
      -w * 0.08,
      pad + rackH * 0.44,
      0
    );
    add(
      g,
      () => kit.box(w * 0.24, rackH * 0.24, d * 0.52, m.plaster),
      w * 0.2,
      pad + 0.24,
      0
    );
    add(
      g,
      () => kit.box(w * 0.24, rackH * 0.24, d * 0.52, m.timber),
      w * 0.36,
      pad + rackH * 0.72,
      0
    );
    // Brass consent tag on one slot — no egress without a grant on file.
    add(
      g,
      () => kit.box(0.5, 0.5, 0.3, m.brass),
      w * 0.2,
      pad + rackH * 0.24,
      d * 0.36
    );

    // Open louvered canopy instead of a roof — the rack stays see-through.
    add(
      g,
      () => kit.truss(w * 1, 0.4, m.steel, { segments: 5 }),
      0,
      pad + rackH + 0.05,
      0
    );
    add(
      g,
      () => kit.louvers(w * 1, 0.7, d * 0.8, 6, m.steel),
      0,
      pad + rackH + 0.5,
      0
    );

    // Accent: the little labels along each shelf lip.
    for (let i = 0; i < 3; i++) {
      const y = pad + (rackH * (i + 1)) / 3.2 + 0.1;
      add(g, () => kit.signBand(w * 0.9, 0.16, color), 0, y, d * 0.37);
    }
    add(g, () => kit.beacon(0, pad + rackH + 1, 0, color, 0.3));
  },

  "runtime-models"({ g, w, h, d, color, kit }) {
    const m = kit.mat || {};
    const pad = 0.35;
    const r = Math.min(h * 0.24, d * 0.15);
    const tankLen = w * 0.86;
    const tankY = pad + r + 0.7;

    // Fuel depot: the model catalog as a row of horizontal tanks behind a gauge board.
    add(g, () => kit.box(w * 1.08, pad, d * 1.08, m.concrete), 0, pad / 2, 0);
    for (let i = -1; i <= 1; i++) {
      const z = i * d * 0.28 - d * 0.1;
      add(g, () => kit.tank(r, tankLen, m.steel, { lying: true }), 0, tankY, z);
      add(
        g,
        () => kit.box(r * 1.4, 0.7, r * 0.7, m.darkSlate),
        -tankLen * 0.32,
        pad + 0.35,
        z
      );
      add(
        g,
        () => kit.box(r * 1.4, 0.7, r * 0.7, m.darkSlate),
        tankLen * 0.32,
        pad + 0.35,
        z
      );
    }
    add(g, () =>
      kit.pipeRun(
        [
          [-tankLen * 0.46, tankY + r * 0.6, -d * 0.38],
          [-tankLen * 0.46, tankY + r * 0.6, d * 0.2],
          [-tankLen * 0.2, tankY + r * 0.6, d * 0.2],
          [-tankLen * 0.2, pad + 0.4, d * 0.34],
        ],
        0.16,
        m.steel
      )
    );
    add(
      g,
      () => kit.vent(0.3, 0.9, m.brass),
      tankLen * 0.4,
      tankY + r,
      d * 0.18
    );

    // The pricing board out front, tilted to be read from the road.
    turn(
      add(
        g,
        () => kit.gaugeBoard(w * 0.72, h * 0.46, m.steel, color),
        0,
        pad + h * 0.32,
        d * 0.44
      ),
      -0.22,
      0,
      0
    );
    add(
      g,
      () => kit.box(0.22, pad + h * 0.3, 0.22, m.steel),
      -w * 0.3,
      (pad + h * 0.3) / 2,
      d * 0.44
    );
    add(
      g,
      () => kit.box(0.22, pad + h * 0.3, 0.22, m.steel),
      w * 0.3,
      (pad + h * 0.3) / 2,
      d * 0.44
    );
    add(
      g,
      () => kit.signBand(w * 0.5, 0.34, color),
      0,
      pad + h * 0.56,
      d * 0.44
    );
    add(g, () =>
      kit.bollards(
        [
          [-w * 0.42, d * 0.5],
          [0, d * 0.54],
          [w * 0.42, d * 0.5],
        ],
        m.steel
      )
    );
    add(g, () =>
      kit.beacon(-tankLen * 0.46, tankY + r * 1.5, -d * 0.38, color, 0.3)
    );
  },
};
