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
  renderCategories();
  renderBudgets(data?.budgets ?? []);
  renderTransactions(data?.transactions ?? []);
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
    const row = document.createElement('div');
    row.className = 'row';
    const text = document.createElement('span');
    text.className = 'row-text';
    text.textContent = conceptLabels.get(b.category_concept_id) ?? b.category_concept_id;
    const amount = document.createElement('span');
    amount.className = 'amount';
    amount.textContent = `${fmtMoney(b.limit_minor, b.currency)} / ${b.period}`;
    row.append(text, amount);
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

  row.append(date, text, amount, select, flag);
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

window.addEventListener('focus', refresh);
refresh();
