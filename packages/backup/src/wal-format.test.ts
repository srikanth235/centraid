// governance: allow-repo-hygiene file-size-limit (#408) the wal-format behavior suite — key codecs, sealing, frame math against real WALs, and the replay planner share one fixture vocabulary; sharding would duplicate it per file
/*
 * WAL segment format tests (FORMAT.md § WAL segments, § Encryption — /1,
 * issue #408). Everything here is restore-correctness-critical: key codec
 * (restore planning reads ONLY keys), deterministic sealing (crash-retry
 * nonce safety), commit-boundary math against a REAL SQLite WAL (no
 * synthetic frames — the shipper reads real files), and replay planning
 * (the page-mixing defenses). The FORMAT.md info/AAD strings are pinned
 * verbatim: silent drift there would strand every already-shipped stream.
 */

import fss, { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test } from 'vitest';
import { deriveNonce, encryptWithNonce } from './crypto.js';
import {
  isWalGeneration,
  lastCommitBoundary,
  newWalGeneration,
  openWalCloser,
  openWalPairMarker,
  openWalSegment,
  parseWalCloserKey,
  parseWalPairMarkerKey,
  parseWalSegmentKey,
  planCoordinatedReplay,
  planWalReplay,
  reachedPosition,
  scanWalPrefix,
  sealWalCloser,
  sealWalPairMarker,
  sealWalSegment,
  WAL_CAPTURE_ORDER,
  WAL_DB_NAMES,
  WAL_HEADER_BYTES,
  type WalDbName,
  type WalGroupCloser,
  type WalPairMarker,
  type WalSegmentAddress,
  type WalStreamListing,
  walGroupCloserKey,
  walPageSize,
  walPairMarkerKey,
  walSalts,
  walSegmentKey,
  walSegmentPrefix,
  validateCommittedWal,
} from './wal-format.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-wal-format-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const GEN = 'ab12'.repeat(8); // 32 hex chars
const GEN2 = 'cd34'.repeat(8);
const VAULT_ID = 'vault-1';
const DATA_KEY = new Uint8Array(32).fill(0x5a);

function seg(over: Partial<WalSegmentAddress> = {}): WalSegmentAddress {
  return {
    db: 'vault',
    generation: GEN,
    group: 0,
    startOffset: 0,
    endOffset: 100,
    tickMs: 1000,
    ...over,
  };
}

function closer(over: Partial<WalGroupCloser> = {}): WalGroupCloser {
  return { db: 'vault', generation: GEN, group: 0, endOffset: 100, ...over };
}

function listing(segments: WalSegmentAddress[], closers: WalGroupCloser[] = []): WalStreamListing {
  return { segments, closers };
}

// ---------------------------------------------------------------------------
// Key codec
// ---------------------------------------------------------------------------

describe('walSegmentKey / parseWalSegmentKey', () => {
  test('emits the exact FORMAT.md key shape and roundtrips', () => {
    const addr = seg({ db: 'journal', group: 3, startOffset: 123, endOffset: 4567, tickMs: 89012 });
    const key = walSegmentKey(addr);
    expect(key).toBe(`wal/journal/${GEN}/00000003/000000000123-000000004567-0000000089012`);
    expect(parseWalSegmentKey(key)).toEqual(addr);
  });

  test('roundtrips zero offsets and large values', () => {
    const addr = seg({ startOffset: 0, endOffset: 999999999999, tickMs: 1752451200000 });
    expect(parseWalSegmentKey(walSegmentKey(addr))).toEqual(addr);
  });

  test('parse rejects non-segment and malformed keys', () => {
    const good = walSegmentKey(seg());
    expect(parseWalSegmentKey(good)).not.toBeNull();
    // bad db name
    expect(parseWalSegmentKey(good.replace('wal/vault/', 'wal/other/'))).toBeNull();
    // generation one hex char short
    expect(
      parseWalSegmentKey(
        `wal/vault/${GEN.slice(0, 31)}/00000000/000000000000-000000000100-0000000001000`,
      ),
    ).toBeNull();
    // uppercase hex generation is not a generation
    expect(
      parseWalSegmentKey(
        `wal/vault/${GEN.toUpperCase()}/00000000/000000000000-000000000100-0000000001000`,
      ),
    ).toBeNull();
    // junk / other object classes
    expect(parseWalSegmentKey('chunks/abcdef')).toBeNull();
    expect(parseWalSegmentKey('manifests/123-abcd.json')).toBeNull();
    expect(parseWalSegmentKey('')).toBeNull();
    // a closer key is NOT a segment
    expect(parseWalSegmentKey(walGroupCloserKey(closer()))).toBeNull();
    // prefixes/suffixes must not match (anchored regex)
    expect(parseWalSegmentKey(`x${good}`)).toBeNull();
    expect(parseWalSegmentKey(`${good}x`)).toBeNull();
    expect(parseWalSegmentKey(`${good}-f`)).toBeNull(); // the retired draft final marker
    expect(parseWalSegmentKey(`prefix/${good}`)).toBeNull();
  });

  test('parse rejects end <= start (an empty or inverted range is never a segment)', () => {
    expect(
      parseWalSegmentKey(`wal/vault/${GEN}/00000000/000000000100-000000000100-0000000001000`),
    ).toBeNull();
    expect(
      parseWalSegmentKey(`wal/vault/${GEN}/00000000/000000000200-000000000100-0000000001000`),
    ).toBeNull();
  });

  test('walSegmentKey refuses invalid addresses instead of minting hostile keys', () => {
    expect(() => walSegmentKey(seg({ generation: 'nothex' }))).toThrow(/generation/);
    expect(() => walSegmentKey(seg({ group: -1 }))).toThrow(/group/);
    expect(() => walSegmentKey(seg({ group: 1.5 }))).toThrow(/group/);
    expect(() => walSegmentKey(seg({ startOffset: 100, endOffset: 100 }))).toThrow(/range/);
    expect(() => walSegmentKey(seg({ startOffset: -1 }))).toThrow(/range/);
    expect(() => walSegmentKey(seg({ tickMs: -1 }))).toThrow(/tick/);
  });

  test('lexicographic key order equals replay order within a group', () => {
    const keys = [
      walSegmentKey(seg({ startOffset: 0, endOffset: 100, tickMs: 1000 })),
      walSegmentKey(seg({ startOffset: 100, endOffset: 5000, tickMs: 2000 })),
      walSegmentKey(seg({ startOffset: 5000, endOffset: 123456, tickMs: 3000 })),
    ];
    expect([...keys].sort()).toEqual(keys);
  });
});

