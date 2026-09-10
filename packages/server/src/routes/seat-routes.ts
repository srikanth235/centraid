// THE SEAT DOORS (#996, rulings R4 and R5).
//
// A seat holds `vault.db` whole, so it needs exactly two things from the
// gateway and nothing else: THE FILE, once, and THE LOG, forever after. That
// is the entire transport. There is no shape to negotiate, no per-app
// composition to compose, and no row-level authorization to evaluate per
// request — a device's enrollment already covers the whole vault, so the
// question these doors answer is "is this an enrolled seat", never "which
// rows may it see".
//
// They live beside today's shaped route rather than replacing it: the share
// transport is not deleted before its replacement serves every live
// subscription (#996's own invariant), and wave 5 takes the device half.
//
// WHY THE SNAPSHOT IS A FILE AND NOT AN RPC. At year-3 volume the sanitised
// copy is ~64 MB, ~9 MB compressed, and the client is a phone on a train. An
// RPC would have to invent resumption, chunking and integrity; a static file
// gets ranges, an ETag and conditional requests from the transport, and the
// artifact is immutable once built because it is named by the log position it
// stands at. So the door's job is to build-once-and-cache, and then get out
// of the way.

import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { gzipSync } from "node:zlib";

import {
  ROUTES,
  SEAT_LOG_MAX_PAGE,
  SEAT_SNAPSHOT_EPOCH_HEADER,
  SEAT_SNAPSHOT_SCHEMA_EPOCH_HEADER,
  SEAT_SNAPSHOT_SEQ_HEADER,
  SEAT_SNAPSHOT_VAULT_HEADER,
} from "@centraid/core/protocol";
import type {
  SeatLockerKeyWire,
  SeatLogPageWire,
  SeatRebootstrapRequiredWire,
} from "@centraid/core/protocol";
import {
  buildSeatSnapshot,
  readReplicaLog,
  recordSeatCursor,
  replicaLogState,
  ReplicaLogRebootstrapRequiredError,
  seatLogRowWire,
} from "@centraid/vault";

import type { RuntimeLogger } from "../engine/runtime.js";
import type { RouteHandler } from "../serve/build-gateway.js";
import type { EnrollmentStore } from "../serve/enrollment-store.js";
import { vaultContext } from "../serve/vault-context.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import { resolveReplicaAccess } from "./replica-access.js";
import { sendJson } from "./route-helpers.js";

export const SEAT_SNAPSHOT_PATH = ROUTES.vaultSeatSnapshot;
export const SEAT_LOG_PATH = ROUTES.vaultSeatLog;
export const SEAT_LOCKER_KEY_PATH = ROUTES.vaultSeatLockerKey;

/** Bounds one log page. A seat asks for more by asking again. */
const DEFAULT_LOG_PAGE = 1_000;
const MAX_LOG_PAGE = SEAT_LOG_MAX_PAGE;
/** How many built snapshots to keep. One per seq, newest first. */
const DEFAULT_SNAPSHOT_CACHE = 2;

export interface SeatRouteOptions {
  enrollments?: EnrollmentStore;
  /** Where built snapshots are cached. Defaults to `<vault dir>/seat`. */
  snapshotDir?: string;
  maxLogPage?: number;
  snapshotCacheSize?: number;
  /**
   * ONE LINE PER SEAT DOOR ANSWER (docs/logs.md).
   *
   * A seat that never catches up leaves no trace anywhere else: the log door
   * reads the vault's own `replica_log` and writes nothing, and the snapshot
   * door only touches disk the first time a watermark is asked for. So a phone
   * with an empty copy and a gateway holding hundreds of rows was
   * indistinguishable from a phone that never asked — which is exactly the
   * question a stale seat raises first. These lines make "did it ask" readable
   * from the gateway log ring instead of from a device console nobody kept.
   */
  logger?: RuntimeLogger;
}

interface SnapshotArtifact {
  readonly file: string;
  readonly seq: number;
  readonly epoch: string;
  readonly schemaEpoch: number;
  readonly bytes: number;
  readonly etag: string;
}

function artifactName(epoch: string, seq: number): string {
  // The epoch is a uuid and the seq an integer, so the name is already safe;
  // hashing keeps it short and keeps a future epoch format from escaping the
  // directory.
  const key = createHash("sha256").update(`${epoch}:${seq}`).digest("hex");
  return `snapshot-${key.slice(0, 16)}-${seq}.db.gz`;
}

