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

/**
 * WHICH VAULT THE ARTIFACT IS OF (#1014, C16 / R-1014-11).
 *
 * The three numbers above say where the file sits and what contract it is
 * under; none of them says WHOSE it is. A seat asked for a snapshot by URL,
 * installed whatever came back, and then wrote its OWN vault id onto the
 * result — so a door that answered for the wrong vault produced a file that
 * every later check agreed with, because every later check compared pages
 * against that self-asserted value. On a phone whose gateway base is a
 * loopback port re-picked each launch, "the wrong door" is not hypothetical.
 *
 * So the door names the vault, and the seat refuses a mismatch BEFORE it
 * touches its own file.
 */
export const SEAT_SNAPSHOT_VAULT_HEADER = "x-centraid-seat-vault";

/**
 * THE SEAT PINS THE ARTIFACT IT MEASURED (#1014, V4).
 *
 * The snapshot door builds for the CURRENT watermark, and a gateway is never
 * quiescent — the system recognition automations write their conversation
 * ledger on every boot, and those rows replicate. So a phone that HEADed seq 4
 * and then asked for bytes was answered with seq 5, which `If-Range` correctly
 * refuses as "a different file". On a slow enough connection against a busy
 * enough gateway that repeats forever and no bootstrap ever lands.
 *
 * `?seq=` is the seat saying WHICH artifact it is downloading. The door serves
 * that one while it still holds it and falls back to the current watermark when
 * it does not — and a gateway older than #1014 ignores the parameter entirely,
 * which is why the client keeps the moved-artifact retry as well.
 */
export const SEAT_SNAPSHOT_SEQ_PARAM = "seq";

/** What a seat reads off the snapshot door before it downloads a byte. */
export interface SeatSnapshotHead {
  /** Strong, and immutable for its name: the artifact is a pure function of `seq`. */
  readonly etag: string;
  readonly bytes: number;
  readonly seq: number;
  readonly epoch: string;
  readonly schemaEpoch: number;
  /**
   * The vault this artifact is a copy of.
   *
   * OPTIONAL ON THE WIRE, AND IT STAYS OPTIONAL. A gateway built before
   * #1014 sends no such header, and a phone that refused to bootstrap against
   * one would turn a compatible pair into a bricked mount — the replica
   * protocol does not get a lockstep upgrade. `undefined` therefore means
   * "this door did not say", which the seat treats as unverified-at-the-door
   * and logs; the check on the FILE's own `core_vault` row still runs, and
   * that one needs no cooperation from the gateway at all.
   */
  readonly vaultId?: string;
}

/** The log door's ceiling on `limit`; a seat asks for more by asking again. */
export const SEAT_LOG_MAX_PAGE = 10_000;

/**
 * THE LOCKER KEY DOOR'S ANSWER (#996, ruling R13).
 *
 * `K` reaches a seat over the AUTHENTICATED post-pair channel and never
 * through the QR pairing ticket. The ticket is a base64url payload a camera
 * reads off a screen; it is seen by whatever is pointed at that screen, it
 * outlives the glance in a photo roll, and it is validated before any device
 * exists to be the principal. A vault key handed out that way is a vault key
 * handed to the room. So the ticket stays what it is — an invitation to
 * enrol — and the key is fetched afterwards by the enrolled DEVICE ROW, which
 * is a principal the gateway can name, check against a revocation tombstone,
 * and refuse.
 *
 * `keyId` is as load-bearing as `key`: a seat compares it against the
 * `key_id` on the row it is about to open or write, and a mismatch is a
 * rotation it has not caught up with rather than a corrupt secret.
 */
export interface SeatLockerKeyWire {
  readonly vaultId: string;
  /** Which `locker_key` row this key is. */
  readonly keyId: string;
  /** `K`, base64. The only route by which a seat ever receives it. */
  readonly key: string;
  /** Named so a future scheme is a new value, never a silent reinterpretation. */
  readonly algorithm: "aes-256-gcm";
}
