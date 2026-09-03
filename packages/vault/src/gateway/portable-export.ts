import { createHash } from "node:crypto";

import { sha256OfBytes } from "../blob/store.js";
import type { VaultDb } from "../db.js";
import {
  MAX_ZIP_ENTRIES,
  readZipEntries,
  writeZipEntries,
} from "../ingest/zip.js";
import type { ZipEntry } from "../ingest/zip.js";
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
import {
  PORTABLE_CUSTODY_KIT_PATH,
  custodyKitSealKey,
  parsePortableCustodyKit,
  wrapPortableCustodyKit,
} from "./portable-custody.js";
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
  sealed: "ciphertext-only" | "recovery-kit";
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

export interface PortableExportOptions {
  passphrase?: string;
}

export async function exportPortableVault(
  db: VaultDb,
  owner: Identity,
  options: PortableExportOptions = {}
): Promise<PortableExport> {
  const canonical = exportVault(db, owner);
  if (canonical.artifact.skippedTables?.length) {
    throw new Error(
      `portable export refused a partial canonical artifact: ${canonical.artifact.skippedTables.map((item) => item.entity).join(", ")}`
    );
  }
  const vault = db.vault
    .prepare("SELECT vault_id FROM core_vault LIMIT 1")
    .get() as { vault_id: string };
  const passphrase = options.passphrase ?? "";
  const files: ZipEntry[] = [
    {
      name: "canonical/vault.json",
      data: Buffer.from(canonicalJson(canonical.artifact), "utf8"),
    },
    ...(passphrase.length > 0
      ? [
          {
            name: PORTABLE_CUSTODY_KIT_PATH,
            data: Buffer.from(
              `${canonicalJson(
                wrapPortableCustodyKit(
                  {
                    vaultId: vault.vault_id,
                    sealKey: db.sealKey,
                    createdAt: canonical.artifact.exportedAt,
                  },
                  passphrase
                )
              )}\n`,
              "utf8"
            ),
          },
        ]
      : []),
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
  if (files.length + blobRows.length + 1 > MAX_ZIP_ENTRIES) {
    throw new Error(
      `portable export has too many entries (max ${MAX_ZIP_ENTRIES})`
    );
  }
  await blobRows.reduce(async (prior, row) => {
    await prior;
    const bytes = await db.blobs.open(row.sha256);
    if (!bytes)
      throw new Error(`portable export cannot read content ${row.sha256}`);
    if (sha256OfBytes(bytes) !== row.sha256)
      throw new Error(`portable export content hash mismatch: ${row.sha256}`);
    files.push({ name: `content/${row.sha256}`, data: bytes });
  }, Promise.resolve());
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
    sealed: passphrase.length > 0 ? "recovery-kit" : "ciphertext-only",
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

export interface PortableImportOptions {
  replaceBootstrap?: boolean;
  passphrase?: string;
}

export function importPortableVault(
  db: VaultDb,
  bytes: Buffer,
  options: PortableImportOptions = {}
): { imported: number; blobs: number } {
  verifyPortableVault(bytes);
  const entries = readZipEntries(bytes);
  const canonical = entries.find(
    (entry) => entry.name === "canonical/vault.json"
  );
  if (!canonical) throw new Error("portable export has no canonical artifact");
  if (entries.some((entry) => entry.name === "custody/seal-key.bin")) {
    throw new Error(
      "portable import refused: this bundle carries a plaintext seal key (custody/seal-key.bin), which is no longer accepted — re-export with a passphrase to get a password-wrapped recovery kit"
    );
  }
  const artifact = JSON.parse(canonical.data.toString("utf8")) as VaultExport;
  const kitEntry = entries.find(
    (entry) => entry.name === PORTABLE_CUSTODY_KIT_PATH
  );
  const passphrase = options.passphrase ?? "";
  let sourceSealKey: Buffer | undefined;
  if (kitEntry) {
    if (passphrase.length === 0)
      throw new Error(
        "portable import refused: this bundle's seal key is in a password-wrapped recovery kit — supply the passphrase it was exported with. Nothing was written."
      );
    sourceSealKey = custodyKitSealKey(
      parsePortableCustodyKit(
        JSON.parse(kitEntry.data.toString("utf8")),
        passphrase
      )
    );
  }
  const result = importVaultExport(db, artifact, {
    ...(options.replaceBootstrap === undefined
      ? {}
      : { replaceBootstrap: options.replaceBootstrap }),
    ...(sourceSealKey ? { sourceSealKey } : {}),
  });
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
