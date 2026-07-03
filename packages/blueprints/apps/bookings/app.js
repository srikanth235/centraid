// governance: allow-repo-hygiene file-size-limit blueprints are single-file by design (read wholesale by one agent); Bookings covers the whole owner-side scheduling loop — availability kinds, a week strip, the request queue with parked ghosts, and confirmation — and splitting it would break that "one file" contract.
// Bookings — the self-employed front door as a projection over the personal
// vault. Availability windows are schedule.availability_rule; every booking
// is a canonical core.event held for a client. Requesting a slot is risk
// high for an app, so it PARKS for the owner's confirmation before holding
// the slot; confirming a tentative hold puts it on the books. The app stores
// nothing — revoke the grant and this page goes dark while the calendar,
// history and receipts remain the owner's.

import { armConfirm, letterAvatar, localDayKey, readFailed, showSkeleton, toast } from './kit.js';

const $ = (id) => document.getElementById(id);

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();

let data = { availability: [], bookings: [], calendars: [], parties: [] };
let attachTarget = null; // event_id the shared file input attaches to
let readErrorShown = false;
// Session-local ghosts for requests that parked — the queue stays visible
// where the work happens until the owner approves them in vault settings.
let parkedRequests = [];
const filters = { pending: true, upcoming: true, past: false };

function notice(text) {
  const el = $('noticeBanner');
  el.textContent = text;
  el.hidden = !text;
}

// The vault speaks in predicate names; the owner shouldn't have to.
const PREDICATE_TEXT = {
  dtend_after_dtstart: 'the end time must be after the start',
  window_is_positive: 'the window must end after it starts',
  no_busy_conflict: 'that slot collides with a booking already on the calendar',
  calendar_exists: 'that calendar no longer exists',
  requester_exists: 'that client no longer exists',
  rule_created: 'the window was not saved',
  booking_held_tentative: 'the hold was not saved',
};

// One narration for every action outcome; returns true when it executed.
function narrate(outcome, parkedText) {
  if (outcome?.status === 'executed') {
    notice('');
    return true;
  }
  if (outcome?.status === 'parked') {
    notice(parkedText ?? 'Parked — the owner confirms this in vault settings.');
  } else if (outcome?.status === 'failed') {
    const raw = outcome.predicate ?? outcome.reason ?? '';
    notice(`Couldn’t do that — ${PREDICATE_TEXT[raw] ?? raw ?? 'a precondition failed'}.`);
  } else if (outcome?.status === 'denied') {
    notice(`Denied by consent: ${outcome.reason ?? ''}`);
  }
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

// ---------- Attachments (shared pattern across apps) ----------
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
    rm.addEventListener('click', () => {
      // Detach discards a pinned file — arm first, confirm on the 2nd tap.
      if (!armConfirm(rm, { armedLabel: 'Sure?' })) return;
      onRemove(a.attachment_id);
    });
    tile.appendChild(rm);
    stripEl.appendChild(tile);
  }
}

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
      if (!narrate(outcome)) break;
    }
    inputEl.value = '';
    await refresh();
  });
}

async function removeAttachment(attachmentId) {
  const outcome = await act('detach', { attachment_id: attachmentId });
  if (narrate(outcome)) await refresh();
}

wireAttachInput($('attachInput'), () => attachTarget);

// ---------- Formatting ----------

const pad2 = (n) => String(n).padStart(2, '0');

function timeToMins(t) {
  const [h, m] = String(t ?? '')
    .split(':')
    .map(Number);
  return (h || 0) * 60 + (m || 0);
}

