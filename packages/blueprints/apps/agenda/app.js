// Agenda — a pure projection over the personal vault. Every row rendered
// here lives in core.event; every mutation is a typed vault command routed
// through this app's handlers (ctx.vault on the gateway side). The app's
// own data.sqlite stays empty by design: revoke the grant and this page
// goes dark while the model, history and receipts remain the owner's.

const $ = (id) => document.getElementById(id);

let calendars = [];
let events = [];
let view = 'month';
// First day of the month being shown; navigation moves it whole months.
let monthCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

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

function dayKey(iso) {
  return String(iso).slice(0, 10);
}

function fmtDay(key) {
  const today = new Date().toISOString().slice(0, 10);
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

function notice(text) {
  const el = $('noticeBanner');
  el.textContent = text;
  el.hidden = !text;
}

// One narration for every action outcome, mirroring the inline handling on the
// propose form; returns true when it executed.
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

// Run an action and return the raw outcome so the shared attachment helpers
// can narrate and refresh on their own schedule.
async function act(action, input) {
  try {
    return await window.centraid.write({ action, input });
  } catch (err) {
    notice(String(err?.message ?? err));
    return undefined;
  }
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
      const outcome = await act('attach', { subject_id: subjectId, data_uri: dataUri, title: file.name });
      if (!narrate(outcome, refresh)) break;
    }
    inputEl.value = '';
    await refresh();
  });
}

// The event a list-row attach button will pin the next file onto. One hidden
// file input is shared across the list; the button sets this.
let attachTarget = null;

async function removeAttachment(attachmentId) {
  const outcome = await act('detach', { attachment_id: attachmentId });
  if (narrate(outcome) || outcome?.status === 'denied') await refresh();
}

async function refresh() {
  let data;
  try {
    data = await window.centraid.read({ query: 'upcoming' });
  } catch {
    return; // transient; the change feed retries
  }
  const denied = data?.vaultDenied;
  $('consentBanner').hidden = !denied;
  document.querySelector('.agenda-bar').hidden = Boolean(denied);
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    $('proposeForm').hidden = true;
    $('dayList').innerHTML = '';
    $('monthGrid').innerHTML = '';
    $('empty').hidden = true;
    $('noCalendars').hidden = true;
    return;
  }
  calendars = data?.calendars ?? [];
  events = data?.events ?? [];
  renderCalendars();
  render();
}

function render() {
  $('monthGrid').hidden = view !== 'month';
  $('monthNav').hidden = view !== 'month';
  $('dayList').hidden = view !== 'list';
  $('monthViewBtn').setAttribute('aria-pressed', String(view === 'month'));
  $('listViewBtn').setAttribute('aria-pressed', String(view === 'list'));
  if (view === 'month') renderMonth();
  else renderEvents(events);
}

// ---------- Month view: a plain CSS-grid calendar ----------

const MAX_PILLS = 3;

function renderMonth() {
  const grid = $('monthGrid');
  grid.innerHTML = '';
  $('empty').hidden = true;
  const year = monthCursor.getFullYear();
  const month = monthCursor.getMonth();
  $('monthLabel').textContent = monthCursor.toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });

  const byDay = new Map();
  for (const ev of events) {
    const key = dayKey(ev.dtstart);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(ev);
  }

  // Weekday header, Monday first.
  const monday = new Date(2024, 0, 1); // a known Monday
  for (let i = 0; i < 7; i += 1) {
    const h = document.createElement('span');
    h.className = 'dow muted small';
    h.textContent = new Date(
      monday.getFullYear(),
      monday.getMonth(),
      monday.getDate() + i,
    ).toLocaleDateString(undefined, { weekday: 'narrow' });
    grid.appendChild(h);
  }

  // 6 weeks × 7 days from the Monday on or before the 1st.
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7; // days since Monday
  const todayKey = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < 42; i += 1) {
    const date = new Date(year, month, 1 - lead + i);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const cell = document.createElement('div');
    cell.className = 'cell';
    if (date.getMonth() !== month) cell.dataset.outside = 'true';
    if (key === todayKey) cell.dataset.today = 'true';
    const num = document.createElement('span');
    num.className = 'cell-date';
    num.textContent = String(date.getDate());
    cell.appendChild(num);
    const dayEvents = byDay.get(key) ?? [];
    for (const ev of dayEvents.slice(0, MAX_PILLS)) {
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.dataset.status = ev.status;
      pill.textContent = ev.summary;
      pill.title = `${fmtTime(ev.dtstart)} ${ev.summary}`;
      cell.appendChild(pill);
    }
    if (dayEvents.length > MAX_PILLS) {
      const more = document.createElement('span');
      more.className = 'more muted small';
      more.textContent = `+${dayEvents.length - MAX_PILLS} more`;
      cell.appendChild(more);
    }
    grid.appendChild(cell);
  }
}

