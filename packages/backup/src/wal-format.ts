// governance: allow-repo-hygiene file-size-limit (#408) the WAL wire format is one normative unit — the key codecs, the sealing AAD/nonce derivations, the frame-boundary math, and the replay planner that consumes all three are a single argument about what a restore may trust; splitting them lets the format drift from the planner that enforces it
/*
 * WAL segment format (FORMAT.md, #408). A segment is `[start, end)` of a `-wal`
 * file, ending on a COMMIT boundary, captured between checkpoints the shipper
 * alone performs (I2). Segments seal RAW ranges — compression (#405) must never
 * reach them, or the deterministic-nonce idempotency contract breaks. SQLite
 * itself replays and validates on open; never re-implement replay here.
 *
 * Two rules, both forced by journal.db's out-of-process writers:
 *
 * 1. Segments end on commit boundaries. UNCOMMITTED trailing frames are NOT
 *    append-only — a rollback rewinds and the next transaction overwrites them,
 *    forking the shipped stream from the file.
 *
 * 2. A checkpointed group is closed only by a SEALED closer recording its exact
 *    end. N+1's frames are page images layered on N's checkpointed state, so
 *    replaying N+1 over a partial N mixes page versions into a database that
 *    opens but is subtly wrong. Its AAD-bound seal means a hostile provider can
 *    withhold objects but never fabricate a closer.
 *
 * Pure format: no fs, no sqlite. Capture is `@centraid/vault`'s WalShipper,
 * materialization `wal-restore.ts`.
 */

import { decrypt, deriveNonce, encryptWithNonce } from "./crypto.js";

/** Format-bearing: object keys embed these names. */
export type WalDbName = "vault" | "journal";
export const WAL_DB_NAMES: readonly WalDbName[] = ["vault", "journal"];

/**
 * The order both databases MUST be cut in, everywhere. Journal FIRST: a receipt
 * commits to journal.db only after its vault.db transaction did, so the reverse
 * order manufactures dangling receipts. Named because `WAL_DB_NAMES` is the
 * WRONG order and any ordering-sensitive loop reaching for it is silently wrong.
 */
export const WAL_CAPTURE_ORDER: readonly WalDbName[] = ["journal", "vault"];

/** `vault` ↔ `vault.db` (manifest entry path / on-disk name). */
export const WAL_DB_FILES: Record<WalDbName, string> = {
  vault: "vault.db",
  journal: "journal.db",
};

export interface WalSegmentAddress {
  db: WalDbName;
  /** 32 hex chars, random per stream era. */
  generation: string;
  /** 0-based, +1 per TRUNCATE checkpoint. */
  group: number;
  /** Inclusive, frame-aligned; 0 includes the 32-byte WAL header. */
  startOffset: number;
  /** Exclusive, on a commit boundary. Always > startOffset. */
  endOffset: number;
  /**
   * Capture tick (monotonicized wall-clock ms). Which tick a coordinated restore
   * cuts at is decided by the `WalPairMarker`, never the listing: an absent
   * segment and an absent write look identical.
   */
  tickMs: number;
}

/** Group checkpointed at exactly `endOffset` WAL bytes. */
export interface WalGroupCloser {
  db: WalDbName;
  generation: string;
  group: number;
  endOffset: number;
}

/** One database's position at the end of a tick. */
export interface WalPairPosition {
  group: number;
  /** Bytes of `group` durably captured; 0 when it has just opened. */
  endOffset: number;
}

/**
 * What BOTH databases had shipped at `tickMs`, sealed by the shipper, because a
 * LISTING cannot tell an IDLE database from one whose newest objects are GONE —
 * both look like a stream that ends. An idle vault must not hold a busy journal
 * back; a vault whose tail was lost MUST, or the journal carries receipts for
 * rows the restore lacks. Only the producer knows, and the seal is why a
 * provider can withhold this but never forge it.
 *
 * Both generations live in the KEY, so restore LISTs exactly its base pair's
 * markers, already tick-ordered, and GC decides from the key alone.
 */
export interface WalPairMarker {
  vaultGeneration: string;
  journalGeneration: string;
  tickMs: number;
  vault: WalPairPosition;
  journal: WalPairPosition;
}

const GENERATION_RE = /^[0-9a-f]{32}$/u;

/**
 * 128 random bits, hex. Random, never a counter: a restored-then-rolled-back
 * counter collides with its own past (#116); 128 random bits cannot.
 */
