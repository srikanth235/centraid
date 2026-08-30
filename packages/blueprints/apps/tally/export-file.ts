// BALANCES ARE ABSENT BY CONSTRUCTION: nothing here folds a figure.
import type { ExportData } from "./types.ts";

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text =
    typeof value === "object" ? JSON.stringify(value) : String(value);
  return /["\n,]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function rowsToCsv(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const head = columns.map(cell).join(",");
  const body = rows.map((row) =>
    columns.map((column) => cell(row[column])).join(",")
  );
  return [head, ...body].join("\n");
}

/** Three tables: one row type would invent columns. */
export function exportFile(
  data: ExportData,
  format: string
): { name: string; type: string; text: string } {
  const slug = (data.group?.name ?? "ledger")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  if (format === "json")
    return {
      name: `${slug || "ledger"}.json`,
      type: "application/json",
      text: JSON.stringify(data, null, 2),
    };
  const text = [
    "# expenses",
    rowsToCsv(data.expenses),
    "",
    "# settlements",
    rowsToCsv(data.settlements),
    "",
    "# revisions",
    rowsToCsv(data.revisions),
  ].join("\n");
  return { name: `${slug || "ledger"}.csv`, type: "text/csv", text };
}

// Handing the file over is the format kit's (#883) — one path for every seat.
export { saveExportFile } from "../_shared/format-kit.ts";
