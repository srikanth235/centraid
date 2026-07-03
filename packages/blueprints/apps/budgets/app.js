// governance: allow-repo-hygiene file-size-limit blueprints are single-file by design (read wholesale by one agent); Budgets is a finished product — month navigation, summary math, filters, drill-down, bulk categorize, budget editing — and splitting it would break that "one file" contract.
// Budgets — a pure projection over the personal vault. Every row rendered
// here lives in core.transaction / core.account / finance.budget; every
// mutation is a typed vault command routed through this app's handlers
// (ctx.vault on the gateway side) — and every one of them is classification
// only: no command can touch an amount. The app's own data.sqlite stays
// empty by design: revoke the grant and this page goes dark while the
// ledger, history and receipts remain the owner's.

import {
  barChart,
  barSpan,
  debounce,
  fmtMoney,
  localDayKey,
  localMonthKey,
  outcomeMessage,
  readFailed,
  showSkeleton,
  toast,
} from './kit.js';

const $ = (id) => document.getElementById(id);

// ---------- State ----------

/** Transactions merged across every fetch, keyed by txn_id. */
const pool = new Map();
let categories = []; // spend-category concepts, derived by the query
let conceptLabels = new Map(); // concept_id → pref_label (all concepts)
let budgets = [];
let defaultCurrency = 'USD';
let baseTruncated = false; // the recent-window fetch hit its cap
let baseWindowStart = null; // 'YYYY-MM' the recent window reaches back to
let baseLimit = 1000;
const fetchedMonths = new Map(); // 'YYYY-MM' → { truncated, limit }
let selectedMonth = localMonthKey(new Date());
let searchText = '';
let filterCategory = null; // concept_id | 'uncategorized' | null
const selection = new Set(); // txn_ids checked for bulk categorize
const flaggedThisSession = new Set(); // txns flagged since load (aria-pressed)
let hasRendered = false;

const prefersReducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

// ---------- Month + money helpers ----------

// Months are the viewer's local months — a Jan 31 11pm purchase belongs to
// January, not to the UTC February its ISO string may start with. Date-only
// strings (budget starts_on) are taken verbatim, not routed through the
// Date parser's UTC-midnight trap.
function monthKeyOf(iso) {
  const s = String(iso ?? '');
  if (!s.includes('T')) return s.slice(0, 7);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s.slice(0, 7) : localMonthKey(d);
}

function monthShift(key, delta) {
  const [y, m] = key.split('-').map(Number);
  return localMonthKey(new Date(y, m - 1 + delta, 1));
}

function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function shortMonthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short' });
}

const isTransfer = (t) => Boolean(t.transfer_group_id);
const countable = (t) => t.status !== 'void' && !isTransfer(t);
const isSpend = (t) => countable(t) && t.direction === 'debit';
const isIncome = (t) => countable(t) && t.direction === 'credit';
const amountOf = (t) => Number(t.amount_minor ?? 0);

const knownCategory = (t) =>
  t.category_concept_id != null && categories.some((c) => c.concept_id === t.category_concept_id);
const needsCategory = (t) => countable(t) && !knownCategory(t);

// counterparty_party_id is a party UUID this app has no read scope for —
// never render it raw.
function payeeText(t) {
  const desc = String(t.description ?? '').trim();
  if (desc) return desc;
  return t.counterparty_party_id ? 'Unknown payee' : '(no description)';
}

function monthTxns(m) {
  return [...pool.values()]
    .filter((t) => monthKeyOf(t.posted_at) === m)
    .toSorted((a, b) => String(b.posted_at).localeCompare(String(a.posted_at)));
}

function notice(text) {
  const el = $('noticeBanner');
  el.textContent = text;
  el.hidden = !text;
}

// ---------- Actions ----------

async function act(action, input) {
  try {
    return await window.centraid.write({ action, input });
  } catch (err) {
    toast(String(err?.message ?? err));
    return undefined;
  }
}

/** True when the outcome executed; otherwise narrate it as a toast. */
function narrateOutcome(outcome) {
  if (outcome?.status === 'executed') return true;
  const msg = outcomeMessage(outcome);
  if (msg) toast(msg);
  return false;
}

