// governance: allow-repo-hygiene file-size-limit blueprints are single-file by design (read wholesale by one agent); Vitals is a finished product — metric cards, time-axis charts, paired BP logging, backdating, highlights, CSV export — and splitting it would break that "one file" contract.
// Vitals — a pure projection over the personal vault. Every reading rendered
// here is a core.observation row wearing its health.vital extension; every
// mutation is a typed vault command routed through this app's handlers
// (ctx.vault on the gateway side). The app's own data.sqlite stays empty by
// design: revoke the grant and this page goes dark while the model, history
// and receipts remain the owner's.

import {
  armConfirm,
  lineChart,
  localDayKey,
  outcomeMessage,
  readFailed,
  relTime,
  showSkeleton,
  toast,
} from './kit.js';

const $ = (id) => document.getElementById(id);

// ---------- Metric families ----------
// The UI thinks in families, the vault in vital types. Blood pressure is one
// family over two vault types (logged, charted and listed as a pair); every
// other family is 1:1 with its type. `mix` varies the app accent's lightness
// so each family reads distinct without leaving the rose palette.
const FAMILIES = {
  heart_rate: { label: 'Heart rate', unit: 'bpm', types: ['heart_rate'], mix: 0 },
  bp: { label: 'Blood pressure', unit: 'mmHg', types: ['bp_systolic', 'bp_diastolic'], mix: -18 },
  spo2: { label: 'SpO₂', unit: '%', types: ['spo2'], mix: 22 },
  body_weight: { label: 'Weight', unit: 'kg', types: ['body_weight'], mix: -34 },
  glucose: { label: 'Glucose', unit: 'mg/dL', types: ['glucose'], mix: 38 },
  temp: { label: 'Temperature', unit: '°C', types: ['temp'], mix: -8 },
};

// Static adult resting reference ranges — visual cues, not diagnoses.
// `low` tints below (v < low), `high` at or above (v >= high); `band` shades
// the normal zone on the big chart.
const REFERENCE = {
  heart_rate: { low: 50, high: 101, band: [60, 100] },
  bp_systolic: { high: 140, band: [90, 120] },
  bp_diastolic: { high: 90, band: [60, 80] },
  spo2: { low: 92, band: [95, 100] },
  glucose: { low: 70, high: 181, band: [70, 140] },
  temp: { low: 35, high: 38, band: [36.1, 37.2] },
};

const RANGE_DAYS = { W: 7, M: 30, '6M': 182, Y: 365, All: null };
const BP_PAIR_MS = 2 * 60 * 1000; // sys+dia logged within 2 minutes are one measurement
const READ_LIMIT = 1000;
const STORE_KEY = 'vitals.metric';

// ---------- State ----------

let readings = [];
let queryMeta = { total: 0, truncated: false };
let selectedFamily = null;
let selectedRange = 'M';
let selectedContext = null;
let loaded = false;
let readFailedShown = false;
// Session-local observation_ids whose removal the vault parked — the rows
// stay visible (dimmed, chipped) until the owner approves in vault settings,
// at which point the readings query stops returning them.
const pendingVoids = new Set();

// ---------- Formatting ----------

