// Studio — a pure read-only projection over the personal vault. Clients
// are core parties, projects and time entries live in the business schema,
// and invoices reference canonical transactions. There are no write paths
// here: billing actions arrive with the business domain's command pack.
// The app's own data.sqlite stays empty by design — revoke the grant and
// this page goes dark while the model, history and receipts remain the
// owner's.

const $ = (id) => document.getElementById(id);

// Real business_invoice.status values: draft | sent | paid | overdue | void.
// Outstanding money gets the accent; settled money recedes.
const ACCENT_STATUSES = new Set(['sent', 'overdue']);
const FAINT_STATUSES = new Set(['paid', 'void']);

function fmtDate(iso) {
  try {
    return new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

function fmtAmount(minor, currency) {
  const value = (minor ?? 0) / 100; // integer minor units → major
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency ?? ''}`.trim();
  }
}

async function refresh() {
  let data;
  try {
    data = await window.centraid.read({ query: 'studio' });
  } catch {
    return; // transient; the change feed retries
  }
  const denied = data?.vaultDenied;
  $('consentBanner').hidden = !denied;
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    $('invoiceList').innerHTML = '';
    $('projectList').innerHTML = '';
    $('clientList').innerHTML = '';
    $('empty').hidden = true;
    return;
  }
  const invoices = data?.invoices ?? [];
  const projects = data?.projects ?? [];
  const clients = data?.clients ?? [];
  renderInvoices(invoices);
  renderProjects(projects);
  renderClients(clients);
  $('empty').hidden = invoices.length > 0 || projects.length > 0 || clients.length > 0;
}

function renderInvoices(invoices) {
  const list = $('invoiceList');
  list.innerHTML = '';
  for (const inv of invoices) {
    const row = document.createElement('div');
    row.className = 'row';
    const text = document.createElement('span');
    text.className = 'row-text';
    text.textContent = inv.number;
    const client = document.createElement('span');
    client.className = 'row-sub';
    client.textContent = inv.client;
    const issued = document.createElement('span');
    issued.className = 'row-date';
    issued.textContent = fmtDate(inv.issued_on);
    const amount = document.createElement('span');
    amount.className = 'amount';
    amount.textContent = fmtAmount(inv.total_minor, inv.currency);
    const badge = document.createElement('span');
    badge.className = 'badge';
    if (ACCENT_STATUSES.has(inv.status)) badge.classList.add('accent');
    else if (FAINT_STATUSES.has(inv.status)) badge.classList.add('faint');
    badge.textContent = inv.status;
    row.append(text, client, issued, amount, badge);
    list.appendChild(row);
  }
}

function renderProjects(projects) {
  const list = $('projectList');
  list.innerHTML = '';
  for (const p of projects) {
    const row = document.createElement('div');
    row.className = 'row';
    const text = document.createElement('span');
    text.className = 'row-text';
    text.textContent = p.name;
    const client = document.createElement('span');
    client.className = 'row-sub';
    client.textContent = p.client;
    const hours = document.createElement('span');
    hours.className = 'amount';
    hours.textContent = `${(p.hours ?? 0).toFixed(1)} h tracked`;
    const badge = document.createElement('span');
    badge.className = 'badge';
    if (p.status === 'active') badge.classList.add('accent');
    badge.textContent = p.status;
    row.append(text, client, hours, badge);
    list.appendChild(row);
  }
}

function renderClients(clients) {
  const list = $('clientList');
  list.innerHTML = '';
  for (const c of clients) {
    const row = document.createElement('div');
    row.className = 'row';
    const text = document.createElement('span');
    text.className = 'row-text';
    text.textContent = c.name;
    const count = document.createElement('span');
    count.className = 'row-sub';
    count.textContent = `${c.projects} project${c.projects === 1 ? '' : 's'}`;
    row.append(text, count);
    list.appendChild(row);
  }
}

window.addEventListener('focus', refresh);
refresh();
