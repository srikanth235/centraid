import { describe, expect, test } from "vitest";

import { openVaultDb } from "./db.js";
import type { VaultDb } from "./db.js";
import { nowIso, sha256Hex, uuidv7 } from "./ids.js";
import {
  findArchiveManifest,
  listArchiveManifests,
  readArchivedSegment,
  runJournalArchival,
  verifyArchivedSegment,
} from "./journal-archive.js";

function daysAgoIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

function seedProvenance(
  db: VaultDb,
  args: { entityId: string; occurredAt: string; prevProvId?: string | null }
): string {
  const provId = uuidv7();
  db.audit
    .prepare(
      `INSERT INTO access_provenance
         (prov_id, entity_type, entity_id, prov_activity, agent_kind, agent_id, used_json, occurred_at, prev_prov_id, signature)
       VALUES (?, 'knowledge.note', ?, 'create', 'owner', 'owner-device', NULL, ?, ?, NULL)`
    )
    .run(provId, args.entityId, args.occurredAt, args.prevProvId ?? null);
  return provId;
}

function seedInvocationCluster(
  db: VaultDb,
  args: { requestedAt: string; receiptAt: string }
): {
  invocationId: string;
  receiptId: string;
  checkId: string;
  evidenceId: string;
  explanationId: string;
} {
  const invocationId = uuidv7();
  const receiptId = uuidv7();
  db.audit
    .prepare(
      `INSERT INTO agent_command_invocation
         (invocation_id, command_id, caller_id, grant_id, input_json, status, requested_at, executed_at, receipt_id)
       VALUES (?, 'cmd-1', 'agent-1', NULL, '{}', 'executed', ?, ?, NULL)`
    )
    .run(invocationId, args.requestedAt, args.receiptAt);
  db.audit
    .prepare(
      `INSERT INTO access_receipt
         (receipt_id, grant_id, invocation_id, action, object_type, object_id, purpose_concept_id, decision, occurred_at, hash, detail_json)
       VALUES (?, NULL, ?, 'act knowledge.create_note', 'knowledge.note', NULL, NULL, 'allow', ?, ?, NULL)`
    )
    .run(receiptId, invocationId, args.receiptAt, sha256Hex(receiptId));
  db.audit
    .prepare(
      "UPDATE agent_command_invocation SET receipt_id = ? WHERE invocation_id = ?"
    )
    .run(receiptId, invocationId);
  const checkId = uuidv7();
  db.audit
    .prepare(
      `INSERT INTO agent_invocation_check (check_id, invocation_id, phase, predicate, passed, observed_json, checked_at)
       VALUES (?, ?, 'pre', 'p', 1, NULL, ?)`
    )
    .run(checkId, invocationId, args.requestedAt);
  const evidenceId = uuidv7();
  db.audit
    .prepare(
      `INSERT INTO agent_evidence (evidence_id, invocation_id, claim, entity_type, entity_id, prov_id, weight)
       VALUES (?, ?, 'claim', 'knowledge.note', 'note-1', NULL, NULL)`
    )
    .run(evidenceId, invocationId);
  const explanationId = uuidv7();
  db.audit
    .prepare(
      `INSERT INTO agent_explanation (explanation_id, invocation_id, audience, summary, generated_at)
       VALUES (?, ?, 'owner', 'summary', ?)`
    )
    .run(explanationId, invocationId, args.requestedAt);
  return { invocationId, receiptId, checkId, evidenceId, explanationId };
}

