// THE SEAT APPLIER (#996, ruling R5; wave 2).
//
// The whole seat-side write path is here: take a page of log rows off the log
// door and turn it into rows in `vault.db`. It is a small program on purpose —
// a seat runs NO DDL generator, NO derivation triggers and NO projector, and
// every one of those absences is what makes "the copy equals the gateway"
// checkable rather than hopeful.
//
// FOUR RULES, AND WHY EACH IS THE RULE:
//
//   1. ONE COMMIT, ONE TRANSACTION, CURSOR INCLUDED. The rows of a commit and
//      the cursor that says they landed are written together, so a crash
//      leaves the seat at a commit boundary the next attempt resumes from —
//      never at a cursor that has run ahead of its rows. This is why the log
//      door never pages mid-commit.
//   2. `INSERT … ON CONFLICT DO UPDATE`, never `INSERT OR REPLACE`. REPLACE
//      DELETES the conflicting row first, and fires delete triggers only under
//      `recursive_triggers` — on a seat, whose only surviving triggers are FTS
//      sync, that silently desynchronises the search index from the rows it
//      indexes. (`applyRowSql` in `@centraid/core/protocol` is the statement.)
//   3. IDEMPOTENT BY SEQ, NOT BY GUESSWORK. A row at or below `applied_seq`
//      is dropped before it is bound. Duplicate delivery — a retried page, a
//      reconnect that re-asks from a cursor the seat had already passed — is
//      therefore a no-op rather than "an upsert that happens to be
//      harmless": harmless is not true for a delete followed by a re-insert.
//   4. FOREIGN KEYS OFF. The gateway's integrity is the only integrity (#996
//      invariant). A seat applies commits in the gateway's order, and a log
//      page can legitimately carry a child before its parent's own commit
//      arrives; enforcing FKs here would reject rows the gateway accepted.
//
// AND ONE REFUSAL. A row whose `schema_epoch` is not the file's stands for a
// schema this file does not have. Applying it would be a SILENT no-op — an
// upsert into a column set that no longer matches — so the applier refuses the
// page and names re-bootstrap, which is the only honest answer. That is the
// drift gate, and it is checked per ROW rather than per page because the page
// header is what the gateway believes and the row is what it actually shipped.

import {
  applyRowSql,
  decodeWireValue,
  deleteRowSql,
} from "@centraid/core/protocol";
import type {
  SeatLogPageWire,
  SeatLogRowWire,
  WireValue,
} from "@centraid/core/protocol";

import type { SeatBindValue, SeatSqliteDriver } from "./driver.js";
import { SeatDriftError } from "./seat-drift-error.js";
import { readSeatState } from "./state.js";
import type { SeatState } from "./state.js";

/** What the shell is told after a batch lands. */
export interface SeatChangeNotice {
  /** Tables whose rows changed, de-duplicated, in first-touch order. */
  readonly tables: readonly string[];
  /** The seat's applied cursor after the batch. */
  readonly cursor: number;
  /** Commit positions that landed, ascending — an outcome clears against these. */
  readonly commitSeqs: readonly number[];
}

export interface SeatApplyResult extends SeatChangeNotice {
  readonly applied: number;
  /** Rows dropped as already-applied (duplicate delivery). */
  readonly duplicate: number;
  /** Rows skipped because their commit crossed the defer threshold. */
  readonly deferred: number;
  readonly ddl: number;
  /** First seq of the oldest owed deferred span, if any. */
  readonly deferredFrom: number | undefined;
  readonly gatewayWatermark: number;
}

