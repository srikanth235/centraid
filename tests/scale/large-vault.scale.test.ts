import { statSync } from "node:fs";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";
import {
  YEAR3_CONTACT_NEEDLE,
  YEAR3_DISTRIBUTIONS,
  YEAR3_NOTE_NEEDLE,
} from "@centraid/test-kit/year3-vault";
import {
  AUDIT_BAND_TABLES,
  createGateway,
  DEFAULT_PURPOSE,
  enrollDevice,
  openVaultDb,
} from "@centraid/vault";
import type { VaultDb } from "@centraid/vault";

import { goldenYear3Vault } from "../helpers/factories.js";
import { journeyCeiling } from "../helpers/journeys.js";

/**
 * DAILY-USE QUERIES AT YEAR-3 VOLUME, on the GOLDEN artifact (#927 P4).
 *
 * This rig used to seed its own corpus: 10,000 photos and 5,000 contacts
 * through the shared generator, then a thousand notes and three calendar years
 * of events written inline, with its two search needles patched in by UPDATE
 * *after* the fixture was copied. Every one of those is a declared dimension
 * of the golden year-3 vault now, which every journey rig mounts by name — so
 * a before/after number from this rig and one from a web or desktop journey
 * are numbers about the same bytes. The needles are the fixture's own
 * (`YEAR3_CONTACT_NEEDLE` / `YEAR3_NOTE_NEEDLE`), so the rig no longer writes
 * to the artifact it measures.
 *
 * The assertions are unchanged: 200 recent photos, one contact hit, 365 events
 * in the 2025 window, one note hit, and both budgets. What `seedMs` MEANS has
 * changed — it is now the cost of materializing or reusing the golden fixture
 * rather than of writing rows inline — so it is reported under its own name.
 */
const OWNER = "tests/scale/large-vault.scale.test.ts";
const SEED_BUDGET_MS = 30_000;
const READ_BUDGET_MS = 2_000;
/**
 * Gateway reads behind the audit-band gauges below. Large enough that the
 * per-read cost is measured over whole SQLite pages rather than over the one
 * page a handful of receipts happen to share, small enough that the loop is a
 * second of the rig's budget.
 */
const READ_COST_KEY = "gateway/read-cost/year3/ci-linux-x64-4c";
const AUDIT_GAUGE_READS = 500;
/** Rows each gauge read returns — the shape of a surface page, not a sweep. */
const AUDIT_GAUGE_LIMIT = 20;

/**
 * On-disk bytes the audit band occupies, its indexes included.
 *
 * `dbstat` is queried one btree at a time because its `name` constraint is the
 * only one it can push down: a join against `sqlite_schema` would walk every
 * page of a 101 MiB file per call. The names come from the band's own
 * `AUDIT_BAND_TABLES`, so a table added to the band is weighed without this
 * rig being edited.
 */
function auditBandBytes(db: VaultDb): number {
  const btrees = db.vault.prepare(
    "SELECT name FROM sqlite_schema WHERE tbl_name = ?"
  );
  const pages = db.vault.prepare(
    "SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat WHERE name = ?"
  );
  let total = 0;
  for (const table of AUDIT_BAND_TABLES) {
    for (const btree of btrees.all(table) as { name: string }[]) {
      total += Number((pages.get(btree.name) as { bytes: number }).bytes);
    }
  }
  return total;
}

