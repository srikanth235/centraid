// main.js — bootstrap: renderer, camera, controls, picking, camera tweens, frame loop.
// Content (copy + city plan) comes from ./content.js. Rendering lives in world.js,
// the economy in sim.js, the DOM in ui.js.
// governance: allow-repo-hygiene file-size-limit — 709 lines against a 625 cap; the
// bootstrap is one linear wiring sequence and an early split would just add indirection.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import { createSim } from "./sim.js";
import {
  createLoading,
  createHud,
  createInspector,
  createTour,
  createToast,
  createHoverTip,
  createMinimap,
} from "./ui.js";
import { createWorld } from "./world.js";

/* ------------------------------------------------------------------ content */

let content;
let contentFallback = false;
try {
  content = await import("./content.js");
} catch {
  content = await import("./content.sample.js");
  contentFallback = true;
}
const meta = content.meta || {};
const districtsData = content.districts || [];

/* ------------------------------------------------------------------ renderer */

const stage = document.querySelector("#stage");
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.02;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false; // static scene: bake once, refresh on demand
stage.append(renderer.domElement);

const world = createWorld(content);
const sim = createSim(content);
const scene = world.scene;

/* ------------------------------------------------------------------ camera */

const bounds = new THREE.Box3();
for (const d of districtsData) {
  if (!d || !d.plate) continue;
  bounds.expandByPoint(
    new THREE.Vector3(d.plate.x - d.plate.w / 2, 0, d.plate.z - d.plate.d / 2)
  );
  bounds.expandByPoint(
    new THREE.Vector3(d.plate.x + d.plate.w / 2, 0, d.plate.z + d.plate.d / 2)
  );
}
if (bounds.isEmpty())
  bounds.set(new THREE.Vector3(-80, 0, -80), new THREE.Vector3(80, 0, 80));
const cityCenter = bounds.getCenter(new THREE.Vector3());
const citySize = bounds.getSize(new THREE.Vector3());
const citySpan = Math.max(citySize.x, citySize.z, 60);

const camera = new THREE.PerspectiveCamera(
  46,
  window.innerWidth / window.innerHeight,
  0.5,
  1400
);

// Frame the whole plan for the current aspect ratio, looking in from the south-east.
const HOME = {
  target: new THREE.Vector3(cityCenter.x, 4, cityCenter.z),
  pos: new THREE.Vector3(),
};
function computeHome() {
  const radius = 0.5 * Math.hypot(citySize.x, citySize.z) + 12;
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const dist =
    Math.max(radius / Math.tan(vFov / 2), radius / Math.tan(hFov / 2)) * 0.92;
  const elev = THREE.MathUtils.degToRad(34);
  const azim = THREE.MathUtils.degToRad(28);
  const flat = Math.cos(elev) * dist;
  HOME.pos.set(
    cityCenter.x + Math.sin(azim) * flat,
    Math.sin(elev) * dist,
    cityCenter.z + Math.cos(azim) * flat
  );
}
computeHome();
camera.position.copy(HOME.pos);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.rotateSpeed = 0.65;
controls.zoomSpeed = 0.85;
controls.panSpeed = 0.7;
controls.screenSpacePanning = false;
controls.minDistance = 16;
controls.maxDistance = citySpan * 2.4;
controls.maxPolarAngle = Math.PI * 0.487; // never dip under the ground plane
controls.minPolarAngle = 0.12;
controls.target.copy(HOME.target);

// This is a map, so it obeys map conventions: left-drag grabs the ground and moves it, and a
// modifier turns the same drag into an orbit. OrbitControls ships the inverse (left orbits,
// right pans), which reads as a dead control to anyone who expects to drag the city around.
// Two fingers on a trackpad pan too, since that gesture arrives as a wheel with ctrlKey unset.
controls.mouseButtons = {
  LEFT: THREE.MOUSE.PAN,
  MIDDLE: THREE.MOUSE.PAN,
  RIGHT: THREE.MOUSE.ROTATE,
};
controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };

let rotateModifier = false;
function setRotateModifier(on) {
  if (rotateModifier === on) return;
  rotateModifier = on;
  controls.mouseButtons.LEFT = on ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
}
// Shift/Ctrl/Cmd, matching every other 3D map. Space would also fire whichever chapter
// button holds focus, so it stays out of this.
const isRotateKey = (e) => e.shiftKey || e.ctrlKey || e.metaKey;
window.addEventListener("keydown", (e) => setRotateModifier(isRotateKey(e)));
window.addEventListener("keyup", (e) => setRotateModifier(isRotateKey(e)));
// Releasing the key outside the window would otherwise latch the modifier on forever.
window.addEventListener("blur", () => setRotateModifier(false));
// A drag that starts with the modifier already held must orbit even if no key event
// reached this window first (click into the page while holding Shift).
renderer.domElement.addEventListener(
  "pointerdown",
  (e) => setRotateModifier(isRotateKey(e)),
  true
);

