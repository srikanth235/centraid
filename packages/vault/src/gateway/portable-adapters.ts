// The portable bundle's human-readable adapters (#630): the same vault
// truths re-spelled in formats other software already reads — ICS for events,
// vCard for people, CSV for transactions, a Markdown directory for notes.
// Adapters are CONVENIENCE COPIES, never the restore source: the canonical
// JSON-LD in `portable-export.ts` is the artifact a restore reads, so an
// adapter may flatten or omit (and these do) without costing the owner data.
// Kept out of `portable-export.ts` so that file stays the completeness owner —
// the canonical walk, the manifest, and the schema/export audit ledger.

import type { VaultDb } from "../db.js";
import { serializeMarkdownNote } from "../ingest/markdown.js";
import type { ZipEntry } from "../ingest/zip.js";
import { contentText } from "../schema/fts.js";

function escapeIcs(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;");
}

function icsDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value.replaceAll("-", "");
  return value
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}(?=Z$)/u, "");
}

export function exportIcs(db: VaultDb): string {
  const rows = db.vault
    .prepare(
      `SELECT event_id, ical_uid, summary, description, dtstart, dtend, start_tz, rrule, status
         FROM core_event ORDER BY dtstart, event_id`
    )
    .all() as {
    event_id: string;
    ical_uid: string | null;
    summary: string;
    description: string | null;
    dtstart: string;
    dtend: string | null;
    start_tz: string | null;
    rrule: string | null;
    status: string;
  }[];
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Centraid//Portable Export//EN",
  ];
  for (const row of rows) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeIcs(row.ical_uid ?? `centraid-${row.event_id}`)}`,
      `SUMMARY:${escapeIcs(row.summary)}`
    );
    if (row.description)
      lines.push(`DESCRIPTION:${escapeIcs(row.description)}`);
    const tz =
      row.start_tz && !row.dtstart.endsWith("Z") ? `;TZID=${row.start_tz}` : "";
    lines.push(`DTSTART${tz}:${icsDate(row.dtstart)}`);
    if (row.dtend) lines.push(`DTEND${tz}:${icsDate(row.dtend)}`);
    if (row.rrule) {
      // Storage is bare `FREQ=…`; strip a legacy `RRULE:` so we never emit
      // `RRULE:RRULE:…` for Google-sourced rows that were stored prefixed.
      const bare = row.rrule.replace(/^\s*RRULE:/iu, "").trim();
      if (bare) lines.push(`RRULE:${bare}`);
    }
    lines.push(`STATUS:${row.status.toUpperCase()}`, "END:VEVENT");
  }
  lines.push("END:VCALENDAR", "");
  return lines.join("\r\n");
}

function escapeVcard(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;");
}

export function exportVcards(db: VaultDb): string {
  const parties = db.vault
    .prepare(
      `SELECT party_id, display_name, sort_name, birth_date
         FROM core_party WHERE kind = 'person' ORDER BY display_name, party_id`
    )
    .all() as {
    party_id: string;
    display_name: string;
    sort_name: string | null;
    birth_date: string | null;
  }[];
  const identifiers = db.vault.prepare(
    `SELECT scheme, value, label FROM core_party_identifier
      WHERE party_id = ? AND valid_to IS NULL ORDER BY scheme, is_primary DESC, identifier_id`
  );
  const lines: string[] = [];
  for (const party of parties) {
    lines.push(
      "BEGIN:VCARD",
      "VERSION:4.0",
      `FN:${escapeVcard(party.display_name)}`
    );
    if (party.sort_name) lines.push(`N:${escapeVcard(party.sort_name)}`);
    if (party.birth_date) lines.push(`BDAY:${party.birth_date}`);
    for (const id of identifiers.all(party.party_id) as {
      scheme: string;
      value: string;
      label: string | null;
    }[]) {
      if (id.scheme !== "email" && id.scheme !== "tel") continue;
      const params = id.label ? `;TYPE=${id.label.toUpperCase()}` : "";
      lines.push(
        `${id.scheme.toUpperCase()}${params}:${escapeVcard(id.value)}`
      );
    }
    lines.push("END:VCARD");
  }
  return `${lines.join("\r\n")}\r\n`;
}

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  // CSV exits should never become spreadsheet commands on another machine.
  if (/^[\t\r ]*[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function exportTransactionsCsv(db: VaultDb): string {
  const rows = db.vault
    .prepare(
      `SELECT t.external_id, t.posted_at, t.description, t.amount_minor, t.currency,
              t.direction, a.name AS account_name
         FROM core_transaction t JOIN core_account a ON a.account_id = t.account_id
        ORDER BY t.posted_at, t.txn_id`
    )
    .all() as Record<string, unknown>[];
  const header = [
    "external_id",
    "date",
    "description",
    "amount",
    "currency",
    "account",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const row of rows) {
    const signed =
      (row["direction"] === "debit" ? -1 : 1) *
      (Number(row["amount_minor"]) / 100);
    lines.push(
      [
        row["external_id"],
        String(row["posted_at"]).slice(0, 10),
        row["description"],
        { numeric: signed.toFixed(2) },
        row["currency"],
        row["account_name"],
      ]
        .map((value) =>
          value &&
          typeof value === "object" &&
          "numeric" in value &&
          typeof value.numeric === "string"
            ? value.numeric
            : csvCell(value)
        )
        .join(",")
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

function safeName(value: string): string {
  const reserved = '<>:"/\\|?*';
  const name = [...value.normalize("NFC")]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 0x20 || reserved.includes(character) ? "-" : character;
    })
    .join("")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return name.slice(0, 120) || "Untitled";
}

function collectionPath(
  id: string,
  collections: Map<string, { name: string; parent: string | null }>
): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = id;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const item = collections.get(cursor);
    if (!item) break;
    path.unshift(safeName(item.name));
    cursor = item.parent;
  }
  return path;
}

export function exportMarkdownDirectory(db: VaultDb): ZipEntry[] {
  const collections = new Map(
    (
      db.vault
        .prepare(
          "SELECT collection_id, name, parent_collection_id FROM core_collection"
        )
        .all() as {
        collection_id: string;
        name: string;
        parent_collection_id: string | null;
      }[]
    ).map((row) => [
      row.collection_id,
      { name: row.name, parent: row.parent_collection_id },
    ])
  );
  const rows = db.vault
    .prepare(
      `SELECT n.note_id, n.title, c.media_type, c.content_uri, e.collection_id
         FROM knowledge_note n
         JOIN core_content_item c ON c.content_id = n.body_content_id
         LEFT JOIN core_collection_entry e
           ON e.target_type = 'knowledge.note' AND e.target_id = n.note_id
        WHERE n.deleted_at IS NULL
        ORDER BY n.note_id, e.position`
    )
    .all() as {
    note_id: string;
    title: string;
    media_type: string;
    content_uri: string;
    collection_id: string | null;
  }[];
  const emitted = new Set<string>();
  const files: ZipEntry[] = [];
  for (const row of rows) {
    if (emitted.has(row.note_id)) continue;
    emitted.add(row.note_id);
    const folders = row.collection_id
      ? collectionPath(row.collection_id, collections)
      : ["Unfiled"];
    const filename = `${safeName(row.title)}-${row.note_id.slice(0, 8)}.md`;
    const body = contentText(row.media_type, row.content_uri) ?? "";
    files.push({
      name: `adapters/markdown/${[...folders, filename].join("/")}`,
      data: Buffer.from(
        serializeMarkdownNote({
          noteId: row.note_id,
          title: row.title,
          body,
        }),
        "utf8"
      ),
    });
  }
  return files;
}
