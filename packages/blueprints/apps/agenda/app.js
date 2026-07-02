// Agenda — a pure projection over the personal vault. Every row rendered
// here lives in core.event; every mutation is a typed vault command routed
// through this app's handlers (ctx.vault on the gateway side). The app's
// own data.sqlite stays empty by design: revoke the grant and this page
// goes dark while the model, history and receipts remain the owner's.

const $ = (id) => document.getElementById(id);

let calendars = [];

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

async function refresh() {
  let data;
  try {
    data = await window.centraid.read({ query: 'upcoming' });
  } catch {
    return; // transient; the change feed retries
  }
  const denied = data?.vaultDenied;
  $('consentBanner').hidden = !denied;
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    $('proposeForm').hidden = true;
    $('dayList').innerHTML = '';
    $('empty').hidden = true;
    $('noCalendars').hidden = true;
    return;
  }
  calendars = data?.calendars ?? [];
  renderCalendars();
  renderEvents(data?.events ?? []);
}

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
  row.append(time, text, badge);
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

window.addEventListener('focus', refresh);
refresh();
