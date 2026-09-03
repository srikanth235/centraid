import type { BrowseColumn, BrowseDependent } from "../../gateway-client.js";

export const SEALED_SENTINEL = "«sealed»";

export function isSealedValue(value: unknown): boolean {
  return value === SEALED_SENTINEL;
}

export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function pkColumns(columns: BrowseColumn[]): BrowseColumn[] {
  return columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
}

export function rowIdOf(
  row: Record<string, unknown>,
  columns: BrowseColumn[]
): string {
  const pks = pkColumns(columns);
  if (pks.length <= 1) {
    const only = pks[0];
    return only ? cellText(row[only.name]) : "";
  }
  return JSON.stringify(pks.map((c) => row[c.name] ?? null));
}

export function insertableColumns(columns: BrowseColumn[]): BrowseColumn[] {
  return columns.filter((c) => c.pk === 0);
}

export function isNumericColumn(col: BrowseColumn): boolean {
  return /INT|REAL|NUM|DEC|FLOA|DOUB/iu.test(col.type);
}

export function mechanismLabel(mechanism: "fk" | "poly"): string {
  return mechanism === "fk" ? "reference" : "authored";
}

export type EditorState =
  | { mode: "insert" }
  | { mode: "edit"; id: string; row: Record<string, unknown> }
  | null;

export interface DeleteState {
  id: string;
  loading: boolean;
  dependents: BrowseDependent[];
  hasEngineDependents: boolean;
  totalRows: number;
  blockedReason: string | null;
  error: string | null;
}