/**
 * The snapshot for the current watermark, built once and cached.
 *
 * ONE CACHED SNAPSHOT PER SEQ. The artifact is a pure function of the log
 * position it was taken at, so a second seat bootstrapping at the same
 * position gets the same bytes and the same ETag — which is what makes a
 * resumed download resumable across gateway restarts rather than only within
 * one process.
 */
function snapshotFor(
  vault: Parameters<typeof buildSeatSnapshot>[0],
  dir: string,
  cacheSize: number
): SnapshotArtifact {
  const state = replicaLogState(vault);
  const seq = state.watermark.seq;
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, artifactName(state.epoch, seq));
  if (!existsSync(file)) {
    // Build beside the destination and rename in: a reader that arrives
    // mid-build must see either no artifact or a complete one, never a
    // truncated file it will happily decompress half of.
    const raw = path.join(dir, `${path.basename(file)}.building.db`);
    const staged = `${raw}.gz`;
    rmSync(raw, { force: true });
    rmSync(staged, { force: true });
    const built = buildSeatSnapshot(vault, raw);
    // Compressed on disk, served as-is: a range over the artifact is a range
    // over what the client is downloading, which `Content-Encoding` would
    // quietly make untrue.
    writeFileSync(staged, gzipSync(readFileSync(raw), { level: 6 }));
    rmSync(raw, { force: true });
    renameSync(staged, file);
    void built;
  }
  // Keep the newest few; an older seq is only useful to a download already in
  // flight, and holding every one of them is how a snapshot cache becomes a
  // second copy of the vault per commit.
  const kept = readdirSync(dir)
    .filter((name) => name.startsWith("snapshot-") && name.endsWith(".db.gz"))
    .sort()
    .toReversed();
  for (const name of kept.slice(cacheSize)) {
    if (path.join(dir, name) !== file)
      rmSync(path.join(dir, name), { force: true });
  }
  return {
    file,
    seq,
    epoch: state.epoch,
    schemaEpoch: state.schemaEpoch,
    bytes: statSync(file).size,
    // Strong, because the artifact is immutable for its name.
    etag: `"${state.epoch}-${seq}"`,
  };
}

interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * One `bytes=` range, or `undefined` for the whole artifact.
 *
 * Deliberately single-range: multipart ranges exist, no client needs them for
 * a resumed download, and the code to emit them correctly is more surface
 * than the feature is worth.
 */