export function newWalGeneration(
  randomBytes: (n: number) => Uint8Array
): string {
  return Buffer.from(randomBytes(16)).toString("hex");
}

export function isWalGeneration(value: string): boolean {
  return GENERATION_RE.test(value);
}

const pad = (n: number, width: number): string =>
  String(n).padStart(width, "0");

/**
 * Segment: `wal/{db}/{generation}/{group:08}/{start:012}-{end:012}-{tick:013}`.
 * Closer:  `wal/{db}/{generation}/{group:08}/closed-{end:012}`.
 * Fixed-width decimals keep lexicographic key order equal to replay order, and
 * the key alone carries the full address — planning needs only a LIST plus one
 * authenticated read per closer.
 */
export function walSegmentKey(addr: WalSegmentAddress): string {
  assertValidAddress(addr);
  return (
    `wal/${addr.db}/${addr.generation}/${pad(addr.group, 8)}/` +
    `${pad(addr.startOffset, 12)}-${pad(addr.endOffset, 12)}-${pad(addr.tickMs, 13)}`
  );
}

/** Closers gate group advance — see the module header. */
export function walGroupCloserKey(closer: WalGroupCloser): string {
  assertValidCloser(closer);
  return `wal/${closer.db}/${closer.generation}/${pad(closer.group, 8)}/closed-${pad(closer.endOffset, 12)}`;
}

/** Prefix for one database's generation, or one group of it. */
export function walSegmentPrefix(
  db: WalDbName,
  generation: string,
  group?: number
): string {
  if (!GENERATION_RE.test(generation))
    throw new Error(`invalid wal generation "${generation}"`);
  const base = `wal/${db}/${generation}/`;
  return group === undefined ? base : `${base}${pad(group, 8)}/`;
}

/** Every generation of one database (GC discovery). */
export function walDbPrefix(db: WalDbName): string {
  return `wal/${db}/`;
}

/** Pair marker: `wal/tick/{vaultGeneration}-{journalGeneration}/{tick:013}`. */
export function walPairMarkerKey(marker: {
  vaultGeneration: string;
  journalGeneration: string;
  tickMs: number;
}): string {
  assertValidPairAddress(marker);
  return `${walPairMarkerPrefix(marker.vaultGeneration, marker.journalGeneration)}${pad(marker.tickMs, 13)}`;
}

/** One BASE PAIR's markers — the only ones a restore may use. */
export function walPairMarkerPrefix(
  vaultGeneration: string,
  journalGeneration: string
): string {
  if (
    !GENERATION_RE.test(vaultGeneration) ||
    !GENERATION_RE.test(journalGeneration)
  ) {
    throw new Error(
      `invalid wal generation pair "${vaultGeneration}-${journalGeneration}"`
    );
  }
  return `wal/tick/${vaultGeneration}-${journalGeneration}/`;
}

/** Every pair marker (GC discovery; the key names both generations). */
export function walPairMarkerRootPrefix(): string {
  return "wal/tick/";
}

const SEGMENT_KEY_RE =
  /^wal\/(?<db>vault|journal)\/(?<generation>[0-9a-f]{32})\/(?<group>\d{8})\/(?<startOffset>\d{12})-(?<endOffset>\d{12})-(?<tickMs>\d{13})$/u;
const CLOSER_KEY_RE =
  /^wal\/(?<db>vault|journal)\/(?<generation>[0-9a-f]{32})\/(?<group>\d{8})\/closed-(?<endOffset>\d{12})$/u;
const PAIR_MARKER_KEY_RE =
  /^wal\/tick\/(?<vaultGeneration>[0-9a-f]{32})-(?<journalGeneration>[0-9a-f]{32})\/(?<tickMs>\d{13})$/u;

/** Everything a pair-marker key carries. */
export interface WalPairMarkerAddress {
  vaultGeneration: string;
  journalGeneration: string;
  tickMs: number;
}

/** Null for keys that are not pair markers. */
export function parseWalPairMarkerKey(
  key: string
): WalPairMarkerAddress | null {
  const m = PAIR_MARKER_KEY_RE.exec(key);
  if (!m) return null;
  const g = m.groups!;
  return {
    vaultGeneration: g.vaultGeneration!,
    journalGeneration: g.journalGeneration!,
    tickMs: Math.trunc(Number(g.tickMs!)),
  };
}

