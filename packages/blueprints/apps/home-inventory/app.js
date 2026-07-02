// Home inventory — a pure read-only projection over the personal vault.
// Every row rendered here lives in home.asset_item / home.warranty /
// home.maintenance_plan (place names from core.place); the app's own
// data.sqlite stays empty by design. The home domain has no typed
// commands yet, so there are no write paths at all: revoke the grant and
// this page goes dark while the data stays the owner's.

const $ = (id) => document.getElementById(id);

const DUE_WINDOW_DAYS = 30;

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function plusDays(key, days) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function fmtDate(key) {
  try {
    return new Date(`${key}T00:00:00`).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return key;
  }
}

async function refresh() {
  let data;
  try {
    data = await window.centraid.read({ query: 'inventory' });
  } catch {
    return; // transient; the change feed retries
  }
  const denied = data?.vaultDenied;
  $('consentBanner').hidden = !denied;
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    $('maintenanceDue').hidden = true;
    $('itemList').innerHTML = '';
    $('empty').hidden = true;
    return;
  }
  renderMaintenance(data?.maintenance ?? []);
  renderItems(data?.items ?? []);
}

function renderMaintenance(plans) {
  const today = todayKey();
  const horizon = plusDays(today, DUE_WINDOW_DAYS);
  const due = plans.filter((p) => p.next_due_on != null && p.next_due_on <= horizon);
  const section = $('maintenanceDue');
  const rows = $('maintenanceRows');
  rows.innerHTML = '';
  section.hidden = due.length === 0;
  for (const p of due) {
    const overdue = p.next_due_on < today;
    const row = document.createElement('div');
    row.className = 'row';
    if (overdue) row.dataset.due = 'overdue';
    const time = document.createElement('span');
    time.className = 'row-time';
    time.textContent = fmtDate(p.next_due_on);
    const text = document.createElement('span');
    text.className = 'row-text';
    text.textContent = p.item_name ? `${p.name} — ${p.item_name}` : p.name;
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = overdue ? 'overdue' : 'due';
    row.append(time, text, badge);
    rows.appendChild(row);
  }
}

function renderItems(items) {
  const list = $('itemList');
  list.innerHTML = '';
  $('empty').hidden = items.length > 0;
  const byPlace = new Map();
  for (const it of items) {
    const key = it.place_name ?? 'No place recorded';
    if (!byPlace.has(key)) byPlace.set(key, []);
    byPlace.get(key).push(it);
  }
  for (const [place, placeItems] of byPlace) {
    const h = document.createElement('p');
    h.className = 'day-label muted small';
    h.textContent = place;
    list.appendChild(h);
    for (const it of placeItems) {
      list.appendChild(renderRow(it));
    }
  }
}

function renderRow(it) {
  const row = document.createElement('div');
  row.className = 'row';
  const text = document.createElement('span');
  text.className = 'row-text';
  text.textContent = it.name;
  row.appendChild(text);
  if (it.serial_no) {
    const detail = document.createElement('span');
    detail.className = 'row-detail muted small';
    detail.textContent = `Serial ${it.serial_no}`;
    row.appendChild(detail);
  }
  if (it.warranty) {
    const badge = document.createElement('span');
    badge.className = `badge ${it.warranty.active ? 'ok' : 'off'}`;
    badge.textContent = it.warranty.active ? 'covered' : 'expired';
    badge.title = `Warranty ends ${fmtDate(String(it.warranty.ends_on).slice(0, 10))}`;
    row.appendChild(badge);
  }
  return row;
}

window.addEventListener('focus', refresh);
refresh();
