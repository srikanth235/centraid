// governance: allow-repo-hygiene file-size-limit blueprints are single-file by design (read wholesale by one agent); Studio is the fullest app — the whole client→invoice→payment loop plus attachments — and splitting it would break that "one file" contract.
// Studio — the self-employed loop as a projection over the personal vault.
// Clients are core parties, tracked time is canonical core.activity,
// invoices settle against canonical core.transaction rows. Every write
// runs a typed business command through this app's action handlers:
// enrolling clients, opening projects and logging time execute directly
// (risk low); drafting an invoice parks for the owner (medium > the app's
// low ceiling) and sending one always parks (high). The app's own
// data.sqlite stays empty by design — revoke the grant and this page goes
// dark while the model, history and receipts remain the owner's.

const $ = (id) => document.getElementById(id);

// Real business_invoice.status values: draft | sent | paid | overdue | void.
// Outstanding money gets the accent; settled money recedes.
const ACCENT_STATUSES = new Set(['sent', 'overdue']);
const FAINT_STATUSES = new Set(['paid', 'void']);

let data = { clients: [], projects: [], invoices: [], unbilled: [], parties: [], credits: [] };
const selectedEntries = new Set();
let payingInvoice = null;

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

// The invoice whose attach button was last clicked — one shared hidden file
// input serves every row, so the change handler needs to know the target.
let attachTarget = null;

async function removeAttachment(attachmentId) {
  const outcome = await act('detach', { attachment_id: attachmentId });
  if (narrate(outcome)) await refresh();
}

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
  let next;
  try {
    next = await window.centraid.read({ query: 'studio' });
  } catch {
    return; // transient; the change feed retries
  }
  const denied = next?.vaultDenied;
  $('consentBanner').hidden = !denied;
  $('timeForm').hidden = Boolean(denied);
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    for (const id of ['invoiceList', 'projectList', 'clientList', 'unbilledList']) {
      $(id).innerHTML = '';
    }
    $('invoiceForm').hidden = true;
    $('payPanel').hidden = true;
    $('empty').hidden = true;
    return;
  }
  data = next;
  for (const id of [...selectedEntries]) {
    if (!data.unbilled.some((e) => e.entry_id === id)) selectedEntries.delete(id);
  }
  renderTimeForm();
  renderUnbilled();
  renderInvoices();
  renderProjects();
  renderClients();
  renderClientForm();
  $('empty').hidden =
    data.invoices.length > 0 || data.projects.length > 0 || data.clients.length > 0;
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

// ---------- Log time ----------

function renderTimeForm() {
  const active = data.projects.filter((p) => p.status === 'active');
  $('timeForm').hidden = active.length === 0;
  fillSelect(
    $('timeProject'),
    active.map((p) => ({ value: p.project_id, label: `${p.name} · ${p.client}` })),
  );
  if (!$('timeDate').value) $('timeDate').value = new Date().toISOString().slice(0, 10);
}

$('timeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const projectId = $('timeProject').value;
  const date = $('timeDate').value;
  const start = $('timeStart').value;
  const end = $('timeEnd').value;
  if (!projectId || !date || !start || !end) return;
  const note = $('timeNote').value.trim();
  // datetime pieces are the viewer's wall clock — convert, don't relabel as UTC.
  const outcome = await act('log-time', {
    project_id: projectId,
    started_at: new Date(`${date}T${start}`).toISOString(),
    ended_at: new Date(`${date}T${end}`).toISOString(),
    ...(note ? { note } : {}),
  });
  if (narrate(outcome)) {
    $('timeNote').value = '';
    await refresh();
  }
});

// ---------- Unbilled time → draft invoice ----------

