/*
 * THE THREE OUTPUTS (#996, R10). Sharing is the same log under a closure
 * predicate, and what a subscription owes its audience at each commit is
 * exactly three lists:
 *
 *   ENTER  — a row newly in scope, with its FULL IMAGE. An existing photograph
 *            added to a shared album has no log entry of its own: one entry row
 *            moved, and the asset, its bytes and its representation entered
 *            with it. Measured on the seeded year-3 vault: one log row, four
 *            rows entering. So enter is computed from the MEMBER-SET DIFF and
 *            never from the log.
 *   UPDATE — a RETAINED row that changed. This one is the log's, read straight
 *            off `replica_log` and coalesced by `(table, pk)` per pass: a
 *            single `UPDATE media_asset` produces two log rows (the row trigger
 *            and `touch_updated_at`'s write), so without the coalesce every
 *            field edit crosses the boundary twice.
 *   LEAVE  — a row no longer in scope, EVEN IF THE ROW ITSELF DID NOT CHANGE,
 *            and for a deleted or purged one. Also from the member-set diff:
 *            removing a photograph from a shared album writes one delete of the
 *            entry row and nothing at all about the four rows the audience must
 *            now scrub. And purging a shared MEMBER revokes nothing — the
 *            revoke trigger keys on a grant's SUBJECT — so leave is the only
 *            thing that reaches the audience's copy in the member case.
 *
 * There is no fourth table for any of this. The outputs are a function of
 * (member set before, member set after, the log since the cursor), computed
 * per pass and never stored.
 */

import type { DatabaseSync } from "node:sqlite";

import { decodeWireValue, encodeWireRow } from "@centraid/core/protocol";
import type { WireRowImage, WireValue } from "@centraid/core/protocol";

import type { ReplicaLogCursor } from "../replica/log.js";
import {
  primaryKeyOf,
  readReplicaLog,
  replicaLogState,
} from "../replica/log.js";
import type { ShareMemberRow, ShareMemberSet } from "./closure-members.js";
import {
  memberKey,
  readShareMembers,
  writeShareMembers,
} from "./closure-members.js";

/** A row on the wire: the physical table, the log's key, the full image. */
export interface ShareRowImage extends ShareMemberRow {
  readonly row: WireRowImage;
}

export interface ShareClosureOutputs {
  readonly authorityId: string;
  /** The origin log position these outputs stand for. */
  readonly cursor: ReplicaLogCursor;
  /**
   * `tail` — the audience's cursor is inside the log and the outputs are the
   * difference since it. `resend` — the audience is behind the retention floor
   * or in another epoch, so every member is sent as an `enter`. That is not a
   * re-bootstrap: `entered_seq` is what the audience compares against, so a
   * resent row it already holds costs it one upsert and no scrub, which is the
   * whole reason the column exists (reconnect after retention expiry).
   */
  readonly reason: "tail" | "resend";
  readonly enter: readonly ShareRowImage[];
  readonly update: readonly ShareRowImage[];
  readonly leave: readonly ShareMemberRow[];
}

/** True when the outputs ask the audience for nothing. */
export function shareOutputsAreEmpty(outputs: ShareClosureOutputs): boolean {
  return (
    outputs.enter.length === 0 &&
    outputs.update.length === 0 &&
    outputs.leave.length === 0
  );
}

function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * The current image of one member row, read from the origin. `undefined` when
 * the row is gone — which is not an error: a member deleted between the
 * closure read and this read is a LEAVE, and the caller drops it.
 */
function readRowImage(
  origin: DatabaseSync,
  member: ShareMemberRow
): WireRowImage | undefined {
  const key = primaryKeyOf(origin, member.table);
  const values = JSON.parse(member.pk) as WireValue[];
  const row = origin
    .prepare(
      `SELECT * FROM ${quoted(member.table)} WHERE ` +
        key.map((column) => `${quoted(column)} = ?`).join(" AND ")
    )
    .get(...values.map((value) => decodeWireValue(value))) as
    | Record<string, unknown>
    | undefined;
  return row === undefined ? undefined : encodeWireRow(row);
}

