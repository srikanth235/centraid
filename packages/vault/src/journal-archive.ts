// governance: allow-repo-hygiene file-size-limit (#367) one coherent archival engine — the eligibility closure, segment builder, hash-chained manifest writer, and its verifier are one integrity unit; splitting the chain-hash writer from its verifier invites drift
// Journal archival (#367 §E2): seal rows past the window into CAS; keep the manifest. Two streams match FK topology (provenance chain; invocation↔receipt cluster under deferred FKs).
// NEEDS-WIRING (#367): nothing calls `runJournalArchival` automatically. Window-gated AND call-gated.

import type { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";

import { sha256OfBytes } from "./blob/store.js";
import type { VaultDb } from "./db.js";
import { nowIso, sha256Hex, uuidv7 } from "./ids.js";

/** Rows older than this are eligible for archival, unless overridden. */
export const DEFAULT_JOURNAL_ARCHIVE_WINDOW_DAYS = 90;

/** Cap per run (#659 L2) — without it a first archival is an unbounded memory spike. */
export const DEFAULT_JOURNAL_ARCHIVE_MAX_ROWS = 5_000;

const SEGMENT_VERSION = 1;

export type JournalArchiveStream = "provenance" | "invocation_cluster";

export interface JournalArchiveManifestRow {
  manifestId: string;
  stream: JournalArchiveStream;
  fromId: string | null;
  toId: string | null;
  fromTime: string;
  toTime: string;
  rowCount: number;
  segmentSha256: string;
  segmentBytes: number;
  prevManifestId: string | null;
  chainHash: string;
  createdAt: string;
}

export interface JournalArchivalOptions {
  /** Rows fully older than this many days from `now` are eligible. Default 90. */
  windowDays?: number;
  now?: string;
  /** Default `DEFAULT_JOURNAL_ARCHIVE_MAX_ROWS`. */
  maxRowsPerRun?: number;
}

export interface JournalArchivalResult {
  /** One manifest per stream that produced a segment this run (0, 1, or 2). */
  manifests: JournalArchiveManifestRow[];
  rowsArchived: number;
  reclaim: { mode: "incremental" | "none"; ranVacuum: boolean };
  /**
   * A stream hit `maxRowsPerRun`: there is more to archive and the host should
   * run again rather than wait for the next daily gate.
   */
  capped: boolean;
}

export interface ArchivedSegmentRows {
  version: number;
  stream: JournalArchiveStream;
  /** Physical table name → the exact rows deleted (`SELECT *` shape). */
  rows: Record<string, Record<string, unknown>[]>;
}

export interface ArchiveVerification {
  manifestId: string;
  segmentPresent: boolean;
  segmentHashOk: boolean;
  /** Recomputed chain_hash (folding the prior manifest's) matches. */
  chainHashOk: boolean;
  rowCountOk: boolean;
  ok: boolean;
}

type Row = Record<string, unknown>;

function daysBeforeIso(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** SQLite bind-parameter limits mean big IN() lists need chunking. */
const ID_CHUNK = 500;

function selectByIds(
  journal: DatabaseSync,
  table: string,
  column: string,
  ids: readonly string[]
): Row[] {
  if (ids.length === 0) return [];
  const out: Row[] = [];
  for (const part of chunk(ids, ID_CHUNK)) {
    const placeholders = part.map(() => "?").join(", ");
    out.push(
      ...(journal
        .prepare(`SELECT * FROM ${table} WHERE ${column} IN (${placeholders})`)
        .all(...part) as Row[])
    );
  }
  return out;
}

function deleteByIds(
  journal: DatabaseSync,
  table: string,
  column: string,
  ids: readonly string[]
): void {
  for (const part of chunk(ids, ID_CHUNK)) {
    const placeholders = part.map(() => "?").join(", ");
    journal
      .prepare(`DELETE FROM ${table} WHERE ${column} IN (${placeholders})`)
      .run(...part);
  }
}

function selectColumnsByIds<T>(
  journal: DatabaseSync,
  sqlFor: (placeholders: string) => string,
  ids: readonly string[]
): T[] {
  if (ids.length === 0) return [];
  const out: T[] = [];
  for (const part of chunk(ids, ID_CHUNK)) {
    const placeholders = part.map(() => "?").join(", ");
    out.push(...(journal.prepare(sqlFor(placeholders)).all(...part) as T[]));
  }
  return out;
}

/**
 * Invocation⇄receipt mutual-FK closure: oldest `maxRows` invocations, then drop any whose linked receipt is too young, missing, or shared.
 * Cost (#659 L2): id-scoped queries over candidates, never full scans. Worklist fixed-point, linear in edges.
 */
function computeEligibleCluster(
  journal: DatabaseSync,
  cutoff: string,
  maxRows: number
): {
  invocationIds: Set<string>;
  receiptIds: Set<string>;
  capped: boolean;
} {
  const candidates = journal
    .prepare(
      `SELECT invocation_id FROM agent_command_invocation
        WHERE requested_at < ?
        ORDER BY requested_at, invocation_id
        LIMIT ?`
    )
    .all(cutoff, maxRows) as { invocation_id: string }[];
  const eligible = new Set(candidates.map((r) => r.invocation_id));
  const capped = candidates.length >= maxRows;
  if (eligible.size === 0)
    return { invocationIds: eligible, receiptIds: new Set(), capped };

  const candidateIds = [...eligible];
  const ownReceipts = selectColumnsByIds<{
    invocation_id: string;
    receipt_id: string;
  }>(
    journal,
    (p) =>
      `SELECT invocation_id, receipt_id FROM agent_command_invocation
        WHERE receipt_id IS NOT NULL AND invocation_id IN (${p})`,
    candidateIds
  );
  const receiptsOfCandidates = selectColumnsByIds<{
    receipt_id: string;
    invocation_id: string;
    occurred_at: string;
  }>(
    journal,
    (p) =>
      `SELECT receipt_id, invocation_id, occurred_at FROM consent_receipt
        WHERE invocation_id IS NOT NULL AND invocation_id IN (${p})`,
    candidateIds
  );

  // Every receipt any candidate touches, in either FK direction.
  const touchedReceiptIds = new Set<string>();
  for (const r of ownReceipts) touchedReceiptIds.add(r.receipt_id);
  for (const r of receiptsOfCandidates) touchedReceiptIds.add(r.receipt_id);
  const receiptIdList = [...touchedReceiptIds];

  // …and every invocation touching one of THOSE receipts, candidate or not: an
  // outside referrer is exactly what blocks a shared receipt.
  const receiptRows = selectColumnsByIds<{
    receipt_id: string;
    invocation_id: string | null;
    occurred_at: string;
  }>(
    journal,
    (p) =>
      `SELECT receipt_id, invocation_id, occurred_at FROM consent_receipt
        WHERE receipt_id IN (${p})`,
    receiptIdList
  );
  const outsideReferrers = selectColumnsByIds<{
    invocation_id: string;
    receipt_id: string;
  }>(
    journal,
    (p) =>
      `SELECT invocation_id, receipt_id FROM agent_command_invocation
        WHERE receipt_id IN (${p})`,
    receiptIdList
  );

  const linked = new Map<string, Set<string>>(); // invocationId -> receiptIds
  const referrers = new Map<string, Set<string>>(); // receiptId -> invocationIds
  const addLink = (inv: string, rec: string): void => {
    let recs = linked.get(inv);
    if (!recs) {
      recs = new Set();
      linked.set(inv, recs);
    }
    recs.add(rec);
    let invs = referrers.get(rec);
    if (!invs) {
      invs = new Set();
      referrers.set(rec, invs);
    }
    invs.add(inv);
  };
  for (const r of ownReceipts) addLink(r.invocation_id, r.receipt_id);
  for (const r of outsideReferrers) addLink(r.invocation_id, r.receipt_id);
  for (const r of receiptRows)
    if (r.invocation_id !== null) addLink(r.invocation_id, r.receipt_id);

  const receiptTime = new Map(
    receiptRows.map((r) => [r.receipt_id, r.occurred_at])
  );

  const worklist = [...eligible];
  const drop = (inv: string): void => {
    if (!eligible.delete(inv)) return;
    // Its receipts' other referrers now sit beside a non-eligible referrer.
    for (const rec of linked.get(inv) ?? [])
      for (const other of referrers.get(rec) ?? []) worklist.push(other);
  };
  while (worklist.length > 0) {
    const inv = worklist.pop() as string;
    if (!eligible.has(inv)) continue;
    for (const rec of linked.get(inv) ?? []) {
      const occurredAt = receiptTime.get(rec);
      const tooYoung = occurredAt === undefined || occurredAt >= cutoff;
      const blockedByOutsider = [...(referrers.get(rec) ?? [])].some(
        (other) => !eligible.has(other)
      );
      if (tooYoung || blockedByOutsider) {
        drop(inv);
        break;
      }
    }
  }

  const receiptIds = new Set<string>();
  for (const inv of eligible)
    for (const rec of linked.get(inv) ?? []) receiptIds.add(rec);
  return { invocationIds: eligible, receiptIds, capped };
}

/**
 * prov_id values a LIVE (not-being-archived) agent_evidence row still points
 * at, restricted to the candidates in hand — never a full scan (#659 L2).
 */
function liveEvidenceProvRefs(
  journal: DatabaseSync,
  eligibleInvocationIds: Set<string>,
  candidateProvIds: readonly string[]
): Set<string> {
  const rows = selectColumnsByIds<{ prov_id: string; invocation_id: string }>(
    journal,
    (p) =>
      `SELECT prov_id, invocation_id FROM agent_evidence
        WHERE prov_id IS NOT NULL AND prov_id IN (${p})`,
    candidateProvIds
  );
  const blocked = new Set<string>();
  for (const r of rows)
    if (!eligibleInvocationIds.has(r.invocation_id)) blocked.add(r.prov_id);
  return blocked;
}

/** The oldest `maxRows` provenance rows whose chain successors are also old. */
function selectProvenanceCandidates(
  journal: DatabaseSync,
  cutoff: string,
  maxRows: number
): Row[] {
  return journal
    .prepare(
      `SELECT * FROM consent_provenance p
        WHERE p.occurred_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM consent_provenance c
             WHERE c.prev_prov_id = p.prov_id AND c.occurred_at >= ?
          )
        ORDER BY p.occurred_at, p.prov_id
        LIMIT ?`
    )
    .all(cutoff, cutoff, maxRows) as Row[];
}

interface SegmentBuild {
  bytes: Buffer;
  rowCount: number;
  fromId: string | null;
  toId: string | null;
  fromTime: string;
  toTime: string;
}

/** Row-by-row gzip (#659) — whole-payload stringify peaked at ~3x the segment. Byte-identical to `JSON.stringify(payload)`. */
function gzipJson(payload: ArchivedSegmentRows): Buffer {
  const chunks: Buffer[] = [];
  const push = (text: string): void => {
    chunks.push(Buffer.from(text, "utf8"));
  };
  push(
    `{"version":${JSON.stringify(payload.version)},"stream":${JSON.stringify(
      payload.stream
    )},"rows":{`
  );
  let firstTable = true;
  for (const [table, rows] of Object.entries(payload.rows)) {
    push(`${firstTable ? "" : ","}${JSON.stringify(table)}:[`);
    firstTable = false;
    for (const [index, row] of rows.entries())
      push(`${index === 0 ? "" : ","}${JSON.stringify(row)}`);
    push("]");
  }
  push("}}");
  return gzipSync(Buffer.concat(chunks));
}

function buildProvenanceSegment(rows: Row[]): SegmentBuild | null {
  if (rows.length === 0) return null;
  const bytes = gzipJson({
    version: SEGMENT_VERSION,
    stream: "provenance",
    rows: { consent_provenance: rows },
  });
  const ids = rows.map((r) => r.prov_id as string).sort();
  const times = rows.map((r) => r.occurred_at as string).sort();
  return {
    bytes,
    rowCount: rows.length,
    fromId: ids[0] ?? null,
    toId: ids[ids.length - 1] ?? null,
    fromTime: times[0]!,
    toTime: times[times.length - 1]!,
  };
}

interface ClusterTables {
  agent_command_invocation: Row[];
  consent_receipt: Row[];
  agent_invocation_check: Row[];
  agent_evidence: Row[];
  agent_explanation: Row[];
}

function buildClusterSegment(tables: ClusterTables): SegmentBuild | null {
  const total = Object.values(tables).reduce((n, rs) => n + rs.length, 0);
  if (total === 0) return null;
  const bytes = gzipJson({
    version: SEGMENT_VERSION,
    stream: "invocation_cluster",
    rows: tables as unknown as Record<string, Row[]>,
  });
  const invIds = tables.agent_command_invocation
    .map((r) => r.invocation_id as string)
    .sort();
  const invTimes = tables.agent_command_invocation
    .map((r) => r.requested_at as string)
    .sort();
  return {
    bytes,
    rowCount: total,
    fromId: invIds[0] ?? null,
    toId: invIds[invIds.length - 1] ?? null,
    fromTime: invTimes[0]!,
    toTime: invTimes[invTimes.length - 1]!,
  };
}

function lastManifestChain(
  journal: DatabaseSync
): { manifestId: string; chainHash: string } | undefined {
  const row = journal
    .prepare(
      `SELECT manifest_id, chain_hash FROM journal_archive_manifest ORDER BY rowid DESC LIMIT 1`
    )
    .get() as { manifest_id: string; chain_hash: string } | undefined;
  return row
    ? { manifestId: row.manifest_id, chainHash: row.chain_hash }
    : undefined;
}

function computeChainHash(args: {
  prevChainHash: string;
  manifestId: string;
  stream: JournalArchiveStream;
  rowCount: number;
  fromTime: string;
  toTime: string;
  segmentSha256: string;
}): string {
  return sha256Hex(
    JSON.stringify([
      args.prevChainHash,
      args.manifestId,
      args.stream,
      args.rowCount,
      args.fromTime,
      args.toTime,
      args.segmentSha256,
    ])
  );
}

function insertManifest(
  journal: DatabaseSync,
  args: {
    stream: JournalArchiveStream;
    seg: SegmentBuild;
    sha256: string;
    createdAt: string;
  }
): JournalArchiveManifestRow {
  const prev = lastManifestChain(journal);
  const manifestId = uuidv7();
  const chainHash = computeChainHash({
    prevChainHash: prev?.chainHash ?? "",
    manifestId,
    stream: args.stream,
    rowCount: args.seg.rowCount,
    fromTime: args.seg.fromTime,
    toTime: args.seg.toTime,
    segmentSha256: args.sha256,
  });
  journal
    .prepare(
      `INSERT INTO journal_archive_manifest
         (manifest_id, stream, from_id, to_id, from_time, to_time, row_count, segment_sha256, segment_bytes, prev_manifest_id, chain_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      manifestId,
      args.stream,
      args.seg.fromId,
      args.seg.toId,
      args.seg.fromTime,
      args.seg.toTime,
      args.seg.rowCount,
      args.sha256,
      args.seg.bytes.length,
      prev?.manifestId ?? null,
      chainHash,
      args.createdAt
    );
  return {
    manifestId,
    stream: args.stream,
    fromId: args.seg.fromId,
    toId: args.seg.toId,
    fromTime: args.seg.fromTime,
    toTime: args.seg.toTime,
    rowCount: args.seg.rowCount,
    segmentSha256: args.sha256,
    segmentBytes: args.seg.bytes.length,
    prevManifestId: prev?.manifestId ?? null,
    chainHash,
    createdAt: args.createdAt,
  };
}

function reclaimModeOf(journal: DatabaseSync): "incremental" | "none" {
  const av = (
    journal.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number }
  ).auto_vacuum;
  return av === 2 ? "incremental" : "none";
}

/**
 * Reclaim the pages the deletes freed. `journal.db` is opened with
 * `PRAGMA auto_vacuum = INCREMENTAL` (#438), so `incremental_vacuum` returns
 * the freelist to the OS without rewriting the file. Open-time setup converts
 * any pre-#438 file first; archival never falls back to a whole-file `VACUUM`.
 */
function reclaimSpace(journal: DatabaseSync): {
  mode: "incremental" | "none";
  ranVacuum: boolean;
} {
  const freelist = (
    journal.prepare("PRAGMA freelist_count").get() as { freelist_count: number }
  ).freelist_count;
  const mode = reclaimModeOf(journal);
  if (freelist === 0) return { mode, ranVacuum: false };
  if (mode === "incremental") {
    journal.exec("PRAGMA incremental_vacuum");
    return { mode, ranVacuum: true };
  }
  return { mode, ranVacuum: false };
}

/** Claimed CAS shas — MUST join `liveBlobShas()` or the remote sweep deletes the only durable copy. */
export function archivedSegmentShas(journal: DatabaseSync): Set<string> {
  const shas = new Set<string>();
  const rows = journal
    .prepare(`SELECT segment_sha256 FROM journal_archive_manifest`)
    .all() as {
    segment_sha256: string;
  }[];
  for (const r of rows) shas.add(r.segment_sha256);
  return shas;
}

/**
 * Seal journal rows past the active window into CAS segments, record a manifest
 * per stream, then delete the archived rows and reclaim pages. A no-op with no
 * CAS writes when nothing is old enough — always true for a fresh vault.
 */
export function runJournalArchival(
  db: VaultDb,
  options: JournalArchivalOptions = {}
): JournalArchivalResult {
  const windowDays = options.windowDays ?? DEFAULT_JOURNAL_ARCHIVE_WINDOW_DAYS;
  if (windowDays <= 0)
    throw new Error(
      "journal archival window must be a positive number of days"
    );
  const maxRows = options.maxRowsPerRun ?? DEFAULT_JOURNAL_ARCHIVE_MAX_ROWS;
  if (maxRows <= 0)
    throw new Error("journal archival maxRowsPerRun must be a positive count");
  const now = options.now ?? nowIso();
  const cutoff = daysBeforeIso(now, windowDays);
  const journal = db.journal;

  // Phase 1 — eligibility. Reads only; no lock held past each query.
  const cluster = computeEligibleCluster(journal, cutoff, maxRows);
  const clusterTables: ClusterTables | null =
    cluster.invocationIds.size > 0
      ? {
          agent_command_invocation: selectByIds(
            journal,
            "agent_command_invocation",
            "invocation_id",
            [...cluster.invocationIds]
          ),
          consent_receipt: selectByIds(
            journal,
            "consent_receipt",
            "receipt_id",
            [...cluster.receiptIds]
          ),
          agent_invocation_check: selectByIds(
            journal,
            "agent_invocation_check",
            "invocation_id",
            [...cluster.invocationIds]
          ),
          agent_evidence: selectByIds(
            journal,
            "agent_evidence",
            "invocation_id",
            [...cluster.invocationIds]
          ),
          agent_explanation: selectByIds(
            journal,
            "agent_explanation",
            "invocation_id",
            [...cluster.invocationIds]
          ),
        }
      : null;

  const provCandidates = selectProvenanceCandidates(journal, cutoff, maxRows);
  const blockedByEvidence = liveEvidenceProvRefs(
    journal,
    cluster.invocationIds,
    provCandidates.map((r) => r.prov_id as string)
  );
  const provRows = provCandidates.filter(
    (r) => !blockedByEvidence.has(r.prov_id as string)
  );
  const capped = cluster.capped || provCandidates.length >= maxRows;

  const provSeg = buildProvenanceSegment(provRows);
  const clusterSeg = clusterTables ? buildClusterSegment(clusterTables) : null;

  if (!provSeg && !clusterSeg) {
    return {
      manifests: [],
      rowsArchived: 0,
      reclaim: { mode: reclaimModeOf(journal), ranVacuum: false },
      capped,
    };
  }

  // Phase 2 — write segments to the local CAS (idempotent by content address)
  // BEFORE opening the write transaction, so the lock's held window is just the
  // manifest insert plus the deletes.
  const provIngest = provSeg ? db.blobs.ingestSync(provSeg.bytes) : null;
  const clusterIngest = clusterSeg
    ? db.blobs.ingestSync(clusterSeg.bytes)
    : null;

  const manifests: JournalArchiveManifestRow[] = [];
  let rowsArchived = 0;

  journal.exec("BEGIN");
  try {
    // Deferred FK checking is what makes the invocation⇄receipt mutual
    // reference deletable at all — see the module header.
    journal.exec("PRAGMA defer_foreign_keys = ON");

    if (provSeg && provIngest) {
      manifests.push(
        insertManifest(journal, {
          stream: "provenance",
          seg: provSeg,
          sha256: provIngest.sha256,
          createdAt: now,
        })
      );
      rowsArchived += provSeg.rowCount;
      deleteByIds(
        journal,
        "consent_provenance",
        "prov_id",
        provRows.map((r) => r.prov_id as string)
      );
    }

    if (clusterSeg && clusterIngest && clusterTables) {
      manifests.push(
        insertManifest(journal, {
          stream: "invocation_cluster",
          seg: clusterSeg,
          sha256: clusterIngest.sha256,
          createdAt: now,
        })
      );
      rowsArchived += clusterSeg.rowCount;
      // Children first (pure leaves — nothing references them).
      deleteByIds(
        journal,
        "agent_invocation_check",
        "check_id",
        clusterTables.agent_invocation_check.map((r) => r.check_id as string)
      );
      deleteByIds(
        journal,
        "agent_evidence",
        "evidence_id",
        clusterTables.agent_evidence.map((r) => r.evidence_id as string)
      );
      deleteByIds(
        journal,
        "agent_explanation",
        "explanation_id",
        clusterTables.agent_explanation.map((r) => r.explanation_id as string)
      );
      // The mutual pair — order is free under defer_foreign_keys.
      deleteByIds(
        journal,
        "consent_receipt",
        "receipt_id",
        clusterTables.consent_receipt.map((r) => r.receipt_id as string)
      );
      deleteByIds(
        journal,
        "agent_command_invocation",
        "invocation_id",
        clusterTables.agent_command_invocation.map(
          (r) => r.invocation_id as string
        )
      );
    }
    journal.exec("COMMIT");
  } catch (error) {
    journal.exec("ROLLBACK");
    throw error;
  }

  const reclaim = reclaimSpace(journal);
  return { manifests, rowsArchived, reclaim, capped };
}

function rowToManifest(row: Row): JournalArchiveManifestRow {
  return {
    manifestId: row.manifest_id as string,
    stream: row.stream as JournalArchiveStream,
    fromId: (row.from_id as string | null) ?? null,
    toId: (row.to_id as string | null) ?? null,
    fromTime: row.from_time as string,
    toTime: row.to_time as string,
    rowCount: row.row_count as number,
    segmentSha256: row.segment_sha256 as string,
    segmentBytes: row.segment_bytes as number,
    prevManifestId: (row.prev_manifest_id as string | null) ?? null,
    chainHash: row.chain_hash as string,
    createdAt: row.created_at as string,
  };
}

export function findArchiveManifest(
  journal: DatabaseSync,
  manifestId: string
): JournalArchiveManifestRow | undefined {
  const row = journal
    .prepare(`SELECT * FROM journal_archive_manifest WHERE manifest_id = ?`)
    .get(manifestId) as Row | undefined;
  return row ? rowToManifest(row) : undefined;
}

/** Oldest first — the audit trail of what got sealed away. */
export function listArchiveManifests(
  journal: DatabaseSync,
  stream?: JournalArchiveStream
): JournalArchiveManifestRow[] {
  const rows = (
    stream
      ? journal
          .prepare(
            `SELECT * FROM journal_archive_manifest WHERE stream = ? ORDER BY rowid`
          )
          .all(stream)
      : journal
          .prepare(`SELECT * FROM journal_archive_manifest ORDER BY rowid`)
          .all()
  ) as Row[];
  return rows.map(rowToManifest);
}

export function readArchivedSegment(
  db: VaultDb,
  manifest: JournalArchiveManifestRow
): ArchivedSegmentRows {
  const bytes = db.blobs.getSync(manifest.segmentSha256);
  if (!bytes) {
    throw new Error(
      `archive segment ${manifest.segmentSha256} for manifest ${manifest.manifestId} is missing from the blob CAS`
    );
  }
  return JSON.parse(gunzipSync(bytes).toString("utf8")) as ArchivedSegmentRows;
}

/**
 * Prove one manifest's segment is intact and its chain position genuine: the
 * CAS still has the bytes, their sha256 matches, the decoded row count matches,
 * and `chain_hash` recomputes from its predecessor. Never mutates anything.
 */
export function verifyArchivedSegment(
  db: VaultDb,
  manifest: JournalArchiveManifestRow
): ArchiveVerification {
  const bytes = db.blobs.getSync(manifest.segmentSha256);
  const segmentPresent = bytes !== null;
  const segmentHashOk =
    segmentPresent && sha256OfBytes(bytes!) === manifest.segmentSha256;
  let rowCountOk = false;
  if (segmentPresent && segmentHashOk) {
    try {
      const parsed = JSON.parse(
        gunzipSync(bytes!).toString("utf8")
      ) as ArchivedSegmentRows;
      const total = Object.values(parsed.rows).reduce(
        (n, rs) => n + rs.length,
        0
      );
      rowCountOk = total === manifest.rowCount;
    } catch {
      rowCountOk = false;
    }
  }
  const prev = manifest.prevManifestId
    ? findArchiveManifest(db.journal, manifest.prevManifestId)
    : undefined;
  const expectedChainHash = computeChainHash({
    prevChainHash: prev?.chainHash ?? "",
    manifestId: manifest.manifestId,
    stream: manifest.stream,
    rowCount: manifest.rowCount,
    fromTime: manifest.fromTime,
    toTime: manifest.toTime,
    segmentSha256: manifest.segmentSha256,
  });
  const chainHashOk = expectedChainHash === manifest.chainHash;
  return {
    manifestId: manifest.manifestId,
    segmentPresent,
    segmentHashOk,
    chainHashOk,
    rowCountOk,
    ok: segmentPresent && segmentHashOk && chainHashOk && rowCountOk,
  };
}
