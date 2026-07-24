// governance: allow-repo-hygiene file-size-limit (#408) the WAL wire format is one normative unit — the key codecs, the sealing AAD/nonce derivations, the frame-boundary math, and the replay planner that consumes all three are a single argument about what a restore may trust; splitting them lets the format drift from the planner that enforces it
/*
 * WAL segment format (FORMAT.md § WAL segments — centraid-snapshot/2,
 * issue #408; carried unchanged into /2): addressing, sealing, frame-boundary
 * math, and replay planning for shipped SQLite write-ahead-log byte ranges.
 * /2's entropy-gated compression (#405 §1) deliberately does NOT reach these —
 * segments seal raw byte ranges so the address-bound deterministic-nonce
 * idempotency contract stays exactly as #408 shipped it (see FORMAT.md).
 *
 * A segment is a raw byte range `[startOffset, endOffset)` of a database's
 * `-wal` file, ending on a COMMIT-frame boundary, captured between
 * checkpoints the shipper alone performs (invariant I2). Committed WAL bytes
 * are immutable until a checkpoint, so concatenating a group's segments in
 * offset order reconstructs the exact WAL file bytes — restore writes them
 * back as `<db>-wal` and lets SQLite itself replay/validate them on open (we
 * never verify checksums or re-implement replay; G6's "damage degrades to an
 * earlier consistent state" is SQLite's own recovery behavior, not our code).
 *
 * Two hard-won rules encoded here (both discovered against the multi-writer
 * reality of journal.db — worker subprocesses open it by path):
 *
 * 1. Segments end on commit boundaries (`lastCommitBoundary`). UNCOMMITTED
 *    trailing frames are NOT append-only: a rollback rewinds SQLite's write
 *    position to the last commit and the next transaction OVERWRITES those
 *    bytes in place. Shipping them would fork the stream from the file.
 *    Finding the boundary is an 8-byte read per fixed-size frame header on
 *    bytes already in memory — boundary detection, not frame validation.
 *
 * 2. A checkpointed group is closed by an explicit, SEALED closer object
 *    recording the group's exact end offset. Group N+1's frames are full
 *    page images written against the state group N checkpointed, so
 *    replaying N+1 on top of a PARTIALLY-replayed N would mix page versions
 *    into a database that opens but may be subtly wrong. Replay therefore
 *    advances groups only through a closer whose end equals the chained
 *    offset — "group N fully present" is explicit, not inferred. The closer
 *    is authenticated (AAD-bound empty seal): a hostile provider can
 *    withhold objects (degrading restore to an earlier consistent state)
 *    but can never FABRICATE a closer that legitimizes a truncated group.
 *
 * This module is pure format: no fs, no sqlite. The capture side lives in
 * `@centraid/vault` (WalShipper), materialization in `wal-restore.ts`.
 */

import { decrypt, deriveNonce, encryptWithNonce } from './crypto.js';

/** The two shipped databases. Part of the format — object keys embed these names. */
export type WalDbName = 'vault' | 'journal';
export const WAL_DB_NAMES: readonly WalDbName[] = ['vault', 'journal'];

/**
 * The order the two databases MUST be cut in, at every cut: checkpoint,
 * capture, base clone. Journal FIRST — a gateway receipt commits to journal.db
 * only AFTER its vault.db transaction committed, so a journal cut taken before
 * the vault cut can never contain a receipt whose vault row is missing. The
 * reverse order manufactures dangling receipts.
 *
 * It exists as a NAMED constant because `WAL_DB_NAMES` is `['vault',
 * 'journal']` — the WRONG order — and any ordering-sensitive loop that reaches
 * for it is silently, invisibly wrong. Grep for this name before writing one.
 */
export const WAL_CAPTURE_ORDER: readonly WalDbName[] = ['journal', 'vault'];

/** `vault` ↔ `vault.db` (manifest entry path / on-disk file name). */
export const WAL_DB_FILES: Record<WalDbName, string> = {
  vault: 'vault.db',
  journal: 'journal.db',
};

export interface WalSegmentAddress {
  db: WalDbName;
  /** 32 hex chars, random per stream era — see `newWalGeneration`. */
  generation: string;
  /** 0-based, +1 per TRUNCATE checkpoint (group rollover). */
  group: number;
  /** Byte offset into the WAL file, inclusive. Frame-aligned (0 = includes the 32-byte WAL header). */
  startOffset: number;
  /** Byte offset, exclusive, on a commit boundary. Always > startOffset. */
  endOffset: number;
  /**
   * The capture tick (monotonicized wall-clock ms). Both databases' segments
   * from one tick share this value, and a coordinated restore cuts both at ONE
   * tick — but which tick that is is decided by the pair MARKER for that tick
   * (`WalPairMarker`), not by the segment listing: an absent segment is
   * indistinguishable from an absent write, and only the producer knows which.
   */
  tickMs: number;
}

