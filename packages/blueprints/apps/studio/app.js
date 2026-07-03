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

import {
  barChart,
  barSpan,
  fmtMoney,
  localDayKey,
  outcomeMessage,
  readFailed,
  showSkeleton,
  toast,
} from './kit.js';

const $ = (id) => document.getElementById(id);

// Real business_invoice.status values: draft | sent | paid | overdue | void.
// Outstanding money gets the accent; settled money recedes.
const ACCENT_STATUSES = new Set(['sent', 'overdue']);
const FAINT_STATUSES = new Set(['paid', 'void']);
const DAY_MS = 86_400_000;

let data = {
  clients: [],
  projects: [],
  invoices: [],
  unbilled: [],
  entries: [],
  parties: [],
  credits: [],
};
let loaded = false; // first read landed — skeletons give way to real rows
const selectedEntries = new Set();
let payingInvoice = null;
let clientFilter = null; // client_id — clicking a client focuses every section
let weekOffset = 0; // 0 = this week; negative pages back through the timesheet
let expandedInvoice = null; // invoice_id whose line items are open
let previewInvoice = null;
let lastTermsClient = null; // which client the due-date default was computed for

// Session-local pending state: parked commands render as pseudo-rows until
// the owner's decision shows up in the projection (or the session ends).
const pendingDrafts = []; // {client_id, client, entry_ids, hours, amount_minor, currency, number}
const pendingSends = new Set(); // invoice_id
const pendingPays = new Set(); // invoice_id

function notice(text) {
  const el = $('noticeBanner');
  el.textContent = text;
  el.hidden = !text;
}

// One narration for every action outcome; returns true when it executed.
// Parked/failed/denied land as toasts — the pending visuals carry the state.
function narrate(outcome, parkedText) {
  if (outcome?.status === 'executed') return true;
  const msg = outcome?.status === 'parked' && parkedText ? parkedText : outcomeMessage(outcome);
  if (msg) toast(msg);
  return false;
}

