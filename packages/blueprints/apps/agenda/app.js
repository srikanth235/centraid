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
  renderAttachments,
  showSkeleton,
  snippetInto,
  toast,
  wireAttachInput,
} from './kit.js';
// Aliased: the app already has a module-level `render()` orchestrator
// (dispatches to the active view's render*); `litRender` is Lit's standalone
// DOM-commit function driving the month/week/list containers and the
// overlay panel (kit-owned containers, per the app's Lit conventions).
import { createRef, html, nothing, ref, render as litRender, repeat } from './lit-core.min.js';

const $ = (id) => document.getElementById(id);

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
  notice(outcomeMessage(outcome) ?? '');
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

// ---------- Attachments (shared pattern, now served by the kit) ----------

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
    // monthGrid may still be holding the raw (non-Lit) skeleton if this is
    // the very first read — route through mountMonth so that guard clear
    // still happens; weekView/dayList never receive non-Lit content, so a
    // plain commit is safe there.
    litRender(nothing, $('dayList'));
    mountMonth(nothing);
    litRender(nothing, $('weekView'));
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
  litRender(
    html`${calendars.map(
      (c) =>
        html`<option value=${c.calendar_id} ?selected=${c.calendar_id === previous}>
          ${c.name ?? 'Calendar'}
        </option>`,
    )}`,
    select,
  );
  $('proposeForm').hidden = calendars.length === 0;
  $('noCalendars').hidden = calendars.length > 0;
}

function renderChips() {
  const host = $('calendarChips');
  host.hidden = calendars.length < 2;
  litRender(
    html`${calendars.map((c) => {
      const shown = !hiddenCals.has(c.calendar_id);
      return html`<button
        type="button"
        class="cal-chip"
        aria-pressed=${String(shown)}
        title=${shown ? 'Hide this calendar' : 'Show this calendar'}
        @click=${() => {
          if (hiddenCals.has(c.calendar_id)) hiddenCals.delete(c.calendar_id);
          else hiddenCals.add(c.calendar_id);
          renderChips();
          render();
        }}
      >
        <span class="cal-dot" style=${`background:${colorFor(c.calendar_id)}`}></span>
        <span>${c.name ?? 'Calendar'}</span>
      </button>`;
    })}`,
    host,
  );
}

// ---------- Month view: a Monday-first CSS-grid calendar ----------

const MAX_PILLS = 3;

// `#monthGrid` starts out holding the kit's raw (non-Lit) skeleton markup
// (`showSkeleton`, in `load()`). Lit's standalone `render()` never clears a
// container's pre-existing children on its first call — it only appends past
// them — so the very first Lit commit here must clear that skeleton itself;
// every commit after that must go through `litRender` alone (a raw clear once
// Lit owns the container corrupts its part cache).
let monthMounted = false;
function mountMonth(templateResult) {
  const grid = $('monthGrid');
  if (!monthMounted) {
    grid.replaceChildren();
    monthMounted = true;
  }
  litRender(templateResult, grid);
}

function renderMonth() {
  $('empty').hidden = true;
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  $('monthLabel').textContent = new Date(year, month, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });

  const byDay = bucketByDay(visibleEvents());

  // 6 weeks × 7 days from the Monday on or before the 1st.
  const gridStart = startOfWeek(new Date(year, month, 1));
  const todayKey = localDayKey(new Date());
  const weeks = [];
  for (let w = 0; w < 6; w += 1) {
    const days = [];
    for (let i = 0; i < 7; i += 1) {
      days.push(
        new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + w * 7 + i),
      );
    }
    weeks.push(days);
  }
  mountMonth(monthTemplate(weeks, byDay, month, todayKey));
}

/**
 * Weekday header row + 6 weeks × 7 days, Monday first, as a Lit template.
 * `.grid-row` is `display: contents` (app.css) so each `.cell`/`.dow` lands
 * as a direct grid item of `#monthGrid` — kept as a plain function (not a
 * component) so that flattening holds; a per-cell custom element host would
 * still be an extra node even at `display: contents` untangled from the
 * `.grid-row` wrapper, and aria roles (`role="row"`/`"gridcell"`) must live
 * on real elements, not a component host.
 */
