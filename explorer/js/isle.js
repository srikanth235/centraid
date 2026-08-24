// governance: allow-repo-hygiene file-size-limit — one cohesive world module: every landmark, tether, and the ISLE API read the same shared coordinate tables (MAP/ANCHORS/HUE); splitting it would strand half the landmarks from the tables they render from.
/* ============================================================================
   THE SOVEREIGN ISLE — the Centraid Explorer world.
   Built on the aesthetic prototype (dusk isle, three.js, zero deps).
   One coherent metaphor: a person's vault is a floating isle at dusk.
   Every element maps 1:1 to a real component (the MAP table below is the
   honesty contract). This file wraps the scene in the ISLE api that the
   journey engine drives: camera foci, night, pulses, parcels, tethers.
   ========================================================================== */
"use strict";

window.ISLE = (() => {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  const HUE = {
    slate: 0x8aa6d6,
    violet: 0xc98bbe,
    amber: 0xc9a05a,
    rose: 0xe08d98,
    indigo: 0x9d96e8,
    net: 0xe0685a,
    warm: 0xe8b84b,
    moon: 0xededec,
    relay: 0x9db0f0,
    teal: 0x6fb2c9,
    forest: 0x7fbe8e,
    ochre: 0xbfa34f,
  };

  const scene = new THREE.Scene();
  const anim = [];
  const frameHooks = []; // engine callbacks: (t) => void
  // everything that belongs to the isle itself lives in `world`, so the
  // bootstrapping journey can raise it out of the void
  const world = new THREE.Group();
  scene.add(world);
  const tethers = {};
  let buildP = 1,
    buildTarget = 1;
  function setBuild(p) {
    buildTarget = p;
  }
  anim.push((t, dt) => {
    if (Math.abs(buildTarget - buildP) < 0.001) {
      buildP = buildTarget;
    } else buildP += (buildTarget - buildP) * Math.min(1, dt * 2.2);
    const e = 1 - Math.pow(1 - buildP, 3); // easeOutCubic
    const s = Math.max(0.0001, e);
    world.scale.set(s, s, s);
    world.position.y = (1 - e) * -26; // rises from below
    world.visible = buildP > 0.002;
  });

  // ── sky (stored so night mode can re-ink it) ──
  const skyCv = document.createElement("canvas");
  skyCv.width = 4;
  skyCv.height = 512;
  function inkSky(night) {
    const g = skyCv.getContext("2d"),
      gr = g.createLinearGradient(0, 0, 0, 512);
    if (!night) {
      gr.addColorStop(0.0, "#07070f");
      gr.addColorStop(0.42, "#181a2e");
      gr.addColorStop(0.66, "#3a3350");
      gr.addColorStop(0.82, "#8a5a52");
      gr.addColorStop(1.0, "#c98d63");
    } else {
      gr.addColorStop(0.0, "#04040a");
      gr.addColorStop(0.45, "#0b0c18");
      gr.addColorStop(0.7, "#1c1a30");
      gr.addColorStop(0.86, "#3a2c3e");
      gr.addColorStop(1.0, "#57404a");
    }
    g.fillStyle = gr;
    g.fillRect(0, 0, 4, 512);
    skyTex.needsUpdate = true;
  }
  const skyTex = new THREE.CanvasTexture(skyCv);
  inkSky(false);
  scene.background = skyTex;
  const fog = new THREE.Fog(0x3a3350, 190, 520);
  scene.fog = fog;

  // ── light (stored for night mode) ──
  const hemi = new THREE.HemisphereLight(0x6a74a8, 0x33281c, 1.7);
  world.add(hemi);
  const sun = new THREE.DirectionalLight(0xffb26b, 2.6);
  sun.position.set(-140, 60, 120);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -140;
  sun.shadow.camera.right = 140;
  sun.shadow.camera.top = 140;
  sun.shadow.camera.bottom = -140;
  sun.shadow.bias = -0.0004;
  world.add(sun);
  const fillA = new THREE.DirectionalLight(0x8aa0ff, 0.55);
  fillA.position.set(90, 80, -60);
  world.add(fillA);
  const fillB = new THREE.DirectionalLight(0xfff2e0, 0.85);
  fillB.position.set(60, 90, 140);
  world.add(fillB);
  const pools = [];
  for (const [lx, lz, lc] of [
    [0, 44, HUE.slate],
    [34, 4, HUE.warm],
    [-35, 2, HUE.violet],
    [-40, -22, HUE.forest],
    [26, -30, HUE.teal],
  ]) {
    const pl = new THREE.PointLight(lc, 900, 55, 2.1);
    pl.position.set(lx, 16, lz);
    world.add(pl);
    pools.push(pl);
  }

  // ── primitives ──
  const glowTex = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d"),
      rg = g.createRadialGradient(64, 64, 2, 64, 64, 64);
    rg.addColorStop(0, "rgba(255,255,255,1)");
    rg.addColorStop(0.35, "rgba(255,255,255,.35)");
    rg.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = rg;
    g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  })();
  function halo(x, y, z, color, size, op = 0.7) {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTex,
        color,
        transparent: true,
        opacity: op,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    s.position.set(x, y, z);
    s.scale.set(size, size, 1);
    world.add(s);
    return s;
  }
  const mat = (c, o = {}) =>
    new THREE.MeshStandardMaterial({
      color: c,
      roughness: o.r ?? 0.88,
      metalness: o.m ?? 0.04,
      ...(o.e ? { emissive: o.e, emissiveIntensity: o.ei ?? 1 } : {}),
    });
  function box(x, y, z, w, h, d, material, cast = true) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    b.position.set(x, y + h / 2, z);
    b.castShadow = cast;
    b.receiveShadow = true;
    world.add(b);
    return b;
  }
  function cyl(x, y, z, r1, r2, h, material, seg = 48) {
    const c = new THREE.Mesh(
      new THREE.CylinderGeometry(r1, r2, h, seg),
      material
    );
    c.position.set(x, y + h / 2, z);
    c.castShadow = true;
    c.receiveShadow = true;
    world.add(c);
    return c;
  }

  // ── THE ISLE ═══ one person's vault: self-contained, with a visible edge ════
  const R = 74;
  const stoneTop = mat(0x33354a, { r: 0.95 }),
    stoneDark = mat(0x232430);
  cyl(0, -7, 0, R + 3, R - 2, 7, mat(0x2b2d3a));
  cyl(0, -15, 0, R - 6, R - 16, 8, stoneDark);
  cyl(0, -24, 0, R - 20, R - 34, 9, mat(0x1b1c26));
  cyl(0, -31, 0, R - 36, R - 48, 7, mat(0x14151d));
  cyl(0, 0, 0, R, R + 3, 2.6, stoneTop, 96);
  {
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(R + 1.2, 0.45, 10, 128),
      mat(0x33354a, { e: HUE.slate, ei: 1.6 })
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 2.4;
    world.add(rim);
  }
  for (const rr of [22, 36, 50, 64]) {
    const g = new THREE.Mesh(
      new THREE.TorusGeometry(rr, 0.12, 6, 128),
      new THREE.MeshBasicMaterial({
        color: HUE.slate,
        transparent: true,
        opacity: 0.14,
      })
    );
    g.rotation.x = Math.PI / 2;
    g.position.y = 2.72;
    world.add(g);
  }

  function district(x, z, w, d, color, rot = 0) {
    const p = new THREE.Mesh(
      new THREE.BoxGeometry(w, 0.5, d),
      new THREE.MeshStandardMaterial({
        color,
        roughness: 0.9,
        transparent: true,
        opacity: 0.5,
      })
    );
    p.position.set(x, 2.9, z);
    p.rotation.y = rot;
    p.receiveShadow = true;
    world.add(p);
    const eg = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(w, 0.5, d)),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 })
    );
    eg.position.copy(p.position);
    eg.rotation.y = rot;
    world.add(eg);
  }
  function cluster(cx, cz, w, d, n, base, litColor, litProb = 0.5) {
    for (let i = 0; i < n; i++) {
      const bw = 1.6 + rnd() * 2.6,
        bd = 1.6 + rnd() * 2.6,
        bh = 1.8 + rnd() * rnd() * 7.5;
      const x = cx + (rnd() - 0.5) * (w - bw),
        z = cz + (rnd() - 0.5) * (d - bd);
      box(
        x,
        3.1,
        z,
        bw,
        bh,
        bd,
        mat(new THREE.Color(base).multiplyScalar(0.75 + rnd() * 0.5).getHex())
      );
      if (rnd() < litProb) {
        const strip = new THREE.Mesh(
          new THREE.BoxGeometry(bw * 0.82, 0.28, bd + 0.06),
          mat(0x111218, { e: litColor, ei: 2.2 })
        );
        strip.position.set(x, 3.1 + bh * (0.35 + rnd() * 0.4), z);
        world.add(strip);
      }
    }
  }

  // ── THE VAULT ═══ vault.db. Monolithic and DARK: light leaks only at the
  //    seams the DEK controls. Sealed columns are the aesthetic. ═══════════════
  cyl(0, 3.1, -2, 13.5, 15, 3.2, mat(0x3a3d52));
  cyl(0, 6.3, -2, 10.5, 11.5, 7.5, mat(0x2c2e40, { r: 0.55, m: 0.2 }));
  {
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(10.5, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2),
      mat(0x262838, { r: 0.45, m: 0.25 })
    );
    dome.position.set(0, 13.8, -2);
    dome.castShadow = true;
    world.add(dome);
  }
  const seams = [];
  for (let i = 0; i < 5; i++) {
    const t = new THREE.Mesh(
      new THREE.TorusGeometry(10.62, 0.16, 8, 96, Math.PI),
      mat(0x14151e, { e: HUE.warm, ei: 3.4 })
    );
    t.position.set(0, 13.8, -2);
    t.rotation.y = (i / 5) * Math.PI;
    world.add(t);
    seams.push(t.material);
  }
  const oculus = halo(0, 25.6, -2, HUE.warm, 10, 0.8);
  cyl(0, 24.1, -2, 0.9, 1.3, 1.6, mat(0x14151e, { e: HUE.warm, ei: 3 }));
  // the drum's ring of cells: mostly dark (sealed), every third lit (plain columns)
  const cells = [];
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2,
      rr = 12.9;
    const c = box(
      Math.cos(a) * rr,
      6.4,
      -2 + Math.sin(a) * rr,
      1.5,
      2.2,
      0.7,
      i % 3 === 0
        ? mat(0x111218, { e: 0x2a3140, ei: 1 })
        : mat(0x16171f, { r: 0.5 })
    );
    c.lookAt(0, 7.5, -2);
    cells.push(c);
  }
  {
    const door = new THREE.Mesh(
      new THREE.TorusGeometry(2.6, 0.28, 10, 48),
      mat(0x191a24, { e: HUE.warm, ei: 3.2 })
    );
    door.position.set(0, 6.8, 9.4);
    world.add(door);
  }
  halo(0, 6.8, 9.8, HUE.warm, 7, 0.5);
  anim.push((t) => {
    const p = 3.0 + Math.sin(t * 0.7) * 0.7;
    for (const m of seams) m.emissiveIntensity = p;
    oculus.material.opacity = 0.7 + Math.sin(t * 0.7) * 0.14;
  });

  // ── GATEHOUSE ═══ the gateway. The ONLY door in. ════════════════════════════
  district(0, 42, 26, 20, HUE.slate);
  cluster(-8, 42, 9, 15, 7, 0x55608a, HUE.slate, 0.65);
  cluster(8, 42, 9, 15, 7, 0x55608a, HUE.slate, 0.65);
  for (const sx of [-4.2, 4.2]) {
    box(sx, 3.1, 52.5, 2.6, 10.5, 2.6, mat(0x4a5478));
    box(
      sx,
      13.8,
      52.5,
      3.2,
      0.8,
      3.2,
      mat(0x4a5478, { e: HUE.slate, ei: 1.6 })
    );
    halo(sx, 14.6, 52.5, HUE.slate, 5.5, 0.55);
  }
  // the portcullis: the one doorway, barred and lit
  {
    const lintel = box(0, 11.4, 52.5, 11.2, 1.4, 3.0, mat(0x4a5478));
    const bars = [];
    for (let i = -2; i <= 2; i++) {
      const b = box(
        i * 1.9,
        3.1,
        52.5,
        0.34,
        8.4,
        0.34,
        mat(0x14151e, { e: HUE.slate, ei: 1.9 }),
        false
      );
      bars.push(b.material);
    }
    box(
      0,
      3.1,
      52.5,
      9.4,
      0.34,
      0.34,
      mat(0x14151e, { e: HUE.slate, ei: 1.9 }),
      false
    );
    box(
      0,
      6.6,
      52.5,
      9.4,
      0.34,
      0.34,
      mat(0x14151e, { e: HUE.slate, ei: 1.9 }),
      false
    );
    halo(0, 8, 52.5, HUE.slate, 9, 0.4);
  }
  // KEY CABINET ═══ keys/ — the only secret-bearing directory, beside its gate ══
  const keycabGlow = halo(15.5, 6.4, 46, HUE.warm, 5, 0.5);
  box(15.5, 3.1, 46, 2.2, 2.6, 1.4, mat(0x3a3d52, { r: 0.6 }));
  box(
    15.5,
    5.7,
    46,
    2.4,
    0.3,
    1.6,
    mat(0x14151e, { e: HUE.warm, ei: 2.6 }),
    false
  );
  // the keyring: endpoint identity, backup keyring, per-vault DEKs — in orbit
  {
    const keyMat = mat(0x111218, { e: HUE.warm, ei: 2.6 });
    const ring = new THREE.Group();
    ring.position.set(15.5, 7.6, 46);
    world.add(ring);
    for (let i = 0; i < 3; i++) {
      const key = new THREE.Group();
      const bow = new THREE.Mesh(
        new THREE.TorusGeometry(0.42, 0.14, 8, 24),
        keyMat
      );
      key.add(bow);
      const shaft = new THREE.Mesh(
        new THREE.BoxGeometry(0.22, 1.3, 0.14),
        keyMat
      );
      shaft.position.y = -0.95;
      key.add(shaft);
      const bit = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.2, 0.14), keyMat);
      bit.position.set(0.16, -1.5, 0);
      key.add(bit);
      key.rotation.z = Math.PI;
      key.position.x = i * 0.02;
      key.userData.phase = (i / 3) * Math.PI * 2;
      ring.add(key);
    }
    const hoop = new THREE.Mesh(
      new THREE.TorusGeometry(0.7, 0.12, 8, 32),
      keyMat
    );
    hoop.rotation.y = Math.PI / 2;
    ring.add(hoop);
    anim.push((t) =>
      ring.children.forEach((k) => {
        if (k.userData.phase === undefined) return;
        const a = t * 0.7 + k.userData.phase;
        k.position.set(
          Math.cos(a) * 1.15,
          Math.sin(a) * 0.45,
          Math.sin(a) * 1.15
        );
        k.rotation.y = -a;
      })
    );
  }

  // ── CONSENT KIOSK ═══ the consent pipeline on the avenue: executed/parked/
  //    denied, always with a receipt. ══════════════════════════════════════════
  const clerkLamps = [];
  {
    // the checkpoint arch: every touch of the vault passes under it
    box(-2.6, 3.1, 24, 1.1, 5.4, 1.1, mat(0x4a4258));
    box(2.6, 3.1, 24, 1.1, 5.4, 1.1, mat(0x4a4258));
    box(
      0,
      8.5,
      24,
      6.3,
      1.0,
      1.4,
      mat(0x14151e, { e: HUE.violet, ei: 2.0 }),
      false
    );
    box(0, 3.1, 27, 3.4, 3.2, 2.2, mat(0x4a4258));
    box(
      0,
      6.3,
      27,
      3.8,
      0.35,
      2.6,
      mat(0x14151e, { e: HUE.violet, ei: 1.8 }),
      false
    );
    const cols = [HUE.forest, HUE.warm, HUE.net];
    for (let i = 0; i < 3; i++) {
      const l = box(
        -1 + i,
        4.4,
        28.15,
        0.55,
        0.55,
        0.12,
        mat(0x111218, { e: cols[i], ei: 1.4 }),
        false
      );
      clerkLamps.push(l.material);
      halo(-1 + i, 4.7, 28.5, cols[i], 2.2, 0.3);
    }
  }

  // ── LEDGER ARCHIVE ═══ journal.db as a giant OPEN BOOK: the spine is the
  //    conversation, each glowing row an item, inked in order, never erased. ══
  district(34, 6, 26, 22, HUE.amber, -0.16);
  {
    const book = new THREE.Group();
    book.position.set(34, 3.1, 4);
    book.rotation.y = -0.16;
    world.add(book);
    const cover = new THREE.Mesh(
      new THREE.BoxGeometry(21, 0.7, 13.6),
      mat(0x4a3a22, { r: 0.6 })
    );
    cover.position.y = 0.35;
    cover.castShadow = cover.receiveShadow = true;
    book.add(cover);
    const spine = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 1.1, 13.8),
      mat(0x3a2d1a, { r: 0.55 })
    );
    spine.position.y = 0.9;
    book.add(spine);
    const pageMat = mat(0xd8cdb2, { r: 0.85, e: 0x8a744a, ei: 0.22 });
    const inkRows = [];
    for (const side of [-1, 1]) {
      const page = new THREE.Mesh(
        new THREE.BoxGeometry(9.7, 0.35, 12.6),
        pageMat
      );
      page.position.set(side * 5.05, 0.95, 0);
      page.rotation.z = -side * 0.2;
      page.castShadow = page.receiveShadow = true;
      book.add(page);
      for (let i = 0; i < 6; i++) {
        const row = new THREE.Mesh(
          new THREE.BoxGeometry(7.6, 0.08, 0.55),
          mat(0x111218, { e: HUE.warm, ei: 2.2 })
        );
        row.position.set(0, 0.26, -4.6 + i * 1.85);
        page.add(row);
        inkRows.push(row.material);
      }
    }
    // the record is alive: rows re-ink in sequence
    anim.push((t) =>
      inkRows.forEach((m, i) => {
        m.emissiveIntensity =
          1.2 + Math.max(0, Math.sin(t * 0.9 - i * 0.55)) * 1.8;
      })
    );
  }
  cluster(30, 16, 18, 7, 6, 0x7a6440, HUE.amber, 0.7);

  // ── HARNESS ROW ═══ installed model-capable CLIs — codex, claude-code,
  //    opencode — driven over ACP. Every turn is a parcel that enters a shed
  //    as a prompt and leaves as a reply; the shed owns the engine. ═══════════
  district(52, -8, 20, 26, HUE.ochre, 0.1);
  const harnessSheds = [];
  {
    const sheds = [
      ["codex", HUE.warm, 52, -14],
      ["claude-code", HUE.slate, 56, -6],
      ["opencode", HUE.forest, 50, -1],
    ];
    for (const [name, hue, hx, hz] of sheds) {
      const g = new THREE.Group();
      g.position.set(hx, 3.1, hz);
      g.rotation.y = 0.1;
      world.add(g);
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(4.6, 2.6, 3.4),
        mat(0x3a3d52, { r: 0.7 })
      );
      body.castShadow = body.receiveShadow = true;
      g.add(body);
      const roof = new THREE.Mesh(
        new THREE.ConeGeometry(3.2, 1.6, 4),
        mat(new THREE.Color(hue).multiplyScalar(0.5).getHex(), { r: 0.6 })
      );
      roof.position.y = 2.1;
      roof.rotation.y = Math.PI / 4;
      roof.castShadow = true;
      g.add(roof);
      // the engine core: visible through the shed's mouth, breathing
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(0.75, 20, 14),
        mat(0x111218, { e: hue, ei: 2.4 })
      );
      core.position.set(0, 1.0, 1.75);
      g.add(core);
      const glow = halo(hx, 4.2, hz + 1.8, hue, 4.5, 0.5);
      harnessSheds.push({
        name,
        hue,
        core: core.material,
        glow: glow.material,
      });
      // the shed's nameplate: its sigil is its glow
      const mouth = new THREE.Mesh(
        new THREE.BoxGeometry(2.6, 1.7, 0.12),
        mat(0x0d0e14, { e: hue, ei: 0.7 })
      );
      mouth.position.set(0, 0.9, 1.72);
      g.add(mouth);
    }
    // engine cores breathe at their own cadence — independent session actors
    anim.push((t) =>
      harnessSheds.forEach((h, i) => {
        const p = 1.6 + Math.max(0, Math.sin(t * 1.1 + i * 2.2)) * 1.6;
        h.core.emissiveIntensity = p;
        h.glow.opacity = 0.3 + Math.max(0, Math.sin(t * 1.1 + i * 2.2)) * 0.35;
      })
    );
    // the ACP coupling: a pinned protocol ring joining ledger and row
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.6, 0.16, 10, 48),
      mat(0x14151e, { e: HUE.ochre, ei: 2.4 })
    );
    ring.position.set(43, 5.4, -2);
    ring.rotation.y = 0.5;
    world.add(ring);
    anim.push((t) => {
      ring.rotation.x = t * 0.6;
    });
    halo(43, 5.4, -2, HUE.ochre, 7, 0.4);
  }
  // the egress thread: only lit when a delegate step earns provider consent
  tether("egress", [56, 8, -6], [120, 70, -60], HUE.violet, 14, -4);
  cutTether("egress", true);

  // ── AUTOMATION HALL ═══ recognition workers: OCR, embeddings, faces. ═════════
  district(-35, 2, 24, 24, HUE.violet, 0.14);
  cluster(-35, 2, 19, 19, 12, 0x66527a, HUE.violet, 0.6);
  for (const [px, pz] of [
    [-40, -4],
    [-31, 7],
    [-38, 9],
  ]) {
    cyl(px, 3.1, pz, 0.8, 1.1, 9 + rnd() * 3, mat(0x504060));
    const h = halo(px, 14.5 + rnd() * 2, pz, HUE.violet, 4.5, 0.6);
    const off = rnd() * 6;
    anim.push((t) => {
      h.material.opacity = 0.35 + Math.abs(Math.sin(t * 0.8 + off)) * 0.45;
    });
  }
  // the clockwork: one great gear driving a small counter-gear — cron ticks
  {
    const gearMat = mat(0x584868, { e: HUE.violet, ei: 0.8, r: 0.5, m: 0.3 });
    function gear(x, y, z, r, teeth) {
      const g = new THREE.Group();
      g.position.set(x, y, z);
      world.add(g);
      const wheel = new THREE.Mesh(
        new THREE.TorusGeometry(r, 0.5, 10, 48),
        gearMat
      );
      g.add(wheel);
      const hub = new THREE.Mesh(
        new THREE.CylinderGeometry(0.7, 0.7, 0.7, 16),
        gearMat
      );
      hub.rotation.x = Math.PI / 2;
      g.add(hub);
      for (let i = 0; i < teeth; i++) {
        const a = (i / teeth) * Math.PI * 2;
        const tooth = new THREE.Mesh(
          new THREE.BoxGeometry(0.7, 0.9, 0.9),
          gearMat
        );
        tooth.position.set(
          Math.cos(a) * (r + 0.55),
          Math.sin(a) * (r + 0.55),
          0
        );
        tooth.rotation.z = a;
        g.add(tooth);
      }
      return g;
    }
    const big = gear(-40, 13.4, -4, 3.1, 10);
    const small = gear(-35.6, 10.4, -4, 1.7, 7);
    anim.push((t) => {
      big.rotation.z = t * 0.35;
      small.rotation.z = -t * 0.35 * (3.1 / 1.7);
    });
  }

  // ── COMMONS HALL ═══ the steward orders every member's command. ═════════════
  district(-40, -22, 20, 17, HUE.forest, -0.2);
  cyl(-40, 3.1, -22, 7.5, 8, 0.5, mat(0x3c5a48));
  {
    const r2 = new THREE.Mesh(
      new THREE.TorusGeometry(6.2, 0.22, 8, 64),
      mat(0x3c5a48, { e: HUE.forest, ei: 1.8 })
    );
    r2.rotation.x = Math.PI / 2;
    r2.position.set(-40, 3.85, -22);
    world.add(r2);
  }
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    box(
      -40 + Math.cos(a) * 6.2,
      3.4,
      -22 + Math.sin(a) * 6.2,
      1,
      1.4,
      1,
      mat(0x4e7a5e)
    );
  }
  cyl(-40, 3.4, -22, 0.5, 0.7, 3.4, mat(0x4e7a5e, { e: HUE.forest, ei: 2 }));
  // the shared container: one round table, every member a seat at it
  cyl(-40, 3.6, -22, 3.4, 3.4, 0.28, mat(0x3c5a48, { e: HUE.forest, ei: 0.5 }));
  halo(-40, 7.2, -22, HUE.forest, 4.5, 0.6);
  cluster(-48, -14, 8, 7, 5, 0x486a56, HUE.forest, 0.5);

  // ── BLOB CELLAR ═══ identical crates; a blob has no identity but its hash. ══
  district(26, -30, 24, 18, HUE.teal, 0.22);
  for (let ix = 0; ix < 5; ix++)
    for (let iz = 0; iz < 4; iz++) {
      const h = 1.4 + ((ix * 7 + iz * 3) % 5) * 0.9;
      const bx = 19 + ix * 3.4 + iz * 0.8,
        bz = -36 + iz * 3.6 - ix * 0.6;
      box(bx, 3.1, bz, 2.6, h, 2.6, mat(0x38596a));
      if ((ix + iz) % 3 === 0)
        box(
          bx,
          3.1 + h,
          bz,
          2.62,
          0.16,
          2.62,
          mat(0x111218, { e: HUE.teal, ei: 2.2 }),
          false
        );
    }
  cluster(37, -24, 8, 8, 4, 0x40667a, HUE.teal, 0.6);

  // ── AVENUES ═══ every road runs THROUGH the vault plinth. ═══════════════════
  function avenue(from, to, color, n = 14, y = 3.35) {
    for (let i = 1; i < n; i++) {
      const t = i / n;
      box(
        from[0] + (to[0] - from[0]) * t,
        y,
        from[1] + (to[1] - from[1]) * t,
        1.5,
        0.14,
        0.6,
        mat(0x111218, { e: color, ei: 2.8 }),
        false
      ).lookAt(to[0], y, to[1]);
    }
  }
  avenue([0, 14], [0, 50], HUE.slate, 12);
  avenue([12, 0], [26, 4], HUE.amber, 9);
  avenue([-12, 0], [-26, 2], HUE.violet, 9);
  avenue([-11, -7], [-32, -18], HUE.forest, 9);
  avenue([9, -10], [20, -26], HUE.teal, 9);
  avenue([2, 12], [14, 40], HUE.violet, 8); // clerk spur

  // ── PARCELS ═══ a moving parcel IS a row in flight. ═════════════════════════
  const parcels = new Map();
  let parcelSeq = 0;
  function addParcel(id, path, color, s = 1.2, speed = 0.06, phase = 0) {
    removeParcel(id);
    const m = box(0, 0, 0, s, s, s, mat(0x111218, { e: color, ei: 2.6 }));
    const h = halo(0, 0, 0, color, s * 4.2, 0.75);
    const pts = path.map((p) => new THREE.Vector3(...p));
    const legs = pts.length - 1;
    const rec = { m, h, pts, legs, speed, phase, t0: null };
    rec.upd = (t) => {
      if (rec.t0 === null) rec.t0 = t;
      const u = (((t - rec.t0) * speed + phase) % 1) * legs,
        i = Math.min(Math.floor(u), legs - 1);
      const p = pts[i].clone().lerp(pts[i + 1], u - i);
      m.position.copy(p);
      m.rotation.y = t * 0.9;
      h.position.set(p.x, p.y + s / 2, p.z);
      const fade = Math.min(1, Math.sin((u / legs) * Math.PI) * 3);
      m.material.emissiveIntensity = 2.6 * fade;
      h.material.opacity = 0.75 * fade;
    };
    anim.push(rec.upd);
    parcels.set(id, rec);
    return rec;
  }
  function removeParcel(id) {
    const r = parcels.get(id);
    if (!r) return;
    const i = anim.indexOf(r.upd);
    if (i >= 0) anim.splice(i, 1);
    scene.remove(r.m);
    scene.remove(r.h);
    parcels.delete(id);
  }
  // ambient traffic
  addParcel(
    "amb1",
    [
      [0, 3.6, 72],
      [0, 3.6, 50],
      [0, 3.6, 16],
      [10, 3.6, 6],
      [24, 3.6, 4],
    ],
    HUE.slate,
    1.5,
    0.045
  );
  addParcel(
    "amb2",
    [
      [0, 3.6, 12],
      [8, 3.6, -8],
      [20, 3.6, -26],
    ],
    HUE.amber,
    1.4,
    0.07,
    0.35
  );
  addParcel(
    "amb3",
    [
      [-12, 3.4, 0],
      [-26, 3.4, 2],
      [-34, 3.4, 2],
    ],
    HUE.violet,
    1.1,
    0.09,
    0.6
  );

  // ── BRIDGE + ISLETS ═══ a device is its own ground, joined by a thread. ═════
  for (let i = 0; i < 9; i++)
    box(0, 1.0 - 0.32 * i, 57 + i * 4.2, 7 - i * 0.25, 1.1, 3.6, mat(0x2b2d3a));
  avenue([0, 58], [0, 93], HUE.slate, 10, 2.2);

  function islet(x, y, z, r) {
    cyl(x, y, z, r, r + 1, 1.8, stoneTop);
    cyl(x, y - 4.5, z, r - 1.5, r - 3.5, 4.5, stoneDark);
    cyl(x, y - 8, z, r - 4, r - 5.5, 3.5, mat(0x14151d));
  }
  function tether(name, from, to, color, n = 16, sag = -6) {
    const dots = [];
    for (let i = 1; i < n; i++) {
      const t = i / n;
      dots.push(
        halo(
          from[0] + (to[0] - from[0]) * t,
          from[1] + (to[1] - from[1]) * t + Math.sin(t * Math.PI) * sag,
          from[2] + (to[2] - from[2]) * t,
          color,
          1.6,
          0.8
        )
      );
    }
    const upd = (t) => {
      if (!tethers[name]?.cut)
        dots.forEach(
          (d, i) =>
            (d.material.opacity =
              0.35 +
              0.5 *
                Math.max(0, Math.sin(t * 2.2 - i * 0.45)) *
                (tethers[name]?.cut ? 0 : 1))
        );
    };
    anim.push(upd);
    tethers[name] = { dots, upd, cut: false };
    return dots;
  }
  function cutTether(name, cut) {
    const t = tethers[name];
    if (!t) return;
    t.cut = cut;
    t.dots.forEach((d) => (d.material.opacity = cut ? 0.04 : 0.5));
  }

  // MOBILE — Expo; embeds no gateway, talks HTTP to one
  islet(-34, -6, 74, 9);
  const phoneScreen = box(
    -34,
    -3.4,
    74.75,
    2.5,
    4.6,
    0.12,
    mat(0x0d0e14, { e: HUE.indigo, ei: 1.5 }),
    false
  );
  box(-34, -4.2, 74, 3.2, 6.4, 1.4, mat(0x20222e, { r: 0.5, m: 0.2 }));
  halo(-34, -0.5, 75.4, HUE.indigo, 7, 0.5);
  tether("mobile", [-6, 2, 52], [-34, -2, 72], HUE.indigo);
  // durable outbox: queued intents pin themselves to the islet
  const outboxGroup = [];
  function setOutbox(n) {
    while (outboxGroup.length) {
      const o = outboxGroup.pop();
      scene.remove(o.m);
      scene.remove(o.h);
    }
    for (let i = 0; i < Math.min(n, 4); i++) {
      const m = box(
        -31.4 + i * 0.1,
        -3.6 + i * 0.9,
        71.4,
        0.8,
        0.8,
        0.8,
        mat(0x111218, { e: HUE.warm, ei: 2.4 })
      );
      const h = halo(-31.4 + i * 0.1, -3.2 + i * 0.9, 71.4, HUE.warm, 3, 0.5);
      outboxGroup.push({ m, h });
    }
  }

  // the replica stock: up to four mounted vault scopes, stacked on the islet
  const scopeStacks = [];
  for (let i = 0; i < 4; i++) {
    const g = new THREE.Group();
    g.position.set(-39.5 + i * 2.7, -5.1, 70.2 - i * 0.35);
    world.add(g);
    const hue = [HUE.slate, HUE.teal, HUE.violet, HUE.forest][i];
    for (let b2 = 0; b2 < 3; b2++) {
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(1.9, 0.34, 1.5),
        mat(0x20222e, { e: hue, ei: b2 === 0 ? 1.1 : 0.25 })
      );
      slab.position.y = 0.2 + b2 * 0.42;
      slab.castShadow = true;
      g.add(slab);
    }
    g.visible = false;
    scopeStacks.push(g);
  }
  let revokeFlash = null;
  function setScopes(n) {
    if (revokeFlash) {
      scene.remove(revokeFlash);
      revokeFlash = null;
    }
    scopeStacks.forEach((g, i) => (g.visible = i < n));
  }
  function revokeScope(n) {
    const g = scopeStacks[Math.min(n, 3)];
    if (g) g.visible = false;
    const pos = g ? g.position : new THREE.Vector3(-30, -5, 70);
    revokeFlash = halo(pos.x, pos.y + 1.5, pos.z, HUE.net, 7, 0.9);
    anim.push((t) => {
      if (revokeFlash) {
        revokeFlash.material.opacity -= 0.008;
        if (revokeFlash.material.opacity <= 0) {
          scene.remove(revokeFlash);
          revokeFlash = null;
        }
      }
    });
  }
  // the delta stream: small parcels shuttling gate ↔ phone while the thread lives
  function syncLoop(on) {
    if (on)
      addParcel(
        "syncloop",
        [
          [0, 3.6, 50],
          [-14, 1.8, 62],
          [-30, 0, 71],
          [-14, 1.8, 62],
          [0, 3.6, 50],
        ],
        HUE.indigo,
        0.7,
        0.16
      );
    else removeParcel("syncloop");
  }
  // the pinned thumbnail pack: recent 90 days + favorites
  const packGroup = new THREE.Group();
  packGroup.position.set(-29, -5.1, 76.5);
  packGroup.rotation.y = -0.4;
  world.add(packGroup);
  for (let i = 0; i < 3; i++) {
    const card = new THREE.Mesh(
      new THREE.BoxGeometry(1.3, 0.12, 1.7),
      mat(0x111218, { e: HUE.amber, ei: 1.2 })
    );
    card.position.set((i - 1) * 0.35, 0.1 + i * 0.16, (i - 1) * 0.2);
    card.rotation.y = (i - 1) * 0.3;
    packGroup.add(card);
  }
  packGroup.visible = false;
  function pack(on) {
    packGroup.visible = on;
  }

  // WEB PWA — relay-only: the thread must climb a beacon
  islet(72, -12, 34, 7.5);
  box(72, -10.2, 34, 5.2, 0.5, 3.6, mat(0x20222e, { r: 0.5, m: 0.2 }));
  box(
    72,
    -9.7,
    32.4,
    6,
    4,
    0.35,
    mat(0x20222e, { r: 0.5, m: 0.2 })
  ).rotation.x = -0.18;
  box(
    72,
    -9.55,
    32.62,
    5.2,
    3,
    0.1,
    mat(0x0d0e14, { e: HUE.relay, ei: 1.3 }),
    false
  ).rotation.x = -0.18;
  const beacon = [60, 42, 36];
  const oct = new THREE.Mesh(
    new THREE.OctahedronGeometry(2.2),
    mat(0x20222e, { e: HUE.relay, ei: 2.6, r: 0.4 })
  );
  oct.position.set(...beacon);
  scene.add(oct);
  anim.push((t) => {
    oct.rotation.y = t * 0.5;
    oct.rotation.x = Math.sin(t * 0.3) * 0.2;
  });
  halo(...beacon, HUE.relay, 12, 0.55);
  tether("web1", [36, 2, 28], beacon, HUE.relay, 12, -2);
  tether("web2", beacon, [69, -8, 32], HUE.relay, 12, -2);

  // DESKTOP — the one seat that runs the local daemon
  islet(0, -7, 97, 10.5);
  box(
    -2.2,
    -5.2,
    97,
    6.4,
    4.4,
    0.5,
    mat(0x20222e, { r: 0.5, m: 0.2 })
  ).rotation.x = -0.12;
  box(
    -2.2,
    -5.0,
    97.2,
    5.6,
    3.6,
    0.2,
    mat(0x0d0e14, { e: HUE.slate, ei: 1.4 }),
    false
  ).rotation.x = -0.12;
  cyl(-2.2, -5.4, 98.6, 1.2, 1.6, 0.5, mat(0x20222e));
  box(4.6, -5.2, 95.6, 2.6, 2.2, 2.6, mat(0x3a3d52));
  box(
    4.6,
    -4.4,
    96.95,
    1.2,
    0.7,
    0.12,
    mat(0x111218, { e: HUE.warm, ei: 2.2 }),
    false
  );
  halo(0, -1, 97, HUE.slate, 9, 0.4);

  // COMPANION — deliberately the smallest islet
  islet(-80, -6, 46, 5);
  box(-81.6, -4.2, 46, 1, 3.4, 1, mat(0x3a3d52));
  box(-78.4, -4.2, 46, 1, 3.4, 1, mat(0x3a3d52));
  box(-80, -1.2, 46, 4.2, 0.7, 1, mat(0x3a3d52, { e: HUE.rose, ei: 1.4 }));
  box(
    -80,
    -4.2,
    47.6,
    1.6,
    2.2,
    0.3,
    mat(0x0d0e14, { e: HUE.rose, ei: 1.2 }),
    false
  );
  tether("companion", [-52, 2, 30], [-77, -3, 44], HUE.rose, 12);

  // ── FAR WAREHOUSE ═══ the backup provider. The ONE red thread. ══════════════
  islet(-112, 2, -6, 13);
  box(-112, 3.8, -6, 12, 7, 8, mat(0x3c4050));
  box(-112, 10.8, -6, 12.6, 1.2, 8.6, mat(0x2c2f3c));
  box(
    -112,
    6,
    -1.7,
    10,
    3.6,
    0.25,
    mat(0x0d0e14, { e: 0x5a2c30, ei: 1.4 }),
    false
  );
  tether("warehouse", [-58, 2, 10], [-108, 6, -5], HUE.net, 22, -8);
  halo(-112, 12, -6, HUE.net, 16, 0.35);
  // sealed crates staged at the dock: chunks wait for the red thread
  for (const [cx2, cy2, cz2, s2] of [
    [-106, 3.8, -12, 2.2],
    [-103, 3.8, -13.5, 1.8],
    [-104.6, 6.1, -12.6, 1.8],
  ]) {
    box(cx2, cy2, cz2, s2, s2, s2, mat(0x31404e, { r: 0.7 }));
    box(
      cx2,
      cy2 + s2 + 0.05,
      cz2,
      s2 * 0.3,
      0.18,
      s2 * 0.3,
      mat(0x111218, { e: HUE.net, ei: 2.4 }),
      false
    );
  }
  // RECOVERY CHEST ═══ the wrapped kit: password = custody ═════════════════════
  box(-105, 3.8, 0.5, 3, 1.8, 2, mat(0x4a3d2c, { r: 0.6 }));
  box(
    -105,
    5.6,
    0.5,
    3.2,
    0.4,
    2.2,
    mat(0x14151e, { e: HUE.warm, ei: 2.6 }),
    false
  );
  const kitHalo = halo(-105, 6.4, 0.5, HUE.warm, 5, 0.45);

  // ── THE EIGHT APPS ═══ packages/blueprints, each in its identity hue. ═══════
  const APPS = [
    ["notes", HUE.slate],
    ["people", HUE.violet],
    ["photos", HUE.amber],
    ["locker", HUE.rose],
    ["tally", HUE.indigo],
    ["tasks", HUE.ochre],
    ["docs", HUE.teal],
    ["agenda", HUE.forest],
  ];
  function pavilion(id, hue, px, pz) {
    cyl(px, 2.7, pz, 3.6, 4.0, 0.7, mat(0x3a3d52));
    const trim = new THREE.Mesh(
      new THREE.TorusGeometry(3.4, 0.14, 8, 48),
      mat(0x111218, { e: hue, ei: 2.4 })
    );
    trim.rotation.x = Math.PI / 2;
    trim.position.set(px, 3.5, pz);
    scene.add(trim);
    halo(px, 6.2, pz, hue, 5, 0.32);
    const b = mat(new THREE.Color(hue).multiplyScalar(0.55).getHex(), {
      r: 0.7,
    });
    const e = mat(0x111218, { e: hue, ei: 2.2 });
    switch (id) {
      case "notes": {
        // a pinned note card, handwritten lines, pencil resting
        const card = box(
          px,
          3.4,
          pz,
          3.0,
          2.6,
          0.22,
          mat(0xd8cdb2, { e: hue, ei: 0.25 })
        );
        card.rotation.y = 0.3;
        for (let i = 0; i < 3; i++)
          box(
            px - 0.7,
            3.9 + i * 0.62,
            pz + 0.16,
            1.7,
            0.09,
            0.05,
            mat(0x111218, { e: hue, ei: 1.8 }),
            false
          ).rotation.y = 0.3;
        const pin = cyl(px, 6.05, pz - 0.2, 0.14, 0.2, 0.35, e);
        const pencil = cyl(px + 1.4, 3.55, pz + 0.9, 0.1, 0.1, 1.7, b);
        pencil.rotation.z = 1.2;
        pencil.rotation.y = 0.5;
        break;
      }
      case "people": {
        // three figures in conversation, one mid-greeting
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2 + 0.5,
            fx = px + Math.cos(a) * 1.5,
            fz = pz + Math.sin(a) * 1.5;
          const tall = i === 0;
          cyl(fx, 3.4, fz, 0.42, 0.55, 1.5 + (tall ? 0.7 : 0), tall ? e : b);
          const head = new THREE.Mesh(
            new THREE.SphereGeometry(0.42, 16, 12),
            tall ? e : b
          );
          head.position.set(fx, 3.4 + 1.9 + (tall ? 0.7 : 0), fz);
          head.castShadow = true;
          scene.add(head);
          if (tall) {
            // waving arm
            const arm = box(fx + 0.5, 5.6, fz, 0.9, 0.22, 0.22, e);
            arm.rotation.z = -0.5;
          }
        }
        break;
      }
      case "photos": {
        // a framed print: mountains and a sun
        box(
          px,
          3.4,
          pz,
          3.6,
          2.9,
          0.24,
          mat(new THREE.Color(hue).multiplyScalar(0.4).getHex(), { r: 0.6 })
        );
        const shot = box(
          px,
          3.55,
          pz + 0.16,
          2.9,
          2.1,
          0.08,
          mat(0x0d0e14, { e: hue, ei: 0.5 }),
          false
        );
        const mtn = new THREE.Mesh(
          new THREE.ConeGeometry(0.95, 1.1, 4),
          mat(0x4e7a5e, { e: HUE.forest, ei: 0.7 })
        );
        mtn.position.set(px - 0.5, 3.9, pz + 0.24);
        mtn.rotation.y = Math.PI / 4;
        mtn.rotation.z = 0.0;
        scene.add(mtn);
        const mtn2 = new THREE.Mesh(
          new THREE.ConeGeometry(0.6, 0.75, 4),
          mat(0x3c5a48, { e: HUE.forest, ei: 0.5 })
        );
        mtn2.position.set(px + 0.55, 3.75, pz + 0.26);
        mtn2.rotation.y = Math.PI / 4;
        scene.add(mtn2);
        const sun2 = new THREE.Mesh(
          new THREE.TorusGeometry(0.28, 0.1, 8, 24),
          e
        );
        sun2.position.set(px + 0.75, 4.55, pz + 0.26);
        scene.add(sun2);
        break;
      }
      case "locker": {
        // a padlock: body, shackle, keyhole
        box(
          px,
          3.4,
          pz,
          2.5,
          2.3,
          1.4,
          mat(new THREE.Color(hue).multiplyScalar(0.5).getHex(), {
            r: 0.5,
            m: 0.3,
          })
        );
        const sh = new THREE.Mesh(
          new THREE.TorusGeometry(0.85, 0.24, 10, 32, Math.PI),
          e
        );
        sh.position.set(px, 5.7, pz);
        scene.add(sh);
        cyl(
          px,
          4.2,
          pz + 0.75,
          0.16,
          0.16,
          0.12,
          mat(0x111218, { e: hue, ei: 2.4 }),
          12
        );
        break;
      }
      case "tally": {
        // a bar chart settling debts
        box(px, 3.4, pz - 0.9, 3.4, 0.22, 1.9, b);
        for (let i = 0; i < 3; i++)
          cyl(
            px - 1.1 + i * 1.1,
            3.62,
            pz,
            0.5,
            0.5,
            0.9 + i * 0.85,
            i === 2 ? e : b
          );
        break;
      }
      case "tasks": {
        // three list rows, the last checked off
        for (let i = 0; i < 3; i++)
          box(px, 3.4 + i * 0.95, pz, 2.9, 0.62, 1.9, i === 2 ? e : b);
        box(
          px - 0.45,
          5.42,
          pz + 1.0,
          0.55,
          0.14,
          0.1,
          mat(0x111218, { e: HUE.forest, ei: 2.4 }),
          false
        ).rotation.z = 0.6;
        box(
          px - 0.1,
          5.3,
          pz + 1.0,
          0.8,
          0.14,
          0.1,
          mat(0x111218, { e: HUE.forest, ei: 2.4 }),
          false
        ).rotation.z = -0.6;
        break;
      }
      case "docs": {
        // two documents, one dog-eared
        box(px - 0.8, 3.4, pz, 1.15, 3.3, 2.3, b);
        box(px + 0.7, 3.4, pz + 0.2, 1.15, 2.9, 2.3, b).rotation.z = -0.14;
        const fold = box(px + 1.28, 6.35, pz + 0.2, 0.5, 0.5, 2.3, e);
        fold.rotation.z = -0.78;
        break;
      }
      case "agenda": {
        // a ring-bound calendar with a marked day
        box(px, 3.4, pz, 2.4, 4.2, 0.5, b);
        box(px, 7.7, pz, 2.6, 0.35, 0.7, mat(0x3a3d52));
        for (const dx of [-0.7, 0.7]) {
          const r3 = new THREE.Mesh(
            new THREE.TorusGeometry(0.22, 0.07, 8, 24),
            e
          );
          r3.position.set(px + dx, 7.55, pz);
          scene.add(r3);
        }
        for (let r2 = 0; r2 < 2; r2++)
          for (let c2 = 0; c2 < 3; c2++) {
            const mark = r2 === 0 && c2 === 1;
            box(
              px - 0.7 + c2 * 0.7,
              5.9 - r2 * 0.85,
              pz + 0.28,
              0.5,
              0.5,
              0.06,
              mark
                ? e
                : mat(new THREE.Color(hue).multiplyScalar(0.35).getHex(), {
                    r: 0.7,
                  }),
              false
            );
          }
        break;
      }
    }
  }
  APPS.forEach(([id, hue], i) => {
    const a = ((16 + i * 8) * Math.PI) / 180;
    pavilion(id, hue, Math.cos(a) * 62, Math.sin(a) * 62);
  });

  // ── sky furniture ──
  {
    const pos = [];
    for (let i = 0; i < 420; i++) {
      const a = rnd() * Math.PI * 2,
        r = 260 + rnd() * 160;
      pos.push(Math.cos(a) * r, 40 + rnd() * 200, Math.sin(a) * r);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    scene.add(
      new THREE.Points(
        g,
        new THREE.PointsMaterial({
          color: 0xbfc4dd,
          size: 0.9,
          transparent: true,
          opacity: 0.8,
        })
      )
    );
  }
  halo(-190, 120, -140, HUE.moon, 46, 0.9);
  const moonMesh = new THREE.Mesh(
    new THREE.SphereGeometry(9, 24, 24),
    mat(HUE.moon, { e: HUE.moon, ei: 0.8 })
  );
  moonMesh.position.set(-190, 120, -140);
  scene.add(moonMesh);
  for (const [x, y, z, s] of [
    [-140, 48, 60, 1],
    [170, 40, 10, 1.3],
    [70, 56, -160, 1.1],
    [-90, 36, -130, 0.8],
  ]) {
    const c = new THREE.Mesh(
      new THREE.BoxGeometry(34 * s, 2.2, 12 * s),
      new THREE.MeshStandardMaterial({
        color: 0x8a7a86,
        roughness: 1,
        transparent: true,
        opacity: 0.09,
      })
    );
    c.position.set(x, y, z);
    scene.add(c);
    anim.push((t) => {
      c.position.x = x + Math.sin(t * 0.05 + x) * 8;
    });
  }

  // ── THE MAP ═══ metaphor → real component. The honesty contract. ════════════
  const MAP = [
    [0, 32, -2, "THE VAULT", "", "vault.db · sealed shelves stay dark", ""],
    [
      34,
      16,
      2,
      "LEDGER ARCHIVE",
      "+3",
      "journal.db · conversation ⊃ turn ⊃ item",
      "",
    ],
    [0, 20, 52, "GATEHOUSE", "", "the gateway · the only door in", ""],
    [15.5, 10, 46, "KEY CABINET", "", "keys/ · the only secret dir", "sm"],
    [
      0,
      11,
      28,
      "CONSENT DESK",
      "",
      "executed / parked / denied · receipt",
      "sm",
    ],
    [-44, 18, 14, "AUTOMATION", "+2", "recognition workers", "sm"],
    [54, 12, -8, "HARNESS ROW", "+3", "installed CLIs · turns over ACP", "sm"],
    [-54, 12, -16, "COMMONS", "", "steward-ordered log", "sm"],
    [27, 12, -32, "BLOB CELLAR", "+29", "content-addressed store", "sm"],
    [59.6, 10, 17.1, "NOTES", "", "blueprints/apps/notes · byte-bearing", "sm"],
    [
      56.6,
      10,
      25.2,
      "PEOPLE",
      "",
      "blueprints/apps/people · record-only",
      "sm",
    ],
    [
      52.6,
      10,
      32.9,
      "PHOTOS",
      "",
      "blueprints/apps/photos · custody triple",
      "sm",
    ],
    [
      47.5,
      10,
      39.8,
      "LOCKER",
      "",
      "blueprints/apps/locker · secret-free replica",
      "sm",
    ],
    [41.5, 10, 46.1, "TALLY", "", "blueprints/apps/tally · record-only", "sm"],
    [34.7, 10, 51.4, "TASKS", "", "blueprints/apps/tasks · record-only", "sm"],
    [27.2, 10, 55.7, "DOCS", "", "blueprints/apps/docs · byte-bearing", "sm"],
    [
      19.2,
      10,
      59.0,
      "AGENDA",
      "",
      "blueprints/apps/agenda · record-only",
      "sm",
    ],
    [9, 3, 99, "DESKTOP", "", "Electron shell · runs the local daemon", "sm"],
    [72, -2, 34, "WEB PWA", "", "relay-only tunnel · replica ⊕ outbox", "sm"],
    [60, 49, 36, "RELAY", "", "browsers have no UDP", "sm"],
    [
      -34,
      8,
      74,
      "MOBILE",
      "",
      "Expo · replica ⊕ outbox · offline first-class",
      "",
    ],
    [-80, 3, 46, "COMPANION", "", "allow-listed tools only", "sm"],
    [
      -112,
      20,
      -6,
      "FAR WAREHOUSE",
      "",
      "sealed snapshots · leaves the isle",
      "sm net",
    ],
    [-105, 11, 0.5, "RECOVERY KIT", "", "wrapped · password = custody", "sm"],
  ];

  // ── renderer, camera, orbit ────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.3;
  document.body.prepend(renderer.domElement);

  const cam = new THREE.PerspectiveCamera(38, 1, 0.1, 900);
  const FOCI = {
    isle: { r: 236, theta: 0.47, phi: 0.86, target: [-6, -14, 10] },
    vault: { r: 84, theta: 0.38, phi: 1.15, target: [-2, 8, -6] },
    gate: { r: 70, theta: 0.12, phi: 1.02, target: [0, 8, 48] },
    keycab: { r: 34, theta: 0.55, phi: 1.08, target: [13, 5, 46] },
    clerk: { r: 38, theta: 0.05, phi: 1.08, target: [0, 5, 28] },
    ledger: { r: 62, theta: 0.85, phi: 1.0, target: [34, 7, 4] },
    automation: { r: 62, theta: -0.55, phi: 1.0, target: [-35, 7, 2] },
    harness: { r: 52, theta: 1.05, phi: 1.02, target: [53, 5, -8] },
    commons: { r: 55, theta: -0.75, phi: 1.05, target: [-40, 6, -22] },
    cellar: { r: 55, theta: 0.95, phi: 1.05, target: [26, 5, -30] },
    apps: { r: 60, theta: 0.95, phi: 1.0, target: [47, 7, 47] },
    mobile: { r: 46, theta: 0.35, phi: 1.1, target: [-34, 0, 74] },
    web: { r: 52, theta: 1.1, phi: 1.05, target: [68, -4, 34] },
    desktop: { r: 48, theta: 0.05, phi: 1.1, target: [0, -2, 97] },
    companion: { r: 36, theta: -0.5, phi: 1.15, target: [-80, 0, 46] },
    warehouse: { r: 60, theta: -1.1, phi: 1.0, target: [-108, 8, -6] },
    bridge: { r: 60, theta: 0.2, phi: 1.15, target: [0, 0, 68] },
  };
  const orb = {
    r: 236,
    theta: 0.47,
    phi: 0.86,
    target: new THREE.Vector3(-6, -14, 10),
  };
  let goal = { ...orb, target: orb.target.clone() };
  function fly(k, tweak) {
    const v = FOCI[k] ? FOCI[k] : k === "custom" ? tweak : FOCI.isle;
    goal = {
      r: (tweak && tweak.r) || v.r,
      theta: (tweak && tweak.theta) != null ? tweak.theta : v.theta,
      phi: (tweak && tweak.phi) != null ? tweak.phi : v.phi,
      fov: (tweak && tweak.fov) || v.fov || 38,
      target: new THREE.Vector3(...((tweak && tweak.target) || v.target)),
    };
  }
  function applyCam() {
    cam.position.set(
      orb.target.x + orb.r * Math.sin(orb.phi) * Math.sin(orb.theta),
      orb.target.y + orb.r * Math.cos(orb.phi),
      orb.target.z + orb.r * Math.sin(orb.phi) * Math.cos(orb.theta)
    );
    cam.lookAt(orb.target);
  }
  let drag = null,
    dragMoved = 0;
  renderer.domElement.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY };
    dragMoved = 0;
  });
  addEventListener("pointerup", () => {
    drag = null;
  });
  addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x,
      dy = e.clientY - drag.y;
    dragMoved += Math.abs(dx) + Math.abs(dy);
    goal.theta -= dx * 0.005;
    goal.phi = Math.max(0.12, Math.min(1.45, goal.phi - dy * 0.004));
    drag = { x: e.clientX, y: e.clientY };
  });
  addEventListener(
    "wheel",
    (e) => {
      goal.r = Math.max(
        26,
        Math.min(420, goal.r * (1 + Math.sign(e.deltaY) * 0.08))
      );
    },
    { passive: true }
  );

  // ── labels: x-ray chips projected onto the world ───────────────────────────
  const chips = MAP.map(([x, y, z, t, n, xr, cls]) => {
    const el = document.createElement("div");
    el.className = "lbl " + (cls || "");
    el.innerHTML =
      `<div class="t">${t}${n ? `<span class="n">${n}</span>` : ""}</div>` +
      (xr ? `<div class="x">${xr}</div>` : "");
    document.body.appendChild(el);
    return { el, v: new THREE.Vector3(x, y, z) };
  });
  // progressive disclosure: 'story' shows no chips, 'mech' shows only chips
  // near the camera's focus, 'expert' shows everything the culling allows
  let detail = "mech";
  function xray(mode) {
    detail = mode;
    chips.forEach(
      (c) => (c.el.style.display = mode === "story" ? "none" : "block")
    );
  }
  xray("mech");

  // ── pulses: beat-driven halos over landmarks ───────────────────────────────
  const pulses = new Map();
  function pulse(name, on) {
    const a = ANCHORS[name];
    if (!a) return;
    let p = pulses.get(name);
    if (on && !p) {
      const h = halo(a[0], a[1], a[2], a[3] || HUE.warm, a[4] || 14, 0.0);
      let ph = pulses.size * 1.7;
      const upd = (t) => {
        h.material.opacity = 0.22 + Math.max(0, Math.sin(t * 2.4 + ph)) * 0.4;
      };
      anim.push(upd);
      p = { h, upd };
      pulses.set(name, p);
    } else if (!on && p) {
      const i = anim.indexOf(p.upd);
      if (i >= 0) anim.splice(i, 1);
      scene.remove(p.h);
      pulses.delete(name);
    }
  }

  // ── night mode ═══ "the night the disk was stolen" ══════════════════════════
  let night = false;
  function setNight(on) {
    if (on === night) return;
    night = on;
    inkSky(on);
    fog.color.setHex(on ? 0x1c1a30 : 0x3a3350);
    fog.near = on ? 150 : 190;
    fog.far = on ? 460 : 520;
    sun.intensity = on ? 0.7 : 2.6;
    hemi.intensity = on ? 0.9 : 1.7;
    fillA.intensity = on ? 0.3 : 0.55;
    fillB.intensity = on ? 0.35 : 0.85;
    pools.forEach((pl) => (pl.intensity = on ? 550 : 900));
    moonMesh.material.emissiveIntensity = on ? 1.6 : 0.8;
    document.body.classList.toggle("night", on);
  }

  // ── vault cells: what a copy yields ═════════════════════════════════════════
  function cellsCopied(n) {
    let lit = 0;
    for (let i = 0; i < cells.length; i++) {
      const isLit = i % 3 === 0;
      if (isLit && lit < n) {
        cells[i].material = mat(0x111218, { e: HUE.net, ei: 2.2 });
        cells[i].material.emissiveIntensity = 1.6 + Math.sin(i) * 0.4;
        lit++;
      } else if (isLit) {
        cells[i].material = mat(0x111218, { e: 0x2a3140, ei: 1 });
      }
    }
  }

  // ── anchors for engine callouts (world coords + halo color + size) ─────────
  const ANCHORS = {
    vault: [0, 26, -2, HUE.warm, 16],
    ledger: [34, 15, 2, HUE.amber, 14],
    gate: [0, 17, 50, HUE.slate, 13],
    keycab: [15.5, 8, 46, HUE.warm, 8],
    clerk: [0, 9, 28, HUE.violet, 8],
    automation: [-35, 15, 2, HUE.violet, 13],
    harness: [54, 10, -8, HUE.ochre, 12],
    commons: [-40, 10, -22, HUE.forest, 11],
    cellar: [26, 9, -30, HUE.teal, 12],
    apps: [47, 11, 47, HUE.amber, 13],
    mobile: [-34, 3, 74, HUE.indigo, 10],
    web: [70, -4, 34, HUE.relay, 10],
    desktop: [0, 2, 97, HUE.slate, 11],
    companion: [-80, 3, 46, HUE.rose, 8],
    warehouse: [-112, 14, -6, HUE.net, 15],
    kit: [-105, 7.5, 0.5, HUE.warm, 7],
    bridge: [0, 4, 70, HUE.slate, 10],
    relay: [60, 44, 36, HUE.relay, 12],
    isle: [-6, 2, 10, HUE.slate, 30],
    void: [0, 30, 120, HUE.slate, 20],
  };

  function project(v) {
    const p = v.clone().project(cam);
    return {
      x: (p.x * 0.5 + 0.5) * innerWidth,
      y: (-p.y * 0.5 + 0.5) * innerHeight,
      behind: p.z > 1,
    };
  }

  function resize() {
    const w = innerWidth,
      h = innerHeight;
    renderer.setSize(w, h);
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
  }
  addEventListener("resize", resize);
  resize();

  // ── loop ───────────────────────────────────────────────────────────────────
  const clock = new THREE.Clock();
  let t = 0;
  (function frame() {
    requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05);
    t += dt;
    const k = 1 - Math.pow(0.001, dt);
    orb.r += (goal.r - orb.r) * k;
    orb.theta += (goal.theta - orb.theta) * k;
    orb.phi += (goal.phi - orb.phi) * k;
    orb.target.lerp(goal.target, k);
    if (goal.fov) {
      cam.fov += (goal.fov - cam.fov) * k;
      cam.updateProjectionMatrix();
    }
    applyCam();
    for (const fn of anim) fn(t, dt);
    renderer.render(scene, cam);
    const far = orb.r > 125;
    if (detail !== "story") {
      // greedy collision avoidance: major labels win their space, small labels
      // only near the focus — the overview never becomes a pile of chips
      const placed = [];
      const prio = (el) => (el.classList.contains("sm") ? 1 : 0);
      const cand = chips
        .map((c) => ({ c, q: project(c.v) }))
        .filter(({ c, q }) => {
          const isSm = c.el.classList.contains("sm");
          const near = c.v.distanceTo(orb.target) < 115;
          return (
            !q.behind &&
            q.x > -80 &&
            q.x < innerWidth * 1.08 &&
            q.y > 40 &&
            q.y < innerHeight - 90 &&
            (detail === "expert" || near || (!isSm && !far))
          );
        })
        .sort((a, b) => prio(a.c.el) - prio(b.c.el));
      for (const { c, q } of cand) {
        const w = c.el.offsetWidth || 120,
          h = c.el.offsetHeight || 40;
        const r1 = {
          x: q.x - w / 2 - 6,
          y: q.y - h / 2 - 4,
          w: w + 12,
          h: h + 8,
        };
        const hit = placed.some(
          (r2) =>
            r1.x < r2.x + r2.w &&
            r1.x + r1.w > r2.x &&
            r1.y < r2.y + r2.h &&
            r1.y + r1.h > r2.y
        );
        if (hit) {
          c.el.style.display = "none";
          continue;
        }
        placed.push(r1);
        c.el.style.display = "block";
        c.el.style.left = q.x + "px";
        c.el.style.top = q.y + "px";
      }
    }
    for (const fn of frameHooks) fn(t);
  })();

  return {
    fly,
    pulse,
    setNight,
    addParcel,
    removeParcel,
    cutTether,
    setOutbox,
    cellsCopied,
    xray,
    project,
    setBuild,
    setScopes,
    revokeScope,
    syncLoop,
    pack,
    onFrame: (fn) => frameHooks.push(fn),
    ANCHORS,
    FOCI,
    HUE,
    MAP,
    night: () => night,
    vec: (x, y, z) => new THREE.Vector3(x, y, z),
  };
})();
window.__isleReady = true;
