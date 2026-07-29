// Portable vault bundle (issue #630): the canonical JSON-LD restore artifact,
// human-readable adapters, every external content byte, and one hash manifest.

import { createHash } from "node:crypto";

import { sha256OfBytes } from "../blob/store.js";
import type { VaultDb } from "../db.js";
import { serializeMarkdownNote } from "../ingest/markdown.js";
import { readZipEntries, writeZipEntries } from "../ingest/zip.js";
import type { ZipEntry } from "../ingest/zip.js";
import { contentText } from "../schema/fts.js";
import { canonicalJson, exportVault } from "./portability.js";
import type { Identity } from "./types.js";

export interface PortableManifestFile {
  path: string;
  sha256: string;
  bytes: number;
  kind: "canonical" | "adapter" | "content";
}

export interface PortableManifest {
  format: "centraid-portable-v1";
  exportedAt: string;
  vaultId: string;
  ontologyVersion: string;
  canonicalVerifyHash: string;
  includes: readonly [
    "documents-and-versions",
    "folders",
    "tags",
    "all-canonical-tables",
    "content-bytes",
  ];
  files: PortableManifestFile[];
}

export interface PortableExport {
  filename: string;
  bytes: Buffer;
  manifest: PortableManifest;
  exportId: string;
  receiptId: string;
}

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
    if (row.rrule) lines.push(`RRULE:${row.rrule}`);
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

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function exportPortableVault(
  db: VaultDb,
  owner: Identity
): Promise<PortableExport> {
  const canonical = exportVault(db, owner);
  if (canonical.artifact.skippedTables?.length) {
    throw new Error(
      `portable export refused a partial canonical artifact: ${canonical.artifact.skippedTables.map((item) => item.entity).join(", ")}`
    );
  }
  const files: ZipEntry[] = [
    {
      name: "canonical/vault.json",
      data: Buffer.from(canonicalJson(canonical.artifact), "utf8"),
    },
    {
      name: "adapters/calendar.ics",
      data: Buffer.from(exportIcs(db), "utf8"),
    },
    {
      name: "adapters/contacts.vcf",
      data: Buffer.from(exportVcards(db), "utf8"),
    },
    {
      name: "adapters/transactions.csv",
      data: Buffer.from(exportTransactionsCsv(db), "utf8"),
    },
    ...exportMarkdownDirectory(db),
  ];
  const blobRows = db.vault
    .prepare(
      `SELECT DISTINCT sha256 FROM core_content_item
        WHERE content_uri LIKE 'blob:sha256-%' ORDER BY sha256`
    )
    .all() as { sha256: string }[];
  const contentFiles = await Promise.all(
    blobRows.map(async (row): Promise<ZipEntry> => {
      const bytes = await db.blobs.open(row.sha256);
      if (!bytes)
        throw new Error(`portable export cannot read content ${row.sha256}`);
      if (sha256OfBytes(bytes) !== row.sha256)
        throw new Error(`portable export content hash mismatch: ${row.sha256}`);
      return { name: `content/${row.sha256}`, data: bytes };
    })
  );
  files.push(...contentFiles);
  const vault = db.vault
    .prepare("SELECT vault_id FROM core_vault LIMIT 1")
    .get() as { vault_id: string };
  const manifestFiles: PortableManifestFile[] = files.map((file) => ({
    path: file.name,
    sha256: hash(file.data),
    bytes: file.data.length,
    kind: file.name.startsWith("canonical/")
      ? "canonical"
      : file.name.startsWith("content/")
        ? "content"
        : "adapter",
  }));
  const manifest: PortableManifest = {
    format: "centraid-portable-v1",
    exportedAt: canonical.artifact.exportedAt,
    vaultId: vault.vault_id,
    ontologyVersion: canonical.artifact.ontologyVersion,
    canonicalVerifyHash: canonical.artifact.verifyHash,
    includes: [
      "documents-and-versions",
      "folders",
      "tags",
      "all-canonical-tables",
      "content-bytes",
    ],
    files: manifestFiles,
  };
  files.unshift({
    name: "manifest.json",
    data: Buffer.from(`${canonicalJson(manifest)}\n`, "utf8"),
  });
  const day = canonical.artifact.exportedAt.slice(0, 10);
  return {
    filename: `centraid-vault-${day}.zip`,
    bytes: writeZipEntries(files),
    manifest,
    exportId: canonical.exportId,
    receiptId: canonical.receiptId,
  };
}

/** Clean-machine integrity check: verifies the manifest and canonical hash. */
export function verifyPortableVault(bytes: Buffer): PortableManifest {
  const entries = new Map(
    readZipEntries(bytes).map((entry) => [entry.name, entry.data])
  );
  const manifestBytes = entries.get("manifest.json");
  if (!manifestBytes) throw new Error("portable export has no manifest.json");
  const manifest = JSON.parse(
    manifestBytes.toString("utf8")
  ) as PortableManifest;
  if (manifest.format !== "centraid-portable-v1")
    throw new Error(
      `unsupported portable export format: ${String(manifest.format)}`
    );
  for (const file of manifest.files) {
    const data = entries.get(file.path);
    if (!data) throw new Error(`portable export is missing ${file.path}`);
    if (data.length !== file.bytes || hash(data) !== file.sha256)
      throw new Error(`portable export integrity failure: ${file.path}`);
  }
  const canonicalBytes = entries.get("canonical/vault.json");
  if (!canonicalBytes)
    throw new Error("portable export has no canonical artifact");
  const artifact = JSON.parse(canonicalBytes.toString("utf8")) as {
    tables: Record<string, unknown>;
    verifyHash: string;
  };
  const actualCanonical = createHash("sha256")
    .update(canonicalJson(artifact.tables))
    .digest("hex");
  if (
    artifact.verifyHash !== manifest.canonicalVerifyHash ||
    actualCanonical !== artifact.verifyHash
  ) {
    throw new Error("portable export canonical hash mismatch");
  }
  return manifest;
}
