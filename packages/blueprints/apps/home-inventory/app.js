// Home inventory — a projection over the personal vault. Every row
// rendered here lives in home.asset_item / home.warranty /
// home.maintenance_plan (place names from core.place); the app's own
// data.sqlite stays empty by design. Writes go through the home domain's
// typed commands (add_item, update_item, dispose_item, add_warranty)
// routed via this app's action handlers — consent-checked per command and
// receipted. Revoke the grant and this page goes dark while the data
// stays the owner's.

const $ = (id) => document.getElementById(id);

const DUE_WINDOW_DAYS = 30;

// The item id the shared file picker is currently attaching to.
let attachTarget = null;

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
      if (!narrate(outcome, refresh)) break;
    }
    inputEl.value = '';
    await refresh();
  });
}

async function removeAttachment(attachmentId) {
  const outcome = await act('detach', { attachment_id: attachmentId });
  if (narrate(outcome, refresh)) await refresh();
}

// The picker is shared across every item row; each attach button records
// which item it targets before opening it.
wireAttachInput($('attachInput'), () => attachTarget);

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
  $('addForm').hidden = Boolean(denied);
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    $('maintenanceDue').hidden = true;
    $('itemList').innerHTML = '';
    $('disposedSection').hidden = true;
    $('empty').hidden = true;
    return;
  }
  renderMaintenance(data?.maintenance ?? []);
  renderItems(data?.items ?? []);
  renderDisposed(data?.disposed ?? []);
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
  const wrap = document.createElement('div');
  wrap.className = 'item';

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

  // The item's inline forms (edit, warranty) live beneath the row; each
  // control toggles its own and closes the other.
  const editForm = renderEditForm(it);
  const warrantyForm = renderWarrantyForm(it);

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'ghost small-btn';
  edit.textContent = 'Edit';
  edit.addEventListener('click', () => {
    warrantyForm.hidden = true;
    editForm.hidden = !editForm.hidden;
  });
  row.appendChild(edit);

  const warranty = document.createElement('button');
  warranty.type = 'button';
  warranty.className = 'ghost small-btn';
  warranty.textContent = '＋ Warranty';
  warranty.addEventListener('click', () => {
    editForm.hidden = true;
    warrantyForm.hidden = !warrantyForm.hidden;
  });
  row.appendChild(warranty);

  // Disposal keeps the row as history, so the confirm is a second click on
  // the same control, not a modal.
  const dispose = document.createElement('button');
  dispose.type = 'button';
  dispose.className = 'ghost small-btn danger';
  dispose.textContent = 'Dispose';
  dispose.addEventListener('click', async () => {
    if (!dispose.dataset.armed) {
      dispose.dataset.armed = 'true';
      dispose.textContent = 'Really dispose?';
      return;
    }
    const outcome = await act('dispose-item', { item_id: it.item_id });
    if (narrate(outcome, refresh)) await refresh();
    else {
      delete dispose.dataset.armed;
      dispose.textContent = 'Dispose';
    }
  });
  row.appendChild(dispose);

  // An owned item wants photos, a warranty PDF, a receipt — the attach
  // control opens the shared picker with this item as its target.
  const attach = document.createElement('button');
  attach.type = 'button';
  attach.className = 'ghost small-btn attach-item-btn';
  attach.textContent = '＋ Attach';
  attach.addEventListener('click', () => {
    attachTarget = it.item_id;
    $('attachInput').click();
  });
  row.appendChild(attach);
  wrap.appendChild(row);

  wrap.appendChild(editForm);
  wrap.appendChild(warrantyForm);

  // Warranty history: every coverage window the item has accumulated.
  if (it.warranties?.length) {
    const list = document.createElement('div');
    list.className = 'warranty-list muted small';
    for (const w of it.warranties) {
      const line = document.createElement('div');
      line.className = 'warranty-line';
      line.textContent = `Warranty ${fmtDate(String(w.starts_on).slice(0, 10))} – ${fmtDate(String(w.ends_on).slice(0, 10))}${w.active ? '' : ' (expired)'}`;
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
    wrap.appendChild(list);
  }

  const strip = document.createElement('div');
  strip.className = 'attach-strip';
  renderAttachments(strip, it.attachments, removeAttachment);
  wrap.appendChild(strip);

  return wrap;
}

// Inline edit form: name / acquired date / serial. Partial update — only the
// fields that changed travel to home.update_item.
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
  acquired.value = it.acquired_on ? String(it.acquired_on).slice(0, 10) : '';
  acquired.setAttribute('aria-label', 'Acquired on');

  const serial = document.createElement('input');
  serial.type = 'text';
  serial.value = it.serial_no ?? '';
  serial.placeholder = 'Serial no.';
  serial.setAttribute('aria-label', 'Serial number');

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
  });

  form.append(name, acquired, serial, save, cancel);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = { item_id: it.item_id };
    const newName = name.value.trim();
    if (newName && newName !== it.name) input.name = newName;
    if (acquired.value && acquired.value !== String(it.acquired_on ?? '').slice(0, 10)) {
      input.acquired_on = acquired.value;
    }
    const newSerial = serial.value.trim();
    if (newSerial && newSerial !== (it.serial_no ?? '')) input.serial_no = newSerial;
    if (Object.keys(input).length === 1) {
      form.hidden = true;
      return;
    }
    const outcome = await act('update-item', input);
    if (narrate(outcome, refresh)) await refresh();
  });
  return form;
}

// Inline warranty form: coverage window plus an optional claim URL.
function renderWarrantyForm(it) {
  const form = document.createElement('form');
  form.className = 'row-form';
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
  });

  form.append(starts, ends, claim, save, cancel);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!starts.value || !ends.value) return;
    const outcome = await act('add-warranty', {
      item_id: it.item_id,
      starts_on: starts.value,
      ends_on: ends.value,
      ...(claim.value.trim() ? { claim_uri: claim.value.trim() } : {}),
    });
    if (narrate(outcome, refresh)) await refresh();
  });
  return form;
}

// Disposed items stay as history — muted rows in a collapsed section.
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
    time.textContent = fmtDate(String(it.disposed_on).slice(0, 10));
    const text = document.createElement('span');
    text.className = 'row-text';
    text.textContent = it.name;
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'disposed';
    row.append(time, text, badge);
    rows.appendChild(row);
  }
}

// ---------- Add item ----------

$('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('addNameInput').value.trim();
  if (!name) return;
  const acquired = $('addAcquiredInput').value;
  const serial = $('addSerialInput').value.trim();
  const outcome = await act('add-item', {
    name,
    ...(acquired ? { acquired_on: acquired } : {}),
    ...(serial ? { serial_no: serial } : {}),
  });
  if (narrate(outcome, refresh)) {
    $('addNameInput').value = '';
    $('addAcquiredInput').value = '';
    $('addSerialInput').value = '';
    await refresh();
  }
});

window.addEventListener('focus', refresh);
refresh();