controls.update();

/* ------------------------------------------------------------------ camera tween */

const tween = {
  active: false,
  t: 0,
  dur: 1,
  fromPos: new THREE.Vector3(),
  toPos: new THREE.Vector3(),
  fromTgt: new THREE.Vector3(),
  toTgt: new THREE.Vector3(),
};
const easeInOutCubic = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

function flyTo(targetVec, distance, dur = 1.5) {
  const dir = new THREE.Vector3().subVectors(targetVec, cityCenter);
  dir.y = 0;
  if (dir.lengthSq() < 1) dir.set(0.35, 0, 1);
  dir.normalize();
  const pos = new THREE.Vector3(
    targetVec.x + dir.x * distance * 0.92,
    targetVec.y + distance * 0.66,
    targetVec.z + dir.z * distance * 0.92
  );
  // keep the shot inside the orbit limits
  const d = pos.distanceTo(targetVec);
  if (d > controls.maxDistance)
    pos.lerp(targetVec, 1 - controls.maxDistance / d);
  tween.fromPos.copy(camera.position);
  tween.fromTgt.copy(controls.target);
  tween.toPos.copy(pos);
  tween.toTgt.copy(targetVec);
  tween.t = 0;
  tween.dur = dur;
  tween.active = true;
  controls.enabled = false;
}

function cancelTween() {
  if (!tween.active) return;
  tween.active = false;
  controls.enabled = true;
}
renderer.domElement.addEventListener("pointerdown", cancelTween);
renderer.domElement.addEventListener("wheel", cancelTween, { passive: true });

function focusDistrict(id, buildingId) {
  const rec = world.byId.get(id);
  if (!rec) return;
  if (buildingId) {
    const b = rec.buildings.find((x) => x.data.id === buildingId);
    if (b) {
      const size = b.box.getSize(new THREE.Vector3());
      // frame the building itself, not the neighbourhood around it
      flyTo(
        b.center.clone(),
        Math.max(19, Math.max(size.x, size.y, size.z) * 2.05)
      );
      return;
    }
  }
  const p = rec.data.plate;
  flyTo(
    new THREE.Vector3(p.x, rec.plateTop + 6, p.z),
    Math.max(42, Math.max(p.w, p.d) * 1.15)
  );
}

function goHome() {
  tween.fromPos.copy(camera.position);
  tween.fromTgt.copy(controls.target);
  tween.toPos.copy(HOME.pos);
  tween.toTgt.copy(HOME.target);
  tween.t = 0;
  tween.dur = 1.4;
  tween.active = true;
  controls.enabled = false;
}

/* ------------------------------------------------------------------ UI */

const toast = createToast();
const hoverTip = createHoverTip();
const hud = createHud(content.hudStats, meta);
const minimap = createMinimap(world);

const inspector = createInspector({
  onFocus: (ref) => {
    select(ref.districtId, ref.buildingId);
    focusDistrict(ref.districtId, ref.buildingId);
  },
});

const districtNames = new Map(districtsData.map((d) => [d.id, d.name || d.id]));

// A chapter may pin the scenario it narrates, so the city actually shows what the text
// claims — every Scenarios chapter does, and several walkthrough chapters do too.
// Closing the card leaves that scenario running on purpose: the reader can keep watching
// what the chapter set up, and the next chapter that pins one takes over from there.
//
// `at` is the position within the chapter: which page, whether the chapter itself just
// changed, and the resolved building/flows for this page. The three things it drives run
// on different clocks — the camera moves every page, the flow spotlight is set every page
// (an absent `flows` releases it), but the scenario is pinned once on entering the
// chapter. Re-pinning it per page would restart the scenario's own timers, e.g. the
// offline drift that has to accumulate across the pages describing it.
const tour = createTour(content.tour, {
  districtNames,
  onEnter: (c, at) => {
    select(c.districtId, at.buildingId);
    focusDistrict(c.districtId, at.buildingId);
    btnTour.classList.add("on");
    if (at.chapterChanged && c.scenarioId && c.scenarioId !== sim.scenario)
      sim.setScenario(c.scenarioId);
    // world.js may not expose the spotlight yet — never let a page turn throw
    if (typeof world.setFlowFocus === "function")
      world.setFlowFocus(at.flows || null);
  },
  onExit: () => {
    btnTour.classList.remove("on");
    if (typeof world.setFlowFocus === "function") world.setFlowFocus(null);
    clearSelection();
    goHome();
  },
});

