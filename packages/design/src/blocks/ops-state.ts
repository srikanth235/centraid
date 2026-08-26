// What each operational state may SAY (#765): rules shared here, words per page.

export type OpsState = "ready" | "full" | "empty" | "loading" | "error";

export interface OpsGenericLines {
  empty: string;
  loading: string;
  error: string;
}

/** Inline verb for `ready`/`full` only — on error the way forward lives in the
 * error panel, never a second verb. */
export function opsStateCarriesAction(state: OpsState): boolean {
  return state === "ready" || state === "full";
}

/** Generic sentence for a state; `undefined` (never "") means the surface speaks for itself. */
export function opsGenericLine(
  state: OpsState,
  lines: OpsGenericLines
): string | undefined {
  if (state === "loading") return lines.loading;
  if (state === "empty") return lines.empty;
  if (state === "error") return lines.error;
  return undefined;
}

/** `label · detail`; either half may be missing — never render a lone separator. */
export function healthSentence(label: string, detail: string): string {
  if (!label) return detail;
  if (!detail) return label;
  return `${label} · ${detail}`;
}