function monthTemplate(weeks, byDay, month, todayKey) {
  const monday = new Date(2024, 0, 1); // a known Monday
  return html`<div class="grid-row" role="row">
      ${Array.from({ length: 7 }, (_, i) => {
        const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
        return html`<span class="dow muted small" role="columnheader"
          >${d.toLocaleDateString(undefined, { weekday: 'narrow' })}</span
        >`;
      })}
    </div>
    ${weeks.map(
      (days) => html`<div class="grid-row" role="row">
        ${days.map((date) => dayCellTpl(date, byDay, month, todayKey))}
      </div>`,
    )}`;
}

function dayCellTpl(date, byDay, month, todayKey) {
  const key = localDayKey(date);
  const segs = byDay.get(key) ?? [];
  const label = `${date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}, ${segs.length === 0 ? 'no events' : `${segs.length} event${segs.length === 1 ? '' : 's'}`}. Press Enter to propose an event.`;
  return html`<div
    class="cell"
    role="gridcell"
    tabindex="0"
    data-outside=${date.getMonth() !== month ? 'true' : nothing}
    data-today=${key === todayKey ? 'true' : nothing}
    aria-label=${label}
    @click=${(e) => {
      if (e.target.closest('.pill, .more')) return;
      prefillCreate(date);
    }}
    @keydown=${(e) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        prefillCreate(date);
      }
    }}
  >
    <span class="cell-date">${date.getDate()}</span>
    ${segs.slice(0, MAX_PILLS).map((seg) => pillTpl(seg))}
    ${segs.length > MAX_PILLS
      ? html`<button
          type="button"
          class="more muted small"
          @click=${(e) => openDayPanel(key, e.currentTarget)}
        >
          +${segs.length - MAX_PILLS} more
        </button>`
      : nothing}
  </div>`;
}