// Open on the first scenario content declares (the steady baseline) so the city is
// already alive before anyone opens a chapter.
const firstScenario = (content.scenarios || [])[0];
if (firstScenario) sim.setScenario(firstScenario.id);

const btnTour = document.querySelector("#btnTour");
const btnDayNight = document.querySelector("#btnDayNight");
// The top-bar button is the way into the book: it opens the table of contents rather
// than starting a fixed sequence.
btnTour.addEventListener("click", () => tour.togglePanel());
document.querySelector("#btnReset").addEventListener("click", () => {
  clearSelection();
  inspector.close();
  goHome();
});

let nightTarget = 0;
let nightNow = 0;
btnDayNight.addEventListener("click", () => {
  nightTarget = nightTarget > 0.5 ? 0 : 1;
  btnDayNight.classList.toggle("on", nightTarget > 0.5);
  btnDayNight.querySelector(".ic").textContent = nightTarget > 0.5 ? "☀" : "☾";
  btnDayNight.querySelector(".lbl").textContent =
    nightTarget > 0.5 ? "Day" : "Night";
});

// OrbitControls only binds arrow keys when listenToKeyEvents() is called, which this
// build never does — so the arrows are ours for page-turning.
function isTypingTarget(t) {
  if (!t || !t.tagName) return false;
  return (
    t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)
  );
}

window.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || isTypingTarget(e.target)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "Escape") {
    if (tour.panelOpen) tour.closePanel();
    else if (tour.active) tour.stop();
    else {
      inspector.close();
      clearSelection();
    }
  } else if (e.key === "ArrowRight" && tour.active) {
    // left/right read straight through, page by page, across chapter boundaries
    e.preventDefault();
    tour.next();
  } else if (e.key === "ArrowLeft" && tour.active) {
    e.preventDefault();
    tour.prev();
  } else if (e.key === "ArrowDown" && tour.active) {
    // up/down stay inside the chapter you are reading
    e.preventDefault();
    tour.nextInChapter();
  } else if (e.key === "ArrowUp" && tour.active) {
    e.preventDefault();
    tour.prevInChapter();
  }
});

/* ------------------------------------------------------------------ picking */

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2(-2, -2);
let pointerPx = { x: 0, y: 0 };
let hovered = null;
let selected = null;
let pointerDown = null;
let pointerMoved = false;

const pickRoots = world.districts.map((d) => d.group);

function resolvePick(obj) {
  let o = obj;
  while (o) {
    if (o.userData && o.userData.pick) return o;
    o = o.parent;
  }
  return null;
}

function pickAt() {
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(pickRoots, true);
  for (const h of hits) {
    if (h.object.isSprite) continue;
    const node = resolvePick(h.object);
    if (node) return node;
  }
  return null;
}

function recordOf(pick) {
  const rec = world.byId.get(pick.districtId);
  if (!rec) return null;
  if (pick.buildingId) {
    const b = rec.buildings.find((x) => x.data.id === pick.buildingId);
    if (b) return { rec, b };
  }
  return { rec, b: null };
}

const plateBoxes = new Map();
for (const rec of world.districts) {
  const p = rec.data.plate;
  plateBoxes.set(
    rec.data.id,
    new THREE.Box3(
      new THREE.Vector3(p.x - p.w / 2, rec.plateTop - 0.5, p.z - p.d / 2),
      new THREE.Vector3(p.x + p.w / 2, rec.plateTop + 1.6, p.z + p.d / 2)
    )
  );
}

function boxOf(pick) {
  const r = recordOf(pick);
  if (!r) return null;
  if (r.b) return r.b.box;
  return plateBoxes.get(r.rec.data.id) || null;
}