function minsToTime(mins) {
  const m = ((mins % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

function sameInstant(a, b) {
  return new Date(a).getTime() === new Date(b).getTime();
}

function fmtWhen(dtstart, dtend) {
  try {
    const s = new Date(dtstart);
    const day = s.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    const t1 = s.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const t2 = dtend
      ? new Date(dtend).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : '';
    return `${day}, ${t1}${t2 ? `–${t2}` : ''}`;
  } catch {
    return String(dtstart);
  }
}

// ---------- Render ----------

async function refresh() {
  let next;
  try {
    next = await window.centraid.read({ query: 'board' });
  } catch {
    // A broken vault must not look like an empty one.
    readFailed($('noticeBanner'));
    readErrorShown = true;
    return;
  }
  if (readErrorShown) {
    notice('');
    readErrorShown = false;
  }
  const denied = next?.vaultDenied;
  $('consentBanner').hidden = !denied;
  $('live').hidden = Boolean(denied);
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    return;
  }
  data = next;
  // A ghost whose real hold landed (owner approved the parked request)
  // gives way to the tentative row from the vault.
  parkedRequests = parkedRequests.filter(
    (p) => !data.bookings.some((b) => b.summary === p.summary && sameInstant(b.dtstart, p.dtstart)),
  );
  renderAvailability();
  renderRequestForm();
  renderWeekStrip();
  renderBookings();
}

function renderAvailability() {
  const row = $('availabilityChips');
  row.innerHTML = '';
  $('availabilityEmpty').hidden = data.availability.length > 0;
  for (const a of data.availability) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const kind = a.kind ?? 'work';
    if (kind === 'blocked') chip.classList.add('blocked');
    else if (kind !== 'work') chip.classList.add('alt');
    const prefix = kind !== 'work' ? `${kind} · ` : '';
    // Windows are wall-clock in the rule's tz — flag it when it isn't yours.
    const tzNote = a.tz && a.tz !== TZ ? ` · ${a.tz}` : '';
    chip.textContent = `${prefix}${a.days.join(' ')} · ${a.window_start}–${a.window_end}${tzNote}`;
    row.appendChild(chip);
  }
}

function fillSelect(select, options, placeholder) {
  const previous = select.value;
  select.innerHTML = '';
  if (placeholder) {
    const el = document.createElement('option');
    el.value = '';
    el.textContent = placeholder;
    el.disabled = true;
    el.selected = true;
    select.appendChild(el);
  }
  for (const opt of options) {
    const el = document.createElement('option');
    el.value = opt.value;
    el.textContent = opt.label;
    if (opt.value === previous) el.selected = true;
    select.appendChild(el);
  }
}

function renderRequestForm() {
  fillSelect(
    $('reqCalendar'),
    data.calendars.map((c) => ({ value: c.calendar_id, label: c.name })),
    data.calendars.length ? 'Calendar…' : 'No calendar yet',
  );
  fillSelect(
    $('reqParty'),
    data.parties.map((p) => ({ value: p.party_id, label: p.display_name })),
    data.parties.length ? 'Client…' : 'No people yet',
  );
  if (!$('reqDate').value) $('reqDate').value = localDayKey(new Date());
}

// ---------- Week strip (read-only visualization of loaded data) ----------

function mondayOf(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday-first week
  return d;
}

function renderWeekStrip() {
  const wrap = $('weekStrip');
  wrap.innerHTML = '';
  const weekStart = mondayOf(new Date());
  const dayDates = [];
  const byDay = new Map();
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    dayDates.push(d);
    byDay.set(localDayKey(d), []);
  }
  for (const b of data.bookings) {
    const key = localDayKey(b.dtstart);
    if (byDay.has(key)) byDay.get(key).push(b);
  }
  const hasWeekBookings = [...byDay.values()].some((list) => list.length > 0);
  $('weekSection').hidden = !data.availability.length && !hasWeekBookings;
  if ($('weekSection').hidden) return;

  // The visible hour span hugs the data: default business hours, stretched
  // to cover any window or booking that falls outside them.
  let minM = 8 * 60;
  let maxM = 18 * 60;
  for (const a of data.availability) {
    minM = Math.min(minM, timeToMins(a.window_start));
    maxM = Math.max(maxM, timeToMins(a.window_end));
  }
  const localSpan = (b) => {
    const s = new Date(b.dtstart);
    const e = b.dtend ? new Date(b.dtend) : new Date(s.getTime() + 3600000);
    return [s.getHours() * 60 + s.getMinutes(), e.getHours() * 60 + e.getMinutes() || 1440];
  };
  for (const list of byDay.values()) {
    for (const b of list) {
      const [s, e] = localSpan(b);
      minM = Math.min(minM, s);
      maxM = Math.max(maxM, e);
    }
  }
  minM = Math.floor(minM / 60) * 60;
  maxM = Math.min(Math.ceil(maxM / 60) * 60, 1440);
  if (maxM - minM < 60) maxM = minM + 60;
  const span = maxM - minM;
  const pct = (m) => Math.max(0, Math.min(100, ((m - minM) / span) * 100));
  const place = (el, s, e) => {
    el.style.top = `${pct(s)}%`;
    el.style.height = `${Math.max(pct(e) - pct(s), 3)}%`;
  };

  const todayKey = localDayKey(new Date());
  dayDates.forEach((date, i) => {
    const key = localDayKey(date);
    const col = document.createElement('div');
    col.className = 'week-col';
    if (key === todayKey) col.classList.add('today');
    const head = document.createElement('div');
    head.className = 'week-day';
    head.textContent = `${DAYS[i]} ${date.getDate()}`;
    const body = document.createElement('div');
    body.className = 'week-col-body';
    for (const a of data.availability) {
      if (!(a.weekday_mask & (1 << i))) continue;
      const block = document.createElement('div');
      const kind = a.kind ?? 'work';
      block.className =
        kind === 'work' ? 'week-avail' : `week-avail ${kind === 'blocked' ? 'blocked' : 'alt'}`;
      place(block, timeToMins(a.window_start), timeToMins(a.window_end));
      body.appendChild(block);
    }
    for (const b of byDay.get(key)) {
      const evt = document.createElement('div');
      evt.className = b.status === 'tentative' ? 'week-evt tentative' : 'week-evt';
      evt.title = `${b.summary} · ${fmtWhen(b.dtstart, b.dtend)}`;
      const [s, e] = localSpan(b);
      place(evt, s, e);
      body.appendChild(evt);
    }
    col.append(head, body);
    wrap.appendChild(col);
  });
}