// ---------- Data loading ----------

function ingest(data) {
  for (const t of data?.transactions ?? []) pool.set(t.txn_id, t);
  if (data?.budgets) budgets = data.budgets;
  const concepts = data?.concepts ?? [];
  if (concepts.length > 0) {
    conceptLabels = new Map(concepts.map((c) => [c.concept_id, c.pref_label]));
  }
  if (data?.categories) categories = data.categories;
  defaultCurrency = data?.accounts?.[0]?.currency ?? defaultCurrency;
}

function renderDenied(denied) {
  $('consentBanner').hidden = !denied;
  if (!denied) return;
  $('consentDetail').textContent = denied.message ?? '';
  for (const id of [
    'summaryCard',
    'chartsSection',
    'budgetForm',
    'bulkBar',
    'emptyBudgets',
    'emptyTxns',
    'truncNote',
  ]) {
    $(id).hidden = true;
  }
  $('budgetList').innerHTML = '';
  $('txnList').innerHTML = '';
}

async function loadBase({ quiet = false } = {}) {
  let data;
  try {
    data = await window.centraid.read({ query: 'overview' });
  } catch {
    if (!quiet || !hasRendered) readFailed($('noticeBanner'));
    if (!hasRendered) {
      $('budgetList').innerHTML = '';
      $('txnList').innerHTML = '';
    }
    return false;
  }
  if (data?.vaultDenied) {
    renderDenied(data.vaultDenied);
    return false;
  }
  renderDenied(null);
  notice('');
  ingest(data);
  baseTruncated = Boolean(data.truncated);
  baseWindowStart = data.windowStart ?? monthShift(localMonthKey(new Date()), -5);
  baseLimit = Number(data.limit ?? baseLimit);
  return true;
}

/** Make sure the pool can answer for a month; fetch it when it can't. */
async function ensureMonth(m) {
  const coveredByBase =
    !baseTruncated &&
    baseWindowStart != null &&
    m >= baseWindowStart &&
    m <= localMonthKey(new Date());
  if (fetchedMonths.has(m) || coveredByBase) return;
  const data = await window.centraid.read({ query: 'overview', input: { month: m } });
  if (data?.vaultDenied) {
    renderDenied(data.vaultDenied);
    return;
  }
  ingest(data);
  fetchedMonths.set(m, { truncated: Boolean(data.truncated), limit: Number(data.limit ?? 500) });
}

/** Re-pull the base window (and the selected month, if month-fetched). */
async function refresh({ quiet = true } = {}) {
  const ok = await loadBase({ quiet });
  if (ok && fetchedMonths.has(selectedMonth)) {
    fetchedMonths.delete(selectedMonth);
    try {
      await ensureMonth(selectedMonth);
    } catch {
      readFailed($('noticeBanner'));
    }
  }
  if (ok || hasRendered) render();
}

async function selectMonth(m) {
  selectedMonth = m;
  selection.clear();
  renderMonthNav();
  showSkeleton($('txnList'), 4);
  try {
    await ensureMonth(m);
  } catch {
    readFailed($('noticeBanner'));
  }
  render();
}

// ---------- Rendering ----------

function render() {
  hasRendered = true;
  const txns = monthTxns(selectedMonth);
  renderMonthNav();
  renderSummary(txns);
  renderBudgets(txns);
  renderCharts(txns);
  renderChips(txns);
  renderLedger(txns);
  renderBulkBar();
  renderTruncation();
  renderBudgetForm();
}

function renderMonthNav() {
  $('monthLabel').textContent = monthLabel(selectedMonth);
  $('nextMonth').disabled = selectedMonth >= localMonthKey(new Date());
}

/** Budgets whose start month has arrived by the selected month. */
function applicableBudgets() {
  return budgets.filter((b) => {
    const start = b.starts_on ? monthKeyOf(b.starts_on) : null;
    return !start || start <= selectedMonth;
  });
}