/** Null for keys that are not WAL segments. */
export function parseWalSegmentKey(key: string): WalSegmentAddress | null {
  const m = SEGMENT_KEY_RE.exec(key);
  if (!m) return null;
  const g = m.groups!;
  const addr: WalSegmentAddress = {
    db: g.db as WalDbName,
    generation: g.generation!,
    group: Math.trunc(Number(g.group!)),
    startOffset: Math.trunc(Number(g.startOffset!)),
    endOffset: Math.trunc(Number(g.endOffset!)),
    tickMs: Math.trunc(Number(g.tickMs!)),
  };
  return addr.endOffset > addr.startOffset ? addr : null;
}

/**
 * Null for non-closers. The positivity check must live here as well as in
 * `assertValidCloser` — `CLOSER_KEY_RE` admits `closed-000000000000`, which
 * downstream would read as a group closed at offset 0 (#846).
 */
export function parseWalCloserKey(key: string): WalGroupCloser | null {
  const m = CLOSER_KEY_RE.exec(key);
  if (!m) return null;
  const g = m.groups!;
  const closer: WalGroupCloser = {
    db: g.db as WalDbName,
    generation: g.generation!,
    group: Math.trunc(Number(g.group!)),
    endOffset: Math.trunc(Number(g.endOffset!)),
  };
  return closer.endOffset > 0 ? closer : null;
}

function assertValidAddress(addr: WalSegmentAddress): void {
  if (!GENERATION_RE.test(addr.generation)) {
    throw new Error(`invalid wal generation "${addr.generation}"`);
  }
  if (!Number.isInteger(addr.group) || addr.group < 0) {
    throw new Error(`invalid wal group ${addr.group}`);
  }
  if (
    !Number.isInteger(addr.startOffset) ||
    !Number.isInteger(addr.endOffset) ||
    addr.startOffset < 0 ||
    addr.endOffset <= addr.startOffset
  ) {
    throw new Error(
      `invalid wal segment range ${addr.startOffset}-${addr.endOffset}`
    );
  }
  if (!Number.isInteger(addr.tickMs) || addr.tickMs < 0) {
    throw new Error(`invalid wal segment tick ${addr.tickMs}`);
  }
}

function assertValidCloser(closer: WalGroupCloser): void {
  if (!GENERATION_RE.test(closer.generation)) {
    throw new Error(`invalid wal generation "${closer.generation}"`);
  }
  if (!Number.isInteger(closer.group) || closer.group < 0) {
    throw new Error(`invalid wal group ${closer.group}`);
  }
  if (!Number.isInteger(closer.endOffset) || closer.endOffset <= 0) {
    throw new Error(`invalid wal closer end ${closer.endOffset}`);
  }
}

function assertValidPairAddress(addr: WalPairMarkerAddress): void {
  if (
    !GENERATION_RE.test(addr.vaultGeneration) ||
    !GENERATION_RE.test(addr.journalGeneration)
  ) {
    throw new Error(
      `invalid wal generation pair "${addr.vaultGeneration}-${addr.journalGeneration}"`
    );
  }
  if (!Number.isInteger(addr.tickMs) || addr.tickMs < 0) {
    throw new Error(`invalid wal pair marker tick ${addr.tickMs}`);
  }
}

// ─── WAL frame-boundary math (sqlite.org/walformat.html) ─────
// #532 mutation ownership is the addressing surface above (keys + parsers);
// everything below keeps unit/contract coverage via wal-format.test.ts instead.
// Stryker disable all

// `WalPairPosition` is pair-marker PAYLOAD, never a KEY, so its validator sits
// on this side of the ownership line (#656 Layer 1C).
function assertValidPosition(pos: WalPairPosition, db: WalDbName): void {
  if (!Number.isInteger(pos.group) || pos.group < 0) {
    throw new Error(`invalid ${db} marker group ${pos.group}`);
  }
  if (!Number.isInteger(pos.endOffset) || pos.endOffset < 0) {
    throw new Error(`invalid ${db} marker offset ${pos.endOffset}`);
  }
}

export const WAL_HEADER_BYTES = 32;
const FRAME_HEADER_BYTES = 24;