async function act(action, input) {
  try {
    return await window.centraid.write({ action, input });
  } catch (err) {
    toast(String(err?.message ?? err));
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
        toast('Could not read that file.');
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

// ---------- Formatting ----------

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

// Short "Mar 14" — for due chips and week labels where the year is noise.
function fmtDay(iso) {
  try {
    return new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function fmtHours(h) {
  return `${h.toFixed(2).replace(/\.?0+$/, '') || '0'} h`;
}

// Due state from the payload's due_on — "due Mar 14" while open, a red
// "overdue 6d" once the date passes and the money is still out.
function dueInfo(inv) {
  if (!inv.due_on) return null;
  const due = String(inv.due_on).slice(0, 10);
  if (FAINT_STATUSES.has(inv.status)) return { overdue: false, text: `was due ${fmtDay(due)}` };
  const days = Math.round(
    (new Date(`${due}T00:00:00`).getTime() -
      new Date(`${localDayKey(new Date())}T00:00:00`).getTime()) /
      DAY_MS,
  );
  if (days < 0) return { overdue: true, text: `overdue ${-days}d` };
  if (days === 0) return { overdue: false, text: 'due today' };
  return { overdue: false, text: `due ${fmtDay(due)}` };
}

// Sum minor units per currency; render as "€1,200" or "€1,200 + $300".
function sumByCurrency(rows, amount, currency) {
  const totals = new Map();
  for (const r of rows) {
    const c = currency(r);
    totals.set(c, (totals.get(c) ?? 0) + amount(r));
  }
  return totals;
}

function fmtSums(totals) {
  if (totals.size === 0) return fmtMoney(0, data.clients[0]?.currency ?? 'EUR');
  return [...totals.entries()].map(([c, v]) => fmtMoney(v, c)).join(' + ');
}

function clientCurrency(clientId) {
  return data.clients.find((c) => c.client_id === clientId)?.currency ?? 'EUR';
}

function entryAmount(entry) {
  return Math.round(entry.hours * (entry.rate_minor ?? 0));
}

// ---------- The client filter (click a client row to focus everything) ----------

function matchesFilter(clientId) {
  return clientFilter === null || clientId === clientFilter;
}

function setClientFilter(clientId) {
  clientFilter = clientFilter === clientId ? null : clientId;
  renderAll();
}

function renderFilterChip() {
  const bar = $('filterBar');
  const chip = $('filterChip');
  if (!clientFilter) {
    bar.hidden = true;
    return;
  }
  const name = data.clients.find((c) => c.client_id === clientFilter)?.name ?? 'client';
  chip.textContent = `Showing ${name} — clear ×`;
  bar.hidden = false;
}

$('filterChip').addEventListener('click', () => {
  clientFilter = null;
  renderAll();
});

// ---------- Refresh ----------

async function refresh() {
  let next;
  try {
    next = await window.centraid.read({ query: 'studio' });
  } catch {
    // A broken vault must not look like an empty one; the change feed and
    // window focus retry, so the banner is the whole recovery UI.
    if (!loaded) readFailed($('noticeBanner'));
    return;
  }
  const denied = next?.vaultDenied;
  $('consentBanner').hidden = !denied;
  $('timeForm').hidden = Boolean(denied);
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    for (const id of ['invoiceList', 'projectList', 'clientList', 'unbilledList', 'timesheet']) {
      $(id).innerHTML = '';
    }
    $('invoiceForm').hidden = true;
    $('payPanel').hidden = true;
    $('statsStrip').hidden = true;
    $('statsNote').hidden = true;
    $('weekChart').hidden = true;
    $('firstRun').hidden = true;
    $('filterBar').hidden = true;
    return;
  }
  loaded = true;
  notice('');
  data = { entries: [], ...next };
  for (const id of [...selectedEntries]) {
    if (!data.unbilled.some((e) => e.entry_id === id)) selectedEntries.delete(id);
  }
  if (clientFilter && !data.clients.some((c) => c.client_id === clientFilter)) clientFilter = null;
  prunePending();
  renderAll();
}

// Drop session-local pending markers once the projection shows the owner's
// decision landed: a draft's entries left the unbilled queue, a sent invoice
// stopped being a draft, a settled one reads paid.
function prunePending() {
  const unbilledIds = new Set(data.unbilled.map((e) => e.entry_id));
  for (let i = pendingDrafts.length - 1; i >= 0; i -= 1) {
    if (!pendingDrafts[i].entry_ids.some((id) => unbilledIds.has(id))) pendingDrafts.splice(i, 1);
  }
  const byId = new Map(data.invoices.map((inv) => [inv.invoice_id, inv]));
  for (const id of [...pendingSends]) {
    const inv = byId.get(id);
    if (!inv || inv.status !== 'draft') pendingSends.delete(id);
  }
  for (const id of [...pendingPays]) {
    const inv = byId.get(id);
    if (!inv || inv.status === 'paid') pendingPays.delete(id);
  }
}

function renderAll() {
  renderStats();
  renderFilterChip();
  renderFirstRun();
  renderTimeForm();
  renderTimesheet();
  renderUnbilled();
  renderInvoices();
  renderProjects();
  renderClients();
  renderClientForm();
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

// ---------- Money dashboard ----------

function isOverdue(inv) {
  return inv.status === 'overdue' || (inv.status === 'sent' && Boolean(dueInfo(inv)?.overdue));
}

function renderStats() {
  const strip = $('statsStrip');
  strip.innerHTML = '';
  const invoices = data.invoices.filter((inv) => matchesFilter(inv.client_id));
  const unbilled = data.unbilled.filter((e) => matchesFilter(e.client_id));
  const nothingYet = invoices.length === 0 && unbilled.length === 0 && data.clients.length === 0;
  strip.hidden = nothingYet;
  $('statsNote').hidden = nothingYet;
  if (nothingYet) return;

  const outstanding = invoices.filter((inv) => ACCENT_STATUSES.has(inv.status));
  const overdue = invoices.filter(isOverdue);
  const drafts = invoices.filter((inv) => inv.status === 'draft');
  const paid = invoices.filter((inv) => inv.status === 'paid');
  const cards = [
    { label: 'Outstanding', rows: outstanding },
    { label: 'Overdue', rows: overdue, danger: overdue.length > 0 },
    { label: 'Drafts', rows: drafts },
    { label: 'Paid', rows: paid },
  ];
  for (const card of cards) {
    const el = document.createElement('div');
    el.className = 'stat';
    if (card.danger) el.classList.add('danger');
    const label = document.createElement('span');
    label.className = 'stat-label';
    label.textContent = card.label;
    const value = document.createElement('span');
    value.className = 'stat-value';
    value.textContent = fmtSums(
      sumByCurrency(
        card.rows,
        (inv) => inv.total_minor,
        (inv) => inv.currency,
      ),
    );
    const sub = document.createElement('span');
    sub.className = 'stat-sub';
    sub.textContent = `${card.rows.length} invoice${card.rows.length === 1 ? '' : 's'}`;
    el.append(label, value, sub);
    strip.appendChild(el);
  }
  const hours = unbilled.reduce((sum, e) => sum + e.hours, 0);
  $('statsNote').textContent =
    `Unbilled: ${fmtSums(sumByCurrency(unbilled, entryAmount, (e) => clientCurrency(e.client_id)))} · ${fmtHours(hours)}`;
}

// ---------- First-run checklist ----------

function openClientForm() {
  $('clientForm').hidden = false;
  $('clientParty').focus();
}

function openProjectForm() {
  fillSelect(
    $('projectClient'),
    data.clients.map((c) => ({ value: c.client_id, label: c.name })),
  );
  $('projectForm').hidden = false;
  $('projectName').focus();
}

function renderFirstRun() {
  const el = $('firstRun');
  const steps = [
    {
      label: 'Enroll a client',
      hint: 'Pick a party from your vault and set their currency and rate.',
      done: data.clients.length > 0,
      go: openClientForm,
    },
    {
      label: 'Create a project',
      hint: 'Time is always logged against a project under a client.',
      done: data.projects.length > 0,
      go: openProjectForm,
    },
    {
      label: 'Log your first hours',
      hint: 'Billable hours queue below, ready to become an invoice.',
      done: data.entries.length > 0,
      go: () => $('timeProject').focus(),
    },
  ];
  // Surface the checklist until the loop exists end-to-end; once a client,
  // a project and a first entry all exist it stays gone.
  el.hidden = !steps.some((s) => !s.done);
  if (el.hidden) return;
  el.innerHTML = '';
  const title = document.createElement('p');
  title.className = 'checklist-title';
  title.textContent = 'Get the loop running';
  el.appendChild(title);
  steps.forEach((step, i) => {
    const row = document.createElement('div');
    row.className = 'checklist-step';
    if (step.done) row.classList.add('done');
    const num = document.createElement('span');
    num.className = 'checklist-num';
    num.textContent = step.done ? '✓' : String(i + 1);
    const body = document.createElement('div');
    body.className = 'checklist-body';
    const label = document.createElement('span');
    label.className = 'checklist-label';
    label.textContent = step.label;
    const hint = document.createElement('span');
    hint.className = 'muted small';
    hint.textContent = step.hint;
    body.append(label, hint);
    row.append(num, body);
    if (!step.done) {
      const firstUndone = steps.findIndex((s) => !s.done) === i;
      const go = document.createElement('button');
      go.type = 'button';
      go.className = firstUndone ? 'primary small-btn' : 'ghost';
      go.textContent = 'Go';
      go.disabled = !firstUndone;
      go.addEventListener('click', step.go);
      row.appendChild(go);
    }
    el.appendChild(row);
  });
}

// ---------- Log time ----------

let hoursMode = false;

$('timeModeBtn').addEventListener('click', () => {
  hoursMode = !hoursMode;
  $('timeEnd').hidden = hoursMode;
  $('timeArrow').hidden = hoursMode;
  $('timeHours').hidden = !hoursMode;
  $('timeModeBtn').textContent = hoursMode ? 'Log by end time' : 'Log by hours';
  (hoursMode ? $('timeHours') : $('timeEnd')).focus();
});

function renderTimeForm() {
  const active = data.projects.filter((p) => p.status === 'active');
  $('timeForm').hidden = active.length === 0;
  // Respect the client filter, but never leave the picker empty because the
  // focused client happens to have no active projects.
  const scoped = active.filter((p) => matchesFilter(p.client_id));
  fillSelect(
    $('timeProject'),
    (scoped.length ? scoped : active).map((p) => ({
      value: p.project_id,
      label: `${p.name} · ${p.client}`,
    })),
  );
  if (!$('timeDate').value) $('timeDate').value = localDayKey(new Date());
}

$('timeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const projectId = $('timeProject').value;
  const date = $('timeDate').value;
  const start = $('timeStart').value;
  if (!projectId || !date || !start) return;
  // datetime pieces are the viewer's wall clock — convert, don't relabel as UTC.
  const startedAt = new Date(`${date}T${start}`);
  let endedAt;
  if (hoursMode) {
    // Duration mode: back-compute the end from start + hours.
    const h = parseFloat($('timeHours').value);
    if (!Number.isFinite(h) || h <= 0) return;
    endedAt = new Date(startedAt.getTime() + Math.round(h * 3_600_000));
  } else {
    if (!$('timeEnd').value) return;
    endedAt = new Date(`${date}T${$('timeEnd').value}`);
  }
  const note = $('timeNote').value.trim();
  const rate = parseFloat($('timeRate').value);
  const outcome = await act('log-time', {
    project_id: projectId,
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    billable: $('timeBillable').checked ? 1 : 0,
    ...(Number.isFinite(rate) && rate >= 0 ? { rate_minor: Math.round(rate * 100) } : {}),
    ...(note ? { note } : {}),
  });
  if (narrate(outcome)) {
    const hours = (endedAt.getTime() - startedAt.getTime()) / 3_600_000;
    toast(`Logged ${fmtHours(hours)}.`);
    $('timeNote').value = '';
    $('timeRate').value = '';
    $('timeHours').value = '';
    await refresh();
  }
});

// ---------- Timesheet (this week, day by day) + weekly hours chart ----------

function startOfWeek(d) {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  s.setDate(s.getDate() - ((s.getDay() + 6) % 7)); // Monday-based
  return s;
}

function weekRange(offset) {
  const start = startOfWeek(new Date());
  start.setDate(start.getDate() + offset * 7);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return { start, end };
}

function timesheetEntries() {
  return data.entries.filter((e) => matchesFilter(e.client_id));
}

function renderTimesheet() {
  const { start, end } = weekRange(weekOffset);
  const startKey = localDayKey(start);
  const endKey = localDayKey(end);
  const rows = timesheetEntries().filter((e) => {
    const key = localDayKey(e.started_at);
    return key >= startKey && key <= endKey;
  });
  const total = rows.reduce((sum, e) => sum + e.hours, 0);
  $('weekLabel').textContent =
    `${fmtDay(startKey)} – ${fmtDay(endKey)}${weekOffset === 0 ? ' (this week)' : ''} · ${fmtHours(total)}`;
  $('weekNext').disabled = weekOffset >= 0;

  const sheet = $('timesheet');
  sheet.innerHTML = '';
  if (rows.length === 0) {
    const none = document.createElement('p');
    none.className = 'muted small quiet';
    none.textContent = weekOffset === 0 ? 'No time this week yet.' : 'No time logged this week.';
    sheet.appendChild(none);
  } else {
    const byDay = new Map();
    for (const e of rows) {
      const key = localDayKey(e.started_at);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(e);
    }
    for (const key of [...byDay.keys()].sort()) {
      const dayRows = byDay.get(key);
      const dayTotal = dayRows.reduce((sum, e) => sum + e.hours, 0);
      const head = document.createElement('div');
      head.className = 'ts-day';
      const name = document.createElement('span');
      name.className = 'ts-day-name';
      name.textContent = new Date(`${key}T00:00:00`).toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
      const sum = document.createElement('span');
      sum.className = 'amount';
      sum.textContent = fmtHours(dayTotal);
      head.append(name, sum);
      sheet.appendChild(head);
      for (const e of dayRows) {
        const row = document.createElement('div');
        row.className = 'row ts-row';
        const text = document.createElement('span');
        text.className = 'row-text';
        text.textContent = e.note ? `${e.project} — ${e.note}` : e.project;
        const client = document.createElement('span');
        client.className = 'row-sub';
        client.textContent = e.client;
        row.append(text, client);
        if (!e.billable) {
          const chip = document.createElement('span');
          chip.className = 'badge faint';
          chip.textContent = 'non-billable';
          row.appendChild(chip);
        } else if (e.billed) {
          const chip = document.createElement('span');
          chip.className = 'badge';
          chip.textContent = 'billed';
          row.appendChild(chip);
        } else {
          const chip = document.createElement('span');
          chip.className = 'badge accent';
          chip.textContent = 'unbilled';
          row.appendChild(chip);
        }
        const hours = document.createElement('span');
        hours.className = 'amount';
        hours.textContent = fmtHours(e.hours);
        row.append(hours);
        sheet.appendChild(row);
      }
    }
  }
  renderWeekChart();
}

function renderWeekChart() {
  const el = $('weekChart');
  el.innerHTML = '';
  const entries = timesheetEntries();
  const items = [];
  let any = false;
  for (let i = 7; i >= 0; i -= 1) {
    const { start, end } = weekRange(-i);
    const startKey = localDayKey(start);
    const endKey = localDayKey(end);
    const hours = entries.reduce((sum, e) => {
      const key = localDayKey(e.started_at);
      return key >= startKey && key <= endKey ? sum + e.hours : sum;
    }, 0);
    if (hours > 0) any = true;
    items.push({ label: fmtDay(startKey), value: hours });
  }
  el.hidden = !any;
  if (any) el.appendChild(barChart(items, { label: 'Hours logged per week', height: 120 }));
}

$('weekPrev').addEventListener('click', () => {
  weekOffset -= 1;
  renderTimesheet();
});

$('weekNext').addEventListener('click', () => {
  if (weekOffset < 0) weekOffset += 1;
  renderTimesheet();
});

// ---------- Unbilled time → draft invoice ----------

function pendingEntryIds() {
  return new Set(pendingDrafts.flatMap((d) => d.entry_ids));
}

function renderUnbilled() {
  const list = $('unbilledList');
  list.innerHTML = '';
  const pendingIds = pendingEntryIds();
  const entries = data.unbilled.filter((e) => matchesFilter(e.client_id));
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.client_id)) groups.set(entry.client_id, []);
    groups.get(entry.client_id).push(entry);
  }
  for (const [clientId, group] of groups) {
    const selectable = group.filter((e) => !pendingIds.has(e.entry_id));
    const head = document.createElement('div');
    head.className = 'group-head';
    const name = document.createElement('span');
    name.className = 'group-name';
    name.textContent = group[0].client;
    const sum = document.createElement('span');
    sum.className = 'muted small';
    const groupHours = group.reduce((s, e) => s + e.hours, 0);
    sum.textContent = `${fmtHours(groupHours)} · ${fmtMoney(
      group.reduce((s, e) => s + entryAmount(e), 0),
      clientCurrency(clientId),
    )}`;
    head.append(name, sum);
    if (selectable.length > 0) {
      const allPicked = selectable.every((e) => selectedEntries.has(e.entry_id));
      const all = document.createElement('button');
      all.type = 'button';
      all.className = 'ghost';
      all.textContent = allPicked ? 'Clear' : 'Select all';
      all.addEventListener('click', () => {
        // One invoice bills one client: selecting a group clears the rest.
        selectedEntries.clear();
        if (!allPicked) for (const e of selectable) selectedEntries.add(e.entry_id);
        renderUnbilled();
      });
      head.appendChild(all);
    }
    list.appendChild(head);
    for (const entry of group) {
      const pending = pendingIds.has(entry.entry_id);
      const row = document.createElement('label');
      row.className = 'row selectable';
      if (pending) row.classList.add('kit-pending');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = selectedEntries.has(entry.entry_id);
      box.disabled = pending;
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
      const when = document.createElement('span');
      when.className = 'row-date';
      when.textContent = fmtDate(entry.date);
      const hours = document.createElement('span');
      hours.className = 'amount';
      hours.textContent =
        entry.rate_minor != null
          ? `${entry.hours.toFixed(2)} h · ${fmtMoney(entryAmount(entry), clientCurrency(entry.client_id))}`
          : `${entry.hours.toFixed(2)} h · no rate`;
      row.append(box, text, when, hours);
      if (pending) {
        const chip = document.createElement('span');
        chip.className = 'kit-pending-chip';
        chip.textContent = 'on a pending draft';
        row.appendChild(chip);
      }
      list.appendChild(row);
    }
  }
  if (entries.length === 0) {
    const none = document.createElement('p');
    none.className = 'muted small quiet';
    none.textContent = clientFilter
      ? 'No unbilled time for this client.'
      : 'No unbilled time — log hours above and they queue here.';
    list.appendChild(none);
  }
  renderInvoiceForm();
}

