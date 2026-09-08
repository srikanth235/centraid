// SAME SQL, TWO FILES (#996, wave 2; the convergence invariant).
//
// The claim a seat makes is not "it has most of the data" — it is that a
// query answers the SAME on the phone as on the gateway. So this test does not
// inspect the applier's bookkeeping: it takes the gateway's file, produces the
// seat's file through the REAL bootstrap (a gzipped snapshot, staged and
// installed by the same code a phone runs) and the REAL applier, and then runs
// the same SQL against both.
//
// WHY IT LIVES IN `tests/quality` AND NOT IN A PACKAGE. It is the one test
// that needs BOTH sides: `@centraid/vault` builds and captures, `@centraid/
// client` bootstraps and applies, and neither package depends on the other —
// deliberately, because the whole point of the log is that the two halves
// share a wire and nothing else.
//
// TWO CORPORA, FOR TWO DIFFERENT REASONS. The 0e ontology fixture is thirteen
// scenarios written through the real command pipeline: it is where a decoder
// bug shows up as a wrong VALUE. The year-3 vault is the declared phone
// volume: it is where a bootstrap shows up as a wrong SIZE or a missing table.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";

import { afterAll, describe, expect, test } from "vitest";

import { encodeWireValue } from "@centraid/core/protocol";
import type { SeatLogPageWire } from "@centraid/core/protocol";
import { staticSeatSnapshotTransport } from "@centraid/test-kit/seat-snapshot-transport";
import { tempDirSync } from "@centraid/test-kit/temp-dir";
import { YEAR3_CONTACT_NEEDLE } from "@centraid/test-kit/year3-vault";
import {
  beginReplicaCommit,
  buildSeatSnapshot,
  endReplicaCommit,
  openVaultDb,
  readReplicaLog,
  replicaLogState,
  seatLogRowWire,
} from "@centraid/vault";
import { buildOntologyScenarios } from "@centraid/vault/tests/ontology-scenarios";

import { REPLICA_LOCAL_SEARCH } from "../../packages/client/src/replica/search.js";
import {
  applySeatLogPage,
  bootstrapSeatFile,
  seatSearchStatement,
} from "../../packages/client/src/replica/seat/index.js";
import { NodeSeatDriver } from "../../packages/client/src/replica/seat/node-seat-driver.js";
import { nodeSeatStaging } from "../../packages/client/src/replica/seat/node-staging.js";
import { goldenYear3Vault } from "../helpers/factories.js";

const open: { close: () => void }[] = [];

function workspace(label: string): string {
  return tempDirSync(`seat-parity-${label}-`);
}

/**
 * Tables whose rows must agree, from the SEAT's own schema.
 *
 * Read from the seat rather than from a list: the seat's tables ARE the
 * gateway's minus the private ones, so asking the file is asking the thing the
 * invariant is about. What comes out is the log itself (a seat holds none of
 * it), `replica_meta` (its `floor_seq` is the seat's position by design), the
 * seat's own bookkeeping, SQLite's internals, and the FTS shadow tables —
 * whose parity is a QUERY question, asserted separately below.
 */
function comparableTables(seat: NodeSeatDriver): string[] {
  return seat
    .all<{ name: string }>(
      `SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name`
    )
    .map((row) => row.name)
    .filter(
      (name) =>
        !name.startsWith("sqlite_") &&
        !name.startsWith("fts_") &&
        name !== "replica_log" &&
        name !== "replica_change" &&
        name !== "replica_meta" &&
        name !== "seat_state"
    );
}

/** Every row of a table, in a form two different SQLite builds can be compared by. */
function rowsOf(read: (sql: string) => object[], table: string): string[] {
  const quoted = `"${table.replaceAll('"', '""')}"`;
  return read(`SELECT * FROM ${quoted}`)
    .map((row) =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries(row)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([column, value]) => [column, encodeWireValue(value)])
        )
      )
    )
    .sort();
}

/**
 * The gateway's file, through the whole seat pipeline: sanitised snapshot,
 * gzipped as the door serves it, staged, resumed, installed, opened.
 */
