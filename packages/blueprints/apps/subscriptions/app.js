// governance: allow-repo-hygiene file-size-limit blueprints are single-file by design (read wholesale by one agent); Subscriptions is a finished product — monthly total, renewal dates, a 30-day runway, inline editing, pause/cancel, attachments — and splitting it would break that "one file" contract.
// Subscriptions — money that repeats, as a projection over the personal
// vault. Each row is a finance.recurring_series charging one of your
// accounts; the app normalizes every cadence to a monthly figure so the
// running total is honest, and frames the yearly cost beside it because
// that's the number that makes people cancel. Renewal dates project from
// each series' anchor_on rolled forward by its cadence (the query owns that
// math); rows sort by what renews next, Bobby-style, and the next 30 days
// stack up in "Up next". Adding, editing, pausing, cancelling and
// reactivating run through typed finance commands (all risk low); files
// attach per subscription. The list reads a bounded recent window (issue
// #262) — the newest series, with the total and runway computed over that
// slice and "Show more" to grow it — because vault data has no upper bound.
// The app stores nothing — revoke the grant and this page goes dark while
// the series, history and receipts remain the owner's.

import {
  armConfirm,
  barSpan,
  fmtMoney,
  letterAvatar,
  localDayKey,
  outcomeMessage,
  readFailed,
  showSkeleton,
  toast,
} from './kit.js';

const $ = (id) => document.getElementById(id);

let data = { subscriptions: [], monthly_active_minor: 0, upcoming: [], accounts: [], parties: [] };
let attachTarget = null; // series_id the shared file input attaches to
const ui = { filter: 'active', sort: 'next', showEnded: false };

// While an inline edit form is open, refreshes park here instead of wiping
// the user's typing; applied when the form closes (home-inventory pattern).
let activeEditor = null;
let renderPending = false;

// A row without a payee party falls back to the charging account's name —
// useful, but "Checking" must never masquerade as a service.
const displayName = (s) => s.counterparty ?? s.account;

// ---------- Renewal dates (next_on comes precomputed from the query) ----------