function spendByCategory(txns) {
  const byCat = new Map(); // concept_id | '' (uncategorized) → minor units
  for (const t of txns) {
    if (!isSpend(t)) continue;
    const key = knownCategory(t) ? t.category_concept_id : '';
    byCat.set(key, (byCat.get(key) ?? 0) + amountOf(t));
  }
  return byCat;
}

function renderSummary(txns) {
  const card = $('summaryCard');
  const byCat = spendByCategory(txns);
  let totalSpent = 0;
  let income = 0;
  for (const t of txns) {
    if (isSpend(t)) totalSpent += amountOf(t);
    else if (isIncome(t)) income += amountOf(t);
  }
  const monthly = applicableBudgets().filter((b) => b.period === 'month');
  const budgeted = monthly.reduce((sum, b) => sum + Number(b.limit_minor ?? 0), 0);
  const spentInBudgeted = monthly.reduce(
    (sum, b) => sum + (byCat.get(b.category_concept_id) ?? 0),
    0,
  );
  const left = budgeted - spentInBudgeted;
  const anyOver = monthly.some(
    (b) => (byCat.get(b.category_concept_id) ?? 0) > Number(b.limit_minor ?? 0),
  );
  card.hidden = budgets.length === 0 && txns.length === 0;
  const currency = monthly[0]?.currency ?? defaultCurrency;
  const leftEl = $('summaryLeft');
  leftEl.textContent = fmtMoney(left, currency);
  leftEl.classList.toggle('over', anyOver || left < 0);
  $('statBudgeted').textContent = fmtMoney(budgeted, currency);
  $('statSpent').textContent = fmtMoney(totalSpent, currency);
  $('statIncome').textContent = `+${fmtMoney(income, currency)}`;
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

function categoryLabel(conceptId) {
  return conceptLabels.get(conceptId) ?? 'Unknown category';
}

function renderBudgets(txns) {
  const list = $('budgetList');
  list.innerHTML = '';
  const rows = applicableBudgets();
  $('emptyBudgets').hidden = rows.length > 0;
  const byCat = spendByCategory(txns);
  for (const b of rows) {
    const spent = byCat.get(b.category_concept_id) ?? 0;
    const limit = Number(b.limit_minor ?? 0);
    const ratio = limit > 0 ? spent / limit : 0;
    const row = document.createElement('div');
    row.className = 'row budget-row';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute(
      'aria-label',
      `Show ${categoryLabel(b.category_concept_id)} transactions this month`,
    );
    const ring = document.createElement('span');
    ring.className = 'ring-wrap';
    ring.innerHTML = ringSvg(ratio);
    const text = document.createElement('span');
    text.className = 'row-text';
    const label = document.createElement('span');
    label.textContent = categoryLabel(b.category_concept_id);
    const bar = barSpan(ratio);
    bar.classList.add('budget-bar');
    if (ratio >= 1) bar.dataset.level = 'over';
    else if (ratio >= 0.8) bar.dataset.level = 'near';
    const detail = document.createElement('span');
    detail.className = 'muted small budget-detail';
    detail.textContent = `${fmtMoney(spent, b.currency)} of ${fmtMoney(b.limit_minor, b.currency)} this ${b.period}`;
    text.append(label, bar, detail);
    const amount = document.createElement('button');
    amount.type = 'button';
    amount.className = 'amount edit-budget';
    amount.textContent =
      spent > limit
        ? `${fmtMoney(spent - limit, b.currency)} over`
        : `${fmtMoney(limit - spent, b.currency)} left`;
    if (spent > limit) amount.classList.add('over');
    amount.title = 'Edit this budget';
    amount.setAttribute(
      'aria-label',
      `Edit the ${categoryLabel(b.category_concept_id)} budget, currently ${fmtMoney(limit, b.currency)}`,
    );
    amount.addEventListener('click', (e) => {
      e.stopPropagation();
      startBudgetEdit(b);
    });
    const drill = () => setCategoryFilter(b.category_concept_id, { scroll: true });
    row.addEventListener('click', drill);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        drill();
      }
    });
    row.append(ring, text, amount);
    list.appendChild(row);
  }
}