/** Header bytes 8..12, big-endian. */
export function walPageSize(header: Uint8Array): number {
  if (header.length < WAL_HEADER_BYTES) throw new Error("wal header truncated");
  const view = new DataView(
    header.buffer,
    header.byteOffset,
    header.byteLength
  );
  const magic = view.getUint32(0);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) {
    throw new Error(`not a wal header (magic 0x${magic.toString(16)})`);
  }
  const pageSize = view.getUint32(8);
  if (!Number.isInteger(pageSize) || pageSize < 512 || pageSize > 65536) {
    throw new Error(`implausible wal page size ${pageSize}`);
  }
  return pageSize;
}

/** Header bytes 16/20; the G5 foreign-checkpoint detector reads these. */
export function walSalts(header: Uint8Array): { salt1: number; salt2: number } {
  if (header.length < WAL_HEADER_BYTES) throw new Error("wal header truncated");
  const view = new DataView(
    header.buffer,
    header.byteOffset,
    header.byteLength
  );
  return { salt1: view.getUint32(16), salt2: view.getUint32(20) };
}

/**
 * Largest commit-frame boundary in `[baseOffset, baseOffset + bytes.length)`;
 * `baseOffset` must be frame-aligned. A frame is `24-byte header || page` and a
 * commit frame has a non-zero size field at header bytes 4..8. Returns
 * `baseOffset` when no commit frame completes.
 *
 * The ONLY frame-level knowledge in the feature: journal.db's out-of-process
 * writers leave non-append-only tails, so shipping past the last commit forks
 * the stream from the file.
 */
export function lastCommitBoundary(
  bytes: Uint8Array,
  baseOffset: number,
  pageSize: number
): number {
  const frameBytes = FRAME_HEADER_BYTES + pageSize;
  // First frame header sits at 32 when baseOffset is 0, at 0 otherwise.
  if (baseOffset !== 0 && (baseOffset - WAL_HEADER_BYTES) % frameBytes !== 0) {
    throw new Error(
      `wal offset ${baseOffset} is not frame-aligned for page size ${pageSize}`
    );
  }
  let at = baseOffset === 0 ? WAL_HEADER_BYTES : 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let lastCommitEnd = baseOffset; // no commit in range ⇒ ship nothing
  while (at + frameBytes <= bytes.length) {
    const dbSizeAfterCommit = view.getUint32(at + 4);
    at += frameBytes;
    if (dbSizeAfterCommit !== 0) lastCommitEnd = baseOffset + at;
  }
  return lastCommitEnd;
}

export interface WalPrefixScan {
  pageSize: number;
  /** End of the last frame whose salts and checksum validate. */
  validEndOffset: number;
  /** End of the last validated commit frame. */
  lastCommitOffset: number;
}

function checksumRange(
  bytes: Uint8Array,
  start: number,
  end: number,
  littleEndian: boolean,
  seed: { s1: number; s2: number }
): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = start; at < end; at += 8) {
    seed.s1 = (seed.s1 + view.getUint32(at, littleEndian) + seed.s2) >>> 0;
    seed.s2 = (seed.s2 + view.getUint32(at + 4, littleEndian) + seed.s1) >>> 0;
  }
}

/**
 * Reports a torn tail as `validEndOffset`; rejecting it is
 * `validateCommittedWal`'s job, not this one's.
 */
export function scanWalPrefix(bytes: Uint8Array): WalPrefixScan {
  if (bytes.length < WAL_HEADER_BYTES) throw new Error("wal header truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) {
    throw new Error(`not a wal header (magic 0x${magic.toString(16)})`);
  }
  const littleEndian = magic === 0x377f0682;
  const pageSize = walPageSize(bytes.subarray(0, WAL_HEADER_BYTES));
  const seed = { s1: 0, s2: 0 };
  checksumRange(bytes, 0, 24, littleEndian, seed);
  if (seed.s1 !== view.getUint32(24) || seed.s2 !== view.getUint32(28)) {
    throw new Error("wal header checksum mismatch");
  }
  const salt1 = view.getUint32(16);
  const salt2 = view.getUint32(20);
  const frameBytes = FRAME_HEADER_BYTES + pageSize;
  let at = WAL_HEADER_BYTES;
  let validEndOffset = WAL_HEADER_BYTES;
  let lastCommitOffset = 0;
  while (at + frameBytes <= bytes.length) {
    if (view.getUint32(at + 8) !== salt1 || view.getUint32(at + 12) !== salt2)
      break;
    checksumRange(bytes, at, at + 8, littleEndian, seed);
    checksumRange(
      bytes,
      at + FRAME_HEADER_BYTES,
      at + frameBytes,
      littleEndian,
      seed
    );
    if (
      seed.s1 !== view.getUint32(at + 16) ||
      seed.s2 !== view.getUint32(at + 20)
    )
      break;
    at += frameBytes;
    validEndOffset = at;
    if (view.getUint32(at - frameBytes + 4) !== 0) lastCommitOffset = at;
  }
  return { pageSize, validEndOffset, lastCommitOffset };
}

