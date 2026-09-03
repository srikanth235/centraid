// governance: allow-repo-hygiene file-size-limit (#408) the WAL wire format is one normative unit — the key codecs, the sealing AAD/nonce derivations, the frame-boundary math, and the replay planner that consumes all three are a single argument about what a restore may trust; splitting them lets the format drift from the planner that enforces it

import { decrypt, deriveNonce, encryptWithNonce } from "./crypto.js";

export type WalDbName = "vault";

export const WAL_DB_FILES: Record<WalDbName, string> = { vault: "vault.db" };

export interface WalSegmentAddress {
  db: WalDbName;
  generation: string;
  group: number;
  startOffset: number;
  endOffset: number;
  tickMs: number;
}

export interface WalGroupCloser {
  db: WalDbName;
  generation: string;
  group: number;
  endOffset: number;
}

export interface WalStreamPosition {
  group: number;
  endOffset: number;
}

export interface WalTickMarker {
  generation: string;
  tickMs: number;
  position: WalStreamPosition;
}

const GENERATION_RE = /^[0-9a-f]{32}$/u;

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

export function walSegmentKey(addr: WalSegmentAddress): string {
  assertValidAddress(addr);
  return (
    `wal/${addr.db}/${addr.generation}/${pad(addr.group, 8)}/` +
    `${pad(addr.startOffset, 12)}-${pad(addr.endOffset, 12)}-${pad(addr.tickMs, 13)}`
  );
}

export function walGroupCloserKey(closer: WalGroupCloser): string {
  assertValidCloser(closer);
  return `wal/${closer.db}/${closer.generation}/${pad(closer.group, 8)}/closed-${pad(closer.endOffset, 12)}`;
}

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

export function walDbPrefix(db: WalDbName): string {
  return `wal/${db}/`;
}

export function walTickMarkerKey(addr: WalTickMarkerAddress): string {
  assertValidTickAddress(addr);
  return `${walTickMarkerPrefix(addr.generation)}${pad(addr.tickMs, 13)}`;
}

export function walTickMarkerPrefix(generation: string): string {
  if (!GENERATION_RE.test(generation))
    throw new Error(`invalid wal generation "${generation}"`);
  return `wal/tick/${generation}/`;
}

export function walTickMarkerRootPrefix(): string {
  return "wal/tick/";
}

const SEGMENT_KEY_RE =
  /^wal\/(?<db>vault)\/(?<generation>[0-9a-f]{32})\/(?<group>\d{8})\/(?<startOffset>\d{12})-(?<endOffset>\d{12})-(?<tickMs>\d{13})$/u;
const CLOSER_KEY_RE =
  /^wal\/(?<db>vault)\/(?<generation>[0-9a-f]{32})\/(?<group>\d{8})\/closed-(?<endOffset>\d{12})$/u;
const TICK_MARKER_KEY_RE =
  /^wal\/tick\/(?<generation>[0-9a-f]{32})\/(?<tickMs>\d{13})$/u;

export interface WalTickMarkerAddress {
  generation: string;
  tickMs: number;
}

export function parseWalTickMarkerKey(
  key: string
): WalTickMarkerAddress | null {
  const m = TICK_MARKER_KEY_RE.exec(key);
  if (!m) return null;
  const g = m.groups!;
  return {
    generation: g.generation!,
    tickMs: Math.trunc(Number(g.tickMs!)),
  };
}

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

function assertValidTickAddress(addr: WalTickMarkerAddress): void {
  if (!GENERATION_RE.test(addr.generation)) {
    throw new Error(`invalid wal generation "${addr.generation}"`);
  }
  if (!Number.isInteger(addr.tickMs) || addr.tickMs < 0) {
    throw new Error(`invalid wal tick marker tick ${addr.tickMs}`);
  }
}

function assertValidPosition(pos: WalStreamPosition): void {
  if (!Number.isInteger(pos.group) || pos.group < 0) {
    throw new Error(`invalid marker group ${pos.group}`);
  }
  if (!Number.isInteger(pos.endOffset) || pos.endOffset < 0) {
    throw new Error(`invalid marker offset ${pos.endOffset}`);
  }
}

export const WAL_HEADER_BYTES = 32;
const FRAME_HEADER_BYTES = 24;

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

export function walSalts(header: Uint8Array): { salt1: number; salt2: number } {
  if (header.length < WAL_HEADER_BYTES) throw new Error("wal header truncated");
  const view = new DataView(
    header.buffer,
    header.byteOffset,
    header.byteLength
  );
  return { salt1: view.getUint32(16), salt2: view.getUint32(20) };
}