function renderUnbilled() {
  const list = $('unbilledList');
  list.innerHTML = '';
  for (const entry of data.unbilled) {
    const row = document.createElement('label');
    row.className = 'row selectable';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = selectedEntries.has(entry.entry_id);
    box.addEventListener('change', () => {
      if (box.checked) {
        // One invoice bills one client: picking an entry drops selections
        // from other clients rather than failing later vault-side.
        for (const id of [...selectedEntries]) {
          const other = data.unbilled.find((e) => e.entry_id === id);
          if (other && other.client_id !== entry.client_id) selectedEntries.delete(id);
        }
        selectedEntries.add(entry.entry_id);
      } else {
        selectedEntries.delete(entry.entry_id);
      }
      renderUnbilled();
    });
    const text = document.createElement('span');
    text.className = 'row-text';
    text.textContent = entry.note ? `${entry.project} — ${entry.note}` : entry.project;
    const client = document.createElement('span');
    client.className = 'row-sub';
    client.textContent = entry.client;
    const when = document.createElement('span');
    when.className = 'row-date';
    when.textContent = fmtDate(entry.date);
    const hours = document.createElement('span');
    hours.className = 'amount';
    hours.textContent =
      entry.rate_minor != null
        ? `${entry.hours.toFixed(2)} h · ${fmtAmount(Math.round(entry.hours * entry.rate_minor), clientCurrency(entry.client_id))}`
        : `${entry.hours.toFixed(2)} h · no rate`;
    row.append(box, text, client, when, hours);
    list.appendChild(row);
  }
  if (data.unbilled.length === 0) {
    const none = document.createElement('p');
    none.className = 'muted small quiet';
    none.textContent = 'No unbilled time — log hours above and they queue here.';
    list.appendChild(none);
  }
  renderInvoiceForm();
}

function clientCurrency(clientId) {
  return data.clients.find((c) => c.client_id === clientId)?.currency ?? 'EUR';
}

function renderInvoiceForm() {
  const picked = data.unbilled.filter((e) => selectedEntries.has(e.entry_id));
  $('invoiceForm').hidden = picked.length === 0;
  if (picked.length === 0) return;
  const hours = picked.reduce((sum, e) => sum + e.hours, 0);
  const amount = picked.reduce((sum, e) => sum + Math.round(e.hours * (e.rate_minor ?? 0)), 0);
  $('invoiceSummary').textContent =
    `${picked.length} entr${picked.length === 1 ? 'y' : 'ies'} · ${hours.toFixed(2)} h · ` +
    `${fmtAmount(amount, clientCurrency(picked[0].client_id))} for ${picked[0].client}`;
  if (!$('invoiceDue').value) {
    const due = new Date();
    due.setDate(due.getDate() + 30);
    $('invoiceDue').value = due.toISOString().slice(0, 10);
  }
}

$('invoiceForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const picked = data.unbilled.filter((entry) => selectedEntries.has(entry.entry_id));
  if (picked.length === 0 || !$('invoiceDue').value) return;
  const outcome = await act('create-draft-invoice', {
    client_id: picked[0].client_id,
    entry_ids: picked.map((entry) => entry.entry_id),
    due_on: $('invoiceDue').value,
  });
  if (
    narrate(
      outcome,
      'Invoice draft parked — the owner confirms it in vault settings, then it appears here.',
    )
  ) {
    selectedEntries.clear();
    await refresh();
  } else if (outcome?.status === 'parked') {
    selectedEntries.clear();
    renderUnbilled();
  }
});

// ---------- Invoices: send + mark paid ----------

function renderInvoices() {
  const list = $('invoiceList');
  list.innerHTML = '';
  for (const inv of data.invoices) {
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
    if (inv.status === 'draft') {
      const send = document.createElement('button');
      send.type = 'button';
      send.className = 'ghost';
      send.textContent = 'Send';
      send.addEventListener('click', async () => {
        const outcome = await act('send-invoice', { invoice_id: inv.invoice_id });
        narrate(
          outcome,
          `Send of ${inv.number} parked — the owner confirms the outward commitment.`,
        );
        await refresh();
      });
      row.appendChild(send);
    } else if (ACCENT_STATUSES.has(inv.status)) {
      const pay = document.createElement('button');
      pay.type = 'button';
      pay.className = 'ghost';
      pay.textContent = 'Mark paid';
      pay.addEventListener('click', () => openPayPanel(inv));
      row.appendChild(pay);
    }
    // One shared hidden file input serves every row; the attach button records
    // which invoice it targets before opening the picker.
    const attach = document.createElement('button');
    attach.type = 'button';
    attach.className = 'ghost';
    attach.textContent = inv.attachments?.length ? `📎 ${inv.attachments.length}` : '📎';
    attach.title = 'Attach the signed contract or a receipt';
    attach.addEventListener('click', () => {
      attachTarget = inv.invoice_id;
      $('attachInput').click();
    });
    row.appendChild(attach);

    // An invoice with files gets a strip on its own line beneath the row.
    if (inv.attachments?.length) {
      const strip = document.createElement('div');
      strip.className = 'attach-strip row-attachments';
      renderAttachments(strip, inv.attachments, removeAttachment);
      const wrap = document.createElement('div');
      wrap.className = 'row-with-attachments';
      wrap.append(row, strip);
      list.appendChild(wrap);
    } else {
      list.appendChild(row);
    }
  }
}

