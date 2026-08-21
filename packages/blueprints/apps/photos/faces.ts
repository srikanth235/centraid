// Faces (issue #299, fixed for #711): the propose-and-confirm loop over
// media.face_region, scoped to the ONE open photograph — the lightbox's own
// compact mini-list. The full, dedicated "Face review" surface (v4 handoff
// 4305-4318, vault-wide, one proposal at a time) lives in
// components/FaceReview.tsx + queries/face-queue.ts, not here; this file's
// job is only to not repeat, at photograph scale, the two mistakes that
// surface exists to fix — see #711's review:
//
//  1. CONFIDENCE IS NEVER A PERCENTAGE (README.md:285). This file used to
//     print `Math.round(region.confidence * 100)}%`, the enricher's raw
//     similarity score. It now counts MATCHES instead: how many OTHER
//     `media_face_region` rows (on any asset, confirmed or not) propose the
//     SAME `party_id`, deduped by photograph — the same derivation
//     queries/face-queue.ts uses for the full surface's `confidence` fact.
//  2. ONE FACE AT A TIME (v4 3967). This file used to render every
//     unconfirmed region on the open photograph as a list. It now shows
//     exactly one — the current index is kept on the host element itself
//     (`data-face-index`) so it survives the answer re-render this function
//     calls itself, without adding React state to a function that stays
//     intentionally DOM-imperative (see below).
//
// It does NOT use ../triage-session.ts, and that is deliberate: this loop's
// cursor lives in a DOM dataset precisely because the function is re-invoked
// wholesale rather than re-rendered, and there is no frozen denominator or
// outcome tally here to share — its progress line counts the photograph's own
// regions. Borrowing the session type would mean serialising it through
// `data-*` attributes to hold a state machine this surface does not have.
//
// Fully-imperative DOM builder, same as the Lit port: it targets an empty
// `<div ref={facesHostRef}>` that LightboxInfo always renders with no JSX
// children, so React never has anything of its own to reconcile there — the
// same "React-owned but foreign-filled" contract the boot skeleton relies on.
// No domain (asset/album) state here, so it lives beside outcomes.ts rather
// than in app.tsx — LightboxInfo imports and calls it directly.
import { act, narrate } from "./outcomes.ts";

interface FaceRegion {
  region_id: string;
  confirmed?: boolean;
  person_name?: string | null;
  confidence?: number | null;
  party_id?: string | null;
}

interface FacePerson {
  party_id: string;
  name: string;
}

interface FacesData {
  regions?: FaceRegion[];
  people?: FacePerson[];
  denied?: boolean;
}

