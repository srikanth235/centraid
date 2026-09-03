// governance: allow-repo-hygiene file-size-limit — the DOM overlay selectors and

import type * as THREE from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";

import type {
  CityMeta,
  HudApi,
  HudStat,
  HoverTipApi,
  InspectorApi,
  InspectorDetails,
  InspectorRef,
  SimStats,
  TourApi,
  TourChapter,
  TourPosition,
  WorldApi,
} from "../core/types.js";

const $ = <T extends Element = HTMLElement>(id: string): T =>
  document.querySelector<T>(`#${id}`)!;

function row(k: string, v: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = "kv";
  const b = document.createElement("b");
  b.textContent = k;
  const s = document.createElement("span");
  s.textContent = v;
  d.append(b, s);
  return d;
}

function para(text: string, cls?: string): HTMLParagraphElement {
  const p = document.createElement("p");
  if (cls) p.className = cls;
  p.textContent = text;
  return p;
}

function sec(text: string): HTMLDivElement {
  const h = document.createElement("div");
  h.className = "insp-sec";
  h.textContent = text;
  return h;
}

export function createLoading(
  meta: CityMeta,
  onDone: () => void
): { finish: () => void } {
  const el = $("loading");
  const msgEl = $("loadMsg");
  const barEl = $("loadBar");
  $("loadTitle").textContent = meta.title || "";
  $("loadSub").textContent = meta.subtitle || "";
  const msgs = (meta.loadingMessages || []).slice();
  let i = 0;
  let timer = 0;
  const step = () => {
    if (i < msgs.length) msgEl.textContent = msgs[i];
    barEl.style.width = `${Math.min(100, Math.round(((i + 1) / Math.max(1, msgs.length)) * 100))}%`;
    i++;
    if (i <= msgs.length) timer = window.setTimeout(step, 380);
    else finish();
  };
  let finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    window.clearTimeout(timer);
    barEl.style.width = "100%";
    window.setTimeout(() => {
      el.classList.add("done");
      if (onDone) onDone();
    }, 260);
  }
  step();
  return { finish };
}

interface StatDisplay {
  v: number;
  dp: number;
  hot?: boolean;
  bad?: boolean;
}

type StatMatcher = [RegExp, (stats: SimStats) => StatDisplay];

const STAT_MATCHERS: StatMatcher[] = [
  [/fps|frame/iu, (s) => ({ v: s.fps, dp: 0 })],
  [/turn/iu, (s) => ({ v: s.turns, dp: 2 })],
  [/item|append/iu, (s) => ({ v: s.items, dp: 1 })],
  [/wal|kib|write.?ahead/iu, (s) => ({ v: s.wal, dp: 0, hot: s.wal > 90 })],
  [
    /approv|park|pending|consent/iu,
    (s) => ({ v: s.approvals, dp: 0, hot: s.approvals > 3 }),
  ],
  [/lag|replica|sync/iu, (s) => ({ v: s.lag, dp: 1, bad: s.lag > 6 })],
  [/cas|blob|occupan|storage/iu, (s) => ({ v: s.cas, dp: 0, hot: s.cas > 85 })],
  [/cron|next|timer|automation/iu, (s) => ({ v: s.cron, dp: 0 })],
];

export function createHud(hudStats: HudStat[], meta: CityMeta): HudApi {
  $("brandTitle").textContent = meta.title || "";
  $("brandSub").textContent = meta.subtitle || "";
  $("legal").textContent = meta.legal || "";
  const wrap = $("stats");
  wrap.textContent = "";
  const given = hudStats && hudStats.length ? hudStats.slice() : [];
  const hasFps = given.some((d) =>
    /fps|frame/iu.test(`${d.id || ""} ${d.label || ""}`)
  );
  const defs = hasFps
    ? given
    : given.concat([{ id: "fps", label: "FPS", unit: "" }]);
  const cells = defs.map((d) => {
    const el = document.createElement("div");
    el.className = "stat";
    const k = document.createElement("div");
    k.className = "k";
    k.textContent = d.label || d.id;
    const v = document.createElement("div");
    v.className = "v";
    v.innerHTML = "<b>–</b>";
    el.append(k, v);
    wrap.append(el);
    const key = `${d.id || ""} ${d.label || ""} ${d.unit || ""}`;
    const matcher = STAT_MATCHERS.find(([re]) => re.test(key))?.[1];
    return { def: d, el, v, matcher };
  });

  return {
    update(stats) {
      for (const c of cells) {
        if (!c.matcher) continue;
        const r = c.matcher(stats);
        const num = Number.isFinite(r.v) ? r.v.toFixed(r.dp) : "–";
        c.v.innerHTML = `${num}${c.def.unit ? `<u>${c.def.unit}</u>` : ""}`;
        c.el.classList.toggle("hot", !!r.hot);
        c.el.classList.toggle("bad", !!r.bad);
      }
    },
  };
}