renderer.domElement.addEventListener("pointermove", (e) => {
  pointerPx = { x: e.clientX, y: e.clientY };
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  if (pointerDown) {
    const dx = e.clientX - pointerDown.x;
    const dy = e.clientY - pointerDown.y;
    if (dx * dx + dy * dy > 26) pointerMoved = true;
  }
});
renderer.domElement.addEventListener("pointerleave", () => {
  pointer.set(-2, -2);
  hoverTip.hide();
});
renderer.domElement.addEventListener("pointerdown", (e) => {
  pointerDown = { x: e.clientX, y: e.clientY };
  pointerMoved = false;
});
renderer.domElement.addEventListener("pointerup", (e) => {
  pointerDown = null;
  if (pointerMoved) return;
  // taps and synthetic clicks never send a pointermove first, so read the ray from the event
  pointerPx = { x: e.clientX, y: e.clientY };
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  const node = pickAt();
  if (!node) {
    clearSelection();
    inspector.close();
    return;
  }
  const p = node.userData.pick;
  select(p.districtId, p.buildingId);
});

function clearSelection() {
  selected = null;
  world.selectOutline.visible = false;
}

function select(districtId, buildingId) {
  const r = recordOf({ districtId, buildingId });
  if (!r) return;
  selected = { districtId, buildingId: r.b ? buildingId : null };
  world.frameOutline(world.selectOutline, boxOf(selected));
  world.selectOutline.material.color.set(r.rec.color);
  showInspector(r);
}

function showInspector(r) {
  const { rec, b } = r;
  const others = rec.buildings
    .filter((x) => !b || x.data.id !== b.data.id)
    .slice(0, 8)
    .map((x) => ({
      label: x.data.name || x.data.id,
      ref: { districtId: rec.data.id, buildingId: x.data.id },
    }));
  if (b) {
    inspector.show({
      title: b.data.name || b.data.id,
      subtitle: rec.data.name || rec.data.id,
      color: rec.color,
      lede: b.data.blurb,
      detail: b.data.detail,
      codeRef: b.data.codeRef,
      state: stateFor(rec.data.id),
      chips: others,
    });
  } else {
    inspector.show({
      title: rec.data.name || rec.data.id,
      subtitle: `${rec.buildings.length} structures`,
      color: rec.color,
      lede: rec.data.blurb,
      detail: "",
      codeRef: "",
      state: stateFor(rec.data.id),
      chips: others,
    });
  }
  inspector.current = {
    districtId: rec.data.id,
    buildingId: b ? b.data.id : null,
  };
}

const n1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : "–");
const n0 = (v) => (Number.isFinite(v) ? Math.round(v).toString() : "–");

function stateFor(districtId) {
  const s = sim.stats;
  const r = sim.rates;
  const rows = [];
  switch (districtId) {
    case "clients":
      rows.push(
        ["Requests out", `${n1(r.request)}/s`],
        ["Responses in", `${n1(r.response)}/s`]
      );
      break;
    case "gateway":
      rows.push(
        ["Requests in", `${n1(r.request)}/s`],
        ["Turns", `${n1(s.turns)}/s`]
      );
      break;
    case "runtime":
      rows.push(
        ["Turns", `${n1(s.turns)}/s`],
        ["Items appended", `${n1(s.items)}/s`]
      );
      break;
    case "consent":
      rows.push(["Tool calls", `${n1(r.tool)}/s`], ["Parked", n0(s.approvals)]);
      break;
    case "vault":
      rows.push(["Writes", `${n1(r.wal)}/s`], ["WAL", `${n0(s.wal)} KiB/s`]);
      break;
    case "wal":
      rows.push(
        ["WAL", `${n0(s.wal)} KiB/s`],
        ["Segments shipped", `${n1(r.ship)}/s`]
      );
      break;
    case "apps":
      rows.push(
        ["App requests", `${n1(r.appReq)}/s`],
        ["App writes", `${n1(r.appWrite)}/s`]
      );
      break;
    case "automation":
      rows.push(
        ["Next cron", `${n0(s.cron)}s`],
        ["Runs", `${n1(r.automation)}/s`]
      );
      break;
    case "cas":
      rows.push(
        ["Occupancy", `${n0(s.cas)}%`],
        ["Blobs in", `${n1(r.blob)}/s`]
      );
      break;
    case "sync":
      rows.push(
        ["Replica lag", `${n1(s.lag)}s`],
        ["Segments", `${n1(r.replica)}/s`]
      );
      break;
    case "backup":
      rows.push(
        ["Snapshots", `${n1(r.backup)}/s`],
        ["WAL", `${n0(s.wal)} KiB/s`]
      );
      break;
    default:
      rows.push(["Turns", `${n1(s.turns)}/s`], ["Items", `${n1(s.items)}/s`]);
  }
  rows.push(["Scenario", sim.scenario]);
  return rows;
}