/** A shipped object/group MUST be a complete, checksum-valid commit prefix. */
export function validateCommittedWal(bytes: Uint8Array): WalPrefixScan {
  const scan = scanWalPrefix(bytes);
  if (scan.validEndOffset !== bytes.length) {
    throw new Error(
      `wal frame checksum/salt mismatch at offset ${scan.validEndOffset} (length ${bytes.length})`
    );
  }
  if (scan.lastCommitOffset !== bytes.length) {
    throw new Error("wal bytes do not end at a commit boundary");
  }
  return scan;
}

// ─── Sealing: deterministic nonce + full-address AAD ─────

function nonceInfo(addr: WalSegmentAddress): string {
  // MUST cover every field of the key; the tuple is then injective under one
  // dataKey. `endOffset` especially: a crash between segment-fsync and
  // offset-fsync makes the retry re-read a LONGER range from the same start, so
  // without it the nonce repeats on different plaintext — GCM's one fatal sin.
  // `tickMs` costs no idempotency (G7): a re-upload re-seals the same local
  // file, whose name IS the key's basename, so the bytes are identical.
  return `centraid-backup:wal-nonce:${addr.db}:${addr.generation}:${addr.group}:${addr.startOffset}:${addr.endOffset}:${addr.tickMs}`;
}

function segmentAad(vaultId: string, addr: WalSegmentAddress): Uint8Array {
  // Binds ciphertext to its full address and vault, so a provider swapping two
  // same-size segments fails the tag check. `tickMs` MUST be here — it alone
  // decides point-in-time and coordinated cuts (G8), and unbound, a segment
  // copied onto a FORGED-tick key would still authenticate. The tag must cover
  // every field the planner trusts.
  return new Uint8Array(
    Buffer.from(
      `centraid-wal/1:${vaultId}:${addr.db}:${addr.generation}:${addr.group}:${addr.startOffset}:${addr.endOffset}:${addr.tickMs}`,
      "utf8"
    )
  );
}

/** Deterministic: same address + bytes ⇒ same object. */
export function sealWalSegment(
  dataKey: Uint8Array,
  vaultId: string,
  addr: WalSegmentAddress,
  plain: Uint8Array
): Uint8Array {
  assertValidAddress(addr);
  if (plain.length !== addr.endOffset - addr.startOffset) {
    throw new Error(
      `sealWalSegment: ${plain.length} bytes for range ${addr.startOffset}-${addr.endOffset}`
    );
  }
  const nonce = deriveNonce(dataKey, nonceInfo(addr));
  return encryptWithNonce(dataKey, nonce, plain, segmentAad(vaultId, addr));
}

/** Throws on tampering, truncation, or address swap. */
export function openWalSegment(
  dataKey: Uint8Array,
  vaultId: string,
  addr: WalSegmentAddress,
  sealed: Uint8Array
): Uint8Array {
  const plain = decrypt(dataKey, sealed, segmentAad(vaultId, addr));
  if (plain.length !== addr.endOffset - addr.startOffset) {
    throw new Error(
      `openWalSegment: ${plain.length} bytes for range ${addr.startOffset}-${addr.endOffset}`
    );
  }
  return plain;
}

function closerNonceInfo(closer: WalGroupCloser): string {
  return `centraid-backup:wal-nonce:${closer.db}:${closer.generation}:${closer.group}:${closer.endOffset}:closed`;
}

function closerAad(vaultId: string, closer: WalGroupCloser): Uint8Array {
  return new Uint8Array(
    Buffer.from(
      `centraid-wal/1:${vaultId}:${closer.db}:${closer.generation}:${closer.group}:${closer.endOffset}:closed`,
      "utf8"
    )
  );
}

/**
 * An empty payload whose GCM tag over the AAD-bound address is the whole point:
 * it proves the SHIPPER, not the provider, asserted where the group ends.
 */
export function sealWalCloser(
  dataKey: Uint8Array,
  vaultId: string,
  closer: WalGroupCloser
): Uint8Array {
  assertValidCloser(closer);
  const nonce = deriveNonce(dataKey, closerNonceInfo(closer));
  return encryptWithNonce(
    dataKey,
    nonce,
    new Uint8Array(0),
    closerAad(vaultId, closer)
  );
}

