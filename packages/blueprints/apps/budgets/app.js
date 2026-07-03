// Budgets — a pure projection over the personal vault. Every row rendered
// here lives in core.transaction / core.account / finance.budget; every
// mutation is a typed vault command routed through this app's handlers
// (ctx.vault on the gateway side) — and every one of them is classification
// only: no command can touch an amount. The app's own data.sqlite stays
// empty by design: revoke the grant and this page goes dark while the
// ledger, history and receipts remain the owner's.

const $ = (id) => document.getElementById(id);

// The spend categories this view budgets against — concepts are matched by
// notation, so the ids stay the vault's own.
const CATEGORY_NOTATIONS = ['groceries', 'dining', 'transport', 'gifts'];

let categories = []; // spend-category concept rows
let conceptLabels = new Map(); // concept_id → pref_label (all concepts)
let defaultCurrency = 'USD';
let transactions = []; // the same rows the txn list renders — rings reuse them

function fmtMoney(amountMinor, currency) {
  const n = Number(amountMinor ?? 0);
  return `${(n / 100).toFixed(2)} ${currency ?? ''}`.trim();
}

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return String(iso).slice(0, 10);
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

// The transaction a receipt button will pin the next file onto. One hidden
// file input is shared across the ledger; the button sets this.
let attachTarget = null;

async function removeAttachment(attachmentId) {
  const outcome = await act('detach', { attachment_id: attachmentId });
  if (narrate(outcome) || outcome?.status === 'denied') await refresh();
}

async function refresh() {
  let data;
  try {
    data = await window.centraid.read({ query: 'overview' });
  } catch {
    return; // transient; the change feed retries
  }
  const denied = data?.vaultDenied;
  $('consentBanner').hidden = !denied;
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    $('budgetForm').hidden = true;
    $('budgetList').innerHTML = '';
    $('txnList').innerHTML = '';
    $('emptyBudgets').hidden = true;
    $('emptyTxns').hidden = true;
    return;
  }
  const concepts = data?.concepts ?? [];
  conceptLabels = new Map(concepts.map((c) => [c.concept_id, c.pref_label]));
  categories = concepts.filter((c) => CATEGORY_NOTATIONS.includes(c.notation));
  defaultCurrency = data?.accounts?.[0]?.currency ?? 'USD';
  transactions = data?.transactions ?? [];
  renderCategories();
  renderBudgets(data?.budgets ?? []);
  renderTransactions(transactions);
}

// Spent this month per category: posted/pending debits only — the ring
// compares like with like (a month budget against the month's outflow).
function spentThisMonth(categoryConceptId) {
  const month = new Date().toISOString().slice(0, 7);
  let sum = 0;
  for (const t of transactions) {
    if (t.category_concept_id !== categoryConceptId) continue;
    if (t.direction !== 'debit' || t.status === 'void') continue;
    if (String(t.posted_at).slice(0, 7) !== month) continue;
    sum += Number(t.amount_minor ?? 0);
  }
  return sum;
}

/** An SVG donut: full circle track + a dash-length arc for the ratio. */
function ringSvg(ratio) {
  const shown = Math.min(ratio, 1);
  const level = ratio >= 1 ? 'over' : ratio >= 0.8 ? 'near' : 'ok';
  // r chosen so the circumference is exactly 100 — dasharray reads as %.
  return (
    `<svg viewBox="0 0 36 36" class="ring" data-level="${level}" role="img" aria-label="${Math.round(ratio * 100)}% of budget spent">` +
    `<circle class="ring-track" cx="18" cy="18" r="15.9155"></circle>` +
    `<circle class="ring-arc" cx="18" cy="18" r="15.9155" stroke-dasharray="${(shown * 100).toFixed(1)} 100"></circle>` +
    `<text x="18" y="21" class="ring-text">${Math.round(ratio * 100)}%</text>` +
    `</svg>`
  );
}

function renderCategories() {
  const select = $('categorySelect');
  select.innerHTML = '';
  for (const c of categories) {
    const opt = document.createElement('option');
    opt.value = c.concept_id;
    opt.textContent = c.pref_label ?? c.notation;
    select.appendChild(opt);
  }
  $('budgetForm').hidden = categories.length === 0;
}

