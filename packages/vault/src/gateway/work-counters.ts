/*
 * The always-on half of #927's instrumentation: deterministic integers for the
 * work one gateway action costs, counted where the work actually happens — the
 * SQLite statement layer.
 *
 * Spans are sampled and off by default (they cost time); these are not. The
 * merge rung compares counters and nothing else, which is why it has zero
 * flake, needs no retry and needs no history: a seeded extra statement or an
 * extra durability barrier on a hot path changes an integer on the first run.
 *
 * MONOTONIC BY CONSTRUCTION. There is exactly one totals object for the life of
 * the process and it is never replaced or rewound, so any two snapshots differ
 * in one direction only and `diffCounters` (which throws on a backwards
 * counter) can never trip on a pair taken here. A per-request or per-worker
 * "reset" is a new snapshot, never a rewind.
 */

import type { DatabaseSync, StatementSync } from "node:sqlite";

import { zeroCounters } from "@centraid/core/protocol";
import type { WorkCounterKey, WorkCounters } from "@centraid/core/protocol";

/** The one process total. Never replaced; see the header. */
const totals = zeroCounters();

export function bumpWorkCounter(key: WorkCounterKey, amount = 1): void {
  if (amount <= 0) return;
  totals[key] += amount;
}

/** A snapshot; the caller owns the copy and may keep it for a later diff. */
export function gatewayWorkCounters(): WorkCounters {
  return { ...totals };
}

/**
 * Bytes of one materialized cell. UTF-16 units for text (deterministic and
 * O(1) — `Buffer.byteLength` would walk the string a second time), byte length
 * for blobs, the SQLite storage width for the fixed-width types. It is a
 * measure of payload moved, not of disk I/O: what a regression like "this read
 * now selects the whole row" moves, which is the thing the gate must catch.
 */
function cellBytes(value: unknown): number {
  if (value === null || value === undefined) return 0;
  switch (typeof value) {
    case "string":
      return value.length;
    case "number":
    case "bigint":
      return 8;
    case "boolean":
      return 1;
    default:
      return value instanceof Uint8Array ? value.byteLength : 0;
  }
}

function rowBytes(row: unknown): number {
  if (row === null || typeof row !== "object") return cellBytes(row);
  let bytes = 0;
  // `Object.keys` rather than `Object.values`: node:sqlite hands back a plain
  // object per row, and keys avoids materializing a second array of the values
  // that are already reachable. This runs once per row on every read.
  const cells = row as Record<string, unknown>;
  for (const key of Object.keys(cells)) bytes += cellBytes(cells[key]);
  return bytes;
}

function paramBytes(params: readonly unknown[]): number {
  let bytes = 0;
  for (const param of params) bytes += rowBytes(param);
  return bytes;
}

/**
 * A durability barrier: the statements that make SQLite call fsync/fdatasync.
 * In WAL mode a COMMIT syncs the log and a checkpoint syncs the database file;
 * both are the expensive thing `fsyncs` exists to fence. Counting the barrier
 * rather than the syscall keeps the counter a property of the product's own
 * behaviour — no strace, no platform split, same integer on every host.
 *
 * `exec` may carry several statements (the schema ladder does); it counts as
 * one execution, because what it measures is calls into SQLite, and a migration
 * is not on any hot path the gate fences.
 */
const DURABILITY_BARRIER =
  /^\s*(?:COMMIT|END(?:\s+TRANSACTION)?\b|PRAGMA\s+\w*\s*\.?\s*wal_checkpoint)/iu;

function countExecuted(sql: string): void {
  totals.statements += 1;
  // Cheap screen first, then the regex. Only COMMIT, END and PRAGMA can open a
  // barrier, so one character rules out every SELECT, INSERT and SAVEPOINT
  // before a regex engine is entered — and those are the statements on the hot
  // path this counter must not slow down.
  let index = 0;
  while (index < sql.length && sql.charCodeAt(index) <= 32) index += 1;
  const first = sql.charCodeAt(index) | 32;
  if (
    (first === 99 || first === 101 || first === 112) &&
    DURABILITY_BARRIER.test(sql)
  ) {
    totals.fsyncs += 1;
  }
}

/**
 * The statement-layer forwarder. A CLASS, not an object of closures: node's
 * `StatementSync` methods are native and need their own receiver, so every
 * member forwards explicitly — and putting them on a prototype makes a counted
 * prepare one small allocation instead of one closure per method, which is the
 * difference between a few percent and tens of percent on a read-heavy path.
 */
class CountedStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly sql: string
  ) {}

  get(...params: Parameters<StatementSync["get"]>): unknown {
    countExecuted(this.sql);
    const row = this.statement.get(...params);
    if (row !== undefined) {
      totals.rowsScanned += 1;
      totals.bytesRead += rowBytes(row);
    }
    return row;
  }

  all(...params: Parameters<StatementSync["all"]>): unknown[] {
    countExecuted(this.sql);
    const rows = this.statement.all(...params);
    totals.rowsScanned += rows.length;
    for (const row of rows) totals.bytesRead += rowBytes(row);
    return rows;
  }

  run(...params: Parameters<StatementSync["run"]>): unknown {
    countExecuted(this.sql);
    totals.bytesWritten += paramBytes(params);
    return this.statement.run(...params);
  }

  iterate(...params: Parameters<StatementSync["iterate"]>): unknown {
    countExecuted(this.sql);
    return this.statement.iterate(...params);
  }

  columns(): unknown {
    return this.statement.columns();
  }

  setAllowBareNamedParameters(enabled: boolean): void {
    this.statement.setAllowBareNamedParameters(enabled);
  }

  setReadBigInts(enabled: boolean): void {
    this.statement.setReadBigInts(enabled);
  }

  get sourceSQL(): string {
    return this.statement.sourceSQL;
  }

  get expandedSQL(): string {
    return this.statement.expandedSQL;
  }
}

const instrumented = new WeakSet<DatabaseSync>();

/**
 * Count every statement this handle runs from here on. Idempotent per handle:
 * the gateway, the replica protocol and the schema ladder all share ONE
 * connection (#916), and double-wrapping it would double every integer.
 */
export function instrumentVaultStatements(db: DatabaseSync): void {
  if (instrumented.has(db)) return;
  instrumented.add(db);
  const prepare = db.prepare.bind(db);
  const exec = db.exec.bind(db);
  db.prepare = (sql: string) =>
    new CountedStatement(prepare(sql), sql) as unknown as StatementSync;
  db.exec = (sql: string) => {
    countExecuted(sql);
    return exec(sql);
  };
}