function pillTpl(seg) {
  const ev = seg.ev;
  return html`<button
    type="button"
    class="pill"
    data-status=${ev.status}
    style=${`--ev-color:${colorFor(ev.calendar_id)}`}
    title=${`${fmtRange(ev)} — ${ev.summary}`}
    @click=${(e) => openEventDetail(ev, e.currentTarget)}
  >
    ${seg.startsHere && !seg.spansAll ? `${fmtTime(ev.dtstart)} ${ev.summary}` : ev.summary}
  </button>`;
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

// `#weekView` never receives non-Lit content (unlike `#monthGrid`, no
// skeleton targets it), so its first commit needs no mount guard.
function renderWeek() {
  const host = $('weekView');
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

  // A callback ref would only fire once (Lit reuses the `.week-scroll` node
  // across re-renders of the same shape); scrollTop must be set imperatively
  // right after the commit instead, every render — matching the vanilla
  // behavior this replaces (land on 7am on every navigation/refresh).
  const scrollRef = createRef();
  litRender(weekTemplate(days, byDay, todayKey, scrollRef), host);
  if (scrollRef.value) scrollRef.value.scrollTop = 7 * HOUR_PX;
}

function weekTemplate(days, byDay, todayKey, scrollRef) {
  const hasAllDay = days.some((d) => (byDay.get(localDayKey(d)) ?? []).some((s) => s.spansAll));
  return html`<div class="week-wrap">
    <div class="week-head">
      <span></span>
      ${days.map((d) => weekDayHeadTpl(d, todayKey))}
    </div>
    ${hasAllDay
      ? html`<div class="week-allday">
          <span></span>
          ${days.map((d) => weekAllDayCellTpl(d, byDay))}
        </div>`
      : nothing}
    <div class="week-scroll" ${ref(scrollRef)}>
      <div class="week-grid">
        ${weekAxisTpl()} ${days.map((d) => weekColTpl(d, byDay, todayKey))}
      </div>
    </div>
  </div>`;
}

function weekDayHeadTpl(d, todayKey) {
  return html`<div
    class="week-day-head"
    data-today=${localDayKey(d) === todayKey ? 'true' : nothing}
  >
    <span class="week-dow muted small"
      >${d.toLocaleDateString(undefined, { weekday: 'short' })}</span
    >
    <span class="week-num">${d.getDate()}</span>
  </div>`;
}

function weekAllDayCellTpl(d, byDay) {
  const segs = (byDay.get(localDayKey(d)) ?? []).filter((s) => s.spansAll);
  return html`<div class="week-allday-cell">
    ${segs.map(
      (seg) => html`<button
        type="button"
        class="allday-chip"
        style=${`--ev-color:${colorFor(seg.ev.calendar_id)}`}
        title=${fmtRange(seg.ev)}
        @click=${(e) => openEventDetail(seg.ev, e.currentTarget)}
      >
        ${seg.ev.summary}
      </button>`,
    )}
  </div>`;
}

function weekAxisTpl() {
  return html`<div class="week-axis" style=${`height:${24 * HOUR_PX}px`}>
    ${Array.from({ length: 23 }, (_, i) => {
      const h = i + 1;
      return html`<span class="week-hour muted small" style=${`top:${h * HOUR_PX}px`}
        >${new Date(2024, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' })}</span
      >`;
    })}
  </div>`;
}

function weekColTpl(d, byDay, todayKey) {
  const key = localDayKey(d);
  const dayStart = d.getTime();
  const segs = (byDay.get(key) ?? []).filter((s) => !s.spansAll);
  return html`<div
    class="week-col"
    style=${`height:${24 * HOUR_PX}px`}
    data-today=${key === todayKey ? 'true' : nothing}
    @click=${(e) => {
      if (e.target.closest('.week-ev')) return;
      const rect = e.currentTarget.getBoundingClientRect();
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
    }}
  >
    ${layoutDay(segs).map((seg) => weekEvTpl(seg, dayStart))}
  </div>`;
}

function weekEvTpl(seg, dayStart) {
  const top = ((seg.segStart - dayStart) / 3600000) * HOUR_PX;
  const height = Math.max(((seg.segEnd - seg.segStart) / 3600000) * HOUR_PX, 22);
  const style = `--ev-color:${colorFor(seg.ev.calendar_id)};top:${top}px;height:${height}px;left:${(seg.col / seg.width) * 100}%;width:calc(${100 / seg.width}% - 2px)`;
  return html`<button
    type="button"
    class="week-ev"
    data-status=${seg.ev.status}
    style=${style}
    title=${`${fmtRange(seg.ev)} — ${seg.ev.summary}`}
    @click=${(e) => openEventDetail(seg.ev, e.currentTarget)}
  >
    <span class="week-ev-title">${seg.ev.summary}</span>
    <span class="week-ev-time">${segTimeText(seg)}</span>
  </button>`;
}

// ---------- List view ----------

function renderList() {
  const list = $('dayList');
  // A search swaps the loaded window for the vault's FTS matches (which can
  // reach past events the window never loaded); the calendar chips filter
  // either set the same way.
  const source = searchResults ?? events;
  const evs = source.filter((ev) => !ev.calendar_id || !hiddenCals.has(ev.calendar_id));
  $('empty').hidden = evs.length > 0;
  const byDay = bucketByDay(evs);
  const keys = [...byDay.keys()].sort();
  litRender(listTemplate(keys, byDay), list);
}

/**
 * Flat day-label + row (+ optional attachment strip) siblings, kept as a
 * plain function (not per-row components): app.css leans on `.row:last-child`
 * across the WHOLE rendered list, which only holds when `.row` stays a
 * direct child of `#dayList`.
 */
function listTemplate(keys, byDay) {
  const entries = [];
  for (const key of keys) {
    entries.push({ tpl: 'label', key: `label:${key}`, day: key });
    for (const seg of byDay.get(key)) {
      entries.push({ tpl: 'row', key: `row:${seg.ev.event_id}:${key}`, seg });
      if (seg.ev.attachments?.length) {
        entries.push({ tpl: 'attach', key: `attach:${seg.ev.event_id}:${key}`, seg });
      }
    }
  }
  return html`${repeat(
    entries,
    (e) => e.key,
    (e) => {
      if (e.tpl === 'label') {
        return html`<p class="day-label muted small" data-day=${e.day}>${fmtDay(e.day)}</p>`;
      }
      if (e.tpl === 'attach') {
        return html`<div
          class="kit-attach-strip row-attachments"
          ${ref((el) => {
            if (el) renderAttachments(el, e.seg.ev.attachments, removeAttachment);
          })}
        ></div>`;
      }
      return rowTpl(e.seg);
    },
  )}`;
}

// One event row: the main body is a real button — clicking anywhere on the
// text opens the event detail panel (attach/cancel stay as their own
// controls). Cancelling is medium-risk, so the vault parks it for the
// owner — the affordance is an ask, armed on first click (kit armConfirm).
function rowTpl(seg) {
  const ev = seg.ev;
  return html`<div class="row" data-status=${ev.status}>
    <button type="button" class="row-main" @click=${(e) => openEventDetail(ev, e.currentTarget)}>
      <span class="row-time">${segTimeText(seg)}</span>
      <span class="cal-dot" style=${`background:${colorFor(ev.calendar_id)}`}></span>
      <span class="row-text"
        >${ev.summary}${ev.snippet ? html`<br />${snippetSpanTpl(ev.snippet)}` : nothing}</span
      >
    </button>
    <span class="badge">${ev.status}</span>
    <button
      type="button"
      class="attach-btn cancel-btn"
      title="Ask to cancel — the owner approves it"
      aria-label="Ask to cancel this event"
      @click=${(e) => cancelFromRow(ev, e.currentTarget)}
    >
      ✕
    </button>
    <button
      type="button"
      class="attach-btn"
      title="Attach a file"
      aria-label="Attach a file"
      @click=${() => {
        attachTarget = ev.event_id;
        $('attachInput').click();
      }}
    >
      ⎘
    </button>
  </div>`;
}

// A vault search match carries its own snippet, already centered on the hit —
// it renders beneath the summary with the term marked. `snippetInto` mutates
// real nodes (the ⟦…⟧ hit markers become <mark>), so it needs a ref, same as
// the kit's other node-mutating helpers.
function snippetSpanTpl(snippet) {
  return html`<span
    class="row-snippet muted small"
    ${ref((el) => {
      if (!el) return;
      el.replaceChildren();
      snippetInto(el, snippet);
    })}
  ></span>`;
}

async function cancelFromRow(ev, btn) {
  if (!armConfirm(btn, { armedLabel: 'Ask to cancel?' })) return;
  const outcome = await act('cancel-event', { event_id: ev.event_id });
  if (narrate(outcome)) await load();
}

// ---------- Overlay: event detail popover + day panel ----------

let overlayReturn = null;

function openOverlay(build, returnFocus) {
  overlayReturn = returnFocus ?? document.activeElement;
  build($('overlayPanel'));
  $('overlay').hidden = false;
  $('overlayPanel').focus();
}

function closeOverlay() {
  if ($('overlay').hidden) return;
  $('overlay').hidden = true;
  // `#overlayPanel` is Lit-owned once anything has been built into it (event
  // detail or day panel) — commit an empty render instead of a raw clear, or
  // the next `litRender` into it throws (corrupted part cache).
  litRender(nothing, $('overlayPanel'));
  if (overlayReturn instanceof HTMLElement && overlayReturn.isConnected) overlayReturn.focus();
  overlayReturn = null;
}

function panelHeaderTpl(title, colorBar) {
  return html`<div class="panel-head">
    ${colorBar
      ? html`<span class="panel-color" style=${`background:${colorBar}`}></span>`
      : nothing}
    <h2 id="panelTitle">${title}</h2>
    <button type="button" class="panel-close" aria-label="Close" @click=${closeOverlay}>×</button>
  </div>`;
}

function openEventDetail(ev, returnFocus) {
  openOverlay((panel) => buildEventDetail(panel, ev), returnFocus);
}

// The event detail panel: meta, optional description/attachments, an inline
// reschedule form, and the attach/cancel actions. A one-time build (the
// panel isn't re-rendered reactively while open) — grab refs right after the
// commit and wire behavior with closures, same shape as tasks' popovers.
function buildEventDetail(panel, ev) {
  const startRef = createRef();
  const endRef = createRef();
  const saveRef = createRef();
  const cancelRef = createRef();
  const noticeRef = createRef();
  // Assigned once the template is committed (below); the inline `@click`/
  // `@change` bindings close over these and only ever fire after the whole
  // synchronous build has finished.
  let onStartChange = () => {};
  let onSave = () => {};
  let onCancel = () => {};

  litRender(
    eventDetailTemplate(ev, {
      startRef,
      endRef,
      saveRef,
      cancelRef,
      noticeRef,
      onStartChange: () => onStartChange(),
      onSave: () => onSave(),
      onCancel: () => onCancel(),
    }),
    panel,
  );

  const startEl = startRef.value;
  const endEl = endRef.value;
  const save = saveRef.value;
  const cancel = cancelRef.value;
  const noticeEl = noticeRef.value;
  let lastStart = startEl.value;

  // Inline narration for outcomes that keep the panel open.
  const sayInPanel = (text) => {
    noticeEl.textContent = text;
    noticeEl.hidden = !text;
  };

  onStartChange = () => {
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
  };

  onSave = async () => {
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
  };

  onCancel = async () => {
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
  };
}

function eventDetailTemplate(ev, refs) {
  const cal = calById.get(ev.calendar_id);
  return html`${panelHeaderTpl(ev.summary, colorFor(ev.calendar_id))}
    <div class="panel-meta">
      <p class="panel-when">${fmtRange(ev)}</p>
      <p class="panel-cal muted">
        <span class="cal-dot" style=${`background:${colorFor(ev.calendar_id)}`}></span>
        ${cal?.name ?? 'No calendar'} · <span class="badge">${ev.status}</span>
      </p>
    </div>
    ${ev.description ? html`<p class="panel-desc">${ev.description}</p>` : nothing}
    ${ev.attachments?.length
      ? html`<div
          class="kit-attach-strip panel-attachments"
          ${ref((el) => {
            if (el) renderAttachments(el, ev.attachments, removeAttachment);
          })}
        ></div>`
      : nothing}
    <div class="panel-edit">
      <p class="muted small panel-edit-label">Edit time</p>
      <div class="panel-times">
        <input
          type="datetime-local"
          aria-label="Starts"
          .value=${toLocalInput(ev.dtstart)}
          ${ref(refs.startRef)}
          @change=${refs.onStartChange}
        />
        <input
          type="datetime-local"
          aria-label="Ends"
          .value=${toLocalInput(ev.dtend ?? ev.dtstart)}
          ${ref(refs.endRef)}
        />
        <button
          type="button"
          class="kit-btn primary panel-save"
          ${ref(refs.saveRef)}
          @click=${refs.onSave}
        >
          Save
        </button>
      </div>
    </div>
    <div class="panel-actions">
      <button
        type="button"
        class="kit-btn"
        @click=${() => {
          attachTarget = ev.event_id;
          $('attachInput').click();
        }}
      >
        Attach a file
      </button>
      <button type="button" class="kit-btn danger" ${ref(refs.cancelRef)} @click=${refs.onCancel}>
        Ask to cancel
      </button>
    </div>
    <p class="panel-notice muted" role="status" hidden ${ref(refs.noticeRef)}></p>`;
}

/** Every event of one day — the "+N more" expansion. */
function openDayPanel(key, returnFocus) {
  openOverlay((panel) => {
    const segs = bucketByDay(visibleEvents()).get(key) ?? [];
    litRender(dayPanelTemplate(key, segs), panel);
  }, returnFocus);
}

function dayPanelTemplate(key, segs) {
  return html`${panelHeaderTpl(fmtDay(key))}
    <div class="panel-day-list">
      ${segs.map(
        (seg) => html`<button
          type="button"
          class="panel-day-item"
          @click=${() => buildEventDetail($('overlayPanel'), seg.ev)}
        >
          <span class="cal-dot" style=${`background:${colorFor(seg.ev.calendar_id)}`}></span>
          <span class="row-time">${segTimeText(seg)}</span>
          <span class="row-text">${seg.ev.summary}</span>
        </button>`,
      )}
    </div>`;
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
  } else {
    notice(outcomeMessage(outcome) ?? '');
    if (outcome?.status === 'denied') await load();
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
wireAttachInput($('attachInput'), () => attachTarget, { act, narrate, notice, refresh: load });

window.addEventListener('focus', () => load());
setSmartDefaults();
load();