async function seatOf(
  vault: DatabaseSync,
  vaultId: string,
  label: string
): Promise<{ driver: NodeSeatDriver; seq: number; bytes: number; ms: number }> {
  const root = workspace(label);
  const snapshot = buildSeatSnapshot(vault, path.join(root, "snapshot.db"));
  const compressed = gzipSync(readFileSync(snapshot.path), { level: 6 });
  writeFileSync(path.join(root, "artifact.db.gz"), compressed);
  const drivers: NodeSeatDriver[] = [];
  const started = performance.now();
  const result = await bootstrapSeatFile({
    // Chunked, so the parity run also exercises the append path rather than a
    // single write that happens to work.
    transport: staticSeatSnapshotTransport(compressed, snapshot, {
      chunkBytes: 1 << 16,
    }),
    staging: nodeSeatStaging({
      directory: path.join(root, "staging"),
      databasePath: path.join(root, "seat.db"),
    }),
    vaultId,
    open: () => {
      const driver = new NodeSeatDriver(path.join(root, "seat.db"));
      drivers.push(driver);
      open.push(driver);
      return driver;
    },
  });
  return {
    driver: drivers.at(-1)!,
    seq: result.seq,
    bytes: compressed.byteLength,
    ms: performance.now() - started,
  };
}

/**
 * THE FTS SHADOW TABLES' PARITY, WHICH IS A QUERY QUESTION (#996, W5-D1).
 *
 * `comparableTables` skips `fts_*` on purpose: an FTS5 shadow is four internal
 * tables of b-tree segments, and two SQLite builds may lay the same terms out
 * differently without disagreeing about a single search. So the claim is made
 * where it means something — the statement a seat runs, run against BOTH files,
 * answering the same rows in the same order.
 *
 * That is also the whole of W5-D1's evidence: search stays on the seat because
 * the seat's answer IS the gateway's answer, measured rather than asserted.
 */
function assertSearchParity(
  gateway: DatabaseSync,
  seat: NodeSeatDriver,
  entity: string,
  term: string,
  label: string
): number {
  const statement = seatSearchStatement({ entity, query: term, limit: 100 });
  const theirs = gateway
    .prepare(statement.sql)
    .all(...statement.bind) as object[];
  const ours = seat.all(statement.sql, statement.bind);
  const shape = (rows: object[]): string[] =>
    rows.map((row) =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries(row)
            // `rank` is a bm25 float; two builds may differ in the last bits
            // without disagreeing about the ORDER, which the array already
            // pins. What must match exactly is the ROWS and their sequence.
            .filter(([column]) => column !== "rank")
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([column, value]) => [column, encodeWireValue(value)])
        )
      )
    );
  expect(shape(ours), `${label}: ${entity} for "${term}"`).toStrictEqual(
    shape(theirs)
  );
  return ours.length;
}

function assertParity(
  gateway: DatabaseSync,
  seat: NodeSeatDriver,
  label: string
): number {
  const tables = comparableTables(seat);
  expect(tables.length, `${label}: the seat holds tables`).toBeGreaterThan(20);
  let compared = 0;
  for (const table of tables) {
    const theirs = rowsOf(
      (sql) => gateway.prepare(sql).all() as object[],
      table
    );
    const ours = rowsOf((sql) => seat.all(sql), table);
    expect(ours, `${label}: ${table}`).toStrictEqual(theirs);
    compared += ours.length;
  }
  return compared;
}

