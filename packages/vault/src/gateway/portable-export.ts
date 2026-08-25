// Portable vault bundle (issue #630): the canonical JSON-LD restore artifact,
// human-readable adapters, every external content byte, and one hash manifest.
// Schema/export audit #679 L2: the sealed enforcement/leak registries are
// policy metadata only; SEALED_COLUMNS remains exported through the canonical
// table walk and introduces no new table or adapter omission.
// The replica schema additions are included by that same canonical table walk;
// this owner is touched whenever the schema fingerprint is deliberately
// re-audited so export completeness cannot drift silently.
// Schema/export audit #712: `media_face_region.review_state` is a new COLUMN
// on an already-walked table, not a new table or adapter — the canonical walk
// carries it, and it must, because it is the only record that the owner
// answered a face proposal (a rejection stopped being a row deletion). A
// restore that dropped it would hand the owner back a review queue they had
// already worked through.
// Schema/export audit #801: the schema fingerprint moved on import remaps
// (`@centraid/time-engine` → `@centraid/core/time`) with no table or adapter
// change.
// Schema/export audit #721: the schema fingerprint moved on comment-only edits
// to schema/enrich.ts (the model-versioning convention is documented in its
// header; no table, column, or CHECK changed). `enrich_embedding` and its
// sibling tables were already carried by the canonical table walk, so export
// completeness is unchanged — derived rows restore exactly like any other row.
// Schema/export audit #864: the schema fingerprint moved on comment-only edits
// to schema/domains-people.ts (S1 purge copy names the party, tags, and
// channels the sweep erases after 30 days; no table, column, or CHECK
// changed). `people_profile` and `people_important_date` were already carried
// by the canonical table walk, so export completeness is unchanged.

// Schema/export audit #724: `enrich_derivation` is a NEW TABLE — the
// provenance stamp naming which capability, under which model, produced a
// target's variant. It is carried by the canonical table walk like every other
// row, and it must be, because a restore that dropped it would hand the owner
// back a library whose derived rows have no producer: the next sweep could not
// tell an up-to-date caption from one an obsolete model wrote, so it would
// either re-derive the whole library or trust stale output forever. It needs
// no adapter — it is machine bookkeeping, not something a human reads outside
// this system — and it carries no content bytes.

// Schema/export audit #724 W5: `media_face_cluster` is a NEW TABLE and
// `enrich.derivation` is a newly REGISTERED one. The canonical table walk is
// `listVaultEntities` (schema/tables.ts) — not "every table in the file" — so
// the stamp table added by W2 was in fact absent from every export until it was
// registered here; it is now, and so is the face-grouping projection.
// Both must be carried, for opposite reasons. The stamp must survive a restore
// because without it the next sweep cannot tell derived output that is current
// from output an obsolete model wrote. The cluster projection is rebuildable
// and could in principle be dropped — it is carried anyway because a restore
// that silently re-derived it would present the owner with a People shelf
// whose unnamed groups had shuffled, and because `media.forget_person`'s
// recovery test asserts on the artifact directly: a table outside the walk
// cannot be proven empty by inspecting an export. Neither needs an adapter
// (machine bookkeeping, not something a human reads) and neither carries bytes.

// Schema/export audit #726 P0: `consent.share` is a DROPPED TABLE — the
// rejected filtering-model share vestige (its one writer was the lifecycle
// sweep's expiry lapse; the real share ledger arrives later as its own table).
// It leaves `listVaultEntities` with the DDL, so the canonical walk no longer
// carries it and a restore artifact simply has no such collection. Nothing to
// migrate on export: no adapter ever read it and it carried no content bytes.

