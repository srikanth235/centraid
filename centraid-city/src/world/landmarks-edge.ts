// governance: allow-repo-hygiene file-size-limit — one bespoke model per building id.

import type * as THREE from "three";

import type {
  CityKit,
  KitOptions,
  LandmarkBuilder,
  SurfaceMaterialFactory,
} from "../core/types.js";

function invoke(
  kit: CityKit | null | undefined,
  name: string,
  args: unknown[]
): unknown {
  const fn = kit ? kit[name] : null;
  if (typeof fn !== "function") return null;
  try {
    return fn.apply(kit, args);
  } catch {
    return null;
  }
}

function isObject3D(value: unknown): value is THREE.Object3D {
  return (
    typeof value === "object" &&
    value !== null &&
    "isObject3D" in value &&
    (value as { isObject3D?: boolean }).isObject3D === true
  );
}

function mk(
  target: THREE.Object3D | null,
  kit: CityKit | null | undefined,
  name: string,
  args: unknown[]
): THREE.Object3D | null {
  const o = invoke(kit, name, args);
  if (isObject3D(o) && target) target.add(o);
  return isObject3D(o) ? o : null;
}

function at(
  o: THREE.Object3D | null,
  x = 0,
  y = 0,
  z = 0,
  rotY?: number
): THREE.Object3D | null {
  if (isObject3D(o)) {
    o.position.set(x || 0, y || 0, z || 0);
    if (rotY) o.rotation.y = rotY;
  }
  return o;
}

function tilt(
  o: THREE.Object3D | null,
  rx?: number,
  rz?: number
): THREE.Object3D | null {
  if (isObject3D(o)) {
    if (rx) o.rotation.x = rx;
    if (rz) o.rotation.z = rz;
  }
  return o;
}

function noShadow(o: THREE.Object3D | null): THREE.Object3D | null {
  if (o && typeof o.traverse === "function") {
    o.traverse((c) => {
      if ("isMesh" in c && c.isMesh) {
        const mesh = c as THREE.Mesh;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
      }
    });
  }
  return o;
}

function palette(
  kit: CityKit | null | undefined,
  plainMat: SurfaceMaterialFactory
): Record<string, THREE.Material> {
  const m: Record<string, THREE.Material> = kit?.mat ?? {};
  const p = (hex: string, options?: KitOptions): THREE.MeshStandardMaterial =>
    plainMat(hex, options);
  return {
    bone: m.bone || p("#e8e2d6"),
    concrete: m.concrete || p("#cfc9bd"),
    plaster: m.plaster || p("#ded6c6"),
    slate: m.slate || p("#5d6570"),
    darkSlate: m.darkSlate || p("#3b424c"),
    steel: m.steel || p("#97a1ad", { metal: 0.6 }),
    brass: m.brass || p("#c08a3e", { metal: 0.85, rough: 0.3 }),
    copper: m.copper || p("#7fae9b", { metal: 0.5 }),
    glass: m.glass || p("#2b3440", { metal: 0.35, rough: 0.12 }),
    timber: m.timber || p("#a97d4f"),
    terracotta: m.terracotta || p("#b4674d"),
    rubber: m.rubber || p("#2f333a"),
  };
}

const CRATE_HUES = ["#7d8894", "#8a7f6f", "#5f6b74", "#9a8b6d", "#6e7a83"];