/** Whole days from the viewer's local today to a YYYY-MM-DD key. */
function daysUntil(key) {
  const [y1, m1, d1] = localDayKey(new Date()).split('-').map(Number);
  const [y2, m2, d2] = String(key).split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

/** "Mar 14" — a day key in the viewer's locale. */
function fmtDay(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "renews Mar 14 · in 6 days" — the row's one-line renewal story. */
function renewCopy(nextOn) {
  const days = daysUntil(nextOn);
  if (days <= 0) return 'renews today';
  if (days === 1) return 'renews tomorrow';
  return `renews ${fmtDay(nextOn)} · in ${days} days`;
}

function editorClosed() {
  activeEditor = null;
  if (renderPending) {
    renderPending = false;
    renderUpNext();
    renderList();
  }
}

function notice(text) {
  const el = $('noticeBanner');
  el.textContent = text;
  el.hidden = !text;
}

function narrate(outcome) {
  if (outcome?.status === 'executed') {
    notice('');
    return true;
  }
  const message = outcomeMessage(outcome);
  if (message) notice(message);
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

// ---------- Read + render ----------

// The browse window: the list query reads only this many recent series
// (newest first), and the monthly total and 30-day runway are computed over
// that slice. "Show more" grows it.
let listWindow = 500;
let listTruncated = false;

let readBroken = false;

async function refresh() {
  let next;
  try {
    next = await window.centraid.read({ query: 'list', input: { limit: listWindow } });
  } catch {
    // A broken vault must not look like an empty one; focus retries.
    readBroken = true;
    readFailed($('noticeBanner'));
    return;
  }
  if (readBroken) {
    readBroken = false;
    notice(''); // the retry landed — retire the failure banner
  }
  const denied = next?.vaultDenied;
  $('consentBanner').hidden = !denied;
  $('live').hidden = Boolean(denied);
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    return;
  }
  data = next;
  listTruncated = Boolean(next?.truncated);
  renderTotal();
  renderAddForm();
  renderToolbar();
  if (activeEditor) {
    // Someone is typing in an inline edit form — don't wipe it.
    renderPending = true;
    return;
  }
  renderUpNext();
  renderList();
}

/** Active spend per currency — minor units across currencies don't add. */
function activeByCurrency() {
  const byCurrency = new Map();
  for (const s of data.subscriptions) {
    if (s.status !== 'active') continue;
    const currency = s.currency || data.accounts[0]?.currency || 'USD';
    byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + Number(s.monthly_minor ?? 0));
  }
  return byCurrency;
}

function renderTotal() {
  const byCurrency = activeByCurrency();
  const card = $('totalCard');
  card.hidden = byCurrency.size === 0;
  if (byCurrency.size === 0) return;
  const entries = [...byCurrency.entries()];
  $('totalValue').textContent = entries
    .map(([currency, minor]) => fmtMoney(minor, currency))
    .join(' + ');
  // The yearly frame is the emotional hook: €12.99/mo reads fine,
  // €155.88/yr starts conversations.
  $('totalYear').textContent = `≈ ${entries
    .map(([currency, minor]) => fmtMoney(minor * 12, currency))
    .join(' + ')} a year`;
}

// "Up next": every charge the query projects inside the next 30 days, with
// a window total per currency — the runway view that makes renewals real.
function renderUpNext() {
  const upcoming = data.upcoming ?? [];
  $('upNext').hidden = upcoming.length === 0;
  if (upcoming.length === 0) return;
  const bySeries = new Map(data.subscriptions.map((s) => [s.series_id, s]));
  const totals = new Map();
  const list = $('upNextList');
  list.innerHTML = '';
  for (const u of upcoming) {
    const currency = u.currency || data.accounts[0]?.currency || 'USD';
    totals.set(currency, (totals.get(currency) ?? 0) + Number(u.expected_minor ?? 0));
    const row = document.createElement('div');
    row.className = 'upnext-row';
    const date = document.createElement('span');
    date.className = 'upnext-date';
    date.textContent = daysUntil(u.on) <= 0 ? 'Today' : fmtDay(u.on);
    const name = document.createElement('span');
    name.className = 'upnext-name';
    const sub = bySeries.get(u.series_id);
    name.textContent = sub ? displayName(sub) : '—';
    const amt = document.createElement('span');
    amt.className = 'upnext-amt';
    amt.textContent = fmtMoney(u.expected_minor, currency);
    row.append(date, name, amt);
    list.appendChild(row);
  }
  $('upNextTotal').textContent = [...totals.entries()]
    .map(([currency, minor]) => fmtMoney(minor, currency))
    .join(' + ');
}

function fillSelect(select, options, placeholder) {
  const previous = select.value;
  select.innerHTML = '';
  if (placeholder) {
    const el = document.createElement('option');
    el.value = '';
    el.textContent = placeholder;
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

function renderAddForm() {
  $('addForm').hidden = data.accounts.length === 0;
  $('noAccounts').hidden = data.accounts.length > 0 || data.subscriptions.length > 0;
  fillSelect(
    $('accountSelect'),
    data.accounts.map((a) => ({ value: a.account_id, label: `${a.name} · ${a.currency}` })),
  );
  // An empty payee dropdown teaches nothing — swap it for the explanation.
  const hasParties = data.parties.length > 0;
  $('payeeSelect').hidden = !hasParties;
  $('payeeHint').hidden = hasParties;
  fillSelect(
    $('payeeSelect'),
    data.parties.map((p) => ({ value: p.party_id, label: p.display_name })),
    'Pick who you pay… (optional)',
  );
}

// ---------- Toolbar: status pills + sort ----------

function renderToolbar() {
  $('toolbar').hidden = data.subscriptions.length === 0;
  for (const pill of document.querySelectorAll('.pill')) {
    pill.setAttribute('aria-pressed', String(pill.dataset.filter === ui.filter));
  }
}

for (const pill of document.querySelectorAll('.pill')) {
  pill.addEventListener('click', () => {
    editorClosed(); // re-rendering rebuilds rows; never strand an open form
    ui.filter = pill.dataset.filter;
    renderToolbar();
    renderList();
  });
}

$('sortSelect').addEventListener('change', () => {
  editorClosed();
  ui.sort = $('sortSelect').value;
  renderList();
});

$('endedToggle').addEventListener('click', () => {
  editorClosed();
  ui.showEnded = !ui.showEnded;
  renderList();
});

// ---------- List ----------

function sortSubs(list) {
  if (ui.sort === 'name') {
    return list.toSorted((a, b) => displayName(a).localeCompare(displayName(b)));
  }
  if (ui.sort === 'next') {
    // What renews soonest first (Bobby's order); rows without an anchor sink
    // to the bottom, ranked by cost so the expensive ones still surface.
    return list.toSorted(
      (a, b) =>
        String(a.next_on ?? '9999-12-31').localeCompare(String(b.next_on ?? '9999-12-31')) ||
        b.monthly_minor - a.monthly_minor,
    );
  }
  return list.toSorted((a, b) => b.monthly_minor - a.monthly_minor);
}

function renderList() {
  const live = data.subscriptions.filter((s) => s.status !== 'ended');
  const ended = data.subscriptions.filter((s) => s.status === 'ended');
  const visible = ui.filter === 'all' ? live : live.filter((s) => s.status === ui.filter);
  // One shared scale so the bars read as a ranking across filters.
  const maxMonthly = Math.max(0, ...live.map((s) => Number(s.monthly_minor ?? 0)));

  const list = $('subList');
  list.innerHTML = '';
  $('empty').hidden = data.subscriptions.length > 0 || data.accounts.length === 0;
  for (const s of sortSubs(visible)) list.appendChild(renderSub(s, maxMonthly));
  if (visible.length === 0 && data.subscriptions.length > 0) {
    const none = document.createElement('p');
    none.className = 'muted small filter-empty';
    none.textContent =
      ui.filter === 'paused' ? 'Nothing paused right now.' : 'Nothing here — switch the filter.';
    list.appendChild(none);
  }
  // The window is honest about its edge: the list, the monthly total and the
  // 30-day runway all cover the latest slice; "Show more" grows it.
  if (listTruncated) {
    const footer = document.createElement('div');
    footer.className = 'window-footer';
    const label = document.createElement('span');
    label.textContent = `Showing your latest ${listWindow} subscriptions — totals count just these. `;
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'ghost';
    more.textContent = 'Show more';
    more.addEventListener('click', async () => {
      listWindow += 500;
      more.disabled = true;
      await refresh();
    });
    footer.append(label, more);
    list.appendChild(footer);
  }

  // Cancelled rows stay out of the way behind a disclosure, but never
  // vanish — Reactivate is the way back.
  const toggle = $('endedToggle');
  toggle.hidden = ended.length === 0;
  toggle.textContent = ui.showEnded
    ? `Hide cancelled (${ended.length})`
    : `Show cancelled (${ended.length})`;
  toggle.setAttribute('aria-expanded', String(ui.showEnded));
  const endedList = $('endedList');
  endedList.hidden = ended.length === 0 || !ui.showEnded;
  endedList.innerHTML = '';
  if (ui.showEnded) {
    for (const s of sortSubs(ended)) endedList.appendChild(renderSub(s, maxMonthly));
  }
}

function renderSub(s, maxMonthly) {
  const row = document.createElement('div');
  row.className = 'sub';
  row.dataset.status = s.status;

  row.appendChild(letterAvatar(displayName(s), { size: '2.5rem' }));

  const main = document.createElement('div');
  main.className = 'sub-main';
  const nameLine = document.createElement('span');
  nameLine.className = 'sub-name-line';
  const name = document.createElement('span');
  name.className = 'sub-name';
  name.textContent = displayName(s);
  nameLine.appendChild(name);
  if (!s.counterparty) {
    // The account is charging, but who's collecting? Mark it and point at
    // the payee picker instead of letting "Checking" pose as a service.
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'unnamed-chip';
    chip.textContent = 'unnamed — set the service';
    chip.title = 'Pick who you pay in the form above';
    chip.addEventListener('click', () => {
      const payee = $('payeeSelect');
      (payee.hidden ? $('payeeHint') : payee).scrollIntoView({ block: 'center' });
      if (!payee.hidden) payee.focus();
    });
    nameLine.appendChild(chip);
  }
  const sub = document.createElement('span');
  sub.className = 'sub-sub';
  sub.textContent =
    `${fmtMoney(s.expected_minor, s.currency)} ${s.cadence_label.toLowerCase()} · ` +
    `from ${s.account} · ≈ ${fmtMoney(s.monthly_minor * 12, s.currency)}/yr`;
  main.append(nameLine, sub);
  const editForm = s.status === 'ended' ? null : renderEditForm(s);
  if (s.status === 'active' && s.next_on) {
    const renew = document.createElement('span');
    renew.className = 'sub-renew';
    renew.textContent = renewCopy(s.next_on);
    main.appendChild(renew);
  } else if (editForm && !s.anchor_on) {
    // No anchor, no renewal date — nudge toward the editor instead of
    // pretending the cadence alone can tell you when the charge lands.
    const nudge = document.createElement('button');
    nudge.type = 'button';
    nudge.className = 'unnamed-chip';
    nudge.textContent = 'set renewal date';
    nudge.title = 'Tell the vault when this next charges';
    nudge.addEventListener('click', () => {
      editForm.hidden = false;
      activeEditor = s.series_id;
      editForm.querySelector('input[type="date"]')?.focus();
    });
    main.appendChild(nudge);
  }
  row.appendChild(main);

  const amt = document.createElement('div');
  amt.className = 'sub-amount';
  const value = document.createElement('b');
  value.textContent = fmtMoney(s.monthly_minor, s.currency);
  const per = document.createElement('span');
  per.textContent = '/mo';
  amt.append(value, per);
  if (s.status !== 'ended' && maxMonthly > 0) {
    amt.appendChild(barSpan(Number(s.monthly_minor ?? 0) / maxMonthly));
  }
  row.appendChild(amt);

  const badge = document.createElement('span');
  badge.className = 'badge';
  if (s.status === 'active') badge.classList.add('active');
  badge.textContent = s.status === 'ended' ? 'cancelled' : s.status;
  row.appendChild(badge);

  const actions = document.createElement('span');
  actions.className = 'sub-actions';
  if (editForm) {
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'ghost';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => {
      editForm.hidden = !editForm.hidden;
      if (!editForm.hidden) {
        activeEditor = s.series_id;
        editForm.querySelector('input')?.focus();
      } else {
        editorClosed();
        edit.focus();
      }
    });
    actions.appendChild(edit);
  }
  if (s.status === 'active') {
    actions.appendChild(statusBtn(s, 'paused', 'Pause'));
    actions.appendChild(cancelBtn(s));
  } else if (s.status === 'paused') {
    actions.appendChild(statusBtn(s, 'active', 'Resume'));
    actions.appendChild(cancelBtn(s));
  } else {
    actions.appendChild(statusBtn(s, 'active', 'Reactivate'));
  }
  const attach = document.createElement('button');
  attach.type = 'button';
  attach.className = 'ghost';
  attach.textContent = '＋ File';
  attach.addEventListener('click', () => {
    attachTarget = s.series_id;
    $('attachInput').click();
  });
  actions.appendChild(attach);
  row.appendChild(actions);

  const strip = document.createElement('div');
  strip.className = 'attach-strip';
  renderAttachments(strip, s.attachments, removeAttachment);
  row.appendChild(strip);
  if (editForm) row.appendChild(editForm);
  return row;
}

// ---------- Inline row editor (price / cadence / anchor date) ----------

// Prefill helper: an rrule the form can express round-trips into the cadence
// controls; anything exotic keeps a "leave as is" first option so a partial
// update never mangles a cadence the UI can't spell.
function cadenceControls(s) {
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Cadence');
  const custom = document.createElement('span');
  custom.className = 'row-form-interval';
  const n = document.createElement('input');
  n.type = 'number';
  n.min = '1';
  n.max = '99';
  n.step = '1';
  n.value = '3';
  n.className = 'interval-in';
  n.setAttribute('aria-label', 'Number of weeks or months between charges');
  const unit = document.createElement('select');
  unit.setAttribute('aria-label', 'Weeks or months');
  for (const [value, label] of [
    ['FREQ=WEEKLY', 'weeks'],
    ['FREQ=MONTHLY', 'months'],
  ]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    unit.appendChild(opt);
  }
  unit.value = 'FREQ=MONTHLY';
  custom.append(n, unit);

  const parsed = /^FREQ=(WEEKLY|MONTHLY|YEARLY)(?:;INTERVAL=(\d+))?$/.exec(String(s.rrule ?? ''));
  const interval = Number(parsed?.[2] ?? 1);
  const options = [];
  if (!parsed) options.push(['', `Keep: ${s.cadence_label.toLowerCase()}`]);
  options.push(
    ['FREQ=MONTHLY', 'Monthly'],
    ['FREQ=WEEKLY', 'Weekly'],
    ['FREQ=YEARLY', 'Yearly'],
    ['custom', 'Every N weeks / months…'],
  );
  for (const [value, label] of options) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
  }
  if (!parsed) {
    select.value = '';
  } else if (interval > 1 && parsed[1] !== 'YEARLY') {
    select.value = 'custom';
    n.value = String(interval);
    unit.value = `FREQ=${parsed[1]}`;
  } else {
    select.value = `FREQ=${parsed[1]}`;
  }
  custom.hidden = select.value !== 'custom';
  select.addEventListener('change', () => {
    custom.hidden = select.value !== 'custom';
  });

  return {
    select,
    custom,
    /** The chosen rrule; null while the custom interval is invalid, '' for keep. */
    value() {
      if (select.value !== 'custom') return select.value;
      const count = Math.round(Number(n.value));
      if (!Number.isFinite(count) || count < 1) return null;
      return count === 1 ? unit.value : `${unit.value};INTERVAL=${count}`;
    },
  };
}

// The row's inline editor — same partial-update contract as the vault
// command: only the fields that changed travel. Non-destructive, so no
// armed confirm; a toast closes the loop.
function renderEditForm(s) {
  const form = document.createElement('form');
  form.className = 'row-form';
  form.autocomplete = 'off';
  form.hidden = true;

  const amount = document.createElement('input');
  amount.type = 'number';
  amount.min = '0';
  amount.step = '0.01';
  amount.inputMode = 'decimal';
  amount.value = (Number(s.expected_minor ?? 0) / 100).toFixed(2);
  amount.className = 'amount-in';
  amount.setAttribute('aria-label', 'Amount per charge');

  const cadence = cadenceControls(s);

  const anchor = document.createElement('input');
  anchor.type = 'date';
  anchor.value = s.anchor_on ?? '';
  anchor.setAttribute('aria-label', 'Next charge date');

  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'primary small-btn';
  save.textContent = 'Save';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ghost';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => {
    form.hidden = true;
    editorClosed();
  });

  form.append(amount, cadence.select, cadence.custom, anchor, save, cancel);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = { series_id: s.series_id };
    if (amount.value.trim() !== '') {
      const value = parseFloat(amount.value);
      if (!Number.isFinite(value) || value <= 0) {
        notice('Enter an amount above zero.');
        return;
      }
      const minor = Math.round(value * 100);
      if (minor !== s.expected_minor) input.expected_minor = minor;
    }
    const rrule = cadence.value();
    if (rrule === null) {
      notice('Enter how many weeks or months between charges.');
      return;
    }
    if (rrule && rrule !== s.rrule) input.rrule = rrule;
    if (anchor.value && anchor.value !== (s.anchor_on ?? '')) input.anchor_on = anchor.value;
    if (Object.keys(input).length === 1) {
      form.hidden = true;
      editorClosed();
      return;
    }
    activeEditor = null;
    const outcome = await act('update-subscription', input);
    if (narrate(outcome)) {
      toast(`Updated ${displayName(s)}`);
      await refresh();
    }
  });
  return form;
}