/** Throws on tampering or address swap. */
export function openWalCloser(
  dataKey: Uint8Array,
  vaultId: string,
  closer: WalGroupCloser,
  sealed: Uint8Array
): void {
  const plain = decrypt(dataKey, sealed, closerAad(vaultId, closer));
  if (plain.length !== 0) throw new Error("openWalCloser: unexpected payload");
}

function pairNonceInfo(addr: WalPairMarkerAddress): string {
  return `centraid-backup:wal-nonce:tick:${addr.vaultGeneration}:${addr.journalGeneration}:${addr.tickMs}`;
}

function pairAad(vaultId: string, addr: WalPairMarkerAddress): Uint8Array {
  // Every field of the key, `tick` included: it alone decides which marker a
  // point-in-time restore selects, so a relabelled marker would make restore
  // trust a LATER pair position at an EARLIER tick.
  return new Uint8Array(
    Buffer.from(
      `centraid-wal/1:${vaultId}:tick:${addr.vaultGeneration}:${addr.journalGeneration}:${addr.tickMs}`,
      "utf8"
    )
  );
}

/**
 * FIXED field order, never `JSON.stringify`: the nonce is deterministic over the
 * address, so two different payloads under one address reuse a (key, nonce)
 * pair. This is what makes an honest retry converge byte-identically.
 */
function pairPayload(marker: WalPairMarker): Uint8Array {
  const pos = (p: WalPairPosition): string =>
    `{"endOffset":${p.endOffset},"group":${p.group}}`;
  return new TextEncoder().encode(
    `{"journal":${pos(marker.journal)},"tickMs":${marker.tickMs},"v":1,"vault":${pos(marker.vault)}}`
  );
}

/** Deterministic: same address + positions ⇒ same object. */
export function sealWalPairMarker(
  dataKey: Uint8Array,
  vaultId: string,
  marker: WalPairMarker
): Uint8Array {
  assertValidPairAddress(marker);
  assertValidPosition(marker.vault, "vault");
  assertValidPosition(marker.journal, "journal");
  const nonce = deriveNonce(dataKey, pairNonceInfo(marker));
  return encryptWithNonce(
    dataKey,
    nonce,
    pairPayload(marker),
    pairAad(vaultId, marker)
  );
}

/** The payload-vs-key `tickMs` check is belt and braces over the AAD. */
export function openWalPairMarker(
  dataKey: Uint8Array,
  vaultId: string,
  addr: WalPairMarkerAddress,
  sealed: Uint8Array
): WalPairMarker {
  const plain = decrypt(dataKey, sealed, pairAad(vaultId, addr));
  const parsed = JSON.parse(new TextDecoder().decode(plain)) as {
    v?: number;
    tickMs?: number;
    vault?: WalPairPosition;
    journal?: WalPairPosition;
  };
  if (parsed.v !== 1)
    throw new Error(`openWalPairMarker: unknown payload version ${parsed.v}`);
  if (parsed.tickMs !== addr.tickMs) {
    throw new Error(
      `openWalPairMarker: payload tick ${parsed.tickMs} disagrees with key tick ${addr.tickMs}`
    );
  }
  if (!parsed.vault || !parsed.journal)
    throw new Error("openWalPairMarker: missing positions");
  const marker: WalPairMarker = {
    vaultGeneration: addr.vaultGeneration,
    journalGeneration: addr.journalGeneration,
    tickMs: addr.tickMs,
    vault: { group: parsed.vault.group, endOffset: parsed.vault.endOffset },
    journal: {
      group: parsed.journal.group,
      endOffset: parsed.journal.endOffset,
    },
  };
  assertValidPosition(marker.vault, "vault");
  assertValidPosition(marker.journal, "journal");
  return marker;
}

// ─── Replay planning ─────

export interface WalReplayPlan {
  /** Replay order (group asc, offset asc), already cut. */
  segments: WalSegmentAddress[];
  /** Tick of the last planned segment; -1 when none applies. */
  lastTickMs: number;
  /**
   * The plan stopped at a hole rather than the requested cut. NOT the
   * coordination signal: a stream whose newest objects are gone has no hole, and
   * one wholly gone lists nothing. Coordination is pair markers' job; this says
   * only that one chain broke before the cut.
   */
  truncatedByHole: boolean;
}