/** Marks group `group` as checkpointed with exactly `endOffset` WAL bytes. */
export interface WalGroupCloser {
  db: WalDbName;
  generation: string;
  group: number;
  endOffset: number;
}

/** One database's shipped position at the end of a tick. */
export interface WalPairPosition {
  group: number;
  /** Bytes of `group` durably captured — 0 when the group has just opened. */
  endOffset: number;
}

/**
 * The end-of-tick pair marker: what BOTH databases had shipped at tick
 * `tickMs`, sealed by the shipper.
 *
 * It exists because a LISTING cannot answer the one question restore must
 * answer: is this database IDLE, or are its newest objects GONE? Both look
 * identical — a stream that simply ends. An idle vault must not hold a busy
 * journal back (that would silently discard a whole afternoon of history); a
 * vault whose tail was lost MUST hold the journal back (or the journal carries
 * receipts for vault rows the restore does not have). Only the producer knows
 * which, so the producer says so, once per tick in which anything moved, in an
 * object a hostile provider can withhold but never forge.
 *
 * Both generations live in the KEY (the manifest names both), so restore LISTs
 * exactly the markers valid for ITS base pair — already tick-ordered — and GC
 * decides from the key alone.
 */
export interface WalPairMarker {
  vaultGeneration: string;
  journalGeneration: string;
  tickMs: number;
  vault: WalPairPosition;
  journal: WalPairPosition;
}

const GENERATION_RE = /^[0-9a-f]{32}$/;

/**
 * Mint a WAL stream generation id: 128 random bits, hex. Random — not a
 * counter — following Litestream: a restored-then-rolled-back counter can
 * collide with its own past (the #116 `measurementEpoch` trap); 128 random
 * bits cannot.
 */
export function newWalGeneration(randomBytes: (n: number) => Uint8Array): string {
  return Buffer.from(randomBytes(16)).toString('hex');
}

