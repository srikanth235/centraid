// People — a pure projection over the personal vault. Every row rendered
// here is a core.party; handles come from core.party_identifier and the
// editable enrichment (nickname, note, favorite) lives in
// social.contact_card, upserted through a typed vault command routed via
// this app's handlers (ctx.vault on the gateway side). Handles bind via
// social.resolve_identity, and composing walks the vault's own two-step
// lifecycle: draft_message executes, send_message parks for the owner —
// the app never sends anything on its own authority. The app's own
// data.sqlite stays empty by design: revoke the grant and this page goes
// dark while the model, history and receipts remain the owner's.

const $ = (id) => document.getElementById(id);

let people = [];
let editing = null;
let composing = null;
// party_id → parked send awaiting the owner's confirmation. Session-local by
// design: the app stores nothing, so a reload simply stops showing the chip
// while the invocation keeps waiting in the owner's vault UI.
const parkedByParty = new Map();

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
    $('addPersonBtn').hidden = true;
    closeForm();
    closeCompose();
    closeAddPerson();
    $('peopleList').innerHTML = '';
    $('empty').hidden = true;
    return;
  }
  $('searchInput').hidden = false;
  $('addPersonBtn').hidden = false;
  people = data?.people ?? [];
  // Keep the open card's attachment strip fresh across change-feed refreshes.
  if (editing) {
    editing = people.find((p) => p.party_id === editing.party_id) ?? editing;
    renderAttachments($('attachStrip'), editing.attachments, removeAttachment);
  }
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
  row.append(avatar, text);
  if (parkedByParty.has(person.party_id)) {
    const parked = document.createElement('span');
    parked.className = 'parked-chip';
    parked.textContent = 'Send awaiting owner';
    parked.title = 'A message to this person is parked for the owner’s confirmation.';
    row.append(parked);
  }
  const message = document.createElement('button');
  message.type = 'button';
  message.className = 'ghost';
  message.textContent = 'Message';
  message.addEventListener('click', () => openCompose(person));
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'ghost';
  edit.textContent = 'Edit';
  edit.addEventListener('click', () => openForm(person));
  row.append(message, edit);
  return row;
}

function openForm(person) {
  closeCompose();
  closeAddPerson();
  editing = person;
  $('cardFormTitle').textContent = `Card for ${person.display_name}`;
  $('displayNameInput').value = person.display_name ?? '';
  $('nicknameInput').value = person.card?.nickname ?? '';
  $('noteInput').value = person.card?.note ?? '';
  $('favoriteInput').checked = person.card?.favorite === 1;
  $('handleValueInput').value = '';
  renderAttachments($('attachStrip'), person.attachments, removeAttachment);
  $('cardForm').hidden = false;
  $('nicknameInput').focus();
}

async function removeAttachment(attachmentId) {
  const outcome = await act('detach', { attachment_id: attachmentId });
  if (narrate(outcome, refresh)) await refresh();
}

function closeForm() {
  editing = null;
  $('cardForm').hidden = true;
}

function openAddPerson() {
  closeForm();
  closeCompose();
  $('personForm').hidden = false;
  $('personNameInput').focus();
}

function closeAddPerson() {
  $('personForm').hidden = true;
}

function openCompose(person) {
  closeForm();
  closeAddPerson();
  composing = person;
  $('composeTitle').textContent = `Message ${person.display_name}`;
  $('composeBody').value = '';
  $('composeForm').hidden = false;
  $('composeBody').focus();
}

function closeCompose() {
  composing = null;
  $('composeForm').hidden = true;
}

// Mint a brand-new party through core.add_party — the one write that grows
// the directory itself. Optional handles bind in the same stroke; the vault
// refuses when a handle already identifies someone else.
$('personForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const display_name = $('personNameInput').value.trim();
  if (!display_name) {
    notice('A person needs a name.');
    return;
  }
  const email = $('personEmailInput').value.trim();
  const tel = $('personTelInput').value.trim();
  const handle = $('personHandleInput').value.trim();
  const outcome = await act('add-person', {
    display_name,
    ...(email ? { email } : {}),
    ...(tel ? { tel } : {}),
    ...(handle ? { handle } : {}),
  });
  if (narrate(outcome, refresh)) {
    $('personNameInput').value = '';
    $('personEmailInput').value = '';
    $('personTelInput').value = '';
    $('personHandleInput').value = '';
    closeAddPerson();
    await refresh();
  }
});

$('addPersonBtn').addEventListener('click', openAddPerson);
$('cancelPerson').addEventListener('click', closeAddPerson);

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