function renderInvoiceForm() {
  const picked = data.unbilled.filter((e) => selectedEntries.has(e.entry_id));
  $('invoiceForm').hidden = picked.length === 0;
  if (picked.length === 0) return;
  const hours = picked.reduce((sum, e) => sum + e.hours, 0);
  const amount = picked.reduce((sum, e) => sum + entryAmount(e), 0);
  $('invoiceSummary').textContent =
    `${picked.length} entr${picked.length === 1 ? 'y' : 'ies'} · ${hours.toFixed(2)} h · ` +
    `${fmtMoney(amount, clientCurrency(picked[0].client_id))} for ${picked[0].client}`;
  // Due date defaults from the client's payment terms, not a hardcoded net-30;
  // recompute when the selection moves to a different client.
  const client = data.clients.find((c) => c.client_id === picked[0].client_id);
  if (!$('invoiceDue').value || lastTermsClient !== picked[0].client_id) {
    const due = new Date();
    due.setDate(due.getDate() + (client?.payment_terms_days ?? 30));
    $('invoiceDue').value = localDayKey(due);
    lastTermsClient = picked[0].client_id;
  }
  // While a draft for this client awaits approval, don't queue another.
  const blocked = pendingDrafts.some((d) => d.client_id === picked[0].client_id);
  $('draftButton').disabled = blocked;
  $('draftPendingNote').hidden = !blocked;
}