describe("a seat converges with the gateway it copied", () => {
  afterAll(() => {
    for (const held of open.splice(0)) held.close();
  });

  test("the 0e ontology fixture: snapshot, then a tail of real commits", async () => {
    const fixture = buildOntologyScenarios();
    open.push({ close: () => fixture.db.vault.close() });
    const vault = fixture.db.vault;
    const vaultId = (
      vault.prepare(`SELECT vault_id FROM core_vault LIMIT 1`).get() as {
        vault_id: string;
      }
    ).vault_id;

    const seat = await seatOf(vault, vaultId, "0e");
    const afterBootstrap = assertParity(vault, seat.driver, "0e bootstrap");
    expect(afterBootstrap).toBeGreaterThan(0);

    // NOW MOVE THE GATEWAY. A snapshot that matches proves the copy; only a
    // tail applied on top proves the log. Three commits: an insert, an update
    // of a row the snapshot already carries, and a delete.
    const before = replicaLogState(vault).watermark.seq;
    const party = (
      vault
        .prepare(`SELECT party_id FROM core_party ORDER BY party_id LIMIT 1`)
        .get() as { party_id: string }
    ).party_id;
    for (const statement of [
      `INSERT INTO core_concept_scheme (scheme_id, uri, title, version)
         VALUES ('seat-parity', 'urn:seat-parity', 'Seat parity', '1')`,
      `UPDATE core_party SET display_name = 'Renamed by the gateway'
         WHERE party_id = '${party}'`,
      `DELETE FROM core_concept_scheme WHERE scheme_id = 'seat-parity'`,
    ]) {
      vault.exec("BEGIN IMMEDIATE");
      const handle = beginReplicaCommit(vault);
      vault.exec(statement);
      endReplicaCommit(vault, handle);
      vault.exec("COMMIT");
    }
    const state = replicaLogState(vault);
    expect(state.watermark.seq).toBeGreaterThan(before);

    const tail = readReplicaLog(vault, {
      since: { epoch: state.epoch, seq: seat.seq },
      limit: 10_000,
    });
    const page: SeatLogPageWire = {
      vaultId,
      epoch: state.epoch,
      schemaEpoch: state.schemaEpoch,
      ddlVersion: state.ddlVersion,
      floor: tail.floor.seq,
      watermark: tail.watermark.seq,
      next: tail.next.seq,
      hasMore: tail.hasMore,
      rows: tail.rows.map(seatLogRowWire),
    };
    expect(page.rows.length).toBeGreaterThan(0);
    const applied = applySeatLogPage(seat.driver, page);
    expect(applied.applied).toBe(page.rows.length);
    assertParity(vault, seat.driver, "0e after tail");

    // The renamed party, read on the seat with the SAME SQL the gateway runs.
    expect(
      seat.driver.all(
        `SELECT display_name FROM core_party WHERE party_id = '${party}'`
      )
    ).toStrictEqual([{ display_name: "Renamed by the gateway" }]);

    // And the same page again changes nothing — duplicate delivery over a
    // corpus, not over a hand-built row.
    const again = applySeatLogPage(seat.driver, page);
    expect(again.applied).toBe(0);
    expect(again.duplicate).toBe(page.rows.length);
    assertParity(vault, seat.driver, "0e after duplicate delivery");
  }, 120_000);

  test("the year-3 vault: the declared phone volume, table for table", async () => {
    const golden = await goldenYear3Vault();
    const db = openVaultDb({ dir: golden.dir, sealKey: golden.sealKey });
    open.push({ close: () => db.close() });
    const vaultId = (
      db.vault.prepare(`SELECT vault_id FROM core_vault LIMIT 1`).get() as {
        vault_id: string;
      }
    ).vault_id;
    const seat = await seatOf(db.vault, vaultId, "year3");
    const rows = assertParity(db.vault, seat.driver, "year-3");
    expect(rows).toBeGreaterThan(1_000);
    // The artifact is a real download, not a token one: an assertion that
    // passed on a few kilobytes would say nothing about the declared volume.
    expect(seat.bytes).toBeGreaterThan(1_000_000);

    // SEARCH, ON THE SEAT, AT THE DECLARED VOLUME (#996, W5-D1). The needle is
    // one planted row in five thousand parties, so a statement that quietly
    // matched everything or nothing cannot pass this.
    const found = assertSearchParity(
      db.vault,
      seat.driver,
      "core.party",
      YEAR3_CONTACT_NEEDLE,
      "year-3"
    );
    expect(found).toBeGreaterThan(0);
    // Every searchable entity answers the same on both files, needle or not:
    // an entity whose join key or shadow table were wrong would answer nothing
    // on the seat and something on the gateway.
    for (const entity of Object.keys(REPLICA_LOCAL_SEARCH))
      assertSearchParity(db.vault, seat.driver, entity, "the", "year-3");
  }, 600_000);
});