/* ------------------------------------------------------------------ resize */

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  computeHome();
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(w, h);
  renderer.shadowMap.needsUpdate = true;
}
window.addEventListener("resize", resize);

/* ------------------------------------------------------------------ loop */

const clock = new THREE.Clock();
let elapsed = 0;
let frames = 0;
let fpsAcc = 0;
let hudAcc = 0;
let inspAcc = 0;
let hoverAcc = 0;

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, clock.getDelta());
  elapsed += dt;

  // fps
  frames++;
  fpsAcc += dt;
  if (fpsAcc >= 0.5) {
    sim.stats.fps = frames / fpsAcc;
    frames = 0;
    fpsAcc = 0;
  }

  // camera tween
  if (tween.active) {
    tween.t += dt / tween.dur;
    const k = easeInOutCubic(Math.min(1, tween.t));
    camera.position.lerpVectors(tween.fromPos, tween.toPos, k);
    controls.target.lerpVectors(tween.fromTgt, tween.toTgt, k);
    if (tween.t >= 1) {
      tween.active = false;
      controls.enabled = true;
    }
  }

  // keep the camera above ground and roughly over the city
  controls.target.x = THREE.MathUtils.clamp(
    controls.target.x,
    cityCenter.x - 180,
    cityCenter.x + 180
  );
  controls.target.z = THREE.MathUtils.clamp(
    controls.target.z,
    cityCenter.z - 180,
    cityCenter.z + 180
  );
  controls.target.y = THREE.MathUtils.clamp(controls.target.y, -8, 40);
  controls.update();
  if (camera.position.y < 3) camera.position.y = 3;

  // day / night
  if (Math.abs(nightNow - nightTarget) > 0.001) {
    nightNow += (nightTarget - nightNow) * Math.min(1, dt * 2.2);
    world.applyNight(nightNow);
  }

  sim.tick(dt);
  sim.drainEvents();
  world.update(dt, elapsed, sim);

  // hover — raycasting the whole city is the most expensive thing per frame, so it runs
  // at ~12 Hz and only when the pointer is actually over the canvas.
  hoverAcc += dt;
  if (!tween.active && pointer.x > -1.5 && hoverAcc >= 0.08) {
    hoverAcc = 0;
    const node = pickAt();
    const pick = node ? node.userData.pick : null;
    const key = pick ? `${pick.districtId}:${pick.buildingId || ""}` : null;
    if (key !== hovered) {
      hovered = key;
      if (pick) {
        const r = recordOf(pick);
        world.frameOutline(world.hoverOutline, boxOf(pick));
        if (r) {
          hoverTip.show(
            r.b
              ? r.b.data.name || r.b.data.id
              : r.rec.data.name || r.rec.data.id,
            r.b ? r.rec.data.name || "" : "district",
            pointerPx.x,
            pointerPx.y
          );
        }
        renderer.domElement.style.cursor = "pointer";
      } else {
        world.hoverOutline.visible = false;
        hoverTip.hide();
        renderer.domElement.style.cursor = "grab";
      }
    } else if (pick) {
      hoverTip.move(pointerPx.x, pointerPx.y);
    }
  } else if (hovered) {
    hoverTip.move(pointerPx.x, pointerPx.y);
  }

  // HUD + minimap at a calmer cadence
  hudAcc += dt;
  if (hudAcc >= 0.1) {
    hudAcc = 0;
    hud.update(sim.stats);
    minimap(
      camera,
      controls,
      selected ? selected.districtId : hovered ? hovered.split(":")[0] : null
    );
  }
  inspAcc += dt;
  if (inspAcc >= 0.5) {
    inspAcc = 0;
    if (inspector.isOpen && inspector.current)
      inspector.refreshState(stateFor(inspector.current.districtId));
  }

  renderer.render(scene, camera);
}

/* ------------------------------------------------------------------ go */

// small debug handle (renderer.info, sim state) — handy when tuning, harmless otherwise
window.__city = { renderer, scene, camera, controls, world, sim };

// one warm-up frame so the shadow map bakes with everything in place
renderer.render(scene, camera);
renderer.shadowMap.needsUpdate = true;
renderer.render(scene, camera);
frame();

createLoading(meta, () => {
  if (contentFallback)
    toast("content.js not found — running the development fixture.", 5000);
  // A shared link like …/#chapter-10 opens straight into that chapter once the scene is
  // ready; otherwise settle on the establishing shot.
  tour.applyHash();
  if (!tour.active) goHome();
});