// Schema/export audit #726 P1: `schema/vault-identity.ts` is a NEW FILE that
// declares no table, column, or adapter — it is key custody, and the vault's
// Ed25519 identity seed deliberately stays OUT of the portable bundle, exactly
// as the DEK does. The two artifacts answer different questions. The recovery
// kit says "this same vault, on another machine", so it carries the seed and a
// restored vault keeps proving it is itself to every peer linked to it. A
// portable bundle says "this data, somewhere else": what it restores is a new
// vault that mints its own identity. Carrying the seed here would put a
// signing key into the one artifact designed to be read by other software.
//
// Schema/export audit #726 P2: `enrich_request.reason` gained `projected` — a
// widened CHECK on an already-walked column, not a new table or adapter. The
// canonical walk carries such rows unchanged, and it must: the row is the only
// record that content arriving over a share edge was queued for the audience's
// own enrichment rather than inheriting the origin's derived state. Such rows
// carry `required_capability = NULL`, so no export or lease reads them as work
// a paired device could claim.
//
// Schema/export audit #726 Finding 6: `core_share_origin.shared_by_member`
// is RENAMED to `shared_by` — the household L2 member-principal layer the old
// name implied is gone, and the column now holds an owner id (a co-hosted
// edge) or a `peer:<vaultId>` string (a remote give), never a member id. A
// same-table column rename changes no row shape and adds no table or
// adapter, so the canonical walk carries `core_share_origin` unchanged; a
// restored bundle's provenance rows read exactly as they did before the
// rename, just honestly named.
//
// Schema/export audit #731: the eleven `share.*` Commons tables are NEW and
// registered in `VAULT_TABLES`. They carry the party↔vault binding, durable
// circle grant, per-grant acceptance state, ordered operations, compact
// receipts/replay decisions, logical per-member cursor, projection lineage,
// pending command overlay, and pending peer invitation/receiver-retain marker.
// All eleven
// are control truth or recovery mechanics: dropping any one on export would
// either orphan shared rows, replay/refuse a settled write incorrectly, or
// apply/lose an invitation without the receiver's consent. They need no
// human-readable adapter and contain no content bytes; referenced CAS bytes
// remain covered by the existing canonical content walk and manifest.

// Schema/export audit #743: the autonomous-principal registry is now logical
// `consent.agent` / physical `consent_agent`, with `enrollment_key`; invocation
// evidence names its actor through `caller_id`, and logical `media.asset`
// continues to resolve to physical `media_asset`. The canonical registry walk
// carries the renamed current-v0 tables and columns without an adapter. These
// rows must survive restore because dropping enrollment or caller evidence
// would detach automation grants from the principal that exercised them.
//
// Schema/export audit #750: `share_commons_intent.status` renames its CHECK
// value `pending` to `queued` (one intent grammar — the replica outbox's own
// word) and its partial index follows. `share.commons_intent` stays in the
// canonical walk with an unchanged row shape: no new table, column, or
// adapter, so the walk carries these rows exactly as before. The one honest
// consequence is that a bundle written by a pre-#750 build holds `pending`
// rows this build's CHECK refuses on restore — deliberately not adapted, per
// that issue's stated v0 posture that pre-release on-disk shapes are reset
// rather than migrated.
//
// Schema/export audit #750 (identity): `schema/vault-identity.ts` gains a
// public-key PIN file written beside the seed, so a vault whose seed went
// missing fails closed instead of silently minting a replacement key that
// every already-linked peer would reject. It declares no table, column, or
// adapter, and — like the seed it guards (see the #726 P1 entry above) — the
// pin stays OUT of the portable bundle. Carrying it would be actively wrong
// here, not merely unnecessary: a bundle restores a NEW vault that mints its
// own identity, and a pin from the old one would fail that vault closed
// against a key it never held.

// Schema/export audit #807: `enrich.policy_rule` and `enrich.consent` ride the
// canonical walk by registration (schema/tables.ts, per the #724 W5 note) —
// owner decisions a restore must keep, or it re-asks answered consent and
// loses recorded refusals. No adapter, no content bytes. The
// `enrich_derivation` profile column rides its already-walked table.

