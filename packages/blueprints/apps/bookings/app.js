// Bookings — the self-employed front door as a projection over the personal
// vault. Availability windows are schedule.availability_rule; every booking
// is a canonical core.event held for a client. Requesting a slot is risk
// high for an app, so it PARKS for the owner's confirmation before holding
// the slot; confirming a tentative hold puts it on the books. The app stores
// nothing — revoke the grant and this page goes dark while the calendar,
// history and receipts remain the owner's.

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

function notice(text) {
  const el = $('noticeBanner');
  el.textContent = text;
  el.hidden = !text;
}

// One narration for every action outcome; returns true when it executed.
function narrate(outcome, parkedText) {
  if (outcome?.status === 'executed') {
    notice('');
    return true;
  }
  if (outcome?.status === 'parked') {
    notice(parkedText ?? 'Parked — the owner confirms this in vault settings.');
  } else if (outcome?.status === 'failed') {
    notice(`The vault refused: ${outcome.predicate ?? outcome.reason ?? 'a precondition failed'}.`);
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
    rm.addEventListener('click', () => onRemove(a.attachment_id));
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
    return; // transient; the change feed retries
  }
  const denied = next?.vaultDenied;
  $('consentBanner').hidden = !denied;
  $('live').hidden = Boolean(denied);
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    return;
  }
  data = next;
  renderAvailability();
  renderRequestForm();
  renderBookings();
}

function renderAvailability() {
  const row = $('availabilityChips');
  row.innerHTML = '';
  for (const a of data.availability) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = `${a.days.join(' ')} · ${a.window_start}–${a.window_end}`;
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
  if (!$('reqDate').value) $('reqDate').value = new Date().toISOString().slice(0, 10);
}

function renderBookings() {
  const list = $('bookingList');
  list.innerHTML = '';
  // Pending (tentative) first, then confirmed — both chronological.
  const ordered = [...data.bookings].sort(
    (a, b) =>
      (a.status === 'tentative' ? 0 : 1) - (b.status === 'tentative' ? 0 : 1) ||
      String(a.dtstart).localeCompare(String(b.dtstart)),
  );
  $('empty').hidden = ordered.length > 0;
  for (const b of ordered) {
    list.appendChild(renderBooking(b));
  }
}

function renderBooking(b) {
  const row = document.createElement('div');
  row.className = 'booking';
  const main = document.createElement('div');
  main.className = 'booking-main';
  const title = document.createElement('span');
  title.className = 'booking-title';
  title.textContent = b.requester ? `${b.summary} · ${b.requester}` : b.summary;
  const when = document.createElement('span');
  when.className = 'booking-when';
  when.textContent = fmtWhen(b.dtstart, b.dtend);
  main.append(title, when);
  row.appendChild(main);

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
      const outcome = await act('confirm-booking', { event_id: b.event_id });
      if (narrate(outcome)) await refresh();
    });
    actions.appendChild(confirm);
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

$('availabilityForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  let mask = 0;
  for (const btn of $('dayToggles').querySelectorAll('.day-toggle')) {
    if (btn.getAttribute('aria-pressed') === 'true') mask |= Number(btn.dataset.bit);
  }
  const start = $('winStart').value;
  const end = $('winEnd').value;
  if (!mask || !start || !end || end <= start) {
    notice('Pick at least one day and a valid time window.');
    return;
  }
  const outcome = await act('set-availability', {
    weekday_mask: mask,
    window_start: start,
    window_end: end,
    tz: TZ,
  });
  if (narrate(outcome)) await refresh();
});

// ---------- Request form ----------

$('requestForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const calendar_id = $('reqCalendar').value;
  const requester_party_id = $('reqParty').value;
  const summary = $('reqSummary').value.trim();
  const date = $('reqDate').value;
  const start = $('reqStart').value;
  const end = $('reqEnd').value;
  if (!calendar_id || !requester_party_id || !summary || !date || !start || !end) {
    notice('Fill in the client, summary, date and times.');
    return;
  }
  const outcome = await act('request-booking', {
    calendar_id,
    requester_party_id,
    summary,
    dtstart: `${date}T${start}:00Z`,
    dtend: `${date}T${end}:00Z`,
  });
  if (
    narrate(outcome, 'Booking request parked — confirm it in vault settings and it holds the slot.')
  ) {
    $('reqSummary').value = '';
    await refresh();
  } else if (outcome?.status === 'parked') {
    $('reqSummary').value = '';
  }
});

renderDayToggles();
window.addEventListener('focus', refresh);
refresh();