$('invoiceForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const picked = data.unbilled.filter((entry) => selectedEntries.has(entry.entry_id));
  if (picked.length === 0 || !$('invoiceDue').value || $('draftButton').disabled) return;
  const number = $('invoiceNumber').value.trim();
  const outcome = await act('create-draft-invoice', {
    client_id: picked[0].client_id,
    entry_ids: picked.map((entry) => entry.entry_id),
    due_on: $('invoiceDue').value,
    ...(number ? { number } : {}),
  });
  if (
    narrate(
      outcome,
      'Invoice draft parked — the owner confirms it in vault settings, then it appears here.',
    )
  ) {
    selectedEntries.clear();
    $('invoiceNumber').value = '';
    await refresh();
  } else if (outcome?.status === 'parked') {
    // The parked draft renders as a pending pseudo-invoice until the owner's
    // decision shows up in the projection.
    pendingDrafts.push({
      client_id: picked[0].client_id,
      client: picked[0].client,
      entry_ids: picked.map((entry) => entry.entry_id),
      hours: picked.reduce((sum, entry) => sum + entry.hours, 0),
      amount_minor: picked.reduce((sum, entry) => sum + entryAmount(entry), 0),
      currency: clientCurrency(picked[0].client_id),
      number: number || null,
    });
    selectedEntries.clear();
    $('invoiceNumber').value = '';
    renderUnbilled();
    renderInvoices();
  }
});

