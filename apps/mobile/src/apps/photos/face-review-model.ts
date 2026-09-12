// The pure fringe of the native Face review screen (#712) — the answer→state
// table, the failure sentences, and two parsing helpers. Split from
// `FaceReview.tsx` so the screen file stays a screen (and inside the
// repo-hygiene size budget); everything here is a function of its inputs and
// carries no React.

export const CROP_PX = 120;

/** What a failed answer is called on the status bar. Never a stack trace:
 *  the member asked a question of their own library and deserves a sentence. */
export const ANSWER_FAILURE = {
  confirm: "Face not confirmed",
  reject: "Face not rejected",
  dismiss: "Face not kept",
} as const;

export function safeParseBBox(
  json: unknown
): { x: number; y: number; w: number; h: number } | null {
  if (json == null) return null;
  try {
    const v = JSON.parse(String(json));
    if (
      v &&
      typeof v.x === "number" &&
      typeof v.y === "number" &&
      typeof v.w === "number" &&
      typeof v.h === "number"
    )
      return v;
    return null;
  } catch {
    return null;
  }
}

export function formatFirstSeen(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** One `core_party` row as the picker reads it. */
export interface NameablePartyRow {
  party_id?: unknown;
  kind?: unknown;
  display_name?: unknown;
}

export interface NameableParty {
  partyId: string;
  name: string;
}

/**
 * WHO A FACE MAY BE NAMED AS (#1014, R12).
 *
 * The picker listed every `core_party` row, and the enrichment recipes each
 * enrol as one: naming a face offered "Document text", "Face recognition",
 * "Image embeddings", "Photo OCR", "Place names", "Text embeddings" and
 * "Transcript" beside the owner — so on a fresh library the only nameable
 * party was Owner, and the six agents were nonsense.
 *
 * A face is a PERSON. `kind` is the vocabulary that says so, and a row whose
 * kind is missing is included: the column is nullable and an older row that
 * predates the vocabulary is a person, not an agent. Everything that DECLARES
 * a non-person kind is out.
 */
export function nameableParties(
  rows: readonly NameablePartyRow[]
): NameableParty[] {
  return rows.flatMap((row) => {
    const partyId = typeof row.party_id === "string" ? row.party_id : null;
    if (partyId === null) return [];
    const kind = row.kind == null ? null : String(row.kind);
    if (kind !== null && kind !== "person") return [];
    return [
      {
        partyId,
        name:
          typeof row.display_name === "string" && row.display_name.length > 0
            ? row.display_name
            : "Unnamed",
      },
    ];
  });
}

/** One `access_provenance` row as face review reads it. */
export interface FaceProvenanceRow {
  entity_id?: unknown;
  agent_kind?: unknown;
  agent_id?: unknown;
  occurred_at?: unknown;
}

/**
 * WHERE A PROPOSAL ACTUALLY RAN (#1014, R13).
 *
 * The screen said "on this device" for every proposal. The seat runs no
 * recogniser at all — the faces recipe is armed on the GATEWAY
 * (docs/recognition-automations.md) — so for an ambient proposal that sentence
 * was simply false, and the member had no way to tell an import's claim from a
 * model's.
 *
 * Provenance is the only row that knows, and it replicates with the audit
 * band. Absent one, the honest answer is the recipe's home, never this device.
 */
export function faceRunnerLabel(
  regionId: string,
  provenance: readonly FaceProvenanceRow[],
  nameOfAgent: (agentId: string) => string | undefined
): string {
  const rows = provenance
    .filter((row) => row.entity_id === regionId)
    .sort((a, b) => (String(a.occurred_at) < String(b.occurred_at) ? -1 : 1));
  const latest = rows.at(-1);
  if (!latest) return "on your gateway";
  const kind = latest.agent_kind == null ? "" : String(latest.agent_kind);
  if (kind === "owner") return "on this device";
  if (kind === "import") return "from an import";
  const agentId = latest.agent_id == null ? "" : String(latest.agent_id);
  const name = nameOfAgent(agentId);
  return name ? `${name}, on your gateway` : "on your gateway";
}
