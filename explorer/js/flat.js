// governance: allow-repo-hygiene file-size-limit — the 2D renderer mirrors isle.js landmark-for-landmark at the same coordinates; a split would desync the two worlds' shared shape.
/* ============================================================================
   FLAT — the 2D schematic of the Sovereign Isle.
   Same world, same coordinates (x east, z north), same API as ISLE.
   The journey engine drives either renderer transparently.
   Luminous ink-on-dark: districts as glowing plates, landmarks as glyphs.
   ============================================================================ */
"use strict";

window.FLAT = (() => {
  const cvs = document.getElementById("flat");
  const g = cvs.getContext("2d");
  const HUE = ISLE.HUE,
    MAP = ISLE.MAP,
    ANCHORS = ISLE.ANCHORS;
  const hex = (n) => "#" + n.toString(16).padStart(6, "0");

  const anim = [];
  const frameHooks = [];
  const W = 6,
    INK = "#0d0e14";

  /* ---------- camera ---------- */
  let cam = { x: -6, y: 10, z: 3.4 }; // y here is world -z (north up)
  let goal = { ...cam };
  const FOCI = {
    isle: { x: -6, y: 10, z: 3.2 },
    vault: { x: 0, y: -2, z: 9 },
    gate: { x: 0, y: 46, z: 8 },
    keycab: { x: 14, y: 45, z: 16 },
    clerk: { x: 0, y: 27, z: 15 },
    ledger: { x: 34, y: 4, z: 9 },
    harness: { x: 53, y: -8, z: 10 },
    automation: { x: -35, y: 2, z: 9 },
    commons: { x: -40, y: -22, z: 11 },
    cellar: { x: 26, y: -30, z: 9 },
    apps: { x: 40, y: 42, z: 7 },
    mobile: { x: -34, y: 74, z: 12 },
    web: { x: 68, y: 34, z: 12 },
    desktop: { x: 0, y: 96, z: 12 },
    companion: { x: -80, y: 46, z: 16 },
    warehouse: { x: -108, y: -6, z: 9 },
    bridge: { x: 0, y: 68, z: 10 },
    relay: { x: 58, y: 36, z: 14 },
  };
  function fly(focus, tweak) {
    const v = FOCI[focus] || FOCI.isle;
    goal = {
      x: tweak && tweak.target ? tweak.target[0] : v.x,
      y: tweak && tweak.target ? -tweak.target[2] : v.y,
      z: tweak && tweak.r != null ? Math.max(4, 260 / tweak.r) : v.z,
    };
  }

  /* ---------- state ---------- */
  let night = false,
    buildP = 1;
  const pulses = new Map();
  const parcels = new Map();
  let parcelSeq = 0;
  const tethers = {};
  let outboxN = 0,
    scopesN = 0,
    packOn = false,
    copiedN = 0,
    syncOn = false;

  function resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    cvs.width = innerWidth * dpr;
    cvs.height = innerHeight * dpr;
    cvs.style.width = innerWidth + "px";
    cvs.style.height = innerHeight + "px";
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  addEventListener("resize", resize);
  resize();

  function toScreen(x, wz) {
    return [
      (x - cam.x) * cam.z + innerWidth / 2,
      (wz - cam.y) * cam.z + innerHeight / 2,
    ];
  }
  function project(v) {
    const [sx, sy] = toScreen(v.x, v.z);
    return { x: sx, y: sy, behind: false };
  }
  function vec(x, y, z) {
    return { x, y, z };
  }

  /* ---------- helpers ---------- */
  function glow(x, z, r, color, a) {
    const [sx, sy] = toScreen(x, z);
    const rg = g.createRadialGradient(sx, sy, 0, sx, sy, r * cam.z);
    rg.addColorStop(
      0,
      color +
        Math.round((a ?? 0.5) * 255)
          .toString(16)
          .padStart(2, "0")
    );
    rg.addColorStop(1, color + "00");
    g.fillStyle = rg;
    g.beginPath();
    g.arc(sx, sy, r * cam.z, 0, 7);
    g.fill();
  }
  function plate(x, z, w, d, color, rot) {
    const [sx, sy] = toScreen(x, z);
    g.save();
    g.translate(sx, sy);
    if (rot) g.rotate(-rot);
    g.fillStyle = color + "26";
    g.strokeStyle = color;
    g.lineWidth = 1.6;
    g.beginPath();
    g.roundRect((-w * cam.z) / 2, (-d * cam.z) / 2, w * cam.z, d * cam.z, 6);
    g.fill();
    g.stroke();
    g.restore();
  }
  function dot(x, z, r, color, a) {
    const [sx, sy] = toScreen(x, z);
    g.fillStyle = color;
    g.globalAlpha = a ?? 1;
    g.beginPath();
    g.arc(sx, sy, r, 0, 7);
    g.fill();
    g.globalAlpha = 1;
  }
  function ring(x, z, r, color, a, lw) {
    const [sx, sy] = toScreen(x, z);
    g.strokeStyle = color;
    g.globalAlpha = a ?? 1;
    g.lineWidth = lw || 2;
    g.beginPath();
    g.arc(sx, sy, r * cam.z, 0, 7);
    g.stroke();
    g.globalAlpha = 1;
  }

  /* ---------- the isle, glyph by glyph ---------- */
  function drawIsle() {
    const t = perfNow / 1000;
    // ground disc + rim
    const [cx, cy] = toScreen(0, 0);
    const R = 74 * cam.z;
    g.fillStyle = "#191b28";
    g.beginPath();
    g.arc(cx, cy, R, 0, 7);
    g.fill();
    g.strokeStyle = hex(HUE.slate);
    g.lineWidth = 2.4;
    g.globalAlpha = 0.8;
    g.beginPath();
    g.arc(cx, cy, R + 2, 0, 7);
    g.stroke();
    g.globalAlpha = 1;
    for (const rr of [22, 36, 50, 64]) ring(0, 0, rr, hex(HUE.slate), 0.12, 1);

    // districts
    plate(0, 42, 26, 20, hex(HUE.slate));
    plate(34, 6, 26, 22, hex(HUE.amber), 0.16);
    plate(-35, 2, 24, 24, hex(HUE.violet), 0.14);
    plate(-40, -22, 20, 17, hex(HUE.forest), 0.2);
    plate(26, -30, 24, 18, hex(HUE.teal), 0.22);
    plate(52, -8, 20, 26, hex(HUE.ochre), 0.1);

    // ── vault: drum + dome + seams + cell ticks ──
    ring(0, -2, 13.5, "#4a4e6a", 1, 3);
    ring(0, -2, 10.5, "#33354a", 1, 2);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI;
      g.strokeStyle = hex(HUE.warm);
      g.lineWidth = 1.8;
      g.globalAlpha = 0.8;
      g.beginPath();
      g.arc(...toScreen(0, -2), 10.6 * cam.z, a, a + 0.9);
      g.stroke();
      g.globalAlpha = 1;
    }
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2,
        rr = 12.9;
      const lit = i % 3 === 0;
      const copied = lit && ((i / 3) | 0) < copiedN;
      dot(
        Math.cos(a) * rr,
        -2 + Math.sin(a) * rr,
        2.6,
        copied ? hex(HUE.net) : lit ? "#9fb4d8" : "#3a3d52",
        lit ? 1 : 0.8
      );
    }
    glow(0, -2, 10, hex(HUE.warm), 0.22 + Math.sin(t) * 0.06);
    dot(0, 8.5, 3, hex(HUE.warm), 0.9); // the door

    // ── gatehouse: towers + portcullis ──
    for (const sx of [-4.2, 4.2]) {
      dot(sx, 52.5, 3.4, "#5a648c", 1);
      ring(sx, 52.5, 4.6, hex(HUE.slate), 0.8, 1.6);
    }
    g.strokeStyle = hex(HUE.slate);
    g.lineWidth = 2;
    const [gx, gy] = toScreen(0, 52.5);
    g.strokeRect(gx - (9 * cam.z) / 2, gy - 2, 9 * cam.z, 4);
    glow(0, 52.5, 6, hex(HUE.slate), 0.3);

    // ── key cabinet + keyring ──
    dot(15.5, 46, 2.6, hex(HUE.warm), 1);
    ring(15.5, 46, 4.4, hex(HUE.warm), 0.8, 1.4);
    for (let i = 0; i < 3; i++) {
      const a = t * 1.4 + (i / 3) * 7;
      dot(
        15.5 + Math.cos(a) * 2.6,
        46 + Math.sin(a) * 2.6,
        1.4,
        hex(HUE.warm),
        0.9
      );
    }

    // ── consent desk: arch + three lamps ──
    const [kx, ky] = toScreen(0, 24);
    g.strokeStyle = hex(HUE.violet);
    g.lineWidth = 2.2;
    g.beginPath();
    g.arc(kx, ky, 3.4 * cam.z, Math.PI * 0.15, Math.PI * 0.85, false);
    g.stroke();
    [
      [-1, HUE.forest],
      [0, HUE.warm],
      [1, HUE.net],
    ].forEach(([dx, c], i) =>
      dot(dx, 27, 1.6, hex(c), 0.55 + Math.max(0, Math.sin(t * 2 + i)) * 0.45)
    );

    // ── ledger: open book ──
    g.save();
    const [lx, ly] = toScreen(34, 4);
    g.translate(lx, ly);
    g.rotate(0.16);
    g.fillStyle = "#4a3a22";
    g.beginPath();
    g.roundRect(-10.5 * cam.z, -7 * cam.z, 21 * cam.z, 14 * cam.z, 3);
    g.fill();
    g.fillStyle = "#d8cdb2";
    for (const s of [-1, 1]) {
      g.save();
      g.translate(s * 5 * cam.z, 0);
      g.rotate(-s * 0.1);
      g.beginPath();
      g.roundRect(-4.8 * cam.z, -6.2 * cam.z, 9.6 * cam.z, 12.4 * cam.z, 2);
      g.fill();
      g.fillStyle = hex(HUE.warm);
      for (let i = 0; i < 6; i++) {
        g.globalAlpha =
          0.5 +
          Math.max(0, Math.sin(t * 0.9 - (i + (s > 0 ? 6 : 0)) * 0.55)) * 0.5;
        g.fillRect(-3.8 * cam.z, (-5 + i * 1.85) * cam.z, 7.6 * cam.z, 1.4);
      }
      g.globalAlpha = 1;
      g.fillStyle = "#d8cdb2";
      g.restore();
    }
    g.restore();
    glow(34, 4, 9, hex(HUE.amber), 0.18);

    // ── harness row: three sheds + coupling ring ──
    const sheds = [
      [52, -14, HUE.warm],
      [56, -6, HUE.slate],
      [50, -1, HUE.forest],
    ];
    sheds.forEach(([hx, hz, c], i) => {
      const [sx, sy] = toScreen(hx, hz);
      g.fillStyle = "#3a3d52";
      g.beginPath();
      g.roundRect(
        sx - 2.3 * cam.z,
        sy - 1.7 * cam.z,
        4.6 * cam.z,
        3.4 * cam.z,
        3
      );
      g.fill();
      dot(
        hx,
        hz,
        1.6,
        hex(c),
        0.5 + Math.max(0, Math.sin(t * 1.1 + i * 2.2)) * 0.5
      );
    });
    ring(43, -2, 1.8, hex(HUE.ochre), 0.8 + Math.sin(t * 0.6) * 0.2, 2);

    // ── automation: gear glyph ──
    const [ax, ay] = toScreen(-35, 2);
    g.save();
    g.translate(ax, ay);
    g.rotate(t * 0.35);
    g.strokeStyle = hex(HUE.violet);
    g.lineWidth = 2.4;
    g.beginPath();
    g.arc(0, 0, 3.4 * cam.z, 0, 7);
    g.stroke();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * 7;
      g.fillStyle = hex(HUE.violet);
      g.fillRect(
        Math.cos(a) * 3.9 * cam.z - 1.4,
        Math.sin(a) * 3.9 * cam.z - 1.4,
        2.8,
        2.8
      );
    }
    g.restore();
    glow(-35, 2, 7, hex(HUE.violet), 0.2);

    // ── commons: stone ring + table ──
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * 7;
      dot(-40 + Math.cos(a) * 6.2, -22 + Math.sin(a) * 6.2, 1.6, "#4e7a5e", 1);
    }
    ring(-40, -22, 6.2, hex(HUE.forest), 0.8, 1.8);
    dot(-40, -22, 3.2, hex(HUE.forest), 0.5);

    // ── blob cellar: crate grid ──
    for (let ix = 0; ix < 5; ix++)
      for (let iz = 0; iz < 4; iz++) {
        const bx = 19 + ix * 3.4 + iz * 0.8,
          bz = -36 + iz * 3.6 - ix * 0.6;
        const [sx, sy] = toScreen(bx, bz);
        g.fillStyle = (ix + iz) % 3 === 0 ? "#4d7a8c" : "#38596a";
        g.fillRect(
          sx - 1.3 * cam.z,
          sy - 1.3 * cam.z,
          2.6 * cam.z,
          2.6 * cam.z
        );
      }

    // ── app pavilions ──
    const APPC = [
      HUE.slate,
      HUE.violet,
      HUE.amber,
      HUE.rose,
      HUE.indigo,
      HUE.ochre,
      HUE.teal,
      HUE.forest,
    ];
    APPC.forEach((c, i) => {
      const a = ((16 + i * 8) * Math.PI) / 180;
      const px = Math.cos(a) * 62,
        pz = Math.sin(a) * 62;
      ring(px, pz, 3.6, hex(c), 0.9, 1.6);
      dot(px, pz, 1.5, hex(c), 0.9);
    });

    // ── bridge ──
    g.strokeStyle = "#4a4e6a";
    g.lineWidth = 3;
    g.beginPath();
    let prev = toScreen(0, 57);
    g.moveTo(prev[0], prev[1]);
    for (let i = 1; i < 9; i++) {
      const q = toScreen(0, 57 + i * 4.2);
      g.lineTo(q[0], q[1]);
    }
    g.stroke();

    // ── device islets ──
    const islets = [
      [-34, 74, 9, HUE.indigo],
      [72, 34, 7.5, HUE.relay],
      [0, 97, 10.5, HUE.slate],
      [-80, 46, 5, HUE.rose],
    ];
    islets.forEach(([ix, iz, ir, c]) => {
      ring(ix, iz, ir, "#4a4e6a", 0.9, 2);
      dot(ix, iz, ir * 0.5, "#20222e", 1);
    });
    // phone screen + scope stacks + pack + outbox
    dot(-34, 74, 2.4, hex(HUE.indigo), 0.95);
    for (let i = 0; i < scopesN; i++)
      dot(
        -39.5 + i * 2.7,
        70.2 - i * 0.35,
        1.7,
        [HUE.slate, HUE.teal, HUE.violet, HUE.forest][i] | 0,
        0.95
      );
    if (packOn)
      for (let i = 0; i < 3; i++)
        dot(
          -29 + (i - 1) * 0.9,
          76.5 + (i - 1) * 0.5,
          1.1,
          hex(HUE.amber),
          0.9
        );
    for (let i = 0; i < outboxN; i++)
      dot(-31.4 + i * 1.1, 71.4 - i * 0.5, 1.4, hex(HUE.warm), 0.95);

    // web screen + relay beacon
    dot(72, 34, 2, hex(HUE.relay), 0.9);
    const b = t * 0.8;
    dot(
      60 + Math.cos(b) * 0.6,
      36 + Math.sin(b) * 0.6,
      2.6,
      hex(HUE.relay),
      0.9
    );
    ring(60, 36, 5, hex(HUE.relay), 0.4, 1.4);

    // desktop + companion
    dot(0, 97, 2.2, hex(HUE.slate), 0.9);
    dot(-80, 46, 1.6, hex(HUE.rose), 0.9);

    // ── warehouse + kit + sealed crates ──
    const [wx, wy] = toScreen(-112, -6);
    g.fillStyle = "#3c4050";
    g.beginPath();
    g.roundRect(wx - 6 * cam.z, wy - 4 * cam.z, 12 * cam.z, 8 * cam.z, 3);
    g.fill();
    g.strokeStyle = hex(HUE.net);
    g.lineWidth = 1.6;
    g.stroke();
    glow(-112, -6, 10, hex(HUE.net), 0.25);
    dot(-105, 0.5, 1.8, hex(HUE.warm), 0.95);
    ring(-105, 0.5, 3, hex(HUE.warm), 0.6, 1.4);
    [
      [-106, -12],
      [-103, -13.5],
      [-104.6, -12.6],
    ].forEach(([cxx, czz]) => {
      dot(cxx, czz, 1.6, "#31404e", 1);
      dot(cxx, czz, 0.6, hex(HUE.net), 1);
    });

    // ── tethers ──
    const tetherDefs = {
      mobile: [[-6, 52], [-34, 72], HUE.indigo],
      companion: [[-52, 30], [-77, 44], HUE.rose],
      warehouse: [[-58, 10], [-108, -5], HUE.net],
      egress: [[56, -6], [110, -55], HUE.violet],
      web1: [[36, 28], [60, 36], HUE.relay],
      web2: [[60, 36], [69, 32], HUE.relay],
    };
    for (const name in tetherDefs) {
      const [x1, z1, x2, z2, c] = [
        tetherDefs[name][0][0],
        tetherDefs[name][0][1],
        tetherDefs[name][1][0],
        tetherDefs[name][1][1],
        tetherDefs[name][2],
      ];
      const cut = tethers[name]?.cut;
      const [ax2, ay2] = toScreen(x1, z1),
        [bx2, by2] = toScreen(x2, z2);
      const mx = (ax2 + bx2) / 2 + (by2 - ay2) * 0.18,
        my = (ay2 + by2) / 2 - (bx2 - ax2) * 0.18;
      g.strokeStyle = hex(c);
      g.globalAlpha = cut ? 0.1 : 0.55;
      g.lineWidth = 1.6;
      if (cut) g.setLineDash([3, 6]);
      g.beginPath();
      g.moveTo(ax2, ay2);
      g.quadraticCurveTo(mx, my, bx2, by2);
      g.stroke();
      g.setLineDash([]);
      g.globalAlpha = 1;
      if (!cut) {
        const n = 9;
        for (let i = 1; i < n; i++) {
          const u = i / n,
            iu = 1 - u;
          const px = iu * iu * ax2 + 2 * iu * u * mx + u * u * bx2;
          const py = iu * iu * ay2 + 2 * iu * u * my + u * u * by2;
          const tw = 0.35 + 0.5 * Math.max(0, Math.sin(t * 2.2 - i * 0.45));
          dot(0, 0, 0); // noop keeps minifiers honest
          g.fillStyle = hex(c);
          g.globalAlpha = tw;
          g.beginPath();
          g.arc(px, py, 1.6, 0, 7);
          g.fill();
          g.globalAlpha = 1;
        }
      }
    }

    // ── parcels ──
    for (const r of parcels.values()) {
      const u = ((perfNow / 1000 - r.t0) * r.speed + r.phase) % 1;
      const seg = u * (r.pts.length - 1),
        i = Math.min(Math.floor(seg), r.pts.length - 2),
        f = seg - i;
      const px = r.pts[i][0] + (r.pts[i + 1][0] - r.pts[i][0]) * f;
      const pz = r.pts[i][2] + (r.pts[i + 1][2] - r.pts[i][2]) * f;
      const fade = Math.min(1, Math.sin(u * Math.PI) * 3);
      glow(px, pz, 4, hex(r.color), 0.4 * fade);
      dot(px, pz, (2.2 * r.s) / 1.2, hex(r.color), fade);
    }

    // ── pulses ──
    for (const p of pulses.values())
      ring(
        p.x,
        p.z,
        (8 + Math.sin(t * 2.4) * 3) * (p.s || 1),
        hex(p.c),
        0.35 + Math.max(0, Math.sin(t * 2.4)) * 0.4,
        2.4
      );
  }

  /* ---------- chips (x-ray) ---------- */
  const chips = MAP.map(([x, y, z, t, n, xr, cls]) => {
    const el = document.createElement("div");
    el.className = "lbl " + (cls || "");
    el.innerHTML =
      `<div class="t">${t}${n ? `<span class="n">${n}</span>` : ""}</div>` +
      (xr ? `<div class="x">${xr}</div>` : "");
    document.body.appendChild(el);
    return { el, x, z, sm: cls.includes("sm") };
  });
  let detail = "mech";
  function xray(mode) {
    detail = mode;
    chips.forEach(
      (c) => (c.el.style.display = mode === "story" ? "none" : "block")
    );
  }
  xray("mech");

  /* ---------- main loop ---------- */
  let perfNow = 0;
  function frame(now) {
    perfNow = now;
    const k = 0.085;
    cam.x += (goal.x - cam.x) * k;
    cam.y += (goal.y - cam.y) * k;
    cam.z += (goal.z - cam.z) * k;
    g.clearRect(0, 0, innerWidth, innerHeight);
    g.fillStyle = night ? "#07070f" : "#0c0d14";
    g.fillRect(0, 0, innerWidth, innerHeight);
    g.save();
    if (buildP < 0.999) {
      const e = 1 - Math.pow(1 - buildP, 3);
      g.translate(innerWidth / 2, innerHeight / 2);
      g.scale(Math.max(0.001, e), Math.max(0.001, e));
      g.translate(-innerWidth / 2, -innerHeight / 2 + (1 - e) * 60);
      g.globalAlpha = Math.max(0.05, e);
    }
    drawIsle();
    g.restore();
    if (night) {
      g.fillStyle = "rgba(5,6,16,.5)";
      g.fillRect(0, 0, innerWidth, innerHeight);
    }
    // chips with collision avoidance
    if (detail !== "story") {
      const placed = [];
      const cand = chips
        .map((c) => ({ c, q: project(vec(c.x, 0, c.z)) }))
        .filter(
          ({ c, q }) =>
            !q.behind &&
            q.x > -80 &&
            q.x < innerWidth * 1.08 &&
            q.y > 40 &&
            q.y < innerHeight - 90 &&
            (detail === "expert" ||
              Math.hypot(c.x - cam.x, c.z + cam.y) < 60 ||
              (!c.sm && cam.z < 4.4))
        );
      cand.sort((a, b) => (a.c.sm ? 1 : 0) - (b.c.sm ? 1 : 0));
      for (const { c, q } of cand) {
        const w = c.el.offsetWidth || 120,
          h = c.el.offsetHeight || 40;
        const r1 = {
          x: q.x - w / 2 - 6,
          y: q.y - h / 2 - 4,
          w: w + 12,
          h: h + 8,
        };
        if (
          placed.some(
            (r2) =>
              r1.x < r2.x + r2.w &&
              r1.x + r1.w > r2.x &&
              r1.y < r2.y + r2.h &&
              r1.y + r1.h > r2.y
          )
        ) {
          c.el.style.display = "none";
          continue;
        }
        placed.push(r1);
        c.el.style.display = "block";
        c.el.style.left = q.x + "px";
        c.el.style.top = q.y + "px";
      }
    }
    for (const fn of frameHooks) fn(now);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /* ---------- input: pan + zoom ---------- */
  let drag = null;
  cvs.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y };
  });
  addEventListener("pointermove", (e) => {
    if (!drag) return;
    cam.x = drag.cx - (e.clientX - drag.x) / cam.z;
    cam.y = drag.cy - (e.clientY - drag.y) / cam.z;
    goal = { ...cam };
  });
  addEventListener("pointerup", () => {
    drag = null;
  });
  cvs.addEventListener(
    "wheel",
    (e) => {
      goal.z = Math.max(
        1.6,
        Math.min(26, goal.z * (1 + Math.sign(e.deltaY) * -0.1))
      );
    },
    { passive: true }
  );

  /* ---------- api ---------- */
  return {
    fly,
    pulse(name, on) {
      const a = ANCHORS[name];
      if (!a) return;
      if (on)
        pulses.set(name, {
          x: a[0],
          z: a[2],
          c: a[3] || HUE.warm,
          s: (a[4] || 14) / 14,
        });
      else pulses.delete(name);
    },
    setNight(on) {
      night = on;
      document.body.classList.toggle("night", on);
    },
    addParcel(id, path, color, s = 1.2, speed = 0.06, phase = 0) {
      removeParcel(id);
      parcels.set(id, {
        pts: path,
        color,
        s,
        speed,
        phase,
        t0: perfNow / 1000,
        legs: path.length - 1,
      });
    },
    removeParcel(id) {
      parcels.delete(id);
    },
    cutTether(name, cut) {
      tethers[name] = { cut };
    },
    setOutbox(n) {
      outboxN = n;
    },
    cellsCopied(n) {
      copiedN = n;
    },
    setBuild(p) {
      buildP = p;
    },
    setScopes(n) {
      scopesN = n;
    },
    revokeScope() {
      if (scopesN > 0) scopesN--;
    },
    syncLoop(on) {
      if (on)
        this.addParcel(
          "syncloop",
          [
            [0, 3.6, 50],
            [-14, 1.8, 62],
            [-30, 0, 71],
            [-14, 1.8, 62],
            [0, 3.6, 50],
          ],
          HUE.indigo,
          0.8,
          0.14
        );
      else this.removeParcel("syncloop");
    },
    pack(on) {
      packOn = on;
    },
    xray,
    project,
    vec,
    onFrame: (fn) => frameHooks.push(fn),
    ANCHORS,
    HUE,
    MAP,
  };
})();
window.__flatReady = true;