function renderBudgets(budgets) {
  const list = $('budgetList');
  list.innerHTML = '';
  $('emptyBudgets').hidden = budgets.length > 0;
  for (const b of budgets) {
    const spent = spentThisMonth(b.category_concept_id);
    const limit = Number(b.limit_minor ?? 0);
    const ratio = limit > 0 ? spent / limit : 0;
    const row = document.createElement('div');
    row.className = 'row budget-row';
    const ring = document.createElement('span');
    ring.className = 'ring-wrap';
    ring.innerHTML = ringSvg(ratio);
    const text = document.createElement('span');
    text.className = 'row-text';
    const label = document.createElement('span');
    label.textContent = conceptLabels.get(b.category_concept_id) ?? b.category_concept_id;
    const detail = document.createElement('span');
    detail.className = 'muted small budget-detail';
    detail.textContent = `${fmtMoney(spent, b.currency)} of ${fmtMoney(b.limit_minor, b.currency)} this ${b.period}`;
    text.append(label, detail);
    const amount = document.createElement('span');
    amount.className = 'amount';
    amount.textContent =
      spent > limit ? `${fmtMoney(spent - limit, b.currency)} over` : fmtMoney(limit - spent, b.currency) + ' left';
    if (spent > limit) amount.classList.add('over');
    row.append(ring, text, amount);
    list.appendChild(row);
  }
}

function renderTransactions(txns) {
  const list = $('txnList');
  list.innerHTML = '';
  $('emptyTxns').hidden = txns.length > 0;
  for (const t of txns) {
    list.appendChild(renderTxnRow(t));
  }
}

function renderTxnRow(t) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.status = t.status;

  const date = document.createElement('span');
  date.className = 'row-time';
  date.textContent = fmtDate(t.posted_at);

  const text = document.createElement('span');
  text.className = 'row-text';
  text.textContent = t.description ?? t.counterparty_party_id ?? '(no description)';

  const amount = document.createElement('span');
  amount.className = 'amount';
  amount.textContent = fmtMoney(t.amount_minor, t.currency);

  const select = document.createElement('select');
  select.className = 'category';
  select.setAttribute('aria-label', 'Category');
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = 'Uncategorized';
  select.appendChild(blank);
  for (const c of categories) {
    const opt = document.createElement('option');
    opt.value = c.concept_id;
    opt.textContent = c.pref_label ?? c.notation;
    select.appendChild(opt);
  }
  select.value = categories.some((c) => c.concept_id === t.category_concept_id)
    ? t.category_concept_id
    : '';
  select.addEventListener('change', async () => {
    if (!select.value) return;
    let outcome;
    try {
      outcome = await window.centraid.write({
        action: 'categorize',
        input: { txn_id: t.txn_id, category_concept_id: select.value },
      });
    } catch (err) {
      notice(String(err?.message ?? err));
      return;
    }
    if (narrate(outcome)) await refresh();
    else if (outcome?.status === 'denied') await refresh();
  });

  const receipt = document.createElement('button');
  receipt.type = 'button';
  receipt.className = 'flag';
  receipt.textContent = 'receipt';
  receipt.title = 'Snap a receipt onto this transaction';
  receipt.addEventListener('click', () => {
    attachTarget = t.txn_id;
    $('attachInput').click();
  });

  const flag = document.createElement('button');
  flag.type = 'button';
  flag.className = 'flag';
  flag.textContent = 'flag';
  flag.title = 'Flag as anomalous';
  flag.addEventListener('click', async () => {
    let outcome;
    try {
      outcome = await window.centraid.write({
        action: 'flag',
        input: { txn_id: t.txn_id, reason: 'Flagged by the owner from the Budgets app' },
      });
    } catch (err) {
      notice(String(err?.message ?? err));
      return;
    }
    if (narrate(outcome)) {
      notice('Flagged — the anomaly tag and its reason now live in the vault.');
      await refresh();
    } else if (outcome?.status === 'denied') {
      await refresh();
    }
  });

  row.append(date, text, amount, select, receipt, flag);

  // Any receipts render as a strip beneath the row; the row and its strip
  // travel together in a fragment so the ledger's append logic stays flat.
  if (t.attachments?.length) {
    const frag = document.createDocumentFragment();
    frag.appendChild(row);
    const strip = document.createElement('div');
    strip.className = 'attach-strip row-attachments';
    renderAttachments(strip, t.attachments, removeAttachment);
    frag.appendChild(strip);
    return frag;
  }
  return row;
}

$('budgetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const category_concept_id = $('categorySelect').value;
  const amount = Number($('amountInput').value);
  if (!category_concept_id || !Number.isFinite(amount) || amount < 0) return;
  const starts_on = `${new Date().toISOString().slice(0, 7)}-01`;
  let outcome;
  try {
    outcome = await window.centraid.write({
      action: 'set-budget',
      input: {
        category_concept_id,
        period: 'month',
        limit_minor: Math.round(amount * 100),
        currency: defaultCurrency,
        starts_on,
      },
    });
  } catch (err) {
    notice(String(err?.message ?? err));
    return;
  }
  if (narrate(outcome)) {
    $('amountInput').value = '';
    await refresh();
  } else if (outcome?.status === 'denied') {
    await refresh();
  }
});

// One hidden file input serves the whole ledger; a row's receipt button sets
// attachTarget just before triggering it.
wireAttachInput($('attachInput'), () => attachTarget);

window.addEventListener('focus', refresh);
refresh();