export function isWalGeneration(value: string): boolean {
  return GENERATION_RE.test(value);
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/**
 * Segment: `wal/{db}/{generation}/{group:08}/{start:012}-{end:012}-{tick:013}`.
 * Closer:  `wal/{db}/{generation}/{group:08}/closed-{end:012}`.
 * Fixed-width decimal fields make lexicographic key order equal replay order
 * within a group, so a plain prefix LIST from the provider comes back
 * usefully sorted. The key alone carries the full address — restore planning
 * needs only a LIST plus one tiny authenticated read per closer.
 */
export function walSegmentKey(addr: WalSegmentAddress): string {
  assertValidAddress(addr);
  return (
    `wal/${addr.db}/${addr.generation}/${pad(addr.group, 8)}/` +
    `${pad(addr.startOffset, 12)}-${pad(addr.endOffset, 12)}-${pad(addr.tickMs, 13)}`
  );
}

/** The group-closer object key (see module header — closers gate group advance). */
export function walGroupCloserKey(closer: WalGroupCloser): string {
  assertValidCloser(closer);
  return `wal/${closer.db}/${closer.generation}/${pad(closer.group, 8)}/closed-${pad(closer.endOffset, 12)}`;
}

/** List prefix for one database's generation (or one group of it). */
export function walSegmentPrefix(db: WalDbName, generation: string, group?: number): string {
  if (!GENERATION_RE.test(generation)) throw new Error(`invalid wal generation "${generation}"`);
  const base = `wal/${db}/${generation}/`;
  return group === undefined ? base : `${base}${pad(group, 8)}/`;
}

/** List prefix for EVERY generation of one database (GC discovery). */
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

/** List prefix for one BASE PAIR's markers — the only ones a restore may use. */
export function walPairMarkerPrefix(vaultGeneration: string, journalGeneration: string): string {
  if (!GENERATION_RE.test(vaultGeneration) || !GENERATION_RE.test(journalGeneration)) {
    throw new Error(`invalid wal generation pair "${vaultGeneration}-${journalGeneration}"`);
  }
  return `wal/tick/${vaultGeneration}-${journalGeneration}/`;
}

/** List prefix for EVERY pair marker (GC discovery — the key names both generations). */
export function walPairMarkerRootPrefix(): string {
  return 'wal/tick/';
}

const SEGMENT_KEY_RE =
  /^wal\/(vault|journal)\/([0-9a-f]{32})\/(\d{8})\/(\d{12})-(\d{12})-(\d{13})$/;
const CLOSER_KEY_RE = /^wal\/(vault|journal)\/([0-9a-f]{32})\/(\d{8})\/closed-(\d{12})$/;
const PAIR_MARKER_KEY_RE = /^wal\/tick\/([0-9a-f]{32})-([0-9a-f]{32})\/(\d{13})$/;

/** The addressing fields of a pair marker — everything its key carries. */
export interface WalPairMarkerAddress {
  vaultGeneration: string;
  journalGeneration: string;
  tickMs: number;
}

/** Parse a pair-marker key. Returns null for keys that are not pair markers. */
export function parseWalPairMarkerKey(key: string): WalPairMarkerAddress | null {
  const m = PAIR_MARKER_KEY_RE.exec(key);
  if (!m) return null;
  return {
    vaultGeneration: m[1]!,
    journalGeneration: m[2]!,
    tickMs: Number.parseInt(m[3]!, 10),
  };
}

/** Parse a segment key. Returns null for keys that are not WAL segments. */
export function parseWalSegmentKey(key: string): WalSegmentAddress | null {
  const m = SEGMENT_KEY_RE.exec(key);
  if (!m) return null;
  const addr: WalSegmentAddress = {
    db: m[1] as WalDbName,
    generation: m[2]!,
    group: Number.parseInt(m[3]!, 10),
    startOffset: Number.parseInt(m[4]!, 10),
    endOffset: Number.parseInt(m[5]!, 10),
    tickMs: Number.parseInt(m[6]!, 10),
  };
  return addr.endOffset > addr.startOffset ? addr : null;
}

/** Parse a group-closer key. Returns null for keys that are not closers. */
export function parseWalCloserKey(key: string): WalGroupCloser | null {
  const m = CLOSER_KEY_RE.exec(key);
  if (!m) return null;
  return {
    db: m[1] as WalDbName,
    generation: m[2]!,
    group: Number.parseInt(m[3]!, 10),
    endOffset: Number.parseInt(m[4]!, 10),
  };
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
    throw new Error(`invalid wal segment range ${addr.startOffset}-${addr.endOffset}`);
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
  if (!GENERATION_RE.test(addr.vaultGeneration) || !GENERATION_RE.test(addr.journalGeneration)) {
    throw new Error(
      `invalid wal generation pair "${addr.vaultGeneration}-${addr.journalGeneration}"`,
    );
  }
  if (!Number.isInteger(addr.tickMs) || addr.tickMs < 0) {
    throw new Error(`invalid wal pair marker tick ${addr.tickMs}`);
  }
}

function assertValidPosition(pos: WalPairPosition, db: WalDbName): void {
  if (!Number.isInteger(pos.group) || pos.group < 0) {
    throw new Error(`invalid ${db} marker group ${pos.group}`);
  }
  if (!Number.isInteger(pos.endOffset) || pos.endOffset < 0) {
    throw new Error(`invalid ${db} marker offset ${pos.endOffset}`);
  }
}

// ---------------------------------------------------------------------------
// WAL frame-boundary math (SQLite WAL file format, sqlite.org/walformat.html)
// ---------------------------------------------------------------------------
// #532 property/mutation ownership is the addressing surface above (keys +
// parsers). Frame math, seal/open, and replay planning keep unit/contract
// coverage via wal-format.test.ts — not the property mutate set.
// Stryker disable all

export const WAL_HEADER_BYTES = 32;
const FRAME_HEADER_BYTES = 24;

/** Read the page size from a WAL file header (bytes 8..12, big-endian). */
export function walPageSize(header: Uint8Array): number {
  if (header.length < WAL_HEADER_BYTES) throw new Error('wal header truncated');
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
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

/** WAL salts (header bytes 16/20) — the G5 foreign-checkpoint detector reads these. */
export function walSalts(header: Uint8Array): { salt1: number; salt2: number } {
  if (header.length < WAL_HEADER_BYTES) throw new Error('wal header truncated');
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  return { salt1: view.getUint32(16), salt2: view.getUint32(20) };
}

/**
 * The largest commit-frame boundary within `[baseOffset, baseOffset + bytes.length)`.
 *
 * `bytes` are the WAL file's bytes starting at `baseOffset`, which must be
 * frame-aligned (0, or a previous commit boundary). A frame is
 * `24-byte header || page`, and a commit frame has a non-zero "database size
 * after commit" field at header bytes 4..8. Returns `baseOffset` itself when
 * no commit frame completes in the range (nothing safe to ship yet).
 *
 * This is the ONLY frame-level knowledge in the whole feature, and it exists
 * because journal.db has out-of-process writers: their uncommitted tails are
 * not append-only (rollback + rewrite overwrites them in place), so shipping
 * past the last commit would fork the shipped stream from the real file.
 */
export function lastCommitBoundary(
  bytes: Uint8Array,
  baseOffset: number,
  pageSize: number,
): number {
  const frameBytes = FRAME_HEADER_BYTES + pageSize;
  // Frames start after the 32-byte WAL header; our ranges start at 0 (header
  // included) or at a prior commit boundary, so within `bytes` the first
  // frame header sits at 32 (when baseOffset is 0) or at 0.
  if (baseOffset !== 0 && (baseOffset - WAL_HEADER_BYTES) % frameBytes !== 0) {
    throw new Error(`wal offset ${baseOffset} is not frame-aligned for page size ${pageSize}`);
  }
  let at = baseOffset === 0 ? WAL_HEADER_BYTES : 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let lastCommitEnd = baseOffset; // no commit in range ⇒ empty range, ship nothing
  while (at + frameBytes <= bytes.length) {
    const dbSizeAfterCommit = view.getUint32(at + 4);
    at += frameBytes;
    if (dbSizeAfterCommit !== 0) lastCommitEnd = baseOffset + at;
  }
  return lastCommitEnd;
}

export interface WalPrefixScan {
  pageSize: number;
  /** End of the last frame whose salts and rolling checksum validate. */
  validEndOffset: number;
  /** End of the last validated commit frame. */
  lastCommitOffset: number;
}

function checksumRange(
  bytes: Uint8Array,
  start: number,
  end: number,
  littleEndian: boolean,
  seed: { s1: number; s2: number },
): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = start; at < end; at += 8) {
    seed.s1 = (seed.s1 + view.getUint32(at, littleEndian) + seed.s2) >>> 0;
    seed.s2 = (seed.s2 + view.getUint32(at + 4, littleEndian) + seed.s1) >>> 0;
  }
}

