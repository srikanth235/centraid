// The pure fringe of the native Face review screen (#712) — the answer→state
// table, the failure sentences, and two parsing helpers. Split from
// `FaceReview.tsx` so the screen file stays a screen (and inside the
// repo-hygiene size budget); everything here is a function of its inputs and
// carries no React.

export const CROP_PX = 120;

/** The row state each answer lands in — the same three the vault's
 *  `media_face_region.review_state` CHECK allows. A table, not a branch
 *  chain, so a fourth answer is one row here (docs/coding-standards.md). */
export const ANSWERED_STATE = {
  confirm: "confirmed",
  reject: "rejected",
  dismiss: "dismissed",
} as const;

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
