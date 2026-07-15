// Real journal.db rows, seeded with old timestamps, archived, verified.
// No mocks: `openVaultDb({})` (in-memory) gives a real DatabaseSync pair and
// a real BlobCustody backed by MemoryBlobStore, so `ingestSync`/`getSync`
// exercise the exact CAS path a real vault uses.

import { expect, test } from 'vitest';
import { openVaultDb, type VaultDb } from './db.js';
import { nowIso, sha256Hex, uuidv7 } from './ids.js';
import {
  findArchiveManifest,
  listArchiveManifests,
  readArchivedSegment,
  runJournalArchival,
  verifyArchivedSegment,
} from './journal-archive.js';

function daysAgoIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

function seedProvenance(
  db: VaultDb,
  args: { entityId: string; occurredAt: string; prevProvId?: string | null },
): string {
  const provId = uuidv7();
  db.journal
    .prepare(
      `INSERT INTO consent_provenance
         (prov_id, entity_type, entity_id, prov_activity, agent_kind, agent_id, used_json, occurred_at, prev_prov_id, signature)
       VALUES (?, 'knowledge.note', ?, 'create', 'owner', 'owner-device', NULL, ?, ?, NULL)`,
    )
    .run(provId, args.entityId, args.occurredAt, args.prevProvId ?? null);
  return provId;
}

function seedInvocationCluster(
  db: VaultDb,
  args: { requestedAt: string; receiptAt: string },
): {
  invocationId: string;
  receiptId: string;
  checkId: string;
  evidenceId: string;
  explanationId: string;
} {
  const invocationId = uuidv7();
  const receiptId = uuidv7();
  // Insert order respects the mutual FK at CREATE time (no defer here, only
  // the archival transaction turns that on): invocation first with
  // receipt_id NULL, then the receipt (which can reference the now-live
  // invocation), then back-fill the invocation's receipt_id — exactly the
  // real write path in gateway/execution.ts (requested → receipted).
  db.journal
    .prepare(
      `INSERT INTO agent_command_invocation
         (invocation_id, command_id, agent_id, grant_id, input_json, status, requested_at, executed_at, receipt_id)
       VALUES (?, 'cmd-1', 'agent-1', NULL, '{}', 'executed', ?, ?, NULL)`,
    )
    .run(invocationId, args.requestedAt, args.receiptAt);
  db.journal
    .prepare(
      `INSERT INTO consent_receipt
         (receipt_id, grant_id, invocation_id, action, object_type, object_id, purpose_concept_id, decision, occurred_at, hash, detail_json)
       VALUES (?, NULL, ?, 'act knowledge.create_note', 'knowledge.note', NULL, NULL, 'allow', ?, ?, NULL)`,
    )
    .run(receiptId, invocationId, args.receiptAt, sha256Hex(receiptId));
  db.journal
    .prepare('UPDATE agent_command_invocation SET receipt_id = ? WHERE invocation_id = ?')
    .run(receiptId, invocationId);
  const checkId = uuidv7();
  db.journal
    .prepare(
      `INSERT INTO agent_invocation_check (check_id, invocation_id, phase, predicate, passed, observed_json, checked_at)
       VALUES (?, ?, 'pre', 'p', 1, NULL, ?)`,
    )
    .run(checkId, invocationId, args.requestedAt);
  const evidenceId = uuidv7();
  db.journal
    .prepare(
      `INSERT INTO agent_evidence (evidence_id, invocation_id, claim, entity_type, entity_id, prov_id, weight)
       VALUES (?, ?, 'claim', 'knowledge.note', 'note-1', NULL, NULL)`,
    )
    .run(evidenceId, invocationId);
  const explanationId = uuidv7();
  db.journal
    .prepare(
      `INSERT INTO agent_explanation (explanation_id, invocation_id, audience, summary, generated_at)
       VALUES (?, ?, 'owner', 'summary', ?)`,
    )
    .run(explanationId, invocationId, args.requestedAt);
  return { invocationId, receiptId, checkId, evidenceId, explanationId };
}

test('archives old provenance rows into a CAS segment and drops them from journal.db', () => {
  const db = openVaultDb({});
  const oldId = seedProvenance(db, { entityId: 'note-1', occurredAt: daysAgoIso(120) });
  const freshId = seedProvenance(db, { entityId: 'note-2', occurredAt: daysAgoIso(1) });

  const result = runJournalArchival(db, { windowDays: 90 });

  expect(result.rowsArchived).toBe(1);
  expect(result.manifests).toHaveLength(1);
  const manifest = result.manifests[0]!;
  expect(manifest.stream).toBe('provenance');
  expect(manifest.rowCount).toBe(1);

  const remaining = db.journal.prepare('SELECT prov_id FROM consent_provenance').all() as {
    prov_id: string;
  }[];
  expect(remaining.map((r) => r.prov_id)).toEqual([freshId]);

  const segment = readArchivedSegment(db, manifest);
  expect(segment.stream).toBe('provenance');
  expect(segment.rows.consent_provenance).toHaveLength(1);
  expect((segment.rows.consent_provenance![0] as { prov_id: string }).prov_id).toBe(oldId);

  const verification = verifyArchivedSegment(db, manifest);
  expect(verification.ok).toBe(true);
  expect(verification).toMatchObject({
    segmentPresent: true,
    segmentHashOk: true,
    chainHashOk: true,
    rowCountOk: true,
  });
});