// ---------- Bookings list (Pending / Upcoming / Past) ----------

function bucketOf(b) {
  if (b.status === 'tentative') return 'pending';
  const end = new Date(b.dtend ?? b.dtstart).getTime();
  return end < Date.now() ? 'past' : 'upcoming';
}

const BUCKET_LABEL = { pending: 'Pending', upcoming: 'Upcoming', past: 'Past' };

function updatePills(counts) {
  for (const pill of $('filterPills').querySelectorAll('.pill')) {
    const bucket = pill.dataset.bucket;
    const n = counts[bucket];
    pill.textContent = n ? `${BUCKET_LABEL[bucket]} · ${n}` : BUCKET_LABEL[bucket];
    pill.setAttribute('aria-pressed', String(filters[bucket]));
  }
}

function renderBookings() {
  const list = $('bookingList');
  list.innerHTML = '';
  const buckets = { pending: [], upcoming: [], past: [] };
  for (const b of data.bookings) buckets[bucketOf(b)].push(b);
  const byStart = (a, b) => String(a.dtstart).localeCompare(String(b.dtstart));
  buckets.pending.sort(byStart);
  buckets.upcoming.sort(byStart);
  buckets.past.sort((a, b) => byStart(b, a)); // most recent first
  updatePills({
    pending: buckets.pending.length + parkedRequests.length,
    upcoming: buckets.upcoming.length,
    past: buckets.past.length,
  });

  let shown = 0;
  for (const name of ['pending', 'upcoming', 'past']) {
    if (!filters[name]) continue;
    const ghosts = name === 'pending' ? parkedRequests : [];
    if (!buckets[name].length && !ghosts.length) continue;
    const label = document.createElement('p');
    label.className = 'group-label';
    label.textContent = BUCKET_LABEL[name];
    list.appendChild(label);
    for (const g of ghosts) {
      list.appendChild(renderGhost(g));
      shown += 1;
    }
    for (const b of buckets[name]) {
      list.appendChild(renderBooking(b));
      shown += 1;
    }
  }
  const empty = $('empty');
  empty.hidden = shown > 0;
  empty.textContent =
    data.bookings.length + parkedRequests.length === 0
      ? 'No bookings yet. Set your availability, then log a request above.'
      : 'Nothing in this view — flip the filters above.';
}