/**
 * The retained rows the log says changed, coalesced by `(table, pk)`.
 *
 * LAST ROW WINS, because a log row is a full image of what the row IS — so the
 * latest one in the page is the only one worth sending. A `delete` in the log
 * is not an update: the row left the closure, and the member-set diff has
 * already put it in `leave`.
 */
function updatesFromLog(
  origin: DatabaseSync,
  input: {
    retained: ReadonlySet<string>;
    since: ReplicaLogCursor | undefined;
    watermark: ReplicaLogCursor;
  }
): ShareRowImage[] {
  if (input.retained.size === 0) return [];
  const coalesced = new Map<string, ShareRowImage>();
  let cursor = input.since;
  // Whole pages, whole commits: the log door's own contract.
  for (;;) {
    const page = readReplicaLog(origin, { since: cursor, limit: 10_000 });
    for (const row of page.rows) {
      if (row.op === "delete" || row.row === null) continue;
      const pk = JSON.stringify(row.primaryKey);
      const key = memberKey(row.table, pk);
      if (!input.retained.has(key)) continue;
      coalesced.set(key, { table: row.table, pk, row: row.row });
    }
    if (!page.hasMore || page.next.seq >= input.watermark.seq) break;
    cursor = page.next;
  }
  return [...coalesced.values()];
}

export interface DiffShareClosureInput {
  readonly authorityId: string;
  /** The grant's closure as it stands now — `readShareClosure`'s result. */
  readonly members: ShareMemberSet;
  /**
   * Where the audience is. `undefined` is a NEW subscriber: everything in
   * scope enters, and the closure snapshot is what carries it.
   */
  readonly since?: ReplicaLogCursor;
}

/**
 * The three outputs for one subscription, READ-ONLY over the origin.
 *
 * `commitShareClosureDiff` is what makes the new membership durable; keeping
 * the two apart is what lets a caller compute the outputs, fail to deliver
 * them, and try again against the same `before` set rather than an audience
 * state it only assumed.
 */
export function diffShareClosure(
  origin: DatabaseSync,
  input: DiffShareClosureInput
): ShareClosureOutputs {
  const state = replicaLogState(origin);
  const before = readShareMembers(origin, input.authorityId);
  const after = input.members;
  const tail =
    input.since !== undefined &&
    input.since.epoch === state.epoch &&
    input.since.seq >= state.floor.seq &&
    input.since.seq <= state.watermark.seq;
  const enter: ShareRowImage[] = [];
  const retained = new Set<string>();
  for (const [key, member] of after) {
    if (before.has(key) && tail) {
      retained.add(key);
      continue;
    }
    const row = readRowImage(origin, member);
    if (row !== undefined) enter.push({ ...member, row });
  }
  const leave: ShareMemberRow[] = [];
  for (const [key, member] of before)
    if (!after.has(key)) leave.push({ table: member.table, pk: member.pk });
  return {
    authorityId: input.authorityId,
    cursor: state.watermark,
    reason: tail ? "tail" : "resend",
    enter,
    update: tail
      ? updatesFromLog(origin, {
          retained,
          since: input.since,
          watermark: state.watermark,
        })
      : [],
    leave,
  };
}

/**
 * Make the membership the outputs stand for durable, in the caller's
 * transaction. Called only once the outputs have been accepted by the
 * transport: membership is what the origin BELIEVES the audience holds, so
 * writing it before delivery would silently drop the retry.
 */
export function commitShareClosureDiff(
  origin: DatabaseSync,
  outputs: ShareClosureOutputs,
  members: ShareMemberSet
): void {
  writeShareMembers(origin, {
    authorityId: outputs.authorityId,
    members,
    enteredSeq: outputs.cursor.seq,
  });
}
