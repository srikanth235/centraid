// Faces (issue #299): the propose-and-confirm loop over media.face_region.
// Unconfirmed proposals show a person picker + Confirm/Reject; confirmed ones
// read as facts. Everything here is derived data — rejecting is disposal, and
// a re-run of the enricher can always propose again.
//
// Fully-imperative DOM builder, same as the Lit port: it targets an empty
// `<div ref={facesHostRef}>` that PanelBody always renders with no JSX
// children, so React never has anything of its own to reconcile there — the
// same "React-owned but foreign-filled" contract the boot skeleton relies on.
// No domain (asset/album) state here, so it lives beside outcomes.js rather
// than in app.jsx — PanelBody (Lightbox.jsx) imports and calls it directly.
import { act, narrate } from './outcomes.js';

function kitBtn(label, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'kit-btn';
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

export async function renderFaces(host, assetId, note) {
  let data;
  try {
    data = await window.centraid.read({ query: 'faces', input: { asset_id: assetId } });
  } catch {
    return; // face queries never break the lightbox
  }
  const regions = data?.regions ?? [];
  if (regions.length === 0 || data?.denied) return;
  host.replaceChildren();
  const heading = document.createElement('p');
  heading.className = 'lightbox-faces-title';
  heading.textContent = 'People';
  host.appendChild(heading);
  for (const region of regions) {
    const row = document.createElement('div');
    row.className = 'lightbox-face';
    if (region.confirmed) {
      const who = document.createElement('span');
      who.textContent = `✓ ${region.person_name ?? 'Confirmed'}`;
      row.appendChild(who);
      host.appendChild(row);
      continue;
    }
    const label = document.createElement('span');
    const pct = region.confidence != null ? ` · ${Math.round(region.confidence * 100)}%` : '';
    label.textContent = `Face${region.person_name ? ` — ${region.person_name}?` : ''}${pct}`;
    row.appendChild(label);
    const picker = document.createElement('select');
    picker.setAttribute('aria-label', 'Who is this?');
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = 'Who is this?';
    picker.appendChild(blank);
    for (const person of data.people ?? []) {
      const option = document.createElement('option');
      option.value = person.party_id;
      option.textContent = person.name;
      if (region.party_id === person.party_id) option.selected = true;
      picker.appendChild(option);
    }
    const confirm = kitBtn('Confirm', async () => {
      const partyId = picker.value;
      if (!partyId) {
        note.textContent = 'Pick a person first.';
        return;
      }
      const outcome = await act('confirm-face', { region_id: region.region_id, party_id: partyId });
      if (narrate(outcome, note)) await renderFaces(host, assetId, note);
    });
    const reject = kitBtn('✕', async () => {
      const outcome = await act('reject-face', { region_id: region.region_id });
      if (narrate(outcome, note)) await renderFaces(host, assetId, note);
    });
    reject.setAttribute('aria-label', 'Reject this face proposal');
    row.append(picker, confirm, reject);
    host.appendChild(row);
  }
}
