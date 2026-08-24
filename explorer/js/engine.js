/* ============================================================================
   Centraid Explorer — beat player over the Sovereign Isle.
   Drives ISLE: camera foci, pulses, parcels, callouts, night, tethers.
   ============================================================================ */
"use strict";

(() => {
  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let R = window.ISLE; // active renderer: ISLE (3D) or FLAT (2D)
  const calloutsEl = document.getElementById("callouts");

  /* ---------- beat-scoped world state ---------- */
  const spawned = []; // parcel ids created by beats
  const pulsed = new Set(); // landmark names pulsing
  let callouts = []; // {el, v:Vector3}
  let ledgerEl = null,
    ledgerRows = [];

  function clearCallouts() {
    callouts.forEach((c) => c.el.remove());
    callouts = [];
  }
  function removeCallout(id) {
    const i = callouts.findIndex((c) => c.id === id);
    if (i >= 0) {
      callouts[i].el.remove();
      callouts.splice(i, 1);
    }
  }
  function anchorVec(at) {
    if (Array.isArray(at)) return R.vec(at[0], at[1], at[2]);
    const a = R.ANCHORS[at];
    return a ? R.vec(a[0], a[1], a[2]) : R.vec(0, 10, 0);
  }
  function addCallout(op) {
    if (op.id) removeCallout(op.id);
    const el = document.createElement("div");
    el.className =
      "callout tone-" + (op.tone || "info") + (op.cls ? " " + op.cls : "");
    el.innerHTML = "<b>" + esc(op.title) + "</b>" + esc(op.body || "");
    calloutsEl.appendChild(el);
    callouts.push({
      id: op.id || "c" + Math.random(),
      el,
      v: anchorVec(op.at),
      dy: op.dy || 0,
    });
  }
  function ensureLedger() {
    if (ledgerEl) return;
    ledgerEl = document.createElement("div");
    ledgerEl.className = "callout ledger tone-info";
    ledgerEl.innerHTML = "<b>JOURNAL.DB — inked in order, never erased</b>";
    calloutsEl.appendChild(ledgerEl);
    callouts.push({ id: "__ledger", el: ledgerEl, v: null, ledger: true });
  }
  function ledgerRow(text, tone) {
    ensureLedger();
    const r = document.createElement("div");
    r.className = "row " + (tone || "");
    r.textContent = (tone === "in" ? "> " : "· ") + text;
    ledgerEl.appendChild(r);
    ledgerRows.push(text);
    while (ledgerEl.children.length > 7)
      ledgerEl.removeChild(ledgerEl.children[1]);
  }
  function clearLedger() {
    if (ledgerEl) {
      ledgerEl.remove();
      ledgerEl = null;
    }
    callouts = callouts.filter((c) => !c.ledger);
    ledgerRows = [];
  }
  // project callouts through the ACTIVE renderer, each engine tick
  function placeCallouts() {
    for (const c of callouts) {
      let v = c.v;
      if (c.ledger) {
        const a = R.ANCHORS.ledger;
        v = R.vec(a[0] - 6, a[1] + 6, a[2] + 14);
      }
      const q = R.project(v);
      c.el.style.display = q.behind ? "none" : "block";
      if (!q.behind) {
        c.el.style.left = q.x + "px";
        c.el.style.top = q.y - c.dy + "px";
      }
    }
  }

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  /* ---------- fx ops ---------- */
  function resetWorld() {
    clearCallouts();
    clearLedger();
    spawned.forEach((id) => R.removeParcel(id));
    spawned.length = 0;
    pulsed.forEach((n) => R.pulse(n, false));
    pulsed.clear();
    R.setNight(false);
    R.setOutbox(0);
    R.cellsCopied(0);
    R.cutTether("mobile", false);
    R.setBuild(1);
    R.setScopes(0);
    R.pack(false);
    R.syncLoop(false);
  }

  function applyOp(op) {
    switch (op.k) {
      case "spawn":
      case "move": {
        const id = op.id || "p" + Math.random();
        if (op.k === "spawn" && !op.path) break;
        R.addParcel(
          id,
          op.path,
          R.HUE[op.color] || op.color || R.HUE.slate,
          op.s || 1.2,
          op.speed || 0.07,
          op.phase || 0
        );
        if (op.k === "spawn") spawned.push(id);
        break;
      }
      case "remove": {
        R.removeParcel(op.id);
        const i = spawned.indexOf(op.id);
        if (i >= 0) spawned.splice(i, 1);
        break;
      }
      case "clearA":
        spawned.forEach((id) => R.removeParcel(id));
        spawned.length = 0;
        break;
      case "pulse":
        R.pulse(op.el, op.on);
        op.on ? pulsed.add(op.el) : pulsed.delete(op.el);
        break;
      case "callout":
        addCallout(op);
        break;
      case "cclear":
        clearCallouts();
        break;
      case "ledgerRow":
        ledgerRow(op.text, op.tone);
        break;
      case "lclear":
        clearLedger();
        break;
      case "night":
        R.setNight(!!op.on);
        break;
      case "cut":
        R.cutTether(op.name, !!op.on);
        break;
      case "outbox":
        R.setOutbox(op.n);
        break;
      case "cells":
        R.cellsCopied(op.n);
        break;
      case "build":
        R.setBuild(op.p);
        break;
      case "scopes":
        R.setScopes(op.n);
        break;
      case "revoke":
        R.revokeScope(op.n ?? 3);
        break;
      case "sync":
        R.syncLoop(!!op.on);
        break;
      case "pack":
        R.pack(!!op.on);
        break;
      case "reset":
        resetWorld();
        break;
    }
  }

  function buildFxQueue(fx) {
    const q = [];
    let t = 0;
    (fx || []).forEach((op) => {
      if (op.k === "wait") {
        t += op.s;
        return;
      }
      t += op.wait || op.at || 0;
      q.push({ at: t * 1000, op });
    });
    return q;
  }

  /* ---------- journey / beat control ---------- */
  const tabsEl = document.getElementById("journeyTabs");
  const railEl = document.getElementById("rail");
  const narrT = document.getElementById("narrTitle");
  const narrX = document.getElementById("narrText");
  const narrS = document.getElementById("narrSrc");
  const stepPos = document.getElementById("stepPos");

  let curJourney = null,
    curBeat = -1,
    fxQueue = [],
    beatStart = 0,
    playing = false;

  function fmtText(s) {
    return esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
  }

  function renderTabs() {
    tabsEl.innerHTML = "";
    JOURNEYS.forEach((j) => {
      const b = document.createElement("button");
      b.className = "pill" + (curJourney === j.id ? " on" : "");
      b.innerHTML = "<b>" + j.tab + "</b>";
      b.onclick = () => go(j.id, 0);
      tabsEl.appendChild(b);
    });
  }
  function renderRail() {
    railEl.innerHTML = "";
    if (!curJourney) {
      document.body.classList.add("rail-hidden");
      return;
    }
    document.body.classList.remove("rail-hidden");
    const j = JOURNEYS.find((x) => x.id === curJourney);
    const h = document.createElement("h3");
    h.textContent = j.title;
    railEl.appendChild(h);
    let lastAct = null;
    j.beats.forEach((b, i) => {
      const act = (ACTS[j.id] || []).find(([from]) => from === i);
      if (act && act[1] !== lastAct) {
        lastAct = act[1];
        const a = document.createElement("div");
        a.className = "act";
        a.textContent = act[1];
        railEl.appendChild(a);
      }
      const bt = document.createElement("button");
      bt.className = "chap" + (i === curBeat ? " active" : "");
      bt.innerHTML =
        '<span class="n">' +
        String(i + 1).padStart(2, "0") +
        "</span><span>" +
        esc(b.t) +
        "</span>";
      bt.onclick = () => go(curJourney, i);
      railEl.appendChild(bt);
    });
  }

  function beatDwell(b) {
    const fxTail = (b.fx || []).reduce(
      (t, o) =>
        t +
        (o.k === "wait"
          ? o.s
          : (o.wait || o.at || 0.8) + (o.speed ? (1 / o.speed) * 0.35 : 0)),
      0
    );
    return Math.max(4.5, 2.4 + b.text.length / 24, fxTail * 0.6 + 3);
  }

  function enterBeat() {
    const j = JOURNEYS.find((x) => x.id === curJourney);
    if (!j) {
      enterOverview();
      return;
    }
    const b = j.beats[curBeat];
    resetWorld();
    modeIx = userMode;
    applyMode();
    if (REDUCED)
      R.fly(b.cam.focus === "custom" ? "custom" : b.cam.focus, b.cam); // instant-ish
    else R.fly(b.cam.focus === "custom" ? "custom" : b.cam.focus, b.cam);
    beatStart = performance.now();
    fxQueue = buildFxQueue(b.fx);
    if (REDUCED) {
      while (fxQueue.length) applyOp(fxQueue.shift().op);
    }
    narrT.textContent = b.t;
    narrX.innerHTML = fmtText(b.text);
    if (b.src) {
      narrS.hidden = false;
      narrS.href = b.src.url;
      narrS.textContent = "SOURCE · " + b.src.label;
    } else narrS.hidden = true;
    stepPos.textContent = "BEAT " + (curBeat + 1) + "/" + j.beats.length;
    document.getElementById("prevBtn").disabled = curBeat === 0;
    renderRail();
    history.replaceState(null, "", "#j/" + j.id + "/" + curBeat);
    b._dwell = beatDwell(b);
  }

  function enterOverview() {
    curJourney = null;
    curBeat = -1;
    playing = false;
    updatePlayBtn();
    resetWorld();
    R.fly("isle");
    modeIx = 0;
    applyMode(); // the overview speaks in metaphor only
    narrT.textContent =
      "One person's data, self-contained, with a visible edge.";
    narrX.innerHTML = fmtText(
      "Every landmark is a real Centraid component — the glowing seams are the vault's DEK boundary, the one red thread is backup egress. Pick a journey above or press `→`; once inside, X-RAY lights up the real names beside the metaphor."
    );
    narrS.hidden = false;
    narrS.href = "../README.md";
    narrS.textContent = "SOURCE · ARCHITECTURE.md";
    stepPos.textContent = "THE ISLE";
    renderRail();
    renderTabs();
    history.replaceState(null, "", location.pathname + location.search);
  }

  function go(jid, i) {
    curJourney = jid;
    curBeat = Math.max(
      0,
      Math.min(i, JOURNEYS.find((x) => x.id === jid).beats.length - 1)
    );
    playing = false;
    updatePlayBtn();
    renderTabs();
    enterBeat();
  }
  function next() {
    if (!curJourney) {
      go(JOURNEYS[0].id, 0);
      return;
    }
    const j = JOURNEYS.find((x) => x.id === curJourney);
    if (curBeat < j.beats.length - 1) {
      curBeat++;
      enterBeat();
    } else if (playing) {
      stopPlay();
      enterOverview();
    }
  }
  function prev() {
    if (!curJourney) return;
    if (curBeat > 0) {
      curBeat--;
      enterBeat();
    }
  }

  /* ---------- autoplay ---------- */
  const playBtn = document.getElementById("playBtn");
  function updatePlayBtn() {
    playBtn.textContent = playing ? "❚❚ PAUSE" : "▶ PLAY";
    playBtn.classList.toggle("on", playing);
  }
  playBtn.onclick = () => {
    if (!curJourney) go(JOURNEYS[0].id, 0);
    else {
      playing = !playing;
      updatePlayBtn();
    }
  };
  function stopPlay() {
    playing = false;
    updatePlayBtn();
  }

  /* ---------- input ---------- */
  document.getElementById("prevBtn").onclick = prev;
  document.getElementById("nextBtn").onclick = next;
  document.getElementById("homeBtn").onclick = () => {
    closeModal();
    enterOverview();
  };

  addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (e.key === "ArrowRight") {
      stopPlay();
      next();
    } else if (e.key === "ArrowLeft") {
      stopPlay();
      prev();
    } else if (e.key === "Escape") {
      if (!document.getElementById("modal").hidden) closeModal();
      else {
        stopPlay();
        enterOverview();
      }
    } else if (e.key.toLowerCase() === "x") {
      xrayBtn.onclick();
    }
  });

  // progressive disclosure: STORY → MECHANISM → FULL
  const xrayBtn = document.getElementById("xrayBtn");
  const MODES = [
    ["story", "X-RAY · STORY"],
    ["mech", "X-RAY · MECH"],
    ["expert", "X-RAY · FULL"],
  ];
  let modeIx = 1,
    userMode = 1;
  function applyMode() {
    const [m, label] = MODES[modeIx];
    R.xray(m);
    xrayBtn.textContent = label;
    xrayBtn.classList.toggle("on", modeIx > 0);
  }
  xrayBtn.onclick = () => {
    modeIx = (modeIx + 1) % MODES.length;
    if (curJourney) userMode = modeIx;
    applyMode();
  };
  applyMode();

  /* ---------- 2D / 3D toggle ---------- */
  const dimBtn = document.getElementById("dimBtn");
  const flatCvs = document.getElementById("flat");
  let dim2d = false;
  function setDim(v) {
    dim2d = v;
    R = v ? window.FLAT : window.ISLE;
    flatCvs.hidden = !v;
    R_3D = R_3D || document.querySelector("body > canvas");
    R_3D.style.display = v ? "none" : "block";
    dimBtn.textContent = v ? "3D" : "2D";
    dimBtn.classList.toggle("on", v);
    // replay the current view so state rebuilds in the new renderer
    if (curJourney) enterBeat();
    else enterOverview();
  }
  let R_3D = null;
  dimBtn.onclick = () => setDim(!dim2d);

  /* ---------- modal ---------- */
  const modal = document.getElementById("modal"),
    mContent = document.getElementById("modalContent");
  function openModal(html) {
    mContent.innerHTML = html;
    modal.hidden = false;
  }
  function closeModal() {
    modal.hidden = true;
  }
  document.getElementById("modalClose").onclick = closeModal;
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  document.getElementById("mappingBtn").onclick = () => {
    const rows = MAPPING.map(
      (m) =>
        "<tr><td>" +
        m[0] +
        "</td><td><code>" +
        esc(m[1]) +
        "</code></td><td>" +
        esc(m[2]) +
        "</td></tr>"
    ).join("");
    openModal(
      "<h2>THE MAPPING TABLE</h2>" +
        "<p class='lead'>The rule of this world: every drawn element maps to exactly one real component, and the mapping never lies. When story and mechanism conflict, the mechanism wins and the metaphor changes.</p>" +
        "<table><tr><th>WORLD ELEMENT</th><th>REAL THING</th><th>SOURCE</th></tr>" +
        rows +
        "</table>"
    );
  };
  document.getElementById("glossBtn").onclick = () => {
    const items = GLOSSARY.map(
      (t) =>
        "<div class='gterm'><dt>" +
        t[0] +
        "<code>" +
        esc(t[1]) +
        "</code></dt><dd>" +
        esc(t[2]) +
        "</dd></div>"
    ).join("");
    openModal(
      "<h2>GLOSSARY RAIL</h2>" +
        "<p class='lead'>Binding vocabulary from docs/glossary.md. If a term here drifts from that file, the file wins and this is a bug.</p>" +
        items
    );
  };
  document.getElementById("mapBtn").onclick = () => {
    openModal(
      "<h2>THE WORKSPACE AS DISTRICTS</h2>" +
        "<p class='lead'>The monorepo drawn as towns: a package exists only when distribution, a hard technical wall, or an independently published contract requires it. Roads are declared dependencies; the broken crossings are law.</p>" +
        "<div class='wsmap'>" +
        "<p><b>@centraid/core</b> — the zero-dependency harbor: protocol, blob, civil-time contracts. Roads from: server, vault, client, cli.</p>" +
        "<p><b>@centraid/vault</b> — the ontology keep: vault.db + journal.db DDL, consent gateway, typed commands. Rests on backup + core; consumed by server and desktop.</p>" +
        "<p><b>@centraid/server</b> — the one backend citadel: engine/ (handler loader, conversation ledger, /centraid HTTP), automation/ (manifest + fire spine), acp/ (ACP turn driver), serve. Imports vault, blueprints, core, tunnel — and <b>never</b> the reverse.</p>" +
        "<p><b>@centraid/blueprints</b> — dual-sided workshop: bundled system apps + automation templates (server manifests/handlers, client/mobile UI).</p>" +
        "<p><b>@centraid/client</b> — shared React shell + browser-safe HTTP. <b>@centraid/design</b> — one quiet chroma system shared by every surface. <b>@centraid/tunnel</b> — the Rust byte plane: a dumb, bounded service that decides nothing. <b>@centraid/backup</b> — Node-builtins-only leaf. <b>@centraid/cli</b> — depends on core only.</p>" +
        "<h3>THE WALLS THAT MATTER</h3>" +
        "<p>Seams that used to be package.json edges are import-boundary rules: <code>automation</code> never imports <code>acp</code>; <code>engine</code> imports neither. — ARCHITECTURE.md · Dependency shape</p>" +
        "</div>"
    );
  };

  /* ---------- hash routing ---------- */
  function fromHash() {
    const m = location.hash.match(/^#j\/([\w-]+)\/(\d+)/);
    if (m && JOURNEYS.some((j) => j.id === m[1])) {
      go(m[1], +m[2]);
      return true;
    }
    return false;
  }
  addEventListener("hashchange", () => {
    if (location.hash) fromHash();
  });

  /* ---------- loop ---------- */
  function tick(now) {
    placeCallouts();
    if (curJourney && curBeat >= 0) {
      while (fxQueue.length && now - beatStart >= fxQueue[0].at)
        applyOp(fxQueue.shift().op);
      if (playing) {
        const b = JOURNEYS.find((x) => x.id === curJourney).beats[curBeat];
        if (now - beatStart > (b._dwell || 6) * 1000) next();
      }
    }
    requestAnimationFrame(tick);
  }

  /* ---------- boot ---------- */
  renderTabs();
  if (!fromHash()) enterOverview();
  requestAnimationFrame(tick);
})();