export function createInspector({
  onFocus,
}: {
  onFocus: (ref: InspectorRef) => void;
}): InspectorApi {
  const el = $("inspector");
  const body = $("inspBody");
  $("inspClose").addEventListener("click", () => close());
  let current = null;

  function close() {
    el.classList.remove("open");
    current = null;
  }

  function show({
    title,
    subtitle,
    color,
    lede,
    detail,
    codeRef,
    state,
    chips,
  }: InspectorDetails): void {
    $("inspTitle").textContent = title || "";
    $("inspSub").textContent = subtitle || "";
    $("inspSwatch").style.background = color || "#39c5ea";
    body.textContent = "";
    if (lede) body.append(para(lede, "lede"));
    if (detail) body.append(para(detail));
    if (codeRef) {
      body.append(sec("In the real code"));
      const c = document.createElement("code");
      c.className = "code-ref";
      c.textContent = codeRef;
      body.append(c);
    }
    if (state && state.length) {
      body.append(sec("Live in this model"));
      const box = document.createElement("div");
      for (const [k, v] of state) box.append(row(k, v));
      body.append(box);
    }
    if (chips && chips.length) {
      body.append(sec("Nearby"));
      const box = document.createElement("div");
      box.className = "chips";
      for (const c of chips) {
        const b = document.createElement("button");
        b.className = "chip";
        b.textContent = c.label;
        b.addEventListener("click", () => onFocus(c.ref));
        box.append(b);
      }
      body.append(box);
    }
    el.classList.add("open");
  }

  return {
    show,
    close,
    get isOpen() {
      return el.classList.contains("open");
    },
    get current() {
      return current;
    },
    set current(v) {
      current = v;
    },
    refreshState(state) {
      const rows = body.querySelectorAll(".kv span");
      state.forEach(([, v], i) => {
        if (rows[i]) rows[i].textContent = v;
      });
    },
  };
}

const SECTION_LABELS = new Map([
  ["walkthrough", "The walkthrough"],
  ["scenarios", "Scenarios"],
]);

