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
    $('readingList').innerHTML = '';
    $('empty').hidden = true;
    return;
  }
  $('logForm').hidden = false;
  renderReadings(data?.readings ?? []);
}

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
  row.append(time, text, badge);
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

window.addEventListener('focus', refresh);
refresh();
