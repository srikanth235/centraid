// People — a pure projection over the personal vault. Every row rendered
// here is a core.party; handles come from core.party_identifier and the
// editable enrichment (nickname, note, favorite) lives in
// social.contact_card, upserted through a typed vault command routed via
// this app's handlers (ctx.vault on the gateway side). The app's own
// data.sqlite stays empty by design: revoke the grant and this page goes
// dark while the model, history and receipts remain the owner's.

const $ = (id) => document.getElementById(id);

let people = [];
let editing = null;

function notice(text) {
  const el = $('noticeBanner');
  el.textContent = text;
  el.hidden = !text;
}

function initials(name) {
  const parts = String(name ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const letters = parts
    .slice(0, 2)
    .map((w) => w[0])
    .join('');
  return letters ? letters.toUpperCase() : '?';
}

function primaryHandle(person) {
  const ids = person.identifiers ?? [];
  const pick = (scheme) =>
    ids.find((i) => i.scheme === scheme && i.is_primary) ?? ids.find((i) => i.scheme === scheme);
  const handle = pick('email') ?? pick('tel');
  return handle ? handle.value : '';
}

function matches(person, q) {
  if (!q) return true;
  const hay = [person.display_name, ...(person.identifiers ?? []).map((i) => i.value)]
    .join(' ')
    .toLowerCase();
  return hay.includes(q);
}

async function refresh() {
  let data;
  try {
    data = await window.centraid.read({ query: 'directory' });
  } catch {
    return; // transient; the change feed retries
  }
  const denied = data?.vaultDenied;
  $('consentBanner').hidden = !denied;
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    $('searchInput').hidden = true;
    closeForm();
    $('peopleList').innerHTML = '';
    $('empty').hidden = true;
    return;
  }
  $('searchInput').hidden = false;
  people = data?.people ?? [];
  renderPeople();
}

function renderPeople() {
  const q = $('searchInput').value.trim().toLowerCase();
  const list = $('peopleList');
  list.innerHTML = '';
  const shown = people.filter((p) => matches(p, q));
  $('empty').hidden = shown.length > 0;
  for (const person of shown) {
    list.appendChild(renderRow(person));
  }
}

function renderRow(person) {
  const row = document.createElement('div');
  row.className = 'row';
  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  avatar.textContent = initials(person.display_name);
  const text = document.createElement('span');
  text.className = 'row-text';
  const name = document.createElement('span');
  name.className = 'row-name';
  name.textContent = person.display_name;
  const detail = document.createElement('span');
  detail.className = 'muted small row-detail';
  detail.textContent = [primaryHandle(person), person.card?.org_title].filter(Boolean).join(' · ');
  text.append(name, detail);
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'ghost';
  edit.textContent = 'Edit';
  edit.addEventListener('click', () => openForm(person));
  row.append(avatar, text, edit);
  return row;
}

function openForm(person) {
  editing = person;
  $('cardFormTitle').textContent = `Card for ${person.display_name}`;
  $('nicknameInput').value = person.card?.nickname ?? '';
  $('noteInput').value = person.card?.note ?? '';
  $('favoriteInput').checked = person.card?.favorite === 1;
  $('cardForm').hidden = false;
  $('nicknameInput').focus();
}

function closeForm() {
  editing = null;
  $('cardForm').hidden = true;
}

$('cardForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!editing) return;
  const nickname = $('nicknameInput').value.trim();
  const note = $('noteInput').value.trim();
  const input = {
    party_id: editing.party_id,
    favorite: $('favoriteInput').checked ? 1 : 0,
    ...(nickname ? { nickname } : {}),
    ...(note ? { note } : {}),
  };
  let outcome;
  try {
    outcome = await window.centraid.write({ action: 'update-card', input });
  } catch (err) {
    notice(String(err?.message ?? err));
    return;
  }
  if (outcome?.status === 'executed') {
    notice('');
    closeForm();
    await refresh();
  } else if (outcome?.status === 'parked') {
    notice('Sent to the owner for confirmation — the card updates once approved.');
  } else if (outcome?.status === 'failed') {
    notice(`The vault refused: ${outcome.predicate ?? outcome.reason ?? 'a precondition failed'}.`);
  } else if (outcome?.status === 'denied') {
    notice(`Denied by consent: ${outcome.reason ?? ''}`);
    await refresh();
  }
});

$('cancelCard').addEventListener('click', closeForm);
$('searchInput').addEventListener('input', renderPeople);

window.addEventListener('focus', refresh);
refresh();