/**
 * Validate SQLite's rolling WAL checksums and salts over the available prefix.
 * A partial/torn tail is reported by `validEndOffset`; corruption in an object
 * being restored is rejected by `validateCommittedWal` below.
 */
export function scanWalPrefix(bytes: Uint8Array): WalPrefixScan {
  if (bytes.length < WAL_HEADER_BYTES) throw new Error('wal header truncated');
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
    throw new Error('wal header checksum mismatch');
  }
  const salt1 = view.getUint32(16);
  const salt2 = view.getUint32(20);
  const frameBytes = FRAME_HEADER_BYTES + pageSize;
  let at = WAL_HEADER_BYTES;
  let validEndOffset = WAL_HEADER_BYTES;
  let lastCommitOffset = 0;
  while (at + frameBytes <= bytes.length) {
    if (view.getUint32(at + 8) !== salt1 || view.getUint32(at + 12) !== salt2) break;
    checksumRange(bytes, at, at + 8, littleEndian, seed);
    checksumRange(bytes, at + FRAME_HEADER_BYTES, at + frameBytes, littleEndian, seed);
    if (seed.s1 !== view.getUint32(at + 16) || seed.s2 !== view.getUint32(at + 20)) break;
    at += frameBytes;
    validEndOffset = at;
    if (view.getUint32(at - frameBytes + 4) !== 0) lastCommitOffset = at;
  }
  return { pageSize, validEndOffset, lastCommitOffset };
}

/** A shipped WAL object/group must be a complete, checksum-valid commit prefix. */
export function validateCommittedWal(bytes: Uint8Array): WalPrefixScan {
  const scan = scanWalPrefix(bytes);
  if (scan.validEndOffset !== bytes.length) {
    throw new Error(
      `wal frame checksum/salt mismatch at offset ${scan.validEndOffset} (length ${bytes.length})`,
    );
  }
  if (scan.lastCommitOffset !== bytes.length) {
    throw new Error('wal bytes do not end at a commit boundary');
  }
  return scan;
}

// ---------------------------------------------------------------------------
// Sealing — deterministic nonce + full-address AAD (FORMAT.md § Encryption).
// ---------------------------------------------------------------------------

function nonceInfo(addr: WalSegmentAddress): string {
  // Derived from the FULL address — every field of the object key, tickMs
  // included. The tuple is injective over everything sealed under one
  // dataKey: offsets are monotonic within a group (committed WAL bytes are
  // append-only under I2), groups within a generation, generations random.
  //
  // `endOffset` is load-bearing: a crash between segment-fsync and
  // offset-fsync makes the retry re-read a possibly LONGER range from the
  // same start; without `end` that retry would reuse the nonce on different
  // plaintext (GCM's one fatal sin).
  //
  // `tickMs` is load-bearing for the same reason it is in the AAD (see
  // below) — nonce and AAD must both cover the whole address or the seal
  // stops being a statement about THIS object key. It costs nothing: the
  // idempotent-PUT property (G7) is about re-uploading the SAME local
  // segment file after a failed PUT, and that file's NAME is the object
  // key's basename (WalShipper.capture writes `${basename(walSegmentKey)}.seg`;
  // drainWalFiles parses the address straight back out of it). A re-seal
  // therefore re-derives the identical address — identical nonce, identical
  // bytes. A retry that stamps a DIFFERENT tick was never byte-identical
  // anyway: it already lands on a different object key.
  return `centraid-backup:wal-nonce:${addr.db}:${addr.generation}:${addr.group}:${addr.startOffset}:${addr.endOffset}:${addr.tickMs}`;
}

