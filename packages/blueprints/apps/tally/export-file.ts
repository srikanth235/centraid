// BALANCES ARE ABSENT BY CONSTRUCTION: nothing here folds a figure, and
// `balances_excluded` travels in the JSON.
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

/** Three tables in one file — one row type would invent columns. */
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

/** `<a download>` over an object URL: the one path every seat has. */
export function saveExportFile(file: {
  name: string;
  type: string;
  text: string;
}): void {
  const blob = new Blob([file.text], { type: `${file.type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  anchor.click();
  URL.revokeObjectURL(url);
}
