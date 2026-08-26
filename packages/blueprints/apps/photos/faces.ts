// Faces (#299, #711): the propose-and-confirm loop over media.face_region for
// the ONE open photograph; the vault-wide surface is components/FaceReview.tsx.
// TWO RULES: confidence is a MATCH COUNT, never a percentage; and ONE face at
// a time, its index on the host (`data-face-index`) so it survives the
// re-render this function calls on itself. Not ../triage-session.ts: no
// frozen denominator here. Imperative builder — React reconciles nothing.
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
  // Cleared before the empty bail-out, so the LAST region leaves nothing.
  host.replaceChildren();
  if (regions.length === 0 || data?.denied) return;
  const confirmedCount = regions.filter((r) => r.confirmed).length;
  const unconfirmed = regions.filter((r) => !r.confirmed);
  const heading = document.createElement("p");
  heading.className = "lightbox-faces-title";
  heading.append("People — ");
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
  // A NEW photograph starts at the head, never inheriting Skip's index.
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
  // ONE VERB, THREE ANSWERS (#712): a face answered here is answered
  // everywhere.
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
  const keepUnnamed = kitBtn("Keep unnamed", async () => {
    await answerHere("dismiss");
  });
  keepUnnamed.setAttribute("aria-label", "Keep this face, do not name it");
  const skip = kitBtn("Skip", () => {
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
