export interface ExportItem {
  item_id?: string;
  type?: string | null;
  title?: string | null;
  username?: string | null;
  password?: string | null;
  url?: string | null;
  otp_seed?: string | null;
  notes?: string | null;
  content?: string | null;
  card_number?: string | null;
  cvv?: string | null;
  expiry?: string | null;
  alias?: string | null;
  archived_at?: string | null;
  deleted_at?: string | null;
  addresses?: { url?: string | null; match_policy?: string | null }[];
  fields?: {
    section?: string | null;
    label?: string | null;
    kind?: string | null;
    value?: string | null;
  }[];
  passkey?: Record<string, unknown> | null;
  history?: Record<string, unknown>[];
  [column: string]: unknown;
}

export interface ExportPayload {
  exported_at?: string;
  item_count?: number;
  items?: ExportItem[];
}

const COLUMNS: readonly string[] = [
  "Title",
  "Url",
  "Username",
  "Password",
  "OTPAuth",
  "Favorite",
  "Archived",
  "Tags",
  "Notes",
];

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text =
    typeof value === "object" ? JSON.stringify(value) : String(value);
  return /["\n,]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function extras(item: ExportItem): string[] {
  const lines: string[] = [];
  if (item.notes) lines.push(String(item.notes));
  if (item.content) lines.push(`Note: ${item.content}`);
  if (item.card_number) lines.push(`Card number: ${item.card_number}`);
  if (item.cvv) lines.push(`Security code: ${item.cvv}`);
  if (item.expiry) lines.push(`Expiry: ${item.expiry}`);
  if (item.alias) lines.push(`Alias: ${item.alias}`);
  for (const address of item.addresses ?? []) {
    if (address?.url) {
      lines.push(`Address: ${address.url} (${address.match_policy ?? ""})`);
    }
  }
  for (const field of item.fields ?? []) {
    if (!field?.label) continue;
    lines.push(
      `${field.section ? `${field.section} · ` : ""}${field.label}: ${field.value ?? ""}`
    );
  }
  if (item.passkey) lines.push(`Passkey: ${JSON.stringify(item.passkey)}`);
  for (const revision of item.history ?? []) {
    lines.push(`Previous password: ${String(revision.password ?? "")}`);
  }
  return lines;
}

export function exportCsv(payload: ExportPayload): string {
  const rows = (payload.items ?? []).map((item) => [
    item.title ?? "",
    item.url ?? "",
    item.username ?? "",
    item.password ?? "",
    item.otp_seed ?? "",
    "",
    item.archived_at ? "archived" : "",
    item.deleted_at ? "trashed" : "",
    extras(item).join("\n"),
  ]);
  return [
    COLUMNS.map(cell).join(","),
    ...rows.map((row) => row.map(cell).join(",")),
  ].join("\n");
}

export function exportFileName(payload: ExportPayload): string {
  const stamp = String(payload.exported_at ?? "").slice(0, 10);
  return stamp ? `locker-${stamp}.csv` : "locker.csv";
}

export { saveExportFile } from "../_shared/format-kit.ts";
