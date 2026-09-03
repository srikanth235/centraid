export type OpsState = "ready" | "full" | "empty" | "loading" | "error";

export interface OpsGenericLines {
  empty: string;
  loading: string;
  error: string;
}

export function opsStateCarriesAction(state: OpsState): boolean {
  return state === "ready" || state === "full";
}

export function opsGenericLine(
  state: OpsState,
  lines: OpsGenericLines
): string | undefined {
  if (state === "loading") return lines.loading;
  if (state === "empty") return lines.empty;
  if (state === "error") return lines.error;
  return undefined;
}

export function healthSentence(label: string, detail: string): string {
  if (!label) return detail;
  if (!detail) return label;
  return `${label} · ${detail}`;
}
