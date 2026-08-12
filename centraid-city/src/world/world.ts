// world.ts — scene construction: sky, ground, district plates, building silhouettes,
// particle flows. ALL geometry (plate rects, building positions/sizes/kinds/colors) comes
// from core/content.ts; this module only knows how to render it.
// governance: allow-repo-hygiene file-size-limit — scene build, flow system, and the
// animation registry share the THREE material/instancing state they allocate. Splitting
// them means exporting that state; tracked for the TypeScript conversion in #704.

import * as THREE from "three";

import type {
  AnimationRecord,
  BuildingBuildContext,
  CityBuilding,
  CityContent,
  FlowRuntime,
  KitOptions,
  Palette,
  Sim,
  WorldApi,
  WorldDistrict,
} from "../core/types.js";
import { makeKit } from "./kit.js";
import { LANDMARKS } from "./landmarks.js";

/* ------------------------------------------------------------------ textures */

function canvas2d(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return { c, g: c.getContext("2d") };
}

// Facade windows. Bottom 8% of the texture is deliberately blank so roof/floor faces
// can be UV-mapped into it (no windows on rooftops).
function makeWindowTexture() {
  const W = 256;
  const H = 512;
  const { c, g } = canvas2d(W, H);
  g.fillStyle = "#000000";
  g.fillRect(0, 0, W, H);
  const cols = 6;
  const rows = 12;
  const blank = H * 0.08;
  const usable = H - blank;
  const cw = W / cols;
  const rh = usable / rows;
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < cols; i++) {
      const lit = (r * 7 + i * 3 + ((r * i) % 5)) % 11 > 3;
      if (!lit) continue;
      const warm = (r + i) % 4 === 0;
      const a = 0.55 + (((r * 5 + i * 11) % 7) / 7) * 0.45;
      g.fillStyle = warm ? `rgba(255,214,150,${a})` : `rgba(196,232,255,${a})`;
      const x = i * cw + cw * 0.22;
      const y = blank + r * rh + rh * 0.22;
      g.fillRect(x, y, cw * 0.56, rh * 0.5);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

// Blueprint-paper ground: a fine grid, one tile == GROUND_TILE_UNITS world units square,
// with a faint sub-grid inside so it reads as elegant drafting paper rather than graph paper.
const GROUND_TILE_UNITS = 4;
function makeGroundTexture() {
  const S = 512;
  const { c, g } = canvas2d(S, S);
  g.fillStyle = "#e9eef4";
  g.fillRect(0, 0, S, S);
  // very faint paper mottling so it isn't a flat void
  g.fillStyle = "rgba(150,168,190,.05)";
  for (let i = 0; i < 24; i++) {
    const rx = Math.random() * S;
    const ry = Math.random() * S;
    const rr = 30 + Math.random() * 70;
    g.beginPath();
    g.arc(rx, ry, rr, 0, Math.PI * 2);
    g.fill();
  }
  // sub-grid: quarters of the tile (≈1 world unit), barely-there
  g.strokeStyle = "rgba(96,122,152,.10)";
  g.lineWidth = 1;
  const subs = 4;
  for (let i = 1; i < subs; i++) {
    const p = Math.round((i * S) / subs) + 0.5;
    g.beginPath();
    g.moveTo(p, 0);
    g.lineTo(p, S);
    g.moveTo(0, p);
    g.lineTo(S, p);
    g.stroke();
  }
  // major grid: tile edges (≈GROUND_TILE_UNITS world units), a touch darker than the base
  g.strokeStyle = "rgba(80,104,134,.28)";
  g.lineWidth = 1.5;
  g.strokeRect(0.75, 0.75, S - 1.5, S - 1.5);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function makeConveyorTexture() {
  const { c, g } = canvas2d(128, 32);
  g.fillStyle = "#241a08";
  g.fillRect(0, 0, 128, 32);
  g.fillStyle = "rgba(245,166,35,.85)";
  for (let i = 0; i < 8; i++) g.fillRect(i * 16, 6, 8, 20);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 1);
  return t;
}

function makeSkyTexture(night) {
  const W = 512;
  const H = 512;
  const { c, g } = canvas2d(W, H);
  const grad = g.createLinearGradient(0, 0, 0, H);
  if (night) {
    grad.addColorStop(0, "#05070e");
    grad.addColorStop(0.42, "#0a1122");
    grad.addColorStop(0.72, "#122036");
    grad.addColorStop(1, "#1b2c44");
  } else {
    grad.addColorStop(0, "#12325c");
    grad.addColorStop(0.45, "#3d6fa4");
    grad.addColorStop(0.78, "#8fb6d4");
    grad.addColorStop(1, "#cfe0e9");
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  if (night) {
    for (let i = 0; i < 420; i++) {
      const y = Math.random() ** 1.4 * H * 0.62;
      const r = Math.random() < 0.12 ? 1.6 : 0.9;
      g.fillStyle = `rgba(255,255,255,${0.18 + Math.random() * 0.62})`;
      g.beginPath();
      g.arc(Math.random() * W, y, r, 0, Math.PI * 2);
      g.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// A single soft radial blob, reused (scaled + repositioned) for every cloud sprite.
function makeCloudTexture() {
  const S = 128;
  const { c, g } = canvas2d(S, S);
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, "rgba(255,255,255,0.9)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.32)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeLabelTexture(text, color) {
  const pad = 24;
  const { g } = canvas2d(16, 16);
  g.font =
    "600 44px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif";
  const w = Math.ceil(g.measureText(text).width) + pad * 2;
  const h = 96;
  const cv = canvas2d(Math.max(64, w), h);
  const gg = cv.g;
  gg.clearRect(0, 0, cv.c.width, h);
  gg.font =
    "600 44px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif";
  gg.textBaseline = "middle";
  gg.textAlign = "center";
  gg.shadowColor = "rgba(0,0,0,.85)";
  gg.shadowBlur = 12;
  gg.fillStyle = "#ffffff";
  gg.fillText(text, cv.c.width / 2, h * 0.42);
  gg.shadowBlur = 0;
  gg.fillStyle = color;
  gg.fillRect(cv.c.width / 2 - 18, h * 0.78, 36, 4);
  const t = new THREE.CanvasTexture(cv.c);
  t.colorSpace = THREE.SRGBColorSpace;
  return { tex: t, aspect: cv.c.width / h };
}

/* ------------------------------------------------------------------ geometry helpers */

function roundedRectShape(w, d, r) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -d / 2;
  const rr = Math.min(r, w / 2 - 0.01, d / 2 - 0.01);
  s.moveTo(x + rr, y);
  s.lineTo(x + w - rr, y);
  s.quadraticCurveTo(x + w, y, x + w, y + rr);
  s.lineTo(x + w, y + d - rr);
  s.quadraticCurveTo(x + w, y + d, x + w - rr, y + d);
  s.lineTo(x + rr, y + d);
  s.quadraticCurveTo(x, y + d, x, y + d - rr);
  s.lineTo(x, y + rr);
  s.quadraticCurveTo(x, y, x + rr, y);
  return s;
}

// Box UVs so window density is roughly constant in world units, and roof/floor faces
// land in the blank band at the bottom of the window texture.
function facadeUVs(geo, w, h, d) {
  const uv = geo.attributes.uv;
  const U = 2.4; // world units per window column
  const V = 3; // world units per window row
  const cols = 6;
  const rows = 12;
  const set = (i, u, v) => uv.setXY(i, u, v);
  const face = (start, su, sv) => {
    const ru = su / (cols * U);
    const rv = sv / (rows * V);
    const base = 0.08;
    const span = 0.92;
    // BoxGeometry face vertex order: (0,1) (1,1) (0,0) (1,0)
    set(start + 0, 0, base + span * rv);
    set(start + 1, ru, base + span * rv);
    set(start + 2, 0, base);
    set(start + 3, ru, base);
  };
  face(0, d, h); // +x
  face(4, d, h); // -x
  for (let i = 8; i < 16; i++) set(i, 0.5, 0.02); // +y / -y → blank band
  face(16, w, h); // +z
  face(20, w, h); // -z
  uv.needsUpdate = true;
  return geo;
}

function prismGeometry(w, h, d) {
  const hw = w / 2;
  const hd = d / 2;
  const v = [];
  const push = (...pts) => {
    for (const p of pts) v.push(p[0], p[1], p[2]);
  };
  const A = [-hw, 0, hd];
  const B = [hw, 0, hd];
  const C = [0, h, hd];
  const D = [-hw, 0, -hd];
  const E = [hw, 0, -hd];
  const F = [0, h, -hd];
  push(A, B, C); // front
  push(E, D, F); // back
  push(A, C, F, A, F, D); // left slope
  push(C, B, E, C, E, F); // right slope
  push(D, E, B, D, B, A); // bottom
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

// Flat road ribbons on the ground, following the same district-to-district routes as the
// particle flows (see FLOW_PLAN). One merged, indexed, single-material mesh — cheap to draw.
// Duplicate/reverse edges (e.g. clients↔gateway request+response) collapse to a single ribbon.
function buildRoadsMesh(
  flowPlan: Array<[string, string, keyof Palette, string, number]>,
  byId: Map<string, WorldDistrict>,
  roadY: number
): THREE.Mesh | null {
  const HALF_W = 1.15;
  const SEGMENTS = 14;
  const positions = [];
  const normals = [];
  const indices = [];
  const seen = new Set();
  for (const [fromId, toId] of flowPlan) {
    const key = fromId < toId ? `${fromId}|${toId}` : `${toId}|${fromId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const A = byId.get(fromId);
    const B = byId.get(toId);
    if (!A || !B) continue;
    const a = new THREE.Vector3(A.center.x, roadY, A.center.z);
    const b = new THREE.Vector3(B.center.x, roadY, B.center.z);
    const dist = a.distanceTo(b);
    if (dist < 1) continue;
    // same lateral bow the flows use, flattened onto the ground plane
    const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    const perp = new THREE.Vector3(b.z - a.z, 0, -(b.x - a.x))
      .normalize()
      .multiplyScalar(dist * 0.08);
    mid.add(perp);
    mid.y = roadY;
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    const pts = curve.getPoints(SEGMENTS);
    const start = positions.length / 3;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(pts.length - 1, i + 1)];
      let dx = next.x - prev.x;
      let dz = next.z - prev.z;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      const px = -dz * HALF_W;
      const pz = dx * HALF_W;
      positions.push(p.x + px, roadY, p.z + pz, p.x - px, roadY, p.z - pz);
      normals.push(0, 1, 0, 0, 1, 0);
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const i0 = start + i * 2;
      const i1 = i0 + 1;
      const i2 = i0 + 2;
      const i3 = i0 + 3;
      indices.push(i0, i2, i1, i1, i2, i3);
    }
  }
  if (!positions.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color("#c2cddb"),
    roughness: 0.92,
    metalness: 0.02,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.userData.dayColor = new THREE.Color("#c2cddb");
  mesh.userData.nightColor = new THREE.Color("#34445e");
  return mesh;
}

/* ------------------------------------------------------------------ world */

const DEFAULT_PALETTE: Palette = {
  requests: "#39c5ea",
  harness: "#5b7cfa",
  wal: "#f5a623",
  dirty: "#e5484d",
  consent: "#8e4ec6",
  sync: "#30a46c",
  blob: "#8d9aa5",
  automation: "#ad8b00",
};

// Engine-side routing graph. A flow is only created when both districts exist in core/content.ts.
//
// Two independent paths share this graph, and the colors are load-bearing:
//   * the HARNESS path (palette.harness / palette.consent — blue + violet) is OPTIONAL. It only
//     lights up when a turn is actually running a runner.
//   * the DIRECT + SYNC path (palette.requests / palette.wal / palette.sync — cyan, amber,
//     green) is ALWAYS running and never touches the runtime. Multi-device sync lives here:
//     gateway → vault → WAL → harbor → device, and back. Do not paint any leg of it 'harness'.
const FLOW_PLAN: Array<[string, string, keyof Palette, string, number]> = [
  ["clients", "gateway", "requests", "request", 0.9],
  // --- harness path (optional)
  ["gateway", "runtime", "harness", "harness", 0.6],
  ["runtime", "consent", "consent", "tool", 0.5],
  ["consent", "vault", "harness", "toolPass", 0.5],
  ["vault", "gateway", "harness", "result", 0.5],
  // --- direct path (no runtime involvement)
  ["gateway", "apps", "requests", "appReq", 0.55],
  ["apps", "vault", "requests", "appWrite", 0.5],
  ["gateway", "vault", "requests", "directRead", 0.45],
  ["vault", "gateway", "requests", "directResult", 0.4],
  // --- durability + sync path (no runtime involvement)
  ["vault", "wal", "wal", "wal", 0.35],
  ["wal", "sync", "sync", "ship", 0.5],
  ["wal", "sync", "sync", "replica", 0.66],
  ["sync", "clients", "sync", "replicaDeliver", 0.85],
  ["clients", "sync", "sync", "devicePush", 0.8],
  ["sync", "vault", "sync", "replicaMerge", 0.55],
  ["wal", "backup", "sync", "backup", 0.7],
  // --- blobs, automation, response
  ["apps", "cas", "blob", "blob", 0.6],
  ["cas", "backup", "blob", "blobBackup", 0.6],
  ["automation", "gateway", "automation", "automation", 0.6],
  ["automation", "vault", "automation", "automationWrite", 0.5],
  ["gateway", "clients", "requests", "response", 0.7],
];

export function createWorld(content: CityContent): WorldApi {
  const palette: Palette = { ...DEFAULT_PALETTE, ...content.palette };
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  scene.add(root);

  const winTex = makeWindowTexture();
  const groundTex = makeGroundTexture();
  const convTex = makeConveyorTexture();

  const matCache = new Map<string, THREE.MeshStandardMaterial>();
  const facadeMat = (
    hex: string,
    opts: KitOptions = {}
  ): THREE.MeshStandardMaterial => {
    const key = `${hex}|${opts.windows === false ? 0 : 1}|${opts.rough ?? 0.72}|${opts.metal ?? 0.06}`;
    let m = matCache.get(key);
    if (m) return m;
    m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(hex),
      roughness: opts.rough ?? 0.72,
      metalness: opts.metal ?? 0.06,
    });
    if (opts.windows !== false) {
      m.emissiveMap = winTex;
      m.emissive = new THREE.Color(0xffffff);
      m.emissiveIntensity = 0;
      m.userData.windows = true;
    }
    matCache.set(key, m);
    return m;
  };
  const plainMat = (
    hex: string,
    opts: KitOptions = {}
  ): THREE.MeshStandardMaterial =>
    facadeMat(hex, {
      windows: false,
      rough: opts.rough ?? 0.8,
      metal: opts.metal ?? 0.1,
    });

  const glowMats: THREE.MeshBasicMaterial[] = [];
  const glowMatImpl = (hex: string, base = 0.55): THREE.MeshBasicMaterial => {
    const m = new THREE.MeshBasicMaterial({
      color: new THREE.Color(hex),
      transparent: true,
      opacity: base,
      toneMapped: false,
    });
    m.userData.baseOpacity = base;
    glowMats.push(m);
    return m;
  };
  const glowMat = glowMatImpl;

  /* ---------------- sky */
  const skyDay = new THREE.Mesh(
    new THREE.SphereGeometry(700, 40, 24),
    new THREE.MeshBasicMaterial({
      map: makeSkyTexture(false),
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    })
  );
  const skyNight = new THREE.Mesh(
    new THREE.SphereGeometry(690, 40, 24),
    new THREE.MeshBasicMaterial({
      map: makeSkyTexture(true),
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      transparent: true,
      opacity: 0,
    })
  );
  scene.add(skyDay, skyNight);

  // A few very soft, far-off cloud sprites — day-only (faded out at night alongside the sky).
  const clouds: THREE.Sprite[] = [];
  const cloudTex = makeCloudTexture();
  const CLOUD_LAYOUT = [
    { x: -260, y: 150, z: -220, s: 150 },
    { x: 190, y: 175, z: -260, s: 180 },
    { x: -110, y: 130, z: 250, s: 130 },
    { x: 250, y: 155, z: 130, s: 160 },
  ];
  for (const cp of CLOUD_LAYOUT) {
    const cm = new THREE.SpriteMaterial({
      map: cloudTex,
      color: 0xffffff,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    const sprite = new THREE.Sprite(cm);
    sprite.position.set(cp.x, cp.y, cp.z);
    sprite.scale.set(cp.s, cp.s * 0.42, 1);
    sprite.renderOrder = -1;
    scene.add(sprite);
    clouds.push(sprite);
  }

  scene.fog = new THREE.Fog(0x8fb6d4, 320, 1300);

  /* ---------------- lights */
  const hemi = new THREE.HemisphereLight(0xbcd8f5, 0x1b2433, 0.62);
  const sun = new THREE.DirectionalLight(0xfff2dc, 1.9);
  sun.position.set(-90, 130, 70);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -170;
  sc.right = 170;
  sc.top = 170;
  sc.bottom = -170;
  sc.near = 20;
  sc.far = 400;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.12;
  const ambient = new THREE.AmbientLight(0x6f88ad, 0.22);
  scene.add(hemi, sun, sun.target, ambient);

  /* ---------------- ground (with a hole punched for any "pit" district) */
  const pitDistrict = (content.districts || []).find((d) => d.id === "vault");
  // size + centre the ground on the plan the content author laid out
  let gx0 = -80;
  let gx1 = 80;
  let gz0 = -80;
  let gz1 = 80;
  for (const d of content.districts || []) {
    if (!d || !d.plate) continue;
    gx0 = Math.min(gx0, d.plate.x - d.plate.w / 2);
    gx1 = Math.max(gx1, d.plate.x + d.plate.w / 2);
    gz0 = Math.min(gz0, d.plate.z - d.plate.d / 2);
    gz1 = Math.max(gz1, d.plate.z + d.plate.d / 2);
  }
  const groundCx = (gx0 + gx1) / 2;
  const groundCz = (gz0 + gz1) / 2;
  const GROUND = Math.max(gx1 - gx0, gz1 - gz0) + 96;
  const groundShape = roundedRectShape(GROUND, GROUND, 26);
  if (pitDistrict && pitDistrict.plate) {
    const p = pitDistrict.plate;
    const hole = new THREE.Path();
    const hw = p.w / 2 + 2;
    const hd = p.d / 2 + 2;
    // Shape space (x, y) maps to world (x, -y) once the mesh is rotated -90° about X,
    // and the shape itself is centred on the plan, so holes are plan-relative.
    const cx = p.x - groundCx;
    const cy = -(p.z - groundCz);
    hole.moveTo(cx - hw, cy - hd);
    hole.lineTo(cx + hw, cy - hd);
    hole.lineTo(cx + hw, cy + hd);
    hole.lineTo(cx - hw, cy + hd);
    hole.closePath();
    groundShape.holes.push(hole);
  }
  const groundGeo = new THREE.ShapeGeometry(groundShape, 12);
  groundGeo.translate(groundCx, -groundCz, 0);
  {
    // ShapeGeometry UVs are raw shape-space (== world-unit) coordinates; scale so one
    // texture repeat spans exactly GROUND_TILE_UNITS world units (grid stays crisp at any
    // ground extent, independent of the district layout).
    const uv = groundGeo.attributes.uv;
    for (let i = 0; i < uv.count; i++)
      uv.setXY(
        i,
        uv.getX(i) / GROUND_TILE_UNITS,
        uv.getY(i) / GROUND_TILE_UNITS
      );
  }
  const ground = new THREE.Mesh(
    groundGeo,
    new THREE.MeshStandardMaterial({
      map: groundTex,
      color: 0xffffff,
      roughness: 0.96,
      metalness: 0.02,
    })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  root.add(ground);

  /* ---------------- districts */
  const districts: WorldDistrict[] = [];
  const byId = new Map<string, WorldDistrict>();
  const labels: THREE.Sprite[] = [];
  const animated: AnimationRecord[] = [];
  const activityNodes = new Map<string, THREE.Material[]>(); // districtId → [material]

  // Shared landmark kit: bespoke geometry primitives used by landmarks.ts so every
  // building gets its own architecture instead of a shared `kind` silhouette.
  const kit = makeKit(THREE, { facadeMat, plainMat, glowMat, animated });
  const PIT_Y = -5;

  for (const d of content.districts || []) {
    if (!d || !d.plate) continue;
    const isPit = d.id === "vault";
    const plateTop = isPit ? PIT_Y : 1.4;
    const group = new THREE.Group();
    group.userData.pick = { kind: "district", districtId: d.id };
    root.add(group);

    const color = d.color || palette.requests;

    // plate: extruded rounded rect with a bevel
    const shape = roundedRectShape(
      d.plate.w,
      d.plate.d,
      Math.min(6, d.plate.w / 6, d.plate.d / 6)
    );
    const plateGeo = new THREE.ExtrudeGeometry(shape, {
      depth: 1.1,
      bevelEnabled: true,
      bevelSize: 0.5,
      bevelThickness: 0.3,
      bevelSegments: 2,
      curveSegments: 6,
    });
    plateGeo.rotateX(-Math.PI / 2);
    const plate = new THREE.Mesh(
      plateGeo,
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(color).multiplyScalar(0.42),
        roughness: 0.88,
        metalness: 0.04,
      })
    );
    plate.position.set(d.plate.x, plateTop, d.plate.z);
    plate.receiveShadow = true;
    plate.userData.pick = { kind: "district", districtId: d.id };
    group.add(plate);

    // rim light strip
    const rimGeo = new THREE.ExtrudeGeometry(
      roundedRectShape(
        d.plate.w + 1.4,
        d.plate.d + 1.4,
        Math.min(6, d.plate.w / 6)
      ),
      { depth: 0.22, bevelEnabled: false, curveSegments: 6 }
    );
    rimGeo.rotateX(-Math.PI / 2);
    const rimMat = glowMat(color, 0.34);
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.position.set(d.plate.x, plateTop + 0.02, d.plate.z);
    group.add(rim);

    if (isPit) {
      // pit walls between world ground (y=0) and the sunken plate
      const wallMat = plainMat("#6d7b91", { rough: 0.95 });
      const depth = -PIT_Y + 1.4;
      const hw = d.plate.w / 2 + 2;
      const hd = d.plate.d / 2 + 2;
      const mk = (w, h, dd, x, y, z) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, dd), wallMat);
        m.position.set(x, y, z);
        m.receiveShadow = true;
        group.add(m);
      };
      const y = -depth / 2 + 1.4;
      mk(hw * 2 + 2, depth, 1, d.plate.x, y, d.plate.z - hd);
      mk(hw * 2 + 2, depth, 1, d.plate.x, y, d.plate.z + hd);
      mk(1, depth, hd * 2, d.plate.x - hw, y, d.plate.z);
      mk(1, depth, hd * 2, d.plate.x + hw, y, d.plate.z);
    }

    // label sprite
    const { tex, aspect } = makeLabelTexture(d.name || d.id, color);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        depthTest: true,
        fog: false,
      })
    );
    const lh = 7.2;
    sprite.scale.set(lh * aspect, lh, 1);
    sprite.position.set(d.plate.x, plateTop + 22, d.plate.z);
    group.add(sprite);
    labels.push(sprite);

    const rec: WorldDistrict = {
      data: d,
      group,
      plate,
      color,
      isPit,
      plateTop,
      center: new THREE.Vector3(d.plate.x, plateTop, d.plate.z),
      anchor: new THREE.Vector3(d.plate.x, plateTop + 9, d.plate.z),
      buildings: [],
      label: sprite,
      activity: 0,
      // flow-spotlight (see setFlowFocus): -1 muted … 0 neutral … +1 lifted
      rimMat,
      focusW: 0,
      focusTarget: 0,
    };
    districts.push(rec);
    byId.set(d.id, rec);
    activityNodes.set(d.id, []);

    // building coordinate space: absolute world, or relative to the plate?
    const list = d.buildings || [];
    const fits = (rel) => {
      let n = 0;
      for (const b of list) {
        if (!b || !b.pos) continue;
        const x = rel ? d.plate.x + b.pos.x : b.pos.x;
        const z = rel ? d.plate.z + b.pos.z : b.pos.z;
        if (
          Math.abs(x - d.plate.x) <= d.plate.w / 2 + 8 &&
          Math.abs(z - d.plate.z) <= d.plate.d / 2 + 8
        )
          n++;
      }
      return n;
    };
    const relative = fits(true) > fits(false);

    for (const b of list) {
      if (!b || !b.pos || !b.size) continue;
      const x = relative ? d.plate.x + b.pos.x : b.pos.x;
      const z = relative ? d.plate.z + b.pos.z : b.pos.z;
      const bg = buildBuilding(b, color, {
        facadeMat,
        plainMat,
        glowMat,
        convTex,
        kit,
        districtId: d.id,
        animated,
        activity: activityNodes.get(d.id),
        palette,
      });
      bg.position.set(x, plateTop + 1.1, z);
      bg.userData.pick = {
        kind: "building",
        districtId: d.id,
        buildingId: b.id,
      };
      group.add(bg);
      const box = new THREE.Box3().setFromObject(bg);
      const brec = {
        data: b,
        group: bg,
        box,
        center: box.getCenter(new THREE.Vector3()),
        top: new THREE.Vector3(x, box.max.y, z),
      };
      rec.buildings.push(brec);
    }

    // ontology star: link the first vault building to its neighbours
    if (isPit && rec.buildings.length > 2) {
      const pts = [];
      const hub = rec.buildings[0].top;
      for (let i = 1; i < rec.buildings.length; i++) {
        pts.push(
          hub.x,
          hub.y - 1,
          hub.z,
          rec.buildings[i].top.x,
          rec.buildings[i].top.y - 1,
          rec.buildings[i].top.z
        );
      }
      const lg = new THREE.BufferGeometry();
      lg.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      const lines = new THREE.LineSegments(
        lg,
        new THREE.LineBasicMaterial({
          color: new THREE.Color(color),
          transparent: true,
          opacity: 0.5,
        })
      );
      group.add(lines);
    }
  }

  /* ---------------- scenery derived from content geometry */

  // Consent parking lot beside the consent gate.
  let parkPoint: THREE.Vector3 | null = null;
  const consent = byId.get("consent");
  if (consent) {
    const p = consent.data.plate;
    parkPoint = new THREE.Vector3(
      p.x + p.w / 2 + 13,
      consent.plateTop + 2,
      p.z
    );
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(9, 9, 0.5, 24),
      plainMat("#2b2338", { rough: 0.95 })
    );
    pad.position.set(parkPoint.x, consent.plateTop + 0.3, parkPoint.z);
    pad.receiveShadow = true;
    root.add(pad);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(9, 0.28, 6, 32),
      glowMat(palette.consent, 0.5)
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(parkPoint.x, consent.plateTop + 0.6, parkPoint.z);
    root.add(ring);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const slot = new THREE.Mesh(
        new THREE.BoxGeometry(3.4, 0.9, 2.2),
        plainMat("#3d3350")
      );
      slot.position.set(
        parkPoint.x + Math.cos(a) * 5.2,
        consent.plateTop + 0.9,
        parkPoint.z + Math.sin(a) * 5.2
      );
      root.add(slot);
    }
    consent.parkPoint = parkPoint;
    consent.parkRing = ring;
  }

  // Replica island at the far end of any bridge (Sync Harbor).
  let islandPoint: THREE.Vector3 | null = null;
  for (const rec of districts) {
    for (const b of rec.buildings) {
      if (b.data.kind !== "bridge") continue;
      const far = b.group.userData.bridgeFar;
      if (!far) continue;
      const wp = b.group.localToWorld(far.clone());
      islandPoint = new THREE.Vector3(wp.x, 1.6, wp.z);
      const isl = new THREE.Mesh(
        new THREE.CylinderGeometry(15, 17, 3, 7),
        plainMat("#3c4b60", { rough: 0.95 })
      );
      isl.position.set(islandPoint.x, 0.6, islandPoint.z);
      isl.receiveShadow = true;
      root.add(isl);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(15.4, 0.3, 6, 28),
        glowMat(palette.sync, 0.45)
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(islandPoint.x, 2.2, islandPoint.z);
      root.add(ring);
      // standby replicas
      for (let i = 0; i < 3; i++) {
        const a = -0.9 + i * 0.9;
        const st = new THREE.Mesh(
          new THREE.BoxGeometry(4, 6 + i, 4),
          facadeMat("#4c6076")
        );
        st.position.set(
          islandPoint.x + Math.cos(a) * 7,
          2.1 + (6 + i) / 2,
          islandPoint.z + Math.sin(a) * 7
        );
        st.castShadow = true;
        root.add(st);
      }
      const lagBar = new THREE.Mesh(
        new THREE.BoxGeometry(10, 0.9, 0.9),
        glowMat(palette.sync, 0.85)
      );
      lagBar.position.set(islandPoint.x, 12, islandPoint.z);
      root.add(lagBar);
      islandPoint.y = 2.2;
      break;
    }
    if (islandPoint) break;
  }

  // Cloud barge departing the CAS warehouse.
  let barge: THREE.Group | null = null;
  const cas = byId.get("cas");
  if (cas) {
    barge = new THREE.Group();
    const hull = new THREE.Mesh(
      new THREE.BoxGeometry(14, 3, 7),
      plainMat("#5b6b7d", { metal: 0.4 })
    );
    barge.add(hull);
    for (let i = 0; i < 4; i++) {
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(2.6, 2.4, 2.4),
        plainMat(i % 2 ? "#7d8b99" : "#4a5a6b")
      );
      box.position.set(-4.5 + i * 3, 2.6, 0);
      barge.add(box);
    }
    const sail = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 7, 5),
      glowMat(palette.blob, 0.4)
    );
    sail.position.set(-5.5, 5.5, 0);
    barge.add(sail);
    barge.position.set(cas.center.x, 22, cas.center.z);
    barge.userData.home = new THREE.Vector3(cas.center.x, 22, cas.center.z);
    barge.visible = false;
    root.add(barge);
  }

  /* ---------------- roads (flat ribbons on the ground, under the particle flows) */
  const ROAD_Y = 0.035; // just above the ground plane — avoids z-fighting
  const roadMesh = buildRoadsMesh(FLOW_PLAN, byId, ROAD_Y);
  if (roadMesh) root.add(roadMesh);

  /* ---------------- flows */
  const flows: FlowRuntime[] = [];
  const mkFlow = (
    a: THREE.Vector3,
    b: THREE.Vector3,
    colorHex: string,
    role: string,
    height: number,
    capacity = 42
  ): FlowRuntime => {
    const curve = new THREE.QuadraticBezierCurve3(
      a.clone(),
      new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5),
      b.clone()
    );
    const dist = a.distanceTo(b);
    curve.v1.y += dist * height + 6;
    // small lateral bow so opposite-direction flows don't overlap
    const perp = new THREE.Vector3(b.z - a.z, 0, -(b.x - a.x))
      .normalize()
      .multiplyScalar(dist * 0.08);
    curve.v1.add(perp);
    // Bigger than the original 0.62 so flows read clearly against the light day ground;
    // MeshBasicMaterial is unlit (already "fully emissive"), so day/night is handled by
    // brightening the color itself rather than adding a lighting response.
    const geo = new THREE.OctahedronGeometry(0.85, 0);
    const baseColor = new THREE.Color(colorHex);
    const hsl = { h: 0, s: 0, l: 0 };
    baseColor.getHSL(hsl);
    const dayColor = new THREE.Color().setHSL(
      hsl.h,
      Math.min(1, hsl.s * 1.1 + 0.08),
      Math.min(0.78, hsl.l * 1.3 + 0.12)
    );
    // `transparent` is on from the start so setFlowFocus can fade a flow down without
    // ever swapping/rebuilding the material (a material swap would recompile the program).
    const mat = new THREE.MeshBasicMaterial({
      color: dayColor.clone(),
      toneMapped: false,
      transparent: true,
      opacity: 1,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = capacity;
    root.add(mesh);
    const parts: Array<{ t: number; speed: number; live: boolean }> = [];
    for (let i = 0; i < capacity; i++)
      parts.push({ t: 0, speed: 0, live: false });
    const f: FlowRuntime = {
      role,
      curve,
      mesh,
      mat,
      parts,
      capacity,
      acc: 0,
      baseColor,
      dayColor,
      from: null,
      to: null,
      // flow-spotlight (see setFlowFocus): -1 muted … 0 neutral … +1 spotlit.
      focusW: 0,
      focusTarget: 0,
    };
    // park everything off-screen initially
    const m = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < capacity; i++) mesh.setMatrixAt(i, m);
    mesh.instanceMatrix.needsUpdate = true;
    flows.push(f);
    return f;
  };

  for (const [fromId, toId, colorKey, role, height] of FLOW_PLAN) {
    const A = byId.get(fromId);
    const B = byId.get(toId);
    if (!A || !B) continue;
    const f = mkFlow(
      A.anchor,
      B.anchor,
      palette[colorKey] || palette.requests,
      role,
      height
    );
    f.from = fromId;
    f.to = toId;
  }
  if (consent && parkPoint) {
    const f = mkFlow(
      consent.anchor,
      parkPoint.clone().setY(parkPoint.y + 4),
      palette.consent,
      "park",
      0.55,
      24
    );
    f.from = "consent";
    f.to = "park";
  }
  if (islandPoint) {
    const syncRec = byId.get("sync") || districts[0];
    const f = mkFlow(
      syncRec.anchor,
      islandPoint.clone().setY(islandPoint.y + 8),
      palette.sync,
      "replica",
      0.35,
      48
    );
    f.dynamic = "replica";
    f.from = "sync";
    f.to = "island";
  }

  /* ---------------- flow spotlight
   *
   * setFlowFocus(roles) makes the flows named in `roles` dominant and everything else a
   * quiet background presence, so a guided chapter can point at exactly one data path.
   *
   * State is one signed weight per flow (and per district): -1 = fully muted,
   * 0 = neutral / cleared, +1 = fully spotlit. `focusTarget` is what setFlowFocus asks for;
   * `focusW` chases it inside update() at FOCUS_EASE, so a page turn reads as a lens
   * shifting rather than a switch flipping. Nothing here allocates or rebuilds anything:
   * it only modulates the existing per-flow material colour/opacity, the instance scale,
   * and the spawn rate.
   */
  const FOCUS_EASE = 6; // w += (target - w) * min(1, dt * FOCUS_EASE) → ~95% in 0.5s
  const FOCUS_RATE_GAIN = 1.6; // spotlit spawn rate ×(1 + 1.6) = ×2.6
  const FOCUS_RATE_FLOOR = 5.5; // …and never below 5.5 particles/s, so a quiet role still streams
  const MUTE_RATE_CUT = 0.65; // muted spawn rate ×0.35 (dimmed, never switched off)
  const FOCUS_SCALE_GAIN = 0.55; // spotlit particles ×1.55
  const MUTE_SCALE_CUT = 0.35; // muted particles ×0.65
  const MUTE_OPACITY_CUT = 0.72; // muted opacity 0.28
  const FOCUS_WHITEN = 0.18; // spotlit colour lerped 18% toward white
  const MUTE_WASH = 0.55; // muted colour lerped 55% toward a cool grey
  const ROAD_MUTE = 0.32; // road ribbons darkened 32% while any focus is held

  let focusActive = false;
  let roadFocusW = 0; // 0 = normal roads, 1 = fully de-emphasised
  let roadFocusTarget = 0;
  const _muteColor = new THREE.Color("#8494a8");
  const _whiteColor = new THREE.Color("#ffffff");
  const _dirtyColor = new THREE.Color(palette.dirty);
  const _roadColor = new THREE.Color();

  function setFlowFocus(roles: string[] | string | null): void {
    const list =
      typeof roles === "string" ? [roles] : Array.isArray(roles) ? roles : [];
    const wanted = new Set();
    for (const r of list) if (typeof r === "string" && r) wanted.add(r);

    // Unknown role strings are a no-op: if nothing in the list names a real flow we clear
    // rather than muting the whole city.
    let matched = 0;
    if (wanted.size) {
      for (const f of flows) if (wanted.has(f.role)) matched++;
    }
    focusActive = matched > 0;

    for (const rec of districts) rec.focusTarget = 0;
    for (const f of flows) {
      if (!focusActive) {
        f.focusTarget = 0;
        continue;
      }
      const on = wanted.has(f.role);
      f.focusTarget = on ? 1 : -1;
      if (!on) continue;
      // lift the districts this path connects (endpoints may be scenery ids like 'park')
      const a = byId.get(f.from);
      const b = byId.get(f.to);
      if (a) a.focusTarget = 1;
      if (b) b.focusTarget = 1;
    }
    if (focusActive) {
      for (const rec of districts)
        if (rec.focusTarget === 0) rec.focusTarget = -1;
    }
    roadFocusTarget = focusActive ? 1 : 0;
  }

  // Roads compose two independent dimmers: day/night, and the flow spotlight.
  function applyRoadTint() {
    if (!roadMesh) return;
    _roadColor
      .copy(roadMesh.userData.dayColor)
      .lerp(roadMesh.userData.nightColor, night);
    if (roadFocusW > 0.001)
      _roadColor.multiplyScalar(1 - ROAD_MUTE * roadFocusW);
    (roadMesh.material as THREE.MeshStandardMaterial).color.copy(_roadColor);
  }

  /* ---------------- hover / select outline */
  const outlineGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
  const mkOutline = (hex, w) => {
    const o = new THREE.LineSegments(
      outlineGeo,
      new THREE.LineBasicMaterial({
        color: new THREE.Color(hex),
        transparent: true,
        opacity: w,
        depthTest: false,
      })
    );
    o.visible = false;
    o.renderOrder = 5;
    root.add(o);
    return o;
  };
  const hoverOutline = mkOutline("#ffffff", 0.75);
  const selectOutline = mkOutline("#39c5ea", 0.95);

  function frameOutline(o: THREE.LineSegments, box: THREE.Box3 | null): void {
    if (!box) {
      o.visible = false;
      return;
    }
    const size = box.getSize(new THREE.Vector3());
    const c = box.getCenter(new THREE.Vector3());
    o.position.copy(c);
    o.scale.set(
      Math.max(size.x, 0.2) * 1.05,
      Math.max(size.y, 0.2) * 1.03,
      Math.max(size.z, 0.2) * 1.05
    );
    o.visible = true;
  }

  /* ---------------- day / night */
  let night = 0;
  const dayFog = new THREE.Color(0x8fb6d4);
  const nightFog = new THREE.Color(0x0d1626);
  const dayGround = new THREE.Color(0xffffff);
  const nightGround = new THREE.Color(0x222c44);

  function applyNight(n: number): void {
    night = n;
    skyNight.material.opacity = n;
    for (const s of clouds) s.material.opacity = 0.5 * (1 - n);
    scene.fog.color.copy(dayFog).lerp(nightFog, n);
    ground.material.color.copy(dayGround).lerp(nightGround, n);
    applyRoadTint();
    hemi.intensity = 0.62 - 0.42 * n;
    sun.intensity = 1.9 - 1.62 * n;
    sun.color.setHex(n > 0.5 ? 0xbcd0ff : 0xfff2dc);
    ambient.intensity = 0.22 - 0.06 * n;
    for (const m of matCache.values()) {
      if (m.userData.windows) m.emissiveIntensity = 1.25 * n;
    }
    for (const m of glowMats)
      m.opacity = m.userData.baseOpacity * (0.55 + 0.75 * n);
    for (const s of labels) s.material.opacity = 0.85 + 0.15 * n;
  }
  applyNight(0);

  /* ---------------- per-frame update */
  const _v = new THREE.Vector3();
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _s = new THREE.Vector3(1, 1, 1);
  const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const UP = new THREE.Vector3(0, 1, 0);
  const _tmpColor = new THREE.Color();

  function update(dt: number, elapsed: number, sim?: Sim): void {
    // animated building details
    for (const a of animated) {
      if (a.type === "crane") {
        const active = sim ? sim.pulses.crane : 0;
        a.obj.rotation.y += dt * (0.12 + active * 0.65);
        if (a.hook)
          a.hook.position.y =
            a.hookBase - 3 - Math.sin(elapsed * (0.6 + active * 1.6)) * 3;
      } else if (a.type === "clock") {
        a.minute.rotation.z = -elapsed * 0.5;
        a.hour.rotation.z = -elapsed * 0.045;
      } else if (a.type === "conveyor") {
        a.tex.offset.x =
          (a.tex.offset.x - dt * (0.25 + (sim ? sim.rates.wal : 0) * 0.02)) % 1;
      } else if (a.type === "beacon") {
        const k = 0.5 + 0.5 * Math.sin(elapsed * 2.2 + a.phase);
        a.mat.opacity = a.mat.userData.baseOpacity * (0.35 + 0.9 * k);
      } else if (a.type === "gate") {
        const k = 0.5 + 0.5 * Math.sin(elapsed * 1.5);
        a.mat.opacity = a.mat.userData.baseOpacity * (0.5 + 0.6 * k);
      } else if (a.type === "activity") {
        const act = sim ? sim.activity[a.districtId] || 0 : 0;
        a.mat.opacity =
          a.mat.userData.baseOpacity *
          (0.25 + 1.5 * act * (0.7 + 0.3 * Math.sin(elapsed * 4 + a.phase)));
      } else if (a.type === "spin") {
        // kit.ts: fans, flywheels, weathervanes, radar rotors
        a.obj.rotation[a.axis || "y"] += dt * a.speed;
      } else if (a.type === "bob") {
        // kit.ts: hanging trolleys, flags, floats
        a.obj.position.y =
          a.base + Math.sin(elapsed * a.speed + a.phase) * a.amp;
      } else if (a.type === "reciprocate") {
        // kit.ts: piston rods
        a.obj.position[a.axis || "y"] =
          a.base + Math.sin(elapsed * a.speed + a.phase) * a.amp;
      }
    }

    if (barge && sim) {
      const p = sim.pulses.barge;
      if (p > 0.01) {
        barge.visible = true;
        const k = 1 - p;
        barge.position.set(
          barge.userData.home.x + k * 120,
          barge.userData.home.y + k * 26,
          barge.userData.home.z - k * 60
        );
        barge.rotation.y = -0.5;
      } else {
        barge.visible = false;
      }
    }

    if (consent && consent.parkRing && sim) {
      const load = Math.min(1, sim.stats.approvals / 8);
      (consent.parkRing.material as THREE.MeshBasicMaterial).opacity =
        0.3 + 0.7 * load;
      consent.parkRing.scale.setScalar(
        1 + 0.04 * Math.sin(elapsed * 3) * (0.2 + load)
      );
    }

    // flow spotlight: ease every weight one step, then apply it to districts + roads.
    const ease = Math.min(1, dt * FOCUS_EASE);
    roadFocusW += (roadFocusTarget - roadFocusW) * ease;
    if (roadMesh && (roadFocusW > 0.001 || roadFocusTarget > 0))
      applyRoadTint();
    for (const rec of districts) {
      rec.focusW += (rec.focusTarget - rec.focusW) * ease;
      const up = Math.max(0, rec.focusW);
      const down = Math.max(0, -rec.focusW);
      if (up < 0.001 && down < 0.001) continue;
      // rim glow: base is whatever applyNight computed, then lifted / eased back
      const rimBase = rec.rimMat.userData.baseOpacity * (0.55 + 0.75 * night);
      rec.rimMat.opacity = rimBase * (1 + 0.9 * up) * (1 - 0.45 * down);
      rec.label.material.opacity =
        (0.85 + 0.15 * night) * (1 + 0.17 * up) * (1 - 0.4 * down);
    }

    // flows
    for (const f of flows) {
      f.focusW += (f.focusTarget - f.focusW) * ease;
      const up = Math.max(0, f.focusW);
      const down = Math.max(0, -f.focusW);
      const scaleMul = 1 + FOCUS_SCALE_GAIN * up - MUTE_SCALE_CUT * down;
      let rate = sim ? sim.rates[f.role] || 0 : 4;
      if (up > 0.001) {
        // spotlit: denser, and floored so a path the sim is running slowly still streams
        rate = Math.max(
          rate * (1 + FOCUS_RATE_GAIN * up),
          FOCUS_RATE_FLOOR * up
        );
      }
      if (down > 0.001) rate *= 1 - MUTE_RATE_CUT * down;
      // Day mode gets the brighter/more-saturated color so particles read against the light
      // ground; night mode eases back to the original (already-good) saturated color.
      _tmpColor.copy(f.dayColor).lerp(f.baseColor, night);
      if (f.dynamic === "replica" && sim) {
        const bad = Math.min(1, sim.stats.lag / 20);
        _tmpColor.lerp(_dirtyColor, bad);
      }
      // spotlight sits on top of the day/night colour, never replaces it
      if (up > 0.001) _tmpColor.lerp(_whiteColor, FOCUS_WHITEN * up);
      if (down > 0.001) _tmpColor.lerp(_muteColor, MUTE_WASH * down);
      f.mat.color.copy(_tmpColor);
      f.mat.opacity = 1 - MUTE_OPACITY_CUT * down;
      f.acc += rate * dt;
      if (f.acc > f.capacity) f.acc = f.capacity; // guard the spawn loop against huge dt
      while (f.acc >= 1) {
        f.acc -= 1;
        const slot = f.parts.find((p) => !p.live);
        if (slot) {
          slot.live = true;
          slot.t = 0;
          slot.speed = 0.16 + Math.random() * 0.12;
        }
      }
      let dirty = false;
      for (let i = 0; i < f.capacity; i++) {
        const p = f.parts[i];
        if (!p.live) continue;
        p.t += p.speed * dt;
        if (p.t >= 1) {
          p.live = false;
          f.mesh.setMatrixAt(i, _zero);
          dirty = true;
          continue;
        }
        f.curve.getPoint(p.t, _v);
        const sScale = 1 + 0.35 * Math.sin(p.t * Math.PI);
        _s.setScalar(sScale * (1 + 0.25 * night) * scaleMul);
        _q.setFromAxisAngle(UP, elapsed * 2 + i);
        _m.compose(_v, _q, _s);
        f.mesh.setMatrixAt(i, _m);
        dirty = true;
      }
      if (dirty) f.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  return {
    scene,
    root,
    ground,
    districts,
    byId,
    flows,
    palette,
    sun,
    labels,
    hoverOutline,
    selectOutline,
    frameOutline,
    update,
    applyNight,
    setFlowFocus,
    get night() {
      return night;
    },
    islandPoint,
    parkPoint,
  };
}

/* ------------------------------------------------------------------ building kinds */

function buildBuilding(
  b: CityBuilding,
  districtColor: string,
  ctx: BuildingBuildContext
): THREE.Group {
  const {
    facadeMat,
    plainMat,
    glowMat,
    convTex,
    districtId,
    animated,
    activity,
  } = ctx;
  const w = Math.max(1, b.size.w || 8);
  const h = Math.max(1, b.size.h || 10);
  const d = Math.max(1, b.size.d || 8);
  const color = b.color || districtColor;
  const g = new THREE.Group();
  const kind = String(b.kind || "slab").toLowerCase();

  const boxed = (bw, bh, bd, hex, windows = true) => {
    const geo = new THREE.BoxGeometry(bw, bh, bd);
    if (windows) facadeUVs(geo, bw, bh, bd);
    const m = new THREE.Mesh(geo, windows ? facadeMat(hex) : plainMat(hex));
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };

  const roofUnits = (bw, bh, bd, n = 3) => {
    for (let i = 0; i < n; i++) {
      const uw = Math.min(bw, bd) * (0.16 + (i % 2) * 0.08);
      const u = new THREE.Mesh(
        new THREE.BoxGeometry(uw, uw * 0.8, uw),
        plainMat("#7c8899", { metal: 0.35 })
      );
      u.position.set(
        -bw * 0.28 + i * bw * 0.28,
        bh + uw * 0.4,
        ((i % 2) - 0.5) * bd * 0.28
      );
      u.castShadow = true;
      g.add(u);
    }
  };

  const beacon = (x, y, z, hex, r = 0.55) => {
    const mat = glowMat(hex, 0.85);
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), mat);
    m.position.set(x, y, z);
    g.add(m);
    animated.push({ type: "beacon", mat, phase: Math.random() * 6 });
    return m;
  };

  // Bespoke landmark geometry wins over the generic `kind` silhouette. Each landmark
  // depicts what its subsystem actually does; `kind` remains the fallback.
  const landmark = LANDMARKS[b.id];
  if (landmark) {
    try {
      landmark({
        g,
        w,
        h,
        d,
        color,
        districtId,
        data: b,
        kit: ctx.kit,
        THREE,
        animated,
        facadeMat,
        plainMat,
        glowMat,
        beacon,
        boxed,
        roofUnits,
      });
      return g;
    } catch (error) {
      console.warn("[landmark]", b.id, error);
      g.clear();
    }
  }

  switch (kind) {
    case "tower": {
      const base = boxed(w, h * 0.7, d, color);
      base.position.y = (h * 0.7) / 2;
      const upW = w * 0.7;
      const up = boxed(upW, h * 0.3, d * 0.7, color);
      up.position.y = h * 0.7 + (h * 0.3) / 2;
      const cap = new THREE.Mesh(
        new THREE.BoxGeometry(upW * 1.15, 0.6, d * 0.7 * 1.15),
        plainMat("#8b98aa", { metal: 0.4 })
      );
      cap.position.y = h + 0.3;
      cap.castShadow = true;
      g.add(cap);
      const mast = new THREE.Mesh(
        new THREE.CylinderGeometry(0.16, 0.22, h * 0.28, 6),
        plainMat("#9aa7b8", { metal: 0.5 })
      );
      mast.position.y = h + h * 0.14;
      g.add(mast);
      beacon(0, h + h * 0.28, 0, "#e5484d", 0.42);
      roofUnits(upW, h, d * 0.7, 2);
      // ground-floor entrance glow
      const ent = new THREE.Mesh(
        new THREE.BoxGeometry(w * 0.4, 2.2, 0.3),
        glowMat(color, 0.6)
      );
      ent.position.set(0, 1.1, d / 2 + 0.05);
      g.add(ent);
      if (districtId === "automation")
        addClock(g, w, h, d, plainMat, glowMat, animated);
      break;
    }
    case "hall": {
      const body = boxed(w, h * 0.82, d, color);
      body.position.y = (h * 0.82) / 2;
      const roof = new THREE.Mesh(
        new THREE.BoxGeometry(w * 1.1, h * 0.1, d * 1.1),
        plainMat(color, { rough: 0.6 })
      );
      roof.position.y = h * 0.82 + h * 0.05;
      roof.castShadow = true;
      g.add(roof);
      const lantern = new THREE.Mesh(
        new THREE.BoxGeometry(w * 0.34, h * 0.16, d * 0.34),
        glowMat(color, 0.55)
      );
      lantern.position.y = h * 0.92 + h * 0.08;
      g.add(lantern);
      // colonnade + steps on the +z face
      const pn = Math.max(3, Math.round(w / 4));
      for (let i = 0; i < pn; i++) {
        const p = new THREE.Mesh(
          new THREE.CylinderGeometry(0.42, 0.5, h * 0.72, 8),
          plainMat("#c8d2de", { rough: 0.6 })
        );
        p.position.set(
          -w / 2 + (w / (pn - 1)) * i,
          (h * 0.72) / 2,
          d / 2 + 1.4
        );
        p.castShadow = true;
        g.add(p);
      }
      const steps = new THREE.Mesh(
        new THREE.BoxGeometry(w * 1.02, 0.6, 3.4),
        plainMat("#b9c4d2")
      );
      steps.position.set(0, 0.3, d / 2 + 1.6);
      steps.receiveShadow = true;
      g.add(steps);
      const porch = new THREE.Mesh(
        new THREE.BoxGeometry(w * 1.05, 0.5, 3.6),
        plainMat(color, { rough: 0.5 })
      );
      porch.position.set(0, h * 0.72, d / 2 + 1.4);
      g.add(porch);
      break;
    }
    case "slab": {
      const lower = boxed(w, h * 0.6, d, color);
      lower.position.y = (h * 0.6) / 2;
      const upper = boxed(w * 0.82, h * 0.4, d * 0.82, color);
      upper.position.y = h * 0.6 + (h * 0.4) / 2;
      roofUnits(w * 0.82, h, d * 0.82, 3);
      // WAL Works slabs carry a conveyor
      if (districtId === "wal")
        addConveyor(g, w, d, convTex, plainMat, animated);
      break;
    }
    case "shed": {
      const body = boxed(w, h * 0.72, d, color);
      body.position.y = (h * 0.72) / 2;
      const roof = new THREE.Mesh(
        prismGeometry(w * 1.06, h * 0.34, d * 1.02),
        plainMat(color, { rough: 0.55 })
      );
      roof.position.y = h * 0.72;
      roof.castShadow = true;
      g.add(roof);
      const door = new THREE.Mesh(
        new THREE.BoxGeometry(w * 0.42, h * 0.42, 0.3),
        glowMat(color, 0.5)
      );
      door.position.set(0, h * 0.21, d / 2 + 0.06);
      g.add(door);
      const vent = new THREE.Mesh(
        new THREE.CylinderGeometry(0.5, 0.5, h * 0.25, 8),
        plainMat("#8b98aa", { metal: 0.4 })
      );
      vent.position.set(w * 0.3, h * 0.9, 0);
      g.add(vent);
      break;
    }
    case "arch": {
      const pw = Math.max(1.6, w * 0.18);
      const legH = h * 0.78;
      for (const s of [-1, 1]) {
        const leg = new THREE.Mesh(
          new THREE.BoxGeometry(pw, legH, d),
          plainMat(color, { rough: 0.6 })
        );
        leg.position.set(s * (w / 2 - pw / 2), legH / 2, 0);
        leg.castShadow = true;
        g.add(leg);
      }
      const lintel = new THREE.Mesh(
        new THREE.BoxGeometry(w * 1.08, h * 0.22, d * 1.15),
        plainMat(color, { rough: 0.55 })
      );
      lintel.position.y = legH + (h * 0.22) / 2;
      lintel.castShadow = true;
      g.add(lintel);
      const gateMat = glowMat(color, 0.35);
      const gate = new THREE.Mesh(
        new THREE.PlaneGeometry(w - pw * 2, legH * 0.92),
        gateMat
      );
      gate.position.y = (legH * 0.92) / 2;
      gate.material.side = THREE.DoubleSide;
      g.add(gate);
      animated.push({ type: "gate", mat: gateMat });
      beacon(0, legH + h * 0.3, 0, color, 0.5);
      break;
    }
    case "crane": {
      const baseM = new THREE.Mesh(
        new THREE.BoxGeometry(w * 0.9, 1.6, d * 0.9),
        plainMat("#4d5866", { metal: 0.4 })
      );
      baseM.position.y = 0.8;
      baseM.receiveShadow = true;
      g.add(baseM);
      const rot = new THREE.Group();
      rot.position.y = 1.6;
      g.add(rot);
      // NOTE: crane parts deliberately do not cast shadows — the shadow map is baked once
      // (renderer.shadowMap.autoUpdate = false) and a frozen shadow under a turning jib reads wrong.
      const mast = new THREE.Mesh(
        new THREE.BoxGeometry(1.5, h, 1.5),
        plainMat("#f5a623", { rough: 0.5, metal: 0.3 })
      );
      mast.position.y = h / 2;
      rot.add(mast);
      const jibLen = Math.max(w, 14);
      const jib = new THREE.Mesh(
        new THREE.BoxGeometry(jibLen, 1, 1),
        plainMat("#f5a623", { rough: 0.5 })
      );
      jib.position.set(jibLen / 2 - 2, h, 0);
      rot.add(jib);
      const cw = new THREE.Mesh(
        new THREE.BoxGeometry(3.2, 2.2, 2.2),
        plainMat("#39404d")
      );
      cw.position.set(-4.2, h, 0);
      rot.add(cw);
      const cable = new THREE.Mesh(
        new THREE.CylinderGeometry(0.07, 0.07, h * 0.55, 4),
        plainMat("#20262f")
      );
      cable.position.set(jibLen - 4, h - (h * 0.55) / 2, 0);
      rot.add(cable);
      const hook = new THREE.Mesh(
        new THREE.BoxGeometry(1.6, 1.2, 1.6),
        plainMat("#c9d3df", { metal: 0.5 })
      );
      hook.position.set(jibLen - 4, h - h * 0.55, 0);
      rot.add(hook);
      beacon(0, h + 1, 0, "#e5484d", 0.4);
      animated.push({ type: "crane", obj: rot, hook, hookBase: h });
      break;
    }
    case "bridge": {
      const len = Math.max(w, 26);
      const deck = new THREE.Mesh(
        new THREE.BoxGeometry(len, 1.1, Math.max(4, d)),
        plainMat("#5f7286", { metal: 0.25 })
      );
      deck.position.set(len / 2, h * 0.62, 0);
      deck.castShadow = true;
      deck.receiveShadow = true;
      g.add(deck);
      for (const px of [len * 0.18, len * 0.72]) {
        const py = new THREE.Mesh(
          new THREE.BoxGeometry(1.6, h, 1.6),
          plainMat(color, { rough: 0.5 })
        );
        py.position.set(px, h / 2 + h * 0.12, 0);
        py.castShadow = true;
        g.add(py);
        const arm = new THREE.Mesh(
          new THREE.BoxGeometry(1.6, 1.2, Math.max(4, d) * 1.3),
          plainMat(color)
        );
        arm.position.set(px, h * 1.05, 0);
        g.add(arm);
      }
      const cablePts = [];
      for (let i = 0; i <= 16; i++) {
        const t = i / 16;
        const x = t * len;
        const sag = Math.sin(t * Math.PI * 2) * -1.6;
        cablePts.push(
          x,
          h * 1.05 + sag - Math.abs(Math.sin(t * Math.PI)) * 1.2,
          Math.max(4, d) * 0.55,
          x,
          h * 1.05 + sag - Math.abs(Math.sin(t * Math.PI)) * 1.2,
          -Math.max(4, d) * 0.55
        );
      }
      const cg = new THREE.BufferGeometry();
      cg.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(cablePts, 3)
      );
      g.add(
        new THREE.LineSegments(
          cg,
          new THREE.LineBasicMaterial({
            color: new THREE.Color(color),
            transparent: true,
            opacity: 0.55,
          })
        )
      );
      const lamp = new THREE.Mesh(
        new THREE.BoxGeometry(len * 0.94, 0.16, 0.3),
        glowMat(color, 0.7)
      );
      lamp.position.set(len / 2, h * 0.68, 0);
      g.add(lamp);
      g.userData.bridgeFar = new THREE.Vector3(len + 16, 0, 0);
      break;
    }
    case "tank": {
      const r = Math.max(1.5, Math.min(w, d) / 2);
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(r, r, h * 0.78, 20),
        plainMat(color, { rough: 0.42, metal: 0.35 })
      );
      body.position.y = (h * 0.78) / 2;
      body.castShadow = true;
      g.add(body);
      const dome = new THREE.Mesh(
        new THREE.SphereGeometry(r, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2),
        plainMat(color, { rough: 0.35, metal: 0.4 })
      );
      dome.position.y = h * 0.78;
      dome.scale.y = 0.55;
      dome.castShadow = true;
      g.add(dome);
      const band = new THREE.Mesh(
        new THREE.TorusGeometry(r * 1.03, 0.16, 6, 22),
        plainMat("#aab6c4", { metal: 0.5 })
      );
      band.rotation.x = Math.PI / 2;
      band.position.y = h * 0.5;
      g.add(band);
      const rail = new THREE.Mesh(
        new THREE.TorusGeometry(r * 1.05, 0.1, 5, 22),
        glowMat(color, 0.55)
      );
      rail.rotation.x = Math.PI / 2;
      rail.position.y = h * 0.8;
      g.add(rail);
      for (const s of [-1, 1]) {
        const pipe = new THREE.Mesh(
          new THREE.CylinderGeometry(0.32, 0.32, r * 1.9, 8),
          plainMat("#93a0b0", { metal: 0.45 })
        );
        pipe.rotation.z = Math.PI / 2;
        pipe.position.set(s * r * 1.1, h * 0.24, 0);
        g.add(pipe);
      }
      break;
    }
    case "bunker": {
      const r = Math.max(w, d) / 2;
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 0.72, r, h, 4),
        plainMat(color, { rough: 0.92 })
      );
      body.rotation.y = Math.PI / 4;
      body.position.y = h / 2;
      body.castShadow = true;
      body.receiveShadow = true;
      g.add(body);
      const cap = new THREE.Mesh(
        new THREE.BoxGeometry(r * 1.05, h * 0.14, r * 1.05),
        plainMat("#6c7684", { rough: 0.8 })
      );
      cap.position.y = h + h * 0.06;
      cap.castShadow = true;
      g.add(cap);
      const slit = new THREE.Mesh(
        new THREE.BoxGeometry(r * 1.1, 0.5, 0.25),
        glowMat(color, 0.75)
      );
      slit.position.set(0, h * 0.62, r * 0.78);
      g.add(slit);
      const hatch = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 0.28, r * 0.28, 0.4, 12),
        plainMat("#8e9aa8", { metal: 0.5 })
      );
      hatch.position.y = h + h * 0.14;
      g.add(hatch);
      break;
    }
    default: {
      const body = boxed(w, h, d, color);
      body.position.y = h / 2;
      roofUnits(w, h, d, 2);
    }
  }

  // per-district activity light on top of every building
  const actMat = glowMat(color, 0.5);
  const act = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), actMat);
  act.position.set(w * 0.32, h + 1.1, d * 0.32);
  g.add(act);
  animated.push({
    type: "activity",
    mat: actMat,
    districtId,
    phase: Math.random() * 6,
  });
  activity.push(actMat);

  return g;
}

function addConveyor(
  g: THREE.Group,
  w: number,
  d: number,
  convTex: THREE.Texture,
  plainMat: (hex: string, options?: KitOptions) => THREE.MeshStandardMaterial,
  animated: AnimationRecord[]
): void {
  const belt = new THREE.Mesh(
    new THREE.BoxGeometry(w * 1.5, 0.4, 2.2),
    new THREE.MeshStandardMaterial({
      map: convTex,
      roughness: 0.8,
      metalness: 0.15,
    })
  );
  belt.position.set(0, 1.2, d / 2 + 2.6);
  g.add(belt);
  for (let i = 0; i < 5; i++) {
    const leg = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.18, 1.2, 6),
      plainMat("#6b7686", { metal: 0.4 })
    );
    leg.position.set(-w * 0.7 + (i * (w * 1.4)) / 4, 0.6, d / 2 + 2.6);
    g.add(leg);
  }
  animated.push({ type: "conveyor", tex: convTex });
}

function addClock(
  g: THREE.Group,
  w: number,
  h: number,
  d: number,
  plainMat: (hex: string, options?: KitOptions) => THREE.MeshStandardMaterial,
  glowMat: (hex: string, base?: number) => THREE.MeshBasicMaterial,
  animated: AnimationRecord[]
): void {
  const face = new THREE.Mesh(
    new THREE.CylinderGeometry(w * 0.32, w * 0.32, 0.3, 20),
    plainMat("#f2f5f9", { rough: 0.5 })
  );
  face.rotation.x = Math.PI / 2;
  face.position.set(0, h * 0.82, d / 2 + 0.2);
  g.add(face);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(w * 0.34, 0.12, 6, 24),
    glowMat("#ad8b00", 0.7)
  );
  ring.position.set(0, h * 0.82, d / 2 + 0.3);
  g.add(ring);
  const hand = (len, wdt, col) => {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(wdt, len, 0.12),
      plainMat(col, { rough: 0.4 })
    );
    const pivot = new THREE.Group();
    m.position.y = len / 2;
    pivot.add(m);
    pivot.position.set(0, h * 0.82, d / 2 + 0.4);
    g.add(pivot);
    return pivot;
  };
  const minute = hand(w * 0.26, 0.16, "#1b2331");
  const hour = hand(w * 0.17, 0.22, "#1b2331");
  animated.push({ type: "clock", minute, hour });
}