// Schema/export audit #821: two edits, neither of which adds a table or an
// adapter. `people_profile.cadence_days` relaxes its CHECK from `> 0` to
// `>= 0` so "never reach out" is storable — a widened domain on an
// already-walked column, and one an export must carry verbatim, because a
// restore that coerced 0 back to some default would start nagging the owner
// about the exact people they had silenced. The relaxation ships as a second
// migration rung (a vault-preserving people_profile rebuild) so files created
// before it get there too; the rebuild re-creates the same columns in the same
// order, so nothing about this walk changes. And `share_party_vault_binding`
// gains a writer on the LINK CEREMONY path (via `share/party-vault-binding.ts`
// — the ceremony had no vault-side writer at all until now, so "is this person
// linked" lived as gateway-side JSON); the table is already
// registered in schema/tables.ts as `share.party_vault_binding`, so the
// canonical walk carries the new rows with no change here. It must: the
// binding is what makes "this person has a vault of their own" survive a
// restore, and losing it would leave a restored vault unable to tell a linked
// person from a stranger until every ceremony was run again. No content bytes.

// Schema/export audit #825: `share.grant` and `share.fulfillment` are two NEW
// TABLES, both registered in schema/tables.ts, so the canonical walk
// (`listVaultEntities` — not "every table in the file", per the #724 W5 note)
// carries them like any other row. Both must be carried, for different
// reasons. `share_grant` is the OWNER DECISION itself — which audience may see
// or edit which subject — held apart from the commons machinery that delivers
// it; a restore that dropped it would hand back a vault that had forgotten
// every share it had ever made, while the projected rows sitting in audience
// vaults kept existing. `share_fulfillment` is per-audience-vault delivery
// state, and dropping it would make a restored vault believe nothing had ever
// been delivered: it would re-send every subject to every peer and could not
// tell a revocation that had been acknowledged from one still in flight.
// Neither needs a human-readable adapter (both are control truth, not
// something a person reads outside this system) and neither carries content
// bytes — a granted subject's bytes are already covered by the canonical
// content walk and manifest through the subject's own tables. Nothing is
// dropped: `share_circle_grant` and the rest of the commons plane stay exactly
// as they were, because commons is now the edit-fulfillment STRATEGY under the
// grant plane rather than a rival record of the same fact. The two tables
// arrive on existing files as migration rung three, whose backfill only reads
// the commons tables and only writes the two new ones.

// Schema/export audit #846 P1: `share_fulfillment` gains one column,
// `delivered_at`, and it MUST be carried. It is the memory that lets a
// revocation know a projection was ever handed to a peer — the whole of P1 is
// that this fact is remembered rather than re-inferred from a live freshness
// reading, because a host that merely lost reach for one pass drops a
// `delivered` row back to `syncing`, and the old code read that as
// never-delivered and settled `removed` while the audience vault still held
// the projection. A restore that dropped the column would restore exactly that
// defect, silently and only for restored vaults. No adapter and no content
// bytes: it is a timestamp on control truth. Nothing else in the export
// changes — `exportVault` walks `SELECT *` over every registered canonical
// table, so a new column on an already-carried table rides along with no code
// change here, which is precisely why the audit is pinned by a test rather
// than by this comment: `portability.test.ts`'s "a delivered fulfillment's
// delivery memory survives export and restore" fails if that walk ever becomes
// a column list. The column arrives on existing files as migration rung four,
// whose rebuild backfills `delivered_at` from `updated_at` for rows already at
// `delivered` or `remove_sent`.

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
  // exportVault walks every registered canonical table and its columns. Keep
  // this owner in the schema/export ratchet so additions such as the Photos
  // custody rollup and source_asset_id are audited against that complete walk.
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
    // Canonical rows retain sealed ciphertext, so blank-machine portability
    // requires the exact DEK. The owner-authorized bundle is already a
    // high-sensitivity artifact; this custody byte-string is manifest-hashed
    // and never exposes a sentinel plaintext to the export surface.
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
  // Entry count is checked before any blob is opened so a huge vault fails
  // cheaply instead of buffering every object then rejecting at zip write.
  // Blobs load sequentially so peak resident set is one content file + zip
  // accumulator rather than every blob at once.
  if (files.length + blobRows.length + 1 > MAX_ZIP_ENTRIES) {
    throw new Error(
      `portable export has too many entries (max ${MAX_ZIP_ENTRIES})`
    );
  }
  // Sequential on purpose: peak RSS is one content object + the zip buffer,
  // not every blob resident at once (review finding on portable export).
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

/** Verified full-bundle import used by the HTTP longevity drill. */
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