function renderCharts(txns) {
  const section = $('chartsSection');
  const trend = $('trendChart');
  trend.innerHTML = '';
  // Six local months ending at the selected one, totalled from every
  // transaction loaded so far (base window + any month fetches).
  const months = [];
  for (let i = 5; i >= 0; i -= 1) months.push(monthShift(selectedMonth, -i));
  const totals = months.map((m) => ({
    label: shortMonthLabel(m),
    value: monthTxns(m).reduce((sum, t) => (isSpend(t) ? sum + amountOf(t) : sum), 0) / 100,
  }));
  const anyTrend = totals.some((t) => t.value > 0);
  if (anyTrend) {
    trend.appendChild(barChart(totals, { label: 'Spending by month, last 6 months' }));
  }

  const breakdown = $('breakdownList');
  breakdown.innerHTML = '';
  const byCat = spendByCategory(txns);
  const entries = [...byCat.entries()].toSorted((a, b) => b[1] - a[1]);
  const max = entries[0]?.[1] ?? 0;
  for (const [catId, spent] of entries) {
    const rowBtn = document.createElement('button');
    rowBtn.type = 'button';
    rowBtn.className = 'bd-row';
    const name = catId === '' ? 'Uncategorized' : categoryLabel(catId);
    rowBtn.setAttribute('aria-label', `Show ${name} transactions`);
    const label = document.createElement('span');
    label.className = 'bd-label';
    label.textContent = name;
    const bar = barSpan(max > 0 ? spent / max : 0);
    const amount = document.createElement('span');
    amount.className = 'amount';
    amount.textContent = fmtMoney(spent, defaultCurrency);
    rowBtn.append(label, bar, amount);
    rowBtn.addEventListener('click', () =>
      setCategoryFilter(catId === '' ? 'uncategorized' : catId, { scroll: true }),
    );
    breakdown.appendChild(rowBtn);
  }
  $('breakdownLabel').hidden = entries.length === 0;
  section.hidden = !anyTrend && entries.length === 0;
}

function setCategoryFilter(value, { scroll = false } = {}) {
  filterCategory = filterCategory === value ? null : value;
  render();
  if (scroll && filterCategory != null) {
    $('txnSection').scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }
}

function renderChips(txns) {
  const host = $('categoryChips');
  host.innerHTML = '';
  const counts = new Map();
  let uncategorized = 0;
  for (const t of txns) {
    if (knownCategory(t)) {
      counts.set(t.category_concept_id, (counts.get(t.category_concept_id) ?? 0) + 1);
    } else if (needsCategory(t)) {
      uncategorized += 1;
    }
  }
  const addChip = (value, text) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    const active = filterCategory === value;
    chip.setAttribute('aria-pressed', String(active));
    chip.textContent = active ? `${text} ×` : text;
    chip.addEventListener('click', () => setCategoryFilter(value));
    host.appendChild(chip);
  };
  // The review queue first: what still needs a category.
  if (uncategorized > 0 || filterCategory === 'uncategorized') {
    addChip('uncategorized', `Uncategorized (${uncategorized})`);
  }
  for (const c of categories) {
    const n = counts.get(c.concept_id) ?? 0;
    if (n === 0 && filterCategory !== c.concept_id) continue;
    addChip(c.concept_id, `${c.pref_label ?? c.notation} (${n})`);
  }
}

function filteredTxns(txns) {
  let rows = txns;
  if (filterCategory === 'uncategorized') rows = rows.filter(needsCategory);
  else if (filterCategory) rows = rows.filter((t) => t.category_concept_id === filterCategory);
  if (searchText) {
    const q = searchText.toLowerCase();
    rows = rows.filter((t) => payeeText(t).toLowerCase().includes(q));
  }
  return rows;
}

function dayLabelOf(key) {
  const today = localDayKey(new Date());
  if (key === today) return 'Today';
  if (key === localDayKey(new Date(Date.now() - 86_400_000))) return 'Yesterday';
  const [y, m, d] = key.split('-').map(Number);
  const opts = { month: 'short', day: 'numeric' };
  if (y !== new Date().getFullYear()) opts.year = 'numeric';
  return new Date(y, m - 1, d).toLocaleDateString(undefined, opts);
}

