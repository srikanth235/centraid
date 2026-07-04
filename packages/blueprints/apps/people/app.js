// governance: allow-repo-hygiene file-size-limit blueprints are single-file by design (read wholesale by one agent); People is a finished contacts product — A–Z directory, detail panel, favorites, photos, vCard export — and splitting it would break that "one file" contract.
// People — a pure projection over the personal vault. Every row rendered
// here is a core.party; handles come from core.party_identifier and the
// editable enrichment (nickname, note, favorite) lives in
// social.contact_card, upserted through a typed vault command routed via
// this app's handlers (ctx.vault on the gateway side). Browsing reads a
// bounded recent window (issue #262) and typing in the search box asks the
// vault's FTS5 index instead of grepping a local copy. Handles bind via
// social.resolve_identity, and composing walks the vault's own two-step
// lifecycle: draft_message executes, send_message parks for the owner —
// the app never sends anything on its own authority. The app's own
// data.sqlite stays empty by design: revoke the grant and this page goes
// dark while the model, history and receipts remain the owner's.

import { armConfirm, debounce, letterAvatar, readFailed, showSkeleton, toast } from './kit.js';

const $ = (id) => document.getElementById(id);

let people = [];
let detail = null; // person whose detail panel is open
let loadedOnce = false;
let searchTerm = '';
let searchResults = null; // vault-ranked matches while a term is active
// The browse window: the directory query reads only this many recently
// touched parties. "Show more" grows it; search reaches everyone beyond it.
let directoryWindow = 500;
let directoryTruncated = false;
let returnFocusPartyId = null; // row to refocus when the panel closes
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

// ---------- Small formatting helpers ----------

function sortName(person) {
  return String(person.sort_name ?? person.display_name ?? '');
}

function groupLetter(person) {
  const first = sortName(person).trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(first) ? first : '#';
}

// "🎂 Mar 4" from a vault birth_date (YYYY-MM-DD), timezone-proof.
function birthdayLabel(birth) {
  const m = String(birth ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

const SCHEME_ICONS = { email: '✉', tel: '☎', handle: '@', url: '🔗' };

function primaryHandle(person) {
  const ids = person.identifiers ?? [];
  const pick = (scheme) =>
    ids.find((i) => i.scheme === scheme && i.is_primary) ?? ids.find((i) => i.scheme === scheme);
  const handle = pick('email') ?? pick('tel');
  return handle ? handle.value : '';
}

function isFavorite(person) {
  return person.card?.favorite === 1;
}

// Render a vault search snippet from text nodes only — the ⟦…⟧ hit markers
// the vault returns become <mark>, and contact text never parses as HTML.
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

// ---------- Avatars (photo attachment falls back to letter tile) ----------

function photoOf(person) {
  const images = (person.attachments ?? []).filter(
    (a) => String(a.media_type).startsWith('image/') && a.content_uri,
  );
  return (
    images.find((a) => a.role === 'photo') ?? images.find((a) => a.is_primary) ?? images[0] ?? null
  );
}

function avatarEl(person, size) {
  const el = letterAvatar(person.display_name, { size });
  const photo = photoOf(person);
  if (photo) {
    el.textContent = '';
    const img = document.createElement('img');
    img.src = photo.content_uri;
    img.alt = '';
    el.appendChild(img);
  }
  return el;
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
// download tile, each with a remove control that arms before it deletes.
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
    rm.addEventListener('click', () => {
      if (!armConfirm(rm, { armedLabel: '✓' })) return;
      onRemove(a.attachment_id);
    });
    tile.appendChild(rm);
    stripEl.appendChild(tile);
  }
}

async function removeAttachment(attachmentId) {
  const outcome = await act('detach', { attachment_id: attachmentId });
  if (narrate(outcome, refresh)) await refresh();
}

// Attach any file chosen through an <input type=file>; role tags photos so
// the directory can pick them as avatars.
async function attachFiles(inputEl, role) {
  if (!detail) return;
  const subjectId = detail.party_id;
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
      ...(role ? { role } : {}),
    });
    if (!narrate(outcome, refresh)) break;
    if (role === 'photo') toast('Photo set.');
  }
  inputEl.value = '';
  await refresh();
}

