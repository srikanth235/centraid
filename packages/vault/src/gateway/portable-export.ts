// Portable vault bundle (#630): the canonical JSON-LD restore artifact,
// human-readable adapters, every external content byte, and one hash manifest.
//
// SCHEMA/EXPORT COMPLETENESS AUDIT — this file is the audit owner. Every time
// the schema fingerprint moves, re-audit export completeness here so it cannot
// drift silently, and record the ruling as a bare citation, never a narrative.
// The rules that decide each audit:
//
//  - The canonical walk is `listVaultEntities` (schema/tables.ts), NOT "every
//    table in the file". An unregistered table is absent from every export
//    (#724 W5). Registering it is the whole fix.
//  - `exportVault` does `SELECT *` over each registered table, so a new column,
//    a widened CHECK, or a rename rides along with no code change here. Keep it
//    that way: `portability.test.ts` fails if the walk ever becomes a column
//    list (#846 P1).
//  - Carry control truth and owner decisions — grants, fulfillment and its
//    `delivered_at` memory, consent/policy rows, enrollment and caller
//    evidence, party↔vault bindings, derivation stamps, answered review states
//    (#712, #724, #807, #825, #846). Dropping any of them restores a vault that
//    has forgotten a decision the owner already made.
//  - Carry rebuildable projections too (`media_face_cluster`): a silent
//    re-derive reshuffles the owner's People shelf, and recovery tests assert
//    on the artifact, which cannot prove a table outside the walk is empty.
//  - Key custody stays OUT (#726 P1, #750): the seed and its public-key PIN
//    belong to the recovery kit ("this same vault, elsewhere"), while a bundle
//    restores a NEW vault that mints its own identity. Only the DEK is carried,
//    because canonical rows keep sealed ciphertext.
//  - Pre-release on-disk shapes are reset, not migrated: a bundle from an older
//    build may hold values this build's CHECKs refuse, and that is deliberate
//    (#750).

import { createHash } from "node:crypto";

import { sha256OfBytes } from "../blob/store.js";
import type { VaultDb } from "../db.js";
import {
  MAX_ZIP_ENTRIES,
  readZipEntries,
  writeZipEntries,
} from "../ingest/zip.js";
import type { ZipEntry } from "../ingest/zip.js";
import { sealKeyFileFor, writeSealKeyFile } from "../schema/sealed.js";
import {
  canonicalJson,
  exportVault,
  importVaultExport,
} from "./portability.js";
import type { VaultExport } from "./portability.js";
import {
  exportIcs,
  exportMarkdownDirectory,
  exportTransactionsCsv,
  exportVcards,
} from "./portable-adapters.js";
import type { Identity } from "./types.js";

export interface PortableManifestFile {
  path: string;
  sha256: string;
  bytes: number;
  kind: "canonical" | "adapter" | "content" | "custody";
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

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function exportPortableVault(
  db: VaultDb,
  owner: Identity
): Promise<PortableExport> {
  // Keep this owner in the schema/export ratchet — see the header.
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
    // Canonical rows keep sealed ciphertext, so blank-machine portability
    // needs the exact DEK. Manifest-hashed; no plaintext reaches the surface.
    { name: "custody/seal-key.bin", data: Buffer.from(db.sealKey) },
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
  // Check the entry count BEFORE opening any blob, so a huge vault fails
  // cheaply instead of buffering every object then rejecting at zip write.
  if (files.length + blobRows.length + 1 > MAX_ZIP_ENTRIES) {
    throw new Error(
      `portable export has too many entries (max ${MAX_ZIP_ENTRIES})`
    );
  }
  // Sequential on purpose: peak RSS is one content object + the zip buffer.
  await blobRows.reduce(async (prior, row) => {
    await prior;
    const bytes = await db.blobs.open(row.sha256);
    if (!bytes)
      throw new Error(`portable export cannot read content ${row.sha256}`);
    if (sha256OfBytes(bytes) !== row.sha256)
      throw new Error(`portable export content hash mismatch: ${row.sha256}`);
    files.push({ name: `content/${row.sha256}`, data: bytes });
  }, Promise.resolve());
  const vault = db.vault
    .prepare("SELECT vault_id FROM core_vault LIMIT 1")
    .get() as { vault_id: string };
  const manifestFiles: PortableManifestFile[] = files.map((file) => ({
    path: file.name,
    sha256: hash(file.data),
    bytes: file.data.length,
    kind: file.name.startsWith("canonical/")
      ? "canonical"
      : file.name.startsWith("custody/")
        ? "custody"
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

export function importPortableVault(
  db: VaultDb,
  bytes: Buffer,
  options: { replaceBootstrap?: boolean } = {}
): { imported: number; blobs: number } {
  verifyPortableVault(bytes);
  const entries = readZipEntries(bytes);
  const canonical = entries.find(
    (entry) => entry.name === "canonical/vault.json"
  );
  if (!canonical) throw new Error("portable export has no canonical artifact");
  const artifact = JSON.parse(canonical.data.toString("utf8")) as VaultExport;
  const portableSealKey = entries.find(
    (entry) => entry.name === "custody/seal-key.bin"
  )?.data;
  if (!portableSealKey || portableSealKey.length !== db.sealKey.length)
    throw new Error("portable export has no valid seal-key custody artifact");
  const priorSealKey = Buffer.from(db.sealKey);
  portableSealKey.copy(db.sealKey);
  if (db.dir !== ":memory:")
    writeSealKeyFile(sealKeyFileFor(db.dir), db.sealKey, db.keyStore);
  let result: { imported: number };
  try {
    result = importVaultExport(db, artifact, options);
  } catch (error) {
    priorSealKey.copy(db.sealKey);
    if (db.dir !== ":memory:")
      writeSealKeyFile(sealKeyFileFor(db.dir), db.sealKey, db.keyStore);
    throw error;
  }
  let blobs = 0;
  for (const entry of entries) {
    const match = /^content\/(?<sha>[a-f0-9]{64})$/u.exec(entry.name);
    if (!match?.groups?.sha) continue;
    const stored = db.blobs.ingestSync(entry.data);
    if (stored.sha256 !== match.groups.sha) {
      throw new Error(`portable export blob hash mismatch for ${entry.name}`);
    }
    blobs += 1;
  }
  return { ...result, blobs };
}