describe('walGroupCloserKey / parseWalCloserKey', () => {
  test('emits the exact FORMAT.md closer key shape and roundtrips', () => {
    const c = closer({ db: 'journal', group: 7, endOffset: 200 });
    const key = walGroupCloserKey(c);
    expect(key).toBe(`wal/journal/${GEN}/00000007/closed-000000000200`);
    expect(parseWalCloserKey(key)).toEqual(c);
  });

  test('parse rejects non-closer and malformed keys', () => {
    const good = walGroupCloserKey(closer());
    expect(parseWalCloserKey(good)).not.toBeNull();
    expect(parseWalCloserKey(good.replace('wal/vault/', 'wal/other/'))).toBeNull();
    expect(
      parseWalCloserKey(`wal/vault/${GEN.slice(0, 31)}/00000000/closed-000000000100`),
    ).toBeNull();
    expect(parseWalCloserKey(walSegmentKey(seg()))).toBeNull(); // a segment is not a closer
    expect(parseWalCloserKey(`x${good}`)).toBeNull();
    expect(parseWalCloserKey(`${good}x`)).toBeNull();
    expect(parseWalCloserKey('')).toBeNull();
  });

  test('walGroupCloserKey refuses invalid closers', () => {
    expect(() => walGroupCloserKey(closer({ generation: 'zz' }))).toThrow(/generation/);
    expect(() => walGroupCloserKey(closer({ group: -1 }))).toThrow(/group/);
    expect(() => walGroupCloserKey(closer({ endOffset: 0 }))).toThrow(/closer end/);
    expect(() => walGroupCloserKey(closer({ endOffset: 1.5 }))).toThrow(/closer end/);
  });

  test('a closer key sorts after every segment key of its group (suffix listing order)', () => {
    // 'closed-…' > any 12-digit start offset lexicographically, so a plain
    // LIST returns a group's segments first, closer last — pleasant, and a
    // property the shipper may rely on for debugging listings.
    const segKey = walSegmentKey(seg({ startOffset: 999999999998, endOffset: 999999999999 }));
    const closerKey = walGroupCloserKey(closer({ endOffset: 999999999999 }));
    expect(closerKey > segKey).toBe(true);
  });
});