// ---------- Load + render ----------

async function refresh() {
  let data;
  try {
    data = await window.centraid.read({ query: 'directory', input: { limit: directoryWindow } });
  } catch {
    // A broken vault must not look like an empty one — surface the first
    // failure; later ones retry silently off the change feed.
    if (!loadedOnce) {
      $('peopleList').innerHTML = '';
      readFailed($('noticeBanner'));
    }
    return;
  }
  const denied = data?.vaultDenied;
  $('consentBanner').hidden = !denied;
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    $('searchInput').hidden = true;
    $('addPersonBtn').hidden = true;
    $('exportBtn').hidden = true;
    closeDetail({ silent: true });
    closeAddPerson();
    $('peopleList').innerHTML = '';
    $('letterRail').hidden = true;
    $('empty').hidden = true;
    return;
  }
  if (!loadedOnce) notice(''); // clear a first-load read failure once the vault answers
  loadedOnce = true;
  $('searchInput').hidden = false;
  $('addPersonBtn').hidden = false;
  $('exportBtn').hidden = false;
  people = data?.people ?? [];
  directoryTruncated = Boolean(data?.truncated);
  const n = people.length;
  $('subtitle').textContent =
    `${n} ${n === 1 ? 'person' : 'people'} — all from your vault, nothing stored here.`;
  // Keep the open detail panel fresh across change-feed refreshes.
  if (detail) {
    detail = people.find((p) => p.party_id === detail.party_id) ?? detail;
    renderDetail();
  }
  renderPeople();
}

function renderPeople() {
  const list = $('peopleList');
  list.innerHTML = '';
  // While a term is active the list IS the vault's ranked matches — the
  // directory copy is only the browse view, so no A–Z regrouping here.
  const shown = searchTerm ? (searchResults ?? []) : people;
  $('empty').hidden = shown.length > 0;
  $('empty').textContent = searchTerm
    ? 'No people match your search.'
    : "No people yet. Add someone above, resolve a handle, or import contacts through the vault's ingest.";

  const groups = new Map();
  if (searchTerm) {
    for (const person of shown) list.appendChild(renderRow(person));
  } else {
    // Pinned Starred section, then sticky A–Z groups over the full list.
    const starred = shown.filter(isFavorite);
    if (starred.length > 0) {
      list.appendChild(sectionHead('★ Starred', 'starred'));
      for (const person of starred) list.appendChild(renderRow(person));
    }
    for (const person of shown) {
      const letter = groupLetter(person);
      if (!groups.has(letter)) groups.set(letter, []);
      groups.get(letter).push(person);
    }
    for (const [letter, members] of groups) {
      list.appendChild(sectionHead(letter, `letter-${letter}`));
      for (const person of members) list.appendChild(renderRow(person));
    }
  }
  renderLetterRail([...groups.keys()], searchTerm, shown.length);

  // The window is honest about its edge: browsing shows the most recently
  // touched slice, "Show more" grows it, search reaches everyone beyond it.
  if (directoryTruncated && !searchTerm) {
    const footer = document.createElement('div');
    footer.className = 'window-footer';
    const label = document.createElement('span');
    label.textContent = `Showing your ${directoryWindow} most recently touched people — the rest are a search away. `;
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'chip';
    more.textContent = 'Show more';
    more.addEventListener('click', async () => {
      directoryWindow += 500;
      more.disabled = true;
      await refresh();
    });
    footer.append(label, more);
    list.appendChild(footer);
  }

  if (returnFocusPartyId && !detail) {
    const row = list.querySelector(`[data-party-id="${CSS.escape(returnFocusPartyId)}"]`);
    if (row) row.focus();
    returnFocusPartyId = null;
  }
}

function sectionHead(label, key) {
  const head = document.createElement('div');
  head.className = 'list-section-head';
  head.textContent = label;
  head.dataset.section = key;
  return head;
}