// Rename the party itself through core.update_party — identity lives on the
// party row, so this is a separate command from the card's enrichment.
$('renamePartyBtn').addEventListener('click', async () => {
  if (!editing) return;
  const display_name = $('displayNameInput').value.trim();
  if (!display_name || display_name === editing.display_name) return;
  const outcome = await act('edit-person', { party_id: editing.party_id, display_name });
  if (narrate(outcome, refresh)) {
    $('cardFormTitle').textContent = `Card for ${display_name}`;
    await refresh();
  }
});

// Bind a raw handle to the party being edited — resolution is retroactive,
// so unresolved threads and messages pick up the identity too.
$('linkHandleBtn').addEventListener('click', async () => {
  if (!editing) return;
  const value = $('handleValueInput').value.trim();
  if (!value) return;
  let outcome;
  try {
    outcome = await window.centraid.write({
      action: 'resolve-identity',
      input: { party_id: editing.party_id, scheme: $('schemeInput').value, value },
    });
  } catch (err) {
    notice(String(err?.message ?? err));
    return;
  }
  if (outcome?.status === 'executed') {
    const resolved =
      (outcome.output?.participants_resolved ?? 0) + (outcome.output?.messages_resolved ?? 0);
    notice(resolved > 0 ? `Handle linked — ${resolved} earlier mentions resolved.` : '');
    $('handleValueInput').value = '';
    await refresh();
  } else if (outcome?.status === 'failed') {
    notice(`The vault refused: ${outcome.predicate ?? outcome.reason ?? 'a precondition failed'}.`);
  } else if (outcome?.status === 'denied') {
    notice(`Denied by consent: ${outcome.reason ?? ''}`);
    await refresh();
  }
});

// Compose: draft first, then optionally release the draft through
// send-message. Both steps can park — apps enroll with a low risk ceiling,
// and draft_message is medium risk, send_message high — so "parked" is a
// routine outcome here, not an error. The two-step lifecycle is the
// vault's, not this UI's invention.
async function composeAndMaybeSend(send) {
  if (!composing) return;
  const bodyText = $('composeBody').value.trim();
  if (!bodyText) return;
  const person = composing;
  let draft;
  try {
    draft = await window.centraid.write({
      action: 'draft-message',
      input: {
        recipient_party_id: person.party_id,
        body_text: bodyText,
        channel: $('channelInput').value,
      },
    });
  } catch (err) {
    notice(String(err?.message ?? err));
    return;
  }
  if (draft?.status === 'parked') {
    parkedByParty.set(person.party_id, { invocation_id: draft.invocationId });
    notice(
      `Draft to ${person.display_name} is parked — the owner confirms it in vault settings before anything is written.`,
    );
    closeCompose();
    renderPeople();
    return;
  }
  if (draft?.status === 'denied') {
    notice(`Denied by consent: ${draft.reason ?? ''}`);
    await refresh();
    return;
  }
  if (draft?.status !== 'executed') {
    notice(`The vault refused the draft: ${draft?.predicate ?? draft?.reason ?? 'unknown'}.`);
    return;
  }
  if (!send) {
    notice(`Draft saved for ${person.display_name} — nothing sends without the send step.`);
    closeCompose();
    return;
  }
  let sent;
  try {
    sent = await window.centraid.write({
      action: 'send-message',
      input: { message_id: draft.output.message_id },
    });
  } catch (err) {
    notice(String(err?.message ?? err));
    return;
  }
  if (sent?.status === 'parked') {
    parkedByParty.set(person.party_id, {
      message_id: draft.output.message_id,
      invocation_id: sent.invocationId,
    });
    notice(
      `Draft to ${person.display_name} is parked — the owner confirms the send in vault settings.`,
    );
    closeCompose();
    renderPeople();
  } else if (sent?.status === 'executed') {
    notice(`Message to ${person.display_name} sent.`);
    closeCompose();
  } else if (sent?.status === 'denied') {
    notice(`Send denied by consent: ${sent.reason ?? ''}`);
  } else {
    notice(`The vault refused the send: ${sent?.predicate ?? sent?.reason ?? 'unknown'}.`);
  }
}

$('composeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  composeAndMaybeSend(true);
});
$('saveDraftBtn').addEventListener('click', () => composeAndMaybeSend(false));
$('cancelCompose').addEventListener('click', closeCompose);

$('searchInput').addEventListener('input', renderPeople);

wireAttachInput($('attachInput'), () => editing?.party_id);

window.addEventListener('focus', refresh);
refresh();
