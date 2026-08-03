// governance: allow-repo-hygiene file-size-limit — a flat catalog of 69 independent
// geometry primitives with no internal coupling; splitting it would scatter one lookup
// table across files without reducing what a reader has to hold. Revisit in #704.
// kit.ts — shared landmark geometry kit. See KIT_API.md for the full contract.
//
// Aesthetic: precision architectural model — basswood-and-brass massing on a blueprint
// table. Restrained neutral bodies, lavish silhouettes, district colour only on signage,
// seams, ports and beacons.
//
// CONVENTIONS (every builder honours these):
//   * Every builder returns a THREE.Object3D and positions itself from `opts`
//     ({ x, y, z, rotY } where sensible). Nothing assumes it is alone in its group.
//   * VOLUMES are CENTRED on `y` — box, drum, vault, wedge, curtainWall, punchedWindows,
//     ribbedFacade, louvers, masonryBands. So `kit.box(w, h, d, m, { y: h / 2 })` sits on
//     the plate, matching the KIT_API example.
//   * EVERYTHING ELSE sits with its BASE at `y` and builds upward — roofs, domes, prisms,
//     hulls, structure and props. `kit.roofGable(w, d, rise, m, { y: h })` caps a box of
//     height h.
//   * Meshes get castShadow/receiveShadow, except glass and glow (unlit) materials.
//   * Materials come only from the injected factories, so they stay cached + night-aware.
//   * Repeated sub-parts (columns, fins, ribs, treads, mullions) are merged into a single
//     BufferGeometry before they become a mesh — one draw call per rhythm, not per part.

import type { Material, MeshBasicMaterial } from "three";

import type {
  AnimationRecord,
  CityKit,
  GlowMaterialFactory,
  KitOptions,
  SurfaceMaterialFactory,
  ThreeNamespace,
} from "../core/types.js";

interface KitDependencies {
  facadeMat: SurfaceMaterialFactory;
  plainMat: SurfaceMaterialFactory;
  glowMat: GlowMaterialFactory;
  animated: AnimationRecord[];
}

