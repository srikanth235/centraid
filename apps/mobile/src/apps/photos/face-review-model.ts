export const CROP_PX = 120;

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
