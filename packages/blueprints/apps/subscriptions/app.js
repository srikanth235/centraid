// Subscriptions — money that repeats, as a projection over the personal
// vault. Each row is a finance.recurring_series charging one of your
// accounts; the app normalizes every cadence to a monthly figure so the
// running total is honest, and frames the yearly cost beside it because
// that's the number that makes people cancel. Adding, pausing, cancelling
// and reactivating run through typed finance commands (all risk low); files
// attach per subscription. The app stores nothing — revoke the grant and
// this page goes dark while the series, history and receipts remain the
// owner's.
//
// Deliberately skipped: renewal dates ("renews in N days", an upcoming
// view). finance.recurring_series stores a cadence but no anchor date, so
// there is nothing truthful to project until the vault schema grows one.

import {
  armConfirm,
  barSpan,
  fmtMoney,
  letterAvatar,
  outcomeMessage,
  readFailed,
  showSkeleton,
  toast,
} from './kit.js';

const $ = (id) => document.getElementById(id);

let data = { subscriptions: [], monthly_active_minor: 0, accounts: [], parties: [] };
let attachTarget = null; // series_id the shared file input attaches to
const ui = { filter: 'active', sort: 'cost', showEnded: false };

// A row without a payee party falls back to the charging account's name —
// useful, but "Checking" must never masquerade as a service.
const displayName = (s) => s.counterparty ?? s.account;

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

let readBroken = false;

async function refresh() {
  let next;
  try {
    next = await window.centraid.read({ query: 'list' });
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
  renderTotal();
  renderAddForm();
  renderToolbar();
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
    ui.filter = pill.dataset.filter;
    renderToolbar();
    renderList();
  });
}

$('sortSelect').addEventListener('change', () => {
  ui.sort = $('sortSelect').value;
  renderList();
});

$('endedToggle').addEventListener('click', () => {
  ui.showEnded = !ui.showEnded;
  renderList();
});

// ---------- List ----------

function sortSubs(list) {
  return ui.sort === 'name'
    ? list.toSorted((a, b) => displayName(a).localeCompare(displayName(b)))
    : list.toSorted((a, b) => b.monthly_minor - a.monthly_minor);
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
  return row;
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
    ...(payee ? { counterparty_party_id: payee } : {}),
  });
  if (narrate(outcome)) {
    $('amountInput').value = '';
    toast('Subscription added');
    await refresh();
  }
});

window.addEventListener('focus', refresh);
showSkeleton($('subList'), 4);
refresh();