export interface SeatApplyOptions {
  /**
   * A METERED SEAT SKIPS THE BIG SPANS (R7). The gateway marks a commit that
   * crossed {@link REPLICA_DEFER_THRESHOLD_BYTES}; a seat on cellular sets
   * this and the applier records the owed position instead of spending the
   * bytes. Default false — a seat on wifi takes everything.
   */
  readonly deferOverThreshold?: boolean;
  /** Called once per applied batch, after the last commit is durable. */
  readonly onChange?: (notice: SeatChangeNotice) => void;
  /**
   * CALLED INSIDE THE TRANSACTION THAT ADVANCES THE CURSOR (#996, R24).
   *
   * Where the outbox shares this file, an executed intent's overlay must clear
   * in the SAME transaction that carries its `commit_seq` — otherwise there is
   * a window in which the rows have landed and the pending row is still drawn
   * over them, and a crash inside that window leaves an overlay nothing will
   * ever clear. The hook runs after the commit's rows and before COMMIT, so
   * whatever it writes is atomic with them.
   *
   * It must not throw for anything recoverable: a throw here rolls the
   * COMMIT'S ROWS back, not just the bookkeeping.
   */
  readonly onCommitInTransaction?: (commitSeq: number) => void;
  /**
   * CALLED AFTER THE COMMIT IS DURABLE (#1014, C10).
   *
   * The twin of the hook above, and the reason both exist. What
   * `onCommitInTransaction` WRITES must be atomic with the rows; what it
   * ANNOUNCES must not be — a shell listener that throws inside the
   * transaction rolls an applied log page back, and a listener that is told
   * before COMMIT has been told a fact that is not yet durable. So the work
   * goes in and the news comes out here.
   */
  readonly afterCommit?: (commitSeq: number) => void;
  readonly now?: () => string;
}

/**
 * A table's primary key, in declared order, cached per driver.
 *
 * Read from the FILE, never from a registry the seat would have to keep in
 * step: the file is the gateway's schema, so its own `pragma_table_info` is
 * the authoritative answer and a schema change reaches the applier without an
 * edit here.
 */
export class SeatTableKeys {
  readonly #cache = new Map<string, readonly string[]>();

  constructor(private readonly driver: SeatSqliteDriver) {}

  of(table: string): readonly string[] {
    const hit = this.#cache.get(table);
    if (hit) return hit;
    const rows = this.driver.all<{ name: string; pk: number }>(
      `SELECT name, pk FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk`,
      [table]
    );
    const key = rows.map((row) => row.name);
    if (key.length === 0) {
      // The gateway refuses to CAPTURE such a table (`primaryKeyOf` throws),
      // so reaching here means the seat's file and the gateway's disagree
      // about the schema — which is drift, not a missing feature.
      throw new SeatDriftError(
        "schema-epoch",
        `seat apply: ${table} has no primary key in this file`
      );
    }
    this.#cache.set(table, key);
    return key;
  }

  forget(): void {
    this.#cache.clear();
  }
}

function bindable(value: WireValue): SeatBindValue {
  return decodeWireValue(value);
}

interface CommitGroup {
  readonly commitSeq: number;
  readonly rows: readonly SeatLogRowWire[];
  readonly deferred: boolean;
  readonly lastSeq: number;
}

/** Split a page into commits, in seq order. The door never pages mid-commit. */
function groupByCommit(rows: readonly SeatLogRowWire[]): CommitGroup[] {
  const groups: CommitGroup[] = [];
  let current: SeatLogRowWire[] = [];
  for (const row of rows) {
    const head = current[0];
    if (head && head.commitSeq !== row.commitSeq) {
      groups.push(closeGroup(current));
      current = [];
    }
    current.push(row);
  }
  if (current.length > 0) groups.push(closeGroup(current));
  return groups;
}

function closeGroup(rows: SeatLogRowWire[]): CommitGroup {
  return {
    commitSeq: rows[0]!.commitSeq,
    rows,
    // The flag is a property of the COMMIT; the gateway stamps every row of
    // it, so any row carrying it settles the question for all of them.
    //
    // EXCEPT WHEN IT CARRIES SCHEMA (#1014, C2). A `ddl` row is not bytes the
    // member can wait for — it is the shape every later row binds against.
    // Skipping a commit that contains one left the file one column short of
    // the rows that followed it, and the SQLite error that produced is not a
    // `SeatDriftError`, so `seat-loop.ts` rethrew it instead of re-bootstrapping
    // and the seat wedged. Schema is never deferred.
    deferred:
      rows.some((row) => row.deferred === true) &&
      !rows.some((row) => row.op === "ddl"),
    lastSeq: rows.at(-1)!.seq,
  };
}

