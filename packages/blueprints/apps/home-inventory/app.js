// governance: allow-repo-hygiene file-size-limit blueprints are single-file by design (read wholesale by one agent); Home inventory is a finished product — search, photo grid, detail cards, warranty presets, CSV export — and splitting it would break that "one file" contract.
// Home inventory — a projection over the personal vault. Every row
// rendered here lives in home.asset_item / home.warranty /
// home.maintenance_plan (rooms are core.place rows); the app's own
// data.sqlite stays empty by design. Writes go through the home domain's
// typed commands (add_item, update_item, dispose_item, add_warranty,
// complete_maintenance) routed via this app's action handlers —
// consent-checked per command and receipted. Revoke the grant and this
// page goes dark while the data stays the owner's.

import {
  armConfirm,
  debounce,
  fmtMoney,
  letterAvatar,
  localDayKey,
  readFailed,
  showSkeleton,
  toast,
} from './kit.js';

const $ = (id) => document.getElementById(id);

const DUE_WINDOW_DAYS = 30;
const WARRANTY_SOON_DAYS = 60;

// ---------- UI state ----------
// The item id the shared file picker is currently attaching to.
let attachTarget = null;
// Files picked but not yet sent — they wait for a role chip.
let pendingFiles = [];
let viewMode = 'list'; // 'list' | 'grid'
let searchTerm = '';
// The vault's ranked matches while a term is active ({ items, disposed });
// null while browsing — the browse list is only the recent window.
let searchResults = null;
// The browse window: the inventory query reads only this many owned items
// (newest first). "Show more" grows it; search reaches the rest.
let inventoryWindow = 500;
let inventoryTruncated = false;
// Room filter: '' = all places, NO_PLACE = items without a room, else a
// core.place id.
const NO_PLACE = '__none__';
let activePlace = '';
// One detail card open at a time.
let openItemId = null;
// While an edit/warranty form is open, refreshes park here instead of
// wiping the user's typing; applied when the form closes.
let activeEditor = null;
let renderPending = false;
let lastData = null;
// The currency last typed into a value field — the fallback default when
// the inventory itself doesn't suggest one yet.
let lastCurrency = '';

function notice(text) {
  const el = $('noticeBanner');
  el.textContent = text;
  el.hidden = !text;
}