// The slim right-edge rail: only on longer, unfiltered lists.
function renderLetterRail(letters, q, count) {
  const rail = $('letterRail');
  rail.innerHTML = '';
  const show = !q && count >= 12 && letters.length > 1;
  rail.hidden = !show;
  if (!show) return;
  const smooth = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  for (const letter of letters) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = letter;
    btn.setAttribute('aria-label', `Jump to ${letter}`);
    btn.addEventListener('click', () => {
      const head = $('peopleList').querySelector(`[data-section="letter-${letter}"]`);
      if (head) head.scrollIntoView({ behavior: smooth, block: 'start' });
    });
    rail.appendChild(btn);
  }
}

function renderRow(person) {
  const row = document.createElement('div');
  row.className = 'row';
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.setAttribute('aria-label', `Open ${person.display_name}`);
  row.dataset.partyId = person.party_id;
  row.appendChild(avatarEl(person, '2.5rem'));
  const text = document.createElement('span');
  text.className = 'row-text';
  const name = document.createElement('span');
  name.className = 'row-name';
  name.textContent = person.display_name;
  const detailLine = document.createElement('span');
  detailLine.className = 'muted small row-detail';
  // A vault match carries its own snippet, already centered on the hit.
  if (searchTerm && person.snippet) {
    snippetInto(detailLine, person.snippet);
  } else {
    detailLine.textContent = [primaryHandle(person), person.card?.org_title]
      .filter(Boolean)
      .join(' · ');
  }
  text.append(name, detailLine);
  row.appendChild(text);
  if (parkedByParty.has(person.party_id)) {
    const parked = document.createElement('span');
    parked.className = 'parked-chip';
    parked.textContent = 'Send awaiting owner';
    parked.title = 'A message to this person is parked for the owner’s confirmation.';
    row.appendChild(parked);
  }
  row.appendChild(starButton(person, 'row-star'));
  const open = () => openDetail(person);
  row.addEventListener('click', open);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });
  return row;
}

// A star toggle wired straight to update-card — visible state, not just a
// write-only checkbox buried in a form.
function starButton(person, extraClass) {
  const fav = isFavorite(person);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `star-btn ${extraClass ?? ''}`.trim();
  btn.textContent = fav ? '★' : '☆';
  btn.classList.toggle('is-fav', fav);
  btn.setAttribute('aria-pressed', String(fav));
  btn.setAttribute('aria-label', fav ? 'Remove from starred' : 'Add to starred');
  btn.title = btn.getAttribute('aria-label');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFavorite(person);
  });
  return btn;
}

async function toggleFavorite(person) {
  const next = isFavorite(person) ? 0 : 1;
  const outcome = await act('update-card', { party_id: person.party_id, favorite: next });
  if (narrate(outcome, refresh)) {
    toast(next ? `${person.display_name} starred.` : `${person.display_name} unstarred.`);
    await refresh();
  }
}

// ---------- Detail panel ----------

function openDetail(person) {
  detail = person;
  returnFocusPartyId = person.party_id;
  closeAddPerson();
  $('listView').hidden = true;
  $('detailPanel').hidden = false;
  closeCardForm();
  closeCompose();
  renderDetail();
  $('backBtn').focus();
}

function closeDetail({ silent } = {}) {
  const wasOpen = detail !== null;
  detail = null;
  $('detailPanel').hidden = true;
  $('listView').hidden = false;
  closeCardForm();
  closeCompose();
  if (wasOpen && !silent) renderPeople(); // restores focus to the row
}