function bookingRowBase(b) {
  const row = document.createElement('div');
  row.className = 'booking';
  row.appendChild(letterAvatar(b.requester ?? b.summary, { size: '2.25rem' }));
  const main = document.createElement('div');
  main.className = 'booking-main';
  const title = document.createElement('span');
  title.className = 'booking-title';
  title.textContent = b.requester ? `${b.summary} · ${b.requester}` : b.summary;
  const when = document.createElement('span');
  when.className = 'booking-when';
  when.textContent = fmtWhen(b.dtstart, b.dtend);
  main.append(title, when);
  if (b.description) {
    const notes = document.createElement('span');
    notes.className = 'booking-notes';
    notes.textContent = b.description;
    main.appendChild(notes);
  }
  row.appendChild(main);
  return row;
}

// A request the vault parked: visible in the queue, not yet a booking.
function renderGhost(g) {
  const row = bookingRowBase(g);
  row.classList.add('kit-pending');
  const chip = document.createElement('span');
  chip.className = 'kit-pending-chip';
  chip.textContent = 'awaiting your approval in vault settings';
  row.appendChild(chip);
  return row;
}

function renderBooking(b) {
  const row = bookingRowBase(b);
  const badge = document.createElement('span');
  badge.className = 'badge';
  if (b.status === 'tentative') {
    badge.classList.add('pending');
    badge.textContent = 'pending';
  } else {
    badge.textContent = b.status;
  }
  row.appendChild(badge);

  const actions = document.createElement('span');
  actions.className = 'booking-actions';
  if (b.status === 'tentative') {
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'ghost';
    confirm.textContent = 'Confirm';
    confirm.addEventListener('click', async () => {
      // Confirm puts the hold on the books — arm first, run on the 2nd tap.
      if (!armConfirm(confirm, { armedLabel: 'Confirm?' })) return;
      confirm.disabled = true;
      const outcome = await act('confirm-booking', { event_id: b.event_id });
      confirm.disabled = false;
      if (narrate(outcome)) {
        toast('Booking confirmed');
        await refresh();
      }
    });
    actions.appendChild(confirm);
  }

  // Decline a pending request / cancel a confirmed booking — both run
  // schedule.cancel_event, which parks for the owner (medium risk).
  if (b.status === 'tentative' || b.status === 'confirmed') {
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'ghost danger';
    cancel.textContent = b.status === 'tentative' ? 'Decline' : 'Cancel';
    cancel.addEventListener('click', async () => {
      if (!armConfirm(cancel, { armedLabel: b.status === 'tentative' ? 'Decline?' : 'Cancel?' })) {
        return;
      }
      cancel.disabled = true;
      const outcome = await act('cancel-booking', { event_id: b.event_id });
      cancel.disabled = false;
      if (narrate(outcome, 'Cancellation sent for your approval — it lands once you confirm it.')) {
        toast('Booking cancelled');
        await refresh();
      }
    });
    actions.appendChild(cancel);

    const move = document.createElement('button');
    move.type = 'button';
    move.className = 'ghost';
    move.textContent = 'Reschedule';
    move.addEventListener('click', () => toggleRescheduleEditor(row, b));
    actions.appendChild(move);
  }

  const attach = document.createElement('button');
  attach.type = 'button';
  attach.className = 'ghost';
  attach.textContent = '＋ File';
  attach.addEventListener('click', () => {
    attachTarget = b.event_id;
    $('attachInput').click();
  });
  actions.appendChild(attach);
  row.appendChild(actions);

  const strip = document.createElement('div');
  strip.className = 'attach-strip';
  renderAttachments(strip, b.attachments, removeAttachment);
  row.appendChild(strip);
  return row;
}