export const LANDMARKS_EDGE: Record<string, LandmarkBuilder> = {
  "apps-locker"({ g, w, h, d, color, kit, plainMat }) {
    const M = palette(kit, plainMat);
    const P = (n, ...a) => mk(g, kit, n, a);
    const front = d * 0.45;
    const plinth = 0.5;
    const bodyH = h * 0.78;
    const bodyY = plinth + bodyH / 2;

    at(P("box", w, plinth, d, M.darkSlate), 0, plinth / 2, 0);
    at(
      P("box", w * 0.94, bodyH, d * 0.9, M.bone, { bevel: true }),
      0,
      bodyY,
      0
    );

    at(
      P("ribbedFacade", w * 0.94, bodyH * 0.94, 0.3, 11, M.steel),
      0,
      bodyY,
      front + 0.16
    );

    at(
      P("box", w * 0.58, 0.55, 0.7, M.steel),
      0,
      plinth + bodyH * 0.56,
      front + 0.34
    );
    at(
      P("louvers", w * 0.5, bodyH * 0.5, 0.28, 9, M.rubber),
      0,
      plinth + bodyH * 0.27,
      front + 0.36
    );

    const lockY = plinth + bodyH * 0.78;
    at(P("box", 2, 1.5, 0.4, M.brass), 0, lockY, front + 0.45);
    tilt(
      at(
        P("drum", 0.7, 0.7, 0.34, M.brass, { seg: 12, open: true }),
        0,
        lockY + 0.95,
        front + 0.45
      ),
      Math.PI / 2
    );
    at(P("box", 0.26, 0.5, 0.18, M.darkSlate), 0, lockY - 0.1, front + 0.68);

    at(P("roofParapet", w * 0.94, d * 0.9, M.concrete), 0, plinth + bodyH, 0);
    at(
      P("signBand", w * 0.56, 0.42, color),
      0,
      plinth + bodyH + 0.5,
      front + 0.3
    );
    noShadow(
      at(P("box", 0.35, 0.35, 0.2, M.brass), w * 0.3, plinth + 1.6, front + 0.4)
    );
  },

  "apps-tally"({ g, w, h, d, color, kit, plainMat }) {
    const M = palette(kit, plainMat);
    const P = (n, ...a) => mk(g, kit, n, a);
    const plinth = 0.4;
    const bodyH = h * 0.76;
    const bodyY = plinth + bodyH / 2;
    const front = d * 0.43;

    at(P("box", w, plinth, d, M.concrete), 0, plinth / 2, 0);
    at(P("box", w * 0.9, bodyH, d * 0.86, M.plaster), 0, bodyY, 0);
    at(
      P("masonryBands", w * 0.92, bodyH * 0.98, d * 0.88, M.bone),
      0,
      bodyY,
      0
    );

    const rods = 4;
    const counts = [3, 2, 4, 1];
    const rodW = w * 0.7;
    for (let i = 0; i < rods; i += 1) {
      const y = plinth + bodyH * (0.2 + i * 0.2);
      at(P("box", rodW, 0.1, 0.1, M.brass), 0, y, front + 0.24);
      const n = counts[i];
      for (let b = 0; b < n; b += 1) {
        const x = -rodW / 2 + 0.6 + b * 0.62 + i * 0.18;
        at(P("box", 0.46, 0.46, 0.42, M.timber), x, y, front + 0.24);
      }
    }

    at(
      P("roofGable", w * 0.9, d * 0.86, h * 0.5, M.terracotta),
      0,
      plinth + bodyH,
      0
    );
    at(P("box", w * 0.22, 1.9, 0.22, M.glass), 0, plinth + 0.95, front + 0.2);
    at(
      P("signBand", w * 0.4, 0.36, color),
      0,
      plinth + bodyH - 0.4,
      front + 0.3
    );
  },

  "apps-people"({ g, w, h, d, color, kit, plainMat }) {
    const M = palette(kit, plainMat);
    const P = (n, ...a) => mk(g, kit, n, a);
    const plinth = 0.35;
    const bayW = w / 3;
    const front = d * 0.4;
    const bodies = [M.bone, M.plaster, M.concrete];
    const heights = [h * 0.72, h * 0.95, h * 0.84];

    at(P("box", w, plinth, d * 0.95, M.darkSlate), 0, plinth / 2, 0);

    for (let i = 0; i < 3; i += 1) {
      const x = -bayW + i * bayW;
      const bh = heights[i];
      at(P("box", bayW * 0.94, bh, d * 0.8, bodies[i]), x, plinth + bh / 2, 0);
      at(
        P("punchedWindows", bayW * 0.94, bh * 0.8, 0.24, 2, 2, M.bone),
        x,
        plinth + bh * 0.52,
        front + 0.14
      );

      if (i === 0)
        at(
          P("roofHipped", bayW * 0.94, d * 0.8, 1.5, M.slate),
          x,
          plinth + bh,
          0
        );
      else if (i === 1)
        at(
          P("roofMansard", bayW * 0.94, d * 0.8, 1.8, M.slate),
          x,
          plinth + bh,
          0
        );
      else
        at(
          P("roofBarrel", bayW * 0.94, d * 0.8, 1.2, M.copper),
          x,
          plinth + bh,
          0
        );

      at(P("steps", bayW * 0.42, 1, 3, M.concrete), x, 0, front + 0.6);
      at(
        P("box", bayW * 0.3, 1.5, 0.18, M.timber),
        x,
        plinth + 0.95,
        front + 0.12
      );
    }

    at(
      P("signBand", bayW * 0.7, 0.34, color),
      0,
      plinth + heights[1] - 0.5,
      front + 0.24
    );
    at(P("streetlamp", 3.2, M.steel), -w * 0.42, 0, front + 1.6);
  },

  "apps-photos"({ g, w, h, d, color, kit, plainMat }) {
    const M = palette(kit, plainMat);
    const P = (n, ...a) => mk(g, kit, n, a);
    const plinth = 0.4;
    const bodyH = h * 0.64;
    const front = d * 0.45;

    at(P("box", w, plinth, d, M.concrete), 0, plinth / 2, 0);
    at(P("box", w * 0.92, bodyH, d * 0.9, M.bone), 0, plinth + bodyH / 2, 0);

    at(
      P("roofSawtooth", w * 0.92, d * 0.9, h * 0.42, 4, M.slate),
      0,
      plinth + bodyH,
      0
    );

    at(
      P("curtainWall", w * 0.78, bodyH * 0.72, 0.3, M.glass, {
        faces: "front",
      }),
      0,
      plinth + bodyH * 0.44,
      front + 0.16
    );
    at(
      P("plaqueWall", w * 0.7, bodyH * 0.6, 4, 3, M.steel),
      0,
      plinth + bodyH * 0.44,
      front + 0.3
    );

    at(
      P("signBand", w * 0.45, 0.34, color),
      0,
      plinth + bodyH + 0.35,
      front + 0.2
    );
    at(P("planter", 0.9, M.concrete), -w * 0.4, 0, front + 1.2);
  },

  "apps-agenda"({ g, w, h, d, color, kit, plainMat, beacon }) {
    const M = palette(kit, plainMat);
    const P = (n, ...a) => mk(g, kit, n, a);
    const plinth = 0.45;
    const bodyH = h * 0.7;
    const front = d * 0.43;

    at(P("box", w, plinth, d, M.darkSlate), 0, plinth / 2, 0);
    at(P("box", w * 0.9, bodyH, d * 0.85, M.plaster), 0, plinth + bodyH / 2, 0);

    at(
      P("punchedWindows", w * 0.86, bodyH * 0.8, 0.28, 7, 5, M.bone),
      0,
      plinth + bodyH * 0.52,
      front + 0.14
    );
    at(
      P("roofStepped", w * 0.9, d * 0.85, h * 0.24, 3, M.concrete),
      0,
      plinth + bodyH,
      0
    );

    const cw = 1.9;
    const cx = w * 0.36;
    const cz = -d * 0.3;
    const campH = h * 1.05;
    at(P("box", cw, campH, cw, M.bone), cx, plinth + campH / 2, cz);
    at(
      P("arcade", 1, cw * 0.8, 1.5, 0.3, M.bone),
      cx,
      plinth + campH - 1.9,
      cz + cw * 0.5
    );
    at(
      P("box", cw * 1.25, 0.28, cw * 1.25, M.brass),
      cx,
      plinth + campH + 0.14,
      cz
    );
    at(P("roofDomeRibbed", cw * 0.7, M.copper), cx, plinth + campH + 0.28, cz);
    at(P("flagpole", 2, M.brass), cx, plinth + campH + 1.5, cz);

    at(
      P("signBand", w * 0.5, 0.38, color),
      0,
      plinth + bodyH + h * 0.28,
      front + 0.2
    );
    if (typeof beacon === "function")
      beacon(cx, plinth + campH + 2.4, cz, color, 0.28);
  },

  "apps-crane"({ g, w, h, d, color, kit, THREE, animated, plainMat, beacon }) {
    const M = palette(kit, plainMat);
    const P = (n, ...a) => mk(g, kit, n, a);

    at(P("box", w * 0.95, 0.7, d * 0.95, M.darkSlate), 0, 0.35, 0);
    at(P("box", w * 0.5, 0.5, d * 0.5, M.concrete), 0, 0.95, 0);
    at(P("crateStack", 2.4, 1.8, 2, M.timber), -w * 0.42, 0.7, d * 0.34);
    at(P("truss", w * 0.9, 1, M.steel, { segments: 5 }), 0, 3.4, -d * 0.42);
    at(P("latticeMast", 3.6, 1.2, M.steel), w * 0.4, 0.7, -d * 0.4);
    at(P("signBand", w * 0.6, 0.4, color), 0, 1.4, d * 0.48);

    const rot = new THREE.Group();
    rot.position.y = 1.2;
    g.add(rot);
    const R = (n, ...a) => mk(rot, kit, n, a);

    const mastH = h * 0.94;
    at(R("latticeMast", mastH, 1.5, M.steel), 0, 0, 0);

    const jibLen = Math.max(w * 1.7, 14);
    at(
      R("truss", jibLen, 0.9, M.steel, { segments: 9 }),
      jibLen / 2 - 2,
      mastH,
      0
    );
    at(R("truss", 5.2, 0.7, M.steel, { segments: 3 }), -3.6, mastH, 0);
    at(R("box", 2.4, 1.7, 2, M.darkSlate), -4.9, mastH - 0.2, 0);
    at(R("box", 1.5, 1.3, 1.5, M.bone), 1.4, mastH - 1, 0);
    at(R("box", 0.35, 2.4, 0.35, M.steel), 0, mastH + 1.2, 0);

    const hookDrop = h * 0.5;
    const trolleyX = jibLen - 4;
    at(R("box", 1.2, 0.6, 1.2, M.steel), trolleyX, mastH - 0.6, 0);
    at(
      R("box", 0.12, hookDrop, 0.12, M.darkSlate),
      trolleyX,
      mastH - hookDrop / 2,
      0
    );
    const hook = at(
      R("box", 1.1, 0.9, 1.1, M.steel),
      trolleyX,
      mastH - hookDrop,
      0
    );

    noShadow(rot);
    if (typeof beacon === "function") beacon(0, h + 1.2, 0, "#e5484d", 0.4);

    animated.push({ type: "crane", obj: rot, hook, hookBase: h });
  },

  "automation-clock"({ g, w, h, color, kit, plainMat, beacon }) {
    const M = palette(kit, plainMat);
    const P = (n, ...a) => mk(g, kit, n, a);

    const baseW = w * 0.72;
    const shaftW = w * 0.44;
    const plinth = 0.9;

    at(P("box", baseW, plinth, baseW, M.concrete), 0, plinth / 2, 0);
    at(P("steps", shaftW * 1.1, 0.9, 3, M.concrete), 0, 0, baseW * 0.5 + 0.5);
    at(
      P("box", shaftW * 1.24, 0.7, shaftW * 1.24, M.bone),
      0,
      plinth + 0.35,
      0
    );

    const shaftH = h * 0.55;
    const shaftY = plinth + 0.7 + shaftH / 2;
    at(P("box", shaftW, shaftH, shaftW, M.terracotta), 0, shaftY, 0);
    at(
      P("masonryBands", shaftW * 1.01, shaftH * 0.98, shaftW * 1.01, M.bone),
      0,
      shaftY,
      0
    );
    const halfS = shaftW * 0.5;
    at(
      P("ribbedFacade", shaftW, shaftH * 0.96, 0.22, 3, M.bone),
      0,
      shaftY,
      halfS + 0.1
    );
    at(
      P("ribbedFacade", shaftW, shaftH * 0.96, 0.22, 3, M.bone),
      0,
      shaftY,
      -halfS - 0.1,
      Math.PI
    );
    at(
      P("ribbedFacade", shaftW, shaftH * 0.96, 0.22, 3, M.bone),
      halfS + 0.1,
      shaftY,
      0,
      Math.PI / 2
    );
    at(
      P("ribbedFacade", shaftW, shaftH * 0.96, 0.22, 3, M.bone),
      -halfS - 0.1,
      shaftY,
      0,
      -Math.PI / 2
    );
    noShadow(
      at(
        P("box", shaftW * 0.16, shaftH * 0.5, 0.14, M.glass),
        0,
        shaftY,
        halfS + 0.2
      )
    );

    const shaftTop = plinth + 0.7 + shaftH;
    const belW = shaftW * 1.2;
    const belH = h * 0.19;
    const belY = shaftTop + belH / 2;
    at(P("box", belW, belH, belW, M.bone), 0, belY, 0);
    const halfB = belW * 0.5;
    at(
      P("arcade", 2, belW * 0.86, belH * 0.8, 0.3, M.bone),
      0,
      shaftTop,
      halfB + 0.02
    );
    at(
      P("arcade", 2, belW * 0.86, belH * 0.8, 0.3, M.bone),
      0,
      shaftTop,
      -halfB - 0.02,
      Math.PI
    );
    at(
      P("arcade", 2, belW * 0.86, belH * 0.8, 0.3, M.bone),
      halfB + 0.02,
      shaftTop,
      0,
      Math.PI / 2
    );
    at(
      P("arcade", 2, belW * 0.86, belH * 0.8, 0.3, M.bone),
      -halfB - 0.02,
      shaftTop,
      0,
      -Math.PI / 2
    );
    at(P("drum", 0.34, 0.62, 0.9, M.brass, { seg: 12 }), 0, belY + 0.1, 0);

    const belTop = shaftTop + belH;
    at(P("box", belW * 1.18, 0.32, belW * 1.18, M.brass), 0, belTop + 0.16, 0);

    const clkW = belW * 0.94;
    const clkH = h * 0.2;
    const clkY = belTop + 0.32 + clkH / 2;
    at(P("box", clkW, clkH, clkW, M.bone), 0, clkY, 0);
    const faceR = Math.min(clkW, clkH) * 0.4;
    const off = clkW * 0.5 + 0.06;
    at(P("clockFace", faceR, M.bone, color), 0, clkY, off);
    at(P("clockFace", faceR, M.bone, color), 0, clkY, -off, Math.PI);
    at(P("clockFace", faceR, M.bone, color), off, clkY, 0, Math.PI / 2);
    at(P("clockFace", faceR, M.bone, color), -off, clkY, 0, -Math.PI / 2);

    const clkTop = belTop + 0.32 + clkH;
    at(P("box", clkW * 1.12, 0.24, clkW * 1.12, M.copper), 0, clkTop + 0.12, 0);
    at(
      P("roofPyramid", clkW * 1.12, clkW * 1.12, h * 0.22, M.copper),
      0,
      clkTop + 0.24,
      0
    );
    const apex = clkTop + 0.24 + h * 0.22;
    at(P("weathervane", 1.6, M.brass), 0, apex, 0);
    if (typeof beacon === "function") beacon(0, apex + 0.5, 0, color, 0.26);

    at(
      P("signBand", shaftW * 1.1, 0.4, color),
      0,
      plinth + 1.4,
      shaftW * 0.62 + 0.24
    );
  },

  "automation-shed1"({ g, w, h, d, color, kit, plainMat, beacon }) {
    const M = palette(kit, plainMat);
    const P = (n, ...a) => mk(g, kit, n, a);

    at(P("box", w * 1.25, 0.24, 2.6, M.darkSlate), 0, 0.12, d * 0.34);
    at(P("box", w * 1.3, 0.16, 0.28, M.steel), 0, 0.3, d * 0.34 - 0.7);
    at(P("box", w * 1.3, 0.16, 0.28, M.steel), 0, 0.3, d * 0.34 + 0.7);

    const hutW = w * 0.52;
    const hutD = d * 0.5;
    const hutH = h * 0.66;
    const hx = -w * 0.18;
    at(P("box", hutW * 1.12, 0.4, hutD * 1.12, M.concrete), hx, 0.2, -d * 0.22);
    at(P("box", hutW, hutH, hutD, M.timber), hx, 0.4 + hutH / 2, -d * 0.22);
    at(
      P("punchedWindows", hutW, hutH * 0.7, 0.2, 3, 1, M.plaster),
      hx,
      0.4 + hutH * 0.6,
      -d * 0.22 + hutD * 0.5 + 0.1
    );
    at(
      P("roofGable", hutW * 1.14, hutD * 1.14, 1.2, M.slate),
      hx,
      0.4 + hutH,
      -d * 0.22
    );
    at(
      P("chimney", 0.22, 1.3, M.terracotta),
      hx + hutW * 0.3,
      0.4 + hutH + 0.6,
      -d * 0.22
    );

    const frameZ = -d * 0.22 + hutD * 0.5 + 0.55;
    at(P("box", hutW * 0.9, 0.28, 0.5, M.darkSlate), hx, 0.62, frameZ);
    for (let i = 0; i < 5; i += 1) {
      const lx = hx - hutW * 0.32 + i * (hutW * 0.16);
      tilt(
        at(P("box", 0.12, 1.1, 0.12, M.brass), lx, 1.3, frameZ),
        -0.22 + i * 0.09,
        0
      );
    }

    const sx = w * 0.36;
    at(P("mast", h * 1.2, M.steel), sx, 0.2, d * 0.1);
    tilt(
      at(P("box", 2.2, 0.3, 0.14, M.terracotta), sx + 1, h * 1.02, d * 0.1),
      0,
      -0.34
    );
    at(P("box", 0.5, 0.5, 0.16, M.darkSlate), sx, h * 0.78, d * 0.1 + 0.1);
    if (typeof beacon === "function")
      beacon(sx + 1.9, h * 0.98, d * 0.1, color, 0.24);

    at(
      P("signBand", hutW * 0.8, 0.32, color),
      hx,
      0.4 + hutH - 0.3,
      -d * 0.22 + hutD * 0.5 + 0.16
    );
  },

  "automation-line"({ g, w, h, d, color, kit, plainMat }) {
    const M = palette(kit, plainMat);
    const P = (n, ...a) => mk(g, kit, n, a);
    const plinth = 0.4;
    const bodyH = h * 0.6;
    const front = d * 0.45;

    at(P("box", w, plinth, d, M.concrete), 0, plinth / 2, 0);
    at(P("box", w * 0.96, bodyH, d * 0.9, M.bone), 0, plinth + bodyH / 2, 0);

    at(
      P("roofSawtooth", w * 0.96, d * 0.9, h * 0.38, 7, M.slate),
      0,
      plinth + bodyH,
      0
    );

    at(
      P("curtainWall", w * 0.88, bodyH * 0.34, 0.28, M.glass, {
        faces: "front",
      }),
      0,
      plinth + bodyH * 0.62,
      front + 0.14
    );
    at(
      P("masonryBands", w * 0.97, bodyH * 0.4, d * 0.91, M.concrete),
      0,
      plinth + bodyH * 0.2,
      0
    );

    at(P("gantry", w * 0.78, h * 1.05, M.steel), 0, 0, front + 2.6);
    at(P("box", w * 0.8, 0.2, 0.4, M.darkSlate), 0, 0.1, front + 2);
    at(P("box", w * 0.8, 0.2, 0.4, M.darkSlate), 0, 0.1, front + 3.2);

    at(
      P("box", w * 0.34, 0.35, 3, M.steel),
      w * 0.26,
      plinth + bodyH * 0.72,
      front + 1.4
    );
    at(
      P("box", 0.26, bodyH * 0.72, 0.26, M.steel),
      w * 0.26 - w * 0.15,
      plinth + bodyH * 0.36,
      front + 2.7
    );
    at(
      P("box", 0.26, bodyH * 0.72, 0.26, M.steel),
      w * 0.26 + w * 0.15,
      plinth + bodyH * 0.36,
      front + 2.7
    );
    at(
      P("box", w * 0.3, bodyH * 0.6, 0.3, M.rubber),
      w * 0.26,
      plinth + bodyH * 0.3,
      front + 0.2
    );
    at(P("crateStack", 2.2, 1.6, 1.8, M.timber), -w * 0.3, 0, front + 2.2);

    at(
      P("signBand", w * 0.5, 0.42, color),
      -w * 0.18,
      plinth + bodyH + 0.4,
      front + 0.2
    );
    at(P("activityLamp", color), w * 0.42, plinth + bodyH * 0.9, front + 0.3);
  },

  "automation-scheduler"({ g, w, h, d, color, kit, plainMat }) {
    const M = palette(kit, plainMat);
    const P = (n, ...a) => mk(g, kit, n, a);
    const bodyH = h * 0.85;
    const front = d * 0.4;

    at(P("box", w * 1.02, 0.3, d * 1.02, M.darkSlate), 0, 0.15, 0);
    at(P("box", w * 0.9, bodyH, d * 0.8, M.concrete), 0, 0.3 + bodyH / 2, 0);
    at(P("roofParapet", w * 0.9, d * 0.8, M.slate), 0, 0.3 + bodyH, 0);
    at(
      P("punchedWindows", w * 0.9, bodyH * 0.6, 0.22, 5, 1, M.bone),
      0,
      0.3 + bodyH * 0.5,
      front + 0.12
    );

    const boardH = h * 1.5;
    const boardY = 0.3 + bodyH + boardH * 0.5;
    at(
      P("truss", w * 0.86, 0.5, M.steel, { segments: 6 }),
      0,
      0.3 + bodyH + 0.25,
      front + 0.5
    );
    at(
      P("splitFlapBoard", w * 0.86, boardH, M.darkSlate, color),
      0,
      boardY,
      front + 0.62
    );
    at(P("box", 0.24, boardH, 0.24, M.steel), -w * 0.42, boardY, front + 0.4);
    at(P("box", 0.24, boardH, 0.24, M.steel), w * 0.42, boardY, front + 0.4);
    at(
      P("box", w * 0.9, 0.24, 0.5, M.brass),
      0,
      boardY + boardH * 0.5 + 0.12,
      front + 0.6
    );

    at(
      P(
        "bollards",
        [
          [-w * 0.35, front + 1.6],
          [0, front + 1.6],
          [w * 0.35, front + 1.6],
        ],
        M.steel
      ),
      0,
      0,
      0
    );
    at(P("signBand", w * 0.4, 0.3, color), 0, 0.3 + bodyH * 0.2, front + 0.16);
  },

  "cas-containers"({ g, w, h, d, color, kit, plainMat }) {
    const M = palette(kit, plainMat);
    const P = (n, ...a) => mk(g, kit, n, a);
    const pad = 0.3;
    const cw = 3;
    const ch = 2.1;
    const cd = 2.5;

    at(P("box", w * 1.08, pad, d * 1.08, M.darkSlate), 0, pad / 2, 0);

    const rows = [[-3, 0.2, 3.1], [-1.6, 1.8], [0.3]];
    let hue = 0;
    for (let r = 0; r < rows.length; r += 1) {
      const y = pad + ch * 0.5 + r * (ch + 0.06);
      const z = -1.4 + r * 0.9;
      for (let i = 0; i < rows[r].length; i += 1) {
        const c = mk(g, kit, "container", [
          cw,
          ch,
          cd,
          CRATE_HUES[hue % CRATE_HUES.length],
        ]);
        at(c, rows[r][i], y, z + (i % 2 === 0 ? 0 : 0.35));
        hue += 1;
      }
    }

    at(P("gantry", w * 1.05, h * 1.08, M.steel), 0, 0, 2.9);
    at(P("box", w * 1.1, 0.18, 0.36, M.steel), 0, 0.24, 2.3);
    at(P("box", w * 1.1, 0.18, 0.36, M.steel), 0, 0.24, 3.5);
    at(
      P("signBand", w * 0.5, 0.36, color),
      0,
      pad + ch * 0.5,
      -1.4 - cd * 0.5 - 0.1,
      Math.PI
    );
    at(P("crateStack", 1.8, 1.2, 1.6, M.timber), w * 0.44, pad, 2.6);
  },

  "cas-press"({ g, w, h, d, color, kit, plainMat }) {
    const M = palette(kit, plainMat);
    const P = (n, ...a) => mk(g, kit, n, a);
    const baseH = h * 0.58;
    const upperH = h * 0.34;
    const front = d * 0.45;

    at(P("box", w * 1.05, 0.35, d * 1.05, M.darkSlate), 0, 0.17, 0);
    at(P("box", w * 0.9, baseH, d * 0.85, M.darkSlate), 0, 0.35 + baseH / 2, 0);
    at(
      P("box", w * 0.68, upperH, d * 0.66, M.concrete),
      0,
      0.35 + baseH + upperH / 2,
      0
    );
    at(
      P("roofBarrel", w * 0.68, d * 0.66, 1, M.steel),
      0,
      0.35 + baseH + upperH,
      0
    );

    for (let i = 0; i < 3; i += 1) {
      at(
        P("drum", w * 0.47, w * 0.47, 0.3, M.brass, { seg: 16, open: true }),
        0,
        0.6 + i * (baseH * 0.3),
        0
      );
    }

    const ramY = 0.35 + baseH + 1.2;
    at(P("box", 2.8, 0.5, 1.4, M.steel), 0, 0.35 + baseH * 0.62, front + 0.85);
    at(P("piston", 2.6, 0.62, M.steel), 0, ramY, front + 0.85);
    at(P("box", 2.4, 0.6, 1.6, M.darkSlate), 0, ramY + 1.6, front + 0.85);
    at(P("box", 0.4, 1.4, 0.4, M.steel), -1.3, ramY + 0.6, front + 0.85);
    at(P("box", 0.4, 1.4, 0.4, M.steel), 1.3, ramY + 0.6, front + 0.85);

    at(
      P("gaugeBoard", 2.2, 1.3, M.slate, color),
      -w * 0.26,
      0.35 + baseH * 0.55,
      front + 0.14
    );
    at(
      P(
        "pipeRun",
        [
          [-w * 0.42, 0.9, front],
          [-w * 0.42, baseH + 1.4, front],
          [w * 0.3, baseH + 1.4, front],
        ],
        0.18,
        M.steel
      ),
      0,
      0,
      0
    );
    at(P("vent", 0.4, 0.9, M.steel), w * 0.2, 0.35 + baseH + upperH + 1.1, 0);
    at(
      P("signBand", w * 0.42, 0.3, color),
      w * 0.2,
      0.35 + baseH * 0.55,
      front + 0.14
    );
  },

  "cas-s3crane"({ g, w, h, d, color, kit, THREE, plainMat, beacon }) {
    const M = palette(kit, plainMat);
    const P = (n, ...a) => mk(g, kit, n, a);
    const railZ = d * 0.42;
    const railLen = w * 2.3;

    at(P("box", railLen, 0.2, 0.4, M.steel), 0, 0.12, -railZ);
    at(P("box", railLen, 0.2, 0.4, M.steel), 0, 0.12, railZ);
    for (let i = 0; i < 5; i += 1) {
      at(
        P("box", 0.5, 0.16, railZ * 2.4, M.timber),
        -railLen * 0.4 + i * (railLen * 0.2),
        0.06,
        0
      );
    }

    const portalH = h * 0.86;
    at(P("gantry", railZ * 2.1, portalH, M.steel), 0, 0, -1.7);
    at(P("gantry", railZ * 2.1, portalH, M.steel), 0, 0, 1.7);
    at(
      P("truss", 4.6, 0.8, M.steel, { segments: 4 }),
      0,
      portalH,
      -railZ * 0.94,
      Math.PI / 2
    );
    at(
      P("truss", 4.6, 0.8, M.steel, { segments: 4 }),
      0,
      portalH,
      railZ * 0.94,
      Math.PI / 2
    );
    at(
      P("truss", railZ * 2.1, 0.9, M.steel, { segments: 5 }),
      0,
      portalH + 0.9,
      0,
      Math.PI / 2
    );

    const bogies = [
      [-railZ, -1.7],
      [railZ, -1.7],
      [-railZ, 1.7],
      [railZ, 1.7],
    ];
    for (const bogie of bogies) {
      at(P("box", 1.2, 0.6, 1.6, M.darkSlate), bogie[0], 0.55, bogie[1]);
      tilt(
        at(P("wheel", 0.4, M.steel), bogie[0], 0.38, bogie[1] - 0.5),
        0,
        Math.PI / 2
      );
      tilt(
        at(P("wheel", 0.4, M.steel), bogie[0], 0.38, bogie[1] + 0.5),
        0,
        Math.PI / 2
      );
    }

    at(P("box", 1.6, 0.8, 1.8, M.bone), -railZ * 0.35, portalH + 0.2, 0);
    const load = new THREE.Group();
    load.position.set(-railZ * 0.35, 0, 0);
    g.add(load);
    at(
      mk(load, kit, "box", [0.12, portalH * 0.42, 0.12, M.darkSlate]),
      0,
      portalH - portalH * 0.21,
      0
    );
    at(
      mk(load, kit, "container", [2.6, 1.9, 2.2, CRATE_HUES[2]]),
      0,
      portalH * 0.52,
      0
    );
    invoke(kit, "bob", [load, 0.5, 0.5]);

    at(P("catwalk", railZ * 1.05, portalH + 0.5, M.steel), 0, 0, 0);
    at(
      P("signBand", w * 0.5, 0.36, color),
      0,
      portalH * 0.5,
      -railZ - 0.3,
      Math.PI
    );
    if (typeof beacon === "function") beacon(0, portalH + 1.6, 0, color, 0.3);
  },

  "cas-barge"({ g, w, d, color, kit, plainMat, glowMat, beacon }) {
    const M = palette(kit, plainMat);
    const P = (n, ...a) => mk(g, kit, n, a);

    at(P("hull", w * 1.08, d * 0.82, 2.2, M.darkSlate), 0, 1.3, 0);
    at(P("box", w * 0.98, 0.28, d * 0.68, M.steel), 0, 2.05, 0);
    at(P("masonryBands", w * 1, 0.9, d * 0.7, M.bone), 0, 1.75, 0);

    const spots = [-3.4, -0.4, 2.6];
    for (let i = 0; i < spots.length; i += 1) {
      at(
        mk(g, kit, "container", [2.7, 1.9, 2.2, CRATE_HUES[i]]),
        spots[i],
        3.15,
        0
      );
    }
    at(mk(g, kit, "container", [2.7, 1.9, 2.2, CRATE_HUES[3]]), -0.4, 5.1, 0);

    const wx = -w * 0.4;
    at(P("box", 2.2, 1.9, 2.4, M.bone), wx, 3.15, 0);
    at(P("curtainWall", 2, 0.9, 0.2, M.glass, { faces: "all" }), wx, 3.6, 0);
    at(P("roofHipped", 2.4, 2.6, 0.6, M.slate), wx, 4.1, 0);
    at(P("mast", 2.6, M.steel), wx, 4.7, 0);
    at(
      P(
        "railing",
        [
          [w * 0.5, -d * 0.3],
          [w * 0.5, d * 0.3],
        ],
        2.2,
        M.steel
      ),
      0,
      0,
      0
    );
    at(P("signBand", w * 0.36, 0.32, color), w * 0.24, 1.75, d * 0.36);

    const wake =
      (typeof glowMat === "function" ? glowMat("#a9c7d8", 0.22) : M.glass) ||
      M.glass;
    noShadow(at(P("box", 6, 0.06, 0.5, wake), -w * 0.72 - 3, 0.5, -0.9));
    noShadow(at(P("box", 4.6, 0.06, 0.5, wake), -w * 0.72 - 2.3, 0.5, 0.9));
    if (typeof beacon === "function") beacon(wx, 7.3, 0, color, 0.26);
  },

  "sync-lighthouse"({
    g,
    w,
    h,
    d,
    color,
    kit,
    THREE,
    plainMat,
    glowMat,
    beacon,
  }) {
    const M = palette(kit, plainMat);
    const P = (n, ...a) => mk(g, kit, n, a);

    at(P("drum", w * 0.52, w * 0.66, 1.2, M.darkSlate, { seg: 12 }), 0, 0.6, 0);
    at(P("steps", 2, 1.2, 3, M.concrete), 0, 0, d * 0.4);

    const towerH = h * 0.74;
    const towerY = 1.2 + towerH / 2;
    at(P("wedge", w * 0.5, towerH, d * 0.5, M.bone), 0, towerY, 0);
    at(
      P("masonryBands", w * 0.44, towerH * 0.9, d * 0.44, M.terracotta),
      0,
      towerY,
      0
    );
    at(
      P("punchedWindows", w * 0.4, towerH * 0.7, 0.2, 1, 3, M.bone),
      0,
      towerY,
      d * 0.22
    );

    const galY = 1.2 + towerH;
    at(P("catwalk", w * 0.34, galY, M.steel), 0, 0, 0);
    at(
      P("drum", w * 0.3, w * 0.3, 0.3, M.brass, { seg: 12 }),
      0,
      galY - 0.1,
      0
    );

    const lantH = h * 0.2;
    const lantY = galY + lantH / 2;
    at(P("drum", w * 0.2, w * 0.22, lantH, M.glass, { seg: 12 }), 0, lantY, 0);
    const lamp = new THREE.Group();
    lamp.position.set(0, lantY, 0);
    g.add(lamp);
    const beamMat =
      (typeof glowMat === "function" ? glowMat(color, 0.18) : M.glass) ||
      M.glass;
    noShadow(at(mk(lamp, kit, "box", [16, 0.5, 1.4, beamMat]), 8, 0, 0));
    invoke(kit, "spin", [lamp, 0.55]);

    at(P("roofCone", w * 0.24, h * 0.14, M.copper), 0, galY + lantH, 0);
    const apex = galY + lantH + h * 0.14;
    at(P("aerial", 1.4, M.steel), 0, apex, 0);
    if (typeof beacon === "function") beacon(0, apex + 0.6, 0, color, 0.34);
    at(P("signBand", w * 0.4, 0.3, color), 0, 1.6, w * 0.3);
  },

  "sync-bridge"({ g, w, h, d, color, kit, plainMat, glowMat }) {
    const M = palette(kit, plainMat);
    const P = (n, ...a) => mk(g, kit, n, a);
    const len = Math.max(w, 20);
    const deckY = h * 0.72;
    const deckD = Math.max(d * 0.6, 3.5);

    at(P("box", len * 1.1, 0.7, deckD, M.concrete), 0, deckY, 0);
    at(
      P("box", len * 1.1, 0.22, 0.3, M.steel),
      0,
      deckY + 0.45,
      -deckD * 0.5 + 0.15
    );
    at(
      P("box", len * 1.1, 0.22, 0.3, M.steel),
      0,
      deckY + 0.45,
      deckD * 0.5 - 0.15
    );
    const seamMat =
      (typeof glowMat === "function" ? glowMat(color, 0.3) : M.glass) ||
      M.glass;
    noShadow(at(P("box", len * 1.02, 0.05, 0.28, seamMat), 0, deckY + 0.38, 0));

    const pylonX = [-len * 0.26, len * 0.26];
    const pylonH = h * 2.1;
    for (const px of pylonX) {
      at(P("box", 1.8, deckY, 1.8, M.concrete), px, deckY / 2, 0);
      tilt(
        at(
          P("box", 0.55, pylonH, 0.55, M.bone),
          px,
          deckY + pylonH * 0.5,
          -deckD * 0.42
        ),
        0.13,
        0
      );
      tilt(
        at(
          P("box", 0.55, pylonH, 0.55, M.bone),
          px,
          deckY + pylonH * 0.5,
          deckD * 0.42
        ),
        -0.13,
        0
      );
      const topY = deckY + pylonH;
      at(P("box", 0.7, 0.8, deckD * 0.5, M.bone), px, topY, 0);
      at(
        P("box", 0.5, 0.4, deckD * 0.8, M.brass),
        px,
        deckY + pylonH * 0.55,
        0
      );

      for (let s = 0; s < 3; s += 1) {
        for (let dir = -1; dir <= 1; dir += 2) {
          const dx = dir * (len * 0.09 + s * len * 0.07);
          const dy = topY - 0.6 - deckY - 0.4;
          const l = Math.hypot(dx, dy);
          const c = at(
            P("box", 0.11, l, 0.11, M.steel),
            px + dx / 2,
            deckY + 0.4 + dy / 2,
            0
          );
          tilt(c, 0, Math.atan2(dx, dy));
        }
      }
    }

    at(P("signBand", 3, 0.32, color), 0, deckY - 0.6, deckD * 0.5 + 0.1);
  },

  "sync-island"({ g, w, d, color, kit, plainMat, beacon }) {
    const M = palette(kit, plainMat);
    const P = (n, ...a) => mk(g, kit, n, a);
    const legH = 3;

    at(P("drum", w * 0.6, w * 0.7, 0.5, M.darkSlate, { seg: 12 }), 0, 0.25, 0);
    at(P("pilotis", w * 0.72, d * 0.72, legH, M.timber), 0, 0.5, 0);
    at(P("box", w * 0.88, 0.3, d * 0.88, M.timber), 0, 0.5 + legH + 0.15, 0);
    const deckY = 0.5 + legH + 0.3;

    const cabW = w * 0.52;
    const cabH = 2.1;
    at(
      P("box", cabW, cabH, d * 0.52, M.plaster),
      -w * 0.08,
      deckY + cabH / 2,
      0
    );
    at(
      P("punchedWindows", cabW, cabH * 0.7, 0.2, 2, 1, M.bone),
      -w * 0.08,
      deckY + cabH * 0.55,
      d * 0.27
    );
    at(
      P("roofParapet", cabW * 1.1, d * 0.56, M.steel),
      -w * 0.08,
      deckY + cabH,
      0
    );

    const dsh = at(P("dish", 1.5, M.bone), w * 0.26, deckY + 1.5, -d * 0.1);
    tilt(dsh, -0.5, 0);
    if (dsh && dsh.isObject3D) dsh.rotation.y = 0.9;
    at(P("box", 0.28, 1.4, 0.28, M.steel), w * 0.26, deckY + 0.7, -d * 0.1);

    at(
      P(
        "railing",
        [
          [-w * 0.42, -d * 0.42],
          [w * 0.42, -d * 0.42],
          [w * 0.42, d * 0.42],
          [-w * 0.42, d * 0.42],
        ],
        deckY,
        M.steel
      ),
      0,
      0,
      0
    );
    at(P("stairFlight", 1.2, deckY, 2.4, M.timber), 0, 0, d * 0.5);
    at(P("mast", 3.4, M.steel), -w * 0.34, deckY, -d * 0.3);
    at(
      P("signBand", w * 0.4, 0.28, color),
      -w * 0.08,
      deckY + cabH - 0.3,
      d * 0.29
    );
    if (typeof beacon === "function")
      beacon(-w * 0.34, deckY + 3.6, -d * 0.3, color, 0.26);
  },

  "sync-island2"({ g, w, h, d, color, kit, plainMat, beacon }) {
    const M = palette(kit, plainMat);
    const P = (n, ...a) => mk(g, kit, n, a);
    const pad = 0.35;

    at(P("drum", w * 0.58, w * 0.66, 0.4, M.darkSlate, { seg: 12 }), 0, 0.2, 0);
    at(P("box", w * 0.9, pad, d * 0.9, M.concrete), 0, 0.4 + pad / 2, 0);
    const deckY = 0.4 + pad;

    at(
      P("roofGable", w * 0.62, d * 0.78, h * 1.25, M.timber),
      -w * 0.1,
      deckY,
      0
    );
    at(
      P("curtainWall", w * 0.34, 1.5, 0.2, M.glass, { faces: "front" }),
      -w * 0.1,
      deckY + 0.8,
      d * 0.39
    );
    at(P("box", w * 0.62, 0.2, 0.3, M.brass), -w * 0.1, deckY + 0.05, d * 0.39);

    tilt(
      at(P("solarArray", 2.4, 1.8, M.slate), w * 0.32, deckY + 0.9, d * 0.1),
      -0.5,
      0
    );
    at(P("box", 0.22, 1, 0.22, M.steel), w * 0.32, deckY + 0.5, d * 0.1);
    at(P("mast", h * 1.5, M.steel), w * 0.3, deckY, -d * 0.32);
    at(P("crateStack", 1.4, 1, 1.2, M.timber), w * 0.2, deckY, d * 0.42);
    at(P("signBand", w * 0.3, 0.26, color), -w * 0.1, deckY + 2.4, d * 0.4);
    if (typeof beacon === "function")
      beacon(w * 0.3, deckY + h * 1.6, -d * 0.32, color, 0.24);
  },
};