function fmtVal(n) {
  if (!Number.isFinite(n)) return '—';
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function fmtDay(key) {
  const today = localDayKey(new Date());
  if (key === today) return 'Today';
  try {
    return new Date(`${key}T00:00:00`).toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return key;
  }
}

function fmtStamp(ms) {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// Each family keeps the rose accent but shifts lightness so cards read apart.
// Built on --metric-base (resolved at :root) because the result is assigned
// to --accent on cards/panels — var(--accent) here would be circular.
function famColor(key) {
  const mix = FAMILIES[key]?.mix ?? 0;
  if (!mix) return 'var(--metric-base)';
  const tint = mix > 0 ? 'white' : 'black';
  return `color-mix(in srgb, var(--metric-base) ${100 - Math.abs(mix)}%, ${tint})`;
}

function unitFor(familyKey) {
  const f = FAMILIES[familyKey];
  if (!f) return '';
  const latest = readings.find((r) => f.types.includes(r.vital_type) && r.unit);
  return latest?.unit ?? f.unit;
}

// 'val-low' | 'val-high' | '' for one raw reading value.
function rangeClass(vitalType, v) {
  const ref = REFERENCE[vitalType];
  if (!ref || !Number.isFinite(v)) return '';
  if (ref.low != null && v < ref.low) return 'val-low';
  if (ref.high != null && v >= ref.high) return 'val-high';
  return '';
}

// ---------- Banners + outcomes ----------

function notice(text) {
  const el = $('noticeBanner');
  el.textContent = text;
  el.hidden = !text;
}

// One narration for every action outcome; returns true when it executed.
function narrate(outcome, onDenied) {
  if (outcome === undefined) return false; // act() already surfaced the error
  if (outcome?.status === 'executed') {
    notice('');
    return true;
  }
  notice(outcomeMessage(outcome) ?? 'No response from the vault.');
  if (outcome?.status === 'denied' && onDenied) onDenied();
  return false;
}

async function act(action, input) {
  try {
    return await window.centraid.write({ action, input });
  } catch (err) {
    notice(String(err?.message ?? err));
    return undefined;
  }
}

// ---------- Series helpers ----------

// Rows for one family, newest first, numeric values only.
function rowsFor(familyKey) {
  const f = FAMILIES[familyKey];
  if (!f) return [];
  return readings.filter((r) => f.types.includes(r.vital_type) && Number.isFinite(r.value_num));
}

// Chronological time-aware points for one vault vital type.
function seriesFor(vitalType, sinceMs) {
  return readings
    .filter((r) => {
      if (r.vital_type !== vitalType || !Number.isFinite(r.value_num)) return false;
      const t = new Date(r.observed_at).getTime();
      return Number.isFinite(t) && (sinceMs == null || t >= sinceMs);
    })
    .map((r) => ({ x: new Date(r.observed_at).getTime(), y: r.value_num, r }))
    .toSorted((a, b) => a.x - b.x);
}

// Pair systolic/diastolic readings observed within BP_PAIR_MS into one
// "120/80" measurement; unpaired halves still show, honestly alone.
function bpPairs(rows) {
  const sys = rows.filter((r) => r.vital_type === 'bp_systolic');
  const dia = rows.filter((r) => r.vital_type === 'bp_diastolic');
  const used = new Set();
  const out = [];
  for (const s of sys) {
    const st = new Date(s.observed_at).getTime();
    let best = null;
    let bestGap = Infinity;
    for (const d of dia) {
      if (used.has(d.vital_id)) continue;
      const gap = Math.abs(new Date(d.observed_at).getTime() - st);
      if (gap <= BP_PAIR_MS && gap < bestGap) {
        best = d;
        bestGap = gap;
      }
    }
    if (best) used.add(best.vital_id);
    out.push({ sys: s, dia: best, observed_at: s.observed_at });
  }
  for (const d of dia) {
    if (!used.has(d.vital_id)) out.push({ sys: null, dia: d, observed_at: d.observed_at });
  }
  return out.toSorted((a, b) => String(b.observed_at).localeCompare(String(a.observed_at)));
}

function avg(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : NaN;
}

// ---------- Metric cards (the Apple Health home) ----------

function renderCards() {
  const grid = $('cardGrid');
  grid.innerHTML = '';
  const withData = Object.keys(FAMILIES).filter((key) => rowsFor(key).length > 0);
  grid.hidden = withData.length === 0;
  for (const key of withData) grid.appendChild(renderCard(key));
}

function deltaSpan(latest, prev) {
  if (!Number.isFinite(latest) || !Number.isFinite(prev) || latest === prev) return null;
  const up = latest > prev;
  const el = document.createElement('span');
  el.className = `mc-delta ${up ? 'delta-up' : 'delta-down'}`;
  el.textContent = `${up ? '▲' : '▼'}${fmtVal(Math.abs(latest - prev))}`;
  return el;
}

function renderCard(key) {
  const f = FAMILIES[key];
  const rows = rowsFor(key);
  const card = document.createElement('button');
  card.type = 'button';
  card.className = `metric-card${key === selectedFamily ? ' selected' : ''}`;
  card.style.setProperty('--fam', famColor(key));
  card.style.setProperty('--accent', famColor(key)); // kit sparkline picks this up
  card.setAttribute('aria-pressed', key === selectedFamily ? 'true' : 'false');

  const name = document.createElement('span');
  name.className = 'mc-name';
  name.textContent = f.label;

  const valueLine = document.createElement('span');
  valueLine.className = 'mc-value';
  const num = document.createElement('b');
  num.className = 'mc-num';
  const unit = document.createElement('span');
  unit.className = 'mc-unit';
  unit.textContent = unitFor(key);

  let when = '';
  let delta = null;
  let sparkPoints = [];
  if (key === 'bp') {
    const pairs = bpPairs(rows);
    const latest = pairs[0];
    num.textContent = `${fmtVal(latest?.sys?.value_num)}/${fmtVal(latest?.dia?.value_num)}`;
    const cls =
      rangeClass('bp_systolic', latest?.sys?.value_num) ||
      rangeClass('bp_diastolic', latest?.dia?.value_num);
    if (cls) num.classList.add(cls);
    when = relTime(latest?.observed_at);
    delta = deltaSpan(latest?.sys?.value_num, pairs[1]?.sys?.value_num);
    sparkPoints = seriesFor('bp_systolic', null).slice(-30);
  } else {
    const latest = rows[0];
    num.textContent = fmtVal(latest?.value_num);
    const cls = rangeClass(f.types[0], latest?.value_num);
    if (cls) num.classList.add(cls);
    when = relTime(latest?.observed_at);
    delta = deltaSpan(latest?.value_num, rows[1]?.value_num);
    sparkPoints = seriesFor(f.types[0], null).slice(-30);
  }
  valueLine.append(num, unit);
  if (delta) valueLine.appendChild(delta);

  const meta = document.createElement('span');
  meta.className = 'mc-when muted small';
  meta.textContent = when;

  card.append(name, valueLine, meta);
  if (sparkPoints.length >= 2) {
    const spark = document.createElement('div');
    spark.className = 'mc-spark';
    spark.appendChild(
      lineChart(sparkPoints, { width: 160, height: 40, label: `${f.label} trend` }),
    );
    card.appendChild(spark);
  }
  card.addEventListener('click', () => selectFamily(key));
  return card;
}

// ---------- Big time-axis chart ----------

const CH_W = 640;
const CH_H = 210;
const CH_PT = 12;
const CH_PB = 24;
const CH_PX = 10;
const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function tickFormat(spanMs) {
  if (spanMs <= 2 * 86400e3) {
    return (ms) =>
      new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  if (spanMs <= 120 * 86400e3) {
    return (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
}

// The header line above the chart doubles as the scrub readout.
function setChartHeader(valueText, whenText) {
  $('chartValue').textContent = valueText;
  $('chartWhen').textContent = whenText;
}

function chartLatestHeader(fam, series, diaSeries) {
  const last = series[series.length - 1];
  if (!last) return;
  if (selectedFamily === 'bp') {
    const dia = diaSeries?.findLast((p) => Math.abs(p.x - last.x) <= BP_PAIR_MS);
    setChartHeader(
      `${fmtVal(last.y)}/${fmtVal(dia?.y)} ${unitFor('bp')}`,
      relTime(last.r.observed_at),
    );
  } else {
    setChartHeader(`${fmtVal(last.y)} ${unitFor(selectedFamily)}`, relTime(last.r.observed_at));
  }
}

function renderChart() {
  const panel = $('chartPanel');
  const f = FAMILIES[selectedFamily];
  const hasAny = f && rowsFor(selectedFamily).length > 0;
  panel.hidden = !hasAny;
  if (!hasAny) return;
  panel.style.setProperty('--accent', famColor(selectedFamily));
  $('chartTitle').textContent = f.label;

  const days = RANGE_DAYS[selectedRange];
  const since = days == null ? null : Date.now() - days * 86400e3;
  const primaryType = f.types[0];
  const series = seriesFor(primaryType, since);
  const diaSeries = selectedFamily === 'bp' ? seriesFor('bp_diastolic', since) : null;

  const body = $('chartBody');
  body.innerHTML = '';
  const enough = series.length >= 2 || (diaSeries?.length ?? 0) >= 2;
  $('chartEmpty').hidden = enough;
  if (!enough) {
    setChartHeader('', '');
    return;
  }

  const all = diaSeries ? [...series, ...diaSeries] : series;
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  let y0 = Math.min(...ys);
  let y1 = Math.max(...ys);
  const yPad = (y1 - y0 || Math.abs(y1) || 1) * 0.08;
  y0 -= yPad;
  y1 += yPad;
  const plotW = CH_W - CH_PX * 2;
  const plotH = CH_H - CH_PT - CH_PB;
  const sx = (x) => CH_PX + ((x - x0) / (x1 - x0 || 1)) * plotW;
  const sy = (y) => CH_PT + plotH - ((y - y0) / (y1 - y0 || 1)) * plotH;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${CH_W} ${CH_H}`,
    class: 'time-chart',
    role: 'img',
    'aria-label': `${f.label} over time`,
  });

  // Normal band — single-series families only; two BP lines over one band
  // would misread, so the pair relies on point tinting instead.
  const band = selectedFamily === 'bp' ? null : REFERENCE[primaryType]?.band;
  if (band) {
    const top = Math.min(Math.max(band[1], y0), y1);
    const bottom = Math.min(Math.max(band[0], y0), y1);
    if (top > bottom) {
      svg.appendChild(
        svgEl('rect', {
          x: CH_PX,
          y: sy(top),
          width: plotW,
          height: Math.max(sy(bottom) - sy(top), 0),
          class: 'chart-band',
        }),
      );
    }
  }

  const pathOf = (pts) =>
    pts
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`)
      .join(' ');
  if (diaSeries && diaSeries.length >= 2) {
    svg.appendChild(svgEl('path', { d: pathOf(diaSeries), class: 'chart-line chart-line-dia' }));
  }
  if (series.length >= 2) {
    svg.appendChild(svgEl('path', { d: pathOf(series), class: 'chart-line chart-line-main' }));
  }
  const lastPt = series[series.length - 1] ?? diaSeries?.[diaSeries.length - 1];
  svg.appendChild(
    svgEl('circle', { cx: sx(lastPt.x), cy: sy(lastPt.y), r: 3.5, class: 'chart-dot' }),
  );

  // Date ticks along the bottom, min/max on the left edge.
  const fmt = tickFormat(x1 - x0);
  for (let i = 0; i < 4; i += 1) {
    const t = x0 + ((x1 - x0) * i) / 3;
    const anchor = i === 0 ? 'start' : i === 3 ? 'end' : 'middle';
    const text = svgEl('text', {
      x: sx(t),
      y: CH_H - 8,
      class: 'chart-tick',
      'text-anchor': anchor,
    });
    text.textContent = fmt(t);
    svg.appendChild(text);
  }
  const minText = svgEl('text', { x: CH_PX, y: CH_PT + plotH - 3, class: 'chart-tick' });
  minText.textContent = fmtVal(Math.min(...ys));
  const maxText = svgEl('text', { x: CH_PX, y: CH_PT + 9, class: 'chart-tick' });
  maxText.textContent = fmtVal(Math.max(...ys));
  svg.append(minText, maxText);

  // Scrub: pointermove pins the nearest reading into the panel header.
  const guide = svgEl('line', {
    x1: 0,
    y1: CH_PT,
    x2: 0,
    y2: CH_PT + plotH,
    class: 'chart-guide',
    visibility: 'hidden',
  });
  const scrubDot = svgEl('circle', {
    cx: 0,
    cy: 0,
    r: 3.5,
    class: 'chart-dot',
    visibility: 'hidden',
  });
  svg.append(guide, scrubDot);

  const nearest = (pts, x) =>
    pts.reduce((best, p) => (Math.abs(p.x - x) < Math.abs(best.x - x) ? p : best), pts[0]);
  svg.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const vx = ((e.clientX - rect.left) / rect.width) * CH_W;
    const t = x0 + ((vx - CH_PX) / (plotW || 1)) * (x1 - x0);
    const base = series.length ? series : diaSeries;
    const p = nearest(base, t);
    guide.setAttribute('x1', sx(p.x).toFixed(1));
    guide.setAttribute('x2', sx(p.x).toFixed(1));
    guide.setAttribute('visibility', 'visible');
    scrubDot.setAttribute('cx', sx(p.x).toFixed(1));
    scrubDot.setAttribute('cy', sy(p.y).toFixed(1));
    scrubDot.setAttribute('visibility', 'visible');
    if (selectedFamily === 'bp') {
      const dia = diaSeries ? nearest(diaSeries, p.x) : null;
      const paired = dia && Math.abs(dia.x - p.x) <= BP_PAIR_MS ? dia : null;
      setChartHeader(`${fmtVal(p.y)}/${fmtVal(paired?.y)} ${unitFor('bp')}`, fmtStamp(p.x));
    } else {
      setChartHeader(`${fmtVal(p.y)} ${unitFor(selectedFamily)}`, fmtStamp(p.x));
    }
  });
  svg.addEventListener('pointerleave', () => {
    guide.setAttribute('visibility', 'hidden');
    scrubDot.setAttribute('visibility', 'hidden');
    chartLatestHeader(f, series, diaSeries);
  });

  body.appendChild(svg);
  chartLatestHeader(f, series, diaSeries);
}

// ---------- Highlights (computed client-side) ----------

function windowRows(familyKey, fromDaysAgo, toDaysAgo) {
  const now = Date.now();
  const from = now - fromDaysAgo * 86400e3;
  const to = now - toDaysAgo * 86400e3;
  return rowsFor(familyKey).filter((r) => {
    const t = new Date(r.observed_at).getTime();
    return t >= from && t <= to;
  });
}

function famAvgText(familyKey, rows) {
  if (familyKey === 'bp') {
    const s = avg(rows.filter((r) => r.vital_type === 'bp_systolic').map((r) => r.value_num));
    const d = avg(rows.filter((r) => r.vital_type === 'bp_diastolic').map((r) => r.value_num));
    if (!Number.isFinite(s)) return null;
    return `${fmtVal(Math.round(s))}/${fmtVal(Math.round(d))}`;
  }
  const a = avg(rows.map((r) => r.value_num));
  return Number.isFinite(a) ? fmtVal(Math.round(a * 10) / 10) : null;
}

function highlightCard(text) {
  const el = document.createElement('div');
  el.className = 'highlight-card';
  el.textContent = text;
  return el;
}

function renderHighlights() {
  const el = $('highlights');
  el.innerHTML = '';
  const f = FAMILIES[selectedFamily];
  const cards = [];
  if (f) {
    const unit = unitFor(selectedFamily);
    const week = windowRows(selectedFamily, 7, 0);
    const prior = windowRows(selectedFamily, 37, 7);
    const weekAvg = week.length >= 2 ? famAvgText(selectedFamily, week) : null;
    const priorAvg = prior.length >= 2 ? famAvgText(selectedFamily, prior) : null;
    if (weekAvg && priorAvg && weekAvg !== priorAvg) {
      const dir = Number.parseFloat(weekAvg) > Number.parseFloat(priorAvg) ? 'up' : 'down';
      cards.push(
        highlightCard(
          `${f.label} averaged ${weekAvg} ${unit} this week, ${dir} from ${priorAvg} over the prior month.`,
        ),
      );
    } else if (weekAvg) {
      cards.push(highlightCard(`${f.label} averaged ${weekAvg} ${unit} this week.`));
    }
    const month = windowRows(selectedFamily, 30, 0);
    if (selectedFamily !== 'bp' && month.length >= 3) {
      const vals = month.map((r) => r.value_num);
      cards.push(
        highlightCard(
          `Ranged ${fmtVal(Math.min(...vals))}–${fmtVal(Math.max(...vals))} ${unit} across ${month.length} readings in the last 30 days.`,
        ),
      );
    }
  }
  el.hidden = cards.length === 0;
  for (const c of cards) el.appendChild(c);
}

// ---------- Vault summary (the trends action, rendered as a card) ----------

async function runTrends() {
  const f = FAMILIES[selectedFamily];
  if (!f) return;
  const vital_type = f.types[0]; // for BP the vault summarizes systolic
  const days = Number($('trendsDays').value) || 90;
  const btn = $('trendsButton');
  btn.disabled = true;
  const outcome = await act('trends', { vital_type, days });
  btn.disabled = false;
  if (!narrate(outcome, refresh)) return;
  const s = outcome.output ?? {};
  const label = selectedFamily === 'bp' ? 'BP systolic' : f.label;
  $('trendsResult').textContent =
    `${label}, last ${days} days: ${s.count} readings · ${s.min}–${s.max} · avg ${s.avg}`;
  $('trendsResult').classList.remove('muted');
}

// ---------- Attachments (shared pattern across apps) ----------

// Read a File as a base64 data: URI — the vault stores bytes inline, so the
// browser does the encoding before the data ever leaves the app.
function fileToDataUri(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function fmtBytes(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Render an attachment strip: images as thumbnails, everything else as a
// download tile, each with a remove control wired to the detach action.
function renderAttachments(stripEl, list, onRemove) {
  stripEl.innerHTML = '';
  for (const a of list ?? []) {
    const tile = document.createElement('div');
    tile.className = 'attach-tile';
    if (String(a.media_type).startsWith('image/')) {
      const img = document.createElement('img');
      img.src = a.content_uri;
      img.alt = a.title ?? 'attachment';
      tile.appendChild(img);
    } else {
      const link = document.createElement('a');
      link.className = 'attach-file';
      link.href = a.content_uri;
      link.download = a.title ?? 'file';
      link.textContent = (a.title ?? a.media_type ?? 'file').slice(0, 24);
      tile.appendChild(link);
    }
    const meta = document.createElement('span');
    meta.className = 'attach-meta';
    meta.textContent = fmtBytes(a.byte_size);
    tile.appendChild(meta);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'attach-remove';
    rm.textContent = '×';
    rm.title = 'Remove';
    rm.addEventListener('click', () => onRemove(a.attachment_id));
    tile.appendChild(rm);
    stripEl.appendChild(tile);
  }
}

// Wire a file <input> so each chosen file is attached to the current subject.
function wireAttachInput(inputEl, getSubjectId) {
  inputEl.addEventListener('change', async () => {
    const subjectId = getSubjectId();
    if (!subjectId) return;
    for (const file of [...inputEl.files]) {
      let dataUri;
      try {
        dataUri = await fileToDataUri(file);
      } catch {
        notice('Could not read that file.');
        continue;
      }
      const outcome = await act('attach', {
        subject_id: subjectId,
        data_uri: dataUri,
        title: file.name,
      });
      if (!narrate(outcome, refresh)) break;
    }
    inputEl.value = '';
    await refresh();
  });
}

// The reading whose attach button was last clicked — one shared hidden file
// input serves every row, so the change handler needs to know the target.
let attachTarget = null;

async function removeAttachment(attachmentId) {
  const outcome = await act('detach', { attachment_id: attachmentId });
  if (narrate(outcome, refresh)) await refresh();
}

// ---------- Removal (health.void_vital) ----------

// The one fix for a typo'd reading: mark its observation entered-in-error.
// health.void_vital is risk medium and this app runs at a low ceiling, so the
// invoke normally parks — the row stays put, dimmed, until the owner approves.
const VOID_REASON = 'Removed from the Vitals app';

// A paired BP row voids both halves — one gesture in, one gesture out, same
// contract as logging. Each half is its own observation, hence two invokes.
async function removeReading(observationIds) {
  let executed = 0;
  let parkedMessage = null;
  for (const id of observationIds) {
    const outcome = await act('void', { observation_id: id, reason: VOID_REASON });
    if (outcome === undefined) return; // act() already surfaced the error
    if (outcome.status === 'executed') {
      executed += 1;
    } else if (outcome.status === 'parked') {
      pendingVoids.add(id);
      parkedMessage = outcomeMessage(outcome) ?? 'Waiting for your approval in vault settings.';
    } else {
      narrate(outcome, refresh);
      break; // denied/failed — leave the sibling half untouched
    }
  }
  if (parkedMessage) toast(parkedMessage);
  else if (executed === observationIds.length && executed > 0) toast('Reading removed');
  await refresh();
}

function removeButton(observationIds) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'remove-btn';
  btn.textContent = '✕';
  btn.title = 'Remove this reading';
  btn.setAttribute('aria-label', 'Remove this reading');
  btn.addEventListener('click', () => {
    if (!armConfirm(btn, { armedLabel: 'Remove?' })) return;
    removeReading(observationIds);
  });
  return btn;
}

// ---------- History (selected metric, day-grouped) ----------

const CONTEXT_LABELS = {
  rest: 'Rest',
  exercise: 'After exercise',
  sleep: 'Sleep',
  post_meal: 'After meal',
};

function contextChip(context) {
  if (!context || !CONTEXT_LABELS[context]) return null;
  const el = document.createElement('span');
  el.className = 'context-chip';
  el.textContent = CONTEXT_LABELS[context];
  return el;
}

function attachButton(vitalId, count) {
  const attach = document.createElement('button');
  attach.type = 'button';
  attach.className = 'ghost attach-btn';
  attach.textContent = count ? `📎 ${count}` : '📎';
  attach.title = 'Attach a lab report or photo';
  attach.addEventListener('click', () => {
    attachTarget = vitalId;
    $('attachInput').click();
  });
  return attach;
}

function historyRow({ time, valueHtmlParts, modality, context, attachTo, attachments, voidIds }) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.modality = modality ?? 'self_reported';
  const timeEl = document.createElement('span');
  timeEl.className = 'row-time';
  timeEl.textContent = time;
  const text = document.createElement('span');
  text.className = 'row-text';
  text.append(...valueHtmlParts);
  const chip = contextChip(context);
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = modality ?? 'self_reported';
  row.append(timeEl, text);
  if (chip) row.appendChild(chip);
  row.appendChild(badge);
  // A removal the vault parked: the row dims and carries the chip until the
  // owner approves; no second delete (or attach) while it waits.
  if (voidIds.some((id) => pendingVoids.has(id))) {
    row.classList.add('kit-pending');
    const pendingChip = document.createElement('span');
    pendingChip.className = 'kit-pending-chip';
    pendingChip.textContent = 'removal awaiting your approval';
    row.appendChild(pendingChip);
    return row;
  }
  row.append(attachButton(attachTo, attachments.length), removeButton(voidIds));

  if (attachments.length) {
    const strip = document.createElement('div');
    strip.className = 'attach-strip row-attachments';
    renderAttachments(strip, attachments, removeAttachment);
    const wrap = document.createElement('div');
    wrap.className = 'row-with-attachments';
    wrap.append(row, strip);
    return wrap;
  }
  return row;
}

function valueSpan(text, cls) {
  const b = document.createElement('b');
  b.className = `row-value${cls ? ` ${cls}` : ''}`;
  b.textContent = text;
  return b;
}

// One history entry per measurement: plain rows for single vitals, a paired
// "120/80" row when BP halves land within the pairing window.
function historyEntries(familyKey) {
  const rows = rowsFor(familyKey);
  const unit = unitFor(familyKey);
  if (familyKey !== 'bp') {
    return rows.map((r) => ({
      observed_at: r.observed_at,
      el: historyRow({
        time: fmtTime(r.observed_at),
        valueHtmlParts: [
          valueSpan(fmtVal(r.value_num), rangeClass(r.vital_type, r.value_num)),
          document.createTextNode(` ${r.unit ?? unit}`),
        ],
        modality: r.modality,
        context: r.context,
        attachTo: r.vital_id,
        attachments: r.attachments ?? [],
        voidIds: [r.observation_id],
      }),
    }));
  }
  return bpPairs(rows).map((p) => {
    const main = p.sys ?? p.dia;
    const cls =
      rangeClass('bp_systolic', p.sys?.value_num) || rangeClass('bp_diastolic', p.dia?.value_num);
    return {
      observed_at: p.observed_at,
      el: historyRow({
        time: fmtTime(p.observed_at),
        valueHtmlParts: [
          valueSpan(`${fmtVal(p.sys?.value_num)}/${fmtVal(p.dia?.value_num)}`, cls),
          document.createTextNode(` ${main.unit ?? unit}`),
        ],
        modality: main.modality,
        context: p.sys?.context ?? p.dia?.context,
        attachTo: main.vital_id,
        attachments: [...(p.sys?.attachments ?? []), ...(p.dia?.attachments ?? [])],
        // The pair row is one measurement, so its ✕ voids both observations
        // (an unpaired half honestly voids just itself).
        voidIds: [p.sys?.observation_id, p.dia?.observation_id].filter(Boolean),
      }),
    };
  });
}

function renderHistory() {
  const list = $('readingList');
  list.innerHTML = '';
  const f = FAMILIES[selectedFamily];
  const entries = f ? historyEntries(selectedFamily) : [];
  $('empty').hidden = readings.length > 0;
  $('historyTitle').textContent = f && entries.length ? `History — ${f.label}` : '';
  $('exportButton').hidden = entries.length === 0;
  $('historyNote').textContent = queryMeta.truncated
    ? `Showing latest ${readings.length} of ${queryMeta.total} readings`
    : '';
  const byDay = new Map();
  for (const e of entries) {
    const key = localDayKey(e.observed_at);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(e);
  }
  for (const [key, dayEntries] of byDay) {
    const h = document.createElement('p');
    h.className = 'day-label muted small';
    h.textContent = fmtDay(key);
    list.appendChild(h);
    for (const e of dayEntries) list.appendChild(e.el);
  }
}

// ---------- CSV export (client-side, straight off the projection) ----------

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function exportCsv() {
  const f = FAMILIES[selectedFamily];
  if (!f) return;
  const rows = rowsFor(selectedFamily).toReversed(); // chronological
  const lines = [
    'observed_at,vital_type,value,unit,context,modality',
    ...rows.map((r) =>
      [r.observed_at, r.vital_type, r.value_num, r.unit ?? '', r.context ?? '', r.modality ?? '']
        .map(csvCell)
        .join(','),
    ),
  ];
  const a = document.createElement('a');
  a.href = `data:text/csv;charset=utf-8,${encodeURIComponent(lines.join('\n'))}`;
  a.download = `vitals-${selectedFamily}.csv`;
  a.click();
  toast(`Exported ${rows.length} readings`);
}

// ---------- Log form: family select, BP pair, backdating, context ----------

function populateTypeSelect() {
  const sel = $('typeSelect');
  sel.innerHTML = '';
  for (const [key, f] of Object.entries(FAMILIES)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = f.label;
    sel.appendChild(opt);
  }
}

function syncForm() {
  const isBp = selectedFamily === 'bp';
  $('typeSelect').value = selectedFamily;
  $('bpSep').hidden = !isBp;
  $('valueInput2').hidden = !isBp;
  $('valueInput').placeholder = isBp ? '120' : 'Value';
  $('unitSuffix').textContent = unitFor(selectedFamily);
}

const TRENDS_HINT =
  'A consent-checked summary computed inside the vault — count, range and average land here.';

function selectFamily(key) {
  if (!FAMILIES[key]) return;
  selectedFamily = key;
  // A summary for the previous metric would mislead under the new one.
  $('trendsResult').textContent = TRENDS_HINT;
  $('trendsResult').classList.add('muted');
  try {
    localStorage.setItem(STORE_KEY, key);
  } catch {
    /* sandboxed storage is a nicety, not a requirement */
  }
  syncForm();
  renderCards();
  renderChart();
  renderHighlights();
  renderTrendsCard();
  renderHistory();
}

function renderTrendsCard() {
  $('trendsCard').hidden = !FAMILIES[selectedFamily] || rowsFor(selectedFamily).length === 0;
}

// "When: now ▾" — collapsed by default; expanding reveals a datetime-local
// whose value becomes the command's observed_at (backdating).
function toLocalInputValue(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function whenValue() {
  const el = $('whenInput');
  if (el.hidden || !el.value) return null;
  const d = new Date(el.value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function syncWhenLabel() {
  const iso = whenValue();
  $('whenToggle').textContent = iso
    ? `When: ${fmtStamp(new Date(iso).getTime())} ▾`
    : 'When: now ▾';
}

function resetWhen() {
  const el = $('whenInput');
  el.hidden = true;
  el.value = '';
  $('whenToggle').setAttribute('aria-expanded', 'false');
  syncWhenLabel();
}

function setContext(context) {
  selectedContext = selectedContext === context ? null : context;
  for (const chip of $('contextChips').querySelectorAll('.chip')) {
    chip.classList.toggle('on', chip.dataset.context === selectedContext);
    chip.setAttribute('aria-pressed', chip.dataset.context === selectedContext ? 'true' : 'false');
  }
}

async function submitLog(e) {
  e.preventDefault();
  const f = FAMILIES[selectedFamily];
  if (!f) return;
  const observed = whenValue();
  const extras = selectedContext ? { context: selectedContext } : {};
  const unit = unitFor(selectedFamily);

  if (selectedFamily === 'bp') {
    const sysV = Number($('valueInput').value);
    const diaV = Number($('valueInput2').value);
    if (!Number.isFinite(sysV) || !Number.isFinite(diaV)) return;
    // One gesture, two typed commands — an identical observed_at keeps the
    // halves inside the pairing window forever, backdated or not.
    const stamp = observed ?? new Date().toISOString();
    const first = await act('log', {
      vital_type: 'bp_systolic',
      value_num: sysV,
      observed_at: stamp,
      ...extras,
    });
    if (!narrate(first, refresh)) return;
    const second = await act('log', {
      vital_type: 'bp_diastolic',
      value_num: diaV,
      observed_at: stamp,
      ...extras,
    });
    if (!narrate(second, refresh)) {
      await refresh();
      return;
    }
    toast(`Logged ${fmtVal(sysV)}/${fmtVal(diaV)} ${unit}`);
  } else {
    const v = Number($('valueInput').value);
    if (!Number.isFinite(v)) return;
    const outcome = await act('log', {
      vital_type: f.types[0],
      value_num: v,
      ...(observed ? { observed_at: observed } : {}),
      ...extras,
    });
    if (!narrate(outcome, refresh)) return;
    toast(`Logged ${fmtVal(v)} ${unit}`);
  }
  $('valueInput').value = '';
  $('valueInput2').value = '';
  resetWhen();
  if (selectedContext) setContext(selectedContext);
  await refresh();
}

// ---------- Refresh ----------

function setConsentState(denied) {
  $('consentBanner').hidden = !denied;
  const sections = ['cardGrid', 'chartPanel', 'highlights', 'trendsCard', 'logForm'];
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    for (const id of sections) $(id).hidden = true;
    $('readingList').innerHTML = '';
    $('historyTitle').textContent = '';
    $('historyNote').textContent = '';
    $('exportButton').hidden = true;
    $('empty').hidden = true;
    return true;
  }
  $('logForm').hidden = false;
  return false;
}

async function refresh() {
  let data;
  try {
    data = await window.centraid.read({ query: 'readings', input: { limit: READ_LIMIT } });
  } catch {
    if (!loaded) {
      readFailed($('noticeBanner'));
      readFailedShown = true;
      $('cardGrid').innerHTML = '';
      $('readingList').innerHTML = '';
    }
    return; // transient; the change feed retries
  }
  if (readFailedShown) {
    readFailedShown = false;
    notice('');
  }
  loaded = true;
  if (setConsentState(data?.vaultDenied)) return;
  readings = data?.readings ?? [];
  queryMeta = { total: data?.total ?? readings.length, truncated: Boolean(data?.truncated) };
  // Once an approved void lands, the readings query stops returning the row —
  // drop its session-local pending mark along with it.
  const present = new Set(readings.map((r) => r.observation_id));
  for (const id of [...pendingVoids]) {
    if (!present.has(id)) pendingVoids.delete(id);
  }
  if (!FAMILIES[selectedFamily]) {
    let remembered = null;
    try {
      remembered = localStorage.getItem(STORE_KEY);
    } catch {
      /* ignore */
    }
    selectedFamily =
      (FAMILIES[remembered] && remembered) ||
      Object.keys(FAMILIES).find((key) => rowsFor(key).length > 0) ||
      'heart_rate';
  }
  syncForm();
  renderCards();
  renderChart();
  renderHighlights();
  renderTrendsCard();
  renderHistory();
}

// ---------- Wiring ----------

populateTypeSelect();
showSkeleton($('cardGrid'), 2);
$('cardGrid').hidden = false;
showSkeleton($('readingList'), 4);

$('logForm').addEventListener('submit', submitLog);
$('typeSelect').addEventListener('change', (e) => selectFamily(e.target.value));
$('exportButton').addEventListener('click', exportCsv);
$('trendsButton').addEventListener('click', runTrends);

$('rangeBar').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-range]');
  if (!btn) return;
  selectedRange = btn.dataset.range;
  for (const b of $('rangeBar').querySelectorAll('button')) {
    b.classList.toggle('on', b === btn);
  }
  renderChart();
});

$('whenToggle').addEventListener('click', () => {
  const el = $('whenInput');
  el.hidden = !el.hidden;
  $('whenToggle').setAttribute('aria-expanded', el.hidden ? 'false' : 'true');
  if (!el.hidden && !el.value) el.value = toLocalInputValue(new Date());
  if (el.hidden) el.value = '';
  syncWhenLabel();
  if (!el.hidden) el.focus();
});
$('whenInput').addEventListener('input', syncWhenLabel);

$('contextChips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip) setContext(chip.dataset.context);
});

// `l` jumps to the log value field (unless already typing somewhere).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'l' || e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  e.preventDefault();
  $('valueInput').focus();
});

wireAttachInput($('attachInput'), () => attachTarget);

window.addEventListener('focus', refresh);
refresh();
