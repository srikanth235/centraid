// governance: allow-repo-hygiene file-size-limit blueprints are single-file by design (read wholesale by one agent); Agenda's Google-Calendar-parity surface — month/week/list views, event detail popover, range-driven reads — lives in one module and splitting it would break that "one file" contract.
// Agenda — a pure projection over the personal vault. Every row rendered
// here lives in core.event; every mutation is a typed vault command routed
// through this app's handlers (ctx.vault on the gateway side). The app's
// own data.sqlite stays empty by design: revoke the grant and this page
// goes dark while the model, history and receipts remain the owner's.

import {
  armConfirm,
  debounce,
  localDayKey,
  outcomeMessage,
  readFailed,
  showSkeleton,
  toast,
} from './kit.js';

const $ = (id) => document.getElementById(id);
// Small files stay one-call inline; larger files stream to the vault's blob
// staging route (issue #296).
const BLOB_ROUTE = '/centraid/_vault/blobs';
const INLINE_ATTACH_BYTES = 256 * 1024;

let calendars = [];
let events = [];
let view = 'month'; // 'month' | 'week' | 'list'
// The day the month/week views are anchored on; navigation moves it whole
// months or weeks depending on the view.
let cursor = new Date();
// Vault FTS matches while the list search is active; null = no search.
let searchResults = null;
const hiddenCals = new Set();
let calById = new Map();
let firstLoad = true;
let readErrorShown = false;

// ---------- Time helpers ----------

function toIsoUtc(local) {
  // datetime-local gives "YYYY-MM-DDTHH:MM" in the viewer's zone.
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
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

/** ISO or Date → the value a datetime-local input wants, in local time. */
function toLocalInput(dateish) {
  const d = dateish instanceof Date ? dateish : new Date(dateish);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "Thu, Jul 3 · 10:00 AM – 11:00 AM" (or spanning both dates). */
function fmtRange(ev) {
  const s = new Date(ev.dtstart);
  const e = ev.dtend ? new Date(ev.dtend) : null;
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  const sd = Number.isNaN(s.getTime()) ? String(ev.dtstart) : s.toLocaleDateString(undefined, opts);
  if (!e || Number.isNaN(e.getTime())) return `${sd} · ${fmtTime(ev.dtstart)}`;
  if (localDayKey(s) === localDayKey(e)) {
    return `${sd} · ${fmtTime(ev.dtstart)} – ${fmtTime(ev.dtend)}`;
  }
  return `${sd}, ${fmtTime(ev.dtstart)} – ${e.toLocaleDateString(undefined, opts)}, ${fmtTime(ev.dtend)}`;
}

/** Monday on or before the given day (the grid is Monday-first). */
function startOfWeek(d) {
  const back = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
}

/** Now rounded up to the next :00/:30 — the propose form's default start. */
function nextHalfHour() {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(Math.floor(d.getMinutes() / 30) * 30 + 30);
  return d;
}

/** The clicked day at the next round hour of the current time. */
function nextRoundHourOn(date) {
  const now = new Date();
  const h = Math.min(
    now.getMinutes() > 0 || now.getSeconds() > 0 ? now.getHours() + 1 : now.getHours(),
    23,
  );
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, 0, 0, 0);
}

// ---------- Multi-day bucketing ----------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Bucket every event into each local day it touches. Each entry carries the
 * segment clamped to that day so the week view can position it, plus flags
 * for "starts here", "ends here" and "covers the whole day". An event ending
 * exactly at midnight does not spill into the next day.
 */
function bucketByDay(list) {
  const map = new Map();
  for (const ev of list) {
    const start = new Date(ev.dtstart);
    if (Number.isNaN(start.getTime())) {
      const key = String(ev.dtstart).slice(0, 10);
      if (!map.has(key)) map.set(key, []);
      map
        .get(key)
        .push({ ev, segStart: 0, segEnd: 0, startsHere: true, endsHere: true, spansAll: false });
      continue;
    }
    let end = ev.dtend ? new Date(ev.dtend) : start;
    if (Number.isNaN(end.getTime()) || end < start) end = start;
    // Midnight-exclusive: a 10pm–midnight event belongs to one evening.
    if (end > start && end.getHours() === 0 && end.getMinutes() === 0 && end.getSeconds() === 0) {
      end = new Date(end.getTime() - 60000);
    }
    const lastKey = localDayKey(end);
    let d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    for (let guard = 0; guard < 62; guard += 1) {
      const key = localDayKey(d);
      const dayStart = d.getTime();
      const dayEnd = dayStart + DAY_MS;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({
        ev,
        segStart: Math.max(start.getTime(), dayStart),
        segEnd: Math.min((ev.dtend ? end : start).getTime(), dayEnd),
        startsHere: key === localDayKey(start),
        endsHere: key === lastKey,
        spansAll: start.getTime() <= dayStart && end.getTime() >= dayEnd,
      });
      if (key === lastKey) break;
      d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    }
  }
  for (const l of map.values()) l.sort((a, b) => a.segStart - b.segStart);
  return map;
}

function segTimeText(seg) {
  if (seg.spansAll) return 'All day';
  if (seg.startsHere && seg.endsHere) {
    return `${fmtTime(seg.ev.dtstart)}${seg.ev.dtend ? `–${fmtTime(seg.ev.dtend)}` : ''}`;
  }
  if (seg.startsHere) return `${fmtTime(seg.ev.dtstart)} →`;
  return `→ ${fmtTime(seg.segEnd)}`;
}

// ---------- Calendar colors ----------

// GCal-adjacent palette used when a calendar has no color of its own.
const PALETTE = [
  '#4285f4',
  '#0b8043',
  '#8e24aa',
  '#f4511e',
  '#f6bf26',
  '#039be5',
  '#d81b60',
  '#33b679',
];

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return ((h % PALETTE.length) + PALETTE.length) % PALETTE.length;
}