function assertNoDrift(state: SeatState, page: SeatLogPageWire): void {
  if (page.vaultId !== state.vaultId) {
    throw new SeatDriftError(
      "vault",
      `seat apply: page is for vault ${page.vaultId}, this file is ${state.vaultId}`
    );
  }
  if (page.epoch !== state.epoch) {
    throw new SeatDriftError(
      "epoch",
      `seat apply: page is epoch ${page.epoch}, this file is ${state.epoch}`
    );
  }
}

/**
 * Apply one page of the log door's answer to this seat's file.
 *
 * Returns what landed. Throws {@link SeatDriftError} — and applies NOTHING —
 * when the page belongs to a file this one is not.
 */
export function applySeatLogPage(
  driver: SeatSqliteDriver,
  page: SeatLogPageWire,
  options: SeatApplyOptions = {}
): SeatApplyResult {
  const state = readSeatState(driver);
  assertNoDrift(state, page);
  const keys = new SeatTableKeys(driver);
  const now = options.now ?? ((): string => new Date().toISOString());

  // THE DRIFT GATE, PER ROW, BEFORE THE FIRST TRANSACTION OPENS. A page that
  // contains one row from another schema epoch is refused whole: applying the
  // rows in front of it and then stopping would leave the seat at a cursor
  // whose file no longer matches the number, which is the state re-bootstrap
  // exists to avoid.
  for (const row of page.rows) {
    if (row.schemaEpoch !== state.schemaEpoch) {
      throw new SeatDriftError(
        "schema-epoch",
        `seat apply: log row ${row.seq} is schema epoch ${row.schemaEpoch}, this file is ${state.schemaEpoch}`
      );
    }
  }

  const tables: string[] = [];
  const seen = new Set<string>();
  const commitSeqs: number[] = [];
  let applied = 0;
  let duplicate = 0;
  let deferred = 0;
  let ddl = 0;
  let cursor = state.appliedSeq;
  let ddlVersion = state.ddlVersion;
  let deferredFrom = state.deferredFrom;

  for (const group of groupByCommit(page.rows)) {
    if (group.lastSeq <= cursor) {
      // Rule 3: the whole commit is behind the cursor. Duplicate delivery.
      duplicate += group.rows.length;
      continue;
    }
    const fresh = group.rows.filter((row) => row.seq > cursor);
    duplicate += group.rows.length - fresh.length;
    const skip = group.deferred && options.deferOverThreshold === true;

    if (skip) {
      // THE OWED SPAN, AND THE CURSOR STAYS PUT (#1014, C1).
      //
      // It used to move: the seat recorded `deferred_from` and then set
      // `cursor = group.lastSeq`, so rule 3 above dropped every one of those
      // rows on the next delivery and NOTHING ever came back for them. A
      // 60-row photo import above the threshold was permanently absent from a
      // seat reporting `behind: 0`, and only a full re-bootstrap recovered it.
      //
      // Leaving the cursor where the last applied row put it makes the back-fill
      // the ordinary tail: the next pull asks from this position again, and a
      // seat no longer on a metered link applies the span it declined. It also
      // makes `behind` true — the distance to the head really is unapplied
      // work — which is what the member is shown.
      deferred += fresh.length;
      deferredFrom ??= fresh[0]!.seq;
      driver.run(
        `UPDATE seat_state SET gateway_watermark = ?, deferred_from = ?,
                updated_at = ?
          WHERE singleton = 1`,
        [Math.max(page.watermark, cursor), deferredFrom, now()]
      );
      // Nothing behind an owed span is applied either: taking later commits
      // would put the cursor past the span again by another route.
      break;
    }

    driver.exec("BEGIN IMMEDIATE");
    try {
      for (const row of fresh) {
        applyRow(driver, keys, row);
        if (row.op === "ddl") {
          ddl += 1;
          ddlVersion = Math.max(ddlVersion, row.ddlVersion);
          // The statement changed the shape the key cache answers for.
          keys.forget();
        } else if (!seen.has(row.table)) {
          seen.add(row.table);
          tables.push(row.table);
        }
      }
      applied += fresh.length;
      cursor = group.lastSeq;
      // THE OWED SPAN, PAID. A commit that applies at or past the recorded
      // position is the deferred rows landing — the seat is on wifi now — so
      // the flag that told the member "waiting for wifi" goes with them.
      if (deferredFrom !== undefined && cursor >= deferredFrom)
        deferredFrom = undefined;
      commitSeqs.push(group.commitSeq);
      options.onCommitInTransaction?.(group.commitSeq);
      driver.run(
        `UPDATE seat_state SET applied_seq = ?, applied_commit_seq = ?,
                ddl_version = ?, gateway_watermark = ?, deferred_from = ?,
                updated_at = ?
          WHERE singleton = 1`,
        [
          cursor,
          group.commitSeq,
          ddlVersion,
          Math.max(page.watermark, cursor),
          deferredFrom ?? null,
          now(),
        ]
      );
      driver.exec("COMMIT");
    } catch (error) {
      driver.exec("ROLLBACK");
      throw error;
    }
    // OUTSIDE THE `try`, DELIBERATELY. A throw from here must not reach the
    // ROLLBACK above: there is no transaction to roll back any more, and the
    // rows are the member's whether or not the shell listened.
    options.afterCommit?.(group.commitSeq);
  }

  // An empty page still tells the seat where the gateway's head is — which is
  // the difference between "caught up" and "no answer yet" on the watermark
  // line, and it is the only thing an empty page has to say.
  if (page.rows.length === 0 || commitSeqs.length === 0) {
    driver.run(
      `UPDATE seat_state SET gateway_watermark = ?, updated_at = ?
        WHERE singleton = 1`,
      [Math.max(page.watermark, cursor), now()]
    );
  }

  const notice: SeatChangeNotice = { tables, cursor, commitSeqs };
  if (tables.length > 0 || commitSeqs.length > 0) options.onChange?.(notice);
  return {
    ...notice,
    applied,
    duplicate,
    deferred,
    ddl,
    deferredFrom,
    gatewayWatermark: Math.max(page.watermark, cursor),
  };
}

function applyRow(
  driver: SeatSqliteDriver,
  keys: SeatTableKeys,
  row: SeatLogRowWire
): void {
  if (row.op === "ddl") {
    // AN ADDITIVE STATEMENT, RUN AS DDL. The gateway ships the statement
    // itself because a seat has no generator to re-derive it from — and it is
    // additive by contract (`ddl_version` is progress inside one epoch;
    // anything incompatible bumps `schema_epoch` and re-bootstraps instead).
    const sql = row.row?.["sql"];
    if (typeof sql !== "string") {
      throw new SeatDriftError(
        "schema-epoch",
        `seat apply: ddl row ${row.seq} carries no statement`
      );
    }
    driver.exec(sql);
    return;
  }
  const primaryKey = keys.of(row.table);
  if (row.op === "delete") {
    driver.run(deleteRowSql(row.table, primaryKey), row.pk.map(bindable));
    return;
  }
  const image = row.row;
  if (!image) {
    throw new SeatDriftError(
      "schema-epoch",
      `seat apply: ${row.op} row ${row.seq} carries no image`
    );
  }
  const columns = Object.keys(image);
  driver.run(
    applyRowSql(row.table, columns, primaryKey),
    columns.map((column) => bindable(image[column]!))
  );
}