// ---------- Invoices: due dates, line items, preview, send + mark paid ----------

function renderInvoices() {
  const list = $('invoiceList');
  list.innerHTML = '';
  // Parked drafts first: pseudo-rows the owner hasn't confirmed yet.
  for (const d of pendingDrafts) {
    if (!matchesFilter(d.client_id)) continue;
    const row = document.createElement('div');
    row.className = 'row kit-pending';
    const text = document.createElement('span');
    text.className = 'row-text';
    text.textContent = d.number ?? 'New draft';
    const client = document.createElement('span');
    client.className = 'row-sub';
    client.textContent = d.client;
    const amount = document.createElement('span');
    amount.className = 'amount';
    amount.textContent = `${fmtHours(d.hours)} · ${fmtMoney(d.amount_minor, d.currency)}`;
    const chip = document.createElement('span');
    chip.className = 'kit-pending-chip';
    chip.textContent = 'awaiting your approval';
    row.append(text, client, amount, chip);
    list.appendChild(row);
  }

  const invoices = data.invoices.filter((inv) => matchesFilter(inv.client_id));
  for (const inv of invoices) {
    const row = document.createElement('div');
    row.className = 'row';
    const sendPending = pendingSends.has(inv.invoice_id);
    const payPending = pendingPays.has(inv.invoice_id);
    if (sendPending || payPending) row.classList.add('kit-pending');
    const text = document.createElement('span');
    text.className = 'row-text';
    text.textContent = inv.number;
    const client = document.createElement('span');
    client.className = 'row-sub';
    client.textContent = inv.client;
    const issued = document.createElement('span');
    issued.className = 'row-date';
    issued.textContent = fmtDate(inv.issued_on);
    const due = dueInfo(inv);
    const dueEl = document.createElement('span');
    dueEl.className = 'due';
    if (due) {
      dueEl.textContent = due.text;
      if (due.overdue) dueEl.classList.add('overdue');
    }
    const amount = document.createElement('span');
    amount.className = 'amount';
    amount.textContent = fmtMoney(inv.total_minor, inv.currency);
    const badge = document.createElement('span');
    badge.className = 'badge';
    if (ACCENT_STATUSES.has(inv.status)) badge.classList.add('accent');
    else if (FAINT_STATUSES.has(inv.status)) badge.classList.add('faint');
    badge.textContent = inv.status;
    row.append(text, client, issued, dueEl, amount, badge);
    if (sendPending || payPending) {
      const chip = document.createElement('span');
      chip.className = 'kit-pending-chip';
      chip.textContent = sendPending
        ? 'send awaiting your approval'
        : 'settlement awaiting approval';
      row.appendChild(chip);
    }
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'ghost';
    preview.textContent = 'Preview';
    preview.addEventListener('click', (e) => {
      e.stopPropagation();
      openPreview(inv);
    });
    row.appendChild(preview);
    if (inv.status === 'draft') {
      const send = document.createElement('button');
      send.type = 'button';
      send.className = 'ghost';
      send.textContent = 'Send';
      send.disabled = sendPending;
      send.addEventListener('click', async (e) => {
        e.stopPropagation();
        const outcome = await act('send-invoice', { invoice_id: inv.invoice_id });
        if (outcome?.status === 'parked') pendingSends.add(inv.invoice_id);
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
      pay.disabled = payPending;
      pay.addEventListener('click', (e) => {
        e.stopPropagation();
        openPayPanel(inv);
      });
      row.appendChild(pay);
    }
    // One shared hidden file input serves every row; the attach button records
    // which invoice it targets before opening the picker.
    const attach = document.createElement('button');
    attach.type = 'button';
    attach.className = 'ghost';
    attach.textContent = inv.attachments?.length ? `📎 ${inv.attachments.length}` : '📎';
    attach.title = 'Attach the signed contract or a receipt';
    attach.addEventListener('click', (e) => {
      e.stopPropagation();
      attachTarget = inv.invoice_id;
      $('attachInput').click();
    });
    row.appendChild(attach);

    // The row itself toggles the line-item breakdown when there are lines.
    const wrap = document.createElement('div');
    wrap.className = 'row-with-attachments';
    wrap.appendChild(row);
    if (inv.lines?.length) {
      row.classList.add('expandable');
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-expanded', String(expandedInvoice === inv.invoice_id));
      const toggle = () => {
        expandedInvoice = expandedInvoice === inv.invoice_id ? null : inv.invoice_id;
        renderInvoices();
      };
      row.addEventListener('click', (e) => {
        if (e.target.closest('button, a, input')) return;
        toggle();
      });
      row.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('button, a, input')) {
          e.preventDefault();
          toggle();
        }
      });
      if (expandedInvoice === inv.invoice_id) {
        const linesEl = document.createElement('div');
        linesEl.className = 'inv-lines';
        for (const line of inv.lines) {
          const lineEl = document.createElement('div');
          lineEl.className = 'inv-line';
          const desc = document.createElement('span');
          desc.className = 'inv-line-desc';
          desc.textContent = line.description;
          const calc = document.createElement('span');
          calc.className = 'inv-line-calc';
          calc.textContent = `${line.hours.toFixed(2)} h × ${fmtMoney(line.unit_price_minor, inv.currency)}`;
          const amt = document.createElement('span');
          amt.className = 'amount';
          amt.textContent = fmtMoney(line.amount_minor, inv.currency);
          lineEl.append(desc, calc, amt);
          linesEl.appendChild(lineEl);
        }
        wrap.appendChild(linesEl);
      }
    }

    // An invoice with files gets a strip on its own line beneath the row.
    if (inv.attachments?.length) {
      const strip = document.createElement('div');
      strip.className = 'attach-strip row-attachments';
      renderAttachments(strip, inv.attachments, removeAttachment);
      wrap.appendChild(strip);
    }
    list.appendChild(wrap);
  }
  if (pendingDrafts.length === 0 && invoices.length === 0) {
    const none = document.createElement('p');
    none.className = 'muted small quiet';
    none.textContent = clientFilter
      ? 'No invoices for this client yet.'
      : 'No invoices yet — select unbilled time above to draft one.';
    list.appendChild(none);
  }
}