function kitBtn(
  label: string,
  onClick: (event: MouseEvent) => void | Promise<void>
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "kit-btn";
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

/**
 * How many OTHER regions on this asset propose the same person (rule 1: a
 * MATCH COUNT, never `region.confidence`'s raw similarity score). This mini
 * list only ever sees the current asset's own regions, so — unlike
 * queries/face-queue.ts's vault-wide version — it counts within `regions`
 * alone; it is a smaller, honestly-scoped number, not an approximation of
 * the same one.
 */
function matchCountWithin(
  region: FaceRegion,
  regions: readonly FaceRegion[]
): number {
  if (!region.party_id) return 0;
  return regions.filter(
    (r) => r.region_id !== region.region_id && r.party_id === region.party_id
  ).length;
}

export async function renderFaces(
  host: HTMLElement,
  assetId: string,
  note: HTMLElement
): Promise<void> {
  let data: FacesData | undefined;
  try {
    data = await window.centraid.read<FacesData>({
      query: "faces",
      input: { asset_id: assetId },
    });
  } catch {
    return; // face queries never break the lightbox
  }
  const regions = data?.regions ?? [];
  // Clear before the empty bail-out too: a re-render call (confirm/reject
  // just resolved the LAST region) must erase the stale "People" section it
  // left behind, not just skip repopulating it. Only a genuinely failed read
  // (caught above) leaves whatever was already there alone.
  host.replaceChildren();
  if (regions.length === 0 || data?.denied) return;
  const confirmedCount = regions.filter((r) => r.confirmed).length;
  const unconfirmed = regions.filter((r) => !r.confirmed);
  const heading = document.createElement("p");
  heading.className = "lightbox-faces-title";
  heading.append("People — ");
  // Progress is DETERMINATE with exact counts, never a spinner or a bare
  // fraction lost in the sentence (v4 §14) — the numerals get their own span
  // so they stay mono/tabular even though the heading around them is prose.
  const progress = document.createElement("span");
  progress.style.fontVariantNumeric = "tabular-nums";
  progress.textContent = `${confirmedCount} of ${regions.length} reviewed`;
  heading.appendChild(progress);
  host.appendChild(heading);
  for (const region of regions.filter((r) => r.confirmed)) {
    const row = document.createElement("div");
    row.className = "lightbox-face";
    const who = document.createElement("span");
    who.textContent = `✓ ${region.person_name ?? "Confirmed"}`;
    row.appendChild(who);
    host.appendChild(row);
  }
  if (unconfirmed.length === 0) return;
  // Rule 2 — ONE FACE AT A TIME (v4 3967): a proposal at a time, not a list
  // of every unconfirmed region on this photograph. The index is kept ON
  // THE HOST rather than in a closure variable, because this function is
  // re-invoked wholesale (by LightboxInfo's effect, and by itself after a
  // write) rather than re-rendered by a framework that would preserve local
  // state for it. A NEW photograph (LightboxInfo's effect re-firing for a
  // different assetId) always starts its own queue at the head, rather than
  // inheriting whatever index Skip left behind on the previous photograph.
  if (host.dataset.faceAsset !== assetId) {
    host.dataset.faceIndex = "0";
    host.dataset.faceAsset = assetId;
  }
  const rawIndex = Number(host.dataset.faceIndex ?? "0");
  const index = Number.isFinite(rawIndex)
    ? ((rawIndex % unconfirmed.length) + unconfirmed.length) %
      unconfirmed.length
    : 0;
  const region = unconfirmed[index]!;
  const row = document.createElement("div");
  row.className = "lightbox-face";
  const label = document.createElement("span");
  const matches = matchCountWithin(region, regions);
  const matchNote =
    region.party_id == null
      ? ""
      : ` · ${matches} matching face${matches === 1 ? "" : "s"}`;
  label.textContent = `Face${region.person_name ? ` — ${region.person_name}?` : ""}${matchNote}`;
  row.appendChild(label);
  const picker = document.createElement("select");
  picker.setAttribute("aria-label", "Who is this?");
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "Who is this?";
  picker.appendChild(blank);
  for (const person of data.people ?? []) {
    const option = document.createElement("option");
    option.value = person.party_id;
    option.textContent = person.name;
    if (region.party_id === person.party_id) option.selected = true;
    picker.appendChild(option);
  }
  // ONE VERB, THREE ANSWERS (issue #712) — the same `answer-face` action the
  // full Face review surface fires, so a face answered in the lightbox is
  // answered everywhere, and a face the member declines to name here does not
  // reappear in the dedicated queue tomorrow.
  const answerHere = async (
    answer: "confirm" | "reject" | "dismiss",
    partyId?: string
  ): Promise<void> => {
    const outcome = await act("answer-face", {
      region_id: region.region_id,
      answer,
      ...(partyId ? { party_id: partyId } : {}),
    });
    if (narrate(outcome, note)) {
      host.dataset.faceIndex = "0"; // the queue shifted; start from its head
      await renderFaces(host, assetId, note);
    }
  };
  const confirm = kitBtn("Confirm", async () => {
    const partyId = picker.value;
    if (!partyId) {
      note.textContent = "Pick a person first.";
      return;
    }
    await answerHere("confirm", partyId);
  });
  const reject = kitBtn("Not this person", async () => {
    await answerHere("reject");
  });
  // The lightbox's own "keep the face, do not name it". The full surface has
  // carried this row since #711 with nothing behind it; here it is offered
  // only now that there is a command that means it.
  const keepUnnamed = kitBtn("Keep unnamed", async () => {
    await answerHere("dismiss");
  });
  keepUnnamed.setAttribute("aria-label", "Keep this face, do not name it");
  const skip = kitBtn("Skip", () => {
    // Local-only: nothing is written, so the skipped face genuinely "stays
    // in the queue" rather than the app merely promising that.
    host.dataset.faceIndex = String(index + 1);
    void renderFaces(host, assetId, note);
  });
  skip.setAttribute("aria-label", "Review this face later");
  row.append(picker, confirm, reject, keepUnnamed, skip);
  host.appendChild(row);
  if (unconfirmed.length > 1) {
    const remaining = document.createElement("p");
    remaining.className = "lightbox-faces-title";
    remaining.textContent = `${unconfirmed.length - 1} more face${
      unconfirmed.length - 1 === 1 ? "" : "s"
    } to review on this photograph`;
    host.appendChild(remaining);
  }
}