/** Signed net for a day group: income minus spend, transfers excluded. */
function dayNetText(rows) {
  let net = 0;
  let any = false;
  for (const t of rows) {
    if (isSpend(t)) {
      net -= amountOf(t);
      any = true;
    } else if (isIncome(t)) {
      net += amountOf(t);
      any = true;
    }
  }
  if (!any) return '';
  const money = fmtMoney(Math.abs(net), rows[0]?.currency ?? defaultCurrency);
  return net > 0 ? `+${money}` : net < 0 ? `−${money}` : money;
}

function renderLedger(txns) {
  const list = $('txnList');
  list.innerHTML = '';
  const rows = filteredTxns(txns);
  const empty = $('emptyTxns');
  empty.hidden = rows.length > 0;
  if (rows.length === 0) {
    if (pool.size === 0) {
      empty.textContent =
        'No transactions yet — import a statement through the vault’s ingest to see them here.';
    } else if (filterCategory || searchText) {
      empty.textContent = 'No transactions match these filters.';
    } else {
      empty.textContent = `No transactions in ${monthLabel(selectedMonth)}.`;
    }
    return;
  }
  let dayKey = null;
  let dayRows = [];
  const flushDay = () => {
    if (dayKey == null) return;
    const head = document.createElement('div');
    head.className = 'day-head';
    const label = document.createElement('span');
    label.className = 'day-label muted small';
    label.textContent = dayLabelOf(dayKey);
    const net = document.createElement('span');
    net.className = 'day-total muted small';
    net.textContent = dayNetText(dayRows);
    head.append(label, net);
    list.appendChild(head);
    for (const t of dayRows) list.appendChild(renderTxnRow(t));
  };
  for (const t of rows) {
    const key = localDayKey(t.posted_at);
    if (key !== dayKey) {
      flushDay();
      dayKey = key;
      dayRows = [];
    }
    dayRows.push(t);
  }
  flushDay();
}

function renderTxnRow(t) {
  const row = document.createElement('div');
  row.className = 'row txn-row';
  row.dataset.status = t.status;

  const check = document.createElement('label');
  check.className = 'check-wrap';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'txn-check';
  box.checked = selection.has(t.txn_id);
  box.setAttribute('aria-label', `Select ${payeeText(t)}`);
  box.addEventListener('change', () => {
    if (box.checked) selection.add(t.txn_id);
    else selection.delete(t.txn_id);
    renderBulkBar();
  });
  check.appendChild(box);

  const text = document.createElement('span');
  text.className = 'row-text';
  const payee = document.createElement('span');
  payee.textContent = payeeText(t);
  text.appendChild(payee);
  if (isTransfer(t)) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = '⇄ Transfer';
    badge.title = 'A move between your own accounts — not counted as spending';
    text.appendChild(badge);
  }
  if (t.status === 'pending') {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'Pending';
    text.appendChild(badge);
  }

  const amount = document.createElement('span');
  amount.className = 'amount';
  if (isTransfer(t)) {
    amount.classList.add('transfer');
    amount.textContent = fmtMoney(t.amount_minor, t.currency);
  } else if (t.direction === 'credit') {
    amount.classList.add('credit');
    amount.textContent = `+${fmtMoney(t.amount_minor, t.currency)}`;
  } else {
    amount.textContent = fmtMoney(t.amount_minor, t.currency);
  }

  const select = document.createElement('select');
  select.className = 'category';
  select.setAttribute('aria-label', `Category for ${payeeText(t)}`);
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
  select.value = knownCategory(t) ? t.category_concept_id : '';
  select.addEventListener('change', async () => {
    if (!select.value) return;
    const outcome = await act('categorize', {
      txn_id: t.txn_id,
      category_concept_id: select.value,
    });
    if (narrateOutcome(outcome) || outcome?.status === 'denied') await refresh();
  });

  const receipt = document.createElement('button');
  receipt.type = 'button';
  receipt.className = 'icon-btn';
  receipt.textContent = '🧾 Receipt';
  receipt.title = 'Snap a receipt onto this transaction';
  receipt.setAttribute('aria-label', `Attach a receipt to ${payeeText(t)}`);
  receipt.addEventListener('click', () => {
    attachTarget = t.txn_id;
    $('attachInput').click();
  });

  const flag = document.createElement('button');
  flag.type = 'button';
  flag.className = 'icon-btn';
  flag.textContent = '⚑ Flag';
  flag.title = 'Flag as anomalous, with a reason';
  flag.setAttribute('aria-label', `Flag ${payeeText(t)} as anomalous`);
  flag.setAttribute('aria-pressed', String(flaggedThisSession.has(t.txn_id)));
  flag.addEventListener('click', () => openFlagEditor(t, flag));

  row.append(check, text, amount, select, receipt, flag);

  // The row travels in a frame so the flag editor and any receipt strip can
  // sit beneath it while the ledger's append logic stays flat.
  const frame = document.createDocumentFragment();
  frame.appendChild(row);
  if (t.attachments?.length) {
    const strip = document.createElement('div');
    strip.className = 'attach-strip row-attachments';
    renderAttachments(strip, t.attachments, removeAttachment);
    frame.appendChild(strip);
  }
  return frame;
}