/** LIST-derived planner input for one database. */
export interface WalStreamListing {
  segments: WalSegmentAddress[];
  /** Only closers that AUTHENTICATED may be passed here. */
  closers: WalGroupCloser[];
}

/**
 * Chain one database's segments into a replayable prefix. Each rule is
 * load-bearing:
 * - Advancing to group N+1 requires N chained EXACTLY to its authenticated
 *   closer's end; no closer ⇒ dead end. (N+1's frames layer on N's checkpointed
 *   state, so a partial N mixes page versions.)
 * - Within a group, chain gaplessly from 0; duplicate starts keep the LONGEST
 *   range. A segment chaining past the closer end is a producer anomaly: stop.
 * - `cutTickMs` stops before the first later-ticked segment. Mid-group is fine —
 *   it is a historical state of that WAL.
 */
export function planWalReplay(
  listing: WalStreamListing,
  opts: { generation: string; db: WalDbName; cutTickMs?: number }
): WalReplayPlan {
  const cut = opts.cutTickMs ?? Number.POSITIVE_INFINITY;
  const relevant = listing.segments
    // Filter by PITR eligibility BEFORE resolving duplicate starts, or a longer
    // post-cut retry hides a shorter same-start segment durable at the cut.
    .filter(
      (s) =>
        s.db === opts.db && s.generation === opts.generation && s.tickMs <= cut
    )
    .sort(
      (a, b) =>
        a.group - b.group ||
        a.startOffset - b.startOffset ||
        b.endOffset - a.endOffset
    );
  const closerEnd = new Map<number, number>();
  for (const c of listing.closers) {
    if (c.db === opts.db && c.generation === opts.generation) {
      closerEnd.set(c.group, c.endOffset);
    }
  }

  const planned: WalSegmentAddress[] = [];
  let group = 0;
  let offset = 0;
  let hole = false;
  const closedAt = () => closerEnd.get(group);

  for (const seg of relevant) {
    if (seg.group === group) {
      if (seg.startOffset < offset) {
        if (seg.endOffset <= offset) continue; // stale shorter duplicate
        hole = true; // overlapping-but-extending cannot happen post-hygiene
        break;
      }
      if (seg.startOffset > offset) {
        hole = true;
        break;
      }
      const end = closedAt();
      if (end !== undefined && seg.endOffset > end) {
        hole = true;
        break;
      }
      planned.push(seg);
      offset = seg.endOffset;
    } else if (
      seg.group === group + 1 &&
      closedAt() === offset &&
      seg.startOffset === 0
    ) {
      planned.push(seg);
      group = seg.group;
      offset = seg.endOffset;
    } else {
      hole = true;
      break;
    }
  }

  return {
    segments: planned,
    lastTickMs: planned.length > 0 ? planned[planned.length - 1]!.tickMs : -1,
    truncatedByHole: hole,
  };
}

const EMPTY_LISTING: WalStreamListing = { segments: [], closers: [] };
const EMPTY_PLAN: WalReplayPlan = {
  segments: [],
  lastTickMs: -1,
  truncatedByHole: false,
};

/**
 * What a planned chain REACHES, in the terms a pair marker records. The
 * normalization is the point: a chain ending at group N's AUTHENTICATED closer
 * is `(N+1, 0)`, matching the shipper after a rollover, while the same offset
 * with the closer MISSING is only `(N, end)` and fails that marker. That is the
 * only way a lost TAIL CLOSER is detectable at all.
 */
export function reachedPosition(
  plan: WalReplayPlan,
  listing: WalStreamListing,
  opts: { db: WalDbName; generation: string }
): WalPairPosition {
  const last = plan.segments[plan.segments.length - 1];
  // No planned segment ⇒ the base itself, always group 0, offset 0.
  if (!last) return { group: 0, endOffset: 0 };
  const closed = listing.closers.some(
    (c) =>
      c.db === opts.db &&
      c.generation === opts.generation &&
      c.group === last.group &&
      c.endOffset === last.endOffset
  );
  return closed
    ? { group: last.group + 1, endOffset: 0 }
    : { group: last.group, endOffset: last.endOffset };
}