function renderDetail() {
  if (!detail) return;
  const slot = $('detailAvatar');
  slot.innerHTML = '';
  slot.appendChild(avatarEl(detail, '4.5rem'));
  $('detailName').textContent = detail.display_name;
  const meta = [
    detail.card?.org_title,
    detail.card?.nickname ? `“${detail.card.nickname}”` : null,
    detail.card?.note,
  ]
    .filter(Boolean)
    .join(' · ');
  $('detailMeta').textContent = meta;
  $('detailMeta').hidden = !meta;
  const bday = birthdayLabel(detail.birth_date);
  $('detailBirthday').textContent = bday ? `🎂 ${bday}` : '';
  $('detailBirthday').hidden = !bday;
  // Swap the header star in place so aria-pressed stays truthful.
  const oldStar = $('detailStarBtn');
  const star = starButton(detail);
  star.id = 'detailStarBtn';
  oldStar.replaceWith(star);
  renderIdentifiers();
  renderAttachments($('attachStrip'), detail.attachments, removeAttachment);
}

// Every identifier as a labeled row: scheme icon, label, value, then the
// act-on-it links (mailto/tel/sms) and a copy button.
function renderIdentifiers() {
  const list = $('idList');
  list.innerHTML = '';
  const ids = detail?.identifiers ?? [];
  if (ids.length === 0) {
    const none = document.createElement('p');
    none.className = 'muted small id-none';
    none.textContent = 'No handles linked yet — add one below.';
    list.appendChild(none);
    return;
  }
  for (const id of ids) {
    const row = document.createElement('div');
    row.className = 'id-row';
    const icon = document.createElement('span');
    icon.className = 'id-icon';
    icon.textContent = SCHEME_ICONS[id.scheme] ?? '•';
    icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'id-text';
    const value = document.createElement('span');
    value.className = 'id-value';
    value.textContent = id.value;
    const label = document.createElement('span');
    label.className = 'muted small id-label';
    label.textContent = [
      id.label ? id.label.charAt(0).toUpperCase() + id.label.slice(1) : id.scheme,
      id.is_primary ? 'primary' : null,
    ]
      .filter(Boolean)
      .join(' · ');
    text.append(value, label);
    const actions = document.createElement('span');
    actions.className = 'id-actions';
    if (id.scheme === 'email') actions.appendChild(idLink('Email', `mailto:${id.value}`));
    if (id.scheme === 'tel') {
      actions.appendChild(idLink('Call', `tel:${id.value}`));
      actions.appendChild(idLink('Text', `sms:${id.value}`));
    }
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'chip chip-small';
    copy.textContent = 'Copy';
    copy.setAttribute('aria-label', `Copy ${id.value}`);
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(id.value);
        toast('Copied.');
      } catch {
        notice('Clipboard unavailable in this context.');
      }
    });
    actions.appendChild(copy);
    row.append(icon, text, actions);
    list.appendChild(row);
  }
}

function idLink(label, href) {
  const a = document.createElement('a');
  a.className = 'chip chip-small';
  a.href = href;
  a.textContent = label;
  return a;
}

// ---------- Card editor (enrichment + identity fields) ----------

function openCardForm() {
  if (!detail) return;
  closeCompose();
  $('cardFormTitle').textContent = `Card for ${detail.display_name}`;
  $('displayNameInput').value = detail.display_name ?? '';
  $('nicknameInput').value = detail.card?.nickname ?? '';
  $('noteInput').value = detail.card?.note ?? '';
  $('birthdayInput').value = String(detail.birth_date ?? '').slice(0, 10);
  $('cardForm').hidden = false;
  $('nicknameInput').focus();
}

function closeCardForm() {
  $('cardForm').hidden = true;
}

$('cardForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!detail) return;
  const nickname = $('nicknameInput').value.trim();
  const note = $('noteInput').value.trim();
  const outcome = await act('update-card', {
    party_id: detail.party_id,
    ...(nickname ? { nickname } : {}),
    ...(note ? { note } : {}),
  });
  if (!narrate(outcome, refresh)) return;
  // Birthday lives on the party row, not the card — a second typed command.
  const birthday = $('birthdayInput').value;
  if (birthday && birthday !== String(detail.birth_date ?? '').slice(0, 10)) {
    const bd = await act('edit-person', { party_id: detail.party_id, birth_date: birthday });
    if (!narrate(bd, refresh)) return;
  }
  toast('Card saved.');
  closeCardForm();
  await refresh();
});

$('cancelCard').addEventListener('click', closeCardForm);

