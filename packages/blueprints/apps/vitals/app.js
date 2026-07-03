// Vitals — a pure projection over the personal vault. Every reading rendered
// here is a core.observation row wearing its health.vital extension; every
// mutation is a typed vault command routed through this app's handlers
// (ctx.vault on the gateway side). The app's own data.sqlite stays empty by
// design: revoke the grant and this page goes dark while the model, history
// and receipts remain the owner's.

const $ = (id) => document.getElementById(id);

const VITAL_LABELS = {
  heart_rate: 'Heart rate',
  bp_systolic: 'BP systolic',
  bp_diastolic: 'BP diastolic',
  spo2: 'SpO₂',
  body_weight: 'Body weight',
  glucose: 'Glucose',
  temp: 'Temperature',
};

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function dayKey(iso) {
  return String(iso).slice(0, 10);
}

function fmtDay(key) {
  const today = new Date().toISOString().slice(0, 10);
  if (key === today) return 'Today';
  try {
    return new Date(`${key}T00:00:00`).toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return key;
  }
}

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

// The reading whose attach button was last clicked — one shared hidden file
// input serves every row, so the change handler needs to know the target.
let attachTarget = null;

async function removeAttachment(attachmentId) {
  const outcome = await act('detach', { attachment_id: attachmentId });
  if (narrate(outcome, refresh)) await refresh();
}

async function refresh() {
  let data;
  try {
    data = await window.centraid.read({ query: 'readings' });
  } catch {
    return; // transient; the change feed retries
  }
  const denied = data?.vaultDenied;
  $('consentBanner').hidden = !denied;
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    $('logForm').hidden = true;
    $('sparkPanel').hidden = true;
    $('readingList').innerHTML = '';
    $('empty').hidden = true;
    return;
  }
  $('logForm').hidden = false;
  readings = data?.readings ?? [];
  renderSparkline();
  renderReadings(readings);
}

let readings = [];

// ---------- Sparkline: the selected vital's series as inline SVG ----------

const SPARK_W = 600;
const SPARK_H = 96;
const SPARK_PAD = 6;

function renderSparkline() {
  const vitalType = $('typeSelect').value;
  // The query returns newest first; the line wants chronological order.
  const series = readings
    .filter((r) => r.vital_type === vitalType && Number.isFinite(r.value_num))
    .toReversed();
  const panel = $('sparkPanel');
  panel.hidden = series.length < 2;
  if (series.length < 2) return;

  const values = series.map((r) => r.value_num);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1; // a flat series draws a midline, not NaN
  const step = (SPARK_W - SPARK_PAD * 2) / (series.length - 1);
  const y = (v) => SPARK_H - SPARK_PAD - ((v - min) / span) * (SPARK_H - SPARK_PAD * 2);
  const points = series.map((r, i) => [SPARK_PAD + i * step, y(r.value_num)]);
  const path = points
    .map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`)
    .join(' ');
  const area = `${path} L${points[points.length - 1][0].toFixed(1)},${SPARK_H - SPARK_PAD} L${SPARK_PAD},${SPARK_H - SPARK_PAD} Z`;
  const last = points[points.length - 1];

  $('sparkChart').innerHTML =
    `<svg viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" role="img" aria-label="Trend line">` +
    `<path d="${area}" class="spark-area"></path>` +
    `<path d="${path}" class="spark-line"></path>` +
    `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3.5" class="spark-dot"></circle>` +
    `</svg>`;

  const latest = series[series.length - 1];
  const unit = latest.unit ?? '';
  $('sparkTitle').textContent = VITAL_LABELS[vitalType] ?? vitalType;
  $('sparkLatest').textContent = `${latest.value_num} ${unit}`.trim();
  $('sparkMin').textContent = `min ${min}`;
  $('sparkMax').textContent = `max ${max}`;
  $('sparkCount').textContent = `${series.length} readings`;
}

$('typeSelect').addEventListener('change', renderSparkline);