// ---------- Reschedule editor (inline, one open per row) ----------

function toggleRescheduleEditor(row, b) {
  const open = row.querySelector('.reschedule-form');
  if (open) {
    open.remove();
    return;
  }
  const form = document.createElement('form');
  form.className = 'reschedule-form';

  const pad = (n) => String(n).padStart(2, '0');
  const toParts = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return { date: '', time: '' };
    return {
      date: localDayKey(d),
      time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    };
  };
  const start = toParts(b.dtstart);
  const end = toParts(b.dtend);

  const date = document.createElement('input');
  date.type = 'date';
  date.value = start.date;
  date.setAttribute('aria-label', 'New date');
  const from = document.createElement('input');
  from.type = 'time';
  from.value = start.time;
  from.setAttribute('aria-label', 'New start time');
  const to = document.createElement('input');
  to.type = 'time';
  to.value = end.time;
  to.setAttribute('aria-label', 'New end time');
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'primary small-btn';
  save.textContent = 'Move';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'ghost';
  close.textContent = 'Close';
  close.addEventListener('click', () => form.remove());
  const err = document.createElement('span');
  err.className = 'field-error';
  err.setAttribute('role', 'alert');
  err.hidden = true;

  form.append(date, from, to, save, close, err);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    if (!date.value || !from.value || !to.value) return;
    if (to.value <= from.value) {
      err.textContent = 'End must be after start.';
      err.hidden = false;
      return;
    }
    save.disabled = true;
    const outcome = await act('reschedule-booking', {
      event_id: b.event_id,
      dtstart: new Date(`${date.value}T${from.value}`).toISOString(),
      dtend: new Date(`${date.value}T${to.value}`).toISOString(),
    });
    save.disabled = false;
    if (narrate(outcome, 'Move sent for your approval — the booking shifts once you confirm.')) {
      toast('Booking moved');
      await refresh();
    }
  });
  row.appendChild(form);
  date.focus();
}

$('filterPills').addEventListener('click', (e) => {
  const pill = e.target.closest('.pill');
  if (!pill) return;
  filters[pill.dataset.bucket] = !filters[pill.dataset.bucket];
  renderBookings();
});

// ---------- Availability editor ----------

function renderDayToggles() {
  const wrap = $('dayToggles');
  wrap.innerHTML = '';
  DAYS.forEach((label, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'day-toggle';
    btn.dataset.bit = String(1 << i);
    btn.textContent = label;
    // Weekdays default on.
    btn.setAttribute('aria-pressed', String(i < 5));
    btn.addEventListener('click', () => {
      btn.setAttribute(
        'aria-pressed',
        btn.getAttribute('aria-pressed') === 'true' ? 'false' : 'true',
      );
    });
    wrap.appendChild(btn);
  });
}

// Work / Blocked behaves like a radio: exactly one kind is active.
$('kindToggles').addEventListener('click', (e) => {
  const btn = e.target.closest('.kind-toggle');
  if (!btn) return;
  for (const b of $('kindToggles').querySelectorAll('.kind-toggle')) {
    b.setAttribute('aria-pressed', String(b === btn));
  }
});

$('availabilityForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  let mask = 0;
  for (const btn of $('dayToggles').querySelectorAll('.day-toggle')) {
    if (btn.getAttribute('aria-pressed') === 'true') mask |= Number(btn.dataset.bit);
  }
  const start = $('winStart').value;
  const end = $('winEnd').value;
  if (!mask || !start || !end) {
    notice('Pick at least one day and both times.');
    return;
  }
  if (end <= start) {
    notice('The window needs to end after it starts.');
    return;
  }
  const kind =
    $('kindToggles').querySelector('.kind-toggle[aria-pressed="true"]')?.dataset.kind ?? 'work';
  const outcome = await act('set-availability', {
    weekday_mask: mask,
    window_start: start,
    window_end: end,
    kind,
    tz: TZ,
  });
  if (narrate(outcome)) {
    toast(kind === 'blocked' ? 'Blocked window added' : 'Work window added');
    await refresh();
  }
});