function colorFor(calendarId) {
  if (!calendarId) return 'var(--app-color, var(--accent))';
  const cal = calById.get(calendarId);
  if (cal?.color) return cal.color;
  return PALETTE[hashStr(String(calendarId))];
}

// ---------- Banners and outcome narration ----------

function notice(text) {
  const el = $('noticeBanner');
  el.textContent = text;
  el.hidden = !text;
}

// One narration for every action outcome; returns true when it executed.
function narrate(outcome) {
  if (outcome?.status === 'executed') {
    notice('');
    return true;
  }
  if (outcome?.status === 'parked') {
    notice('Sent to the owner for confirmation — it will appear once approved.');
  } else if (outcome?.status === 'failed') {
    notice(`The vault refused: ${outcome.predicate ?? outcome.reason ?? 'a precondition failed'}.`);
  } else if (outcome?.status === 'denied') {
    notice(`Denied by consent: ${outcome.reason ?? ''}`);
  }
  return false;
}

// Run an action and return the raw outcome so callers can narrate and
// refresh on their own schedule.
async function act(action, input) {
  try {
    return await window.centraid.write({ action, input });
  } catch (err) {
    notice(String(err?.message ?? err));
    return undefined;
  }
}

// ---------- Attachments (shared pattern across apps) ----------

function fileToDataUri(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

// Stage one file's bytes into the vault's CAS (issue #296): the file
// streams to the blob route — no base64 through command JSON — and the
// attach action claims the returned sha (that claim is the receipt).
async function stageFileBytes(file) {
  const q = new URLSearchParams();
  if (file.name) q.set('filename', file.name);
  if (file.type) q.set('media_type', file.type);
  const res = await fetch(`${BLOB_ROUTE}?${q}`, {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!res.ok) throw new Error(`upload refused (${res.status})`);
  return res.json();
}

function fmtBytes(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Render an attachment strip: images as thumbnails, everything else as a
// download tile, each with an arm-to-confirm remove wired to detach.
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
    rm.setAttribute('aria-label', 'Remove attachment');
    rm.addEventListener('click', async () => {
      if (!armConfirm(rm, { armedLabel: 'Sure?' })) return;
      const outcome = await onRemove(a.attachment_id);
      if (outcome?.status === 'executed') tile.remove();
    });
    tile.appendChild(rm);
    stripEl.appendChild(tile);
  }
}

// Wire the shared file <input> so each chosen file is attached to the
// current subject (set by whichever attach button was pressed last).
function wireAttachInput(inputEl, getSubjectId) {
  inputEl.addEventListener('change', async () => {
    const subjectId = getSubjectId();
    if (!subjectId) return;
    for (const file of [...inputEl.files]) {
      // Large files stage through the blob route and attach by sha; small
      // ones keep the one-call inline data: URI path (issue #296).
      let input;
      try {
        if (file.size > INLINE_ATTACH_BYTES) {
          const staged = await stageFileBytes(file);
          input = { subject_id: subjectId, staged_sha: staged.sha256, title: file.name };
        } else {
          const dataUri = await fileToDataUri(file);
          input = { subject_id: subjectId, data_uri: dataUri, title: file.name };
        }
      } catch {
        notice('Could not read that file.');
        continue;
      }
      const outcome = await act('attach', input);
      if (!narrate(outcome)) break;
    }
    inputEl.value = '';
    await load();
  });
}

let attachTarget = null;

async function removeAttachment(attachmentId) {
  const outcome = await act('detach', { attachment_id: attachmentId });
  if (narrate(outcome) || outcome?.status === 'denied') await load();
  return outcome;
}

// ---------- Data ----------

/** The read window for the current view; list keeps the query's default. */
function rangeFor() {
  if (view === 'month') {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const gridStart = startOfWeek(first);
    const gridEnd = new Date(
      gridStart.getFullYear(),
      gridStart.getMonth(),
      gridStart.getDate() + 42,
    );
    return { from: gridStart.toISOString(), to: gridEnd.toISOString() };
  }
  if (view === 'week') {
    const start = startOfWeek(cursor);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
    return { from: start.toISOString(), to: end.toISOString() };
  }
  return null;
}

let loadSeq = 0;

async function load() {
  const seq = ++loadSeq;
  if (firstLoad) {
    showSkeleton($('monthGrid'), 4);
  }
  const range = rangeFor();
  let data;
  try {
    data = await window.centraid.read({ query: 'upcoming', ...(range ? { input: range } : {}) });
  } catch {
    // A broken vault must not look like an empty one.
    readFailed($('noticeBanner'));
    readErrorShown = true;
    return;
  }
  if (seq !== loadSeq) return; // a newer navigation superseded this read
  if (readErrorShown) {
    notice('');
    readErrorShown = false;
  }
  const denied = data?.vaultDenied;
  $('consentBanner').hidden = !denied;
  document.querySelector('.agenda-bar').hidden = Boolean(denied);
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    $('proposeForm').hidden = true;
    $('dayList').innerHTML = '';
    $('monthGrid').innerHTML = '';
    $('weekView').innerHTML = '';
    $('calendarChips').hidden = true;
    $('empty').hidden = true;
    $('noCalendars').hidden = true;
    return;
  }
  calendars = data?.calendars ?? [];
  events = data?.events ?? [];
  calById = new Map(calendars.map((c) => [c.calendar_id, c]));
  firstLoad = false;
  renderCalendars();
  renderChips();
  render();
}