$('monthViewBtn').addEventListener('click', () => {
  view = 'month';
  render();
});
$('listViewBtn').addEventListener('click', () => {
  view = 'list';
  render();
});
$('prevMonth').addEventListener('click', () => {
  monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() - 1, 1);
  renderMonth();
});
$('nextMonth').addEventListener('click', () => {
  monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1);
  renderMonth();
});

function renderCalendars() {
  const select = $('calendarSelect');
  select.innerHTML = '';
  for (const c of calendars) {
    const opt = document.createElement('option');
    opt.value = c.calendar_id;
    opt.textContent = c.name ?? 'Calendar';
    select.appendChild(opt);
  }
  $('proposeForm').hidden = calendars.length === 0;
  $('noCalendars').hidden = calendars.length > 0;
}

function renderEvents(events) {
  const list = $('dayList');
  list.innerHTML = '';
  $('empty').hidden = events.length > 0;
  const byDay = new Map();
  for (const ev of events) {
    const key = dayKey(ev.dtstart);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(ev);
  }
  for (const [key, dayEvents] of byDay) {
    const h = document.createElement('p');
    h.className = 'day-label muted small';
    h.textContent = fmtDay(key);
    list.appendChild(h);
    for (const ev of dayEvents) {
      list.appendChild(renderRow(ev));
    }
  }
}

function renderRow(ev) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.status = ev.status;
  const time = document.createElement('span');
  time.className = 'row-time';
  time.textContent = `${fmtTime(ev.dtstart)}${ev.dtend ? `–${fmtTime(ev.dtend)}` : ''}`;
  const text = document.createElement('span');
  text.className = 'row-text';
  text.textContent = ev.summary;
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
  row.append(time, text, badge, attach);

  // Any attachments render as a strip beneath the row; the row and its strip
  // travel together in a fragment so the list's append logic stays flat.
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

$('proposeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const summary = $('summaryInput').value.trim();
  const dtstart = toIsoUtc($('startInput').value);
  const dtend = toIsoUtc($('endInput').value);
  const calendar_id = $('calendarSelect').value;
  if (!summary || !dtstart || !dtend || !calendar_id) return;
  let outcome;
  try {
    outcome = await window.centraid.write({
      action: 'propose',
      input: { summary, dtstart, dtend, calendar_id },
    });
  } catch (err) {
    notice(String(err?.message ?? err));
    return;
  }
  if (outcome?.status === 'executed') {
    notice('');
    $('summaryInput').value = '';
    await refresh();
  } else if (outcome?.status === 'parked') {
    notice('Sent to the owner for confirmation — it will appear once approved.');
  } else if (outcome?.status === 'failed') {
    notice(`The vault refused: ${outcome.predicate ?? outcome.reason ?? 'a precondition failed'}.`);
  } else if (outcome?.status === 'denied') {
    notice(`Denied by consent: ${outcome.reason ?? ''}`);
    await refresh();
  }
});

// One hidden file input serves the whole list; a row's attach button sets
// attachTarget just before triggering it.
wireAttachInput($('attachInput'), () => attachTarget);

window.addEventListener('focus', refresh);
refresh();