// ---------- Request form ----------

function showTimeError(text) {
  const el = $('timeError');
  el.textContent = text;
  el.hidden = false;
}

function hideTimeError() {
  $('timeError').hidden = true;
}

// Duration presets: pick one and the end time follows the start.
let lastDuration = 60;

function currentDuration() {
  const d = timeToMins($('reqEnd').value) - timeToMins($('reqStart').value);
  return d > 0 ? d : lastDuration;
}

function applyDuration(mins) {
  lastDuration = mins;
  if ($('reqStart').value) {
    $('reqEnd').value = minsToTime(timeToMins($('reqStart').value) + mins);
  }
  hideTimeError();
  markActivePreset();
}

function markActivePreset() {
  const d = timeToMins($('reqEnd').value) - timeToMins($('reqStart').value);
  for (const btn of document.querySelectorAll('.preset')) {
    btn.setAttribute('aria-pressed', String(Number(btn.dataset.mins) === d));
  }
}

for (const btn of document.querySelectorAll('.preset')) {
  btn.addEventListener('click', () => applyDuration(Number(btn.dataset.mins)));
}

$('reqStart').addEventListener('change', () => {
  // The end auto-bumps when the start moves past it, keeping the duration.
  if ($('reqEnd').value <= $('reqStart').value) {
    $('reqEnd').value = minsToTime(timeToMins($('reqStart').value) + lastDuration);
  }
  hideTimeError();
  markActivePreset();
});

$('reqEnd').addEventListener('change', () => {
  const d = currentDuration();
  if (d > 0) lastDuration = d;
  hideTimeError();
  markActivePreset();
});

$('requestForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideTimeError();
  const calendar_id = $('reqCalendar').value;
  const requester_party_id = $('reqParty').value;
  const summary = $('reqSummary').value.trim();
  const date = $('reqDate').value;
  const start = $('reqStart').value;
  const end = $('reqEnd').value;
  const description = $('reqNotes').value.trim();
  if (!calendar_id || !requester_party_id || !summary || !date || !start || !end) {
    notice('Fill in the client, summary, date and times.');
    return;
  }
  if (timeToMins(end) <= timeToMins(start)) {
    showTimeError('The end time needs to be after the start — try a duration preset.');
    $('reqEnd').focus();
    return;
  }
  // date/time inputs are the owner's wall clock — convert, don't relabel as UTC.
  const input = {
    calendar_id,
    requester_party_id,
    summary,
    dtstart: new Date(`${date}T${start}`).toISOString(),
    dtend: new Date(`${date}T${end}`).toISOString(),
    ...(description ? { description } : {}),
  };
  // The identical ask parked already — don't queue it twice.
  const key = [calendar_id, requester_party_id, input.dtstart, input.dtend, summary].join('|');
  if (parkedRequests.some((p) => p.key === key)) {
    notice('That exact request is already waiting for your approval in vault settings.');
    return;
  }
  const btn = $('reqSubmit');
  btn.disabled = true;
  const outcome = await act('request-booking', input);
  btn.disabled = false;
  if (outcome?.status === 'parked') {
    parkedRequests.push({
      key,
      summary,
      description: description || null,
      dtstart: input.dtstart,
      dtend: input.dtend,
      requester: data.parties.find((p) => p.party_id === requester_party_id)?.display_name ?? null,
    });
    notice('Booking request parked — approve it in vault settings and it holds the slot.');
    $('reqSummary').value = '';
    $('reqNotes').value = '';
    renderBookings();
  } else if (narrate(outcome)) {
    toast('Booking requested');
    $('reqSummary').value = '';
    $('reqNotes').value = '';
    await refresh();
  }
});

// ---------- Boot ----------

renderDayToggles();
markActivePreset();
showSkeleton($('bookingList'), 3); // first paint shimmers until the vault answers
window.addEventListener('focus', refresh);
refresh();