describe("large-vault.scale", () => {
  test("10k photos, 5k contacts, three years of events, and 1k notes stay bounded", async () => {
    const started = performance.now();
    const golden = await goldenYear3Vault();
    const db = openVaultDb({ dir: golden.dir, sealKey: golden.sealKey });
    onTestFinished(() => db.close());
    const seedMs = performance.now() - started;

    const readStarted = performance.now();
    const recentPhotos = db.vault
      .prepare(
        `SELECT asset_id FROM media_asset
          WHERE deleted_at IS NULL ORDER BY captured_at DESC LIMIT 200`
      )
      .all();
    const contactHit = db.vault
      .prepare(
        `SELECT party_id FROM fts_core_party WHERE fts_core_party MATCH ?`
      )
      .all(YEAR3_CONTACT_NEEDLE);
    const events = db.vault
      .prepare(
        `SELECT event_id FROM core_event
          WHERE dtstart >= '2025-01-01' AND dtstart < '2026-01-01'
          ORDER BY dtstart`
      )
      .all();
    const noteHit = db.vault
      .prepare(
        `SELECT note_id FROM fts_knowledge_note
          WHERE fts_knowledge_note MATCH ?`
      )
      .all(YEAR3_NOTE_NEEDLE);
    const readMs = performance.now() - readStarted;

    // ── #922 F5 / B6 gauges: what a READ costs the audit band ───────────────
    // A gateway read is a WRITER (`gateway/read-batch.test.ts`): it appends an
    // access.receipt, so an owner who only ever looks still grows the file and
    // the WAL — and the WAL never shrinks on its own, because
    // `wal_autocheckpoint = 0` makes the shipper the sole checkpointer
    // (docs/traps/wal-checkpoint.md). These are GAUGES and carry no budget:
    // #927 wave 2's `surface x journey x volume x hardware` ledger decides
    // what to gate and where. The reads run through the real gateway on a real
    // enrolled owner device, so the bytes are the product's, not a model's.
    const ownerPartyId = (
      db.vault
        .prepare("SELECT owner_party_id FROM access_device LIMIT 1")
        .get() as { owner_party_id: string }
    ).owner_party_id;
    const device = enrollDevice(db, ownerPartyId, "Audit gauge device");
    const gateway = createGateway(db);
    const walFile = path.join(golden.dir, "vault.db-wal");
    const auditBefore = auditBandBytes(db);
    const walBefore = statSync(walFile).size;
    const gaugeStarted = performance.now();
    for (let index = 0; index < AUDIT_GAUGE_READS; index += 1) {
      gateway.read(
        {
          kind: "device",
          deviceId: device.deviceId,
          deviceKey: device.deviceKey,
        },
        {
          entity: "media.asset",
          purpose: DEFAULT_PURPOSE,
          limit: AUDIT_GAUGE_LIMIT,
          acceptTruncation: true,
        }
      );
    }
    const gaugeMs = performance.now() - gaugeStarted;
    const auditBytesPerRead =
      (auditBandBytes(db) - auditBefore) / AUDIT_GAUGE_READS;
    const walBytesPerRead =
      (statSync(walFile).size - walBefore) / AUDIT_GAUGE_READS;
    // The projection states BOTH its inputs: a per-hour number is only as
    // honest as the rate it assumes, so the achieved rate is published beside
    // it rather than folded into it.
    const readsPerSecond = AUDIT_GAUGE_READS / (gaugeMs / 1_000);
    const walBytesPerHour = walBytesPerRead * readsPerSecond * 3_600;

    const passed =
      recentPhotos.length === 200 &&
      contactHit.length === 1 &&
      events.length === 365 &&
      noteHit.length === 1 &&
      seedMs < SEED_BUDGET_MS &&
      readMs < READ_BUDGET_MS;
    await recordQualityResult({
      lane: "scale",
      owner: OWNER,
      name: "Daily-use queries on the golden year-3 vault",
      status: passed ? "passed" : "failed",
      measurements: [
        {
          name: "golden fixture mount",
          value: seedMs,
          unit: "ms",
          budget: SEED_BUDGET_MS,
        },
        {
          name: "combined reads",
          value: readMs,
          unit: "ms",
          budget: READ_BUDGET_MS,
        },
        {
          name: "photos",
          value: YEAR3_DISTRIBUTIONS.dailyPathPhotos,
          unit: "rows",
        },
        { name: "contacts", value: golden.profile.parties, unit: "rows" },
        {
          name: "event days",
          value: YEAR3_DISTRIBUTIONS.eventDays,
          unit: "rows",
        },
        { name: "notes", value: YEAR3_DISTRIBUTIONS.notes, unit: "rows" },
        {
          name: "receipt days",
          value: YEAR3_DISTRIBUTIONS.receiptDays,
          unit: "rows",
        },
        { name: "golden vault on disk", value: golden.bytes, unit: "bytes" },
        {
          name: "golden fixture cache hit",
          value: golden.cacheHit ? 1 : 0,
          unit: "count",
        },
        // MOUNT alone, separated from the build the first run pays: this is
        // what every journey rig that opens the golden vault will pay, once
        // per rig, forever.
        { name: "golden vault mount", value: golden.mountMs, unit: "ms" },
        {
          name: "audit-band bytes per gateway read",
          value: auditBytesPerRead,
          unit: "bytes",
        },
        {
          name: "WAL bytes per gateway read",
          value: walBytesPerRead,
          unit: "bytes",
        },
        {
          name: "gateway reads sustained",
          value: readsPerSecond,
          unit: "reads/s",
        },
        {
          name: "WAL growth per hour under a reading client",
          value: walBytesPerHour,
          unit: "bytes/h",
        },
      ],
    });
    expect(recentPhotos).toHaveLength(200);
    expect(contactHit).toHaveLength(1);
    expect(events).toHaveLength(365);
    expect(noteHit).toHaveLength(1);
    expect(seedMs).toBeLessThan(SEED_BUDGET_MS);
    expect(readMs).toBeLessThan(READ_BUDGET_MS);
    // These two were GAUGES — measured, published, ungated — until #927 gave
    // them ceilings in tests/journeys.json. A byte-per-read that nothing budgets
    // is exactly the cost that grows unnoticed: a client that only ever looks
    // pays it forever. A gauge that measured NOTHING is still a broken
    // instrument reporting a good number, so the floors stay too.
    expect(auditBytesPerRead).toBeGreaterThan(0);
    expect(walBytesPerRead).toBeGreaterThan(0);
    expect(auditBytesPerRead).toBeLessThanOrEqual(
      journeyCeiling(READ_COST_KEY, "auditBandPerRead", "maxBytes")
    );
    expect(walBytesPerRead).toBeLessThanOrEqual(
      journeyCeiling(READ_COST_KEY, "walBytesPerRead", "maxBytes")
    );
  });
});