function segmentAad(vaultId: string, addr: WalSegmentAddress): Uint8Array {
  // Binds the ciphertext to its full address (and vault): a provider that
  // swaps two segment objects — same sizes, valid seals — fails the tag
  // check instead of feeding SQLite mixed WAL bytes.
  //
  // `tickMs` MUST be here: it is in the object key, restore parses it back
  // out of the key, and it alone decides point-in-time cuts (planWalReplay
  // stops at the first `tickMs > cut`) and the coordinated two-db cut (G8).
  // Unbound, a hostile provider could copy a sealed segment to a key bearing
  // a FORGED tick and it would still authenticate — a "restore to T" would
  // then apply bytes captured well after T (relabel a late segment early),
  // and the two databases could be cut at different real instants while both
  // plans claim the same tick. The tag must cover every field the planner
  // trusts.
  return new Uint8Array(
    Buffer.from(
      `centraid-wal/1:${vaultId}:${addr.db}:${addr.generation}:${addr.group}:${addr.startOffset}:${addr.endOffset}:${addr.tickMs}`,
      'utf8',
    ),
  );
}

/** Seal WAL bytes for upload. Deterministic: same address + bytes ⇒ same object. */
export function sealWalSegment(
  dataKey: Uint8Array,
  vaultId: string,
  addr: WalSegmentAddress,
  plain: Uint8Array,
): Uint8Array {
  assertValidAddress(addr);
  if (plain.length !== addr.endOffset - addr.startOffset) {
    throw new Error(
      `sealWalSegment: ${plain.length} bytes for range ${addr.startOffset}-${addr.endOffset}`,
    );
  }
  const nonce = deriveNonce(dataKey, nonceInfo(addr));
  return encryptWithNonce(dataKey, nonce, plain, segmentAad(vaultId, addr));
}

/** Unseal a segment object. Throws on any tampering, truncation, or address swap. */
export function openWalSegment(
  dataKey: Uint8Array,
  vaultId: string,
  addr: WalSegmentAddress,
  sealed: Uint8Array,
): Uint8Array {
  const plain = decrypt(dataKey, sealed, segmentAad(vaultId, addr));
  if (plain.length !== addr.endOffset - addr.startOffset) {
    throw new Error(
      `openWalSegment: ${plain.length} bytes for range ${addr.startOffset}-${addr.endOffset}`,
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
      'utf8',
    ),
  );
}

/**
 * Seal a group closer: an empty payload whose GCM tag (over the AAD-bound
 * address) is the whole point — it proves the SHIPPER, not the provider,
 * asserted "group {group} ends at exactly {endOffset}".
 */
export function sealWalCloser(
  dataKey: Uint8Array,
  vaultId: string,
  closer: WalGroupCloser,
): Uint8Array {
  assertValidCloser(closer);
  const nonce = deriveNonce(dataKey, closerNonceInfo(closer));
  return encryptWithNonce(dataKey, nonce, new Uint8Array(0), closerAad(vaultId, closer));
}

/** Verify a closer object. Throws on tampering or address swap. */
export function openWalCloser(
  dataKey: Uint8Array,
  vaultId: string,
  closer: WalGroupCloser,
  sealed: Uint8Array,
): void {
  const plain = decrypt(dataKey, sealed, closerAad(vaultId, closer));
  if (plain.length !== 0) throw new Error('openWalCloser: unexpected payload');
}

function pairNonceInfo(addr: WalPairMarkerAddress): string {
  return `centraid-backup:wal-nonce:tick:${addr.vaultGeneration}:${addr.journalGeneration}:${addr.tickMs}`;
}

function pairAad(vaultId: string, addr: WalPairMarkerAddress): Uint8Array {
  // Every field of the key, `tick` included — for the same reason segments
  // bind theirs: the tick alone decides which marker a point-in-time restore
  // selects, so a provider that could relabel one could make restore trust a
  // LATER pair position at an EARLIER tick and cut both databases past a
  // segment the vault never actually reached.
  return new Uint8Array(
    Buffer.from(
      `centraid-wal/1:${vaultId}:tick:${addr.vaultGeneration}:${addr.journalGeneration}:${addr.tickMs}`,
      'utf8',
    ),
  );
}