export function parseByteRange(
  header: string | undefined,
  size: number
): ByteRange | undefined | "unsatisfiable" {
  if (!header) return undefined;
  const match = /^bytes=(?<from>\d*)-(?<to>\d*)$/u.exec(header.trim());
  if (!match?.groups) return "unsatisfiable";
  const rawStart = match.groups["from"]!;
  const rawEnd = match.groups["to"]!;
  if (rawStart === "" && rawEnd === "") return "unsatisfiable";
  if (rawStart === "") {
    // `bytes=-N`: the LAST n bytes.
    const length = Number(rawEnd);
    if (!Number.isFinite(length) || length <= 0) return "unsatisfiable";
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === "" ? size - 1 : Number(rawEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "unsatisfiable";
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end: Math.min(end, size - 1) };
}

export function makeSeatRouteHandler(
  vaults: VaultRegistry,
  options: SeatRouteOptions = {}
): RouteHandler {
  const maxPage = options.maxLogPage ?? MAX_LOG_PAGE;
  const cacheSize = options.snapshotCacheSize ?? DEFAULT_SNAPSHOT_CACHE;
  return async (req, res): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    const SEAT_PATHS: readonly string[] = [
      SEAT_SNAPSHOT_PATH,
      SEAT_LOG_PATH,
      SEAT_LOCKER_KEY_PATH,
    ];
    if (!SEAT_PATHS.includes(url.pathname)) return false;
    const method = (req.method ?? "GET").toUpperCase();
    // HEAD IS A SNAPSHOT-DOOR METHOD, and only there (#996, W5). The shipped
    // transport asks HEAD before it asks for bytes — deliberately, so the door
    // has BUILT the artifact and the seat can measure the phone's free space
    // against a real size before it starts a download it cannot finish. The
    // log and key doors answer JSON a caller either wants or does not, so
    // there is nothing for a HEAD of them to buy.
    const headOnly = method === "HEAD" && url.pathname === SEAT_SNAPSHOT_PATH;
    if (method !== "GET" && !headOnly) {
      res.statusCode = 405;
      res.setHeader(
        "Allow",
        url.pathname === SEAT_SNAPSHOT_PATH ? "GET, HEAD" : "GET"
      );
      res.end();
      return true;
    }
    const plane = vaults.current();
    const vaultId = vaultContext()?.vaultId ?? plane.boot.vaultId;
    // The SAME identity resolution as the shaped route: a seat is an enrolled
    // device, and there is no narrower principal these doors could consult.
    const resolution = resolveReplicaAccess(url, vaultId, options.enrollments);
    if (!resolution.ok) {
      sendJson(res, resolution.status, resolution.body);
      return true;
    }

    if (url.pathname === SEAT_LOCKER_KEY_PATH) {
      // THE KEY DOOR (#996, R13). The PRINCIPAL IS THE DEVICE ROW, resolved
      // exactly as the other two doors resolve it — `resolveReplicaAccess`
      // above has already refused an unenrolled or revoked device, which is
      // the whole authorization question here. There is no narrower one: an
      // enrolment covers the vault, and `K` opens the vault's Locker.
      //
      // WHY THIS AND NOT THE PAIRING TICKET. The QR ticket is a base64url
      // payload read off a screen by a camera; it is seen by whatever is
      // pointed at that screen, it survives in a photo roll, and it is
      // validated BEFORE any device exists to be a principal. A vault key
      // handed out that way is handed to the room. Fetching it afterwards
      // costs one authenticated request and buys a principal the gateway can
      // name, check against a revocation tombstone, and refuse.
      //
      // NO-STORE, on purpose: a proxy or a service worker holding `K` is a
      // second copy of the key in a place nothing revokes.
      const { keyId, key } = plane.db.lockerKey();
      res.setHeader("Cache-Control", "no-store");
      const answer: SeatLockerKeyWire = {
        vaultId,
        keyId,
        key: key.toString("base64"),
        algorithm: "aes-256-gcm",
      };
      return sendJson(res, 200, answer);
    }

    if (url.pathname === SEAT_LOG_PATH) {
      const requestedLimit = url.searchParams.get("limit");
      const limit =
        requestedLimit === null ? DEFAULT_LOG_PAGE : Number(requestedLimit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxPage) {
        return sendJson(res, 400, {
          error: "invalid_seat_log_limit",
          message: `limit must be an integer between 1 and ${maxPage}`,
        });
      }
      const state = replicaLogState(plane.db.vault);
      const sinceSeq = url.searchParams.get("since");
      const sinceEpoch = url.searchParams.get("epoch") ?? state.epoch;
      const seq = sinceSeq === null ? state.floor.seq : Number(sinceSeq);
      if (!Number.isSafeInteger(seq) || seq < 0) {
        return sendJson(res, 400, {
          error: "invalid_seat_log_cursor",
          message: "since must be a non-negative integer seq",
        });
      }
      let page;
      try {
        page = readReplicaLog(plane.db.vault, {
          since: { epoch: sinceEpoch, seq },
          limit,
        });
      } catch (error) {
        if (error instanceof ReplicaLogRebootstrapRequiredError) {
          // START OVER, SAID OUT LOUD. The alternative — serving what is left
          // — hands the seat a file that is silently missing the middle.
          const answer: SeatRebootstrapRequiredWire = {
            error: "seat_rebootstrap_required",
            reason: error.reason,
            epoch: error.state.epoch,
            floor: error.state.floor.seq,
            watermark: error.state.watermark.seq,
            schemaEpoch: error.state.schemaEpoch,
            snapshot: SEAT_SNAPSHOT_PATH,
          };
          return sendJson(res, 409, answer);
        }
        throw error;
      }
      // THE EPOCH GATE, ON EVERY ROW. The cursor check above is about the
      // REQUEST; this is about the ANSWER. A row from another epoch stands
      // for a schema the seat cannot apply, and applying one is a silent
      // no-op rather than a visible failure — so the gateway refuses to be
      // the one that shipped it.
      const foreign = page.rows.find((row) => row.epoch !== state.epoch);
      if (foreign) {
        return sendJson(res, 500, {
          error: "seat_log_epoch_mismatch",
          message: `log row ${foreign.seq} carries epoch ${foreign.epoch}, this vault is ${state.epoch}`,
        });
      }
      // THE HOLD THE PRUNE STANDS ON (#1014, V1/T9). `since` is the position
      // the device HAS — the rows above it are what it still needs — so this
      // is what `lowestSeatCursor` must not prune past. Recording the served
      // watermark instead would pin only what is already in flight and let
      // retention delete the rest.
      //
      // BEST-EFFORT, LIKE A DOORBELL: the page is already served and correct;
      // a failure to write bookkeeping about it may never fail the answer.
      if (sinceEpoch === state.epoch) {
        recordSeatCursor(plane.db.vault, resolution.access.deviceId, seq);
      }
      options.logger?.info(
        `seat log page for ${vaultId}: since ${seq}, ${page.rows.length} rows, ` +
          `next ${page.next.seq}, watermark ${page.watermark.seq}, hasMore ${String(page.hasMore)}`
      );
      const body: SeatLogPageWire = {
        vaultId,
        epoch: state.epoch,
        schemaEpoch: state.schemaEpoch,
        ddlVersion: state.ddlVersion,
        floor: page.floor.seq,
        watermark: page.watermark.seq,
        next: page.next.seq,
        hasMore: page.hasMore,
        rows: page.rows.map(seatLogRowWire),
      };
      return sendJson(res, 200, body);
    }

    const dir =
      options.snapshotDir ??
      (plane.dir === ":memory:" ? undefined : path.join(plane.dir, "seat"));
    if (dir === undefined) {
      return sendJson(res, 503, {
        error: "seat_snapshot_unavailable",
        message: "this gateway has no durable directory to build a snapshot in",
      });
    }
    const artifact = snapshotFor(plane.db.vault, dir, cacheSize);
    options.logger?.info(
      `seat snapshot for ${vaultId}: seq ${artifact.seq}, ${artifact.bytes} bytes, ` +
        `${headOnly ? "HEAD" : "GET"}`
    );
    res.setHeader("ETag", artifact.etag);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
    // The two numbers a seat needs before it opens the file: where it sits in
    // the log, and which contract it is under — and, since #1014 (C16), WHOSE
    // file it is. `vaultId` is the vault this request resolved to, which is
    // the same value the log door stamps on every page, so a seat comparing
    // the two is comparing one gateway's answer with itself.
    res.setHeader(SEAT_SNAPSHOT_VAULT_HEADER, vaultId);
    res.setHeader(SEAT_SNAPSHOT_SEQ_HEADER, String(artifact.seq));
    res.setHeader(SEAT_SNAPSHOT_EPOCH_HEADER, artifact.epoch);
    res.setHeader(
      SEAT_SNAPSHOT_SCHEMA_EPOCH_HEADER,
      String(artifact.schemaEpoch)
    );
    const inm = req.headers["if-none-match"];
    if (
      typeof inm === "string" &&
      inm.split(",").some((tag) => tag.trim() === artifact.etag)
    ) {
      res.statusCode = 304;
      res.end();
      return true;
    }
    const range = parseByteRange(
      typeof req.headers.range === "string" ? req.headers.range : undefined,
      artifact.bytes
    );
    if (range === "unsatisfiable") {
      res.statusCode = 416;
      res.setHeader("Content-Range", `bytes */${artifact.bytes}`);
      res.end();
      return true;
    }
    if (range) {
      res.statusCode = 206;
      res.setHeader(
        "Content-Range",
        `bytes ${range.start}-${range.end}/${artifact.bytes}`
      );
      res.setHeader("Content-Length", String(range.end - range.start + 1));
      await pipeline(
        createReadStream(artifact.file, { start: range.start, end: range.end }),
        res as unknown as NodeJS.WritableStream
      );
      return true;
    }
    res.statusCode = 200;
    res.setHeader("Content-Length", String(artifact.bytes));
    // A HEAD gets every header the GET would carry and none of the bytes —
    // which is the whole point of asking: the size, the ETag and the two seat
    // numbers, without spending the artifact on the wire.
    if (headOnly) {
      res.end();
      return true;
    }
    await pipeline(
      createReadStream(artifact.file),
      res as unknown as NodeJS.WritableStream
    );
    return true;
  };
}