// ---------- Flag with a reason ----------

function openFlagEditor(t, flagBtn) {
  document.getElementById('flagEditor')?.remove();
  const row = flagBtn.closest('.row');
  const editor = document.createElement('div');
  editor.id = 'flagEditor';
  editor.className = 'flag-editor';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Why does this look wrong? (one line)';
  input.setAttribute('aria-label', 'Reason for flagging');
  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'primary';
  confirm.textContent = 'Flag it';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ghost';
  cancel.textContent = 'Cancel';
  const submit = async () => {
    if (confirm.disabled) return; // an Enter while the write is in flight
    const reason = input.value.trim() || 'Flagged by the owner from the Budgets app';
    confirm.disabled = true;
    const outcome = await act('flag', { txn_id: t.txn_id, reason });
    confirm.disabled = false;
    if (narrateOutcome(outcome)) {
      flaggedThisSession.add(t.txn_id);
      flagBtn.setAttribute('aria-pressed', 'true');
      editor.remove();
      toast('Flagged — the anomaly tag and its reason now live in the vault.');
      await refresh();
    } else if (outcome?.status === 'denied') {
      editor.remove();
      await refresh();
    }
  };
  confirm.addEventListener('click', submit);
  cancel.addEventListener('click', () => editor.remove());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
    if (e.key === 'Escape') editor.remove();
  });
  editor.append(input, confirm, cancel);
  row.after(editor);
  input.focus();
}

// ---------- Bulk categorize ----------

function renderBulkBar() {
  const bar = $('bulkBar');
  bar.hidden = selection.size === 0;
  document.body.classList.toggle('has-bulk', selection.size > 0);
  if (selection.size === 0) return;
  $('bulkCount').textContent = `${selection.size} selected`;
  const select = $('bulkCategory');
  const previous = select.value;
  select.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Categorize as…';
  select.appendChild(placeholder);
  for (const c of categories) {
    const opt = document.createElement('option');
    opt.value = c.concept_id;
    opt.textContent = c.pref_label ?? c.notation;
    select.appendChild(opt);
  }
  select.value = previous;
}

async function bulkCategorize() {
  const catId = $('bulkCategory').value;
  if (!catId) {
    toast('Pick a category first.');
    return;
  }
  const ids = [...selection];
  const apply = $('bulkApply');
  apply.disabled = true;
  let done = 0;
  let parked = 0;
  let failed = 0;
  for (let i = 0; i < ids.length; i += 1) {
    $('bulkCount').textContent = `Categorizing ${i + 1} of ${ids.length}…`;
    const outcome = await act('categorize', { txn_id: ids[i], category_concept_id: catId });
    if (outcome?.status === 'executed') done += 1;
    else if (outcome?.status === 'parked') parked += 1;
    else failed += 1;
  }
  apply.disabled = false;
  selection.clear();
  const parts = [`Categorized ${done} of ${ids.length} as ${categoryLabel(catId)}`];
  if (parked > 0) parts.push(`${parked} awaiting approval`);
  if (failed > 0) parts.push(`${failed} refused`);
  toast(parts.join(' · '));
  await refresh();
}