// One narration for every action outcome; returns true when it executed.
function narrate(outcome, onDenied) {
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
    if (onDenied) onDenied();
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

// ---------- Dates ----------

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function plusDays(key, days) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function plusYears(key, years) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
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

function dayKeyOf(value) {
  return String(value ?? '').slice(0, 10);
}

// ---------- Money (purchase values — the insurance numbers) ----------

// A typed major-units amount → integer minor units, or null when unusable.
function parseMinor(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

// "eur" / " EUR " → "EUR"; anything that isn't three letters → null.
function currencyOf(raw) {
  const c = String(raw ?? '')
    .trim()
    .toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : null;
}

// The currency a new value probably wants: the most common one across the
// inventory, else whatever the user typed last.
function defaultCurrency() {
  const counts = new Map();
  for (const it of lastData?.items ?? []) {
    if (!it.purchase_currency) continue;
    counts.set(it.purchase_currency, (counts.get(it.purchase_currency) ?? 0) + 1);
  }
  let best = '';
  let bestN = 0;
  for (const [cur, n] of counts) {
    if (n > bestN) {
      best = cur;
      bestN = n;
    }
  }
  return best || lastCurrency;
}

// Sum purchase values per currency — minor units across currencies don't add.
function currencyTotals(items) {
  const map = new Map();
  for (const it of items) {
    if (it.purchase_price_minor == null || !it.purchase_currency) continue;
    map.set(
      it.purchase_currency,
      (map.get(it.purchase_currency) ?? 0) + Number(it.purchase_price_minor),
    );
  }
  return map;
}

// "€3,450 + $200" — biggest pile first.
function joinMoney(totals) {
  return [...totals.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .map(([cur, minor]) => fmtMoney(minor, cur))
    .join(' + ');
}

// ---------- Rooms (core.place options) ----------

// Fill a room select: "No room" first, then the owner's places by name.
function fillPlaceSelect(select, selectedId) {
  select.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'No room';
  select.appendChild(none);
  for (const p of lastData?.places ?? []) {
    const opt = document.createElement('option');
    opt.value = p.place_id;
    opt.textContent = p.name;
    select.appendChild(opt);
  }
  select.value = selectedId ?? '';
  if (select.value !== (selectedId ?? '')) select.value = '';
}

// The rooms nav: "All places", one chip per room, plus "No room" when
// unfiled items exist. Counts are whole-inventory — the nav answers
// "what lives in this room?", not "what matches my search?".
function renderPlaceNav() {
  const nav = $('placeNav');
  nav.innerHTML = '';
  const items = lastData?.items ?? [];
  const counts = new Map();
  for (const it of items) {
    const key = it.place_id || NO_PLACE;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const entries = [{ id: '', name: 'All places', count: items.length }];
  for (const p of lastData?.places ?? []) {
    entries.push({ id: p.place_id, name: p.name, count: counts.get(p.place_id) ?? 0 });
  }
  if (counts.has(NO_PLACE)) {
    entries.push({ id: NO_PLACE, name: 'No room', count: counts.get(NO_PLACE) });
  }
  for (const e of entries) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.setAttribute('aria-pressed', String(e.id === activePlace));
    const label = document.createElement('span');
    label.textContent = e.name;
    const count = document.createElement('span');
    count.className = 'chip-count';
    count.textContent = String(e.count);
    chip.append(label, count);
    chip.addEventListener('click', () => {
      activePlace = e.id;
      renderPlaceNav();
      renderItems();
    });
    nav.appendChild(chip);
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

// The item's cover image: a photo-role image first, then any image.
function coverOf(it) {
  const images = (it.attachments ?? []).filter((a) => String(a.media_type).startsWith('image/'));
  return images.find((a) => a.role === 'photo') ?? images[0] ?? null;
}

// Render an attachment strip: images as thumbnails, everything else as a
// download tile — each badged by role so a receipt reads differently from a
// photo, each with a remove control wired to the detach action.
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
    if (a.role && a.role !== 'photo') {
      const role = document.createElement('span');
      role.className = 'attach-role';
      role.textContent = a.role;
      tile.appendChild(role);
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

// The picker is shared across every item; each attach button records which
// item it targets before opening it. Chosen files wait for a role chip
// (photo / receipt / warranty / manual) before they travel.
$('attachInput').addEventListener('change', () => {
  if (!attachTarget || $('attachInput').files.length === 0) return;
  pendingFiles = [...$('attachInput').files];
  $('attachInput').value = '';
  renderItems();
});

async function sendPendingFiles(role) {
  const subjectId = attachTarget;
  const files = pendingFiles;
  pendingFiles = [];
  if (!subjectId) return;
  for (const file of files) {
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
      ...(role ? { role } : {}),
    });
    if (!narrate(outcome, refresh)) break;
  }
  await refresh();
}

async function removeAttachment(attachmentId) {
  const outcome = await act('detach', { attachment_id: attachmentId });
  if (narrate(outcome, refresh)) await refresh();
}

// ---------- Read + top-level render ----------

let readWasFailing = false;

async function refresh() {
  let data;
  try {
    data = await window.centraid.read({ query: 'inventory', input: { limit: inventoryWindow } });
  } catch {
    readFailed($('noticeBanner'));
    readWasFailing = true;
    // First load: swap the skeleton for the banner instead of shimmering forever.
    if (lastData === null) $('itemList').innerHTML = '';
    return;
  }
  if (readWasFailing) {
    readWasFailing = false;
    notice('');
  }
  const denied = data?.vaultDenied;
  $('consentBanner').hidden = !denied;
  $('addForm').hidden = Boolean(denied);
  $('toolbar').hidden = Boolean(denied);
  $('sideNav').hidden = Boolean(denied);
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    $('placeNav').innerHTML = '';
    $('maintenanceDue').hidden = true;
    $('warrantyExpiring').hidden = true;
    $('itemList').innerHTML = '';
    $('disposedSection').hidden = true;
    $('empty').hidden = true;
    $('noMatches').hidden = true;
    return;
  }
  lastData = data;
  inventoryTruncated = Boolean(data?.truncated);
  // A room that vanished from the vault can't stay selected — fall back to
  // all places (same for "No room" once every item is filed somewhere).
  if (
    activePlace &&
    (activePlace === NO_PLACE
      ? !(data?.items ?? []).some((it) => !it.place_id)
      : !(data?.places ?? []).some((p) => p.place_id === activePlace))
  ) {
    activePlace = '';
  }
  renderPlaceNav();
  refreshAddFormPickers();
  renderTotalValue(data?.items ?? []);
  renderMaintenance(data?.maintenance ?? []);
  renderExpiring(data?.items ?? []);
  renderDisposedShelf();
  if (activeEditor) {
    // Someone is typing in an edit or warranty form — don't wipe it.
    renderPending = true;
    return;
  }
  renderItems();
}

// Keep the add form's room options current without stomping what the user
// already picked or typed.
function refreshAddFormPickers() {
  const select = $('addPlaceSelect');
  fillPlaceSelect(select, select.value);
  const currency = $('addCurrencyInput');
  if (!currency.value && document.activeElement !== currency) {
    currency.value = defaultCurrency();
  }
}

// The grand total in the header — the number an insurer asks for.
function renderTotalValue(items) {
  const el = $('totalValue');
  const totals = currencyTotals(items);
  el.hidden = totals.size === 0;
  el.textContent = totals.size > 0 ? `Total value ${joinMoney(totals)}` : '';
}

function editorClosed() {
  activeEditor = null;
  if (renderPending) {
    renderPending = false;
    renderItems();
  }
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
    // Done stamps last_done_on with today's local date; on refresh the
    // rrule math rolls the next due date forward and this row clears.
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'ghost done-btn';
    done.textContent = 'Done';
    done.addEventListener('click', async () => {
      done.disabled = true;
      const doneOn = localDayKey(new Date());
      const outcome = await act('complete-maintenance', { plan_id: p.plan_id, done_on: doneOn });
      if (narrate(outcome, refresh)) {
        const next = nextDueFrom(p.rrule, doneOn);
        toast(next ? `Marked done — next due ${fmtDate(next)}` : 'Marked done');
        await refresh();
      } else {
        done.disabled = false;
      }
    });
    row.append(time, text, badge, done);
    rows.appendChild(row);
  }
}

// The same FREQ/INTERVAL projection the inventory query applies to
// last_done_on — computed here so the toast can name the new due date
// before the refresh lands. An rrule we can't read yields null.
function nextDueFrom(rrule, doneOn) {
  const freq = /FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/i.exec(rrule ?? '')?.[1]?.toUpperCase();
  if (!freq) return null;
  const interval = Math.max(1, Number(/INTERVAL=(\d+)/i.exec(rrule ?? '')?.[1] ?? 1));
  const d = new Date(`${doneOn}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  if (freq === 'DAILY') d.setUTCDate(d.getUTCDate() + interval);
  else if (freq === 'WEEKLY') d.setUTCDate(d.getUTCDate() + 7 * interval);
  else if (freq === 'MONTHLY') d.setUTCMonth(d.getUTCMonth() + interval);
  else d.setUTCFullYear(d.getUTCFullYear() + interval);
  return d.toISOString().slice(0, 10);
}

// Warranties ending within 60 days — surfaced beside Maintenance due so
// coverage runs out in view, not in a tooltip.
function renderExpiring(items) {
  const today = todayKey();
  const horizon = plusDays(today, WARRANTY_SOON_DAYS);
  const soon = items
    .filter((it) => {
      const end = it.warranty?.active ? dayKeyOf(it.warranty.ends_on) : null;
      return end != null && end >= today && end <= horizon;
    })
    .toSorted((a, b) => dayKeyOf(a.warranty.ends_on).localeCompare(dayKeyOf(b.warranty.ends_on)));
  const section = $('warrantyExpiring');
  const rows = $('warrantyExpiringRows');
  rows.innerHTML = '';
  section.hidden = soon.length === 0;
  for (const it of soon) {
    const end = dayKeyOf(it.warranty.ends_on);
    const row = document.createElement('div');
    row.className = 'row';
    const time = document.createElement('span');
    time.className = 'row-time';
    time.textContent = fmtDate(end);
    const text = document.createElement('span');
    text.className = 'row-text';
    text.textContent = it.name;
    const badge = document.createElement('span');
    badge.className = 'badge warn';
    const days = Math.max(
      0,
      Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000),
    );
    badge.textContent = days === 0 ? 'ends today' : `${days}d left`;
    row.append(time, text, badge);
    rows.appendChild(row);
  }
}

// ---------- Items: search, groups, list/grid ----------

function placeKeyOf(it) {
  return it.place_name ?? 'No place recorded';
}

// Render a vault search snippet from text nodes only — the ⟦…⟧ hit markers
// the vault returns become <mark>, and item text never parses as HTML.
function snippetInto(el, snippet) {
  const parts = String(snippet ?? '').split(/[⟦⟧]/);
  for (let i = 0; i < parts.length; i += 1) {
    if (!parts[i]) continue;
    if (i % 2 === 1) {
      const mark = document.createElement('mark');
      mark.textContent = parts[i];
      el.appendChild(mark);
    } else {
      el.appendChild(document.createTextNode(parts[i]));
    }
  }
}

function renderItems() {
  const list = $('itemList');
  const all = lastData?.items ?? [];
  // The room filter narrows the browse list, and — while a term is active —
  // the vault's ranked matches too, so the nav constrains what search shows.
  const inRoom = (items) =>
    activePlace
      ? items.filter((it) =>
          activePlace === NO_PLACE ? !it.place_id : it.place_id === activePlace,
        )
      : items;
  const inPlace = inRoom(all);
  const term = searchTerm.trim();
  // While a term is active the list IS the vault's ranked matches — search
  // reaches every item in the vault, not just the browse window's slice —
  // then narrowed to the active room.
  const shown = term ? inRoom(searchResults?.items ?? []) : inPlace;
  if (openItemId && !shown.some((it) => it.item_id === openItemId)) openItemId = null;

  $('empty').hidden = term ? true : all.length > 0;
  // "No matches" covers both an empty search and an empty room; the copy
  // switches to name whichever filter is in force.
  $('noMatches').hidden = !((term || activePlace) && all.length > 0 && shown.length === 0);
  $('noMatches').textContent = term ? 'No items match your search.' : 'Nothing in this room yet.';
  list.classList.toggle('grid-view', viewMode === 'grid');
  list.innerHTML = '';

  const totals = new Map();
  const allByPlace = new Map();
  for (const it of all) {
    const key = placeKeyOf(it);
    totals.set(key, (totals.get(key) ?? 0) + 1);
    if (!allByPlace.has(key)) allByPlace.set(key, []);
    allByPlace.get(key).push(it);
  }

  const byPlace = new Map();
  for (const it of shown) {
    const key = placeKeyOf(it);
    if (!byPlace.has(key)) byPlace.set(key, []);
    byPlace.get(key).push(it);
  }

  for (const [place, placeItems] of byPlace) {
    const h = document.createElement('p');
    h.className = 'day-label muted small';
    // Browsing: "Kitchen · 12 items · €3,450" — the room's value subtotal
    // (per currency). Searching: matches only — search reaches beyond the
    // browse window, so window-derived totals would lie next to the hits.
    let bits;
    if (term) {
      bits = [place, `${placeItems.length} match${placeItems.length === 1 ? '' : 'es'}`];
    } else {
      const total = totals.get(place);
      bits = [place, `${total} item${total === 1 ? '' : 's'}`];
      const roomTotals = currencyTotals(allByPlace.get(place) ?? []);
      if (roomTotals.size > 0) bits.push(joinMoney(roomTotals));
    }
    h.textContent = bits.join(' · ');
    list.appendChild(h);

    if (viewMode === 'grid') {
      const grid = document.createElement('div');
      grid.className = 'place-grid';
      for (const it of placeItems) {
        grid.appendChild(renderCard(it));
        if (it.item_id === openItemId) {
          const detail = renderDetail(it);
          detail.classList.add('grid-span');
          grid.appendChild(detail);
        }
      }
      list.appendChild(grid);
    } else {
      for (const it of placeItems) {
        const wrap = document.createElement('div');
        wrap.className = 'item';
        wrap.appendChild(renderRow(it));
        if (it.item_id === openItemId) wrap.appendChild(renderDetail(it));
        list.appendChild(wrap);
      }
    }
  }

  // The window is honest about its edge: browsing shows the newest slice,
  // "Show more" grows it, search reaches every item beyond it.
  if (inventoryTruncated && !term) {
    const footer = document.createElement('div');
    footer.className = 'window-footer';
    const label = document.createElement('span');
    label.textContent = `Showing your newest ${inventoryWindow} items — older ones are a search away. `;
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'ghost';
    more.textContent = 'Show more';
    more.addEventListener('click', async () => {
      inventoryWindow += 500;
      more.disabled = true;
      await refresh();
    });
    footer.append(label, more);
    list.appendChild(footer);
  }
}

function toggleDetail(itemId) {
  const wasOpen = openItemId === itemId;
  openItemId = wasOpen ? null : itemId;
  pendingFiles = [];
  renderItems();
  if (!wasOpen) {
    document.querySelector(`.item-detail[data-item-id="${itemId}"]`)?.focus();
  } else {
    focusItemTrigger(itemId);
  }
}

function focusItemTrigger(itemId) {
  document.querySelector(`[data-item-trigger="${itemId}"]`)?.focus();
}

function thumbOf(it, size) {
  const cover = coverOf(it);
  const holder = document.createElement('span');
  holder.className = 'thumb';
  holder.style.width = size;
  holder.style.height = size;
  if (cover) {
    const img = document.createElement('img');
    img.src = cover.content_uri;
    img.alt = '';
    img.loading = 'lazy';
    holder.appendChild(img);
  } else {
    holder.appendChild(letterAvatar(it.name, { size }));
  }
  return holder;
}

function warrantyBadge(it) {
  if (!it.warranty) return null;
  const badge = document.createElement('span');
  badge.className = `badge ${it.warranty.active ? 'ok' : 'off'}`;
  badge.textContent = it.warranty.active ? 'covered' : 'expired';
  return badge;
}

// List view: one calm row — photo thumb, name, serial, warranty badge.
// Everything else waits inside the detail card.
function renderRow(it) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'item-row';
  row.dataset.itemTrigger = it.item_id;
  row.setAttribute('aria-expanded', String(openItemId === it.item_id));

  row.appendChild(thumbOf(it, '2.75rem'));

  const text = document.createElement('span');
  text.className = 'row-text';
  text.textContent = it.name;
  row.appendChild(text);

  // A vault match carries its own snippet (⟦…⟧ around the hit in the name
  // or serial) — show why the row matched instead of the bare serial line.
  if (searchTerm.trim() && it.snippet) {
    const detail = document.createElement('span');
    detail.className = 'row-detail muted small';
    snippetInto(detail, it.snippet);
    row.appendChild(detail);
  } else if (it.serial_no) {
    const detail = document.createElement('span');
    detail.className = 'row-detail muted small';
    detail.textContent = `Serial ${it.serial_no}`;
    row.appendChild(detail);
  }
  const badge = warrantyBadge(it);
  if (badge) row.appendChild(badge);

  row.addEventListener('click', () => toggleDetail(it.item_id));
  return row;
}

// Grid view: Sortly-style photo card with a name+meta overlay.
function renderCard(it) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'grid-card';
  card.dataset.itemTrigger = it.item_id;
  card.setAttribute('aria-expanded', String(openItemId === it.item_id));

  const cover = coverOf(it);
  if (cover) {
    const img = document.createElement('img');
    img.src = cover.content_uri;
    img.alt = '';
    img.loading = 'lazy';
    card.appendChild(img);
  } else {
    const tile = document.createElement('span');
    tile.className = 'grid-letter';
    tile.appendChild(letterAvatar(it.name, { size: '3.5rem' }));
    card.appendChild(tile);
  }

  const overlay = document.createElement('span');
  overlay.className = 'grid-overlay';
  const name = document.createElement('span');
  name.className = 'grid-name';
  name.textContent = it.name;
  overlay.appendChild(name);
  const meta = document.createElement('span');
  meta.className = 'grid-meta';
  const bits = [];
  if (it.serial_no) bits.push(`Serial ${it.serial_no}`);
  const attachCount = it.attachments?.length ?? 0;
  if (attachCount > 0) bits.push(`${attachCount} file${attachCount === 1 ? '' : 's'}`);
  meta.textContent = bits.join(' · ');
  overlay.appendChild(meta);
  card.appendChild(overlay);

  const badge = warrantyBadge(it);
  if (badge) {
    badge.classList.add('grid-badge');
    card.appendChild(badge);
  }

  card.addEventListener('click', () => toggleDetail(it.item_id));
  return card;
}

// ---------- Detail card (one open at a time) ----------

function renderDetail(it) {
  const card = document.createElement('div');
  card.className = 'item-detail';
  card.dataset.itemId = it.item_id;
  card.tabIndex = -1;
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      openItemId = null;
      pendingFiles = [];
      editorClosed();
      renderItems();
      focusItemTrigger(it.item_id);
    }
  });

  const head = document.createElement('div');
  head.className = 'detail-head';
  head.appendChild(thumbOf(it, '3.5rem'));
  const headText = document.createElement('div');
  headText.className = 'detail-head-text';
  const name = document.createElement('strong');
  name.textContent = it.name;
  headText.appendChild(name);
  const meta = document.createElement('span');
  meta.className = 'muted small';
  const bits = [placeKeyOf(it)];
  if (it.serial_no) bits.push(`Serial ${it.serial_no}`);
  if (it.acquired_on) bits.push(`Acquired ${fmtDate(dayKeyOf(it.acquired_on))}`);
  if (it.purchase_price_minor != null && it.purchase_currency) {
    bits.push(`Worth ${fmtMoney(it.purchase_price_minor, it.purchase_currency)}`);
  }
  meta.textContent = bits.join(' · ');
  headText.appendChild(meta);
  // Coverage as visible text — never only a hover tooltip.
  const coverage = document.createElement('span');
  coverage.className = 'coverage small';
  if (it.warranty?.active) {
    coverage.classList.add('ok');
    coverage.textContent = `Covered until ${fmtDate(dayKeyOf(it.warranty.ends_on))}`;
  } else if (it.warranty) {
    coverage.classList.add('off');
    coverage.textContent = `Warranty expired ${fmtDate(dayKeyOf(it.warranty.ends_on))}`;
  } else {
    coverage.classList.add('off');
    coverage.textContent = 'No warranty recorded';
  }
  headText.appendChild(coverage);
  head.appendChild(headText);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'ghost detail-close';
  close.textContent = 'Close';
  close.addEventListener('click', () => {
    openItemId = null;
    pendingFiles = [];
    editorClosed();
    renderItems();
    focusItemTrigger(it.item_id);
  });
  head.appendChild(close);
  card.appendChild(head);

  const editForm = renderEditForm(it);
  const warrantyForm = renderWarrantyForm(it);

  const actions = document.createElement('div');
  actions.className = 'detail-actions';

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'ghost';
  edit.textContent = 'Edit';
  edit.addEventListener('click', () => {
    warrantyForm.hidden = true;
    editForm.hidden = !editForm.hidden;
    if (!editForm.hidden) {
      activeEditor = 'edit';
      editForm.querySelector('input')?.focus();
    } else {
      editorClosed();
      edit.focus();
    }
  });
  actions.appendChild(edit);

  const warranty = document.createElement('button');
  warranty.type = 'button';
  warranty.className = 'ghost';
  warranty.textContent = '＋ Warranty';
  warranty.addEventListener('click', () => {
    editForm.hidden = true;
    warrantyForm.hidden = !warrantyForm.hidden;
    if (!warrantyForm.hidden) {
      activeEditor = 'warranty';
      warrantyForm.querySelector('input')?.focus();
    } else {
      editorClosed();
      warranty.focus();
    }
  });
  actions.appendChild(warranty);

  // An owned item wants photos, a warranty PDF, a receipt — the attach
  // control opens the shared picker with this item as its target.
  const attach = document.createElement('button');
  attach.type = 'button';
  attach.className = 'ghost';
  attach.textContent = '＋ Attach';
  attach.addEventListener('click', () => {
    // Close any open editor first — the role prompt re-renders the list,
    // which would otherwise wipe half-typed edits.
    editForm.hidden = true;
    warrantyForm.hidden = true;
    editorClosed();
    attachTarget = it.item_id;
    $('attachInput').click();
  });
  actions.appendChild(attach);

  // Disposal keeps the row as history; the confirm is a second click on the
  // same control (kit-armed, so it disarms itself if abandoned).
  const dispose = document.createElement('button');
  dispose.type = 'button';
  dispose.className = 'ghost danger';
  dispose.textContent = 'Dispose';
  dispose.addEventListener('click', async () => {
    if (!armConfirm(dispose, { armedLabel: 'Really dispose?' })) return;
    const outcome = await act('dispose-item', { item_id: it.item_id });
    if (narrate(outcome, refresh)) {
      openItemId = null;
      await refresh();
    }
  });
  actions.appendChild(dispose);
  card.appendChild(actions);

  // Picked files wait here for a role before the bytes travel.
  if (pendingFiles.length > 0 && attachTarget === it.item_id) {
    card.appendChild(renderRolePrompt());
  }

  card.appendChild(editForm);
  card.appendChild(warrantyForm);

  // Warranty history: every coverage window the item has accumulated.
  if (it.warranties?.length) {
    const list = document.createElement('div');
    list.className = 'warranty-list muted small';
    for (const w of it.warranties) {
      const line = document.createElement('div');
      line.className = 'warranty-line';
      line.textContent = `Warranty ${fmtDate(dayKeyOf(w.starts_on))} – ${fmtDate(dayKeyOf(w.ends_on))}${w.active ? '' : ' (expired)'}`;
      if (w.claim_uri) {
        const link = document.createElement('a');
        link.href = w.claim_uri;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.textContent = 'claim';
        line.append(' · ', link);
      }
      list.appendChild(line);
    }
    card.appendChild(list);
  }

  const strip = document.createElement('div');
  strip.className = 'attach-strip';
  renderAttachments(strip, it.attachments, removeAttachment);
  card.appendChild(strip);

  return card;
}

// Role chips shown after picking files: what kind of document is this?
function renderRolePrompt() {
  const wrap = document.createElement('div');
  wrap.className = 'role-prompt';
  const label = document.createElement('span');
  label.className = 'muted small';
  const n = pendingFiles.length;
  label.textContent = `${n} file${n === 1 ? '' : 's'} picked — attach as:`;
  wrap.appendChild(label);
  for (const [role, text] of [
    ['photo', 'Photo'],
    ['receipt', 'Receipt'],
    ['warranty', 'Warranty'],
    ['manual', 'Manual'],
  ]) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = text;
    chip.addEventListener('click', () => sendPendingFiles(role));
    wrap.appendChild(chip);
  }
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ghost';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => {
    pendingFiles = [];
    renderItems();
  });
  wrap.appendChild(cancel);
  return wrap;
}

// Inline edit form: name / acquired date / serial / room / value. Partial
// update — only the fields that changed travel to home.update_item.
function renderEditForm(it) {
  const form = document.createElement('form');
  form.className = 'row-form';
  form.autocomplete = 'off';
  form.hidden = true;

  const name = document.createElement('input');
  name.type = 'text';
  name.value = it.name;
  name.setAttribute('aria-label', 'Item name');

  const acquired = document.createElement('input');
  acquired.type = 'date';
  acquired.value = it.acquired_on ? dayKeyOf(it.acquired_on) : '';
  acquired.setAttribute('aria-label', 'Acquired on');

  const serial = document.createElement('input');
  serial.type = 'text';
  serial.value = it.serial_no ?? '';
  serial.placeholder = 'Serial no.';
  serial.setAttribute('aria-label', 'Serial number');

  const place = document.createElement('select');
  place.setAttribute('aria-label', 'Room');
  fillPlaceSelect(place, it.place_id ?? '');

  const value = document.createElement('input');
  value.type = 'number';
  value.min = '0';
  value.step = '0.01';
  value.className = 'value-input';
  value.placeholder = 'Value';
  value.setAttribute('aria-label', 'Purchase value');
  if (it.purchase_price_minor != null) value.value = (it.purchase_price_minor / 100).toFixed(2);

  const currency = document.createElement('input');
  currency.type = 'text';
  currency.maxLength = 3;
  currency.className = 'currency-input';
  currency.placeholder = 'EUR';
  currency.setAttribute('aria-label', 'Currency (3 letters)');
  currency.value = it.purchase_currency ?? defaultCurrency();

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
    focusItemTrigger(it.item_id);
  });

  form.append(name, acquired, serial, place, value, currency, save, cancel);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = { item_id: it.item_id };
    const newName = name.value.trim();
    if (newName && newName !== it.name) input.name = newName;
    if (acquired.value && acquired.value !== dayKeyOf(it.acquired_on ?? '')) {
      input.acquired_on = acquired.value;
    }
    const newSerial = serial.value.trim();
    if (newSerial && newSerial !== (it.serial_no ?? '')) input.serial_no = newSerial;
    // home.update_item can move an item between rooms but has no way to
    // clear one (place_id refuses the empty string) — be honest about it.
    if (!place.value && it.place_id) {
      notice('The vault can move an item to another room, but not clear the room yet.');
      return;
    }
    if (place.value && place.value !== (it.place_id ?? '')) input.place_id = place.value;
    const rawValue = value.value.trim();
    if (rawValue !== '') {
      const minor = parseMinor(rawValue);
      if (minor == null) {
        notice('Value must be a non-negative amount.');
        return;
      }
      const cur = currencyOf(currency.value);
      if (!cur) {
        notice('A value needs its 3-letter currency, e.g. EUR.');
        return;
      }
      if (minor !== (it.purchase_price_minor ?? null)) input.purchase_price_minor = minor;
      if (cur !== (it.purchase_currency ?? '')) input.purchase_currency = cur;
      lastCurrency = cur;
    }
    if (Object.keys(input).length === 1) {
      form.hidden = true;
      editorClosed();
      return;
    }
    activeEditor = null;
    const outcome = await act('update-item', input);
    if (narrate(outcome, refresh)) {
      await refresh();
      focusItemTrigger(it.item_id);
    }
  });
  return form;
}

// Inline warranty form: coverage window plus an optional claim URL, with
// preset chips so the common cases are one tap.
function renderWarrantyForm(it) {
  const form = document.createElement('form');
  form.className = 'row-form warranty-form';
  form.autocomplete = 'off';
  form.hidden = true;

  const starts = document.createElement('input');
  starts.type = 'date';
  starts.setAttribute('aria-label', 'Warranty starts');

  const ends = document.createElement('input');
  ends.type = 'date';
  ends.setAttribute('aria-label', 'Warranty ends');

  const claim = document.createElement('input');
  claim.type = 'url';
  claim.placeholder = 'Claim URL (optional)';
  claim.setAttribute('aria-label', 'Claim URL');

  const presets = document.createElement('div');
  presets.className = 'preset-row';
  const preset = (label, fill) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = label;
    chip.addEventListener('click', fill);
    presets.appendChild(chip);
  };
  preset('1 yr', () => {
    if (!starts.value) starts.value = todayKey();
    ends.value = plusYears(starts.value, 1);
  });
  preset('2 yrs', () => {
    if (!starts.value) starts.value = todayKey();
    ends.value = plusYears(starts.value, 2);
  });
  preset('From purchase', () => {
    starts.value = it.acquired_on ? dayKeyOf(it.acquired_on) : todayKey();
    if (!ends.value) ends.value = plusYears(starts.value, 1);
  });

  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'primary small-btn';
  save.textContent = 'Add warranty';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ghost';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => {
    form.hidden = true;
    editorClosed();
    focusItemTrigger(it.item_id);
  });

  form.append(presets, starts, ends, claim, save, cancel);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!starts.value || !ends.value) return;
    activeEditor = null;
    const outcome = await act('add-warranty', {
      item_id: it.item_id,
      starts_on: starts.value,
      ends_on: ends.value,
      ...(claim.value.trim() ? { claim_uri: claim.value.trim() } : {}),
    });
    if (narrate(outcome, refresh)) {
      await refresh();
      focusItemTrigger(it.item_id);
    }
  });
  return form;
}

// The disposed shelf follows the active source: the vault's matched
// disposals while a term is active (search reaches disposals older than
// the fixed 200-row history shelf), the browse shelf otherwise.
function renderDisposedShelf() {
  const term = searchTerm.trim();
  renderDisposed(term ? (searchResults?.disposed ?? []) : (lastData?.disposed ?? []));
}

// Disposed items stay as history — muted rows in a collapsed section, with
// enough detail (serial, place) to answer "which one was that?".
function renderDisposed(items) {
  const section = $('disposedSection');
  const rows = $('disposedRows');
  rows.innerHTML = '';
  section.hidden = items.length === 0;
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.disposed = 'true';
    const time = document.createElement('span');
    time.className = 'row-time';
    time.textContent = fmtDate(dayKeyOf(it.disposed_on));
    const text = document.createElement('span');
    text.className = 'row-text';
    text.textContent = it.name;
    const bits = [];
    if (it.serial_no) bits.push(`Serial ${it.serial_no}`);
    if (it.place_name) bits.push(it.place_name);
    if (bits.length > 0) {
      const detail = document.createElement('span');
      detail.className = 'row-detail muted small';
      detail.textContent = bits.join(' · ');
      row.append(time, text, detail);
    } else {
      row.append(time, text);
    }
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'disposed';
    row.appendChild(badge);
    rows.appendChild(row);
  }
}

// ---------- CSV export (the insurance deliverable) ----------

function csvField(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv() {
  const items = lastData?.items ?? [];
  const lines = [
    [
      'Name',
      'Place',
      'Serial',
      'Acquired on',
      'Value',
      'Currency',
      'Warranty ends',
      'Attachments',
    ].join(','),
  ];
  for (const it of items) {
    lines.push(
      [
        csvField(it.name),
        csvField(it.place_name ?? ''),
        csvField(it.serial_no ?? ''),
        csvField(it.acquired_on ? dayKeyOf(it.acquired_on) : ''),
        // Major units — the number an insurer or spreadsheet expects.
        csvField(it.purchase_price_minor != null ? (it.purchase_price_minor / 100).toFixed(2) : ''),
        csvField(it.purchase_currency ?? ''),
        csvField(it.warranty ? dayKeyOf(it.warranty.ends_on) : ''),
        csvField(it.attachments?.length ?? 0),
      ].join(','),
    );
  }
  const a = document.createElement('a');
  a.href = `data:text/csv;charset=utf-8,${encodeURIComponent(lines.join('\r\n'))}`;
  a.download = `home-inventory-${todayKey()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------- Add item ----------

$('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('addNameInput').value.trim();
  if (!name) return;
  const acquired = $('addAcquiredInput').value;
  const serial = $('addSerialInput').value.trim();
  const placeId = $('addPlaceSelect').value;
  // A value travels as minor units plus its currency — the vault refuses
  // one without the other, so the form does too.
  const rawValue = $('addValueInput').value.trim();
  let priceFields = {};
  if (rawValue !== '') {
    const minor = parseMinor(rawValue);
    if (minor == null) {
      notice('Value must be a non-negative amount.');
      return;
    }
    const cur = currencyOf($('addCurrencyInput').value);
    if (!cur) {
      notice('A value needs its 3-letter currency, e.g. EUR.');
      return;
    }
    priceFields = { purchase_price_minor: minor, purchase_currency: cur };
    lastCurrency = cur;
  }
  const outcome = await act('add-item', {
    name,
    ...(acquired ? { acquired_on: acquired } : {}),
    ...(serial ? { serial_no: serial } : {}),
    ...(placeId ? { place_id: placeId } : {}),
    ...priceFields,
  });
  if (narrate(outcome, refresh)) {
    $('addNameInput').value = '';
    $('addAcquiredInput').value = '';
    $('addSerialInput').value = '';
    $('addValueInput').value = '';
    $('addCurrencyInput').value = defaultCurrency();
    await refresh();
  }
});

// ---------- Toolbar wiring ----------

// Searching asks the vault, not a local copy: the FTS5 index matches name
// and serial over every item inside SQLite and returns only the hits, so
// the app never greps an unbounded table in memory. `searchSeq` drops
// stale replies when the owner types faster than the vault answers.
let searchSeq = 0;
$('searchInput').addEventListener(
  'input',
  debounce(async () => {
    searchTerm = $('searchInput').value;
    const raw = searchTerm.trim();
    if (!raw) {
      searchResults = null;
      renderItems();
      renderDisposedShelf();
      return;
    }
    const seq = ++searchSeq;
    let data = null;
    try {
      data = await window.centraid.read({ query: 'search', input: { term: raw } });
    } catch {
      data = null;
    }
    if (seq !== searchSeq) return;
    searchResults = { items: data?.items ?? [], disposed: data?.disposed ?? [] };
    renderItems();
    renderDisposedShelf();
  }, 250),
);

function setView(mode) {
  viewMode = mode;
  $('viewListBtn').setAttribute('aria-pressed', String(mode === 'list'));
  $('viewGridBtn').setAttribute('aria-pressed', String(mode === 'grid'));
  renderItems();
}

$('viewListBtn').addEventListener('click', () => setView('list'));
$('viewGridBtn').addEventListener('click', () => setView('grid'));
$('exportBtn').addEventListener('click', exportCsv);

// ---------- Boot ----------

showSkeleton($('itemList'), 5);
window.addEventListener('focus', refresh);
refresh();
