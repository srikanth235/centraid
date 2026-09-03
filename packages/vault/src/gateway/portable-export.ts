// Portable vault bundle (#630): the canonical JSON-LD restore artifact,
// human-readable adapters, every external content byte, and one hash manifest.
//
// SCHEMA/EXPORT COMPLETENESS AUDIT — this file is the audit owner. Every time
// the schema fingerprint moves, re-audit export completeness here so it cannot
// drift silently, and record the ruling as a bare citation, never a narrative.
// The rules that decide each audit:
//
//  - The canonical walk is `listVaultEntities` (schema/tables.ts over
//    schema/entity-catalog.ts), NOT "every table in the file". An unregistered
//    table is absent from every export (#724 W5). Registering it is the whole
//    fix.
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
//    restores a NEW vault that mints its own identity. The DEK is not carried
//    in the clear either (#630, closing review-A 10.1): sealed cells ride as
//    ciphertext, and the key leaves ONLY inside `custody/recovery-kit.json`,
//    password-wrapped, and only when the owner supplies a passphrase. Without
//    one the manifest says `sealed: "ciphertext-only"` and the bundle opens no
//    secrets anywhere.
//  - Pre-release on-disk shapes are reset, not migrated: a bundle from an older
//    build may hold values this build's CHECKs refuse, and that is deliberate
//    (#750).

// Schema/export audit #865: `sync_connection_credential.refresh_capability`
// MUST be carried. It is the Worker-minted HMAC a stored Assist refresh token
// is redeemable with — dropping it hands back tokens `/refresh` refuses, so
// every Google connection reads as a withdrawn grant. A sealed cell on an
// already-walked table, pinned by `portability.test.ts`'s "an Assist refresh
// capability survives export and restore".

// Schema/export audit #872: Tally gains two tables and four columns, all of
// which MUST be carried. `tally_expense_payer` is the GROUND FACT of who put
// money down, without which restored expenses have no payer; `tally_nudge` is
// the record that the owner prepared a reminder. The columns ride the same
// `SELECT *`: `tally_expense.split_method`/`split_params_json` (without them
// every restored edit re-opens as exact amounts) and
// `tally_group.simplify_opt_in`/`archived_at` (two owner decisions — a dropped
// opt-in re-wires who owes whom, a dropped archive un-files a group).

// Schema/export audit #872 (Locker): four tables enter the canonical walk and
// three columns join `locker_item`, and all MUST be carried.
// `locker_item_alias` binds connectors (`locker:@<alias>:<column>`);
// `locker_item_field` is the member's own sections and fields;
// `locker_item_address` the extra addresses a login answers to;
// `locker_item_passkey` the passkey slot. Each is a fact the owner entered.
// `locker_item_history` was a fifth and is GONE (#916, D2): rotation history
// is a `core_entity_revision` snapshot now, which is already in the walk, so
// the record survives the table under the row that owns it.
// Registration in schema/tables.ts is the whole fix — the `SELECT *` walk
// carries the new `locker_item` columns and the sidecars' sealed cells, which
// stay CIPHERTEXT: the bundle never carries plaintext, and since #630 never
// carries the DEK in the clear either — see the custody bullet above.

// Schema/export audit #883: the legacy authority stores fold into one table
// and the SET of decisions carried is unchanged — only where they live.
// `share.authority` and `share.delivery_config` enter the walk; `share.grant`
// and `enrich.consent` leave it with the tables rung six drops. The member's
// device trust moves out of `access_device.trust` into a row of its own, so
// that table's `SELECT *` narrows by exactly the value that moved. No adapter,
// no content bytes. Watch `share_delivery_config`: dropping it would silently
// reset a per-grant size ceiling to the vault-wide default, which is why it is
// registered rather than treated as derivable machinery.

// Schema/export audit #883 (entity catalog extract): `VAULT_ENTITIES` moved
// from tables.ts to schema/entity-catalog.ts so engine W can read the
// declarations. No table, no column, no sealed cell. `listVaultEntities`
// still walks `VAULT_TABLES` derived from that catalog; `exportVault`'s
// SELECT * is unchanged. The schema-dir hash includes the new module and
// `entity-labels.test.ts`, which is why the fingerprint moved again.

// Schema/export audit #903 (linked account is the one way to share): NOTHING
// to carry. No table, no column, no sealed cell. Every changed line in
// schema/share-grant.ts is a COMMENT, `share_fulfillment`'s state CHECK
// byte-identical; schema/poly-refs.ts carries no DDL, its new
// `PARTY_POINTER_REGISTRY` being a MERGE-time list of FK-less party pointers,
// which rewrites rows the walk already carries. `core.share_origin` and
// `share.party_vault_binding` — the entities this issue's Docs manifest reads —
// were already registered and already exported.

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
  /**
   * What this bundle can do with the vault's secrets (#630):
   *  - `ciphertext-only` — sealed cells are here, nothing that opens them is.
   *  - `recovery-kit` — a password-wrapped `custody/recovery-kit.json` rides
   *    along; the passphrase is the owner's, held nowhere in the file.
   */
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
  /**
   * Owner-chosen passphrase for the custody kit. Absent → the bundle carries
   * no key at all, and an import of its sealed cells is refused (as it should
   * be: there is nothing to open them with).
   */
  passphrase?: string;
}

export async function exportPortableVault(
  db: VaultDb,
  owner: Identity,
  options: PortableExportOptions = {}
): Promise<PortableExport> {
  // Keep this owner in the schema/export ratchet — see the header.
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
    // Canonical rows keep sealed CIPHERTEXT and the bundle carries no key in
    // the clear. With a passphrase the DEK rides password-wrapped, so the
    // header's promise holds literally: no plaintext reaches the surface.
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
  /**
   * Passphrase for the bundle's `custody/recovery-kit.json`. Required whenever
   * the bundle carries sealed values; the unwrapped key is used to RE-SEAL them
   * under this vault's own key and is never installed here.
   */
  passphrase?: string;
}

/**
 * Restore a bundle. Secrets are the load-bearing part (#630):
 *  - a bundle whose sealed cells have no kit is refused before any row lands;
 *  - a kit without its passphrase is refused the same way;
 *  - with both, the source key is unwrapped in memory, every sealed cell is
 *    re-sealed under THIS vault's key, and the source key is dropped.
 */
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
    // Pre-#630 bundles shipped the DEK in the clear beside the ciphertext it
    // opens. Accepting one would keep that artifact alive and useful.
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
  // `importVaultExport` refuses sealed values with no key, before any write.
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