/** What `planCoordinatedReplay` decided, and how short of the tip. */
export interface CoordinatedReplayResult {
  plans: Record<WalDbName, WalReplayPlan>;
  /**
   * The single tick BOTH databases were cut at; -1 at the base floor, which is
   * itself coordinated since both bases come from one tick.
   */
  coordinatedCutMs: number;
  /**
   * Newest marker at or before the cut; -1 when none. `coordinatedCutMs <
   * newestMarkerTickMs` is the real "tip NOT restorable" signal.
   */
  newestMarkerTickMs: number;
  /** False when only one database has a generation. */
  coordinated: boolean;
}

/**
 * The coordinated two-database cut (G8). Walk markers newest-first and take the
 * first BOTH databases can PROVE they reached; none satisfiable ⇒ the base pair,
 * coherent because both bases are minted in one tick.
 *
 * Never drive this from the listing: it cannot tell IDLE from LOST. "Smaller
 * reached tick" regresses an idle vault; each database's own tip lets a lost
 * vault tail hand back a journal carrying receipts for absent rows. A provider
 * CAN withhold markers and roll the restore back — G6 degradation, defended by
 * freshness signals, not by the format.
 */
export function planCoordinatedReplay(opts: {
  listingByDb: Partial<Record<WalDbName, WalStreamListing>>;
  generationByDb: Partial<Record<WalDbName, string>>;
  /** EXACTLY this base pair, already authenticated. Order irrelevant. */
  markers?: readonly WalPairMarker[];
  cutTickMs?: number;
}): CoordinatedReplayResult {
  const { listingByDb, generationByDb } = opts;
  const cut = opts.cutTickMs ?? Number.POSITIVE_INFINITY;
  const plan = (
    db: WalDbName,
    generation: string,
    cutTickMs: number
  ): WalReplayPlan =>
    planWalReplay(listingByDb[db] ?? EMPTY_LISTING, {
      db,
      generation,
      ...(Number.isFinite(cutTickMs) ? { cutTickMs } : {}),
    });

  if (
    generationByDb.vault === undefined ||
    generationByDb.journal === undefined
  ) {
    // Not a pair: nothing to coordinate. Unreachable from a real snapshot, but
    // direct callers use the planner single-sided.
    const plans = {} as Record<WalDbName, WalReplayPlan>;
    let reached = -1;
    for (const db of WAL_DB_NAMES) {
      const generation = generationByDb[db];
      plans[db] =
        generation === undefined ? EMPTY_PLAN : plan(db, generation, cut);
      reached = Math.max(reached, plans[db].lastTickMs);
    }
    return {
      plans,
      coordinatedCutMs: reached,
      newestMarkerTickMs: -1,
      coordinated: false,
    };
  }

  const generations = {
    vault: generationByDb.vault,
    journal: generationByDb.journal,
  };
  // Re-filter by generation even though restore LISTs a pair-scoped prefix:
  // positions are believed ABSOLUTELY, and a marker from another base pair
  // describes offsets into a different stream.
  const candidates = [...(opts.markers ?? [])]
    .filter(
      (m) =>
        m.vaultGeneration === generations.vault &&
        m.journalGeneration === generations.journal &&
        m.tickMs <= cut
    )
    .sort((a, b) => b.tickMs - a.tickMs);
  const newestMarkerTickMs = candidates[0]?.tickMs ?? -1;

  for (const marker of candidates) {
    const plans = {} as Record<WalDbName, WalReplayPlan>;
    let satisfied = true;
    for (const db of WAL_DB_NAMES) {
      const generation = generations[db];
      const candidate = plan(db, generation, marker.tickMs);
      // A hole before the marker's tick means broken, not merely short — the
      // recorded position cannot be trusted even if the arithmetic lines up.
      if (candidate.truncatedByHole) {
        satisfied = false;
        break;
      }
      const at = reachedPosition(candidate, listingByDb[db] ?? EMPTY_LISTING, {
        db,
        generation,
      });
      const want = marker[db];
      if (at.group !== want.group || at.endOffset !== want.endOffset) {
        satisfied = false;
        break;
      }
      plans[db] = candidate;
    }
    if (satisfied) {
      return {
        plans,
        coordinatedCutMs: marker.tickMs,
        newestMarkerTickMs,
        coordinated: true,
      };
    }
  }

  // Fall to the base pair: both bases were cloned in ONE tick, so this floor is
  // itself a coordinated instant.
  return {
    plans: { vault: EMPTY_PLAN, journal: EMPTY_PLAN },
    coordinatedCutMs: -1,
    newestMarkerTickMs,
    coordinated: true,
  };
}