/**
 * The marker's plaintext. Hand-built in a FIXED field order (not
 * `JSON.stringify` over a computed object) so a re-seal of the same logical
 * marker is byte-identical: the nonce is deterministic over the address, so
 * two DIFFERENT payloads under one address would reuse a (key, nonce) pair —
 * GCM's one fatal sin. The producer therefore writes each (vg, jg, tick)
 * exactly once, and this encoding makes an honest retry converge.
 */
function pairPayload(marker: WalPairMarker): Uint8Array {
  const pos = (p: WalPairPosition): string => `{"endOffset":${p.endOffset},"group":${p.group}}`;
  return new TextEncoder().encode(
    `{"journal":${pos(marker.journal)},"tickMs":${marker.tickMs},"v":1,"vault":${pos(marker.vault)}}`,
  );
}

/** Seal a pair marker. Deterministic: same address + positions ⇒ same object. */
export function sealWalPairMarker(
  dataKey: Uint8Array,
  vaultId: string,
  marker: WalPairMarker,
): Uint8Array {
  assertValidPairAddress(marker);
  assertValidPosition(marker.vault, 'vault');
  assertValidPosition(marker.journal, 'journal');
  const nonce = deriveNonce(dataKey, pairNonceInfo(marker));
  return encryptWithNonce(dataKey, nonce, pairPayload(marker), pairAad(vaultId, marker));
}

/**
 * Unseal a pair marker against the address parsed from its KEY. Throws on
 * tampering, on a marker moved to another key (AAD), and on a payload whose
 * own `tickMs` disagrees with the key — belt and braces over the AAD, because
 * everything downstream trusts these positions absolutely.
 */
export function openWalPairMarker(
  dataKey: Uint8Array,
  vaultId: string,
  addr: WalPairMarkerAddress,
  sealed: Uint8Array,
): WalPairMarker {
  const plain = decrypt(dataKey, sealed, pairAad(vaultId, addr));
  const parsed = JSON.parse(new TextDecoder().decode(plain)) as {
    v?: number;
    tickMs?: number;
    vault?: WalPairPosition;
    journal?: WalPairPosition;
  };
  if (parsed.v !== 1) throw new Error(`openWalPairMarker: unknown payload version ${parsed.v}`);
  if (parsed.tickMs !== addr.tickMs) {
    throw new Error(
      `openWalPairMarker: payload tick ${parsed.tickMs} disagrees with key tick ${addr.tickMs}`,
    );
  }
  if (!parsed.vault || !parsed.journal) throw new Error('openWalPairMarker: missing positions');
  const marker: WalPairMarker = {
    vaultGeneration: addr.vaultGeneration,
    journalGeneration: addr.journalGeneration,
    tickMs: addr.tickMs,
    vault: { group: parsed.vault.group, endOffset: parsed.vault.endOffset },
    journal: { group: parsed.journal.group, endOffset: parsed.journal.endOffset },
  };
  assertValidPosition(marker.vault, 'vault');
  assertValidPosition(marker.journal, 'journal');
  return marker;
}

// ---------------------------------------------------------------------------
// Replay planning
// ---------------------------------------------------------------------------

export interface WalReplayPlan {
  /** Segments in replay order (group asc, offset asc), already cut. */
  segments: WalSegmentAddress[];
  /** Tick of the last planned segment; -1 when nothing is applicable. */
  lastTickMs: number;
  /**
   * True when the plan stopped early at a hole — a missing/unchainable
   * segment or an unclosed group with a successor — rather than at the
   * caller's requested cut.
   *
   * It is NOT the coordination signal, and treating it as one is the bug this
   * revision exists to close: a stream whose NEWEST objects are gone has no
   * hole at all (the listing simply ends), and a stream whose objects are ALL
   * gone lists nothing, so the loop that computes this flag never even runs.
   * Coordination is decided by pair markers (`planCoordinatedReplay`); this
   * flag only says "this single chain is broken before the cut you asked for",
   * which makes a candidate marker unsatisfiable.
   */
  truncatedByHole: boolean;
}

/** The planner's LIST-derived input for one database. */
export interface WalStreamListing {
  segments: WalSegmentAddress[];
  /** Only closers that AUTHENTICATED (openWalCloser) may be passed here. */
  closers: WalGroupCloser[];
}