test('a provenance row is kept when a live row still chains back to it', () => {
  const db = openVaultDb({});
  const oldId = seedProvenance(db, { entityId: 'note-1', occurredAt: daysAgoIso(120) });
  // A fresh row points BACK at the old one — deleting the old row would
  // dangle this FK, so the old row must stay this run.
  seedProvenance(db, { entityId: 'note-1', occurredAt: daysAgoIso(1), prevProvId: oldId });

  const result = runJournalArchival(db, { windowDays: 90 });

  expect(result.rowsArchived).toBe(0);
  expect(result.manifests).toHaveLength(0);
  const remaining = db.journal.prepare('SELECT prov_id FROM consent_provenance').all();
  expect(remaining).toHaveLength(2);
});

test('archives a full invocation cluster (invocation, receipt, check, evidence, explanation) as one unit', () => {
  const db = openVaultDb({});
  const old = seedInvocationCluster(db, {
    requestedAt: daysAgoIso(120),
    receiptAt: daysAgoIso(120),
  });
  const fresh = seedInvocationCluster(db, { requestedAt: daysAgoIso(1), receiptAt: daysAgoIso(1) });

  const result = runJournalArchival(db, { windowDays: 90 });

  expect(result.manifests).toHaveLength(1);
  const manifest = result.manifests[0]!;
  expect(manifest.stream).toBe('invocation_cluster');
  expect(manifest.rowCount).toBe(5); // invocation + receipt + check + evidence + explanation
  expect(result.rowsArchived).toBe(5);

  for (const table of [
    'agent_command_invocation',
    'consent_receipt',
    'agent_invocation_check',
    'agent_evidence',
    'agent_explanation',
  ]) {
    const rows = db.journal.prepare(`SELECT * FROM ${table}`).all();
    expect(rows).toHaveLength(1); // only the fresh cluster survives
  }
  const survivingInvocation = db.journal
    .prepare('SELECT invocation_id FROM agent_command_invocation')
    .get() as { invocation_id: string };
  expect(survivingInvocation.invocation_id).toBe(fresh.invocationId);

  const segment = readArchivedSegment(db, manifest);
  expect(segment.rows.agent_command_invocation).toHaveLength(1);
  expect(
    (segment.rows.agent_command_invocation![0] as { invocation_id: string }).invocation_id,
  ).toBe(old.invocationId);
  expect(verifyArchivedSegment(db, manifest).ok).toBe(true);
});

test('an invocation cluster stays live when its receipt is younger than the window', () => {
  const db = openVaultDb({});
  // Invocation is old, but its receipt landed recently (edge case) —
  // archiving the invocation would dangle the receipt's FK, so both stay.
  seedInvocationCluster(db, { requestedAt: daysAgoIso(120), receiptAt: daysAgoIso(1) });

  const result = runJournalArchival(db, { windowDays: 90 });

  expect(result.rowsArchived).toBe(0);
  const invocations = db.journal.prepare('SELECT * FROM agent_command_invocation').all();
  expect(invocations).toHaveLength(1);
});

test('a fresh vault archives nothing (window- and call-gated)', () => {
  const db = openVaultDb({});
  seedProvenance(db, { entityId: 'note-1', occurredAt: daysAgoIso(1) });
  seedInvocationCluster(db, { requestedAt: daysAgoIso(1), receiptAt: daysAgoIso(1) });

  const result = runJournalArchival(db, { windowDays: 90 });

  expect(result.manifests).toHaveLength(0);
  expect(result.rowsArchived).toBe(0);
});

test('the manifest chain links across archival runs — each chain_hash folds the last', () => {
  const db = openVaultDb({});
  seedProvenance(db, { entityId: 'note-1', occurredAt: daysAgoIso(120) });

  const first = runJournalArchival(db, { windowDays: 90, now: daysAgoIso(0) });
  expect(first.manifests).toHaveLength(1);

  seedProvenance(db, { entityId: 'note-2', occurredAt: daysAgoIso(150) });
  const second = runJournalArchival(db, { windowDays: 90, now: nowIso() });
  expect(second.manifests).toHaveLength(1);
  expect(second.manifests[0]!.prevManifestId).toBe(first.manifests[0]!.manifestId);

  const all = listArchiveManifests(db.journal, 'provenance');
  expect(all.map((m) => m.manifestId)).toEqual([
    first.manifests[0]!.manifestId,
    second.manifests[0]!.manifestId,
  ]);
  expect(verifyArchivedSegment(db, all[1]!).ok).toBe(true);
});

test('verifyArchivedSegment catches a tampered manifest row (chain_hash mismatch)', () => {
  const db = openVaultDb({});
  seedProvenance(db, { entityId: 'note-1', occurredAt: daysAgoIso(120) });
  const result = runJournalArchival(db, { windowDays: 90 });
  const manifest = result.manifests[0]!;

  // Simulate tampering: flip the stored row_count after the fact.
  db.journal
    .prepare('UPDATE journal_archive_manifest SET row_count = row_count + 1 WHERE manifest_id = ?')
    .run(manifest.manifestId);
  const tampered = findArchiveManifest(db.journal, manifest.manifestId)!;

  const verification = verifyArchivedSegment(db, tampered);
  expect(verification.ok).toBe(false);
  expect(verification.chainHashOk).toBe(false);
});

test('rejects a non-positive window', () => {
  const db = openVaultDb({});
  expect(() => runJournalArchival(db, { windowDays: 0 })).toThrow(/positive/);
});