/** Events surviving the calendar filter (uncoloured/orphan events always show). */
function visibleEvents() {
  return events.filter((ev) => !ev.calendar_id || !hiddenCals.has(ev.calendar_id));
}

// ---------- Render dispatch ----------

function render() {
  $('monthGrid').hidden = view !== 'month';
  $('weekView').hidden = view !== 'week';
  $('dayList').hidden = view !== 'list';
  $('monthNav').hidden = view === 'list';
  $('searchInput').hidden = view !== 'list';
  $('monthViewBtn').setAttribute('aria-pressed', String(view === 'month'));
  $('weekViewBtn').setAttribute('aria-pressed', String(view === 'week'));
  $('listViewBtn').setAttribute('aria-pressed', String(view === 'list'));
  if (view === 'month') renderMonth();
  else if (view === 'week') renderWeek();
  else renderList();
}

// ---------- Calendar select + filter chips ----------

function renderCalendars() {
  const select = $('calendarSelect');
  const previous = select.value; // keep a mid-form choice across focus refreshes
  select.innerHTML = '';
  for (const c of calendars) {
    const opt = document.createElement('option');
    opt.value = c.calendar_id;
    opt.textContent = c.name ?? 'Calendar';
    select.appendChild(opt);
  }
  if (previous && calendars.some((c) => c.calendar_id === previous)) {
    select.value = previous;
  }
  $('proposeForm').hidden = calendars.length === 0;
  $('noCalendars').hidden = calendars.length > 0;
}

function renderChips() {
  const host = $('calendarChips');
  host.hidden = calendars.length < 2;
  host.innerHTML = '';
  for (const c of calendars) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'cal-chip';
    const shown = !hiddenCals.has(c.calendar_id);
    chip.setAttribute('aria-pressed', String(shown));
    chip.title = shown ? 'Hide this calendar' : 'Show this calendar';
    const dot = document.createElement('span');
    dot.className = 'cal-dot';
    dot.style.background = colorFor(c.calendar_id);
    const name = document.createElement('span');
    name.textContent = c.name ?? 'Calendar';
    chip.append(dot, name);
    chip.addEventListener('click', () => {
      if (hiddenCals.has(c.calendar_id)) hiddenCals.delete(c.calendar_id);
      else hiddenCals.add(c.calendar_id);
      renderChips();
      render();
    });
    host.appendChild(chip);
  }
}

// ---------- Month view: a Monday-first CSS-grid calendar ----------

const MAX_PILLS = 3;

