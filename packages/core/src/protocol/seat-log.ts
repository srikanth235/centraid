// WHAT THE SEAT DOORS PUT ON THE WIRE (#996, rulings R4 and R5).
//
// Wave 1 built the doors and hand-shaped their JSON; wave 2 builds the seat
// that reads it. Two programs now agree on these objects, so the agreement
// belongs in `packages/core` — where the contracts both hosts compile against
// live — rather than in a comment on one side and a cast on the other.
//
// THE WIRE IS DELIBERATELY NOT THE STORAGE SHAPE. `replica_log` names its
// columns `commit_seq`, `pk_json`, `row_json`; the wire names them `commitSeq`,
// `pk`, `row`, drops `epoch` from every row (the page carries it once — a row
// that disagreed with its page is the gateway's bug, and wave 1's door refuses
// to ship one), and OMITS `indirect` and `deferred` when false. A seat reads
// millions of these on a catch-up, so an absent key is worth having.

import type { WireValue } from "./row-json.js";

/** What one log row did to one row of one table. */
export type SeatLogOp = "insert" | "update" | "delete" | "ddl";

/**
 * One row of the gateway log, as the log door serves it.
 *
 * `row` is the FULL image for an insert or update and the full OLD image for a
 * delete — never the partial image a session changeset carries, which is the
 * one thing the gateway's decoder exists to remove from the wire.
 */
export interface SeatLogRowWire {
  readonly seq: number;
  readonly commitSeq: number;
  readonly schemaEpoch: number;
  readonly ddlVersion: number;
  readonly table: string;
  readonly op: SeatLogOp;
  /** Primary-key values, in declared key order. */
  readonly pk: readonly WireValue[];
  readonly row?: Readonly<Record<string, WireValue>>;
  readonly indirect?: true;
  /** This row's COMMIT crossed the defer threshold; a metered seat may skip it. */
  readonly deferred?: true;
  readonly producer: string;
  readonly committedAt: string;
}

/** One page of the log door's answer. Never half a commit. */
export interface SeatLogPageWire {
  readonly vaultId: string;
  readonly epoch: string;
  readonly schemaEpoch: number;
  readonly ddlVersion: number;
  readonly floor: number;
  readonly watermark: number;
  readonly next: number;
  readonly hasMore: boolean;
  readonly rows: readonly SeatLogRowWire[];
}

/** Why the gateway cannot answer this seat's cursor with a page. */
export type SeatRebootstrapReason =
  | "epoch-mismatch"
  | "retention"
  | "cursor-ahead";

/**
 * The log door's 409. START OVER, SAID OUT LOUD — with the three numbers a
 * seat needs to decide what to do next and the route it does it through.
 */
export interface SeatRebootstrapRequiredWire {
  readonly error: "seat_rebootstrap_required";
  readonly reason: SeatRebootstrapReason;
  readonly epoch: string;
  readonly floor: number;
  readonly watermark: number;
  readonly schemaEpoch: number;
  readonly snapshot: string;
}

/**
 * The three numbers the snapshot door puts in headers, so a seat knows where
 * the file sits and which contract it is under BEFORE it opens it.
 */
export const SEAT_SNAPSHOT_SEQ_HEADER = "x-centraid-seat-seq";
export const SEAT_SNAPSHOT_EPOCH_HEADER = "x-centraid-seat-epoch";
export const SEAT_SNAPSHOT_SCHEMA_EPOCH_HEADER = "x-centraid-schema-epoch";

/** What a seat reads off the snapshot door before it downloads a byte. */
export interface SeatSnapshotHead {
  /** Strong, and immutable for its name: the artifact is a pure function of `seq`. */
  readonly etag: string;
  readonly bytes: number;
  readonly seq: number;
  readonly epoch: string;
  readonly schemaEpoch: number;
}

/** The log door's ceiling on `limit`; a seat asks for more by asking again. */
export const SEAT_LOG_MAX_PAGE = 10_000;