export function createTour(
  chapters: TourChapter[],
  {
    onEnter,
    onExit,
    districtNames,
  }: {
    onEnter: (chapter: TourChapter, position: TourPosition) => void;
    onExit: () => void;
    districtNames: Map<string, string>;
  }
): TourApi {
  const el = $("tour");
  const dots = $("tourDots");
  const panel = $("contents");
  const listEl = $("contentsList");
  const btnToggle = $("btnTour");
  const list = chapters || [];
  const names = districtNames || new Map();
  let idx = -1;
  let pidx = 0;
  let syncingHash = false;

  const pagesOf = (c: TourChapter): NonNullable<TourChapter["pages"]> => {
    const p = c && Array.isArray(c.pages) ? c.pages.filter(Boolean) : null;
    if (p && p.length) return p;
    return [{ body: (c && c.body) || "" }];
  };
  const pageList = list.map(pagesOf);
  const lastPage = (i) => pageList[i].length - 1;

  let dotEls = [];
  let dotsFor = -1;

  function buildDots(i) {
    dotsFor = i;
    dotEls = [];
    dots.textContent = "";
    const n = pageList[i].length;
    if (n < 2) {
      dots.hidden = true;
      return;
    }
    dots.hidden = false;
    for (let p = 0; p < n; p++) {
      const b = document.createElement("button");
      b.type = "button";
      b.title = `Page ${p + 1} of ${n}`;
      b.setAttribute("aria-label", `Page ${p + 1} of ${n}`);
      b.addEventListener("click", () => go(i, p));
      dots.append(b);
      dotEls.push(b);
    }
  }

  const countEl = $("tocCount");
  if (countEl)
    countEl.textContent = list.length ? `${list.length} chapters` : "";

  listEl.textContent = "";
  let openSection = null;
  const rowEls = list.map((c, i) => {
    if (c.section && c.section !== openSection) {
      openSection = c.section;
      const head = document.createElement("li");
      head.className = "toc-sec";
      head.setAttribute("role", "presentation");
      const h = document.createElement("h3");
      h.textContent = SECTION_LABELS.get(c.section) || c.section;
      head.append(h);
      listEl.append(head);
    }
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "toc-row";
    const num = document.createElement("span");
    num.className = "toc-num";
    num.textContent = String(i + 1).padStart(2, "0");
    const text = document.createElement("span");
    text.className = "toc-text";
    const title = document.createElement("span");
    title.className = "toc-title";
    title.textContent = c.title || c.id || "";
    const where = document.createElement("span");
    where.className = "toc-district";
    where.textContent = names.get(c.districtId) || c.districtId || "";
    text.append(title, where);
    b.append(num, text);
    b.addEventListener("click", () => go(i));
    li.append(b);
    listEl.append(li);
    return b;
  });

  function openPanel() {
    panel.classList.add("open");
    if (btnToggle) btnToggle.setAttribute("aria-expanded", "true");
    const focusTarget = rowEls[idx] || $("tocRestart") || rowEls[0];
    if (focusTarget) focusTarget.focus();
  }

  function closePanel() {
    if (!panel.classList.contains("open")) return;
    const hadFocus = panel.contains(document.activeElement);
    panel.classList.remove("open");
    if (btnToggle) {
      btnToggle.setAttribute("aria-expanded", "false");
      if (hadFocus) btnToggle.focus();
    }
  }

  function togglePanel() {
    if (panel.classList.contains("open")) closePanel();
    else openPanel();
  }

  function setHash(hash) {
    if (location.hash === hash) return;
    if (hash) {
      syncingHash = true;
      location.hash = hash;
      window.setTimeout(() => {
        syncingHash = false;
      }, 0);
    } else if (location.hash) {
      history.replaceState(null, "", location.pathname + location.search);
    }
  }

  function parseHash(): { i: number; p: number } {
    const raw = decodeURIComponent(location.hash.replace(/^#/u, ""));
    if (!raw) return { i: -1, p: 0 };
    const m = /^(?<id>.*?)(?:\/(?<page>\d+))?$/u.exec(raw);
    const p = m.groups.page
      ? Math.max(0, Math.trunc(Number(m.groups.page)) - 1)
      : 0;
    return { i: list.findIndex((c) => c.id === m.groups.id), p };
  }

  function applyHash() {
    const { i, p } = parseHash();
    if (i >= 0) {
      if (i !== idx || p !== pidx) go(i, p);
    } else if (idx >= 0) {
      stop();
    }
  }

  window.addEventListener("hashchange", () => {
    if (syncingHash) {
      syncingHash = false;
      return;
    }
    applyHash();
  });

  function render(chapterChanged) {
    const c = list[idx];
    if (!c) return;
    const pages = pageList[idx];
    const page = pages[pidx];
    const many = pages.length > 1;
    $("tourStep").textContent = many
      ? `Chapter ${idx + 1} of ${list.length} · Page ${pidx + 1} of ${pages.length}`
      : `Chapter ${idx + 1} of ${list.length}`;
    $("tourTitle").textContent = c.title || "";
    $("tourBody").textContent = page.body || "";

    const dotsHadFocus = dots.contains(document.activeElement);
    if (chapterChanged || dotsFor !== idx) buildDots(idx);
    dotEls.forEach((b, p) => {
      if (p === pidx) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    });
    if (
      dotsHadFocus &&
      dotEls[pidx] &&
      !dots.contains(document.activeElement)
    ) {
      dotEls[pidx].focus();
    }

    rowEls.forEach((r, i) => {
      if (i === idx) r.setAttribute("aria-current", "step");
      else r.removeAttribute("aria-current");
    });
    const activeRow = rowEls[idx];
    if (activeRow && panel.classList.contains("open"))
      activeRow.scrollIntoView({ block: "nearest" });

    const atStart = idx === 0 && pidx === 0;
    const atEnd = idx === list.length - 1 && pidx === lastPage(idx);
    $<HTMLButtonElement>("tourPrev").disabled = atStart;
    $<HTMLButtonElement>("tourPrev").style.opacity = String(atStart ? 0.4 : 1);
    $<HTMLButtonElement>("tourNext").textContent = atEnd ? "Finish" : "Next";
    setHash(c.id ? (pidx > 0 ? `#${c.id}/${pidx + 1}` : `#${c.id}`) : "");
    onEnter(c, {
      page,
      pageIndex: pidx,
      pageCount: pages.length,
      chapterChanged: !!chapterChanged,
      buildingId: page.buildingId || c.buildingId,
      flows: page.flows || c.flows || null,
    });
  }

  function go(i, p = 0) {
    if (!list.length) return;
    if (i >= list.length) return stop();
    const next = Math.max(0, Math.min(list.length - 1, i));
    const chapterChanged = next !== idx;
    idx = next;
    pidx = Math.max(0, Math.min(lastPage(idx), p));
    el.classList.add("open");
    render(chapterChanged);
  }

  function stop() {
    if (idx < 0 && !el.classList.contains("open")) {
      setHash("");
      return;
    }
    idx = -1;
    pidx = 0;
    el.classList.remove("open");
    dotEls.forEach((d) => d.removeAttribute("aria-current"));
    rowEls.forEach((r) => r.removeAttribute("aria-current"));
    setHash("");
    onExit();
  }

  function nextPage() {
    if (idx < 0) return go(0, 0);
    if (pidx < lastPage(idx)) go(idx, pidx + 1);
    else go(idx + 1, 0); // past the last chapter, go() falls through to stop()
  }

  function prevPage() {
    if (idx < 0) return;
    if (pidx > 0) go(idx, pidx - 1);
    else if (idx > 0) go(idx - 1, Number.POSITIVE_INFINITY);
  }

  function pageIn(delta) {
    if (idx < 0) return;
    const p = pidx + delta;
    if (p < 0 || p > lastPage(idx)) return;
    go(idx, p);
  }

  $("tourNext").addEventListener("click", nextPage);
  $("tourPrev").addEventListener("click", prevPage);
  $("tourClose").addEventListener("click", stop);
  $("tocClose").addEventListener("click", closePanel);
  $("tocRestart").addEventListener("click", () => go(0));

  return {
    start: () => go(0),
    stop,
    next: nextPage,
    prev: prevPage,
    nextInChapter: () => pageIn(1),
    prevInChapter: () => pageIn(-1),
    goTo: (i, p) => go(i, p),
    openPanel,
    closePanel,
    togglePanel,
    applyHash,
    get panelOpen() {
      return panel.classList.contains("open");
    },
    get active() {
      return idx >= 0;
    },
    get count() {
      return list.length;
    },
  };
}

export function createToast(): (text: string, ms?: number) => void {
  const el = $("toast");
  let t = 0;
  return function toast(text, ms = 2600) {
    el.textContent = text;
    el.classList.add("on");
    window.clearTimeout(t);
    t = window.setTimeout(() => el.classList.remove("on"), ms);
  };
}

export function createHoverTip(): HoverTipApi {
  const el = $("hoverTip");
  return {
    show(title, sub, x, y) {
      el.innerHTML = "";
      const u = document.createElement("u");
      u.textContent = sub || "";
      el.append(document.createTextNode(title));
      el.append(u);
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.classList.add("on");
    },
    move(x, y) {
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    },
    hide() {
      el.classList.remove("on");
    },
  };
}

export function createMinimap(
  world: WorldApi
): (
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  highlightId?: string
) => void {
  const cv = $<HTMLCanvasElement>("minimap");
  const g = cv.getContext("2d");
  const S = cv.width;
  const EXT = 180; // world half-extent shown
  const toPx = (v) => ((v + EXT) / (EXT * 2)) * S;

  return function draw(camera, controls, highlightId) {
    g.clearRect(0, 0, S, S);
    g.fillStyle = "rgba(8,13,22,.85)";
    g.fillRect(0, 0, S, S);
    g.strokeStyle = "rgba(140,168,205,.18)";
    g.lineWidth = 2;
    g.strokeRect(1, 1, S - 2, S - 2);

    for (const d of world.districts) {
      const p = d.data.plate;
      const x = toPx(p.x - p.w / 2);
      const y = toPx(p.z - p.d / 2);
      const w = (p.w / (EXT * 2)) * S;
      const h = (p.d / (EXT * 2)) * S;
      const hot = d.data.id === highlightId;
      g.fillStyle = hexA(d.color, hot ? 0.85 : 0.42);
      g.fillRect(x, y, w, h);
      if (hot) {
        g.strokeStyle = "#ffffff";
        g.lineWidth = 3;
        g.strokeRect(x, y, w, h);
      }
    }

    const cx = toPx(camera.position.x);
    const cy = toPx(camera.position.z);
    const tx = toPx(controls.target.x);
    const ty = toPx(controls.target.z);
    g.strokeStyle = "rgba(57,197,234,.9)";
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(tx, ty);
    g.stroke();
    g.fillStyle = "#39c5ea";
    g.beginPath();
    g.arc(cx, cy, 6, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "rgba(255,255,255,.85)";
    g.beginPath();
    g.arc(tx, ty, 3.5, 0, Math.PI * 2);
    g.fill();
  };
}

function hexA(hex: string, a: number): string {
  const h = String(hex || "#39c5ea").replace("#", "");
  const n = Number.parseInt(
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h,
    16
  );
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
