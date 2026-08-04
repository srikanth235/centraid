// landmarks-data.ts — consent, vault, wal, backup. See KIT_API.md.
//
// Every builder below calls ONLY documented kit.* members with documented signatures.
// Positioning for members that don't document x/y/z opts (most non-box/drum/dome
// builders) is done by setting `.position` / `.rotation` on the returned Object3D —
// that's plain three.js, not an invented kit API.
//
// Flagged: none of these builders were invented. The one spec instruction that could
// not be satisfied as written is `wal-conveyor`'s scrolling belt texture — the
// landmark dispatch object (see world.ts "Bespoke landmark geometry") does not pass
// `convTex` to landmarks, so the belt is built as static geometry instead of pushing
// `{ type: 'conveyor', tex }` into `animated` (which would crash on `a.tex.offset.x`
// with an undefined texture).

import type { LandmarkBuilder } from "../core/types.js";

// small local helper — angle math only, not a kit member.
function ring(
  count: number,
  radius: number
): Array<{ x: number; z: number; a: number }> {
  const pts: Array<{ x: number; z: number; a: number }> = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    pts.push({ x: Math.cos(a) * radius, z: Math.sin(a) * radius, a });
  }
  return pts;
}

export const LANDMARKS_DATA: Record<string, LandmarkBuilder> = {
  // ---------------------------------------------------------------- consent
  "consent-arch"({ g, w, h, d, color, kit }) {
    const pierW = Math.max(1.2, w * 0.18);
    const gap = Math.max(1.5, w - pierW * 2);
    const pierH = h * 0.85;
    const left = kit.box(pierW, pierH, d * 0.6, kit.mat.bone, {
      y: pierH / 2,
      x: -(gap / 2 + pierW / 2),
      windows: false,
    });
    const right = kit.box(pierW, pierH, d * 0.6, kit.mat.bone, {
      y: pierH / 2,
      x: gap / 2 + pierW / 2,
      windows: false,
    });
    g.add(left, right);

    const header = kit.box(w, h * 0.22, d * 0.55, kit.mat.bone, {
      y: pierH + (h * 0.22) / 2,
      windows: false,
    });
    g.add(header);
    const coping = kit.roofParapet(w, d * 0.55, kit.mat.slate);
    coping.position.y = pierH + h * 0.22;
    g.add(coping);

    // glowing scan curtain filling the gate opening
    const curtain = kit.signBand(gap * 0.82, pierH * 0.9, color, {
      y: pierH * 0.45,
      z: 0,
    });
    g.add(curtain);

    // guard booths flanking the gate
    const boothL = kit.box(1.6, 2.3, 1.6, kit.mat.plaster, {
      y: 1.15,
      x: -(gap / 2 + pierW + 1.4),
      z: d * 0.35,
    });
    const boothR = kit.box(1.6, 2.3, 1.6, kit.mat.plaster, {
      y: 1.15,
      x: gap / 2 + pierW + 1.4,
      z: d * 0.35,
    });
    g.add(boothL, boothR);

    // boom barrier arms, raised
    const barL = kit.box(2.6, 0.15, 0.15, kit.mat.brass, { y: 1.1 });
    barL.position.x = -(gap / 2 + pierW + 0.6);
    barL.position.z = d * 0.35;
    barL.rotation.z = 0.55;
    const barR = kit.box(2.6, 0.15, 0.15, kit.mat.brass, { y: 1.1 });
    barR.position.x = gap / 2 + pierW + 0.6;
    barR.position.z = d * 0.35;
    barR.rotation.z = -0.55;
    g.add(barL, barR);
  },

  "consent-parking"({ g, w, h, d, color, kit }) {
    const liftH = Math.max(1.6, h * 0.35);
    const deckT = 0.5;
    const legs = kit.pilotis(w * 0.9, d * 0.9, liftH, kit.mat.concrete);
    g.add(legs);
    const deck = kit.box(w, deckT, d, kit.mat.concrete, {
      y: liftH + deckT / 2,
      windows: false,
    });
    g.add(deck);

    // low rim
    const rimN = kit.box(w, 0.4, 0.2, kit.mat.darkSlate, { windows: false });
    rimN.position.set(0, liftH + deckT + 0.2, d / 2);
    const rimS = kit.box(w, 0.4, 0.2, kit.mat.darkSlate, { windows: false });
    rimS.position.set(0, liftH + deckT + 0.2, -d / 2);
    g.add(rimN, rimS);

    // parked crates, neutral bodies
    for (let i = 0; i < 3; i++) {
      const crate = kit.crateStack(1.3, 1.1, 1.3, kit.mat.timber, {});
      crate.position.set(
        -w * 0.3 + i * (w * 0.3),
        liftH + deckT,
        -d * 0.15 + (i % 2) * d * 0.2
      );
      g.add(crate);
    }

    // small district plaque, the one accent touch
    const plaque = kit.signBand(w * 0.35, 0.4, color, {
      y: liftH + deckT + 0.5,
      z: d / 2 + 0.05,
    });
    g.add(plaque);
  },

  "consent-ledger"({ g, w, h, d, kit }) {
    const bodyH = h * 0.7;
    const body = kit.box(w, bodyH, d, kit.mat.bone, { y: bodyH / 2 });
    g.add(body);

    const arc = kit.arcade(5, w * 0.85, bodyH * 0.6, 0.9, kit.mat.concrete);
    arc.position.set(0, 0, d / 2);
    g.add(arc);

    const plaques = kit.plaqueWall(w * 0.7, bodyH * 0.28, 6, 3, kit.mat.brass);
    plaques.position.set(0, bodyH * 0.58, d / 2 + 0.08);
    g.add(plaques);

    const roof = kit.roofHipped(w, d, h * 0.22, kit.mat.slate);
    roof.position.y = bodyH;
    g.add(roof);
  },

  // ------------------------------------------------------------------ vault
  "vault-core"({ g, w, h, d, color, kit }) {
    const r = Math.max(2.5, Math.min(w, d) * 0.5);
    const bodyH = h * 0.6;
    const drum = kit.drum(r, r * 1.05, bodyH, kit.mat.bone, { seg: 16 });
    g.add(drum);

    const dome = kit.roofDomeRibbed(r * 1.02, kit.mat.copper, { ratio: 0.42 });
    dome.position.y = bodyH;
    g.add(dome);

    // radiating spoke walls at plinth level
    const spokeLen = Math.max(2, w * 0.4);
    const spokes = ring(6, 0);
    for (const s of spokes) {
      const spoke = kit.box(spokeLen, 0.9, 0.7, kit.mat.concrete, {
        y: 0.45,
        windows: false,
      });
      spoke.position.set(
        Math.cos(s.a) * (r + spokeLen / 2),
        0.45,
        Math.sin(s.a) * (r + spokeLen / 2)
      );
      spoke.rotation.y = -s.a;
      g.add(spoke);
    }

    // ring of glowing ports (FKs into core_party)
    const ports = ring(10, r * 0.98);
    for (const p of ports) {
      g.add(kit.beacon(p.x, bodyH * 0.5, p.z, color, 0.28));
    }
  },

  "vault-journal"({ g, w, h, d, color, kit }) {
    const n = 6;
    const segW = w / n;
    for (let i = 0; i < n; i++) {
      const segH = Math.max(0.6, h * (0.18 + (i / (n - 1)) * 0.82));
      const seg = kit.box(segW * 0.96, segH, d, kit.mat.bone, {
        y: segH / 2,
        x: -w / 2 + segW * (i + 0.5),
        windows: false,
      });
      g.add(seg);
      if (i === n - 1) {
        const glow = kit.signBand(segW * 0.85, 0.3, color, {
          y: segH + 0.05,
          z: 0,
        });
        glow.position.x = seg.position.x;
        g.add(glow);
      }
    }
  },

  "vault-fts"({ g, w, h, d, kit }) {
    const mastW = Math.max(2, Math.min(w, d) * 0.55);
    const mast = kit.latticeMast(h * 0.95, mastW, kit.mat.brass);
    g.add(mast);

    const cap = kit.roofCone(mastW * 0.55, h * 0.15, kit.mat.brass);
    cap.position.y = h * 0.95;
    g.add(cap);

    // stacked openwork grid frames
    const half = mastW / 2;
    for (let lvl = 1; lvl <= 3; lvl++) {
      const y = (h * 0.95 * lvl) / 4;
      const front = kit.truss(mastW, 0.5, kit.mat.steel);
      front.position.set(0, y, half);
      const back = kit.truss(mastW, 0.5, kit.mat.steel);
      back.position.set(0, y, -half);
      const left = kit.truss(mastW, 0.5, kit.mat.steel);
      left.rotation.y = Math.PI / 2;
      left.position.set(-half, y, 0);
      const right = kit.truss(mastW, 0.5, kit.mat.steel);
      right.rotation.y = Math.PI / 2;
      right.position.set(half, y, 0);
      g.add(front, back, left, right);
    }
  },

  "vault-sealed"({ g, w, h, d, color, kit }) {
    const body = kit.box(w, h, d, kit.mat.darkSlate, { windows: false });
    g.add(body);

    const doorR = Math.max(1.4, Math.min(w, h) * 0.32);
    const door = kit.drum(doorR, doorR, 0.5, kit.mat.brass, { seg: 16 });
    door.rotation.x = Math.PI / 2;
    door.position.set(0, h * 0.42, d / 2 + 0.25);
    g.add(door);

    // radial bolts around the door — ring() gives a 2D circle; reuse it as the
    // door's local x/y (the door faces along +z, so bolts sit in the x/y plane).
    const bolts = ring(10, doorR * 0.82);
    for (const b of bolts) {
      const bolt = kit.drum(0.14, 0.14, 0.18, kit.mat.brass, { seg: 8 });
      bolt.rotation.x = Math.PI / 2;
      bolt.position.set(b.x, h * 0.42 + b.z, d / 2 + 0.32);
      g.add(bolt);
    }

    // minimal light — a single dim beacon at the door hub
    g.add(kit.beacon(0, h * 0.42, d / 2 + 0.5, color, 0.2));
  },

  "vault-spokes"({ g, w, h, d, kit }) {
    const count = 7;
    const spread = Math.max(w, d) * 0.42;
    const stelae = [];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const rr = spread * (0.6 + (0.4 * ((i * 37) % 5)) / 4);
      const sh = h * (0.35 + (0.55 * ((i * 53) % 7)) / 6);
      const st = kit.box(0.7, sh, 0.7, kit.mat.concrete, {
        y: sh / 2,
        windows: false,
      });
      st.position.set(Math.cos(a) * rr, sh / 2, Math.sin(a) * rr);
      g.add(st);
      stelae.push({ x: st.position.x, z: st.position.z });
    }
    // low connecting walls between consecutive stelae
    for (let i = 0; i < stelae.length; i++) {
      const a = stelae[i];
      const b = stelae[(i + 1) % stelae.length];
      const mx = (a.x + b.x) / 2;
      const mz = (a.z + b.z) / 2;
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const ang = Math.atan2(b.z - a.z, b.x - a.x);
      const wall = kit.box(len, 0.6, 0.3, kit.mat.concrete, {
        y: 0.3,
        windows: false,
      });
      wall.position.set(mx, 0.3, mz);
      wall.rotation.y = -ang;
      g.add(wall);
    }
  },

  // -------------------------------------------------------------------- wal
  "wal-conveyor"({ g, w, h, kit }) {
    const beltLen = Math.max(4, w * 1.4);
    const gallery = kit.box(beltLen, 0.7, 2, kit.mat.steel, {
      windows: false,
    });
    gallery.position.set(0, h * 0.45, 0);
    gallery.rotation.z = 0.22;
    g.add(gallery);

    const cover = kit.roofBarrel(beltLen, 2, 0.6, kit.mat.slate);
    cover.rotation.z = 0.22;
    cover.position.set(0, h * 0.45 + 0.55, 0);
    g.add(cover);

    // trestle legs, rising with the incline
    const legN = 5;
    for (let i = 0; i < legN; i++) {
      const t = i / (legN - 1);
      const legH = Math.max(0.6, h * 0.15 + t * h * 0.55);
      const leg = kit.box(0.3, legH, 0.3, kit.mat.steel, {
        y: legH / 2,
        windows: false,
      });
      leg.position.set(-beltLen / 2 + t * beltLen, legH / 2, 1.3);
      g.add(leg);
    }

    // hopper at the high end — a battered mass flipped to funnel downward
    const hopper = kit.wedge(1.8, 1.6, 1.8, kit.mat.darkSlate);
    hopper.rotation.x = Math.PI;
    hopper.position.set(
      beltLen / 2,
      h * 0.45 + Math.sin(0.22) * beltLen * 0.02 + 1.2,
      0
    );
    g.add(hopper);

    // NOTE: no scrolling texture — landmarks don't receive `convTex` (see file header).
  },

  "wal-checkpointer"({ g, w, h, d, color, kit }) {
    const r = Math.max(2, Math.min(w, d) * 0.42);
    const bodyH = h * 0.55;
    const body = kit.drum(r, r, bodyH, kit.mat.slate, { seg: 16 });
    g.add(body);

    const cap = kit.dome(r * 0.95, kit.mat.slate, {
      ratio: 0.38,
      y: bodyH,
      seg: 14,
    });
    g.add(cap);

    const wheel = kit.wheel(r * 0.5, kit.mat.steel);
    wheel.position.set(r + 0.4, bodyH * 0.55, 0);
    g.add(wheel);

    const piston = kit.piston(1.8, 0.28, kit.mat.steel);
    piston.rotation.z = Math.PI / 2;
    piston.position.set(-(r + 0.5), bodyH * 0.4, 0);
    g.add(piston);

    const gauges = kit.gaugeBoard(r * 0.9, bodyH * 0.35, kit.mat.steel, color);
    gauges.position.set(0, bodyH * 0.5, r + 0.08);
    g.add(gauges);

    const cat = kit.catwalk(r + 0.6, bodyH * 0.85, kit.mat.steel);
    g.add(cat);
  },

  "wal-shipper"({ g, w, h, d, kit }) {
    const bodyW = w * 0.6;
    const bodyH = h * 0.6;
    const body = kit.box(bodyW, bodyH, d, kit.mat.bone, {
      y: bodyH / 2,
      windows: false,
    });
    g.add(body);
    const roof = kit.roofGable(bodyW, d, h * 0.2, kit.mat.slate);
    roof.position.y = bodyH;
    g.add(roof);

    // angled chute aimed away from the body
    const chute = kit.box(Math.max(3, w * 0.9), 0.6, 1.3, kit.mat.steel, {
      windows: false,
    });
    chute.position.set(bodyW / 2 + w * 0.35, bodyH * 0.6, 0);
    chute.rotation.z = -0.32;
    g.add(chute);

    // rails
    const rail1 = kit.box(w * 1.1, 0.15, 0.15, kit.mat.steel, {
      windows: false,
    });
    rail1.position.set(bodyW * 0.2, 0.1, 0.9);
    const rail2 = kit.box(w * 1.1, 0.15, 0.15, kit.mat.steel, {
      windows: false,
    });
    rail2.position.set(bodyW * 0.2, 0.1, -0.9);
    g.add(rail1, rail2);

    // queued segment crates
    for (let i = 0; i < 4; i++) {
      const crate = kit.crateStack(1.1, 1, 1.1, kit.mat.timber, {});
      crate.position.set(
        bodyW * 0.2 + i * 1.4,
        0.55,
        0.9 * (i % 2 === 0 ? 1 : -1)
      );
      g.add(crate);
    }
  },

  // ---------------------------------------------------------------- backup
  "backup-bunker1"({ g, w, h, d, kit }) {
    const berm = kit.wedge(w * 1.1, h * 0.75, d * 1.1, kit.mat.concrete);
    g.add(berm);

    const cap = kit.roofParapet(w * 0.75, d * 0.75, kit.mat.darkSlate);
    cap.position.y = h * 0.62;
    g.add(cap);

    const doorR = Math.max(1, h * 0.22);
    const door = kit.drum(doorR, doorR, 0.35, kit.mat.darkSlate, { seg: 12 });
    door.rotation.x = Math.PI / 2;
    door.position.set(0, doorR + 0.2, d * 0.55 + 0.2);
    g.add(door);
  },

  "backup-bunker2"({ g, w, h, d, kit }) {
    const r = Math.max(1, Math.min(w, d) * 0.16);
    const siloH = h * 0.85;
    const offsets = [
      [-w * 0.28, -d * 0.2],
      [w * 0.05, -d * 0.28],
      [w * 0.3, -d * 0.05],
      [-w * 0.02, d * 0.22],
    ];
    const tops = [];
    for (const [x, z] of offsets) {
      const silo = kit.silo(r, siloH, kit.mat.concrete);
      silo.position.set(x, 0, z);
      g.add(silo);
      const cap = kit.roofCone(r * 1.02, siloH * 0.22, kit.mat.slate);
      cap.position.set(x, siloH, z);
      g.add(cap);
      tops.push({ x, z });
    }
    // link bridge between the first two silos
    const a = tops[0];
    const b = tops[1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const ang = Math.atan2(b.z - a.z, b.x - a.x);
    const bridge = kit.truss(len, 0.5, kit.mat.steel);
    bridge.position.set((a.x + b.x) / 2, siloH * 0.65, (a.z + b.z) / 2);
    bridge.rotation.y = -ang;
    g.add(bridge);
  },

  "backup-bunker3"({ g, w, h, d, kit }) {
    const bodyW = w * 0.6;
    const bodyD = d * 0.6;
    const bodyH = h * 0.5;
    const body = kit.box(bodyW, bodyH, bodyD, kit.mat.terracotta, {
      y: bodyH / 2,
    });
    g.add(body);
    const roof = kit.roofGable(bodyW, bodyD, h * 0.22, kit.mat.slate);
    roof.position.y = bodyH;
    g.add(roof);

    const chimney = kit.chimney(0.35, h * 0.5, kit.mat.terracotta);
    chimney.position.set(bodyW * 0.3, bodyH, bodyD * 0.15);
    g.add(chimney);

    // records annex, small domestic wing
    const annex = kit.box(w * 0.3, bodyH * 0.7, d * 0.35, kit.mat.plaster, {
      y: (bodyH * 0.7) / 2,
      x: bodyW * 0.65,
    });
    g.add(annex);
  },
};