// ---------- Truncation honesty ----------

function renderTruncation() {
  const note = $('truncNote');
  const monthInfo = fetchedMonths.get(selectedMonth);
  if (monthInfo?.truncated) {
    note.textContent = `Showing ${monthInfo.limit} of this month’s transactions — the rest are not loaded.`;
    note.hidden = false;
  } else if (baseTruncated && !fetchedMonths.has(selectedMonth)) {
    note.textContent = `Showing the latest ${baseLimit} transactions — older rows and totals may be incomplete.`;
    note.hidden = false;
  } else {
    note.hidden = true;
  }
}

// ---------- Budget form (set + edit share one upsert) ----------

function renderBudgetForm() {
  const select = $('categorySelect');
  const previous = select.value;
  select.innerHTML = '';
  for (const c of categories) {
    const opt = document.createElement('option');
    opt.value = c.concept_id;
    opt.textContent = c.pref_label ?? c.notation;
    select.appendChild(opt);
  }
  if (categories.some((c) => c.concept_id === previous)) select.value = previous;
  $('budgetForm').hidden = categories.length === 0;
  syncBudgetSubmitLabel();
}

function budgetFor(catId) {
  return budgets.find((b) => b.category_concept_id === catId && b.period === 'month');
}

function syncBudgetSubmitLabel() {
  $('budgetSubmit').textContent = budgetFor($('categorySelect').value)
    ? 'Save budget'
    : 'Set budget';
}

function startBudgetEdit(b) {
  const select = $('categorySelect');
  if (![...select.options].some((o) => o.value === b.category_concept_id)) return;
  select.value = b.category_concept_id;
  $('amountInput').value = (Number(b.limit_minor ?? 0) / 100).toFixed(2);
  syncBudgetSubmitLabel();
  $('budgetForm').scrollIntoView({
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    block: 'center',
  });
  $('amountInput').focus();
}

$('categorySelect').addEventListener('change', syncBudgetSubmitLabel);

$('budgetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const category_concept_id = $('categorySelect').value;
  const amount = Number($('amountInput').value);
  if (!category_concept_id || !Number.isFinite(amount) || amount < 0) return;
  const outcome = await act('set-budget', {
    category_concept_id,
    period: 'month',
    limit_minor: Math.round(amount * 100),
    currency: budgetFor(category_concept_id)?.currency ?? defaultCurrency,
    starts_on: `${selectedMonth}-01`,
  });
  if (narrateOutcome(outcome)) {
    $('amountInput').value = '';
    toast('Budget saved.');
    await refresh();
  } else if (outcome?.status === 'denied') {
    await refresh();
  }
});

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
    rm.setAttribute('aria-label', 'Remove attachment');
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
        toast('Could not read that file.');
        continue;
      }
      const outcome = await act('attach', {
        subject_id: subjectId,
        data_uri: dataUri,
        title: file.name,
      });
      if (!narrateOutcome(outcome)) break;
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
  if (narrateOutcome(outcome) || outcome?.status === 'denied') await refresh();
}

// ---------- Wiring ----------

$('prevMonth').addEventListener('click', () => selectMonth(monthShift(selectedMonth, -1)));
$('nextMonth').addEventListener('click', () => {
  if (selectedMonth < localMonthKey(new Date())) selectMonth(monthShift(selectedMonth, 1));
});

$('searchInput').addEventListener(
  'input',
  debounce(() => {
    searchText = $('searchInput').value.trim();
    if (hasRendered) render();
  }, 150),
);

$('bulkApply').addEventListener('click', bulkCategorize);
$('bulkClear').addEventListener('click', () => {
  selection.clear();
  render();
});

wireAttachInput($('attachInput'), () => attachTarget);

async function boot() {
  showSkeleton($('budgetList'), 3);
  showSkeleton($('txnList'), 6);
  const ok = await loadBase();
  if (!ok) return;
  try {
    await ensureMonth(selectedMonth);
  } catch {
    readFailed($('noticeBanner'));
  }
  render();
}

window.addEventListener('focus', () => refresh());
boot();