// ---------- Invoice preview (the artifact you actually send) ----------

function openPreview(inv) {
  previewInvoice = inv;
  const sheet = $('previewSheet');
  sheet.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'pv-head';
  const title = document.createElement('h2');
  title.textContent = `Invoice ${inv.number}`;
  const status = document.createElement('span');
  status.className = 'pv-status';
  status.textContent = inv.status.toUpperCase();
  head.append(title, status);
  const meta = document.createElement('div');
  meta.className = 'pv-meta';
  const metaCell = (label, value) => {
    const cell = document.createElement('div');
    const l = document.createElement('span');
    l.className = 'pv-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'pv-value';
    v.textContent = value;
    cell.append(l, v);
    return cell;
  };
  meta.append(
    metaCell('Billed to', inv.client),
    metaCell('Issued', fmtDate(inv.issued_on)),
    metaCell('Due', fmtDate(inv.due_on)),
  );
  sheet.append(head, meta);

  const table = document.createElement('table');
  table.className = 'pv-table';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const h of ['Description', 'Hours', 'Rate', 'Amount']) {
    const th = document.createElement('th');
    th.textContent = h;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  const tbody = document.createElement('tbody');
  if (inv.lines?.length) {
    for (const line of inv.lines) {
      const tr = document.createElement('tr');
      const cells = [
        line.description,
        line.hours.toFixed(2),
        fmtMoney(line.unit_price_minor, inv.currency),
        fmtMoney(line.amount_minor, inv.currency),
      ];
      cells.forEach((c, i) => {
        const td = document.createElement('td');
        td.textContent = c;
        if (i > 0) td.className = 'num';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
  } else {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.textContent = 'Professional services';
    const empty1 = document.createElement('td');
    empty1.className = 'num';
    const empty2 = document.createElement('td');
    empty2.className = 'num';
    const amt = document.createElement('td');
    amt.className = 'num';
    amt.textContent = fmtMoney(inv.total_minor, inv.currency);
    tr.append(td, empty1, empty2, amt);
    tbody.appendChild(tr);
  }
  const tfoot = document.createElement('tfoot');
  const fr = document.createElement('tr');
  const fl = document.createElement('td');
  fl.colSpan = 3;
  fl.textContent = 'Total';
  const fv = document.createElement('td');
  fv.className = 'num';
  fv.textContent = fmtMoney(inv.total_minor, inv.currency);
  fr.append(fl, fv);
  tfoot.appendChild(fr);
  table.append(thead, tbody, tfoot);
  sheet.appendChild(table);

  $('previewOverlay').hidden = false;
  document.body.classList.add('previewing');
  $('previewClose').focus();
}

function closePreview() {
  $('previewOverlay').hidden = true;
  document.body.classList.remove('previewing');
  previewInvoice = null;
}

$('previewPrint').addEventListener('click', () => window.print());
$('previewClose').addEventListener('click', closePreview);
$('previewOverlay').addEventListener('click', (e) => {
  if (e.target === $('previewOverlay')) closePreview();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && previewInvoice) closePreview();
});

// ---------- Settle (mark paid) ----------

function openPayPanel(inv) {
  payingInvoice = inv;
  $('payTitle').textContent =
    `Settle ${inv.number} — ${fmtMoney(inv.total_minor, inv.currency)} from ${inv.client}`;
  const candidates = data.credits.filter(
    (t) => t.currency === inv.currency && t.amount_minor >= inv.total_minor,
  );
  fillSelect(
    $('paySelect'),
    candidates.map((t) => ({
      value: t.txn_id,
      label: `${fmtDate(t.posted_at)} · ${fmtMoney(t.amount_minor, t.currency)} · ${t.description || 'incoming'}`,
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
  if (outcome?.status === 'parked') pendingPays.add(payingInvoice.invoice_id);
  if (
    narrate(outcome, 'Settlement parked — the owner confirms the ledger link in vault settings.')
  ) {
    $('payPanel').hidden = true;
    payingInvoice = null;
    await refresh();
  } else if (outcome?.status === 'parked') {
    $('payPanel').hidden = true;
    payingInvoice = null;
    renderInvoices();
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
  const projects = data.projects.filter((p) => matchesFilter(p.client_id));
  for (const p of projects) {
    const row = document.createElement('div');
    row.className = 'row';
    const cell = document.createElement('span');
    cell.className = 'row-text project-cell';
    const name = document.createElement('span');
    name.textContent = p.name;
    cell.appendChild(name);
    // A thin budget bar: logged value (hours × entry rate) against budget.
    if (p.budget_minor != null && p.budget_minor > 0) {
      const ratio = (p.tracked_minor ?? 0) / p.budget_minor;
      const bar = barSpan(ratio);
      bar.classList.add('budget-bar');
      if (ratio > 1) bar.classList.add('budget-over');
      const label = document.createElement('span');
      label.className = 'muted small budget-label';
      label.textContent = `${fmtMoney(p.tracked_minor ?? 0, p.currency)} of ${fmtMoney(p.budget_minor, p.currency)} budget`;
      if (ratio > 1) label.classList.add('over-label');
      cell.append(bar, label);
    }
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
    row.append(cell, client, hours, badge);
    list.appendChild(row);
  }
  if (projects.length === 0 && data.projects.length > 0) {
    const none = document.createElement('p');
    none.className = 'muted small quiet';
    none.textContent = 'No projects for this client.';
    list.appendChild(none);
  }
}

$('addProjectButton').addEventListener('click', () => {
  if ($('projectForm').hidden) openProjectForm();
  else $('projectForm').hidden = true;
});

$('projectForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const clientId = $('projectClient').value;
  const name = $('projectName').value.trim();
  if (!clientId || !name) return;
  const budget = parseFloat($('projectBudget').value);
  const outcome = await act('add-project', {
    client_id: clientId,
    name,
    ...(Number.isFinite(budget) && budget >= 0 ? { budget_minor: Math.round(budget * 100) } : {}),
  });
  if (narrate(outcome)) {
    $('projectName').value = '';
    $('projectBudget').value = '';
    $('projectForm').hidden = true;
    await refresh();
  }
});

// ---------- Clients ----------

function renderClients() {
  const list = $('clientList');
  list.innerHTML = '';
  for (const c of data.clients) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'row client-row';
    if (clientFilter === c.client_id) row.classList.add('filtered');
    row.setAttribute('aria-pressed', String(clientFilter === c.client_id));
    row.title =
      clientFilter === c.client_id ? 'Clear the filter' : `Show only ${c.name} everywhere`;
    const text = document.createElement('span');
    text.className = 'row-text';
    text.textContent = c.name;
    const count = document.createElement('span');
    count.className = 'row-sub';
    count.textContent = `${c.projects} project${c.projects === 1 ? '' : 's'}`;
    const terms = document.createElement('span');
    terms.className = 'row-sub';
    terms.textContent = c.payment_terms_days != null ? `net ${c.payment_terms_days}` : '';
    const rate = document.createElement('span');
    rate.className = 'amount';
    rate.textContent =
      c.default_rate_minor != null ? `${fmtMoney(c.default_rate_minor, c.currency)}/h` : '';
    row.append(text, count, terms, rate);
    row.addEventListener('click', () => setClientFilter(c.client_id));
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
  const terms = parseInt($('clientTerms').value, 10);
  const outcome = await act('add-client', {
    party_id: partyId,
    currency,
    ...(Number.isFinite(rate) && rate >= 0 ? { default_rate_minor: Math.round(rate * 100) } : {}),
    ...(Number.isFinite(terms) && terms >= 0 ? { payment_terms_days: terms } : {}),
  });
  if (narrate(outcome)) {
    $('clientForm').hidden = true;
    $('clientRate').value = '';
    $('clientTerms').value = '';
    await refresh();
  }
});

// ---------- Boot ----------

wireAttachInput($('attachInput'), () => attachTarget);

for (const id of ['timesheet', 'unbilledList', 'invoiceList', 'projectList', 'clientList']) {
  showSkeleton($(id), 2);
}

window.addEventListener('focus', refresh);
refresh();