describe("journal-archive", () => {
  test("archives old provenance rows into a CAS segment and drops them from vault.db", () => {
    const db = openVaultDb({});
    const oldId = seedProvenance(db, {
      entityId: "note-1",
      occurredAt: daysAgoIso(120),
    });
    const freshId = seedProvenance(db, {
      entityId: "note-2",
      occurredAt: daysAgoIso(1),
    });

    const result = runJournalArchival(db, { windowDays: 90 });

    expect(result.rowsArchived).toBe(1);
    expect(result.manifests).toHaveLength(1);
    const manifest = result.manifests[0]!;
    expect(manifest.stream).toBe("provenance");
    expect(manifest.rowCount).toBe(1);

    const remaining = db.audit
      .prepare("SELECT prov_id FROM access_provenance")
      .all() as {
      prov_id: string;
    }[];
    expect(remaining.map((r) => r.prov_id)).toStrictEqual([freshId]);

    const segment = readArchivedSegment(db, manifest);
    expect(segment.stream).toBe("provenance");
    expect(segment.rows.access_provenance).toHaveLength(1);
    expect(
      (segment.rows.access_provenance![0] as { prov_id: string }).prov_id
    ).toBe(oldId);

    const verification = verifyArchivedSegment(db, manifest);
    expect(verification.ok).toBe(true);
    expect(verification).toMatchObject({
      segmentPresent: true,
      segmentHashOk: true,
      chainHashOk: true,
      rowCountOk: true,
    });
  });

  test("a provenance row is kept when a live row still chains back to it", () => {
    const db = openVaultDb({});
    const oldId = seedProvenance(db, {
      entityId: "note-1",
      occurredAt: daysAgoIso(120),
    });
    seedProvenance(db, {
      entityId: "note-1",
      occurredAt: daysAgoIso(1),
      prevProvId: oldId,
    });

    const result = runJournalArchival(db, { windowDays: 90 });

    expect(result.rowsArchived).toBe(0);
    expect(result.manifests).toHaveLength(0);
    const remaining = db.audit
      .prepare("SELECT prov_id FROM access_provenance")
      .all();
    expect(remaining).toHaveLength(2);
  });

  test("archives a full invocation cluster (invocation, receipt, check, evidence, explanation) as one unit", () => {
    const db = openVaultDb({});
    const old = seedInvocationCluster(db, {
      requestedAt: daysAgoIso(120),
      receiptAt: daysAgoIso(120),
    });
    const fresh = seedInvocationCluster(db, {
      requestedAt: daysAgoIso(1),
      receiptAt: daysAgoIso(1),
    });

    const result = runJournalArchival(db, { windowDays: 90 });

    expect(result.manifests).toHaveLength(1);
    const manifest = result.manifests[0]!;
    expect(manifest.stream).toBe("invocation_cluster");
    expect(manifest.rowCount).toBe(5); // invocation + receipt + check + evidence + explanation
    expect(result.rowsArchived).toBe(5);

    for (const table of [
      "agent_command_invocation",
      "access_receipt",
      "agent_invocation_check",
      "agent_evidence",
      "agent_explanation",
    ]) {
      const rows = db.audit.prepare(`SELECT * FROM ${table}`).all();
      expect(rows).toHaveLength(1); // only the fresh cluster survives
    }
    const survivingInvocation = db.audit
      .prepare("SELECT invocation_id FROM agent_command_invocation")
      .get() as { invocation_id: string };
    expect(survivingInvocation.invocation_id).toBe(fresh.invocationId);

    const segment = readArchivedSegment(db, manifest);
    expect(segment.rows.agent_command_invocation).toHaveLength(1);
    expect(
      (segment.rows.agent_command_invocation![0] as { invocation_id: string })
        .invocation_id
    ).toBe(old.invocationId);
    expect(verifyArchivedSegment(db, manifest).ok).toBe(true);
  });

  test("an invocation cluster stays live when its receipt is younger than the window", () => {
    const db = openVaultDb({});
    seedInvocationCluster(db, {
      requestedAt: daysAgoIso(120),
      receiptAt: daysAgoIso(1),
    });

    const result = runJournalArchival(db, { windowDays: 90 });

    expect(result.rowsArchived).toBe(0);
    const invocations = db.audit
      .prepare("SELECT * FROM agent_command_invocation")
      .all();
    expect(invocations).toHaveLength(1);
  });

  test("a fresh vault archives nothing (window- and call-gated)", () => {
    const db = openVaultDb({});
    seedProvenance(db, { entityId: "note-1", occurredAt: daysAgoIso(1) });
    seedInvocationCluster(db, {
      requestedAt: daysAgoIso(1),
      receiptAt: daysAgoIso(1),
    });

    const result = runJournalArchival(db, { windowDays: 90 });

    expect(result.manifests).toHaveLength(0);
    expect(result.rowsArchived).toBe(0);
  });

  test("the manifest chain links across archival runs — each chain_hash folds the last", () => {
    const db = openVaultDb({});
    seedProvenance(db, { entityId: "note-1", occurredAt: daysAgoIso(120) });

    const first = runJournalArchival(db, {
      windowDays: 90,
      now: daysAgoIso(0),
    });
    expect(first.manifests).toHaveLength(1);

    seedProvenance(db, { entityId: "note-2", occurredAt: daysAgoIso(150) });
    const second = runJournalArchival(db, { windowDays: 90, now: nowIso() });
    expect(second.manifests).toHaveLength(1);
    expect(second.manifests[0]!.prevManifestId).toBe(
      first.manifests[0]!.manifestId
    );

    const all = listArchiveManifests(db.audit, "provenance");
    expect(all.map((m) => m.manifestId)).toStrictEqual([
      first.manifests[0]!.manifestId,
      second.manifests[0]!.manifestId,
    ]);
    expect(verifyArchivedSegment(db, all[1]!).ok).toBe(true);
  });

  test("verifyArchivedSegment catches a tampered manifest row (chain_hash mismatch)", () => {
    const db = openVaultDb({});
    seedProvenance(db, { entityId: "note-1", occurredAt: daysAgoIso(120) });
    const result = runJournalArchival(db, { windowDays: 90 });
    const manifest = result.manifests[0]!;

    db.audit
      .prepare(
        "UPDATE audit_archive_manifest SET row_count = row_count + 1 WHERE manifest_id = ?"
      )
      .run(manifest.manifestId);
    const tampered = findArchiveManifest(db.audit, manifest.manifestId)!;

    const verification = verifyArchivedSegment(db, tampered);
    expect(verification.ok).toBe(false);
    expect(verification.chainHashOk).toBe(false);
  });

  test("rejects a non-positive window", () => {
    const db = openVaultDb({});
    expect(() => runJournalArchival(db, { windowDays: 0 })).toThrow(
      /positive/u
    );
  });

  test("a run seals at most maxRowsPerRun and says there is more", () => {
    const db = openVaultDb({});
    for (let i = 0; i < 7; i += 1)
      seedProvenance(db, {
        entityId: `note-${i}`,
        occurredAt: daysAgoIso(120 + i),
      });

    const first = runJournalArchival(db, {
      windowDays: 90,
      maxRowsPerRun: 3,
    });
    expect(first.rowsArchived).toBe(3);
    expect(first.capped).toBe(true);
    expect(
      (
        db.audit
          .prepare("SELECT count(*) AS n FROM access_provenance")
          .get() as { n: number }
      ).n
    ).toBe(4);

    runJournalArchival(db, { windowDays: 90, maxRowsPerRun: 3 });
    const third = runJournalArchival(db, { windowDays: 90, maxRowsPerRun: 3 });
    expect(third.rowsArchived).toBe(1);
    expect(third.capped).toBe(false);
    expect(
      (
        db.audit
          .prepare("SELECT count(*) AS n FROM access_provenance")
          .get() as { n: number }
      ).n
    ).toBe(0);
    for (const manifest of listArchiveManifests(db.audit, "provenance"))
      expect(verifyArchivedSegment(db, manifest).ok).toBe(true);
  });

  test("an invocation sharing a receipt with a young one stays put", () => {
    const db = openVaultDb({});
    const old = seedInvocationCluster(db, {
      requestedAt: daysAgoIso(200),
      receiptAt: daysAgoIso(200),
    });
    const young = seedInvocationCluster(db, {
      requestedAt: daysAgoIso(200),
      receiptAt: daysAgoIso(1),
    });
    db.audit
      .prepare(
        "UPDATE agent_command_invocation SET receipt_id = ? WHERE invocation_id = ?"
      )
      .run(young.receiptId, old.invocationId);

    const result = runJournalArchival(db, { windowDays: 90 });

    expect(result.rowsArchived).toBe(0);
    expect(
      (
        db.audit
          .prepare("SELECT count(*) AS n FROM agent_command_invocation")
          .get() as { n: number }
      ).n
    ).toBe(2);
  });

  test("C1: audit rows past the window leave the LIVE file, and stay readable from CAS", () => {
    const db = openVaultDb({});
    for (let i = 0; i < 5; i += 1)
      seedProvenance(db, {
        entityId: `note-${i}`,
        occurredAt: daysAgoIso(400 + i),
      });
    seedProvenance(db, { entityId: "recent", occurredAt: daysAgoIso(1) });
    const before = (
      db.audit.prepare("SELECT count(*) AS n FROM access_provenance").get() as {
        n: number;
      }
    ).n;
    expect(before).toBe(6);

    const result = runJournalArchival(db);
    expect(result.rowsArchived).toBe(5);

    const live = db.audit
      .prepare("SELECT entity_id FROM access_provenance")
      .all() as { entity_id: string }[];
    expect(live.map((row) => row.entity_id)).toStrictEqual(["recent"]);

    const manifest = result.manifests.find((m) => m.stream === "provenance");
    expect(manifest).toBeDefined();
    const segment = readArchivedSegment(db, manifest!);
    expect(segment.rows.access_provenance).toHaveLength(5);
  });

  test("C1: the archive pass's door is shut again — an ordinary delete is still refused", () => {
    const db = openVaultDb({});
    seedProvenance(db, { entityId: "old", occurredAt: daysAgoIso(400) });
    seedProvenance(db, { entityId: "recent", occurredAt: daysAgoIso(1) });
    runJournalArchival(db);
    expect(
      (
        db.audit
          .prepare("SELECT count(*) AS n FROM audit_archive_pass")
          .get() as { n: number }
      ).n
    ).toBe(0);
    expect(() =>
      db.audit.prepare("DELETE FROM access_provenance").run()
    ).toThrow(/append-only/u);
  });

  test("C1: the ledger band prunes behind its custody latch, and holds what is not durable", () => {
    const db = openVaultDb({});
    const conversationId = uuidv7();
    const at = Date.parse(daysAgoIso(200));
    db.audit
      .prepare(
        `INSERT INTO conversations (id, kind, user_id, created_at, updated_at)
         VALUES (?, 'chat', 'owner', ?, ?)`
      )
      .run(conversationId, at, at);
    const insertTurn = db.audit.prepare(
      `INSERT INTO turns (id, conversation_id, seq, trigger, started_at)
       VALUES (?, ?, ?, 'manual', ?)`
    );
    for (let seq = 1; seq <= 4; seq += 1)
      insertTurn.run(uuidv7(), conversationId, seq, at);

    const archiveRow = (args: {
      seqFrom: number;
      seqTo: number;
      sha: string;
    }): void => {
      db.audit
        .prepare(
          `INSERT INTO conversation_archive
             (id, conversation_id, seq_from, seq_to, from_time, to_time, turn_count,
              item_count, segment_sha256, segment_bytes, plaintext_bytes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 1, 1, ?)`
        )
        .run(
          uuidv7(),
          conversationId,
          args.seqFrom,
          args.seqTo,
          at,
          at,
          args.seqTo - args.seqFrom + 1,
          args.sha,
          at
        );
    };
    const durable = db.blobs.ingestSync(Buffer.from("segment-bytes"));
    archiveRow({ seqFrom: 1, seqTo: 2, sha: durable.sha256 });
    archiveRow({ seqFrom: 3, seqTo: 4, sha: sha256Hex("not-here") });

    const result = runJournalArchival(db);
    expect(result.ledger.segmentsPruned).toBe(1);
    expect(result.ledger.turnsPruned).toBe(2);
    expect(result.ledger.heldForCustody).toBe(1);
    const seqs = (
      db.audit.prepare("SELECT seq FROM turns ORDER BY seq").all() as {
        seq: number;
      }[]
    ).map((row) => row.seq);
    expect(seqs).toStrictEqual([3, 4]);
  });

  test("rejects a non-positive run cap", () => {
    const db = openVaultDb({});
    expect(() =>
      runJournalArchival(db, { windowDays: 90, maxRowsPerRun: 0 })
    ).toThrow(/positive/u);
  });
});