export function makeKit(
  THREE: ThreeNamespace,
  { facadeMat, plainMat, glowMat, animated }: KitDependencies
): CityKit {
  /* ------------------------------------------------------------------ helpers */

  const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
  const _mtx = new THREE.Matrix4();
  const _quat = new THREE.Quaternion();
  const _eul = new THREE.Euler();
  const _one = new THREE.Vector3(1, 1, 1);
  const _up = new THREE.Vector3(0, 1, 0);
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const TAU = Math.PI * 2;

  // Defensive coercion — landmarks are written by other hands, so a missing/zero/NaN
  // dimension must degrade to something sane instead of producing NaN geometry.
  const D = (v, dflt) =>
    typeof v === "number" && isFinite(v) && Math.abs(v) > 1e-4 ? v : dflt;
  const N = (v, dflt) => (typeof v === "number" && isFinite(v) ? v : dflt);
  const M = (m, fb) => (m && m.isMaterial ? m : fb);
  const O = (o: KitOptions | undefined): KitOptions =>
    o && typeof o === "object" ? o : {};

  // Point normaliser: accepts [x, z], [x, y, z] and THREE.Vector3 alike. KIT_API.md never
  // pinned the arity and the lanes used all three, so every point-taking helper goes
  // through this.
  function toVec3(p, defaultY = 0) {
    if (!p) return V3(0, defaultY, 0);
    if (p.isVector3) return V3(N(p.x, 0), N(p.y, defaultY), N(p.z, 0));
    if (Array.isArray(p)) {
      if (p.length >= 3) return V3(N(p[0], 0), N(p[1], defaultY), N(p[2], 0));
      if (p.length === 2) return V3(N(p[0], 0), defaultY, N(p[1], 0));
      return V3(N(p[0], 0), defaultY, 0);
    }
    if (typeof p === "object")
      return V3(N(p.x, 0), N(p.y, defaultY), N(p.z, 0));
    return V3(0, defaultY, 0);
  }
  const toVec3List = (pts, defaultY = 0) =>
    Array.isArray(pts) ? pts.map((p) => toVec3(p, defaultY)) : [];

  // Deterministic jitter — stable across reloads, unlike Math.random().
  const rnd = (i, salt = 0) => {
    const x = Math.sin((i + 1) * 127.1 + salt * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };

  // Materials that must never cast/receive shadows (unlit glow, smoked glass).
  const noShadow = new Set();
  const isNoShadow = (m) =>
    !m || m.isMeshBasicMaterial === true || noShadow.has(m);

  function place(o, opts) {
    if (!opts) return o;
    o.position.set(opts.x || 0, opts.y || 0, opts.z || 0);
    if (opts.rotY) o.rotation.y = opts.rotY;
    if (opts.rotX) o.rotation.x = opts.rotX;
    if (opts.rotZ) o.rotation.z = opts.rotZ;
    return o;
  }

  function group(opts: KitOptions = {}) {
    return place(new THREE.Group(), opts);
  }

  function mesh(geo, mat, opts: KitOptions = {}) {
    const m = new THREE.Mesh(geo, mat);
    place(m, opts);
    const off = isNoShadow(mat);
    m.castShadow = !off;
    m.receiveShadow = !off;
    return m;
  }

  function xf(
    geo,
    x = 0,
    y = 0,
    z = 0,
    rx = 0,
    ry = 0,
    rz = 0,
    sx = 1,
    sy = 1,
    sz = 1
  ) {
    _eul.set(rx, ry, rz);
    _quat.setFromEuler(_eul);
    _mtx.compose(V3(x, y, z), _quat, V3(sx, sy, sz));
    geo.applyMatrix4(_mtx);
    return geo;
  }

  // Manual merge — no BufferGeometryUtils dependency. All inputs are geometries created
  // inside this module, so disposing them afterwards is safe.
  function mergeGeos(geos) {
    const list = [];
    for (const g of geos) {
      if (!g) continue;
      if (!g.attributes.normal) g.computeVertexNormals();
      list.push(g.index ? g.toNonIndexed() : g);
    }
    if (list.length === 0) return new THREE.BufferGeometry();
    if (list.length === 1) return list[0];
    let n = 0;
    for (const g of list) n += g.attributes.position.count;
    const pos = new Float32Array(n * 3);
    const nrm = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2);
    let o = 0;
    for (const g of list) {
      const p = g.attributes.position;
      const nn = g.attributes.normal;
      const uu = g.attributes.uv;
      pos.set(
        p.array.subarray ? p.array.subarray(0, p.count * 3) : p.array,
        o * 3
      );
      if (nn)
        nrm.set(
          nn.array.subarray ? nn.array.subarray(0, p.count * 3) : nn.array,
          o * 3
        );
      if (uu)
        uv.set(
          uu.array.subarray ? uu.array.subarray(0, p.count * 2) : uu.array,
          o * 2
        );
      o += p.count;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    out.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    for (const g of list) g.dispose();
    return out;
  }

  // A box beam running from a to b (arrays or Vector3) — struts, braces, cables, rails.
  function strutGeo(a, b, t, t2 = t) {
    const A = toVec3(a);
    const B = toVec3(b);
    const dir = B.clone().sub(A);
    const len = dir.length();
    if (len < 1e-5) return null;
    const g = new THREE.BoxGeometry(t, len, t2 == null ? t : t2);
    _quat.setFromUnitVectors(_up, dir.divideScalar(len));
    _mtx.compose(A.add(B).multiplyScalar(0.5), _quat, _one);
    g.applyMatrix4(_mtx);
    return g;
  }

  // Round tube from a to b.
  function tubeGeo(a, b, r, seg = 6) {
    const A = toVec3(a);
    const B = toVec3(b);
    const dir = B.clone().sub(A);
    const len = dir.length();
    if (len < 1e-5) return null;
    const g = new THREE.CylinderGeometry(r, r, len, seg, 1);
    _quat.setFromUnitVectors(_up, dir.divideScalar(len));
    _mtx.compose(A.add(B).multiplyScalar(0.5), _quat, _one);
    g.applyMatrix4(_mtx);
    return g;
  }

  // Tapered rectangular solid, base at y=0.
  function frustumGeo(wb, db, wt, dt, h) {
    const b = [
      [-wb / 2, 0, db / 2],
      [wb / 2, 0, db / 2],
      [wb / 2, 0, -db / 2],
      [-wb / 2, 0, -db / 2],
    ];
    const t = [
      [-wt / 2, h, dt / 2],
      [wt / 2, h, dt / 2],
      [wt / 2, h, -dt / 2],
      [-wt / 2, h, -dt / 2],
    ];
    const v = [];
    const push = (...ps) => {
      for (const p of ps) v.push(p[0], p[1], p[2]);
    };
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      push(b[i], b[j], t[j], b[i], t[j], t[i]);
    }
    push(t[0], t[1], t[2], t[0], t[2], t[3]);
    push(b[0], b[2], b[1], b[0], b[3], b[2]);
    return rawGeo(v);
  }

  function rawGeo(v) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
    g.setAttribute(
      "uv",
      new THREE.Float32BufferAttribute(
        Array.from({ length: (v.length / 3) * 2 }, () => 0.02),
        2
      )
    );
    g.computeVertexNormals();
    return g;
  }

  // Box UVs so the shared window texture keeps a constant world-space density and roof /
  // floor faces land in the blank band at the bottom of the texture. Mirrors world.ts.
  function windowUVs(geo, w, h, d) {
    const uv = geo.attributes.uv;
    if (!uv) return geo;
    const U = 2.4;
    const V = 3;
    const cols = 6;
    const rows = 12;
    const face = (start, su, sv) => {
      const ru = su / (cols * U);
      const rv = sv / (rows * V);
      const base = 0.08;
      const span = 0.92;
      uv.setXY(start + 0, 0, base + span * rv);
      uv.setXY(start + 1, ru, base + span * rv);
      uv.setXY(start + 2, 0, base);
      uv.setXY(start + 3, ru, base);
    };
    face(0, d, h);
    face(4, d, h);
    for (let i = 8; i < 16; i++) uv.setXY(i, 0.5, 0.02);
    face(16, w, h);
    face(20, w, h);
    uv.needsUpdate = true;
    return geo;
  }

  // Square chamfer cap: a 4-sided frustum whose top is inset by `c` on every edge.
  const chamferGeo = (w, d, h, c) =>
    frustumGeo(w, d, Math.max(0.05, w - 2 * c), Math.max(0.05, d - 2 * c), h);

  /* ------------------------------------------------------------------ materials */

  // Neutral palette. Bodies live here; district colour is an accent only.
  const MAT_SPEC: Record<
    string,
    { hex: string; rough: number; metal: number }
  > = {
    bone: { hex: "#e8e2d6", rough: 0.86, metal: 0.02 },
    concrete: { hex: "#cfc9bd", rough: 0.93, metal: 0.02 },
    plaster: { hex: "#ded6c6", rough: 0.95, metal: 0 },
    slate: { hex: "#5d6570", rough: 0.78, metal: 0.14 },
    darkSlate: { hex: "#3b424c", rough: 0.84, metal: 0.16 },
    steel: { hex: "#97a1ad", rough: 0.4, metal: 0.6 },
    brass: { hex: "#c08a3e", rough: 0.3, metal: 0.85 },
    copper: { hex: "#7fae9b", rough: 0.55, metal: 0.5 },
    glass: { hex: "#2b3440", rough: 0.12, metal: 0.35 },
    timber: { hex: "#a97d4f", rough: 0.86, metal: 0.02 },
    terracotta: { hex: "#b4674d", rough: 0.9, metal: 0.02 },
    rubber: { hex: "#2f333a", rough: 0.98, metal: 0.02 },
  };

  const mat: Record<string, Material> = {};
  for (const key of Object.keys(MAT_SPEC)) {
    const s = MAT_SPEC[key];
    mat[key] = plainMat(s.hex, { rough: s.rough, metal: s.metal });
  }
  // Smoked glass reads best without shadow contribution.
  noShadow.add(mat.glass);

  const matWindows = (hex) => facadeMat(hex || "#d9d3c6");

  const glowCache = new Map<string, MeshBasicMaterial>();
  const matGlow = (hex, base = 0.55) => {
    const key = `${hex}|${base}`;
    let m = glowCache.get(key);
    if (m) return m;
    m = glowMat(hex, base);
    glowCache.set(key, m);
    return m;
  };

  const _ca = new THREE.Color();
  const _cb = new THREE.Color();
  const matTint = (baseKey, hex, amt = 0.22) => {
    const s = MAT_SPEC[baseKey] || MAT_SPEC.bone;
    _ca.set(s.hex);
    _cb.set(hex);
    _ca.lerp(_cb, clamp(amt, 0, 1));
    return plainMat(`#${_ca.getHexString()}`, {
      rough: s.rough,
      metal: s.metal,
    });
  };

  /* ------------------------------------------------------------------ volumes */

  // box — centred on y. opts { x, y, z, rotY, windows, bevel }
  //   windows: true applies the window UV mapping (pass kit.matWindows(hex) as `m`);
  //            a hex string does both.
  function box(rw, rh, rd, m, rawOpts) {
    const opts = O(rawOpts);
    const w = Math.abs(D(rw, 4));
    const h = Math.abs(D(rh, 4));
    const d = Math.abs(D(rd, 4));
    let material = M(m, mat.bone);
    const bev = opts.bevel
      ? Math.min(
          opts.bevel === true ? Math.min(w, d) * 0.08 : opts.bevel,
          Math.min(w, d) * 0.3,
          h * 0.4
        )
      : 0;
    if (typeof opts.windows === "string") material = matWindows(opts.windows);
    if (!bev) {
      const geo = new THREE.BoxGeometry(w, h, d);
      if (opts.windows) windowUVs(geo, w, h, d);
      return mesh(geo, material, opts);
    }
    const body = new THREE.BoxGeometry(w, h - bev, d);
    if (opts.windows) windowUVs(body, w, h - bev, d);
    xf(body, 0, -bev / 2, 0);
    const cap = xf(chamferGeo(w, d, bev, bev), 0, h / 2 - bev, 0);
    return mesh(mergeGeos([body, cap]), material, opts);
  }

  // drum — centred on y. opts { seg = 16, y, open, x, z, rotY }
  function drum(rTop, rBot, rh, m, rawOpts) {
    const opts = O(rawOpts);
    const seg = clamp(Math.round(D(opts.seg, 16)), 3, 24);
    const h = Math.abs(D(rh, 4));
    const geo = new THREE.CylinderGeometry(
      Math.max(0.001, Math.abs(D(rTop, 2))),
      Math.max(0.001, Math.abs(D(rBot, 2))),
      h,
      seg,
      1,
      !!opts.open
    );
    return mesh(geo, M(m, mat.bone), opts);
  }

  // dome — hemisphere, base at y. opts { y, ratio = 0.6, seg = 18 }
  function dome(rr, m, rawOpts) {
    const opts = O(rawOpts);
    const r = Math.abs(D(rr, 3));
    const seg = clamp(Math.round(D(opts.seg, 18)), 6, 18);
    const ratio = D(opts.ratio, 0.6);
    const geo = new THREE.SphereGeometry(
      r,
      seg,
      Math.max(5, Math.round(seg / 2)),
      0,
      TAU,
      0,
      Math.PI / 2
    );
    xf(geo, 0, 0, 0, 0, 0, 0, 1, ratio, 1);
    return mesh(geo, M(m, mat.copper), opts);
  }

  // vault — barrel-vaulted volume, CENTRED on y. Default: the arc crosses `w` and the
  // vault is extruded along `d` (ridge runs along Z). `opts.axis = 'x'` flips it so the
  // ridge runs along X instead.
  function vault(rw, rh, rd, m, rawOpts) {
    const opts = O(rawOpts);
    if (opts.axis === "x") {
      const inner = vault(rd, rh, rw, m, {
        ...opts,
        axis: "z",
        x: 0,
        y: 0,
        z: 0,
        rotY: 0,
      });
      const holder = group(opts);
      inner.rotation.y = Math.PI / 2;
      holder.add(inner);
      return holder;
    }
    const w = Math.abs(D(rw, 6));
    const h = Math.abs(D(rh, 6));
    const d = Math.abs(D(rd, 8));
    const g = group(opts);
    const r = w / 2;
    const rise = Math.min(r, h * 0.55);
    const wallH = Math.max(0.2, h - rise);
    const parts = [
      xf(new THREE.BoxGeometry(w, wallH, d), 0, -h / 2 + wallH / 2, 0),
      xf(
        barrelGeo(w, rise, d, Math.min(0.5, rise * 0.35)),
        0,
        -h / 2 + wallH,
        0
      ),
    ];
    // solid tympana so the ends read closed
    const tym = [];
    for (const sz of [d / 2 - 0.16, -d / 2 + 0.16]) {
      const s = new THREE.Shape();
      s.moveTo(-w / 2, 0);
      s.absellipse(0, 0, w / 2, rise, Math.PI, 0, true);
      s.lineTo(-w / 2, 0);
      const gg = new THREE.ExtrudeGeometry(s, {
        depth: 0.3,
        bevelEnabled: false,
        curveSegments: 10,
      });
      tym.push(xf(gg, 0, -h / 2 + wallH, sz - 0.15));
    }
    g.add(mesh(mergeGeos(parts.concat(tym)), M(m, mat.bone)));
    return g;
  }

  // Half-tube shell, base at y=0, axis along Z.
  function barrelGeo(w, rise, d, t = 0.4) {
    const s = new THREE.Shape();
    s.moveTo(w / 2, 0);
    s.absellipse(0, 0, w / 2, rise, 0, Math.PI, false);
    s.lineTo(-w / 2 + t, 0);
    s.absellipse(0, 0, w / 2 - t, Math.max(0.05, rise - t), Math.PI, 0, true);
    s.lineTo(w / 2, 0);
    const g = new THREE.ExtrudeGeometry(s, {
      depth: d,
      bevelEnabled: false,
      curveSegments: 14,
    });
    return xf(g, 0, 0, -d / 2);
  }

  // prismShape — extrude an arbitrary footprint [[x,z], …] (pairs, triples or Vector3).
  // CENTRED on y like the other volumes: spans -depth/2 … +depth/2.
  function prismShape(points, rdepth, m, rawOpts) {
    const opts = O(rawOpts);
    const pts = toVec3List(points);
    if (pts.length < 3) return group(opts);
    const depth = Math.abs(D(rdepth, 4));
    const s = new THREE.Shape();
    pts.forEach((p, i) =>
      i === 0 ? s.moveTo(p.x, -p.z) : s.lineTo(p.x, -p.z)
    );
    s.closePath();
    const bev = opts.bevel
      ? opts.bevel === true
        ? 0.28
        : D(opts.bevel, 0.28)
      : 0;
    const geo = new THREE.ExtrudeGeometry(s, {
      depth: Math.max(0.05, depth - (bev ? bev * 2 : 0)),
      bevelEnabled: !!bev,
      bevelSize: bev,
      bevelThickness: bev,
      bevelSegments: 1,
      curveSegments: 8,
    });
    xf(geo, 0, bev - depth / 2, 0, -Math.PI / 2, 0, 0);
    return mesh(geo, M(m, mat.bone), opts);
  }

  // wedge — battered mass, wider at the base. CENTRED on y. opts { taper = 0.62 }
  function wedge(rw, rh, rd, m, rawOpts) {
    const opts = O(rawOpts);
    const w = Math.abs(D(rw, 4));
    const h = Math.abs(D(rh, 6));
    const d = Math.abs(D(rd, 4));
    const taper = clamp(D(opts.taper, 0.62), 0.05, 1);
    const geo = xf(frustumGeo(w, d, w * taper, d * taper, h), 0, -h / 2, 0);
    return mesh(geo, M(m, mat.concrete), opts);
  }

  // hull — barge hull. CENTRED on y: keel at -depth/2, deck at +depth/2.
  function hull(rlen, rbeam, rdepth, m, rawOpts) {
    const opts = O(rawOpts);
    const len = Math.abs(D(rlen, 12));
    const beam = Math.abs(D(rbeam, 5));
    const depth = Math.abs(D(rdepth, 2.5));
    const hb = beam / 2;
    const hl = len / 2;
    const s = new THREE.Shape();
    s.moveTo(-hl, -hb * 0.86);
    s.lineTo(hl * 0.42, -hb);
    s.quadraticCurveTo(hl * 0.94, -hb * 0.7, hl, 0);
    s.quadraticCurveTo(hl * 0.94, hb * 0.7, hl * 0.42, hb);
    s.lineTo(-hl, hb * 0.86);
    s.quadraticCurveTo(-hl * 1.05, 0, -hl, -hb * 0.86);
    const bev = Math.min(beam * 0.22, depth * 0.42);
    const geo = new THREE.ExtrudeGeometry(s, {
      depth: Math.max(0.2, depth - bev * 2),
      bevelEnabled: true,
      bevelSize: bev,
      bevelThickness: bev,
      bevelSegments: 2,
      curveSegments: 8,
    });
    xf(geo, 0, bev - depth / 2, 0, -Math.PI / 2, 0, 0);
    return mesh(geo, M(m, mat.steel), opts);
  }

  /* ------------------------------------------------------------------ roofs */

  // roofGable — ridge along Z, gable ends face ±Z. Base at y. opts { overhang, rotY }
  function roofGable(w, d, rise, m, opts: KitOptions = {}) {
    const oh = opts.overhang == null ? 0.35 : opts.overhang;
    const W = w + oh * 2;
    const Dtot = d + oh * 2;
    const hw = W / 2;
    const hd = Dtot / 2;
    const v = [];
    const push = (...ps) => {
      for (const p of ps) v.push(p[0], p[1], p[2]);
    };
    const A = [-hw, 0, hd];
    const B = [hw, 0, hd];
    const C = [0, rise, hd];
    const Dp = [-hw, 0, -hd];
    const E = [hw, 0, -hd];
    const F = [0, rise, -hd];
    push(A, B, C);
    push(E, Dp, F);
    push(A, C, F, A, F, Dp);
    push(C, B, E, C, E, F);
    push(Dp, E, B, Dp, B, A);
    // ridge cap + eaves fascia
    const parts = [
      rawGeo(v),
      xf(new THREE.BoxGeometry(0.42, 0.3, Dtot + 0.2), 0, rise - 0.06, 0),
      xf(new THREE.BoxGeometry(W + 0.16, 0.34, 0.3), 0, 0.1, hd + 0.05),
      xf(new THREE.BoxGeometry(W + 0.16, 0.34, 0.3), 0, 0.1, -hd - 0.05),
    ];
    return mesh(mergeGeos(parts), m || mat.slate, opts);
  }

  // roofHipped — four slopes, ridge along the longer axis. Base at y.
  function roofHipped(w, d, rise, m, opts: KitOptions = {}) {
    const swap = w > d;
    const W = swap ? d : w;
    const Dtot = swap ? w : d;
    const hw = W / 2;
    const hd = Dtot / 2;
    const rl = (Dtot - W) / 2;
    const b = [
      [-hw, 0, hd],
      [hw, 0, hd],
      [hw, 0, -hd],
      [-hw, 0, -hd],
    ];
    const r0 = [0, rise, rl];
    const r1 = [0, rise, -rl];
    const v = [];
    const push = (...ps) => {
      for (const p of ps) v.push(p[0], p[1], p[2]);
    };
    push(b[0], b[1], r0);
    push(b[1], b[2], r1, b[1], r1, r0);
    push(b[2], b[3], r1);
    push(b[3], b[0], r0, b[3], r0, r1);
    push(b[0], b[2], b[1], b[0], b[3], b[2]);
    const parts = [rawGeo(v)];
    if (rl > 0.2)
      parts.push(
        xf(new THREE.BoxGeometry(0.34, 0.26, rl * 2), 0, rise - 0.04, 0)
      );
    const geo = mergeGeos(parts);
    if (swap) xf(geo, 0, 0, 0, 0, Math.PI / 2, 0);
    return mesh(geo, m || mat.slate, opts);
  }

  // roofSawtooth — north-light studio roof. Sloped opaque sheets + vertical glazed faces.
  // Bays run along X; the glazed faces look toward -X ("north"). Base at y.
  function roofSawtooth(w, d, rise, bays, m, opts: KitOptions = {}) {
    const g = group(opts);
    const n = Math.max(1, Math.min(bays || 4, 10));
    const bw = w / n;
    const t = opts.thick == null ? 0.34 : opts.thick;
    // zig-zag ribbon profile in XY, extruded across the depth
    const s = new THREE.Shape();
    s.moveTo(-w / 2, 0);
    for (let i = 0; i < n; i++) {
      const x0 = -w / 2 + i * bw;
      s.lineTo(x0 + bw, rise);
      s.lineTo(x0 + bw, 0.0001);
    }
    for (let i = n - 1; i >= 0; i--) {
      const x0 = -w / 2 + i * bw;
      s.lineTo(x0 + bw, -t);
      s.lineTo(x0, rise - t);
    }
    s.lineTo(-w / 2, 0);
    const sheet = new THREE.ExtrudeGeometry(s, {
      depth: d,
      bevelEnabled: false,
    });
    xf(sheet, 0, 0, -d / 2);
    g.add(mesh(sheet, m || mat.slate));
    // glazed vertical faces + their mullions
    const glassParts = [];
    const barParts = [];
    for (let i = 0; i < n; i++) {
      const x = -w / 2 + (i + 1) * bw;
      glassParts.push(
        xf(
          new THREE.BoxGeometry(0.14, rise * 0.94, d * 0.96),
          x - 0.09,
          rise * 0.5,
          0
        )
      );
      const mull = Math.max(2, Math.round(d / 3));
      for (let k = 0; k <= mull; k++) {
        barParts.push(
          xf(
            new THREE.BoxGeometry(0.2, rise, 0.16),
            x - 0.06,
            rise * 0.5,
            -d / 2 + (d * k) / mull
          )
        );
      }
      barParts.push(
        xf(new THREE.BoxGeometry(0.24, 0.18, d), x - 0.06, rise * 0.52, 0)
      );
    }
    g.add(mesh(mergeGeos(glassParts), opts.glassMat || mat.glass));
    g.add(mesh(mergeGeos(barParts), mat.steel));
    return g;
  }

  // roofBarrel — half-cylinder along Z, optional clerestory drum band beneath.
  function roofBarrel(w, d, rise, m, opts: KitOptions = {}) {
    const g = group(opts);
    const cler = opts.clerestory ? Math.min(rise * 0.5, 1.6) : 0;
    if (cler) {
      const bars = [];
      const cols = Math.max(4, Math.round(d / 2.6));
      for (let i = 0; i <= cols; i++) {
        const z = -d / 2 + (d * i) / cols;
        bars.push(
          xf(new THREE.BoxGeometry(w + 0.2, cler, 0.22), 0, cler / 2, z)
        );
      }
      g.add(
        mesh(
          xf(
            new THREE.BoxGeometry(w - 0.5, cler * 0.92, d - 0.3),
            0,
            cler / 2,
            0
          ),
          mat.glass
        )
      );
      g.add(mesh(mergeGeos(bars), mat.steel));
    }
    const shell = barrelGeo(w, rise, d, Math.min(0.45, rise * 0.3));
    xf(shell, 0, cler, 0);
    const parts = [shell];
    // ribs across the vault
    const ribs = Math.max(3, Math.round(d / 3.2));
    for (let i = 0; i <= ribs; i++) {
      const z = -d / 2 + (d * i) / ribs;
      const rg = barrelGeo(w + 0.28, rise + 0.14, 0.26, 0.26);
      parts.push(xf(rg, 0, cler, z));
    }
    g.add(mesh(mergeGeos(parts), m || mat.copper));
    return g;
  }

  // roofPyramid — campanile / tower cap. Base at y.
  function roofPyramid(w, d, rise, m, opts: KitOptions = {}) {
    const hw = w / 2;
    const hd = d / 2;
    const b = [
      [-hw, 0, hd],
      [hw, 0, hd],
      [hw, 0, -hd],
      [-hw, 0, -hd],
    ];
    const apex = [0, rise, 0];
    const v = [];
    const push = (...ps) => {
      for (const p of ps) v.push(p[0], p[1], p[2]);
    };
    for (let i = 0; i < 4; i++) push(b[i], b[(i + 1) % 4], apex);
    push(b[0], b[2], b[1], b[0], b[3], b[2]);
    const parts = [
      rawGeo(v),
      xf(new THREE.BoxGeometry(w + 0.3, 0.3, d + 0.3), 0, 0.06, 0),
    ];
    // hip arrises in a contrasting metal read as seams; keep them in the same merge
    return mesh(mergeGeos(parts), m || mat.copper, opts);
  }

  // roofStepped — ziggurat. Base at y.
  function roofStepped(w, d, h, stepCount, m, opts: KitOptions = {}) {
    const n = Math.max(1, Math.min(stepCount || 3, 8));
    const sh = h / n;
    const parts = [];
    for (let i = 0; i < n; i++) {
      const k = 1 - (i * 0.62) / n;
      parts.push(
        xf(new THREE.BoxGeometry(w * k, sh, d * k), 0, sh * (i + 0.5), 0),
        xf(
          new THREE.BoxGeometry(w * k + 0.24, 0.16, d * k + 0.24),
          0,
          sh * (i + 1) - 0.08,
          0
        )
      );
    }
    return mesh(mergeGeos(parts), m || mat.concrete, opts);
  }

  // roofMansard — steep lower slope, shallow deck above, dormers on +Z. Base at y.
  function roofMansard(w, d, h, m, opts: KitOptions = {}) {
    const g = group(opts);
    const lower = h * 0.64;
    const parts = [
      frustumGeo(w, d, w * 0.74, d * 0.74, lower),
      xf(
        frustumGeo(w * 0.74, d * 0.74, w * 0.3, d * 0.3, h - lower),
        0,
        lower,
        0
      ),
      xf(new THREE.BoxGeometry(w + 0.34, 0.34, d + 0.34), 0, 0.1, 0),
      xf(new THREE.BoxGeometry(w * 0.78, 0.2, d * 0.78), 0, lower, 0),
    ];
    g.add(mesh(mergeGeos(parts), m || mat.slate));
    const dorm = [];
    const glass = [];
    const dn = Math.max(1, Math.min(3, Math.round(w / 5)));
    for (let i = 0; i < dn; i++) {
      const x = (i - (dn - 1) / 2) * (w / (dn + 0.4));
      dorm.push(
        xf(
          new THREE.BoxGeometry(1.5, lower * 0.5, 1.2),
          x,
          lower * 0.36,
          d * 0.44
        ),
        xf(frustumGeo(1.7, 1.4, 0.2, 1.4, 0.55), x, lower * 0.61, d * 0.44)
      );
      glass.push(
        xf(
          new THREE.BoxGeometry(1, lower * 0.32, 0.14),
          x,
          lower * 0.36,
          d * 0.44 + 0.62
        )
      );
    }
    g.add(mesh(mergeGeos(dorm), mat.slate));
    g.add(mesh(mergeGeos(glass), mat.glass));
    return g;
  }

  // roofParapet — flat roof with a raised rim and a coping band. Base at y.
  function roofParapet(w, d, m, opts: KitOptions = {}) {
    const g = group(opts);
    const h = opts.h == null ? 0.95 : opts.h;
    const t = opts.thick == null ? 0.38 : opts.thick;
    const parts = [
      xf(new THREE.BoxGeometry(w, 0.2, d), 0, 0.1, 0),
      xf(new THREE.BoxGeometry(w, h, t), 0, h / 2, d / 2 - t / 2),
      xf(new THREE.BoxGeometry(w, h, t), 0, h / 2, -d / 2 + t / 2),
      xf(new THREE.BoxGeometry(t, h, d - t * 2), -w / 2 + t / 2, h / 2, 0),
      xf(new THREE.BoxGeometry(t, h, d - t * 2), w / 2 - t / 2, h / 2, 0),
    ];
    g.add(mesh(mergeGeos(parts), m || mat.concrete));
    const cop = [
      xf(
        new THREE.BoxGeometry(w + 0.3, 0.16, t + 0.24),
        0,
        h + 0.06,
        d / 2 - t / 2
      ),
      xf(
        new THREE.BoxGeometry(w + 0.3, 0.16, t + 0.24),
        0,
        h + 0.06,
        -d / 2 + t / 2
      ),
      xf(
        new THREE.BoxGeometry(t + 0.24, 0.16, d + 0.3),
        -w / 2 + t / 2,
        h + 0.06,
        0
      ),
      xf(
        new THREE.BoxGeometry(t + 0.24, 0.16, d + 0.3),
        w / 2 - t / 2,
        h + 0.06,
        0
      ),
    ];
    g.add(mesh(mergeGeos(cop), opts.copingMat || mat.slate));
    return g;
  }

  // roofCone — silo cap. Base at y.
  function roofCone(r, h, m, opts: KitOptions = {}) {
    const geo = xf(new THREE.ConeGeometry(r, h, 14), 0, h / 2, 0);
    return mesh(geo, m || mat.copper, opts);
  }

  // roofDomeRibbed — ribbed copper dome with a base ring. Base at y.
  function roofDomeRibbed(r, m, opts: KitOptions = {}) {
    const g = group(opts);
    const ratio = opts.ratio == null ? 0.62 : opts.ratio;
    const seg = Math.min(opts.seg || 18, 18);
    const shell = new THREE.SphereGeometry(r, seg, 8, 0, TAU, 0, Math.PI / 2);
    xf(shell, 0, 0, 0, 0, 0, 0, 1, ratio, 1);
    g.add(mesh(shell, m || mat.copper));
    const nribs = Math.max(6, Math.min(opts.ribs || 12, 16));
    const ribs = [];
    for (let i = 0; i < nribs; i++) {
      const rg = new THREE.TorusGeometry(
        r,
        r * 0.028 + 0.04,
        4,
        8,
        Math.PI / 2
      );
      // torus arc lies in XY from (r,0) to (0,r) — a meridian; rotate into place
      xf(rg, 0, 0, 0, 0, (i / nribs) * TAU, 0, 1, ratio, 1);
      ribs.push(rg);
    }
    ribs.push(
      xf(
        new THREE.TorusGeometry(r * 1.005, 0.09, 4, 20),
        0,
        0.06,
        0,
        Math.PI / 2,
        0,
        0
      ),
      xf(
        new THREE.TorusGeometry(r * 0.2, 0.08, 4, 12),
        0,
        r * ratio * 0.985,
        0,
        Math.PI / 2,
        0,
        0
      )
    );
    g.add(mesh(mergeGeos(ribs), opts.ribMat || mat.brass));
    if (opts.lantern) {
      g.add(
        mesh(
          new THREE.CylinderGeometry(r * 0.17, r * 0.19, r * 0.3, 10),
          mat.bone,
          { y: r * ratio + r * 0.15 }
        )
      );
      g.add(
        mesh(
          new THREE.ConeGeometry(r * 0.22, r * 0.22, 10),
          opts.ribMat || mat.brass,
          { y: r * ratio + r * 0.4 }
        )
      );
    }
    return g;
  }

  /* ------------------------------------------------------------ facades & structure */

  // curtainWall — glazed skin with a real mullion grid. CENTRED on y.
  // opts { faces: 'front' | 'all', cols, rows, y, x, z, rotY }
  function curtainWall(w, h, d, m, opts: KitOptions = {}) {
    const g = group(opts);
    const all = opts.faces === "all";
    const cols = Math.max(2, opts.cols || Math.round(w / 2.2));
    const rows = Math.max(2, opts.rows || Math.round(h / 2.6));
    const glassMat = m || mat.glass;
    const bars = [];
    const panes = [];
    const t = 0.16;
    const faceList = all
      ? [
          { n: [0, 0, 1], span: w, off: d / 2 },
          { n: [0, 0, -1], span: w, off: d / 2 },
          { n: [1, 0, 0], span: d, off: w / 2 },
          { n: [-1, 0, 0], span: d, off: w / 2 },
        ]
      : [{ n: [0, 0, 1], span: w, off: d / 2 }];
    for (const f of faceList) {
      const along = f.n[2] === 0 ? "z" : "x";
      const sgn = f.n[0] + f.n[2];
      const span = f.span;
      const put = (bw, bh, bd, a, y) => {
        const gg = new THREE.BoxGeometry(bw, bh, bd);
        if (along === "x") xf(gg, a, y, sgn * f.off);
        else xf(gg, sgn * f.off, y, a);
        return gg;
      };
      const cw = along === "x" ? 1 : 0;
      for (let i = 0; i <= cols; i++) {
        const a = -span / 2 + (span * i) / cols;
        bars.push(cw ? put(t, h, t * 2.2, a, 0) : put(t * 2.2, h, t, a, 0));
      }
      for (let j = 0; j <= rows; j++) {
        const y = -h / 2 + (h * j) / rows;
        bars.push(
          cw
            ? put(span, t * 1.2, t * 1.6, 0, y)
            : put(t * 1.6, t * 1.2, span, 0, y)
        );
      }
      panes.push(
        cw
          ? put(span - 0.1, h - 0.1, 0.12, 0, 0)
          : put(0.12, h - 0.1, span - 0.1, 0, 0)
      );
    }
    // recessed core so the glazing reads as a skin, not a solid
    g.add(
      mesh(
        new THREE.BoxGeometry(w - 0.5, h - 0.3, d - 0.5),
        opts.coreMat || mat.darkSlate
      )
    );
    g.add(mesh(mergeGeos(panes), glassMat));
    g.add(mesh(mergeGeos(bars), opts.barMat || mat.steel));
    return g;
  }

  // punchedWindows — solid mass with recessed openings. CENTRED on y.
  function punchedWindows(w, h, d, cols, rows, m, opts: KitOptions = {}) {
    const g = group(opts);
    g.add(mesh(new THREE.BoxGeometry(w, h, d), m || mat.bone));
    const c = Math.max(1, Math.min(cols || 4, 14));
    const r = Math.max(1, Math.min(rows || 4, 16));
    const ww = (w / c) * 0.46;
    const wh = (h / r) * 0.5;
    const panes = [];
    const reveals = [];
    const faces = opts.faces === "all" ? ["z", "-z", "x", "-x"] : ["z", "-z"];
    for (const f of faces) {
      const axis = f.includes("x") ? "x" : "z";
      const sgn = f[0] === "-" ? -1 : 1;
      const span = axis === "x" ? d : w;
      const off = axis === "x" ? w / 2 : d / 2;
      const n =
        axis === "x"
          ? Math.max(1, Math.round(c * (d / Math.max(0.001, w))))
          : c;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < r; j++) {
          const a = -span / 2 + (span * (i + 0.5)) / n;
          const y = -h / 2 + (h * (j + 0.5)) / r;
          const pw = axis === "x" ? 0.2 : ww;
          const pd = axis === "x" ? ww : 0.2;
          const px = axis === "x" ? sgn * (off - 0.16) : a;
          const pz = axis === "x" ? a : sgn * (off - 0.16);
          panes.push(xf(new THREE.BoxGeometry(pw, wh, pd), px, y, pz));
          const fw = axis === "x" ? 0.26 : ww + 0.34;
          const fd = axis === "x" ? ww + 0.34 : 0.26;
          reveals.push(
            xf(
              new THREE.BoxGeometry(fw, wh + 0.34, fd),
              axis === "x" ? sgn * (off + 0.02) : px,
              y,
              axis === "x" ? pz : sgn * (off + 0.02)
            )
          );
        }
      }
    }
    g.add(mesh(mergeGeos(reveals), opts.frameMat || mat.concrete));
    g.add(mesh(mergeGeos(panes), opts.glassMat || mat.glass));
    return g;
  }

  // ribbedFacade — vertical fin / pilaster rhythm over a solid body. CENTRED on y.
  function ribbedFacade(w, h, d, fins, m, opts: KitOptions = {}) {
    const g = group(opts);
    const body = m || mat.bone;
    g.add(mesh(new THREE.BoxGeometry(w, h, d), body));
    const n = Math.max(2, Math.min(fins || 8, 28));
    const depth = opts.depth == null ? 0.3 : opts.depth;
    const parts = [];
    const fh = opts.finH == null ? h : opts.finH;
    const fy = opts.finY == null ? 0 : opts.finY;
    for (let i = 0; i < n; i++) {
      const x = -w / 2 + (w * (i + 0.5)) / n;
      parts.push(
        xf(new THREE.BoxGeometry(w / n / 3.2, fh, depth * 2), x, fy, d / 2),
        xf(new THREE.BoxGeometry(w / n / 3.2, fh, depth * 2), x, fy, -d / 2)
      );
    }
    if (opts.wrap) {
      const nz = Math.max(2, Math.round((n * d) / Math.max(0.001, w)));
      for (let i = 0; i < nz; i++) {
        const z = -d / 2 + (d * (i + 0.5)) / nz;
        parts.push(
          xf(new THREE.BoxGeometry(depth * 2, fh, d / nz / 3.2), w / 2, fy, z),
          xf(new THREE.BoxGeometry(depth * 2, fh, d / nz / 3.2), -w / 2, fy, z)
        );
      }
    }
    g.add(mesh(mergeGeos(parts), opts.finMat || body));
    return g;
  }

  // louvers — angled slats in a frame. CENTRED on y.
  function louvers(w, h, d, count, m, opts: KitOptions = {}) {
    const g = group(opts);
    const n = Math.max(2, Math.min(count || 8, 22));
    const body = m || mat.steel;
    if (opts.solid !== false)
      g.add(
        mesh(
          new THREE.BoxGeometry(w - 0.6, h - 0.4, d - 0.6),
          opts.coreMat || mat.darkSlate
        )
      );
    const ang = opts.angle == null ? 0.62 : opts.angle;
    const parts = [];
    const sh = h / n;
    const faces = opts.faces === "all" ? ["z", "-z", "x", "-x"] : ["z", "-z"];
    for (const f of faces) {
      const axis = f.includes("x") ? "x" : "z";
      const sgn = f[0] === "-" ? -1 : 1;
      for (let i = 0; i < n; i++) {
        const y = -h / 2 + sh * (i + 0.5);
        if (axis === "z") {
          parts.push(
            xf(
              new THREE.BoxGeometry(w, sh * 0.82, 0.16),
              0,
              y,
              sgn * (d / 2 - 0.1),
              ang * sgn,
              0,
              0
            )
          );
        } else {
          parts.push(
            xf(
              new THREE.BoxGeometry(0.16, sh * 0.82, d),
              sgn * (w / 2 - 0.1),
              y,
              0,
              0,
              0,
              -ang * sgn
            )
          );
        }
      }
    }
    // frame posts
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        parts.push(
          xf(new THREE.BoxGeometry(0.3, h, 0.3), (sx * w) / 2, 0, (sz * d) / 2)
        );
      }
    }
    parts.push(
      xf(new THREE.BoxGeometry(w + 0.2, 0.3, d + 0.2), 0, h / 2, 0),
      xf(new THREE.BoxGeometry(w + 0.2, 0.3, d + 0.2), 0, -h / 2, 0)
    );
    g.add(mesh(mergeGeos(parts), body));
    return g;
  }

  // masonryBands — horizontal course lines over a solid body. CENTRED on y.
  function masonryBands(w, h, d, m, opts: KitOptions = {}) {
    const g = group(opts);
    const body = m || mat.terracotta;
    g.add(mesh(new THREE.BoxGeometry(w, h, d), body));
    const n = Math.max(2, Math.min(opts.bands || Math.round(h / 1.4), 22));
    const parts = [];
    for (let i = 1; i < n; i++) {
      const y = -h / 2 + (h * i) / n;
      parts.push(xf(new THREE.BoxGeometry(w + 0.14, 0.13, d + 0.14), 0, y, 0));
    }
    parts.push(
      xf(new THREE.BoxGeometry(w + 0.4, 0.42, d + 0.4), 0, h / 2 - 0.21, 0),
      xf(new THREE.BoxGeometry(w + 0.4, 0.5, d + 0.4), 0, -h / 2 + 0.25, 0)
    );
    g.add(mesh(mergeGeos(parts), opts.bandMat || mat.concrete));
    return g;
  }

  // Fluted shaft with entasis — a real scalloped surface, not decal ridges.
  function shaftGeo(R, h, flutes) {
    const ringCount = 5;
    const segCount = flutes > 0 ? flutes * 4 : 12;
    const ring = (t) => {
      const base = R * (1 - 0.16 * t + 0.05 * Math.sin(Math.PI * t));
      const pts = [];
      for (let j = 0; j < segCount; j++) {
        const th = (j / segCount) * TAU;
        const scallop =
          flutes > 0 ? 1 - 0.085 * (0.5 - 0.5 * Math.cos(flutes * th)) : 1;
        pts.push([
          Math.cos(th) * base * scallop,
          t * h,
          Math.sin(th) * base * scallop,
        ]);
      }
      return pts;
    };
    const rings = [];
    for (let i = 0; i < ringCount; i++) rings.push(ring(i / (ringCount - 1)));
    const v = [];
    const push = (...ps) => {
      for (const p of ps) v.push(p[0], p[1], p[2]);
    };
    for (let i = 0; i < ringCount - 1; i++) {
      for (let j = 0; j < segCount; j++) {
        const k = (j + 1) % segCount;
        push(rings[i][j], rings[i][k], rings[i + 1][k]);
        push(rings[i][j], rings[i + 1][k], rings[i + 1][j]);
      }
    }
    return rawGeo(v);
  }

  // colonnade — a row of columns spread along X over `span`, base at y.
  // opts { fluted, entablature, x, y, z, rotY, flutes }
  function colonnade(count, r, h, span, m, opts: KitOptions = {}) {
    const g = group(opts);
    const n = Math.max(2, Math.min(count || 6, 16));
    const flutes = opts.fluted ? Math.min(opts.flutes || 8, 12) : 0;
    const shaftH = h * 0.84;
    const parts = [];
    for (let i = 0; i < n; i++) {
      const x = n === 1 ? 0 : -span / 2 + (span * i) / (n - 1);
      // plinth + torus base, shaft with entasis, capital: echinus + abacus
      parts.push(
        xf(
          new THREE.BoxGeometry(r * 2.7, h * 0.045, r * 2.7),
          x,
          h * 0.0225,
          0
        ),
        xf(
          new THREE.CylinderGeometry(r * 1.06, r * 1.22, h * 0.04, 12),
          x,
          h * 0.065,
          0
        ),
        xf(shaftGeo(r, shaftH, flutes), x, h * 0.085, 0),
        xf(
          new THREE.CylinderGeometry(r * 1.24, r * 0.84, h * 0.05, 12),
          x,
          h * 0.085 + shaftH + h * 0.025,
          0
        ),
        xf(
          new THREE.BoxGeometry(r * 2.8, h * 0.035, r * 2.8),
          x,
          h * 0.085 + shaftH + h * 0.067,
          0
        )
      );
    }
    g.add(mesh(mergeGeos(parts), m || mat.bone));
    if (opts.entablature !== false) {
      const ent = [];
      const ey = h * 0.085 + shaftH + h * 0.085;
      const ew = span + r * 3.4;
      ent.push(
        // architrave
        xf(new THREE.BoxGeometry(ew, h * 0.055, r * 2.9), 0, ey + h * 0.028, 0),
        // frieze
        xf(new THREE.BoxGeometry(ew, h * 0.06, r * 2.7), 0, ey + h * 0.086, 0)
      );
      g.add(mesh(mergeGeos(ent), m || mat.bone));
      const cor = xf(
        new THREE.BoxGeometry(ew + r * 0.9, h * 0.03, r * 3.5),
        0,
        ey + h * 0.131,
        0
      );
      g.add(mesh(cor, opts.cornMat || mat.brass));
      // triglyph rhythm on the frieze
      const tg = [];
      for (let i = 0; i < n * 2 - 1; i++) {
        const x = -span / 2 + (span * i) / (n * 2 - 2);
        tg.push(
          xf(
            new THREE.BoxGeometry(r * 0.5, h * 0.05, 0.12),
            x,
            ey + h * 0.086,
            r * 1.4
          )
        );
      }
      g.add(mesh(mergeGeos(tg), opts.cornMat || mat.brass));
    }
    return g;
  }

  // arcade — a wall of repeated arched openings. Base at y, wall spans w along X, d thick.
  function arcade(count, w, h, d, m, opts: KitOptions = {}) {
    const n = Math.max(1, Math.min(count || 4, 12));
    const s = new THREE.Shape();
    s.moveTo(-w / 2, 0);
    s.lineTo(w / 2, 0);
    s.lineTo(w / 2, h);
    s.lineTo(-w / 2, h);
    s.lineTo(-w / 2, 0);
    const bay = w / n;
    const ow = bay * 0.6;
    const sp = Math.min(h * 0.5, h - ow / 2 - 0.6);
    for (let i = 0; i < n; i++) {
      const cx = -w / 2 + bay * (i + 0.5);
      const p = new THREE.Path();
      p.moveTo(cx - ow / 2, 0.001);
      p.lineTo(cx - ow / 2, sp);
      p.absarc(cx, sp, ow / 2, Math.PI, 0, true);
      p.lineTo(cx + ow / 2, 0.001);
      p.lineTo(cx - ow / 2, 0.001);
      s.holes.push(p);
    }
    const wall = new THREE.ExtrudeGeometry(s, {
      depth: d,
      bevelEnabled: false,
      curveSegments: 8,
    });
    xf(wall, 0, 0, -d / 2);
    // impost band + cornice
    const parts = [
      wall,
      xf(new THREE.BoxGeometry(w, 0.2, d + 0.22), 0, sp, 0),
      xf(new THREE.BoxGeometry(w + 0.3, 0.34, d + 0.34), 0, h - 0.17, 0),
    ];
    const key = [];
    for (let i = 0; i < n; i++) {
      const cx = -w / 2 + bay * (i + 0.5);
      key.push(
        xf(new THREE.BoxGeometry(0.4, 0.62, d + 0.3), cx, sp + ow / 2 - 0.1, 0)
      );
    }
    const g = group(opts);
    g.add(mesh(mergeGeos(parts), m || mat.bone));
    g.add(mesh(mergeGeos(key), opts.keyMat || mat.concrete));
    return g;
  }

  // pilotis — a building raised on legs. Base at y; legs of height h under a w×d plate.
  function pilotis(w, d, h, m, opts: KitOptions = {}) {
    const g = group(opts);
    const cols = Math.max(2, opts.cols || Math.round(w / 4.5));
    const rows = Math.max(2, opts.rows || Math.round(d / 4.5));
    const r = opts.r == null ? 0.42 : opts.r;
    const parts = [];
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const x = -w / 2 + (w * (i + 0.5)) / cols;
        const z = -d / 2 + (d * (j + 0.5)) / rows;
        parts.push(
          xf(new THREE.CylinderGeometry(r, r * 1.14, h, 10), x, h / 2, z)
        );
      }
    }
    parts.push(xf(new THREE.BoxGeometry(w + 0.4, 0.4, d + 0.4), 0, h + 0.2, 0));
    g.add(mesh(mergeGeos(parts), m || mat.concrete));
    return g;
  }

  // truss — lattice beam along X, base at y, spanning [-len/2, len/2].
  function truss(len, h, m, opts: KitOptions = {}) {
    const segs = Math.max(
      2,
      Math.min(opts.segments || Math.round(len / 2.6), 20)
    );
    const t = opts.thick == null ? 0.18 : opts.thick;
    const dep = opts.depth == null ? Math.min(h, 0.8) : opts.depth;
    const parts = [];
    const zz = [dep / 2, -dep / 2];
    for (const z of zz) {
      parts.push(
        xf(new THREE.BoxGeometry(len, t, t), 0, h - t / 2, z),
        xf(new THREE.BoxGeometry(len, t, t), 0, t / 2, z)
      );
      for (let i = 0; i <= segs; i++) {
        const x = -len / 2 + (len * i) / segs;
        parts.push(xf(new THREE.BoxGeometry(t * 0.8, h, t * 0.8), x, h / 2, z));
        if (i < segs) {
          const x2 = -len / 2 + (len * (i + 1)) / segs;
          parts.push(
            strutGeo(
              [i % 2 ? x : x2, t, z],
              [i % 2 ? x2 : x, h - t, z],
              t * 0.72
            )
          );
        }
      }
    }
    for (let i = 0; i <= segs; i++) {
      const x = -len / 2 + (len * i) / segs;
      parts.push(
        xf(new THREE.BoxGeometry(t * 0.8, t * 0.8, dep), x, h - t / 2, 0),
        xf(new THREE.BoxGeometry(t * 0.8, t * 0.8, dep), x, t / 2, 0)
      );
    }
    return mesh(mergeGeos(parts), m || mat.steel, opts);
  }

  // latticeMast — openwork tower with legs, ring braces and X cross-bracing. Base at y.
  function latticeMast(h, w, m, opts: KitOptions = {}) {
    const segs = Math.max(
      3,
      Math.min(opts.segments || Math.round(h / 3.2), 14)
    );
    const taper = opts.taper == null ? 0.55 : opts.taper;
    const t = opts.thick == null ? 0.2 : opts.thick;
    const half = (i) => (w / 2) * (1 - (1 - taper) * (i / segs));
    const corner = (i, c) => {
      const s = half(i);
      const y = (h * i) / segs;
      return [c & 1 ? s : -s, y, c & 2 ? s : -s];
    };
    const parts = [];
    for (let i = 0; i < segs; i++) {
      for (let c = 0; c < 4; c++) {
        const a = corner(i, c);
        const b = corner(i + 1, c);
        parts.push(strutGeo(a, b, t));
      }
      // 4 side faces get an X brace each
      const order = [0, 1, 3, 2];
      for (let f = 0; f < 4; f++) {
        const c1 = order[f];
        const c2 = order[(f + 1) % 4];
        parts.push(
          strutGeo(corner(i, c1), corner(i + 1, c2), t * 0.6),
          strutGeo(corner(i, c2), corner(i + 1, c1), t * 0.6)
        );
      }
    }
    for (let i = 0; i <= segs; i++) {
      const order = [0, 1, 3, 2];
      for (let f = 0; f < 4; f++) {
        parts.push(
          strutGeo(corner(i, order[f]), corner(i, order[(f + 1) % 4]), t * 0.7)
        );
      }
    }
    return mesh(mergeGeos(parts), m || mat.steel, opts);
  }

  // gantry — portal frame straddling a track along X. Base at y.
  function gantry(span, h, m, opts: KitOptions = {}) {
    const g = group(opts);
    const legW = opts.legW == null ? Math.max(0.5, span * 0.05) : opts.legW;
    const parts = [];
    for (const sx of [-1, 1]) {
      const x = (sx * span) / 2;
      parts.push(
        xf(new THREE.BoxGeometry(legW, h, legW), x, h / 2, 0),
        xf(new THREE.BoxGeometry(legW * 2.4, 0.4, legW * 3), x, 0.2, 0),
        strutGeo([x, h * 0.68, 0], [x - sx * h * 0.22, h, 0], legW * 0.6)
      );
    }
    g.add(mesh(mergeGeos(parts), m || mat.steel));
    const beam = truss(
      span + legW * 2,
      Math.max(0.9, h * 0.14),
      m || mat.steel,
      {
        y: h,
        segments: Math.max(3, Math.round(span / 3)),
        depth: legW * 2.6,
      }
    );
    g.add(beam);
    if (opts.trolley !== false) {
      const tr = group({ y: h - 0.2, x: span * 0.12 });
      tr.add(
        mesh(new THREE.BoxGeometry(legW * 2.4, 0.6, legW * 3), m || mat.steel)
      );
      tr.add(
        mesh(new THREE.BoxGeometry(0.12, h * 0.32, 0.12), mat.darkSlate, {
          y: -h * 0.18,
        })
      );
      tr.add(
        mesh(new THREE.BoxGeometry(legW * 1.3, 0.5, legW * 1.3), mat.brass, {
          y: -h * 0.35,
        })
      );
      g.add(tr);
      bob(tr, h * 0.06, 0.7);
    }
    return g;
  }

  // catwalk — a ring deck with railing at radius r, base at y.
  function catwalk(r, y, m, opts: KitOptions = {}) {
    const g = group({ ...opts, y: y || 0 });
    const seg = 20;
    const deck = new THREE.RingGeometry(r, r + (opts.width || 0.9), seg, 1);
    xf(deck, 0, 0, 0, -Math.PI / 2, 0, 0);
    const parts = [deck];
    const rr = r + (opts.width || 0.9);
    parts.push(
      xf(
        new THREE.TorusGeometry(rr, 0.07, 4, seg),
        0,
        0.95,
        0,
        Math.PI / 2,
        0,
        0
      ),
      xf(
        new THREE.TorusGeometry(rr, 0.05, 4, seg),
        0,
        0.52,
        0,
        Math.PI / 2,
        0,
        0
      )
    );
    const posts = Math.min(seg, 16);
    for (let i = 0; i < posts; i++) {
      const th = (i / posts) * TAU;
      parts.push(
        xf(
          new THREE.BoxGeometry(0.1, 0.98, 0.1),
          Math.cos(th) * rr,
          0.49,
          Math.sin(th) * rr
        )
      );
    }
    g.add(mesh(mergeGeos(parts), m || mat.steel));
    return g;
  }

  // railing — posts + two rails along [[x,z] | [x,y,z] | Vector3, …], base-anchored at y.
  function railing(points, y, m, rawOpts) {
    const opts = O(rawOpts);
    const pts = toVec3List(points);
    if (!pts.length) return group({ ...opts, y: N(y, 0) });
    const parts = [];
    const H = Math.abs(D(opts.h, 1));
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      parts.push(
        xf(new THREE.BoxGeometry(0.09, H, 0.09), p.x, p.y + H / 2, p.z)
      );
      if (i < pts.length - 1) {
        const q = pts[i + 1];
        parts.push(
          strutGeo([p.x, p.y + H, p.z], [q.x, q.y + H, q.z], 0.09),
          strutGeo([p.x, p.y + H * 0.52, p.z], [q.x, q.y + H * 0.52, q.z], 0.07)
        );
      }
    }
    if (opts.closed && pts.length > 2) {
      const a = pts[pts.length - 1];
      const b = pts[0];
      parts.push(
        strutGeo([a.x, a.y + H, a.z], [b.x, b.y + H, b.z], 0.09),
        strutGeo([a.x, a.y + H * 0.52, a.z], [b.x, b.y + H * 0.52, b.z], 0.07)
      );
    }
    return mesh(mergeGeos(parts), M(m, mat.steel), {
      ...opts,
      y: N(y, opts.y || 0),
    });
  }

  // stairFlight — an open flight of width w climbing `rise` over `run` toward +Z. Base at y.
  function stairFlight(w, rise, run, m, opts: KitOptions = {}) {
    const n = Math.max(2, Math.min(Math.round(rise / 0.3), 26));
    const parts = [];
    for (let i = 0; i < n; i++) {
      const y = (rise * (i + 1)) / n;
      const z = (run * (i + 0.5)) / n;
      parts.push(
        xf(new THREE.BoxGeometry(w, 0.11, run / n + 0.05), 0, y, z),
        xf(
          new THREE.BoxGeometry(w, rise / n, 0.09),
          0,
          y - rise / n / 2,
          z + run / n / 2
        )
      );
    }
    for (const sx of [-1, 1]) {
      parts.push(
        strutGeo([(sx * w) / 2, 0, 0], [(sx * w) / 2, rise, run], 0.16, 0.5),
        strutGeo([(sx * w) / 2, 1, 0], [(sx * w) / 2, rise + 1, run], 0.09)
      );
    }
    return mesh(mergeGeos(parts), m || mat.steel, opts);
  }

  // spiralStair — treads winding around a central pole. Base at y.
  function spiralStair(r, h, m, opts: KitOptions = {}) {
    const n = Math.max(6, Math.min(Math.round(h / 0.34), 40));
    const turns = opts.turns == null ? 1.25 : opts.turns;
    const parts = [
      xf(new THREE.CylinderGeometry(0.16, 0.16, h, 8), 0, h / 2, 0),
    ];
    for (let i = 0; i < n; i++) {
      const th = (i / n) * TAU * turns;
      const y = (h * (i + 1)) / n;
      const tread = new THREE.BoxGeometry(r, 0.1, r * 0.44);
      xf(tread, 0, 0, 0, 0, 0, 0);
      xf(tread, r / 2, 0, 0);
      xf(tread, 0, y, 0, 0, th, 0);
      parts.push(
        tread,
        xf(
          new THREE.BoxGeometry(0.07, 0.95, 0.07),
          Math.cos(th) * r * 0.92,
          y + 0.47,
          -Math.sin(th) * r * 0.92
        )
      );
    }
    return mesh(mergeGeos(parts), m || mat.steel, opts);
  }

  // steps — entry stairs: top tread against the building (z=0), descending toward +z.
  function steps(w, d, count, m, opts: KitOptions = {}) {
    const n = Math.max(1, Math.min(count || 4, 14));
    const rise = opts.rise == null ? 0.3 : opts.rise;
    const tread = d / n;
    const parts = [];
    for (let i = 0; i < n; i++) {
      const y = rise * (n - i);
      parts.push(
        xf(
          new THREE.BoxGeometry(w, rise, d - tread * i),
          0,
          y - rise / 2,
          (tread * i) / 2
        )
      );
    }
    // cheek walls
    for (const sx of [-1, 1]) {
      parts.push(
        xf(
          new THREE.BoxGeometry(0.42, rise * n, d),
          (sx * (w + 0.42)) / 2,
          (rise * n) / 2,
          0
        )
      );
    }
    return mesh(mergeGeos(parts), m || mat.bone, opts);
  }

  // buttress — a battered pier projecting +X from a wall. Base at y.
  function buttress(h, d, m, opts: KitOptions = {}) {
    const w = opts.w == null ? 0.8 : opts.w;
    const s = new THREE.Shape();
    s.moveTo(0, 0);
    s.lineTo(d, 0);
    s.lineTo(d * 0.42, h * 0.42);
    s.lineTo(0, h);
    s.lineTo(0, 0);
    const geo = new THREE.ExtrudeGeometry(s, { depth: w, bevelEnabled: false });
    xf(geo, 0, 0, -w / 2);
    const parts = [
      geo,
      xf(new THREE.BoxGeometry(d * 0.5, 0.28, w + 0.2), d * 0.25, h * 0.44, 0),
    ];
    return mesh(mergeGeos(parts), m || mat.bone, opts);
  }

  /* ------------------------------------------------------------------ props */

  // pipeRun — tubes + elbow spheres along [[x,y,z] | [x,z] | Vector3, …].
  function pipeRun(points, rr, m, rawOpts) {
    const opts = O(rawOpts);
    const pts = toVec3List(points, opts.y0 || 0);
    if (pts.length < 2) return group(opts);
    const r = Math.abs(D(rr, 0.24));
    const parts = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const t = tubeGeo(pts[i], pts[i + 1], r, 7);
      if (t) parts.push(t);
    }
    for (const p of pts)
      parts.push(xf(new THREE.SphereGeometry(r * 1.18, 7, 5), p.x, p.y, p.z));
    for (const i of [0, pts.length - 1]) {
      const p = pts[i];
      parts.push(
        xf(
          new THREE.CylinderGeometry(r * 1.7, r * 1.7, r * 0.5, 8),
          p.x,
          p.y,
          p.z
        )
      );
    }
    return mesh(mergeGeos(parts), M(m, mat.steel), opts);
  }

  // ductRun — rectangular duct along X with flange ribs. Base-centred on y.
  function ductRun(w, len, m, opts: KitOptions = {}) {
    const parts = [xf(new THREE.BoxGeometry(len, w, w), 0, 0, 0)];
    const n = Math.max(2, Math.min(Math.round(len / 2), 12));
    for (let i = 0; i <= n; i++) {
      const x = -len / 2 + (len * i) / n;
      parts.push(xf(new THREE.BoxGeometry(0.16, w + 0.24, w + 0.24), x, 0, 0));
    }
    return mesh(mergeGeos(parts), m || mat.steel, opts);
  }

  // dish — aimable parabolic dish. opts { az, el, aim: [x,y,z], y, x, z }
  function dish(r, m, opts: KitOptions = {}) {
    const yaw = group({ x: opts.x || 0, y: opts.y || 0, z: opts.z || 0 });
    let az = opts.az || 0;
    let el = opts.el == null ? 0.35 : opts.el;
    if (opts.aim) {
      const a = opts.aim;
      az = Math.atan2(a[0], a[2]);
      el = Math.atan2(a[1] || 0, Math.hypot(a[0], a[2]) || 1);
    }
    yaw.rotation.y = az;
    const tilt = group({});
    tilt.rotation.x = Math.PI / 2 - el;
    yaw.add(tilt);
    // parabolic shell via lathe: inner face then offset back
    const t = Math.max(0.06, r * 0.06);
    const pts = [];
    const segCount = 6;
    for (let i = 0; i <= segCount; i++) {
      const x = (i / segCount) * r;
      pts.push(new THREE.Vector2(x, (0.42 * x * x) / r));
    }
    for (let i = segCount; i >= 0; i--) {
      const x = (i / segCount) * r;
      pts.push(
        new THREE.Vector2(Math.max(0.001, x - t * 0.3), (0.42 * x * x) / r - t)
      );
    }
    const shell = new THREE.LatheGeometry(pts, 14);
    tilt.add(mesh(shell, M(m, mat.bone)));
    // feed mast + tripod legs share the steel material — one merged draw call
    const legs = [
      xf(
        new THREE.CylinderGeometry(r * 0.06, r * 0.06, r * 0.9, 6),
        0,
        r * 0.45,
        0
      ),
    ];
    for (let i = 0; i < 3; i++) {
      const th = (i / 3) * TAU;
      legs.push(
        strutGeo(
          [Math.cos(th) * r * 0.78, 0.28, Math.sin(th) * r * 0.78],
          [0, r * 0.82, 0],
          0.07
        )
      );
    }
    tilt.add(mesh(mergeGeos(legs), mat.steel));
    tilt.add(
      mesh(
        new THREE.CylinderGeometry(r * 0.13, r * 0.09, r * 0.24, 8),
        mat.darkSlate,
        { y: r * 0.92 }
      )
    );
    // yoke + pedestal live in the un-tilted frame
    yaw.add(
      mesh(
        new THREE.CylinderGeometry(r * 0.14, r * 0.2, r * 0.5, 8),
        mat.darkSlate,
        { y: -r * 0.25 }
      )
    );
    return yaw;
  }

  // mast — a tapered pole with collars. Base at y.
  function mast(h, m, opts: KitOptions = {}) {
    const r = opts.r == null ? Math.max(0.12, h * 0.02) : opts.r;
    const parts = [
      xf(new THREE.CylinderGeometry(r * 0.5, r, h, 8), 0, h / 2, 0),
    ];
    for (let i = 1; i <= 3; i++) {
      parts.push(
        xf(
          new THREE.TorusGeometry(r * (1.1 - i * 0.14), r * 0.32, 4, 8),
          0,
          (h * i) / 4,
          0,
          Math.PI / 2,
          0,
          0
        )
      );
    }
    return mesh(mergeGeos(parts), m || mat.steel, opts);
  }

  // aerial — a whip antenna with cross elements. Base at y.
  function aerial(h, m, opts: KitOptions = {}) {
    const parts = [
      xf(new THREE.CylinderGeometry(0.045, 0.09, h, 6), 0, h / 2, 0),
    ];
    const n = Math.max(2, Math.min(opts.elements || 4, 7));
    for (let i = 0; i < n; i++) {
      const y = h * (0.42 + (0.5 * i) / n);
      const len = h * 0.24 * (1 - i / (n + 2));
      parts.push(xf(new THREE.BoxGeometry(len, 0.05, 0.05), 0, y, 0));
    }
    parts.push(xf(new THREE.SphereGeometry(0.11, 6, 5), 0, h, 0));
    return mesh(mergeGeos(parts), m || mat.steel, opts);
  }

  // vent — a stack with a cowl. Base at y.
  function vent(r, h, m, opts: KitOptions = {}) {
    const parts = [
      xf(new THREE.CylinderGeometry(r, r, h, 10), 0, h / 2, 0),
      xf(
        new THREE.CylinderGeometry(r * 1.35, r * 1.1, r * 0.5, 10),
        0,
        h + r * 0.2,
        0
      ),
      xf(
        new THREE.SphereGeometry(r * 1.32, 10, 5, 0, TAU, 0, Math.PI / 2),
        0,
        h + r * 0.42,
        0,
        0,
        0,
        0,
        1,
        0.5,
        1
      ),
      xf(
        new THREE.TorusGeometry(r * 1.04, r * 0.12, 4, 10),
        0,
        h * 0.35,
        0,
        Math.PI / 2,
        0,
        0
      ),
    ];
    return mesh(mergeGeos(parts), m || mat.steel, opts);
  }

  // fan — housing ring with a spinning 4-blade rotor. Base at y (axis vertical).
  function fan(r, m, opts: KitOptions = {}) {
    const g = group(opts);
    const body = m || mat.steel;
    const hous = [
      xf(
        new THREE.CylinderGeometry(r, r, r * 0.5, 12, 1, true),
        0,
        r * 0.25,
        0
      ),
      xf(
        new THREE.TorusGeometry(r, r * 0.09, 4, 14),
        0,
        r * 0.52,
        0,
        Math.PI / 2,
        0,
        0
      ),
      xf(new THREE.BoxGeometry(r * 2.3, 0.16, r * 2.3), 0, 0.08, 0),
    ];
    g.add(mesh(mergeGeos(hous), body));
    const rot = group({ y: r * 0.3 });
    const blades = [
      xf(new THREE.CylinderGeometry(r * 0.16, r * 0.16, r * 0.36, 8), 0, 0, 0),
    ];
    for (let i = 0; i < 4; i++) {
      const th = (i / 4) * TAU;
      const b = new THREE.BoxGeometry(r * 0.86, 0.06, r * 0.42);
      xf(b, r * 0.5, 0, 0, 0.45, 0, 0);
      xf(b, 0, 0, 0, 0, th, 0);
      blades.push(b);
    }
    rot.add(mesh(mergeGeos(blades), opts.bladeMat || mat.darkSlate));
    g.add(rot);
    spin(rot, opts.speed == null ? 2.6 : opts.speed, "y");
    return g;
  }

  // chimney — tapered stack with a corbelled cap and pots. Base at y.
  function chimney(r, h, m, opts: KitOptions = {}) {
    const parts = [
      frustumGeo(r * 2, r * 2, r * 1.55, r * 1.55, h),
      xf(
        new THREE.BoxGeometry(r * 2.3, h * 0.045, r * 2.3),
        0,
        h - h * 0.02,
        0
      ),
      xf(
        new THREE.BoxGeometry(r * 2.05, h * 0.04, r * 2.05),
        0,
        h - h * 0.065,
        0
      ),
    ];
    const g = group(opts);
    g.add(mesh(mergeGeos(parts), m || mat.terracotta));
    const pots = [];
    for (const sx of [-1, 1]) {
      pots.push(
        xf(
          new THREE.CylinderGeometry(r * 0.3, r * 0.34, r * 0.9, 8),
          sx * r * 0.5,
          h + r * 0.45,
          0
        )
      );
    }
    g.add(mesh(mergeGeos(pots), opts.potMat || mat.concrete));
    return g;
  }

  // tank — vertical drum with dished ends, or horizontal on saddles if { lying: true }.
  // CENTRED on y (the inner frame is built base-up then re-centred).
  function tank(rr, rh, m, rawOpts) {
    const opts = O(rawOpts);
    const r = Math.abs(D(rr, 1.6));
    const h = Math.abs(D(rh, 5));
    const g = group(opts);
    const inner = new THREE.Group();
    g.add(inner);
    inner.position.y = opts.lying ? -(r + Math.max(0.5, r * 0.5)) : -h / 2;
    const body = M(m, mat.steel);
    const parts = [];
    if (opts.lying) {
      const sad = Math.max(0.5, r * 0.5);
      parts.push(
        xf(
          new THREE.CylinderGeometry(r, r, h, 14, 1, true),
          0,
          r + sad,
          0,
          0,
          0,
          Math.PI / 2
        )
      );
      for (const sx of [-1, 1]) {
        parts.push(
          xf(
            new THREE.SphereGeometry(r, 12, 6, 0, TAU, 0, Math.PI / 2),
            (sx * h) / 2,
            r + sad,
            0,
            0,
            0,
            (sx * Math.PI) / 2,
            1,
            0.55,
            1
          )
        );
      }
      const rings = Math.max(2, Math.round(h / 3));
      for (let i = 0; i <= rings; i++) {
        parts.push(
          xf(
            new THREE.TorusGeometry(r * 1.02, 0.08, 4, 14),
            -h / 2 + (h * i) / rings,
            r + sad,
            0,
            0,
            Math.PI / 2,
            0
          )
        );
      }
      const sadd = [];
      for (const sx of [-0.62, 0.62]) {
        sadd.push(
          xf(
            new THREE.BoxGeometry(r * 0.7, sad, r * 2.1),
            sx * h * 0.5,
            sad / 2,
            0
          )
        );
      }
      inner.add(mesh(mergeGeos(sadd), M(opts.saddleMat, mat.concrete)));
    } else {
      parts.push(
        xf(
          new THREE.CylinderGeometry(r, r, h * 0.88, 14, 1, true),
          0,
          h * 0.44,
          0
        ),
        xf(
          new THREE.SphereGeometry(r, 14, 6, 0, TAU, 0, Math.PI / 2),
          0,
          h * 0.88,
          0,
          0,
          0,
          0,
          1,
          0.42,
          1
        ),
        xf(
          new THREE.CylinderGeometry(r * 1.06, r * 1.12, h * 0.1, 14),
          0,
          h * 0.05,
          0
        )
      );
      const rings = Math.max(2, Math.round(h / 3));
      for (let i = 1; i < rings; i++) {
        parts.push(
          xf(
            new THREE.TorusGeometry(r * 1.02, 0.08, 4, 14),
            0,
            (h * 0.88 * i) / rings,
            0,
            Math.PI / 2,
            0,
            0
          )
        );
      }
      // ladder
      for (const sz of [-0.16, 0.16]) {
        parts.push(
          xf(
            new THREE.BoxGeometry(0.07, h * 0.88, 0.07),
            r * 1.06,
            h * 0.44,
            sz
          )
        );
      }
      const rungs = Math.max(3, Math.round(h / 0.9));
      for (let i = 1; i < rungs; i++) {
        parts.push(
          xf(
            new THREE.BoxGeometry(0.05, 0.05, 0.36),
            r * 1.06,
            (h * 0.88 * i) / rungs,
            0
          )
        );
      }
    }
    inner.add(mesh(mergeGeos(parts), body));
    return g;
  }

  // silo — corrugated cylinder with a conical cap and a ladder. CENTRED on y.
  function silo(rr, rh, m, rawOpts) {
    const opts = O(rawOpts);
    const r = Math.abs(D(rr, 2));
    const h = Math.abs(D(rh, 8));
    const g = group(opts);
    const inner = new THREE.Group();
    inner.position.y = -h / 2;
    g.add(inner);
    const bodyH = h * 0.82;
    const parts = [
      xf(new THREE.CylinderGeometry(r, r, bodyH, 14, 1, true), 0, bodyH / 2, 0),
    ];
    const n = Math.max(4, Math.min(Math.round(bodyH / 1.1), 16));
    for (let i = 1; i < n; i++) {
      parts.push(
        xf(
          new THREE.TorusGeometry(r * 1.015, 0.07, 4, 14),
          0,
          (bodyH * i) / n,
          0,
          Math.PI / 2,
          0,
          0
        )
      );
    }
    parts.push(
      xf(new THREE.CylinderGeometry(r * 1.08, r * 1.14, 0.4, 14), 0, 0.2, 0),
      xf(new THREE.ConeGeometry(r * 1.06, h * 0.2, 14), 0, bodyH + h * 0.1, 0)
    );
    for (const sz of [-0.17, 0.17])
      parts.push(
        xf(new THREE.BoxGeometry(0.07, bodyH, 0.07), r * 1.05, bodyH / 2, sz)
      );
    const rungs = Math.max(4, Math.round(bodyH / 0.9));
    for (let i = 1; i < rungs; i++)
      parts.push(
        xf(
          new THREE.BoxGeometry(0.05, 0.05, 0.38),
          r * 1.05,
          (bodyH * i) / rungs,
          0
        )
      );
    inner.add(mesh(mergeGeos(parts), M(m, mat.concrete)));
    inner.add(
      mesh(
        new THREE.BoxGeometry(r * 0.55, r * 0.7, 0.16),
        M(opts.hatchMat, mat.steel),
        { y: bodyH * 0.28, z: r * 1.01 }
      )
    );
    return g;
  }

  // crateStack — battened crates stacked in a w×d×h envelope. Base at y.
  function crateStack(w, h, d, m, opts: KitOptions = {}) {
    const cw = opts.crate == null ? Math.min(1.9, w * 0.5) : opts.crate;
    const cols = Math.max(1, Math.round(w / cw));
    const rows = Math.max(1, Math.round(d / cw));
    const lev = Math.max(1, Math.round(h / cw));
    const parts = [];
    const batt = [];
    let k = 0;
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        for (let l = 0; l < lev; l++) {
          k++;
          if (l > 0 && rnd(k, 3) > 0.78) continue;
          const s = cw * 0.92;
          const x = -w / 2 + (w * (i + 0.5)) / cols;
          const z = -d / 2 + (d * (j + 0.5)) / rows;
          const y = cw * (l + 0.5);
          const rot = (rnd(k, 7) - 0.5) * 0.18;
          const c = new THREE.BoxGeometry(s, s * 0.92, s);
          xf(c, x, y, z, 0, rot, 0);
          parts.push(c);
          for (const sz of [-1, 1]) {
            const b = new THREE.BoxGeometry(s * 1.02, s * 0.12, 0.07);
            xf(b, 0, s * 0.26 * sz, s * 0.5);
            xf(b, x, y, z, 0, rot, 0);
            batt.push(b);
            const b2 = new THREE.BoxGeometry(0.07, s * 0.12, s * 1.02);
            xf(b2, s * 0.5, s * 0.26 * sz, 0);
            xf(b2, x, y, z, 0, rot, 0);
            batt.push(b2);
          }
        }
      }
    }
    const g = group(opts);
    g.add(mesh(mergeGeos(parts), m || mat.timber));
    g.add(mesh(mergeGeos(batt), opts.battenMat || mat.darkSlate));
    return g;
  }

  // container — a real shipping container: corrugated sides, rails, corner castings,
  // door leaves with locking rods and handles. Length along X, doors at +X. CENTRED on y.
  function container(rw, rh, rd, hex, rawOpts) {
    const opts = O(rawOpts);
    const w = Math.abs(D(rw, 6));
    const h = Math.abs(D(rh, 2.6));
    const d = Math.abs(D(rd, 2.4));
    const g = group(opts);
    const inner = new THREE.Group();
    inner.position.y = -h / 2;
    g.add(inner);
    const body = plainMat(typeof hex === "string" ? hex : "#7a8794", {
      rough: 0.62,
      metal: 0.3,
    });
    const parts = [
      xf(new THREE.BoxGeometry(w - 0.3, h - 0.3, d - 0.24), 0, h / 2, 0),
    ];
    // corrugation ribs on both long sides + the blind end
    const n = Math.min(Math.max(4, Math.round(w / 0.55)), 26);
    for (let i = 0; i < n; i++) {
      const x = -w / 2 + (w * (i + 0.5)) / n;
      for (const sz of [-1, 1]) {
        parts.push(
          xf(
            new THREE.BoxGeometry(w / n / 2.4, h - 0.55, 0.14),
            x,
            h / 2,
            (sz * d) / 2 - sz * 0.05
          )
        );
      }
    }
    const nz = Math.min(Math.max(3, Math.round(d / 0.55)), 14);
    for (let i = 0; i < nz; i++) {
      const z = -d / 2 + (d * (i + 0.5)) / nz;
      parts.push(
        xf(
          new THREE.BoxGeometry(0.14, h - 0.55, d / nz / 2.4),
          -w / 2 + 0.05,
          h / 2,
          z
        )
      );
    }
    // doors share the body material, so they join the same merge (one draw call)
    for (const sz of [-1, 1]) {
      parts.push(
        xf(
          new THREE.BoxGeometry(0.14, h - 0.42, d / 2 - 0.24),
          w / 2 + 0.02,
          h / 2,
          (sz * d) / 4
        )
      );
    }
    inner.add(mesh(mergeGeos(parts), body));
    // steel frame: rails, posts, corner castings
    const fr = [];
    for (const sy of [0.14, h - 0.14]) {
      for (const sz of [-1, 1])
        fr.push(xf(new THREE.BoxGeometry(w, 0.22, 0.22), 0, sy, (sz * d) / 2));
      for (const sx of [-1, 1])
        fr.push(xf(new THREE.BoxGeometry(0.22, 0.22, d), (sx * w) / 2, sy, 0));
    }
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        fr.push(
          xf(
            new THREE.BoxGeometry(0.24, h, 0.24),
            (sx * w) / 2,
            h / 2,
            (sz * d) / 2
          ),
          xf(
            new THREE.BoxGeometry(0.42, 0.34, 0.42),
            (sx * w) / 2,
            0.17,
            (sz * d) / 2
          ),
          xf(
            new THREE.BoxGeometry(0.42, 0.34, 0.42),
            (sx * w) / 2,
            h - 0.17,
            (sz * d) / 2
          )
        );
      }
    }
    inner.add(mesh(mergeGeos(fr), mat.darkSlate));
    // door hardware: locking rods + handles
    const hw = [];
    for (const dz of [-0.34, -0.12, 0.12, 0.34]) {
      hw.push(
        xf(
          new THREE.CylinderGeometry(0.05, 0.05, h - 0.5, 6),
          w / 2 + 0.11,
          h / 2,
          dz * d
        ),
        xf(
          new THREE.BoxGeometry(0.22, 0.16, 0.1),
          w / 2 + 0.18,
          h * 0.46,
          dz * d
        )
      );
    }
    inner.add(mesh(mergeGeos(hw), mat.brass));
    return g;
  }

  // bollards — merged posts at [[x,z] | [x,y,z] | Vector3, …]. Base-anchored.
  function bollards(points, m, rawOpts) {
    const opts = O(rawOpts);
    const pts = toVec3List(points);
    if (!pts.length) return group(opts);
    const h = Math.abs(D(opts.h, 0.85));
    const r = Math.abs(D(opts.r, 0.19));
    const parts = [];
    for (const p of pts) {
      parts.push(
        xf(new THREE.CylinderGeometry(r * 0.86, r, h, 8), p.x, h / 2, p.z),
        xf(
          new THREE.SphereGeometry(r * 0.86, 8, 4, 0, TAU, 0, Math.PI / 2),
          p.x,
          h,
          p.z,
          0,
          0,
          0,
          1,
          0.6,
          1
        )
      );
    }
    return mesh(mergeGeos(parts), M(m, mat.darkSlate), opts);
  }

  // planter — a tub with soil and a shrub. Base at y.
  function planter(r, m, opts: KitOptions = {}) {
    const g = group(opts);
    const h = opts.h == null ? r * 0.85 : opts.h;
    const parts = [
      frustumGeo(r * 2, r * 2, r * 1.7, r * 1.7, h),
      xf(new THREE.BoxGeometry(r * 2.2, 0.14, r * 2.2), 0, h - 0.07, 0),
    ];
    g.add(mesh(mergeGeos(parts), m || mat.concrete));
    g.add(
      mesh(
        new THREE.BoxGeometry(r * 1.6, 0.1, r * 1.6),
        plainMat("#3a3128", { rough: 1 }),
        { y: h - 0.02 }
      )
    );
    const shrub = new THREE.IcosahedronGeometry(r * 0.72, 0);
    g.add(
      mesh(
        xf(shrub, 0, h + r * 0.5, 0, 0, 0, 0, 1, 0.8, 1),
        plainMat("#5b7355", { rough: 0.95 })
      )
    );
    return g;
  }

  // tree — trunk + canopy. opts { r, kind: 'round' | 'conifer', x, y, z }
  function tree(h, opts: KitOptions = {}) {
    const g = group(opts);
    const r = opts.r == null ? h * 0.24 : opts.r;
    g.add(
      mesh(
        new THREE.CylinderGeometry(h * 0.035, h * 0.055, h * 0.5, 6),
        mat.timber,
        { y: h * 0.25 }
      )
    );
    const leaf = plainMat(opts.hex || "#5f7a58", { rough: 0.96 });
    const parts = [];
    if (opts.kind === "conifer") {
      for (let i = 0; i < 3; i++) {
        parts.push(
          xf(
            new THREE.ConeGeometry(r * (1 - i * 0.24), h * 0.36, 7),
            0,
            h * (0.42 + i * 0.22),
            0
          )
        );
      }
    } else {
      parts.push(
        xf(new THREE.IcosahedronGeometry(r, 0), 0, h * 0.72, 0),
        xf(
          new THREE.IcosahedronGeometry(r * 0.62, 0),
          r * 0.5,
          h * 0.56,
          r * 0.24
        ),
        xf(
          new THREE.IcosahedronGeometry(r * 0.55, 0),
          -r * 0.42,
          h * 0.6,
          -r * 0.3
        )
      );
    }
    g.add(mesh(mergeGeos(parts), leaf));
    return g;
  }

  // streetlamp — pole with a curved arm and a glowing head. Base at y.
  function streetlamp(h, m, opts: KitOptions = {}) {
    const g = group(opts);
    const arm = opts.arm == null ? h * 0.28 : opts.arm;
    const parts = [
      xf(new THREE.CylinderGeometry(0.07, 0.11, h, 7), 0, h / 2, 0),
      xf(new THREE.CylinderGeometry(0.2, 0.24, 0.3, 8), 0, 0.15, 0),
      strutGeo([0, h - 0.3, 0], [arm * 0.7, h, 0], 0.08),
      strutGeo([arm * 0.7, h, 0], [arm, h - 0.06, 0], 0.08),
    ];
    g.add(mesh(mergeGeos(parts), m || mat.darkSlate));
    const head = mesh(
      new THREE.BoxGeometry(0.5, 0.16, 0.34),
      matGlow(opts.hex || "#ffdca8", 0.8),
      { x: arm, y: h - 0.16 }
    );
    g.add(head);
    return g;
  }

  // flagpole — pole, finial and a flag. Base at y.
  function flagpole(h, m, opts: KitOptions = {}) {
    const g = group(opts);
    const parts = [
      xf(new THREE.CylinderGeometry(0.06, 0.1, h, 7), 0, h / 2, 0),
      xf(new THREE.CylinderGeometry(0.32, 0.4, 0.26, 10), 0, 0.13, 0),
    ];
    g.add(mesh(mergeGeos(parts), m || mat.steel));
    g.add(mesh(new THREE.SphereGeometry(0.13, 8, 6), mat.brass, { y: h }));
    const flag = mesh(
      new THREE.BoxGeometry(h * 0.3, h * 0.17, 0.05),
      plainMat(opts.hex || "#d9d3c6", { rough: 0.9 }),
      {
        x: h * 0.16,
        y: h * 0.86,
      }
    );
    g.add(flag);
    bob(flag, 0.08, 2.4);
    return g;
  }

  // signBand — the primary home of district colour: a glowing fascia in a dark surround.
  function signBand(w, h, hex, opts: KitOptions = {}) {
    const g = group(opts);
    const dep = opts.depth == null ? 0.22 : opts.depth;
    if (opts.frame !== false)
      g.add(
        mesh(
          new THREE.BoxGeometry(w + 0.34, h + 0.3, dep),
          opts.frameMat || mat.darkSlate
        )
      );
    g.add(
      mesh(
        new THREE.BoxGeometry(w, h, dep + 0.12),
        matGlow(hex || "#ffd479", opts.base == null ? 0.62 : opts.base)
      )
    );
    if (opts.brackets) {
      const br = [];
      for (const sx of [-1, 1])
        br.push(
          xf(
            new THREE.BoxGeometry(0.16, h + 0.5, 0.5),
            (sx * (w + 0.5)) / 2,
            0,
            -dep * 0.6
          )
        );
      g.add(mesh(mergeGeos(br), mat.brass));
    }
    return g;
  }

  // plaqueWall — a wall faced with a grid of small brass plaques. CENTRED on y.
  function plaqueWall(w, h, cols, rows, m, opts: KitOptions = {}) {
    const g = group(opts);
    const d = opts.d == null ? 0.6 : opts.d;
    g.add(mesh(new THREE.BoxGeometry(w, h, d), m || mat.bone));
    const c = Math.max(1, Math.min(cols || 6, 22));
    const r = Math.max(1, Math.min(rows || 5, 22));
    const parts = [];
    for (let i = 0; i < c; i++) {
      for (let j = 0; j < r; j++) {
        const x = -w / 2 + (w * (i + 0.5)) / c;
        const y = -h / 2 + (h * (j + 0.5)) / r;
        parts.push(
          xf(
            new THREE.BoxGeometry((w / c) * 0.72, (h / r) * 0.66, 0.1),
            x,
            y,
            d / 2 + 0.03
          )
        );
      }
    }
    g.add(mesh(mergeGeos(parts), opts.plaqueMat || mat.brass));
    return g;
  }

  // gaugeBoard — instrument panel: brass bezels, glowing needles and lamps. Faces +Z.
  function gaugeBoard(w, h, m, hex, opts: KitOptions = {}) {
    const g = group(opts);
    g.add(mesh(new THREE.BoxGeometry(w, h, 0.3), m || mat.darkSlate));
    const cols = Math.max(2, Math.round(w / 1.5));
    const rows = Math.max(1, Math.round(h / 1.5));
    const rr = Math.min(w / cols, h / rows) * 0.34;
    const bez = [];
    const nee = [];
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const x = -w / 2 + (w * (i + 0.5)) / cols;
        const y = -h / 2 + (h * (j + 0.5)) / rows;
        bez.push(
          xf(new THREE.TorusGeometry(rr, rr * 0.16, 4, 12), x, y, 0.16),
          xf(
            new THREE.CylinderGeometry(rr * 0.92, rr * 0.92, 0.1, 12),
            x,
            y,
            0.14,
            Math.PI / 2,
            0,
            0
          )
        );
        const a = -0.8 + rnd(i * 7 + j, 5) * 2.4;
        const nd = xf(
          new THREE.BoxGeometry(rr * 0.86, rr * 0.12, 0.06),
          rr * 0.4,
          0,
          0
        );
        xf(nd, x, y, 0.24, 0, 0, a);
        nee.push(nd);
      }
    }
    g.add(mesh(mergeGeos(bez), mat.brass));
    g.add(mesh(mergeGeos(nee), matGlow(hex || "#ffb545", 0.8)));
    g.add(
      mesh(new THREE.BoxGeometry(w + 0.24, 0.3, 0.4), mat.brass, {
        y: h / 2 + 0.14,
      })
    );
    return g;
  }

  // splitFlapBoard — a departure board: flap cells, glowing rows, header band. Faces +Z.
  function splitFlapBoard(w, h, m, hex, opts: KitOptions = {}) {
    const g = group(opts);
    g.add(mesh(new THREE.BoxGeometry(w, h, 0.36), m || mat.darkSlate));
    const rows = Math.max(3, Math.min(opts.rows || Math.round(h / 0.9), 12));
    const cols = Math.max(6, Math.min(opts.cols || Math.round(w / 0.7), 26));
    const cells = [];
    const text = [];
    const cw = (w * 0.94) / cols;
    const ch = (h * 0.8) / rows;
    for (let j = 0; j < rows; j++) {
      const y = h * 0.38 - ch * (j + 0.5);
      for (let i = 0; i < cols; i++) {
        const x = -w * 0.47 + cw * (i + 0.5);
        cells.push(
          xf(new THREE.BoxGeometry(cw * 0.86, ch * 0.84, 0.12), x, y, 0.2),
          xf(new THREE.BoxGeometry(cw * 0.86, 0.04, 0.16), x, y, 0.22)
        );
      }
      const len = 0.3 + rnd(j, 11) * 0.55;
      text.push(
        xf(
          new THREE.BoxGeometry(w * 0.9 * len, ch * 0.4, 0.08),
          -w * 0.45 + (w * 0.9 * len) / 2,
          y,
          0.28
        )
      );
    }
    g.add(mesh(mergeGeos(cells), plainMat("#20242b", { rough: 0.85 })));
    g.add(mesh(mergeGeos(text), matGlow(hex || "#ffe08a", 0.55)));
    g.add(
      mesh(new THREE.BoxGeometry(w, h * 0.11, 0.44), mat.brass, { y: h * 0.44 })
    );
    g.add(
      mesh(
        new THREE.BoxGeometry(w * 0.6, h * 0.05, 0.5),
        matGlow(hex || "#ffe08a", 0.7),
        { y: h * 0.44, z: 0.06 }
      )
    );
    return g;
  }

  // clockFace — dial facing +Z with brass rim, ticks and live hands.
  function clockFace(rr, m, hex, rawOpts) {
    const opts = O(rawOpts);
    const r = Math.abs(D(rr, 1.4));
    const g = group(opts);
    g.add(
      mesh(
        xf(
          new THREE.CylinderGeometry(r, r, 0.18, 20),
          0,
          0,
          0,
          Math.PI / 2,
          0,
          0
        ),
        M(m, mat.bone)
      )
    );
    // hub shares the rim material — merged in rather than costing its own draw call
    const rim = [
      xf(new THREE.TorusGeometry(r * 1.02, r * 0.07, 5, 22), 0, 0, 0.02),
      xf(
        new THREE.CylinderGeometry(r * 0.08, r * 0.08, 0.12, 8),
        0,
        0,
        0.2,
        Math.PI / 2,
        0,
        0
      ),
    ];
    for (let i = 0; i < 12; i++) {
      const th = (i / 12) * TAU;
      const t = xf(
        new THREE.BoxGeometry(r * (i % 3 === 0 ? 0.24 : 0.14), r * 0.055, 0.06),
        r * 0.83,
        0,
        0.11
      );
      xf(t, 0, 0, 0, 0, 0, th);
      rim.push(t);
    }
    g.add(mesh(mergeGeos(rim), M(opts.rimMat, mat.brass)));
    const handMat = matGlow(hex || "#ffe6b0", 0.85);
    const hour = mesh(
      xf(new THREE.BoxGeometry(r * 0.09, r * 0.5, 0.05), 0, r * 0.25, 0),
      handMat,
      { z: 0.16 }
    );
    const minute = mesh(
      xf(new THREE.BoxGeometry(r * 0.07, r * 0.78, 0.05), 0, r * 0.39, 0),
      handMat,
      { z: 0.19 }
    );
    g.add(hour);
    g.add(minute);
    // world.ts already drives `{ type: 'clock', minute, hour }` — reuse that handler
    // rather than introducing a second, conflicting one.
    animated.push({ type: "clock", hour, minute });
    return g;
  }

  // weathervane — cross arms and a spinning arrow. Base at y.
  function weathervane(h, m, opts: KitOptions = {}) {
    const g = group(opts);
    const parts = [
      xf(new THREE.CylinderGeometry(0.05, 0.09, h, 6), 0, h / 2, 0),
      xf(new THREE.BoxGeometry(h * 0.34, 0.05, 0.05), 0, h * 0.62, 0),
      xf(new THREE.BoxGeometry(0.05, 0.05, h * 0.34), 0, h * 0.62, 0),
      xf(new THREE.SphereGeometry(0.1, 6, 5), 0, h * 0.72, 0),
    ];
    g.add(mesh(mergeGeos(parts), m || mat.brass));
    const arrow = group({ y: h * 0.94 });
    const ap = [
      xf(new THREE.BoxGeometry(0.05, 0.05, h * 0.42), 0, 0, 0),
      xf(
        new THREE.ConeGeometry(0.1, 0.28, 5),
        0,
        0,
        h * 0.23,
        Math.PI / 2,
        0,
        0
      ),
      xf(new THREE.BoxGeometry(0.04, h * 0.15, h * 0.16), 0, 0.02, -h * 0.16),
    ];
    arrow.add(mesh(mergeGeos(ap), m || mat.brass));
    g.add(arrow);
    spin(arrow, 0.22, "y");
    return g;
  }

  // solarArray — rows of tilted panels on a merged steel frame. Base at y.
  function solarArray(w, d, m, opts: KitOptions = {}) {
    const g = group(opts);
    const rows = Math.max(1, Math.min(opts.rows || Math.round(d / 2.4), 8));
    const tilt = opts.tilt == null ? 0.55 : opts.tilt;
    const legs = [];
    const panes = [];
    const pd = (d / rows) * 0.78;
    for (let j = 0; j < rows; j++) {
      const z = -d / 2 + (d * (j + 0.5)) / rows;
      panes.push(
        xf(new THREE.BoxGeometry(w * 0.96, 0.1, pd), 0, 0.75, z, tilt, 0, 0)
      );
      const n = Math.max(2, Math.round(w / 3));
      for (let i = 0; i <= n; i++) {
        const x = -w / 2 + (w * i) / n;
        legs.push(
          xf(new THREE.BoxGeometry(0.12, 0.75, 0.12), x, 0.375, z + pd * 0.3),
          xf(new THREE.BoxGeometry(0.12, 1.05, 0.12), x, 0.52, z - pd * 0.3)
        );
      }
      legs.push(
        xf(new THREE.BoxGeometry(w, 0.1, 0.14), 0, 0.75, z, tilt, 0, 0)
      );
    }
    g.add(mesh(mergeGeos(legs), m || mat.steel));
    g.add(mesh(mergeGeos(panes), opts.panelMat || mat.glass));
    return g;
  }

  // wheel — a spoked flywheel in the XY plane (spins about Z). Centred on y.
  function wheel(r, m, opts: KitOptions = {}) {
    const g = group(opts);
    const rot = new THREE.Group();
    const parts = [
      new THREE.TorusGeometry(r, r * 0.1, 6, 20),
      xf(
        new THREE.CylinderGeometry(r * 0.18, r * 0.18, r * 0.28, 10),
        0,
        0,
        0,
        Math.PI / 2,
        0,
        0
      ),
    ];
    const spokes = Math.max(4, Math.min(opts.spokes || 6, 10));
    for (let i = 0; i < spokes; i++) {
      const th = (i / spokes) * Math.PI * 2;
      const s = xf(
        new THREE.BoxGeometry(r * 1.86, r * 0.09, r * 0.09),
        0,
        0,
        0,
        0,
        0,
        th
      );
      parts.push(s);
    }
    rot.add(mesh(mergeGeos(parts), m || mat.steel));
    g.add(rot);
    spin(rot, opts.speed == null ? 1.4 : opts.speed, "z");
    return g;
  }

  // piston — cylinder body along X with a reciprocating rod + crosshead. Centred on y.
  function piston(len, r, m, opts: KitOptions = {}) {
    const g = group(opts);
    const body = m || mat.steel;
    const parts = [
      xf(
        new THREE.CylinderGeometry(r, r, len * 0.62, 12),
        -len * 0.19,
        0,
        0,
        0,
        0,
        Math.PI / 2
      ),
      xf(
        new THREE.CylinderGeometry(r * 1.18, r * 1.18, r * 0.4, 12),
        -len * 0.5,
        0,
        0,
        0,
        0,
        Math.PI / 2
      ),
      xf(
        new THREE.CylinderGeometry(r * 1.18, r * 1.18, r * 0.4, 12),
        len * 0.12,
        0,
        0,
        0,
        0,
        Math.PI / 2
      ),
    ];
    for (const sz of [-1, 1]) {
      parts.push(
        xf(
          new THREE.BoxGeometry(len * 0.72, r * 0.14, r * 0.14),
          -len * 0.19,
          r * 1.1,
          sz * r * 0.7
        )
      );
    }
    g.add(mesh(mergeGeos(parts), body));
    const rod = group({});
    const rp = [
      xf(
        new THREE.CylinderGeometry(r * 0.24, r * 0.24, len * 0.58, 8),
        len * 0.36,
        0,
        0,
        0,
        0,
        Math.PI / 2
      ),
      xf(new THREE.BoxGeometry(r * 0.7, r * 1.5, r * 1.5), len * 0.63, 0, 0),
    ];
    rod.add(mesh(mergeGeos(rp), opts.rodMat || mat.brass));
    g.add(rod);
    animated.push({
      type: "reciprocate",
      obj: rod,
      axis: "x",
      base: 0,
      amp: len * 0.18,
      speed: opts.speed == null ? 1.6 : opts.speed,
      phase: opts.phase == null ? 0 : opts.phase,
    });
    return g;
  }

  /* ------------------------------------------------------------------ animation */

  function beacon(x, y, z, hex, r = 0.55) {
    // Deliberately uncached: each beacon owns its material so the pulses stay out of phase.
    const m = glowMat(hex || "#ffd479", 0.85);
    const o = mesh(new THREE.SphereGeometry(Math.abs(D(r, 0.55)), 8, 6), m, {
      x: N(x, 0),
      y: N(y, 0),
      z: N(z, 0),
    });
    animated.push({
      type: "beacon",
      mat: m,
      phase: rnd(animated.length, 2) * 6,
    });
    return o;
  }

  // seam — a glowing line along [[x,y,z] | [x,z] | Vector3, …]. 2-element points sit at
  // local y=0; `opts.y` always translates the finished seam.
  function seam(points, hex, rawOpts) {
    const opts = O(rawOpts);
    const wdt = Math.abs(D(opts.w, 0.16));
    const P = toVec3List(points, 0);
    if (!P.length) return group(opts);
    const lift = N(opts.lift, 0);
    const parts = [];
    for (let i = 0; i < P.length - 1; i++) {
      const s = strutGeo(
        [P[i].x, P[i].y + lift, P[i].z],
        [P[i + 1].x, P[i + 1].y + lift, P[i + 1].z],
        wdt
      );
      if (s) parts.push(s);
    }
    if (opts.closed && P.length > 2) {
      const a = P[P.length - 1];
      const b = P[0];
      const s = strutGeo([a.x, a.y + lift, a.z], [b.x, b.y + lift, b.z], wdt);
      if (s) parts.push(s);
    }
    for (const p of P)
      parts.push(
        xf(new THREE.BoxGeometry(wdt, wdt, wdt), p.x, p.y + lift, p.z)
      );
    return mesh(
      mergeGeos(parts),
      matGlow(hex || "#7fd4ff", D(opts.base, 0.6)),
      opts
    );
  }

  function spin(obj, speed, axis: "x" | "y" | "z" = "y") {
    animated.push({
      type: "spin",
      obj,
      speed: speed == null ? 1 : speed,
      axis,
    });
    return obj;
  }

  function bob(obj, amp, speed) {
    animated.push({
      type: "bob",
      obj,
      amp: amp == null ? 0.2 : amp,
      speed: speed == null ? 1 : speed,
      base: obj.position.y,
      phase: rnd(animated.length, 4) * 6,
    });
    return obj;
  }

  // activityLamp — brightens with district activity when a districtId is supplied;
  // otherwise it falls back to the shared beacon pulse so it is never a dead lamp.
  function activityLamp(hex, rawOpts) {
    const opts = O(rawOpts);
    // Uncached for the same reason as beacon(): it is driven per-instance.
    const m = glowMat(hex || "#8fe3ff", D(opts.base, 0.5));
    const geo = opts.r
      ? new THREE.SphereGeometry(opts.r, 8, 6)
      : new THREE.BoxGeometry(opts.w || 0.8, opts.h || 0.3, opts.d || 0.24);
    const o = mesh(geo, m, opts);
    if (opts.districtId)
      animated.push({
        type: "activity",
        mat: m,
        districtId: opts.districtId,
        phase: rnd(animated.length, 6) * 6,
      });
    else
      animated.push({
        type: "beacon",
        mat: m,
        phase: rnd(animated.length, 6) * 6,
      });
    return o;
  }

  /* ------------------------------------------------------------------ export */

  // Landmarks are authored independently; a bad argument must cost one detail, never the
  // whole building. Every Object3D builder degrades to an empty Group instead of throwing.
  const safe = (fn, name) =>
    function kitBuilder(...args) {
      try {
        const r = fn(...args);
        return r && r.isObject3D ? r : new THREE.Group();
      } catch (error) {
        console.warn("[kit]", name, error);
        return new THREE.Group();
      }
    };

  const builders = {
    // volumes
    box,
    drum,
    dome,
    vault,
    prismShape,
    wedge,
    hull,
    // roofs
    roofGable,
    roofHipped,
    roofSawtooth,
    roofBarrel,
    roofPyramid,
    roofStepped,
    roofMansard,
    roofParapet,
    roofCone,
    roofDomeRibbed,
    // facades & structure
    curtainWall,
    punchedWindows,
    ribbedFacade,
    louvers,
    masonryBands,
    colonnade,
    arcade,
    pilotis,
    truss,
    latticeMast,
    gantry,
    catwalk,
    railing,
    stairFlight,
    spiralStair,
    steps,
    buttress,
    // props & fittings
    pipeRun,
    ductRun,
    dish,
    mast,
    aerial,
    vent,
    fan,
    chimney,
    tank,
    silo,
    crateStack,
    container,
    bollards,
    planter,
    tree,
    streetlamp,
    flagpole,
    signBand,
    plaqueWall,
    gaugeBoard,
    splitFlapBoard,
    clockFace,
    weathervane,
    solarArray,
    wheel,
    piston,
    // animation-bearing builders
    beacon,
    seam,
    activityLamp,
  };

  const kit = {
    // materials
    mat,
    matWindows: (hex) => {
      try {
        return matWindows(hex);
      } catch {
        return mat.bone;
      }
    },
    matGlow: (hex, base) => {
      try {
        return matGlow(hex, base);
      } catch {
        return mat.brass;
      }
    },
    matTint: (baseKey, hex, amt) => {
      try {
        return matTint(baseKey, hex, amt);
      } catch {
        return mat[baseKey] || mat.concrete;
      }
    },
    // animation registrars (return their subject, never a Group)
    spin: (obj, speed, axis) => {
      try {
        return obj ? spin(obj, speed, axis) : obj;
      } catch {
        return obj;
      }
    },
    bob: (obj, amp, speed) => {
      try {
        return obj ? bob(obj, amp, speed) : obj;
      } catch {
        return obj;
      }
    },
    // low-level utilities (handy for one-off bespoke bits inside a landmark)
    group,
    mesh,
    merge: mergeGeos,
    strutGeo,
    tubeGeo,
    frustumGeo,
    windowUVs,
    toVec3,
  } as unknown as CityKit;
  for (const name of Object.keys(builders))
    kit[name] = safe(builders[name], name);
  return kit;
}