// Rename the party itself through core.update_party — identity lives on the
// party row, so this is a separate command from the card's enrichment.
$('renamePartyBtn').addEventListener('click', async () => {
  if (!detail) return;
  const display_name = $('displayNameInput').value.trim();
  if (!display_name || display_name === detail.display_name) return;
  const outcome = await act('edit-person', { party_id: detail.party_id, display_name });
  if (narrate(outcome, refresh)) {
    $('cardFormTitle').textContent = `Card for ${display_name}`;
    await refresh();
  }
});

// Bind a raw handle to the open person — resolution is retroactive, so
// unresolved threads and messages pick up the identity too. The label
// (Home/Work/Other) rides along on the identifier row.
$('linkHandleBtn').addEventListener('click', async () => {
  if (!detail) return;
  const value = $('handleValueInput').value.trim();
  if (!value) return;
  const label = $('handleLabelInput').value;
  let outcome;
  try {
    outcome = await window.centraid.write({
      action: 'resolve-identity',
      input: {
        party_id: detail.party_id,
        scheme: $('schemeInput').value,
        value,
        ...(label ? { label } : {}),
      },
    });
  } catch (err) {
    notice(String(err?.message ?? err));
    return;
  }
  if (outcome?.status === 'executed') {
    const resolved =
      (outcome.output?.participants_resolved ?? 0) + (outcome.output?.messages_resolved ?? 0);
    notice(resolved > 0 ? `Handle linked — ${resolved} earlier mentions resolved.` : '');
    if (resolved === 0) toast('Handle linked.');
    $('handleValueInput').value = '';
    await refresh();
  } else if (outcome?.status === 'failed') {
    notice(`The vault refused: ${outcome.predicate ?? outcome.reason ?? 'a precondition failed'}.`);
  } else if (outcome?.status === 'denied') {
    notice(`Denied by consent: ${outcome.reason ?? ''}`);
    await refresh();
  }
});

// ---------- Add person ----------

function openAddPerson() {
  closeDetail({ silent: true });
  $('listView').hidden = false;
  $('detailPanel').hidden = true;
  $('personForm').hidden = false;
  $('personNameInput').focus();
}

function closeAddPerson() {
  $('personForm').hidden = true;
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
    toast(`${display_name} added.`);
    await refresh();
  }
});

$('addPersonBtn').addEventListener('click', openAddPerson);
$('cancelPerson').addEventListener('click', closeAddPerson);

// ---------- Compose (draft-then-send, inside the detail panel) ----------

function openCompose() {
  if (!detail) return;
  closeCardForm();
  $('composeTitle').textContent = `Message ${detail.display_name}`;
  $('composeBody').value = '';
  $('composeForm').hidden = false;
  $('composeBody').focus();
}

function closeCompose() {
  $('composeForm').hidden = true;
}

// Compose: draft first, then optionally release the draft through
// send-message. Both steps can park — apps enroll with a low risk ceiling,
// and draft_message is medium risk, send_message high — so "parked" is a
// routine outcome here, not an error. The two-step lifecycle is the
// vault's, not this UI's invention.
async function composeAndMaybeSend(send) {
  if (!detail) return;
  const bodyText = $('composeBody').value.trim();
  if (!bodyText) return;
  const person = detail;
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

$('chipMessage').addEventListener('click', () => {
  if ($('composeForm').hidden) openCompose();
  else closeCompose();
});
$('chipEdit').addEventListener('click', () => {
  if ($('cardForm').hidden) openCardForm();
  else closeCardForm();
});
$('backBtn').addEventListener('click', () => closeDetail());

// ---------- vCard export (client-side only, nothing leaves the page) ----------

function vEscape(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/[;,]/g, (c) => `\\${c}`);
}

function vName(person) {
  const sort = String(person.sort_name ?? '');
  if (sort.includes(',')) {
    const [family, given] = sort.split(',', 2).map((s) => s.trim());
    return `${vEscape(family)};${vEscape(given ?? '')};;;`;
  }
  const words = String(person.display_name ?? '')
    .trim()
    .split(/\s+/);
  const family = words.length > 1 ? words.pop() : '';
  return `${vEscape(family)};${vEscape(words.join(' '))};;;`;
}