export function lastCommitBoundary(
  bytes: Uint8Array,
  baseOffset: number,
  pageSize: number
): number {
  const frameBytes = FRAME_HEADER_BYTES + pageSize;
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
  validEndOffset: number;
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

function nonceInfo(addr: WalSegmentAddress): string {
  return `centraid-backup:wal-nonce:${addr.db}:${addr.generation}:${addr.group}:${addr.startOffset}:${addr.endOffset}:${addr.tickMs}`;
}

function segmentAad(vaultId: string, addr: WalSegmentAddress): Uint8Array {
  return new Uint8Array(
    Buffer.from(
      `centraid-wal/1:${vaultId}:${addr.db}:${addr.generation}:${addr.group}:${addr.startOffset}:${addr.endOffset}:${addr.tickMs}`,
      "utf8"
    )
  );
}

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

export function openWalCloser(
  dataKey: Uint8Array,
  vaultId: string,
  closer: WalGroupCloser,
  sealed: Uint8Array
): void {
  const plain = decrypt(dataKey, sealed, closerAad(vaultId, closer));
  if (plain.length !== 0) throw new Error("openWalCloser: unexpected payload");
}

function tickNonceInfo(addr: WalTickMarkerAddress): string {
  return `centraid-backup:wal-nonce:tick:${addr.generation}:${addr.tickMs}`;
}

function tickAad(vaultId: string, addr: WalTickMarkerAddress): Uint8Array {
  return new Uint8Array(
    Buffer.from(
      `centraid-wal/1:${vaultId}:tick:${addr.generation}:${addr.tickMs}`,
      "utf8"
    )
  );
}

function tickPayload(marker: WalTickMarker): Uint8Array {
  return new TextEncoder().encode(
    `{"position":{"endOffset":${marker.position.endOffset},"group":${marker.position.group}},"tickMs":${marker.tickMs},"v":1}`
  );
}

export function sealWalTickMarker(
  dataKey: Uint8Array,
  vaultId: string,
  marker: WalTickMarker
): Uint8Array {
  assertValidTickAddress(marker);
  assertValidPosition(marker.position);
  const nonce = deriveNonce(dataKey, tickNonceInfo(marker));
  return encryptWithNonce(
    dataKey,
    nonce,
    tickPayload(marker),
    tickAad(vaultId, marker)
  );
}

export function openWalTickMarker(
  dataKey: Uint8Array,
  vaultId: string,
  addr: WalTickMarkerAddress,
  sealed: Uint8Array
): WalTickMarker {
  const plain = decrypt(dataKey, sealed, tickAad(vaultId, addr));
  const parsed = JSON.parse(new TextDecoder().decode(plain)) as {
    v?: number;
    tickMs?: number;
    position?: WalStreamPosition;
  };
  if (parsed.v !== 1)
    throw new Error(`openWalTickMarker: unknown payload version ${parsed.v}`);
  if (parsed.tickMs !== addr.tickMs) {
    throw new Error(
      `openWalTickMarker: payload tick ${parsed.tickMs} disagrees with key tick ${addr.tickMs}`
    );
  }
  if (!parsed.position) throw new Error("openWalTickMarker: missing position");
  const marker: WalTickMarker = {
    generation: addr.generation,
    tickMs: addr.tickMs,
    position: {
      group: parsed.position.group,
      endOffset: parsed.position.endOffset,
    },
  };
  assertValidPosition(marker.position);
  return marker;
}

export interface WalReplayPlan {
  segments: WalSegmentAddress[];
  lastTickMs: number;
  truncatedByHole: boolean;
}

export interface WalStreamListing {
  segments: WalSegmentAddress[];
  closers: WalGroupCloser[];
}

export function planWalReplay(
  listing: WalStreamListing,
  opts: { generation: string; cutTickMs?: number }
): WalReplayPlan {
  const cut = opts.cutTickMs ?? Number.POSITIVE_INFINITY;
  const relevant = listing.segments
    .filter((s) => s.generation === opts.generation && s.tickMs <= cut)
    .sort(
      (a, b) =>
        a.group - b.group ||
        a.startOffset - b.startOffset ||
        b.endOffset - a.endOffset
    );
  const closerEnd = new Map<number, number>();
  for (const c of listing.closers) {
    if (c.generation === opts.generation) closerEnd.set(c.group, c.endOffset);
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

const EMPTY_PLAN: WalReplayPlan = {
  segments: [],
  lastTickMs: -1,
  truncatedByHole: false,
};

export function reachedPosition(
  plan: WalReplayPlan,
  listing: WalStreamListing,
  opts: { generation: string }
): WalStreamPosition {
  const last = plan.segments[plan.segments.length - 1];
  if (!last) return { group: 0, endOffset: 0 };
  const closed = listing.closers.some(
    (c) =>
      c.generation === opts.generation &&
      c.group === last.group &&
      c.endOffset === last.endOffset
  );
  return closed
    ? { group: last.group + 1, endOffset: 0 }
    : { group: last.group, endOffset: last.endOffset };
}

export interface MarkedReplayResult {
  plan: WalReplayPlan;
  cutTickMs: number;
  newestMarkerTickMs: number;
}

export function planMarkedReplay(opts: {
  listing: WalStreamListing;
  generation: string;
  markers?: readonly WalTickMarker[];
  cutTickMs?: number;
}): MarkedReplayResult {
  const cut = opts.cutTickMs ?? Number.POSITIVE_INFINITY;
  const candidates = [...(opts.markers ?? [])]
    .filter((m) => m.generation === opts.generation && m.tickMs <= cut)
    .sort((a, b) => b.tickMs - a.tickMs);
  const newestMarkerTickMs = candidates[0]?.tickMs ?? -1;

  for (const marker of candidates) {
    const plan = planWalReplay(opts.listing, {
      generation: opts.generation,
      cutTickMs: marker.tickMs,
    });
    if (plan.truncatedByHole) continue;
    const at = reachedPosition(plan, opts.listing, {
      generation: opts.generation,
    });
    if (
      at.group === marker.position.group &&
      at.endOffset === marker.position.endOffset
    ) {
      return { plan, cutTickMs: marker.tickMs, newestMarkerTickMs };
    }
  }

  return { plan: EMPTY_PLAN, cutTickMs: -1, newestMarkerTickMs };
}