/**
 * Order + chain one database's listed segments into a replayable prefix.
 *
 * Rules (each load-bearing):
 * - Groups replay in ascending order, consecutively from 0. Advancing to
 *   group N+1 requires group N chained EXACTLY to its authenticated
 *   closer's end offset — group N+1's frames are page images layered on
 *   group N's checkpointed state, so applying them over a partial N would
 *   mix page versions. No closer (or a chain short of it) ⇒ the group is
 *   the plan's dead end.
 * - Within a group, segments chain gaplessly from offset 0 (the first
 *   segment carries the 32-byte WAL header). Duplicate starts keep the
 *   longest range — committed byte ranges are prefix-compatible, so the
 *   longer strictly contains the shorter. A segment that would chain PAST
 *   the group's closer end is a producer anomaly: stop, never mix.
 * - `cutTickMs`: the plan stops BEFORE the first segment with a later tick
 *   (point-in-time restore). Stopping mid-group is always consistent — it
 *   is a historical state of that WAL.
 */
export function planWalReplay(
  listing: WalStreamListing,
  opts: { generation: string; db: WalDbName; cutTickMs?: number },
): WalReplayPlan {
  const cut = opts.cutTickMs ?? Number.POSITIVE_INFINITY;
  const relevant = listing.segments
    // Filter by PITR eligibility BEFORE resolving duplicate starts. A longer
    // retry captured after the requested instant must not hide a shorter
    // same-start segment that was already durable at the cut.
    .filter((s) => s.db === opts.db && s.generation === opts.generation && s.tickMs <= cut)
    .sort(
      (a, b) => a.group - b.group || a.startOffset - b.startOffset || b.endOffset - a.endOffset,
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
        if (seg.endOffset <= offset) continue; // stale shorter duplicate — skip
        hole = true; // overlapping-but-extending never happens post-hygiene
        break;
      }
      if (seg.startOffset > offset) {
        hole = true;
        break;
      }
      const end = closedAt();
      if (end !== undefined && seg.endOffset > end) {
        // Chains past the authenticated group end: producer anomaly.
        hole = true;
        break;
      }
      planned.push(seg);
      offset = seg.endOffset;
    } else if (seg.group === group + 1 && closedAt() === offset && seg.startOffset === 0) {
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
const EMPTY_PLAN: WalReplayPlan = { segments: [], lastTickMs: -1, truncatedByHole: false };

/**
 * The `(group, endOffset)` a planned chain actually REACHES — the quantity a
 * pair marker records, so the two are comparable.
 *
 * The normalization is the whole point: a chain that ends exactly at group N's
 * AUTHENTICATED closer has finished N, so its position is `(N+1, 0)` — the
 * same thing the shipper's state says after a rollover. A chain that ends at
 * the same offset with the closer MISSING is only `(N, end)`, and therefore
 * fails to satisfy a marker that says `(N+1, 0)`. That is how a lost TAIL
 * CLOSER becomes detectable at all: nothing else in the format distinguishes
 * "group N ended here and we moved on" from "group N is where the stream ran
 * out", because a closed final group has no successor segments to prove it.
 */
export function reachedPosition(
  plan: WalReplayPlan,
  listing: WalStreamListing,
  opts: { db: WalDbName; generation: string },
): WalPairPosition {
  const last = plan.segments[plan.segments.length - 1];
  // No planned segment ⇒ the base itself, which is always group 0, offset 0.
  // (A group only ever advances past 0 after shipping bytes into it, so a db
  // at group > 0 necessarily has group-0 segments a cut this early excludes.)
  if (!last) return { group: 0, endOffset: 0 };
  const closed = listing.closers.some(
    (c) =>
      c.db === opts.db &&
      c.generation === opts.generation &&
      c.group === last.group &&
      c.endOffset === last.endOffset,
  );
  return closed
    ? { group: last.group + 1, endOffset: 0 }
    : { group: last.group, endOffset: last.endOffset };
}

/** What `planCoordinatedReplay` decided, and how far short of the tip it fell. */
export interface CoordinatedReplayResult {
  plans: Record<WalDbName, WalReplayPlan>;
  /**
   * The single tick BOTH databases were cut at; -1 when the pair degraded to
   * the base floor (which, the bases being from one tick, is itself a
   * coordinated instant).
   */
  coordinatedCutMs: number;
  /**
   * The newest pair marker at or before the requested cut; -1 when none
   * exists. `coordinatedCutMs < newestMarkerTickMs` is the real "the tip is
   * NOT restorable" signal — objects the producer proved it shipped cannot be
   * reassembled.
   */
  newestMarkerTickMs: number;
  /** False when only one database has a generation — no pair, nothing to coordinate. */
  coordinated: boolean;
}

/**
 * The coordinated two-database cut (G8), driven by authenticated pair markers.
 *
 * Walk the markers at or before `cutTickMs`, newest first, and take the first
 * one BOTH databases can PROVE they reached: their listed segments must chain
 * hole-free to exactly the position the marker records. The first satisfiable
 * marker is the cut; if none is, the pair degrades to its bases — coherent by
 * construction, because the producer mints both bases in one tick.
 *
 * Why a marker and not the listing: a listing cannot distinguish an IDLE
 * database from one whose newest objects were LOST. Both simply end. Cutting
 * to "the smaller reached tick" regresses the idle vault (a quiet afternoon
 * would discard every journal write); trusting each database's own tip lets a
 * lost vault tail hand back a journal two ticks ahead of it, carrying receipts
 * for rows that are not there. The marker is the producer stating, per tick,
 * which of the two it is — and the GCM tag is why a provider cannot lie about
 * it. (A provider CAN withhold the newest markers along with the newest
 * segments and roll the restore back in time; that is a G6 degradation, not
 * corruption, and freshness signals — not the format — are its defense.)
 */
export function planCoordinatedReplay(opts: {
  listingByDb: Partial<Record<WalDbName, WalStreamListing>>;
  generationByDb: Partial<Record<WalDbName, string>>;
  /** Markers for EXACTLY this base pair, already authenticated. Order irrelevant. */
  markers?: readonly WalPairMarker[];
  cutTickMs?: number;
}): CoordinatedReplayResult {
  const { listingByDb, generationByDb } = opts;
  const cut = opts.cutTickMs ?? Number.POSITIVE_INFINITY;
  const plan = (db: WalDbName, generation: string, cutTickMs: number): WalReplayPlan =>
    planWalReplay(listingByDb[db] ?? EMPTY_LISTING, {
      db,
      generation,
      ...(Number.isFinite(cutTickMs) ? { cutTickMs } : {}),
    });

  if (generationByDb.vault === undefined || generationByDb.journal === undefined) {
    // Not a pair: one database (or neither) has a stream, so there is nothing
    // to coordinate and no marker to consult. Unreachable from a real /1
    // snapshot — the producer refuses to register a manifest without both db
    // entries, and `restoreSnapshot` refuses one that lacks them — but the
    // planner is a pure function and direct callers (unit tests, tooling) use
    // it single-sided.
    const plans = {} as Record<WalDbName, WalReplayPlan>;
    let reached = -1;
    for (const db of WAL_DB_NAMES) {
      const generation = generationByDb[db];
      plans[db] = generation === undefined ? EMPTY_PLAN : plan(db, generation, cut);
      reached = Math.max(reached, plans[db].lastTickMs);
    }
    return { plans, coordinatedCutMs: reached, newestMarkerTickMs: -1, coordinated: false };
  }

  const generations = { vault: generationByDb.vault, journal: generationByDb.journal };
  // Re-filter by generation even though the restore LISTs a pair-scoped prefix
  // and cannot see a foreign marker: a marker's positions are believed
  // ABSOLUTELY, and one minted under a different base pair describes offsets
  // into a different stream. If those numbers ever coincided with this pair's,
  // the cut would over-reach — past segments this vault never shipped. The
  // planner is not going to take the caller's word for which markers are its
  // own.
  const candidates = [...(opts.markers ?? [])]
    .filter(
      (m) =>
        m.vaultGeneration === generations.vault &&
        m.journalGeneration === generations.journal &&
        m.tickMs <= cut,
    )
    .sort((a, b) => b.tickMs - a.tickMs);
  const newestMarkerTickMs = candidates[0]?.tickMs ?? -1;

  for (const marker of candidates) {
    const plans = {} as Record<WalDbName, WalReplayPlan>;
    let satisfied = true;
    for (const db of WAL_DB_NAMES) {
      const generation = generations[db];
      const candidate = plan(db, generation, marker.tickMs);
      // A hole BEFORE the marker's tick means this chain is broken, not merely
      // short — and a broken chain can never be trusted to have reached the
      // recorded position even if the arithmetic happened to line up.
      if (candidate.truncatedByHole) {
        satisfied = false;
        break;
      }
      const at = reachedPosition(candidate, listingByDb[db] ?? EMPTY_LISTING, { db, generation });
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

  // No marker is satisfiable (or none exists at all): the base pair. Both
  // bases were cloned in ONE tick, so this floor is itself a coordinated
  // instant — which is exactly why degradation always has somewhere safe to
  // land, and why coordinated breaks are load-bearing even though they cannot
  // close the lost-tail case alone.
  return {
    plans: { vault: EMPTY_PLAN, journal: EMPTY_PLAN },
    coordinatedCutMs: -1,
    newestMarkerTickMs,
    coordinated: true,
  };
}