function statusBtn(s, status, label) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost';
  btn.textContent = label;
  btn.addEventListener('click', async () => {
    const outcome = await act('set-status', { series_id: s.series_id, status });
    if (!narrate(outcome)) return;
    await refresh();
    if (status === 'active' && s.status === 'ended') {
      toast(`Reactivated ${displayName(s)}`);
    }
  });
  return btn;
}

function cancelBtn(s) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost danger';
  btn.textContent = 'Cancel';
  btn.addEventListener('click', async () => {
    if (!armConfirm(btn, { armedLabel: `Cancel ${displayName(s)}?` })) return;
    const outcome = await act('set-status', { series_id: s.series_id, status: 'ended' });
    if (!narrate(outcome)) return;
    await refresh();
    toast(`Cancelled ${displayName(s)}`, {
      undoLabel: 'Undo',
      onUndo: async () => {
        const undone = await act('set-status', { series_id: s.series_id, status: 'active' });
        if (narrate(undone)) await refresh();
      },
    });
  });
  return btn;
}

// ---------- Add form ----------

$('cadenceSelect').addEventListener('change', () => {
  $('customCadence').hidden = $('cadenceSelect').value !== 'custom';
});

function chosenRrule() {
  const value = $('cadenceSelect').value;
  if (value !== 'custom') return value;
  const n = Math.round(Number($('intervalInput').value));
  if (!Number.isFinite(n) || n < 1) return null;
  const freq = $('intervalUnit').value; // FREQ=WEEKLY | FREQ=MONTHLY
  return n === 1 ? freq : `${freq};INTERVAL=${n}`;
}

$('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const account_id = $('accountSelect').value;
  const amount = parseFloat($('amountInput').value);
  const payee = $('payeeSelect').value;
  const anchor = $('anchorInput').value;
  const rrule = chosenRrule();
  if (!account_id || !Number.isFinite(amount) || amount <= 0) {
    notice('Pick an account and enter an amount.');
    return;
  }
  if (!rrule) {
    notice('Enter how many weeks or months between charges.');
    return;
  }
  const outcome = await act('add-subscription', {
    account_id,
    expected_minor: Math.round(amount * 100),
    rrule,
    ...(anchor ? { anchor_on: anchor } : {}),
    ...(payee ? { counterparty_party_id: payee } : {}),
  });
  if (narrate(outcome)) {
    $('amountInput').value = '';
    $('anchorInput').value = localDayKey(new Date());
    toast('Subscription added');
    await refresh();
  }
});

// The first/next charge date defaults to today — the honest guess for a
// charge you're adding the day you notice it; edit it for anything else.
$('anchorInput').value = localDayKey(new Date());
window.addEventListener('focus', refresh);
showSkeleton($('subList'), 4);
refresh();