function openPayPanel(inv) {
  payingInvoice = inv;
  $('payTitle').textContent =
    `Settle ${inv.number} — ${fmtAmount(inv.total_minor, inv.currency)} from ${inv.client}`;
  const candidates = data.credits.filter(
    (t) => t.currency === inv.currency && t.amount_minor >= inv.total_minor,
  );
  fillSelect(
    $('paySelect'),
    candidates.map((t) => ({
      value: t.txn_id,
      label: `${fmtDate(t.posted_at)} · ${fmtAmount(t.amount_minor, t.currency)} · ${t.description || 'incoming'}`,
    })),
    candidates.length ? 'Pick the matching deposit…' : 'No matching deposit in the vault yet',
  );
  $('payButton').disabled = candidates.length === 0;
  $('payPanel').hidden = false;
}

$('payButton').addEventListener('click', async () => {
  if (!payingInvoice || !$('paySelect').value) return;
  const outcome = await act('mark-invoice-paid', {
    invoice_id: payingInvoice.invoice_id,
    txn_id: $('paySelect').value,
  });
  if (
    narrate(outcome, 'Settlement parked — the owner confirms the ledger link in vault settings.')
  ) {
    $('payPanel').hidden = true;
    payingInvoice = null;
    await refresh();
  } else if (outcome?.status === 'parked') {
    $('payPanel').hidden = true;
    payingInvoice = null;
  }
});

$('payCancel').addEventListener('click', () => {
  $('payPanel').hidden = true;
  payingInvoice = null;
});

// ---------- Projects ----------

function renderProjects() {
  const list = $('projectList');
  list.innerHTML = '';
  for (const p of data.projects) {
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

$('addProjectButton').addEventListener('click', () => {
  fillSelect(
    $('projectClient'),
    data.clients.map((c) => ({ value: c.client_id, label: c.name })),
  );
  $('projectForm').hidden = !$('projectForm').hidden;
  if (!$('projectForm').hidden) $('projectName').focus();
});

$('projectForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const clientId = $('projectClient').value;
  const name = $('projectName').value.trim();
  if (!clientId || !name) return;
  const outcome = await act('add-project', { client_id: clientId, name });
  if (narrate(outcome)) {
    $('projectName').value = '';
    $('projectForm').hidden = true;
    await refresh();
  }
});

// ---------- Clients ----------

function renderClients() {
  const list = $('clientList');
  list.innerHTML = '';
  for (const c of data.clients) {
    const row = document.createElement('div');
    row.className = 'row';
    const text = document.createElement('span');
    text.className = 'row-text';
    text.textContent = c.name;
    const count = document.createElement('span');
    count.className = 'row-sub';
    count.textContent = `${c.projects} project${c.projects === 1 ? '' : 's'}`;
    const rate = document.createElement('span');
    rate.className = 'amount';
    rate.textContent =
      c.default_rate_minor != null ? `${fmtAmount(c.default_rate_minor, c.currency)}/h` : '';
    row.append(text, count, rate);
    list.appendChild(row);
  }
}

function renderClientForm() {
  fillSelect(
    $('clientParty'),
    data.parties.map((p) => ({ value: p.party_id, label: p.display_name })),
    data.parties.length ? 'Pick a party…' : 'No unenrolled parties — add one in People',
  );
}

$('addClientButton').addEventListener('click', () => {
  $('clientForm').hidden = !$('clientForm').hidden;
});

$('clientForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const partyId = $('clientParty').value;
  const currency = $('clientCurrency').value.trim().toUpperCase();
  if (!partyId || currency.length !== 3) return;
  const rate = parseFloat($('clientRate').value);
  const outcome = await act('add-client', {
    party_id: partyId,
    currency,
    ...(Number.isFinite(rate) && rate >= 0 ? { default_rate_minor: Math.round(rate * 100) } : {}),
  });
  if (narrate(outcome)) {
    $('clientForm').hidden = true;
    $('clientRate').value = '';
    await refresh();
  }
});

wireAttachInput($('attachInput'), () => attachTarget);

window.addEventListener('focus', refresh);
refresh();