function toVcf(list) {
  const lines = [];
  for (const person of list) {
    lines.push('BEGIN:VCARD', 'VERSION:3.0');
    lines.push(`FN:${vEscape(person.display_name ?? '')}`);
    lines.push(`N:${vName(person)}`);
    if (person.card?.nickname) lines.push(`NICKNAME:${vEscape(person.card.nickname)}`);
    if (person.card?.org_title) lines.push(`TITLE:${vEscape(person.card.org_title)}`);
    if (person.card?.note) lines.push(`NOTE:${vEscape(person.card.note)}`);
    const bday = String(person.birth_date ?? '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(bday)) lines.push(`BDAY:${bday}`);
    for (const id of person.identifiers ?? []) {
      const type = id.label ? `;TYPE=${id.label.toUpperCase()}` : '';
      if (id.scheme === 'email') lines.push(`EMAIL${type}:${vEscape(id.value)}`);
      else if (id.scheme === 'tel') lines.push(`TEL${type}:${vEscape(id.value)}`);
      else if (id.scheme === 'url') lines.push(`URL${type}:${vEscape(id.value)}`);
      else lines.push(`X-${id.scheme.toUpperCase()}${type}:${vEscape(id.value)}`);
    }
    lines.push('END:VCARD');
  }
  return `${lines.join('\r\n')}\r\n`;
}

$('exportBtn').addEventListener('click', () => {
  if (people.length === 0) {
    toast('Nothing to export yet.');
    return;
  }
  const a = document.createElement('a');
  a.href = `data:text/vcard;charset=utf-8,${encodeURIComponent(toVcf(people))}`;
  a.download = 'people.vcf';
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast(`Exported ${people.length} ${people.length === 1 ? 'person' : 'people'} to people.vcf.`);
});

// ---------- Keyboard: / focuses search, Esc backs out, n adds ----------

function isTyping(target) {
  return (
    target instanceof HTMLElement &&
    (target.matches('input, textarea, select') || target.isContentEditable)
  );
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('composeForm').hidden) closeCompose();
    else if (!$('cardForm').hidden) closeCardForm();
    else if (detail) closeDetail();
    else if (!$('personForm').hidden) closeAddPerson();
    else if (searchTerm || $('searchInput').value) clearSearch();
    return;
  }
  if (isTyping(e.target)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/') {
    e.preventDefault();
    if (!detail) $('searchInput').focus();
  } else if (e.key === 'n') {
    if (detail) return;
    e.preventDefault();
    openAddPerson();
  }
});

// Searching asks the vault, not a local copy: the FTS5 index matches over
// every party and contact card inside SQLite and returns only the hits, so
// the app never greps an unbounded directory in memory. `searchSeq` drops
// stale replies when the owner types faster than the vault answers.
let searchSeq = 0;
$('searchInput').addEventListener(
  'input',
  debounce(async () => {
    const raw = $('searchInput').value.trim();
    searchTerm = raw.toLowerCase();
    if (!raw) {
      searchResults = null;
      renderPeople();
      return;
    }
    const seq = ++searchSeq;
    let rows = [];
    try {
      const data = await window.centraid.read({ query: 'search', input: { term: raw } });
      rows = data?.people ?? [];
    } catch {
      rows = [];
    }
    if (seq !== searchSeq) return;
    searchResults = rows;
    renderPeople();
  }, 250),
);

function clearSearch() {
  $('searchInput').value = '';
  searchTerm = '';
  searchResults = null;
  renderPeople();
}

wireAttachInputs();
function wireAttachInputs() {
  $('attachInput').addEventListener('change', () => attachFiles($('attachInput')));
  $('photoInput').addEventListener('change', () => attachFiles($('photoInput'), 'photo'));
}

window.addEventListener('focus', refresh);
showSkeleton($('peopleList'), 6);
refresh();