function renderReadings(readings) {
  const list = $('readingList');
  list.innerHTML = '';
  $('empty').hidden = readings.length > 0;
  const byDay = new Map();
  for (const r of readings) {
    const key = dayKey(r.observed_at);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(r);
  }
  for (const [key, dayReadings] of byDay) {
    const h = document.createElement('p');
    h.className = 'day-label muted small';
    h.textContent = fmtDay(key);
    list.appendChild(h);
    for (const r of dayReadings) {
      list.appendChild(renderRow(r));
    }
  }
}

function renderRow(r) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.modality = r.modality;
  const time = document.createElement('span');
  time.className = 'row-time';
  time.textContent = fmtTime(r.observed_at);
  const text = document.createElement('span');
  text.className = 'row-text';
  text.textContent = `${VITAL_LABELS[r.vital_type] ?? r.vital_type} ${r.value_num} ${r.unit ?? ''}`;
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = r.modality ?? 'self_reported';
  // One shared hidden file input serves every row; the attach button records
  // which reading it targets before opening the picker.
  const attach = document.createElement('button');
  attach.type = 'button';
  attach.className = 'ghost attach-btn';
  attach.textContent = r.attachments?.length ? `📎 ${r.attachments.length}` : '📎';
  attach.title = 'Attach a lab report or photo';
  attach.addEventListener('click', () => {
    attachTarget = r.vital_id;
    $('attachInput').click();
  });
  row.append(time, text, badge, attach);

  // A reading with files gets a strip on its own line beneath the row.
  if (r.attachments?.length) {
    const strip = document.createElement('div');
    strip.className = 'attach-strip row-attachments';
    renderAttachments(strip, r.attachments, removeAttachment);
    const wrap = document.createElement('div');
    wrap.className = 'row-with-attachments';
    wrap.append(row, strip);
    return wrap;
  }
  return row;
}

$('logForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const vital_type = $('typeSelect').value;
  const value_num = Number($('valueInput').value);
  if (!vital_type || !Number.isFinite(value_num)) return;
  let outcome;
  try {
    outcome = await window.centraid.write({
      action: 'log',
      input: { vital_type, value_num },
    });
  } catch (err) {
    notice(String(err?.message ?? err));
    return;
  }
  if (outcome?.status === 'executed') {
    notice('');
    $('valueInput').value = '';
    await refresh();
  } else if (outcome?.status === 'parked') {
    notice('Sent to the owner for confirmation — it will appear once approved.');
  } else if (outcome?.status === 'failed') {
    notice(`The vault refused: ${outcome.predicate ?? outcome.reason ?? 'a precondition failed'}.`);
  } else if (outcome?.status === 'denied') {
    notice(`Denied by consent: ${outcome.reason ?? ''}`);
    await refresh();
  }
});

$('trendsButton').addEventListener('click', async () => {
  const vital_type = $('typeSelect').value;
  if (!vital_type) return;
  let outcome;
  try {
    outcome = await window.centraid.write({
      action: 'trends',
      input: { vital_type, days: 90 },
    });
  } catch (err) {
    notice(String(err?.message ?? err));
    return;
  }
  if (outcome?.status === 'executed') {
    const s = outcome.output ?? {};
    const label = VITAL_LABELS[vital_type] ?? vital_type;
    notice(`${label}, last 90 days: ${s.count} readings · ${s.min}–${s.max} · avg ${s.avg}`);
  } else if (outcome?.status === 'parked') {
    notice('Sent to the owner for confirmation.');
  } else if (outcome?.status === 'failed') {
    notice(`The vault refused: ${outcome.predicate ?? outcome.reason ?? 'a precondition failed'}.`);
  } else if (outcome?.status === 'denied') {
    notice(`Denied by consent: ${outcome.reason ?? ''}`);
    await refresh();
  }
});

wireAttachInput($('attachInput'), () => attachTarget);

window.addEventListener('focus', refresh);
refresh();