describe('walSegmentPrefix / generations', () => {
  test('prefix without group covers the whole generation', () => {
    expect(walSegmentPrefix('vault', GEN)).toBe(`wal/vault/${GEN}/`);
  });

  test('prefix with group pins one zero-padded group directory', () => {
    expect(walSegmentPrefix('journal', GEN, 5)).toBe(`wal/journal/${GEN}/00000005/`);
    expect(walSegmentPrefix('journal', GEN, 0)).toBe(`wal/journal/${GEN}/00000000/`);
  });

  test('prefix refuses an invalid generation', () => {
    expect(() => walSegmentPrefix('vault', 'not-a-generation')).toThrow(/generation/);
  });

  test('segment and closer keys fall under their generation prefix', () => {
    const prefix = walSegmentPrefix('vault', GEN);
    expect(walSegmentKey(seg()).startsWith(prefix)).toBe(true);
    expect(walGroupCloserKey(closer()).startsWith(prefix)).toBe(true);
    expect(walSegmentKey(seg({ generation: GEN2 })).startsWith(prefix)).toBe(false);
  });

  test('newWalGeneration mints 32 lowercase hex chars from the supplied entropy', () => {
    const gen = newWalGeneration((n) => new Uint8Array(n).fill(0xab));
    expect(gen).toBe('ab'.repeat(16));
    expect(isWalGeneration(gen)).toBe(true);
    expect(isWalGeneration('AB'.repeat(16))).toBe(false);
    expect(isWalGeneration('ab'.repeat(15))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sealing — deterministic nonces, AAD address binding
// ---------------------------------------------------------------------------

describe('sealWalSegment / openWalSegment', () => {
  const plain100 = new Uint8Array(100).map((_, i) => i % 251);

  test('roundtrips', () => {
    const addr = seg();
    const sealed = sealWalSegment(DATA_KEY, VAULT_ID, addr, plain100);
    expect([...openWalSegment(DATA_KEY, VAULT_ID, addr, sealed)]).toEqual([...plain100]);
  });

  test('is deterministic: same (address, bytes) seals to byte-identical output (G7)', () => {
    // The idempotent-PUT property: a retried upload re-seals the SAME local
    // segment file, whose name encodes the full address (tick included), so
    // it must reproduce the object byte for byte.
    const addr = seg({ group: 2, startOffset: 100, endOffset: 200, tickMs: 1752451200000 });
    const plain = new Uint8Array(100).fill(0x77);
    const a = sealWalSegment(DATA_KEY, VAULT_ID, addr, plain);
    const b = sealWalSegment(DATA_KEY, VAULT_ID, addr, plain);
    expect([...a]).toEqual([...b]);
    expect([...openWalSegment(DATA_KEY, VAULT_ID, addr, b)]).toEqual([...plain]);
  });

  test('a forged tick does not authenticate — PITR cuts cannot be lied about', () => {
    // tickMs is in the object key and it ALONE decides the point-in-time cut
    // (planWalReplay stops at the first tick > cut) and the coordinated
    // two-db cut. If the seal did not cover it, a hostile provider could
    // copy this object to a key bearing an earlier tick and a "restore to T"
    // would apply bytes captured well after T.
    const real = seg({ group: 1, startOffset: 0, endOffset: 100, tickMs: 1000 });
    const sealed = sealWalSegment(DATA_KEY, VAULT_ID, real, plain100);
    const forged = { ...real, tickMs: 1 }; // same range, same group — only the tick moved
    expect(() => openWalSegment(DATA_KEY, VAULT_ID, forged, sealed)).toThrow();
    // ...and forward, too (relabelling an early segment as late).
    expect(() =>
      openWalSegment(DATA_KEY, VAULT_ID, { ...real, tickMs: 9_999_999 }, sealed),
    ).toThrow();
    // The genuine address still opens.
    expect([...openWalSegment(DATA_KEY, VAULT_ID, real, sealed)]).toEqual([...plain100]);
  });

  test('the same range at a different tick gets a DIFFERENT nonce', () => {
    // Two objects, same [start,end), different ticks (a crash-retry can leave
    // exactly this pair). Both are legitimate keys, so both must carry their
    // own nonce — sealing them under one nonce would be reuse.
    const early = seg({ startOffset: 0, endOffset: 100, tickMs: 1000 });
    const late = seg({ startOffset: 0, endOffset: 100, tickMs: 2000 });
    const a = sealWalSegment(DATA_KEY, VAULT_ID, early, plain100);
    const b = sealWalSegment(DATA_KEY, VAULT_ID, late, plain100);
    expect([...a.subarray(0, 12)]).not.toEqual([...b.subarray(0, 12)]); // nonces
    expect([...a]).not.toEqual([...b]); // ciphertexts
  });

  test('a longer crash-retry range from the same start gets a DIFFERENT nonce', () => {
    // The G7 crash-retry defense: a retry that re-reads a LONGER range from
    // the same startOffset must not reuse the shorter seal's nonce on
    // different plaintext. endOffset is in the derivation, so the first 12
    // sealed bytes (the nonce) must differ.
    const shorter = seg({ startOffset: 0, endOffset: 100 });
    const longer = seg({ startOffset: 0, endOffset: 150 });
    const plain150 = new Uint8Array(150).map((_, i) => i % 251); // first 100 bytes identical
    const sealedShort = sealWalSegment(DATA_KEY, VAULT_ID, shorter, plain150.subarray(0, 100));
    const sealedLong = sealWalSegment(DATA_KEY, VAULT_ID, longer, plain150);
    expect([...sealedShort.subarray(0, 12)]).not.toEqual([...sealedLong.subarray(0, 12)]);
  });

  test('pins the FORMAT.md nonce info and AAD strings verbatim', () => {
    // FORMAT.md § Encryption is normative; if this test breaks, already-
    // shipped segments become unreadable — that is a format break, not a
    // refactor.
    const addr = seg({ group: 2, startOffset: 0, endOffset: 100, tickMs: 1000 });
    const nonce = deriveNonce(DATA_KEY, `centraid-backup:wal-nonce:vault:${GEN}:2:0:100:1000`);
    const aad = new TextEncoder().encode(`centraid-wal/1:${VAULT_ID}:vault:${GEN}:2:0:100:1000`);
    const expected = encryptWithNonce(DATA_KEY, nonce, plain100, aad);
    expect([...sealWalSegment(DATA_KEY, VAULT_ID, addr, plain100)]).toEqual([...expected]);
  });

  test('seal refuses bytes that do not match the claimed range length', () => {
    expect(() => sealWalSegment(DATA_KEY, VAULT_ID, seg({ endOffset: 101 }), plain100)).toThrow(
      /100 bytes for range 0-101/,
    );
  });

  test('open rejects a valid seal whose plaintext length contradicts the address', () => {
    // Craft a blob that AUTHENTICATES under the address (correct nonce + AAD)
    // but carries the wrong number of bytes — the post-decrypt length check
    // is the last line of defense against a shipper-side accounting bug.
    const addr = seg({ startOffset: 0, endOffset: 100, tickMs: 1000 });
    const nonce = deriveNonce(DATA_KEY, `centraid-backup:wal-nonce:vault:${GEN}:0:0:100:1000`);
    const aad = new TextEncoder().encode(`centraid-wal/1:${VAULT_ID}:vault:${GEN}:0:0:100:1000`);
    const forged = encryptWithNonce(DATA_KEY, nonce, new Uint8Array(60), aad);
    expect(() => openWalSegment(DATA_KEY, VAULT_ID, addr, forged)).toThrow(
      /60 bytes for range 0-100/,
    );
  });

  test('open rejects an address swap — same-size segments cannot be substituted', () => {
    const addrA = seg({ group: 0, startOffset: 0, endOffset: 100 });
    const addrB = seg({ group: 1, startOffset: 0, endOffset: 100 });
    const sealed = sealWalSegment(DATA_KEY, VAULT_ID, addrA, plain100);
    expect(() => openWalSegment(DATA_KEY, VAULT_ID, addrB, sealed)).toThrow();
    // db swap
    const addrJournal = seg({ db: 'journal' });
    expect(() => openWalSegment(DATA_KEY, VAULT_ID, addrJournal, sealed)).toThrow();
    // generation swap
    expect(() => openWalSegment(DATA_KEY, VAULT_ID, seg({ generation: GEN2 }), sealed)).toThrow();
    // vault swap
    expect(() => openWalSegment(DATA_KEY, 'vault-2', addrA, sealed)).toThrow();
    // offset swap (same length, shifted range)
    const addrShifted = seg({ startOffset: 100, endOffset: 200 });
    expect(() => openWalSegment(DATA_KEY, VAULT_ID, addrShifted, sealed)).toThrow();
  });

  test('open rejects a single flipped ciphertext bit', () => {
    const addr = seg();
    const sealed = sealWalSegment(DATA_KEY, VAULT_ID, addr, plain100);
    const tampered = new Uint8Array(sealed);
    tampered[12 + 50]! ^= 0x01; // one bit, mid-ciphertext
    expect(() => openWalSegment(DATA_KEY, VAULT_ID, addr, tampered)).toThrow();
  });

  test('open rejects truncation', () => {
    const addr = seg();
    const sealed = sealWalSegment(DATA_KEY, VAULT_ID, addr, plain100);
    expect(() =>
      openWalSegment(DATA_KEY, VAULT_ID, addr, sealed.subarray(0, sealed.length - 1)),
    ).toThrow();
    expect(() => openWalSegment(DATA_KEY, VAULT_ID, addr, sealed.subarray(0, 10))).toThrow(
      /truncated/,
    );
    expect(() => openWalSegment(DATA_KEY, VAULT_ID, addr, new Uint8Array(0))).toThrow(/truncated/);
  });

  test('open rejects a seal under a different data key', () => {
    const addr = seg();
    const otherKey = new Uint8Array(32).fill(0x5b);
    const sealed = sealWalSegment(otherKey, VAULT_ID, addr, plain100);
    expect(() => openWalSegment(DATA_KEY, VAULT_ID, addr, sealed)).toThrow();
  });
});

describe('sealWalCloser / openWalCloser', () => {
  test('roundtrips (empty payload, tag over the AAD-bound address)', () => {
    const c = closer({ group: 3, endOffset: 4096 });
    const sealed = sealWalCloser(DATA_KEY, VAULT_ID, c);
    expect(sealed.length).toBe(12 + 0 + 16); // nonce + empty ciphertext + tag
    expect(() => openWalCloser(DATA_KEY, VAULT_ID, c, sealed)).not.toThrow();
  });

  test('is deterministic — a retried closer upload is byte-identical', () => {
    const c = closer({ group: 1, endOffset: 200 });
    expect([...sealWalCloser(DATA_KEY, VAULT_ID, c)]).toEqual([
      ...sealWalCloser(DATA_KEY, VAULT_ID, c),
    ]);
  });

  test('pins the FORMAT.md closer info and AAD strings verbatim', () => {
    const c = closer({ group: 3, endOffset: 4096 });
    const nonce = deriveNonce(DATA_KEY, `centraid-backup:wal-nonce:vault:${GEN}:3:4096:closed`);
    const aad = new TextEncoder().encode(`centraid-wal/1:${VAULT_ID}:vault:${GEN}:3:4096:closed`);
    const expected = encryptWithNonce(DATA_KEY, nonce, new Uint8Array(0), aad);
    expect([...sealWalCloser(DATA_KEY, VAULT_ID, c)]).toEqual([...expected]);
  });

  test('rejects tampering — a provider cannot flip a closer to a different end', () => {
    const c = closer({ endOffset: 200 });
    const sealed = sealWalCloser(DATA_KEY, VAULT_ID, c);
    const tampered = new Uint8Array(sealed);
    tampered[tampered.length - 1]! ^= 0x01;
    expect(() => openWalCloser(DATA_KEY, VAULT_ID, c, tampered)).toThrow();
  });

  test('rejects an address swap — a closer legitimizes exactly one (group, end)', () => {
    const sealed = sealWalCloser(DATA_KEY, VAULT_ID, closer({ group: 0, endOffset: 200 }));
    // The dangerous forgery: same sealed object presented as closing the
    // group EARLIER than it really ended — would legitimize a truncated group.
    expect(() =>
      openWalCloser(DATA_KEY, VAULT_ID, closer({ group: 0, endOffset: 100 }), sealed),
    ).toThrow();
    expect(() =>
      openWalCloser(DATA_KEY, VAULT_ID, closer({ group: 1, endOffset: 200 }), sealed),
    ).toThrow();
    expect(() =>
      openWalCloser(DATA_KEY, VAULT_ID, closer({ db: 'journal', endOffset: 200 }), sealed),
    ).toThrow();
    expect(() =>
      openWalCloser(DATA_KEY, 'vault-2', closer({ group: 0, endOffset: 200 }), sealed),
    ).toThrow();
  });

  test('rejects a closer forged without the data key', () => {
    const c = closer();
    const forged = sealWalCloser(new Uint8Array(32).fill(0x99), VAULT_ID, c);
    expect(() => openWalCloser(DATA_KEY, VAULT_ID, c, forged)).toThrow();
  });

  test('rejects a sealed SEGMENT presented as a closer (cross-object confusion)', () => {
    const addr = seg({ startOffset: 0, endOffset: 100 });
    const sealedSegment = sealWalSegment(DATA_KEY, VAULT_ID, addr, new Uint8Array(100));
    expect(() =>
      openWalCloser(DATA_KEY, VAULT_ID, closer({ group: 0, endOffset: 100 }), sealedSegment),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Frame-boundary math against a REAL SQLite WAL
// ---------------------------------------------------------------------------

interface WalRig {
  conn: DatabaseSync;
  walPath: string;
  pageSize: number;
  insert: (val: string) => void;
}

async function walRig(): Promise<WalRig> {
  const dir = await tempDir();
  const dbPath = path.join(dir, 'rig.db');
  const conn = new DatabaseSync(dbPath);
  cleanups.push(async () => {
    try {
      conn.close();
    } catch {
      /* already closed */
    }
  });
  conn.exec('PRAGMA journal_mode=WAL');
  conn.exec('PRAGMA synchronous=FULL');
  conn.exec('PRAGMA wal_autocheckpoint=0');
  // Tiny page cache so an open transaction SPILLS uncommitted frames into
  // the WAL file — the exact hazard lastCommitBoundary exists to fence off.
  conn.exec('PRAGMA cache_size=2');
  conn.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY, val TEXT NOT NULL)');
  const { page_size: pageSize } = conn.prepare('PRAGMA page_size').get() as { page_size: number };
  const stmt = conn.prepare('INSERT INTO rows (val) VALUES (?)');
  return { conn, walPath: `${dbPath}-wal`, pageSize, insert: (val) => void stmt.run(val) };
}

function walBytes(rig: WalRig): Uint8Array {
  return new Uint8Array(fss.readFileSync(rig.walPath));
}

describe('lastCommitBoundary / walPageSize / walSalts against a real WAL', () => {
  test('validates the rolling checksums of a committed real WAL', async () => {
    const rig = await walRig();
    const bytes = walBytes(rig);
    expect(validateCommittedWal(bytes)).toMatchObject({
      validEndOffset: bytes.length,
      lastCommitOffset: bytes.length,
    });
  });

  test('stops before an AEAD-valid but checksum-corrupted frame', async () => {
    const rig = await walRig();
    const bytes = Buffer.from(walBytes(rig));
    bytes[bytes.length - 1]! ^= 0xff;
    const scan = scanWalPrefix(bytes);
    expect(scan.validEndOffset).toBeLessThan(bytes.length);
    expect(() => validateCommittedWal(bytes)).toThrow(/checksum|salt/);
  });
  test('idle WAL: the last frame is a commit, so the boundary IS the file size', async () => {
    const rig = await walRig();
    for (let i = 0; i < 5; i++) rig.insert(`row-${i}`);
    const bytes = walBytes(rig);
    expect(bytes.length).toBeGreaterThan(WAL_HEADER_BYTES);
    expect((bytes.length - WAL_HEADER_BYTES) % (24 + rig.pageSize)).toBe(0);
    expect(lastCommitBoundary(bytes, 0, rig.pageSize)).toBe(bytes.length);
  });

  test('an uncommitted spilled tail is excluded; ROLLBACK does not move the boundary', async () => {
    const rig = await walRig();
    for (let i = 0; i < 5; i++) rig.insert(`row-${i}`);
    const preBegin = walBytes(rig).length;
    expect(lastCommitBoundary(walBytes(rig), 0, rig.pageSize)).toBe(preBegin);

    rig.conn.exec('BEGIN');
    const big = 'x'.repeat(2000);
    for (let i = 0; i < 30; i++) rig.insert(`${big}-${i}`);
    const mid = walBytes(rig);
    // The tiny cache spilled uncommitted frames into the file…
    expect(mid.length).toBeGreaterThan(preBegin);
    // …and the boundary must sit exactly at the last COMMIT, i.e. pre-BEGIN.
    expect(lastCommitBoundary(mid, 0, rig.pageSize)).toBe(preBegin);

    rig.conn.exec('ROLLBACK');
    const post = walBytes(rig);
    expect(lastCommitBoundary(post, 0, rig.pageSize)).toBe(preBegin);
  });

  test('rolled-back bytes are OVERWRITTEN in place by the next commits (why segments end on commits)', async () => {
    const rig = await walRig();
    for (let i = 0; i < 5; i++) rig.insert(`row-${i}`);
    const preBegin = walBytes(rig).length;
    rig.conn.exec('BEGIN');
    const big = 'x'.repeat(2000);
    for (let i = 0; i < 30; i++) rig.insert(`${big}-${i}`);
    rig.conn.exec('ROLLBACK');
    const rolledBackSize = walBytes(rig).length;
    for (let i = 0; i < 3; i++) rig.insert(`after-${i}`);
    const full = walBytes(rig);
    const boundary = lastCommitBoundary(full, 0, rig.pageSize);
    // New commits land right after preBegin — INSIDE the rolled-back extent.
    // Anything shipped past a commit boundary would have forked from this.
    expect(boundary).toBeGreaterThan(preBegin);
    expect(boundary).toBeLessThan(rolledBackSize);
    expect(full.length).toBe(rolledBackSize);
  });

  test('a range starting at a prior commit boundary (baseOffset > 0) finds the next commits', async () => {
    const rig = await walRig();
    for (let i = 0; i < 5; i++) rig.insert(`row-${i}`);
    const b1 = lastCommitBoundary(walBytes(rig), 0, rig.pageSize);
    for (let i = 0; i < 4; i++) rig.insert(`more-${i}`);
    const full = walBytes(rig);
    const b2 = lastCommitBoundary(full, 0, rig.pageSize);
    expect(b2).toBeGreaterThan(b1);
    expect(lastCommitBoundary(full.subarray(b1), b1, rig.pageSize)).toBe(b2);
  });

  test('a range with no completed commit frame returns baseOffset itself', async () => {
    const rig = await walRig();
    rig.insert('row');
    const full = walBytes(rig);
    const b = lastCommitBoundary(full, 0, rig.pageSize);
    // From the boundary on there is nothing new: ship-nothing, not garbage.
    expect(lastCommitBoundary(full.subarray(b), b, rig.pageSize)).toBe(b);
    // Header-only prefix: no frame completes in range.
    expect(lastCommitBoundary(full.subarray(0, WAL_HEADER_BYTES), 0, rig.pageSize)).toBe(0);
    // Empty WAL (post-checkpoint state): nothing to ship.
    expect(lastCommitBoundary(new Uint8Array(0), 0, rig.pageSize)).toBe(0);
  });

  test('a misaligned baseOffset is an error, never a silent misparse', async () => {
    const rig = await walRig();
    for (let i = 0; i < 3; i++) rig.insert(`row-${i}`);
    const full = walBytes(rig);
    expect(() => lastCommitBoundary(full.subarray(33), 33, rig.pageSize)).toThrow(
      /not frame-aligned/,
    );
    expect(() => lastCommitBoundary(full.subarray(16), 16, rig.pageSize)).toThrow(
      /not frame-aligned/,
    );
  });

  test('walPageSize reads the real header page size; walSalts change across checkpoints', async () => {
    const rig = await walRig();
    rig.insert('row-a');
    const header1 = walBytes(rig).subarray(0, WAL_HEADER_BYTES);
    expect(walPageSize(header1)).toBe(rig.pageSize);
    const salts1 = walSalts(header1);

    // Shipper-style TRUNCATE checkpoint, then new writes → fresh WAL header.
    const cp = rig.conn.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number };
    expect(cp.busy).toBe(0);
    expect(fss.statSync(rig.walPath).size).toBe(0);
    rig.insert('row-b');
    const header2 = walBytes(rig).subarray(0, WAL_HEADER_BYTES);
    const salts2 = walSalts(header2);
    // This is the G5 foreign-checkpoint detector's signal.
    expect(salts2).not.toEqual(salts1);
  });

  test('walPageSize / walSalts reject garbage and truncated headers', () => {
    expect(() => walPageSize(new Uint8Array(31))).toThrow(/truncated/);
    expect(() => walSalts(new Uint8Array(31))).toThrow(/truncated/);
    const garbage = new Uint8Array(32).fill(0x41);
    expect(() => walPageSize(garbage)).toThrow(/not a wal header/);
    // Right magic, implausible page size.
    const badPage = new Uint8Array(32);
    new DataView(badPage.buffer).setUint32(0, 0x377f0682);
    new DataView(badPage.buffer).setUint32(8, 17);
    expect(() => walPageSize(badPage)).toThrow(/implausible/);
  });
});

// ---------------------------------------------------------------------------
// Replay planning
// ---------------------------------------------------------------------------

describe('planWalReplay', () => {
  test('PITR keeps an earlier shorter same-start segment when the longer retry is after the cut', () => {
    const short = seg({ startOffset: 0, endOffset: 100, tickMs: 1000 });
    const lateLong = seg({ startOffset: 0, endOffset: 150, tickMs: 1100 });
    const plan = planWalReplay(listing([lateLong, short]), {
      db: 'vault',
      generation: GEN,
      cutTickMs: 1000,
    });
    expect(plan.segments).toEqual([short]);
    expect(plan.lastTickMs).toBe(1000);
  });
  const opts = { generation: GEN, db: 'vault' as WalDbName };

  test('plans a happy chain across two groups through the closer', () => {
    const s1 = seg({ group: 0, startOffset: 0, endOffset: 100, tickMs: 1000 });
    const s2 = seg({ group: 0, startOffset: 100, endOffset: 200, tickMs: 2000 });
    const s3 = seg({ group: 1, startOffset: 0, endOffset: 150, tickMs: 3000 });
    const plan = planWalReplay(listing([s3, s1, s2], [closer({ group: 0, endOffset: 200 })]), opts);
    expect(plan.segments).toEqual([s1, s2, s3]);
    expect(plan.lastTickMs).toBe(3000);
    expect(plan.truncatedByHole).toBe(false);
  });

  test('a missing middle segment truncates the plan at the hole', () => {
    const s1 = seg({ group: 0, startOffset: 0, endOffset: 100, tickMs: 1000 });
    const s3 = seg({ group: 0, startOffset: 200, endOffset: 300, tickMs: 3000 });
    const plan = planWalReplay(listing([s1, s3], [closer({ group: 0, endOffset: 300 })]), opts);
    expect(plan.segments).toEqual([s1]);
    expect(plan.lastTickMs).toBe(1000);
    expect(plan.truncatedByHole).toBe(true);
  });

  test('group advance WITHOUT a closer stops the plan (page-mixing defense)', () => {
    const s1 = seg({ group: 0, startOffset: 0, endOffset: 100, tickMs: 1000 });
    const s2 = seg({ group: 1, startOffset: 0, endOffset: 50, tickMs: 2000 });
    const plan = planWalReplay(listing([s1, s2], []), opts);
    expect(plan.segments).toEqual([s1]);
    expect(plan.truncatedByHole).toBe(true);
  });

  test('a closer whose end is PAST the chained offset does not permit advance (missing tail)', () => {
    // Group 0 really ended at 200 (says the authenticated closer) but only
    // [0,100) survived — advancing would layer group 1's page images over a
    // half-applied group 0.
    const s1 = seg({ group: 0, startOffset: 0, endOffset: 100, tickMs: 1000 });
    const s2 = seg({ group: 1, startOffset: 0, endOffset: 50, tickMs: 2000 });
    const plan = planWalReplay(listing([s1, s2], [closer({ group: 0, endOffset: 200 })]), opts);
    expect(plan.segments).toEqual([s1]);
    expect(plan.truncatedByHole).toBe(true);
  });

  test('a segment chaining PAST its group closer end is a producer anomaly: stop', () => {
    const s1 = seg({ group: 0, startOffset: 0, endOffset: 100, tickMs: 1000 });
    const s2 = seg({ group: 0, startOffset: 100, endOffset: 250, tickMs: 2000 });
    const plan = planWalReplay(listing([s1, s2], [closer({ group: 0, endOffset: 100 })]), opts);
    expect(plan.segments).toEqual([s1]);
    expect(plan.truncatedByHole).toBe(true);
  });

  test('a stale same-start SHORTER duplicate is skipped, not a hole', () => {
    const s1 = seg({ group: 0, startOffset: 0, endOffset: 100, tickMs: 1000 });
    const s2long = seg({ group: 0, startOffset: 100, endOffset: 200, tickMs: 2000 });
    const s2short = seg({ group: 0, startOffset: 100, endOffset: 150, tickMs: 1500 });
    const plan = planWalReplay(listing([s1, s2short, s2long]), opts);
    expect(plan.segments).toEqual([s1, s2long]);
    expect(plan.truncatedByHole).toBe(false);
  });

  test('of two same-start duplicates the LONGER range wins (crash-retry re-read)', () => {
    const shortSeg = seg({ group: 0, startOffset: 0, endOffset: 100, tickMs: 1000 });
    const longSeg = seg({ group: 0, startOffset: 0, endOffset: 150, tickMs: 1100 });
    const next = seg({ group: 0, startOffset: 150, endOffset: 220, tickMs: 2000 });
    const plan = planWalReplay(listing([shortSeg, longSeg, next]), opts);
    expect(plan.segments).toEqual([longSeg, next]);
    expect(plan.truncatedByHole).toBe(false);
  });

  test('a missing FIRST segment (no offset-0 chain start) plans nothing', () => {
    const s = seg({ group: 0, startOffset: 100, endOffset: 200, tickMs: 1000 });
    const plan = planWalReplay(listing([s]), opts);
    expect(plan.segments).toEqual([]);
    expect(plan.lastTickMs).toBe(-1);
    expect(plan.truncatedByHole).toBe(true);
  });

  test('a group skip (0 closed, 2 present, 1 missing) is a hole', () => {
    const s1 = seg({ group: 0, startOffset: 0, endOffset: 100, tickMs: 1000 });
    const s3 = seg({ group: 2, startOffset: 0, endOffset: 50, tickMs: 3000 });
    const plan = planWalReplay(
      listing(
        [s1, s3],
        [closer({ group: 0, endOffset: 100 }), closer({ group: 2, endOffset: 50 })],
      ),
      opts,
    );
    expect(plan.segments).toEqual([s1]);
    expect(plan.truncatedByHole).toBe(true);
  });

  test('segments of other generations and databases are ignored entirely', () => {
    const mine = seg({ group: 0, startOffset: 0, endOffset: 100, tickMs: 1000 });
    const otherGen = seg({
      generation: GEN2,
      group: 0,
      startOffset: 0,
      endOffset: 999,
      tickMs: 500,
    });
    const otherDb = seg({ db: 'journal', group: 0, startOffset: 0, endOffset: 999, tickMs: 500 });
    const plan = planWalReplay(
      listing([otherGen, otherDb, mine], [closer({ generation: GEN2, group: 0, endOffset: 999 })]),
      opts,
    );
    expect(plan.segments).toEqual([mine]);
    expect(plan.truncatedByHole).toBe(false);
  });

  test('cutTickMs stops BEFORE the first later-tick segment; mid-group cuts are allowed', () => {
    const s1 = seg({ group: 0, startOffset: 0, endOffset: 100, tickMs: 1000 });
    const s2 = seg({ group: 0, startOffset: 100, endOffset: 200, tickMs: 2000 });
    const s3 = seg({ group: 0, startOffset: 200, endOffset: 300, tickMs: 3000 });
    const all = listing([s1, s2, s3], [closer({ group: 0, endOffset: 300 })]);
    const plan = planWalReplay(all, { ...opts, cutTickMs: 2000 }); // cut == tick is inclusive
    expect(plan.segments).toEqual([s1, s2]);
    expect(plan.lastTickMs).toBe(2000);
    expect(plan.truncatedByHole).toBe(false); // a requested cut is NOT a hole
    const before = planWalReplay(all, { ...opts, cutTickMs: 999 });
    expect(before.segments).toEqual([]);
    expect(before.lastTickMs).toBe(-1);
    expect(before.truncatedByHole).toBe(false);
  });

  test('cutting exactly at a group boundary keeps the closed group, drops the next', () => {
    const s1 = seg({ group: 0, startOffset: 0, endOffset: 100, tickMs: 1000 });
    const s2 = seg({ group: 1, startOffset: 0, endOffset: 50, tickMs: 2000 });
    const plan = planWalReplay(listing([s1, s2], [closer({ group: 0, endOffset: 100 })]), {
      ...opts,
      cutTickMs: 1000,
    });
    expect(plan.segments).toEqual([s1]);
    expect(plan.truncatedByHole).toBe(false);
  });

  test('an empty listing plans nothing without claiming a hole', () => {
    const plan = planWalReplay(listing([]), opts);
    expect(plan).toEqual({ segments: [], lastTickMs: -1, truncatedByHole: false });
  });
});

describe('WAL_CAPTURE_ORDER', () => {
  test('is journal FIRST — and WAL_DB_NAMES is deliberately NOT', () => {
    // The one ordering fact the whole G8 argument rests on, pinned: a receipt
    // commits to journal.db only after its vault.db transaction, so the journal
    // must be cut first or a cut can contain a receipt whose row is missing.
    // `WAL_DB_NAMES` is vault-first and safe only for order-INDIFFERENT loops;
    // this test exists so a "tidy-up" that unifies them fails loudly.
    expect(WAL_CAPTURE_ORDER).toEqual(['journal', 'vault']);
    expect(WAL_DB_NAMES).toEqual(['vault', 'journal']);
  });
});

// ---------------------------------------------------------------------------
// Pair markers (FORMAT.md § WAL segments — the idle-vs-missing discriminator)
// ---------------------------------------------------------------------------

const JGEN = 'ef56'.repeat(8);

function marker(over: Partial<WalPairMarker> = {}): WalPairMarker {
  return {
    vaultGeneration: GEN,
    journalGeneration: JGEN,
    tickMs: 1000,
    vault: { group: 0, endOffset: 100 },
    journal: { group: 0, endOffset: 200 },
    ...over,
  };
}

describe('walPairMarkerKey / parseWalPairMarkerKey', () => {
  test('emits the exact FORMAT.md key shape and roundtrips', () => {
    const key = walPairMarkerKey(marker({ tickMs: 1752480060000 }));
    expect(key).toBe(`wal/tick/${GEN}-${JGEN}/1752480060000`);
    expect(parseWalPairMarkerKey(key)).toEqual({
      vaultGeneration: GEN,
      journalGeneration: JGEN,
      tickMs: 1752480060000,
    });
  });

  test('parse rejects segment keys, closer keys, and malformed marker keys', () => {
    expect(parseWalPairMarkerKey(walSegmentKey(seg()))).toBeNull();
    expect(parseWalPairMarkerKey(walGroupCloserKey(closer()))).toBeNull();
    expect(parseWalPairMarkerKey(`wal/tick/${GEN}/0000000001000`)).toBeNull();
    expect(parseWalPairMarkerKey(`wal/tick/${GEN}-${JGEN}/1000`)).toBeNull();
  });
});

describe('sealWalPairMarker / openWalPairMarker', () => {
  const addrOf = (m: WalPairMarker) => ({
    vaultGeneration: m.vaultGeneration,
    journalGeneration: m.journalGeneration,
    tickMs: m.tickMs,
  });

  test('roundtrips the recorded positions', () => {
    const m = marker({ vault: { group: 2, endOffset: 0 }, journal: { group: 1, endOffset: 4128 } });
    const opened = openWalPairMarker(
      DATA_KEY,
      VAULT_ID,
      addrOf(m),
      sealWalPairMarker(DATA_KEY, VAULT_ID, m),
    );
    expect(opened).toEqual(m);
  });

  test('re-sealing the same marker is BYTE-IDENTICAL (idempotent PUT, and no nonce reuse)', () => {
    // The nonce derives from (vaultGeneration, journalGeneration, tick) alone,
    // so one address MUST have exactly one payload encoding — two different
    // ciphertexts under one address would be a (key, nonce) reuse.
    const m = marker();
    const a = sealWalPairMarker(DATA_KEY, VAULT_ID, m);
    const b = sealWalPairMarker(DATA_KEY, VAULT_ID, { ...m });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  test('RELABELLING the tick in the key fails the tag', () => {
    const m = marker({ tickMs: 5000 });
    const sealed = sealWalPairMarker(DATA_KEY, VAULT_ID, m);
    // A provider copies the object to an earlier tick's key: a restore "at
    // 3000" would then trust positions the databases only reached at 5000 and
    // cut past segments the vault never actually shipped.
    expect(() =>
      openWalPairMarker(DATA_KEY, VAULT_ID, { ...addrOf(m), tickMs: 3000 }, sealed),
    ).toThrow();
  });

  test('SWAPPING two markers of different generations fails the tag', () => {
    const mine = marker();
    const other = marker({ vaultGeneration: GEN2 });
    const sealed = sealWalPairMarker(DATA_KEY, VAULT_ID, other);
    expect(() => openWalPairMarker(DATA_KEY, VAULT_ID, addrOf(mine), sealed)).toThrow();
  });

  test('a marker sealed for another vault fails the tag', () => {
    const m = marker();
    const sealed = sealWalPairMarker(DATA_KEY, 'other-vault', m);
    expect(() => openWalPairMarker(DATA_KEY, VAULT_ID, addrOf(m), sealed)).toThrow();
  });

  test('the nonce info + AAD strings are pinned to FORMAT.md verbatim', () => {
    const m = marker({ tickMs: 7000 });
    const info = `centraid-backup:wal-nonce:tick:${GEN}:${JGEN}:7000`;
    const aad = new TextEncoder().encode(`centraid-wal/1:${VAULT_ID}:tick:${GEN}:${JGEN}:7000`);
    const payload = new TextEncoder().encode(
      `{"journal":{"endOffset":200,"group":0},"tickMs":7000,"v":1,"vault":{"endOffset":100,"group":0}}`,
    );
    const expected = encryptWithNonce(DATA_KEY, deriveNonce(DATA_KEY, info), payload, aad);
    expect(
      Buffer.from(sealWalPairMarker(DATA_KEY, VAULT_ID, m)).equals(Buffer.from(expected)),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reachedPosition — the normalization that makes a lost tail closer visible
// ---------------------------------------------------------------------------

describe('reachedPosition', () => {
  const opts = { db: 'vault' as WalDbName, generation: GEN };

  test('an empty plan is the base itself: (0, 0)', () => {
    const l = listing([]);
    expect(reachedPosition(planWalReplay(l, opts), l, opts)).toEqual({ group: 0, endOffset: 0 });
  });

  test('a mid-group chain is (group, endOffset)', () => {
    const l = listing([
      seg({ group: 0, startOffset: 0, endOffset: 100, tickMs: 1000 }),
      seg({ group: 0, startOffset: 100, endOffset: 220, tickMs: 2000 }),
    ]);
    expect(reachedPosition(planWalReplay(l, opts), l, opts)).toEqual({ group: 0, endOffset: 220 });
  });

  test('a chain that reaches its group CLOSER normalizes to (group + 1, 0)', () => {
    const l = listing(
      [seg({ group: 0, startOffset: 0, endOffset: 220, tickMs: 1000 })],
      [closer({ group: 0, endOffset: 220 })],
    );
    expect(reachedPosition(planWalReplay(l, opts), l, opts)).toEqual({ group: 1, endOffset: 0 });
  });

  test('the SAME chain WITHOUT the closer stays at (group, end) — the tail-closer tell', () => {
    // Nothing else in the format can see a lost tail closer: the chain reaches
    // the group's last byte either way, and a closed FINAL group has no
    // successor segments to prove it was finished. Only the marker's
    // (group + 1, 0) disagrees with this (group, end).
    const l = listing([seg({ group: 0, startOffset: 0, endOffset: 220, tickMs: 1000 })]);
    expect(reachedPosition(planWalReplay(l, opts), l, opts)).toEqual({ group: 0, endOffset: 220 });
  });
});

// ---------------------------------------------------------------------------
// planCoordinatedReplay (G8 — the marker-driven two-database cut)
// ---------------------------------------------------------------------------

describe('planCoordinatedReplay (G8 two-database cut)', () => {
  const generationByDb = { vault: GEN, journal: JGEN } as const;

  /** vault: three chained segments, group 0, ending at 100/200/300. */
  function vaultListing(): WalStreamListing {
    return listing([
      seg({ db: 'vault', group: 0, startOffset: 0, endOffset: 100, tickMs: 1000 }),
      seg({ db: 'vault', group: 0, startOffset: 100, endOffset: 200, tickMs: 2000 }),
      seg({ db: 'vault', group: 0, startOffset: 200, endOffset: 300, tickMs: 3000 }),
    ]);
  }

  /** journal: three chained segments, group 0, ending at 50/150/250. */
  function journalListing(): WalStreamListing {
    return listing([
      seg({
        db: 'journal',
        generation: JGEN,
        group: 0,
        startOffset: 0,
        endOffset: 50,
        tickMs: 1000,
      }),
      seg({
        db: 'journal',
        generation: JGEN,
        group: 0,
        startOffset: 50,
        endOffset: 150,
        tickMs: 2000,
      }),
      seg({
        db: 'journal',
        generation: JGEN,
        group: 0,
        startOffset: 150,
        endOffset: 250,
        tickMs: 3000,
      }),
    ]);
  }

  /** The markers a healthy shipper would have written for those two streams. */
  function markers(): WalPairMarker[] {
    return [
      marker({
        tickMs: 1000,
        vault: { group: 0, endOffset: 100 },
        journal: { group: 0, endOffset: 50 },
      }),
      marker({
        tickMs: 2000,
        vault: { group: 0, endOffset: 200 },
        journal: { group: 0, endOffset: 150 },
      }),
      marker({
        tickMs: 3000,
        vault: { group: 0, endOffset: 300 },
        journal: { group: 0, endOffset: 250 },
      }),
    ];
  }

  test('intact streams cut at the newest marker', () => {
    const r = planCoordinatedReplay({
      listingByDb: { vault: vaultListing(), journal: journalListing() },
      generationByDb,
      markers: markers(),
    });
    expect(r.coordinatedCutMs).toBe(3000);
    expect(r.newestMarkerTickMs).toBe(3000);
    expect(r.plans.vault.lastTickMs).toBe(3000);
    expect(r.plans.journal.lastTickMs).toBe(3000);
  });

  test('a LOST TAIL (listing simply ends — no hole) walks back to the last provable marker', () => {
    const vault = vaultListing();
    vault.segments = vault.segments.slice(0, 2); // ticks 3000's segment is gone
    const r = planCoordinatedReplay({
      listingByDb: { vault, journal: journalListing() },
      generationByDb,
      markers: markers(),
    });
    // The 3000 marker says the vault reached 300; the listing chains to 200.
    expect(r.coordinatedCutMs).toBe(2000);
    expect(r.newestMarkerTickMs).toBe(3000);
    expect(r.plans.vault.lastTickMs).toBe(2000);
    expect(r.plans.journal.lastTickMs).toBe(2000); // the INTACT journal is re-cut with it
    expect(r.plans.journal.segments).toHaveLength(2);
  });

  test('an IDLE database (no new segments, unchanged position) constrains nothing', () => {
    // The vault stopped at 100 after tick 1000; every later marker carries that
    // SAME position, so every later marker is satisfiable and the busy journal
    // reaches its own tip. This is the case a "min over reached ticks" rule
    // silently destroys.
    const vault = listing([
      seg({ db: 'vault', group: 0, startOffset: 0, endOffset: 100, tickMs: 1000 }),
    ]);
    const idleMarkers = markers().map((m) => ({ ...m, vault: { group: 0, endOffset: 100 } }));
    const r = planCoordinatedReplay({
      listingByDb: { vault, journal: journalListing() },
      generationByDb,
      markers: idleMarkers,
    });
    expect(r.coordinatedCutMs).toBe(3000);
    expect(r.plans.journal.lastTickMs).toBe(3000);
    expect(r.plans.vault.lastTickMs).toBe(1000);
  });

  test('a marker whose GROUP CLOSER is missing is unsatisfiable', () => {
    // The shipper rolled the vault's group at tick 3000, so its marker says
    // (1, 0). Without the closer the chain can only claim (0, 300).
    const rolled = markers();
    rolled[2] = marker({
      tickMs: 3000,
      vault: { group: 1, endOffset: 0 },
      journal: { group: 0, endOffset: 250 },
    });
    const r = planCoordinatedReplay({
      listingByDb: { vault: vaultListing(), journal: journalListing() },
      generationByDb,
      markers: rolled,
    });
    expect(r.coordinatedCutMs).toBe(2000);

    // Put the closer back and the very same listing satisfies it.
    const closed = vaultListing();
    closed.closers = [closer({ db: 'vault', group: 0, endOffset: 300 })];
    const ok = planCoordinatedReplay({
      listingByDb: { vault: closed, journal: journalListing() },
      generationByDb,
      markers: rolled,
    });
    expect(ok.coordinatedCutMs).toBe(3000);
  });

  test('a HOLE before a marker makes it unsatisfiable, however the arithmetic falls', () => {
    const holed = vaultListing();
    holed.segments = [holed.segments[0]!, holed.segments[2]!]; // the [100,200) middle is gone
    const r = planCoordinatedReplay({
      listingByDb: { vault: holed, journal: journalListing() },
      generationByDb,
      markers: markers(),
    });
    expect(r.coordinatedCutMs).toBe(1000);
    expect(r.plans.journal.lastTickMs).toBe(1000);
  });

  test('markers naming OTHER generations are never considered', () => {
    const foreign = markers().map((m) => ({ ...m, vaultGeneration: GEN2 }));
    const r = planCoordinatedReplay({
      listingByDb: { vault: vaultListing(), journal: journalListing() },
      generationByDb,
      markers: foreign,
    });
    // (The restore LISTs a pair-scoped prefix, so this cannot happen in
    // practice; the planner refuses to trust them regardless.)
    expect(r.coordinatedCutMs).toBe(-1);
  });

  test('NO markers at all ⇒ the base floor, for both databases', () => {
    const r = planCoordinatedReplay({
      listingByDb: { vault: vaultListing(), journal: journalListing() },
      generationByDb,
      markers: [],
    });
    expect(r.coordinatedCutMs).toBe(-1);
    expect(r.newestMarkerTickMs).toBe(-1);
    expect(r.plans.vault.segments).toEqual([]);
    expect(r.plans.journal.segments).toEqual([]);
  });

  test('an explicit point-in-time cut selects the newest marker AT OR BEFORE it', () => {
    const r = planCoordinatedReplay({
      listingByDb: { vault: vaultListing(), journal: journalListing() },
      generationByDb,
      markers: markers(),
      cutTickMs: 2500,
    });
    expect(r.coordinatedCutMs).toBe(2000);
    // A cut that lands where the producer proved it got to is NOT a truncation:
    // the newest CANDIDATE marker is 2000, and we reached it.
    expect(r.newestMarkerTickMs).toBe(2000);
    expect(r.plans.vault.lastTickMs).toBe(2000);
    expect(r.plans.journal.lastTickMs).toBe(2000);
  });

  test('a cut before any marker is the base pair, and is not a truncation', () => {
    const r = planCoordinatedReplay({
      listingByDb: { vault: vaultListing(), journal: journalListing() },
      generationByDb,
      markers: markers(),
      cutTickMs: 999,
    });
    expect(r.coordinatedCutMs).toBe(-1);
    expect(r.newestMarkerTickMs).toBe(-1);
  });

  test('a single database (no pair) plans uncoordinated — markers cannot apply', () => {
    const r = planCoordinatedReplay({
      listingByDb: { vault: vaultListing(), journal: journalListing() },
      generationByDb: { journal: JGEN },
      markers: markers(),
    });
    expect(r.coordinated).toBe(false);
    expect(r.plans.vault).toEqual({ segments: [], lastTickMs: -1, truncatedByHole: false });
    expect(r.plans.journal.lastTickMs).toBe(3000);
  });
});