function renderMonth() {
  const grid = $('monthGrid');
  grid.innerHTML = '';
  $('empty').hidden = true;
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  $('monthLabel').textContent = new Date(year, month, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });

  const byDay = bucketByDay(visibleEvents());

  // Weekday header row, Monday first.
  const head = document.createElement('div');
  head.className = 'grid-row';
  head.setAttribute('role', 'row');
  const monday = new Date(2024, 0, 1); // a known Monday
  for (let i = 0; i < 7; i += 1) {
    const h = document.createElement('span');
    h.className = 'dow muted small';
    h.setAttribute('role', 'columnheader');
    h.textContent = new Date(
      monday.getFullYear(),
      monday.getMonth(),
      monday.getDate() + i,
    ).toLocaleDateString(undefined, { weekday: 'narrow' });
    head.appendChild(h);
  }
  grid.appendChild(head);

  // 6 weeks × 7 days from the Monday on or before the 1st.
  const gridStart = startOfWeek(new Date(year, month, 1));
  const todayKey = localDayKey(new Date());
  for (let w = 0; w < 6; w += 1) {
    const row = document.createElement('div');
    row.className = 'grid-row';
    row.setAttribute('role', 'row');
    for (let i = 0; i < 7; i += 1) {
      const date = new Date(
        gridStart.getFullYear(),
        gridStart.getMonth(),
        gridStart.getDate() + w * 7 + i,
      );
      const key = localDayKey(date);
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.setAttribute('role', 'gridcell');
      cell.tabIndex = 0;
      if (date.getMonth() !== month) cell.dataset.outside = 'true';
      if (key === todayKey) cell.dataset.today = 'true';
      const segs = byDay.get(key) ?? [];
      cell.setAttribute(
        'aria-label',
        `${date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}, ${segs.length === 0 ? 'no events' : `${segs.length} event${segs.length === 1 ? '' : 's'}`}. Press Enter to propose an event.`,
      );
      const num = document.createElement('span');
      num.className = 'cell-date';
      num.textContent = String(date.getDate());
      cell.appendChild(num);
      for (const seg of segs.slice(0, MAX_PILLS)) {
        cell.appendChild(renderPill(seg));
      }
      if (segs.length > MAX_PILLS) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'more muted small';
        more.textContent = `+${segs.length - MAX_PILLS} more`;
        more.addEventListener('click', () => openDayPanel(key, more));
        cell.appendChild(more);
      }
      // Clicking the cell itself (not a pill) starts a proposal on that day.
      cell.addEventListener('click', (e) => {
        if (e.target.closest('.pill, .more')) return;
        prefillCreate(date);
      });
      cell.addEventListener('keydown', (e) => {
        if (e.target !== cell) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          prefillCreate(date);
        }
      });
      row.appendChild(cell);
    }
    grid.appendChild(row);
  }
}

function renderPill(seg) {
  const ev = seg.ev;
  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'pill';
  pill.dataset.status = ev.status;
  pill.style.setProperty('--ev-color', colorFor(ev.calendar_id));
  pill.textContent =
    seg.startsHere && !seg.spansAll ? `${fmtTime(ev.dtstart)} ${ev.summary}` : ev.summary;
  pill.title = `${fmtRange(ev)} — ${ev.summary}`;
  pill.addEventListener('click', () => openEventDetail(ev, pill));
  return pill;
}

// ---------- Week view: hour axis + 7 positioned columns ----------

const HOUR_PX = 48;

/**
 * Assign overlapping segments of one day to side-by-side columns: greedy
 * first-fit within each overlap cluster, every member split evenly.
 */
function layoutDay(items) {
  const colEnds = [];
  let cluster = [];
  let clusterEnd = -1;
  const placed = [];
  const flush = () => {
    for (const p of cluster) p.width = colEnds.length;
    cluster = [];
    colEnds.length = 0;
  };
  for (const it of items) {
    if (cluster.length && it.segStart >= clusterEnd) flush();
    let col = colEnds.findIndex((end) => end <= it.segStart);
    if (col === -1) {
      col = colEnds.length;
      colEnds.push(it.segEnd);
    } else {
      colEnds[col] = it.segEnd;
    }
    const p = { ...it, col };
    cluster.push(p);
    placed.push(p);
    clusterEnd = Math.max(clusterEnd, it.segEnd);
  }
  flush();
  return placed;
}

