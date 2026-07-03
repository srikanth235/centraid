// Subscriptions — money that repeats, as a projection over the personal
// vault. Each row is a finance.recurring_series charging one of your
// accounts; the app normalizes every cadence to a monthly figure so the
// running total is honest. Adding, pausing and cancelling run through typed
// finance commands (all risk low); files attach per subscription. The app
// stores nothing — revoke the grant and this page goes dark while the
// series, history and receipts remain the owner's.

const $ = (id) => document.getElementById(id);

const CADENCE_LABEL = {
  'FREQ=WEEKLY': 'Weekly',
  'FREQ=MONTHLY': 'Monthly',
  'FREQ=YEARLY': 'Yearly',
};

let data = { subscriptions: [], monthly_active_minor: 0, accounts: [], parties: [] };
let attachTarget = null; // series_id the shared file input attaches to

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
  if (outcome?.status === 'parked') {
    notice('Sent to the owner for confirmation — it lands once approved.');
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

function fmtMoney(minor, currency) {
  const value = (minor ?? 0) / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency ?? ''}`.trim();
  }
}

// ---------- Render ----------

async function refresh() {
  let next;
  try {
    next = await window.centraid.read({ query: 'list' });
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
  renderTotal();
  renderAddForm();
  renderList();
}

function renderTotal() {
  const active = data.subscriptions.filter((s) => s.status === 'active');
  const card = $('totalCard');
  card.hidden = active.length === 0;
  if (active.length === 0) return;
  // Minor units in different currencies don't add — total per currency.
  const byCurrency = new Map();
  for (const s of active) {
    const currency = s.currency || data.accounts[0]?.currency || 'USD';
    byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + Number(s.monthly_minor ?? 0));
  }
  $('totalValue').textContent = [...byCurrency.entries()]
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
  fillSelect(
    $('payeeSelect'),
    data.parties.map((p) => ({ value: p.party_id, label: p.display_name })),
    'Paid to… (optional)',
  );
}

function renderList() {
  const list = $('subList');
  list.innerHTML = '';
  $('empty').hidden = data.subscriptions.length > 0 || data.accounts.length === 0;
  for (const s of data.subscriptions) {
    list.appendChild(renderSub(s));
  }
}

function renderSub(s) {
  const row = document.createElement('div');
  row.className = 'sub';
  row.dataset.status = s.status;

  const main = document.createElement('div');
  main.className = 'sub-main';
  const name = document.createElement('span');
  name.className = 'sub-name';
  name.textContent = s.counterparty ?? s.account;
  const sub = document.createElement('span');
  sub.className = 'sub-sub';
  sub.textContent = `${fmtMoney(s.expected_minor, s.currency)} · ${s.cadence_label} · ${s.account}`;
  main.append(name, sub);
  row.appendChild(main);

  const amt = document.createElement('div');
  amt.className = 'sub-amount';
  amt.innerHTML = `<b>${fmtMoney(s.monthly_minor, s.currency)}</b><span>/mo</span>`;
  row.appendChild(amt);

  const badge = document.createElement('span');
  badge.className = 'badge';
  if (s.status === 'active') badge.classList.add('active');
  badge.textContent = s.status;
  row.appendChild(badge);

  const actions = document.createElement('span');
  actions.className = 'sub-actions';
  if (s.status === 'active') {
    actions.appendChild(statusBtn(s, 'paused', 'Pause'));
    actions.appendChild(statusBtn(s, 'ended', 'Cancel', true));
  } else if (s.status === 'paused') {
    actions.appendChild(statusBtn(s, 'active', 'Resume'));
    actions.appendChild(statusBtn(s, 'ended', 'Cancel', true));
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

function statusBtn(s, status, label, danger) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = danger ? 'ghost danger' : 'ghost';
  btn.textContent = label;
  btn.addEventListener('click', async () => {
    const outcome = await act('set-status', { series_id: s.series_id, status });
    if (narrate(outcome)) await refresh();
  });
  return btn;
}

// ---------- Add form ----------

$('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const account_id = $('accountSelect').value;
  const amount = parseFloat($('amountInput').value);
  const rrule = $('cadenceSelect').value;
  const payee = $('payeeSelect').value;
  if (!account_id || !Number.isFinite(amount) || amount <= 0) {
    notice('Pick an account and enter an amount.');
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
    await refresh();
  }
});

window.addEventListener('focus', refresh);
refresh();