function renderWeek() {
  const host = $('weekView');
  host.innerHTML = '';
  $('empty').hidden = true;
  const start = startOfWeek(cursor);
  const end6 = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  $('monthLabel').textContent =
    `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end6.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;

  const byDay = bucketByDay(visibleEvents());
  const todayKey = localDayKey(new Date());
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    days.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }

  const wrap = document.createElement('div');
  wrap.className = 'week-wrap';

  // Day headers.
  const head = document.createElement('div');
  head.className = 'week-head';
  head.appendChild(document.createElement('span')); // axis corner
  for (const d of days) {
    const cellHead = document.createElement('div');
    cellHead.className = 'week-day-head';
    if (localDayKey(d) === todayKey) cellHead.dataset.today = 'true';
    const dow = document.createElement('span');
    dow.className = 'week-dow muted small';
    dow.textContent = d.toLocaleDateString(undefined, { weekday: 'short' });
    const num = document.createElement('span');
    num.className = 'week-num';
    num.textContent = String(d.getDate());
    cellHead.append(dow, num);
    head.appendChild(cellHead);
  }
  wrap.appendChild(head);

  // All-day lane: whole-day segments of multi-day events.
  const hasAllDay = days.some((d) => (byDay.get(localDayKey(d)) ?? []).some((s) => s.spansAll));
  if (hasAllDay) {
    const lane = document.createElement('div');
    lane.className = 'week-allday';
    lane.appendChild(document.createElement('span'));
    for (const d of days) {
      const cell = document.createElement('div');
      cell.className = 'week-allday-cell';
      for (const seg of (byDay.get(localDayKey(d)) ?? []).filter((s) => s.spansAll)) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'allday-chip';
        chip.style.setProperty('--ev-color', colorFor(seg.ev.calendar_id));
        chip.textContent = seg.ev.summary;
        chip.title = fmtRange(seg.ev);
        chip.addEventListener('click', () => openEventDetail(seg.ev, chip));
        cell.appendChild(chip);
      }
      lane.appendChild(cell);
    }
    wrap.appendChild(lane);
  }

  // Scrollable hour grid.
  const scroll = document.createElement('div');
  scroll.className = 'week-scroll';
  const grid = document.createElement('div');
  grid.className = 'week-grid';

  const axis = document.createElement('div');
  axis.className = 'week-axis';
  axis.style.height = `${24 * HOUR_PX}px`;
  for (let h = 1; h < 24; h += 1) {
    const label = document.createElement('span');
    label.className = 'week-hour muted small';
    label.style.top = `${h * HOUR_PX}px`;
    label.textContent = new Date(2024, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });
    axis.appendChild(label);
  }
  grid.appendChild(axis);

  for (const d of days) {
    const key = localDayKey(d);
    const col = document.createElement('div');
    col.className = 'week-col';
    col.style.height = `${24 * HOUR_PX}px`;
    if (key === todayKey) col.dataset.today = 'true';
    const dayStart = d.getTime();
    const segs = (byDay.get(key) ?? []).filter((s) => !s.spansAll);
    for (const seg of layoutDay(segs)) {
      const block = document.createElement('button');
      block.type = 'button';
      block.className = 'week-ev';
      block.dataset.status = seg.ev.status;
      block.style.setProperty('--ev-color', colorFor(seg.ev.calendar_id));
      const top = ((seg.segStart - dayStart) / 3600000) * HOUR_PX;
      const height = Math.max(((seg.segEnd - seg.segStart) / 3600000) * HOUR_PX, 22);
      block.style.top = `${top}px`;
      block.style.height = `${height}px`;
      block.style.left = `${(seg.col / seg.width) * 100}%`;
      block.style.width = `calc(${100 / seg.width}% - 2px)`;
      const name = document.createElement('span');
      name.className = 'week-ev-title';
      name.textContent = seg.ev.summary;
      const time = document.createElement('span');
      time.className = 'week-ev-time';
      time.textContent = segTimeText(seg);
      block.append(name, time);
      block.title = `${fmtRange(seg.ev)} — ${seg.ev.summary}`;
      block.addEventListener('click', () => openEventDetail(seg.ev, block));
      col.appendChild(block);
    }
    // Click an empty slot to start a proposal at that half hour.
    col.addEventListener('click', (e) => {
      if (e.target.closest('.week-ev')) return;
      const rect = col.getBoundingClientRect();
      const hour = Math.max(
        0,
        Math.min(23.5, Math.floor(((e.clientY - rect.top) / HOUR_PX) * 2) / 2),
      );
      const at = new Date(
        d.getFullYear(),
        d.getMonth(),
        d.getDate(),
        Math.floor(hour),
        (hour % 1) * 60,
      );
      prefillCreate(d, at);
    });
    grid.appendChild(col);
  }
  scroll.appendChild(grid);
  wrap.appendChild(scroll);
  host.appendChild(wrap);
  // Land on the working day: 7:00 visible first, full day scrollable.
  scroll.scrollTop = 7 * HOUR_PX;
}

// ---------- List view ----------

// Render a vault search snippet from text nodes only — the ⟦…⟧ hit markers
// the vault returns become <mark>, and event text never parses as HTML.
function snippetInto(el, snippet) {
  const parts = String(snippet ?? '').split(/[⟦⟧]/);
  for (let i = 0; i < parts.length; i += 1) {
    if (!parts[i]) continue;
    if (i % 2 === 1) {
      const mark = document.createElement('mark');
      mark.textContent = parts[i];
      el.appendChild(mark);
    } else {
      el.appendChild(document.createTextNode(parts[i]));
    }
  }
}

function renderList() {
  const list = $('dayList');
  list.innerHTML = '';
  // A search swaps the loaded window for the vault's FTS matches (which can
  // reach past events the window never loaded); the calendar chips filter
  // either set the same way.
  const source = searchResults ?? events;
  const evs = source.filter((ev) => !ev.calendar_id || !hiddenCals.has(ev.calendar_id));
  $('empty').hidden = evs.length > 0;
  const byDay = bucketByDay(evs);
  const keys = [...byDay.keys()].sort();
  for (const key of keys) {
    const h = document.createElement('p');
    h.className = 'day-label muted small';
    h.dataset.day = key;
    h.textContent = fmtDay(key);
    list.appendChild(h);
    for (const seg of byDay.get(key)) {
      list.appendChild(renderRow(seg));
    }
  }
}

function renderRow(seg) {
  const ev = seg.ev;
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.status = ev.status;
  // The main body is a real button: clicking anywhere on the text opens the
  // event detail panel (attach/cancel stay as their own controls).
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'row-main';
  const time = document.createElement('span');
  time.className = 'row-time';
  time.textContent = segTimeText(seg);
  const dot = document.createElement('span');
  dot.className = 'cal-dot';
  dot.style.background = colorFor(ev.calendar_id);
  const text = document.createElement('span');
  text.className = 'row-text';
  text.textContent = ev.summary;
  // A vault search match carries its own snippet, already centered on the
  // hit — it renders beneath the summary with the term marked.
  if (ev.snippet) {
    const snip = document.createElement('span');
    snip.className = 'row-snippet muted small';
    snippetInto(snip, ev.snippet);
    text.append(document.createElement('br'), snip);
  }
  main.append(time, dot, text);
  main.addEventListener('click', () => openEventDetail(ev, main));
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = ev.status;
  const attach = document.createElement('button');
  attach.type = 'button';
  attach.className = 'attach-btn';
  attach.textContent = '⎘';
  attach.title = 'Attach a file';
  attach.setAttribute('aria-label', 'Attach a file');
  attach.addEventListener('click', () => {
    attachTarget = ev.event_id;
    $('attachInput').click();
  });
  // Cancelling is medium-risk, so the vault parks it for the owner — the
  // affordance is an ask, armed on first click and auto-disarmed by the kit.
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'attach-btn cancel-btn';
  cancel.textContent = '✕';
  cancel.title = 'Ask to cancel — the owner approves it';
  cancel.setAttribute('aria-label', 'Ask to cancel this event');
  cancel.addEventListener('click', async () => {
    if (!armConfirm(cancel, { armedLabel: 'Ask to cancel?' })) return;
    const outcome = await act('cancel-event', { event_id: ev.event_id });
    if (narrate(outcome)) await load();
  });
  row.append(main, badge, cancel, attach);

  // Any attachments render as a strip beneath the row.
  if (ev.attachments?.length) {
    const frag = document.createDocumentFragment();
    frag.appendChild(row);
    const strip = document.createElement('div');
    strip.className = 'attach-strip row-attachments';
    renderAttachments(strip, ev.attachments, removeAttachment);
    frag.appendChild(strip);
    return frag;
  }
  return row;
}

// ---------- Overlay: event detail popover + day panel ----------

let overlayReturn = null;

function openOverlay(build, returnFocus) {
  overlayReturn = returnFocus ?? document.activeElement;
  const panel = $('overlayPanel');
  panel.innerHTML = '';
  build(panel);
  $('overlay').hidden = false;
  panel.focus();
}

function closeOverlay() {
  if ($('overlay').hidden) return;
  $('overlay').hidden = true;
  $('overlayPanel').innerHTML = '';
  if (overlayReturn instanceof HTMLElement && overlayReturn.isConnected) overlayReturn.focus();
  overlayReturn = null;
}

function panelHeader(panel, title, colorBar) {
  const head = document.createElement('div');
  head.className = 'panel-head';
  if (colorBar) {
    const bar = document.createElement('span');
    bar.className = 'panel-color';
    bar.style.background = colorBar;
    head.appendChild(bar);
  }
  const h = document.createElement('h2');
  h.id = 'panelTitle';
  h.textContent = title;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'panel-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', closeOverlay);
  head.append(h, close);
  panel.appendChild(head);
}

function openEventDetail(ev, returnFocus) {
  openOverlay((panel) => buildEventDetail(panel, ev), returnFocus);
}

function buildEventDetail(panel, ev) {
  panel.innerHTML = '';
  panelHeader(panel, ev.summary, colorFor(ev.calendar_id));

  const meta = document.createElement('div');
  meta.className = 'panel-meta';
  const when = document.createElement('p');
  when.className = 'panel-when';
  when.textContent = fmtRange(ev);
  meta.appendChild(when);
  const cal = calById.get(ev.calendar_id);
  const line = document.createElement('p');
  line.className = 'panel-cal muted';
  const dot = document.createElement('span');
  dot.className = 'cal-dot';
  dot.style.background = colorFor(ev.calendar_id);
  line.appendChild(dot);
  line.appendChild(document.createTextNode(` ${cal?.name ?? 'No calendar'} · `));
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = ev.status;
  line.appendChild(badge);
  meta.appendChild(line);
  panel.appendChild(meta);

  if (ev.description) {
    const desc = document.createElement('p');
    desc.className = 'panel-desc';
    desc.textContent = ev.description;
    panel.appendChild(desc);
  }

  if (ev.attachments?.length) {
    const strip = document.createElement('div');
    strip.className = 'attach-strip panel-attachments';
    renderAttachments(strip, ev.attachments, removeAttachment);
    panel.appendChild(strip);
  }

  // Inline narration for outcomes that keep the panel open.
  const panelNotice = document.createElement('p');
  panelNotice.className = 'panel-notice muted';
  panelNotice.setAttribute('role', 'status');
  panelNotice.hidden = true;
  const sayInPanel = (text) => {
    panelNotice.textContent = text;
    panelNotice.hidden = !text;
  };

  // Edit time — wired to the reschedule action (same identity, new times).
  const edit = document.createElement('div');
  edit.className = 'panel-edit';
  const editLabel = document.createElement('p');
  editLabel.className = 'muted small panel-edit-label';
  editLabel.textContent = 'Edit time';
  const times = document.createElement('div');
  times.className = 'panel-times';
  const startEl = document.createElement('input');
  startEl.type = 'datetime-local';
  startEl.setAttribute('aria-label', 'Starts');
  startEl.value = toLocalInput(ev.dtstart);
  const endEl = document.createElement('input');
  endEl.type = 'datetime-local';
  endEl.setAttribute('aria-label', 'Ends');
  endEl.value = toLocalInput(ev.dtend ?? ev.dtstart);
  let lastStart = startEl.value;
  startEl.addEventListener('change', () => {
    // Moving the start drags the end along, preserving the duration.
    const prev = new Date(lastStart);
    const end = new Date(endEl.value);
    const next = new Date(startEl.value);
    if (!Number.isNaN(next.getTime())) {
      const dur =
        !Number.isNaN(prev.getTime()) && !Number.isNaN(end.getTime()) && end > prev
          ? end.getTime() - prev.getTime()
          : 3600000;
      endEl.value = toLocalInput(new Date(next.getTime() + dur));
    }
    lastStart = startEl.value;
  });
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'primary panel-save';
  save.textContent = 'Save';
  save.addEventListener('click', async () => {
    const dtstart = toIsoUtc(startEl.value);
    const dtend = toIsoUtc(endEl.value);
    if (!dtstart || !dtend) {
      sayInPanel('Pick both a start and an end.');
      return;
    }
    if (dtend < dtstart) {
      sayInPanel('The end must come after the start.');
      return;
    }
    save.disabled = true;
    const outcome = await act('reschedule', { event_id: ev.event_id, dtstart, dtend });
    save.disabled = false;
    if (outcome?.status === 'executed') {
      toast('Event moved.');
      closeOverlay();
      await load();
    } else if (outcome?.status === 'parked') {
      toast('Sent for your approval — the move lands once you confirm it.', { duration: 7000 });
      closeOverlay();
      await load();
    } else if (outcome) {
      sayInPanel(outcomeMessage(outcome) ?? 'Something went wrong.');
    }
  });
  times.append(startEl, endEl, save);
  edit.append(editLabel, times);
  panel.appendChild(edit);

  // Action row: attach + the cancellation ask.
  const actions = document.createElement('div');
  actions.className = 'panel-actions';
  const attach = document.createElement('button');
  attach.type = 'button';
  attach.className = 'panel-btn';
  attach.textContent = 'Attach a file';
  attach.addEventListener('click', () => {
    attachTarget = ev.event_id;
    $('attachInput').click();
  });
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'panel-btn panel-danger';
  cancel.textContent = 'Ask to cancel';
  cancel.addEventListener('click', async () => {
    if (!armConfirm(cancel, { armedLabel: 'Ask to cancel?' })) return;
    cancel.disabled = true;
    const outcome = await act('cancel-event', { event_id: ev.event_id });
    cancel.disabled = false;
    if (outcome?.status === 'executed') {
      toast('Event cancelled.');
      closeOverlay();
      await load();
    } else if (outcome?.status === 'parked') {
      toast('Sent for your approval — it stays on the agenda until you confirm.', {
        duration: 7000,
      });
      closeOverlay();
      await load();
    } else if (outcome) {
      sayInPanel(outcomeMessage(outcome) ?? 'Something went wrong.');
    }
  });
  actions.append(attach, cancel);
  panel.appendChild(actions);
  panel.appendChild(panelNotice);
}

/** Every event of one day — the "+N more" expansion. */
function openDayPanel(key, returnFocus) {
  openOverlay((panel) => {
    panelHeader(panel, fmtDay(key));
    const listEl = document.createElement('div');
    listEl.className = 'panel-day-list';
    const segs = bucketByDay(visibleEvents()).get(key) ?? [];
    for (const seg of segs) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'panel-day-item';
      const dot = document.createElement('span');
      dot.className = 'cal-dot';
      dot.style.background = colorFor(seg.ev.calendar_id);
      const time = document.createElement('span');
      time.className = 'row-time';
      time.textContent = segTimeText(seg);
      const text = document.createElement('span');
      text.className = 'row-text';
      text.textContent = seg.ev.summary;
      item.append(dot, time, text);
      // Same overlay, swapped content — Esc still returns to the grid.
      item.addEventListener('click', () => buildEventDetail($('overlayPanel'), seg.ev));
      listEl.appendChild(item);
    }
    panel.appendChild(listEl);
  }, returnFocus);
}

$('overlay').addEventListener('click', (e) => {
  if (e.target === $('overlay')) closeOverlay();
});

// ---------- Propose form ----------

let lastFormStart = '';

function setFormTimes(start, end) {
  $('startInput').value = toLocalInput(start);
  $('endInput').value = toLocalInput(end);
  lastFormStart = $('startInput').value;
}

/** Fresh defaults: the next half-hour, one hour long. */
function setSmartDefaults() {
  const start = nextHalfHour();
  setFormTimes(start, new Date(start.getTime() + 3600000));
}

/** A day cell (or week slot) was clicked: prefill and focus the form. */
function prefillCreate(date, at) {
  const start = at ?? nextRoundHourOn(date);
  setFormTimes(start, new Date(start.getTime() + 3600000));
  $('summaryInput').focus();
  $('proposeForm').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

$('startInput').addEventListener('change', () => {
  // The end tracks the start, preserving whatever duration was set.
  const prev = new Date(lastFormStart);
  const end = new Date($('endInput').value);
  const next = new Date($('startInput').value);
  if (!Number.isNaN(next.getTime())) {
    const dur =
      !Number.isNaN(prev.getTime()) && !Number.isNaN(end.getTime()) && end > prev
        ? end.getTime() - prev.getTime()
        : 3600000;
    $('endInput').value = toLocalInput(new Date(next.getTime() + dur));
  }
  lastFormStart = $('startInput').value;
});

$('proposeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const summary = $('summaryInput').value.trim();
  const description = $('descInput').value.trim();
  const dtstart = toIsoUtc($('startInput').value);
  const dtend = toIsoUtc($('endInput').value);
  const calendar_id = $('calendarSelect').value;
  if (!summary || !dtstart || !dtend || !calendar_id) return;
  let outcome;
  try {
    outcome = await window.centraid.write({
      action: 'propose',
      input: { summary, dtstart, dtend, calendar_id, ...(description ? { description } : {}) },
    });
  } catch (err) {
    notice(String(err?.message ?? err));
    return;
  }
  if (outcome?.status === 'executed') {
    notice('');
    $('summaryInput').value = '';
    $('descInput').value = '';
    setSmartDefaults();
    toast('Event proposed.');
    await load();
  } else if (outcome?.status === 'parked') {
    notice('Sent to the owner for confirmation — it will appear once approved.');
  } else if (outcome?.status === 'failed') {
    notice(`The vault refused: ${outcome.predicate ?? outcome.reason ?? 'a precondition failed'}.`);
  } else if (outcome?.status === 'denied') {
    notice(`Denied by consent: ${outcome.reason ?? ''}`);
    await load();
  }
});

// ---------- Navigation, views, search, keyboard ----------

function nav(dir) {
  if (view === 'month') {
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1);
  } else if (view === 'week') {
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + dir * 7);
  } else {
    return;
  }
  load();
}

function scrollListToToday() {
  const todayKey = localDayKey(new Date());
  const labels = [...$('dayList').querySelectorAll('.day-label')];
  const target = labels.find((l) => l.dataset.day >= todayKey) ?? labels[0];
  target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function goToday() {
  cursor = new Date();
  if (view === 'list') scrollListToToday();
  else load();
}

function setView(v) {
  if (view === v) return;
  view = v;
  $('monthViewBtn').setAttribute('aria-pressed', String(v === 'month'));
  $('weekViewBtn').setAttribute('aria-pressed', String(v === 'week'));
  $('listViewBtn').setAttribute('aria-pressed', String(v === 'list'));
  load();
}

$('monthViewBtn').addEventListener('click', () => setView('month'));
$('weekViewBtn').addEventListener('click', () => setView('week'));
$('listViewBtn').addEventListener('click', () => setView('list'));
$('prevMonth').addEventListener('click', () => nav(-1));
$('nextMonth').addEventListener('click', () => nav(1));
$('todayBtn').addEventListener('click', goToday);

// Searching asks the vault, not the loaded window: the FTS5 index matches
// over every event (summary + description) inside SQLite and returns only
// the hits, so the app never greps an unbounded table in memory. `searchSeq`
// drops stale replies when the owner types faster than the vault answers.
let searchSeq = 0;
$('searchInput').addEventListener(
  'input',
  debounce(async () => {
    const raw = $('searchInput').value.trim();
    if (!raw) {
      searchResults = null;
      renderList();
      return;
    }
    const seq = ++searchSeq;
    let rows = [];
    try {
      const data = await window.centraid.read({ query: 'search', input: { term: raw } });
      rows = data?.events ?? [];
    } catch {
      rows = [];
    }
    if (seq !== searchSeq) return;
    searchResults = rows;
    renderList();
  }, 250),
);

function clearSearch() {
  $('searchInput').value = '';
  searchResults = null;
  renderList();
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('overlay').hidden) {
      closeOverlay();
      return;
    }
    // Esc in the search box clears it back to the loaded list.
    if (e.target === $('searchInput') && $('searchInput').value) clearSearch();
    return;
  }
  // Never hijack typing, and let the open panel own its keys.
  const t = e.target;
  if (t instanceof Element && t.closest('input, textarea, select')) return;
  if (!$('overlay').hidden) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'ArrowLeft') nav(-1);
  else if (e.key === 'ArrowRight') nav(1);
  else if (e.key === 't') goToday();
  else if (e.key === 'm') setView('month');
  else if (e.key === 'w') setView('week');
  else if (e.key === 'l') setView('list');
});

// One hidden file input serves the whole app; attach buttons set
// attachTarget just before triggering it.
wireAttachInput($('attachInput'), () => attachTarget);

window.addEventListener('focus', () => load());
setSmartDefaults();
load();
