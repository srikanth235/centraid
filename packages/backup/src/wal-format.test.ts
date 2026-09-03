import fss from "node:fs";
// governance: allow-repo-hygiene file-size-limit (#408) the wal-format behavior suite — key codecs, sealing, frame math against real WALs, and the replay planner share one fixture vocabulary; sharding would duplicate it per file
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { deriveNonce, encryptWithNonce } from "./crypto.js";
import {
  isWalGeneration,
  lastCommitBoundary,
  newWalGeneration,
  openWalCloser,
  openWalSegment,
  openWalTickMarker,
  parseWalCloserKey,
  parseWalSegmentKey,
  parseWalTickMarkerKey,
  planMarkedReplay,
  planWalReplay,
  reachedPosition,
  scanWalPrefix,
  sealWalCloser,
  sealWalSegment,
  sealWalTickMarker,
  WAL_DB_FILES,
  WAL_HEADER_BYTES,
  walGroupCloserKey,
  walPageSize,
  walSalts,
  walSegmentKey,
  walSegmentPrefix,
  walTickMarkerKey,
  validateCommittedWal,
} from "./wal-format.js";
import type {
  WalGroupCloser,
  WalSegmentAddress,
  WalStreamListing,
  WalTickMarker,
} from "./wal-format.js";

const cleanups: Array<() => Promise<void>> = [];
describe("wal-format", () => {
  afterEach(async () => {
    const closeNext = async (): Promise<void> => {
      const cleanup = cleanups.pop();
      if (!cleanup) return;
      await cleanup();
      return closeNext();
    };
    await closeNext();
  });
  const GEN = "ab12".repeat(8); // 32 hex chars
  const GEN2 = "cd34".repeat(8);
  const VAULT_ID = "vault-1";
  const DATA_KEY = new Uint8Array(32).fill(0x5a);

  function seg(over: Partial<WalSegmentAddress> = {}): WalSegmentAddress {
    return {
      db: "vault",
      generation: GEN,
      group: 0,
      startOffset: 0,
      endOffset: 100,
      tickMs: 1000,
      ...over,
    };
  }

  function closer(over: Partial<WalGroupCloser> = {}): WalGroupCloser {
    return { db: "vault", generation: GEN, group: 0, endOffset: 100, ...over };
  }

  function listing(
    segments: WalSegmentAddress[],
    closers: WalGroupCloser[] = []
  ): WalStreamListing {
    return { segments, closers };
  }

  describe("walSegmentKey / parseWalSegmentKey", () => {
    test("emits the exact FORMAT.md key shape and roundtrips", () => {
      const addr = seg({
        group: 3,
        startOffset: 123,
        endOffset: 4567,
        tickMs: 89012,
      });
      const key = walSegmentKey(addr);
      expect(key).toBe(
        `wal/vault/${GEN}/00000003/000000000123-000000004567-0000000089012`
      );
      expect(parseWalSegmentKey(key)).toStrictEqual(addr);
    });

    test("roundtrips zero offsets and large values", () => {
      const addr = seg({
        startOffset: 0,
        endOffset: 999999999999,
        tickMs: 1752451200000,
      });
      expect(parseWalSegmentKey(walSegmentKey(addr))).toStrictEqual(addr);
    });

    test("parse rejects non-segment and malformed keys", () => {
      const good = walSegmentKey(seg());
      expect(parseWalSegmentKey(good)).not.toBeNull();
      expect(
        parseWalSegmentKey(good.replace("wal/vault/", "wal/other/"))
      ).toBeNull();
      expect(
        parseWalSegmentKey(
          `wal/vault/${GEN.slice(0, 31)}/00000000/000000000000-000000000100-0000000001000`
        )
      ).toBeNull();
      expect(
        parseWalSegmentKey(
          `wal/vault/${GEN.toUpperCase()}/00000000/000000000000-000000000100-0000000001000`
        )
      ).toBeNull();
      expect(parseWalSegmentKey("chunks/abcdef")).toBeNull();
      expect(parseWalSegmentKey("manifests/123-abcd.json")).toBeNull();
      expect(parseWalSegmentKey("")).toBeNull();
      expect(parseWalSegmentKey(walGroupCloserKey(closer()))).toBeNull();
      expect(parseWalSegmentKey(`x${good}`)).toBeNull();
      expect(parseWalSegmentKey(`${good}x`)).toBeNull();
      expect(parseWalSegmentKey(`${good}-f`)).toBeNull(); // the retired draft final marker
      expect(parseWalSegmentKey(`prefix/${good}`)).toBeNull();
    });

    test("parse rejects end <= start (an empty or inverted range is never a segment)", () => {
      expect(
        parseWalSegmentKey(
          `wal/vault/${GEN}/00000000/000000000100-000000000100-0000000001000`
        )
      ).toBeNull();
      expect(
        parseWalSegmentKey(
          `wal/vault/${GEN}/00000000/000000000200-000000000100-0000000001000`
        )
      ).toBeNull();
    });

    test("walSegmentKey refuses invalid addresses instead of minting hostile keys", () => {
      expect(() => walSegmentKey(seg({ generation: "nothex" }))).toThrow(
        /generation/u
      );
      expect(() => walSegmentKey(seg({ group: -1 }))).toThrow(/group/u);
      expect(() => walSegmentKey(seg({ group: 1.5 }))).toThrow(/group/u);
      expect(() =>
        walSegmentKey(seg({ startOffset: 100, endOffset: 100 }))
      ).toThrow(/range/u);
      expect(() => walSegmentKey(seg({ startOffset: -1 }))).toThrow(/range/u);
      expect(() => walSegmentKey(seg({ tickMs: -1 }))).toThrow(/tick/u);
    });

    test("lexicographic key order equals replay order within a group", () => {
      const keys = [
        walSegmentKey(seg({ startOffset: 0, endOffset: 100, tickMs: 1000 })),
        walSegmentKey(seg({ startOffset: 100, endOffset: 5000, tickMs: 2000 })),
        walSegmentKey(
          seg({ startOffset: 5000, endOffset: 123456, tickMs: 3000 })
        ),
      ];
      expect([...keys].sort()).toStrictEqual(keys);
    });
  });

  describe("walGroupCloserKey / parseWalCloserKey", () => {
    test("emits the exact FORMAT.md closer key shape and roundtrips", () => {
      const c = closer({ group: 7, endOffset: 200 });
      const key = walGroupCloserKey(c);
      expect(key).toBe(`wal/vault/${GEN}/00000007/closed-000000000200`);
      expect(parseWalCloserKey(key)).toStrictEqual(c);
    });

    test("parse rejects non-closer and malformed keys", () => {
      const good = walGroupCloserKey(closer());
      expect(parseWalCloserKey(good)).not.toBeNull();
      expect(
        parseWalCloserKey(good.replace("wal/vault/", "wal/other/"))
      ).toBeNull();
      expect(
        parseWalCloserKey(
          `wal/vault/${GEN.slice(0, 31)}/00000000/closed-000000000100`
        )
      ).toBeNull();
      expect(parseWalCloserKey(walSegmentKey(seg()))).toBeNull(); // a segment is not a closer
      expect(parseWalCloserKey(`x${good}`)).toBeNull();
      expect(parseWalCloserKey(`${good}x`)).toBeNull();
      expect(parseWalCloserKey("")).toBeNull();
    });

    test("walGroupCloserKey refuses invalid closers", () => {
      expect(() => walGroupCloserKey(closer({ generation: "zz" }))).toThrow(
        /generation/u
      );
      expect(() => walGroupCloserKey(closer({ group: -1 }))).toThrow(/group/u);
      expect(() => walGroupCloserKey(closer({ endOffset: 0 }))).toThrow(
        /closer end/u
      );
      expect(() => walGroupCloserKey(closer({ endOffset: 1.5 }))).toThrow(
        /closer end/u
      );
    });

    test("a closer key sorts after every segment key of its group (suffix listing order)", () => {
      const segKey = walSegmentKey(
        seg({ startOffset: 999999999998, endOffset: 999999999999 })
      );
      const closerKey = walGroupCloserKey(closer({ endOffset: 999999999999 }));
      expect([closerKey, segKey].toSorted()).toStrictEqual([segKey, closerKey]);
    });
  });

  describe("walSegmentPrefix / generations", () => {
    test("prefix without group covers the whole generation", () => {
      expect(walSegmentPrefix("vault", GEN)).toBe(`wal/vault/${GEN}/`);
    });

    test("prefix with group pins one zero-padded group directory", () => {
      expect(walSegmentPrefix("vault", GEN, 5)).toBe(
        `wal/vault/${GEN}/00000005/`
      );
      expect(walSegmentPrefix("vault", GEN, 0)).toBe(
        `wal/vault/${GEN}/00000000/`
      );
    });

    test("prefix refuses an invalid generation", () => {
      expect(() => walSegmentPrefix("vault", "not-a-generation")).toThrow(
        /generation/u
      );
    });

    test("segment and closer keys fall under their generation prefix", () => {
      const prefix = walSegmentPrefix("vault", GEN);
      expect(walSegmentKey(seg()).startsWith(prefix)).toBe(true);
      expect(walGroupCloserKey(closer()).startsWith(prefix)).toBe(true);
      expect(walSegmentKey(seg({ generation: GEN2 })).startsWith(prefix)).toBe(
        false
      );
    });

    test("newWalGeneration mints 32 lowercase hex chars from the supplied entropy", () => {
      const gen = newWalGeneration((n) => new Uint8Array(n).fill(0xab));
      expect(gen).toBe("ab".repeat(16));
      expect(isWalGeneration(gen)).toBe(true);
      expect(isWalGeneration("AB".repeat(16))).toBe(false);
      expect(isWalGeneration("ab".repeat(15))).toBe(false);
    });
  });

  describe("sealWalSegment / openWalSegment", () => {
    const plain100 = new Uint8Array(100).map((_, i) => i % 251);

    test("roundtrips", () => {
      const addr = seg();
      const sealed = sealWalSegment(DATA_KEY, VAULT_ID, addr, plain100);
      expect([
        ...openWalSegment(DATA_KEY, VAULT_ID, addr, sealed),
      ]).toStrictEqual([...plain100]);
    });

    test("is deterministic: same (address, bytes) seals to byte-identical output (G7)", () => {
      const addr = seg({
        group: 2,
        startOffset: 100,
        endOffset: 200,
        tickMs: 1752451200000,
      });
      const plain = new Uint8Array(100).fill(0x77);
      const a = sealWalSegment(DATA_KEY, VAULT_ID, addr, plain);
      const b = sealWalSegment(DATA_KEY, VAULT_ID, addr, plain);
      expect([...a]).toStrictEqual([...b]);
      expect([...openWalSegment(DATA_KEY, VAULT_ID, addr, b)]).toStrictEqual([
        ...plain,
      ]);
    });

    test("a forged tick does not authenticate — PITR cuts cannot be lied about", () => {
      const real = seg({
        group: 1,
        startOffset: 0,
        endOffset: 100,
        tickMs: 1000,
      });
      const sealed = sealWalSegment(DATA_KEY, VAULT_ID, real, plain100);
      const forged = { ...real, tickMs: 1 }; // same range, same group — only the tick moved
      expect(() => openWalSegment(DATA_KEY, VAULT_ID, forged, sealed)).toThrow(
        /unsupported state or unable to authenticate data/iu
      );
      expect(() =>
        openWalSegment(
          DATA_KEY,
          VAULT_ID,
          { ...real, tickMs: 9_999_999 },
          sealed
        )
      ).toThrow(/unsupported state or unable to authenticate data/iu);
      expect([
        ...openWalSegment(DATA_KEY, VAULT_ID, real, sealed),
      ]).toStrictEqual([...plain100]);
    });

    test("the same range at a different tick gets a DIFFERENT nonce", () => {
      const early = seg({ startOffset: 0, endOffset: 100, tickMs: 1000 });
      const late = seg({ startOffset: 0, endOffset: 100, tickMs: 2000 });
      const a = sealWalSegment(DATA_KEY, VAULT_ID, early, plain100);
      const b = sealWalSegment(DATA_KEY, VAULT_ID, late, plain100);
      expect([...a.subarray(0, 12)]).not.toStrictEqual([...b.subarray(0, 12)]); // nonces
      expect([...a]).not.toStrictEqual([...b]); // ciphertexts
    });

    test("a longer crash-retry range from the same start gets a DIFFERENT nonce", () => {
      const shorter = seg({ startOffset: 0, endOffset: 100 });
      const longer = seg({ startOffset: 0, endOffset: 150 });
      const plain150 = new Uint8Array(150).map((_, i) => i % 251); // first 100 bytes identical
      const sealedShort = sealWalSegment(
        DATA_KEY,
        VAULT_ID,
        shorter,
        plain150.subarray(0, 100)
      );
      const sealedLong = sealWalSegment(DATA_KEY, VAULT_ID, longer, plain150);
      expect([...sealedShort.subarray(0, 12)]).not.toStrictEqual([
        ...sealedLong.subarray(0, 12),
      ]);
    });

    test("pins the FORMAT.md nonce info and AAD strings verbatim", () => {
      const addr = seg({
        group: 2,
        startOffset: 0,
        endOffset: 100,
        tickMs: 1000,
      });
      const nonce = deriveNonce(
        DATA_KEY,
        `centraid-backup:wal-nonce:vault:${GEN}:2:0:100:1000`
      );
      const aad = new TextEncoder().encode(
        `centraid-wal/1:${VAULT_ID}:vault:${GEN}:2:0:100:1000`
      );
      const expected = encryptWithNonce(DATA_KEY, nonce, plain100, aad);
      expect([
        ...sealWalSegment(DATA_KEY, VAULT_ID, addr, plain100),
      ]).toStrictEqual([...expected]);
    });

    test("seal refuses bytes that do not match the claimed range length", () => {
      expect(() =>
        sealWalSegment(DATA_KEY, VAULT_ID, seg({ endOffset: 101 }), plain100)
      ).toThrow(/100 bytes for range 0-101/u);
    });

    test("open rejects a valid seal whose plaintext length contradicts the address", () => {
      const addr = seg({ startOffset: 0, endOffset: 100, tickMs: 1000 });
      const nonce = deriveNonce(
        DATA_KEY,
        `centraid-backup:wal-nonce:vault:${GEN}:0:0:100:1000`
      );
      const aad = new TextEncoder().encode(
        `centraid-wal/1:${VAULT_ID}:vault:${GEN}:0:0:100:1000`
      );
      const forged = encryptWithNonce(DATA_KEY, nonce, new Uint8Array(60), aad);
      expect(() => openWalSegment(DATA_KEY, VAULT_ID, addr, forged)).toThrow(
        /60 bytes for range 0-100/u
      );
    });

    test("open rejects an address swap — same-size segments cannot be substituted", () => {
      const addrA = seg({ group: 0, startOffset: 0, endOffset: 100 });
      const addrB = seg({ group: 1, startOffset: 0, endOffset: 100 });
      const sealed = sealWalSegment(DATA_KEY, VAULT_ID, addrA, plain100);
      expect(() => openWalSegment(DATA_KEY, VAULT_ID, addrB, sealed)).toThrow(
        /unsupported state or unable to authenticate data/iu
      );
      expect(() =>
        openWalSegment(DATA_KEY, VAULT_ID, seg({ generation: GEN2 }), sealed)
      ).toThrow(/unsupported state or unable to authenticate data/iu);
      expect(() => openWalSegment(DATA_KEY, "vault-2", addrA, sealed)).toThrow(
        /unsupported state or unable to authenticate data/iu
      );
      const addrShifted = seg({ startOffset: 100, endOffset: 200 });
      expect(() =>
        openWalSegment(DATA_KEY, VAULT_ID, addrShifted, sealed)
      ).toThrow(/unsupported state or unable to authenticate data/iu);
    });

    test("open rejects a single flipped ciphertext bit", () => {
      const addr = seg();
      const sealed = sealWalSegment(DATA_KEY, VAULT_ID, addr, plain100);
      const tampered = new Uint8Array(sealed);
      tampered[12 + 50]! ^= 0x01; // one bit, mid-ciphertext
      expect(() => openWalSegment(DATA_KEY, VAULT_ID, addr, tampered)).toThrow(
        /unsupported state or unable to authenticate data/iu
      );
    });

    test("open rejects truncation", () => {
      const addr = seg();
      const sealed = sealWalSegment(DATA_KEY, VAULT_ID, addr, plain100);
      expect(() =>
        openWalSegment(
          DATA_KEY,
          VAULT_ID,
          addr,
          sealed.subarray(0, sealed.length - 1)
        )
      ).toThrow(/unsupported state or unable to authenticate data/iu);
      expect(() =>
        openWalSegment(DATA_KEY, VAULT_ID, addr, sealed.subarray(0, 10))
      ).toThrow(/truncated/u);
      expect(() =>
        openWalSegment(DATA_KEY, VAULT_ID, addr, new Uint8Array(0))
      ).toThrow(/truncated/u);
    });

    test("open rejects a seal under a different data key", () => {
      const addr = seg();
      const otherKey = new Uint8Array(32).fill(0x5b);
      const sealed = sealWalSegment(otherKey, VAULT_ID, addr, plain100);
      expect(() => openWalSegment(DATA_KEY, VAULT_ID, addr, sealed)).toThrow(
        /unsupported state or unable to authenticate data/iu
      );
    });
  });

  describe("sealWalCloser / openWalCloser", () => {
    test("roundtrips (empty payload, tag over the AAD-bound address)", () => {
      const c = closer({ group: 3, endOffset: 4096 });
      const sealed = sealWalCloser(DATA_KEY, VAULT_ID, c);
      expect(sealed).toHaveLength(12 + 0 + 16); // nonce + empty ciphertext + tag
      expect(() => openWalCloser(DATA_KEY, VAULT_ID, c, sealed)).not.toThrow();
    });

    test("is deterministic — a retried closer upload is byte-identical", () => {
      const c = closer({ group: 1, endOffset: 200 });
      expect([...sealWalCloser(DATA_KEY, VAULT_ID, c)]).toStrictEqual([
        ...sealWalCloser(DATA_KEY, VAULT_ID, c),
      ]);
    });

    test("pins the FORMAT.md closer info and AAD strings verbatim", () => {
      const c = closer({ group: 3, endOffset: 4096 });
      const nonce = deriveNonce(
        DATA_KEY,
        `centraid-backup:wal-nonce:vault:${GEN}:3:4096:closed`
      );
      const aad = new TextEncoder().encode(
        `centraid-wal/1:${VAULT_ID}:vault:${GEN}:3:4096:closed`
      );
      const expected = encryptWithNonce(
        DATA_KEY,
        nonce,
        new Uint8Array(0),
        aad
      );
      expect([...sealWalCloser(DATA_KEY, VAULT_ID, c)]).toStrictEqual([
        ...expected,
      ]);
    });

    test("rejects tampering — a provider cannot flip a closer to a different end", () => {
      const c = closer({ endOffset: 200 });
      const sealed = sealWalCloser(DATA_KEY, VAULT_ID, c);
      const tampered = new Uint8Array(sealed);
      tampered[tampered.length - 1]! ^= 0x01;
      expect(() => openWalCloser(DATA_KEY, VAULT_ID, c, tampered)).toThrow(
        /unsupported state or unable to authenticate data/iu
      );
    });

    test("rejects an address swap — a closer legitimizes exactly one (group, end)", () => {
      const sealed = sealWalCloser(
        DATA_KEY,
        VAULT_ID,
        closer({ group: 0, endOffset: 200 })
      );
      expect(() =>
        openWalCloser(
          DATA_KEY,
          VAULT_ID,
          closer({ group: 0, endOffset: 100 }),
          sealed
        )
      ).toThrow(/unsupported state or unable to authenticate data/iu);
      expect(() =>
        openWalCloser(
          DATA_KEY,
          VAULT_ID,
          closer({ group: 1, endOffset: 200 }),
          sealed
        )
      ).toThrow(/unsupported state or unable to authenticate data/iu);
      expect(() =>
        openWalCloser(
          DATA_KEY,
          "vault-2",
          closer({ group: 0, endOffset: 200 }),
          sealed
        )
      ).toThrow(/unsupported state or unable to authenticate data/iu);
    });

    test("rejects a closer forged without the data key", () => {
      const c = closer();
      const forged = sealWalCloser(new Uint8Array(32).fill(0x99), VAULT_ID, c);
      expect(() => openWalCloser(DATA_KEY, VAULT_ID, c, forged)).toThrow(
        /unsupported state or unable to authenticate data/iu
      );
    });

    test("rejects a sealed SEGMENT presented as a closer (cross-object confusion)", () => {
      const addr = seg({ startOffset: 0, endOffset: 100 });
      const sealedSegment = sealWalSegment(
        DATA_KEY,
        VAULT_ID,
        addr,
        new Uint8Array(100)
      );
      expect(() =>
        openWalCloser(
          DATA_KEY,
          VAULT_ID,
          closer({ group: 0, endOffset: 100 }),
          sealedSegment
        )
      ).toThrow(/unsupported state or unable to authenticate data/iu);
    });
  });

  interface WalRig {
    conn: DatabaseSync;
    walPath: string;
    pageSize: number;
    insert: (val: string) => void;
  }

  async function walRig(): Promise<WalRig> {
    const dir = await tempDir();
    const dbPath = path.join(dir, "rig.db");
    const conn = new DatabaseSync(dbPath);
    cleanups.push(async () => {
      try {
        conn.close();
      } catch {
        // Intentionally empty.
      }
    });
    conn.exec("PRAGMA journal_mode=WAL");
    conn.exec("PRAGMA synchronous=FULL");
    conn.exec("PRAGMA wal_autocheckpoint=0");
    conn.exec("PRAGMA cache_size=2");
    conn.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY, val TEXT NOT NULL)");
    const { page_size: pageSize } = conn.prepare("PRAGMA page_size").get() as {
      page_size: number;
    };
    const stmt = conn.prepare("INSERT INTO rows (val) VALUES (?)");
    return {
      conn,
      walPath: `${dbPath}-wal`,
      pageSize,
      insert: (val) => void stmt.run(val),
    };
  }

  function walBytes(rig: WalRig): Uint8Array {
    return new Uint8Array(fss.readFileSync(rig.walPath));
  }

  describe("lastCommitBoundary / walPageSize / walSalts against a real WAL", () => {
    test("validates the rolling checksums of a committed real WAL", async () => {
      const rig = await walRig();
      const bytes = walBytes(rig);
      expect(validateCommittedWal(bytes)).toMatchObject({
        validEndOffset: bytes.length,
        lastCommitOffset: bytes.length,
      });
    });

    test("stops before an AEAD-valid but checksum-corrupted frame", async () => {
      const rig = await walRig();
      const bytes = Buffer.from(walBytes(rig));
      bytes[bytes.length - 1]! ^= 0xff;
      const scan = scanWalPrefix(bytes);
      expect(scan.validEndOffset).toBeLessThan(bytes.length);
      expect(() => validateCommittedWal(bytes)).toThrow(/checksum|salt/u);
    });
    test("idle WAL: the last frame is a commit, so the boundary IS the file size", async () => {
      const rig = await walRig();
      for (let i = 0; i < 5; i++) rig.insert(`row-${i}`);
      const bytes = walBytes(rig);
      expect(bytes.length).toBeGreaterThan(WAL_HEADER_BYTES);
      expect((bytes.length - WAL_HEADER_BYTES) % (24 + rig.pageSize)).toBe(0);
      expect(lastCommitBoundary(bytes, 0, rig.pageSize)).toBe(bytes.length);
    });

    test("an uncommitted spilled tail is excluded; ROLLBACK does not move the boundary", async () => {
      const rig = await walRig();
      for (let i = 0; i < 5; i++) rig.insert(`row-${i}`);
      const preBegin = walBytes(rig).length;
      expect(lastCommitBoundary(walBytes(rig), 0, rig.pageSize)).toBe(preBegin);

      rig.conn.exec("BEGIN");
      const big = "x".repeat(2000);
      for (let i = 0; i < 30; i++) rig.insert(`${big}-${i}`);
      const mid = walBytes(rig);
      expect(mid.length).toBeGreaterThan(preBegin);
      expect(lastCommitBoundary(mid, 0, rig.pageSize)).toBe(preBegin);

      rig.conn.exec("ROLLBACK");
      const post = walBytes(rig);
      expect(lastCommitBoundary(post, 0, rig.pageSize)).toBe(preBegin);
    });

    test("rolled-back bytes are OVERWRITTEN in place by the next commits (why segments end on commits)", async () => {
      const rig = await walRig();
      for (let i = 0; i < 5; i++) rig.insert(`row-${i}`);
      const preBegin = walBytes(rig).length;
      rig.conn.exec("BEGIN");
      const big = "x".repeat(2000);
      for (let i = 0; i < 30; i++) rig.insert(`${big}-${i}`);
      rig.conn.exec("ROLLBACK");
      const rolledBackSize = walBytes(rig).length;
      for (let i = 0; i < 3; i++) rig.insert(`after-${i}`);
      const full = walBytes(rig);
      const boundary = lastCommitBoundary(full, 0, rig.pageSize);
      expect(boundary).toBeGreaterThan(preBegin);
      expect(boundary).toBeLessThan(rolledBackSize);
      expect(full).toHaveLength(rolledBackSize);
    });

    test("a range starting at a prior commit boundary (baseOffset > 0) finds the next commits", async () => {
      const rig = await walRig();
      for (let i = 0; i < 5; i++) rig.insert(`row-${i}`);
      const b1 = lastCommitBoundary(walBytes(rig), 0, rig.pageSize);
      for (let i = 0; i < 4; i++) rig.insert(`more-${i}`);
      const full = walBytes(rig);
      const b2 = lastCommitBoundary(full, 0, rig.pageSize);
      expect(b2).toBeGreaterThan(b1);
      expect(lastCommitBoundary(full.subarray(b1), b1, rig.pageSize)).toBe(b2);
    });

    test("a range with no completed commit frame returns baseOffset itself", async () => {
      const rig = await walRig();
      rig.insert("row");
      const full = walBytes(rig);
      const b = lastCommitBoundary(full, 0, rig.pageSize);
      expect(lastCommitBoundary(full.subarray(b), b, rig.pageSize)).toBe(b);
      expect(
        lastCommitBoundary(full.subarray(0, WAL_HEADER_BYTES), 0, rig.pageSize)
      ).toBe(0);
      expect(lastCommitBoundary(new Uint8Array(0), 0, rig.pageSize)).toBe(0);
    });

    test("a misaligned baseOffset is an error, never a silent misparse", async () => {
      const rig = await walRig();
      for (let i = 0; i < 3; i++) rig.insert(`row-${i}`);
      const full = walBytes(rig);
      expect(() =>
        lastCommitBoundary(full.subarray(33), 33, rig.pageSize)
      ).toThrow(/not frame-aligned/u);
      expect(() =>
        lastCommitBoundary(full.subarray(16), 16, rig.pageSize)
      ).toThrow(/not frame-aligned/u);
    });

    test("walPageSize reads the real header page size; walSalts change across checkpoints", async () => {
      const rig = await walRig();
      rig.insert("row-a");
      const header1 = walBytes(rig).subarray(0, WAL_HEADER_BYTES);
      expect(walPageSize(header1)).toBe(rig.pageSize);
      const salts1 = walSalts(header1);

      const cp = rig.conn.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
        busy: number;
      };
      expect(cp.busy).toBe(0);
      expect(fss.statSync(rig.walPath).size).toBe(0);
      rig.insert("row-b");
      const header2 = walBytes(rig).subarray(0, WAL_HEADER_BYTES);
      const salts2 = walSalts(header2);
      expect(salts2).not.toStrictEqual(salts1);
    });

    test("walPageSize / walSalts reject garbage and truncated headers", () => {
      expect(() => walPageSize(new Uint8Array(31))).toThrow(/truncated/u);
      expect(() => walSalts(new Uint8Array(31))).toThrow(/truncated/u);
      const garbage = new Uint8Array(32).fill(0x41);
      expect(() => walPageSize(garbage)).toThrow(/not a wal header/u);
      const badPage = new Uint8Array(32);
      new DataView(badPage.buffer).setUint32(0, 0x377f0682);
      new DataView(badPage.buffer).setUint32(8, 17);
      expect(() => walPageSize(badPage)).toThrow(/implausible/u);
    });
  });

  describe(planWalReplay, () => {
    test("PITR keeps an earlier shorter same-start segment when the longer retry is after the cut", () => {
      const short = seg({ startOffset: 0, endOffset: 100, tickMs: 1000 });
      const lateLong = seg({ startOffset: 0, endOffset: 150, tickMs: 1100 });
      const plan = planWalReplay(listing([lateLong, short]), {
        generation: GEN,
        cutTickMs: 1000,
      });
      expect(plan.segments).toStrictEqual([short]);
      expect(plan.lastTickMs).toBe(1000);
    });
    const opts = { generation: GEN };

    test("plans a happy chain across two groups through the closer", () => {
      const s1 = seg({
        group: 0,
        startOffset: 0,
        endOffset: 100,
        tickMs: 1000,
      });
      const s2 = seg({
        group: 0,
        startOffset: 100,
        endOffset: 200,
        tickMs: 2000,
      });
      const s3 = seg({
        group: 1,
        startOffset: 0,
        endOffset: 150,
        tickMs: 3000,
      });
      const plan = planWalReplay(
        listing([s3, s1, s2], [closer({ group: 0, endOffset: 200 })]),
        opts
      );
      expect(plan.segments).toStrictEqual([s1, s2, s3]);
      expect(plan.lastTickMs).toBe(3000);
      expect(plan.truncatedByHole).toBe(false);
    });

    test("a missing middle segment truncates the plan at the hole", () => {
      const s1 = seg({
        group: 0,
        startOffset: 0,
        endOffset: 100,
        tickMs: 1000,
      });
      const s3 = seg({
        group: 0,
        startOffset: 200,
        endOffset: 300,
        tickMs: 3000,
      });
      const plan = planWalReplay(
        listing([s1, s3], [closer({ group: 0, endOffset: 300 })]),
        opts
      );
      expect(plan.segments).toStrictEqual([s1]);
      expect(plan.lastTickMs).toBe(1000);
      expect(plan.truncatedByHole).toBe(true);
    });

    test("group advance WITHOUT a closer stops the plan (page-mixing defense)", () => {
      const s1 = seg({
        group: 0,
        startOffset: 0,
        endOffset: 100,
        tickMs: 1000,
      });
      const s2 = seg({ group: 1, startOffset: 0, endOffset: 50, tickMs: 2000 });
      const plan = planWalReplay(listing([s1, s2], []), opts);
      expect(plan.segments).toStrictEqual([s1]);
      expect(plan.truncatedByHole).toBe(true);
    });

    test("a closer whose end is PAST the chained offset does not permit advance (missing tail)", () => {
      const s1 = seg({
        group: 0,
        startOffset: 0,
        endOffset: 100,
        tickMs: 1000,
      });
      const s2 = seg({ group: 1, startOffset: 0, endOffset: 50, tickMs: 2000 });
      const plan = planWalReplay(
        listing([s1, s2], [closer({ group: 0, endOffset: 200 })]),
        opts
      );
      expect(plan.segments).toStrictEqual([s1]);
      expect(plan.truncatedByHole).toBe(true);
    });

    test("a segment chaining PAST its group closer end is a producer anomaly: stop", () => {
      const s1 = seg({
        group: 0,
        startOffset: 0,
        endOffset: 100,
        tickMs: 1000,
      });
      const s2 = seg({
        group: 0,
        startOffset: 100,
        endOffset: 250,
        tickMs: 2000,
      });
      const plan = planWalReplay(
        listing([s1, s2], [closer({ group: 0, endOffset: 100 })]),
        opts
      );
      expect(plan.segments).toStrictEqual([s1]);
      expect(plan.truncatedByHole).toBe(true);
    });

    test("a stale same-start SHORTER duplicate is skipped, not a hole", () => {
      const s1 = seg({
        group: 0,
        startOffset: 0,
        endOffset: 100,
        tickMs: 1000,
      });
      const s2long = seg({
        group: 0,
        startOffset: 100,
        endOffset: 200,
        tickMs: 2000,
      });
      const s2short = seg({
        group: 0,
        startOffset: 100,
        endOffset: 150,
        tickMs: 1500,
      });
      const plan = planWalReplay(listing([s1, s2short, s2long]), opts);
      expect(plan.segments).toStrictEqual([s1, s2long]);
      expect(plan.truncatedByHole).toBe(false);
    });

    test("of two same-start duplicates the LONGER range wins (crash-retry re-read)", () => {
      const shortSeg = seg({
        group: 0,
        startOffset: 0,
        endOffset: 100,
        tickMs: 1000,
      });
      const longSeg = seg({
        group: 0,
        startOffset: 0,
        endOffset: 150,
        tickMs: 1100,
      });
      const next = seg({
        group: 0,
        startOffset: 150,
        endOffset: 220,
        tickMs: 2000,
      });
      const plan = planWalReplay(listing([shortSeg, longSeg, next]), opts);
      expect(plan.segments).toStrictEqual([longSeg, next]);
      expect(plan.truncatedByHole).toBe(false);
    });

    test("a missing FIRST segment (no offset-0 chain start) plans nothing", () => {
      const s = seg({
        group: 0,
        startOffset: 100,
        endOffset: 200,
        tickMs: 1000,
      });
      const plan = planWalReplay(listing([s]), opts);
      expect(plan.segments).toStrictEqual([]);
      expect(plan.lastTickMs).toBe(-1);
      expect(plan.truncatedByHole).toBe(true);
    });

    test("a group skip (0 closed, 2 present, 1 missing) is a hole", () => {
      const s1 = seg({
        group: 0,
        startOffset: 0,
        endOffset: 100,
        tickMs: 1000,
      });
      const s3 = seg({ group: 2, startOffset: 0, endOffset: 50, tickMs: 3000 });
      const plan = planWalReplay(
        listing(
          [s1, s3],
          [
            closer({ group: 0, endOffset: 100 }),
            closer({ group: 2, endOffset: 50 }),
          ]
        ),
        opts
      );
      expect(plan.segments).toStrictEqual([s1]);
      expect(plan.truncatedByHole).toBe(true);
    });

    test("segments of other generations are ignored entirely", () => {
      const mine = seg({
        group: 0,
        startOffset: 0,
        endOffset: 100,
        tickMs: 1000,
      });
      const otherGen = seg({
        generation: GEN2,
        group: 0,
        startOffset: 0,
        endOffset: 999,
        tickMs: 500,
      });
      const plan = planWalReplay(
        listing(
          [otherGen, mine],
          [closer({ generation: GEN2, group: 0, endOffset: 999 })]
        ),
        opts
      );
      expect(plan.segments).toStrictEqual([mine]);
      expect(plan.truncatedByHole).toBe(false);
    });

    test("cutTickMs stops BEFORE the first later-tick segment; mid-group cuts are allowed", () => {
      const s1 = seg({
        group: 0,
        startOffset: 0,
        endOffset: 100,
        tickMs: 1000,
      });
      const s2 = seg({
        group: 0,
        startOffset: 100,
        endOffset: 200,
        tickMs: 2000,
      });
      const s3 = seg({
        group: 0,
        startOffset: 200,
        endOffset: 300,
        tickMs: 3000,
      });
      const all = listing([s1, s2, s3], [closer({ group: 0, endOffset: 300 })]);
      const plan = planWalReplay(all, { ...opts, cutTickMs: 2000 }); // cut == tick is inclusive
      expect(plan.segments).toStrictEqual([s1, s2]);
      expect(plan.lastTickMs).toBe(2000);
      expect(plan.truncatedByHole).toBe(false); // a requested cut is NOT a hole
      const before = planWalReplay(all, { ...opts, cutTickMs: 999 });
      expect(before.segments).toStrictEqual([]);
      expect(before.lastTickMs).toBe(-1);
      expect(before.truncatedByHole).toBe(false);
    });

    test("cutting exactly at a group boundary keeps the closed group, drops the next", () => {
      const s1 = seg({
        group: 0,
        startOffset: 0,
        endOffset: 100,
        tickMs: 1000,
      });
      const s2 = seg({ group: 1, startOffset: 0, endOffset: 50, tickMs: 2000 });
      const plan = planWalReplay(
        listing([s1, s2], [closer({ group: 0, endOffset: 100 })]),
        {
          ...opts,
          cutTickMs: 1000,
        }
      );
      expect(plan.segments).toStrictEqual([s1]);
      expect(plan.truncatedByHole).toBe(false);
    });

    test("an empty listing plans nothing without claiming a hole", () => {
      const plan = planWalReplay(listing([]), opts);
      expect(plan).toStrictEqual({
        segments: [],
        lastTickMs: -1,
        truncatedByHole: false,
      });
    });
  });

  function marker(over: Partial<WalTickMarker> = {}): WalTickMarker {
    return {
      generation: GEN,
      tickMs: 1000,
      position: { group: 0, endOffset: 100 },
      ...over,
    };
  }

  describe("walTickMarkerKey / parseWalTickMarkerKey", () => {
    test("emits the exact FORMAT.md key shape and roundtrips", () => {
      const key = walTickMarkerKey(marker({ tickMs: 1752480060000 }));
      expect(key).toBe(`wal/tick/${GEN}/1752480060000`);
      expect(parseWalTickMarkerKey(key)).toStrictEqual({
        generation: GEN,
        tickMs: 1752480060000,
      });
    });

    test("parse rejects segment keys, closer keys, and malformed marker keys", () => {
      expect(parseWalTickMarkerKey(walSegmentKey(seg()))).toBeNull();
      expect(parseWalTickMarkerKey(walGroupCloserKey(closer()))).toBeNull();
      expect(parseWalTickMarkerKey(`wal/tick/${GEN}/1000`)).toBeNull();
      expect(parseWalTickMarkerKey(`wal/tick/${GEN}-${GEN2}/1000`)).toBeNull();
    });

    test("a marker key never collides with the stream it describes", () => {
      expect(walTickMarkerKey(marker())).not.toContain(
        `/${WAL_DB_FILES.vault.replace(".db", "")}/`
      );
      expect(parseWalSegmentKey(walTickMarkerKey(marker()))).toBeNull();
    });
  });

  describe("sealWalTickMarker / openWalTickMarker", () => {
    const addrOf = (m: WalTickMarker) => ({
      generation: m.generation,
      tickMs: m.tickMs,
    });

    test("roundtrips the recorded position", () => {
      const m = marker({ position: { group: 2, endOffset: 0 } });
      const opened = openWalTickMarker(
        DATA_KEY,
        VAULT_ID,
        addrOf(m),
        sealWalTickMarker(DATA_KEY, VAULT_ID, m)
      );
      expect(opened).toStrictEqual(m);
    });

    test("re-sealing the same marker is BYTE-IDENTICAL (idempotent PUT, and no nonce reuse)", () => {
      const m = marker();
      const a = sealWalTickMarker(DATA_KEY, VAULT_ID, m);
      const b = sealWalTickMarker(DATA_KEY, VAULT_ID, { ...m });
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    });

    test("RELABELLING the tick in the key fails the tag", () => {
      const m = marker({ tickMs: 5000 });
      const sealed = sealWalTickMarker(DATA_KEY, VAULT_ID, m);
      expect(() =>
        openWalTickMarker(
          DATA_KEY,
          VAULT_ID,
          { ...addrOf(m), tickMs: 3000 },
          sealed
        )
      ).toThrow(/unsupported state or unable to authenticate data/iu);
    });

    test("SWAPPING a marker from another generation fails the tag", () => {
      const other = marker({ generation: GEN2 });
      const sealed = sealWalTickMarker(DATA_KEY, VAULT_ID, other);
      expect(() =>
        openWalTickMarker(DATA_KEY, VAULT_ID, addrOf(marker()), sealed)
      ).toThrow(/unsupported state or unable to authenticate data/iu);
    });

    test("a marker sealed for another vault fails the tag", () => {
      const m = marker();
      const sealed = sealWalTickMarker(DATA_KEY, "other-vault", m);
      expect(() =>
        openWalTickMarker(DATA_KEY, VAULT_ID, addrOf(m), sealed)
      ).toThrow(/unsupported state or unable to authenticate data/iu);
    });

    test("the nonce info + AAD strings are pinned to FORMAT.md verbatim", () => {
      const m = marker({ tickMs: 7000 });
      const info = `centraid-backup:wal-nonce:tick:${GEN}:7000`;
      const aad = new TextEncoder().encode(
        `centraid-wal/1:${VAULT_ID}:tick:${GEN}:7000`
      );
      const payload = new TextEncoder().encode(
        `{"position":{"endOffset":100,"group":0},"tickMs":7000,"v":1}`
      );
      const expected = encryptWithNonce(
        DATA_KEY,
        deriveNonce(DATA_KEY, info),
        payload,
        aad
      );
      expect(
        Buffer.from(sealWalTickMarker(DATA_KEY, VAULT_ID, m)).equals(
          Buffer.from(expected)
        )
      ).toBe(true);
    });
  });

  describe(reachedPosition, () => {
    const opts = { generation: GEN };

    test("an empty plan is the base itself: (0, 0)", () => {
      const l = listing([]);
      expect(reachedPosition(planWalReplay(l, opts), l, opts)).toStrictEqual({
        group: 0,
        endOffset: 0,
      });
    });

    test("a mid-group chain is (group, endOffset)", () => {
      const l = listing([
        seg({ group: 0, startOffset: 0, endOffset: 100, tickMs: 1000 }),
        seg({ group: 0, startOffset: 100, endOffset: 220, tickMs: 2000 }),
      ]);
      expect(reachedPosition(planWalReplay(l, opts), l, opts)).toStrictEqual({
        group: 0,
        endOffset: 220,
      });
    });

    test("a chain that reaches its group CLOSER normalizes to (group + 1, 0)", () => {
      const l = listing(
        [seg({ group: 0, startOffset: 0, endOffset: 220, tickMs: 1000 })],
        [closer({ group: 0, endOffset: 220 })]
      );
      expect(reachedPosition(planWalReplay(l, opts), l, opts)).toStrictEqual({
        group: 1,
        endOffset: 0,
      });
    });

    test("the SAME chain WITHOUT the closer stays at (group, end) — the tail-closer tell", () => {
      const l = listing([
        seg({ group: 0, startOffset: 0, endOffset: 220, tickMs: 1000 }),
      ]);
      expect(reachedPosition(planWalReplay(l, opts), l, opts)).toStrictEqual({
        group: 0,
        endOffset: 220,
      });
    });
  });

  describe(planMarkedReplay, () => {
    function streamListing(): WalStreamListing {
      return listing([
        seg({ group: 0, startOffset: 0, endOffset: 100, tickMs: 1000 }),
        seg({ group: 0, startOffset: 100, endOffset: 200, tickMs: 2000 }),
        seg({ group: 0, startOffset: 200, endOffset: 300, tickMs: 3000 }),
      ]);
    }

    function markers(): WalTickMarker[] {
      return [
        marker({ tickMs: 1000, position: { group: 0, endOffset: 100 } }),
        marker({ tickMs: 2000, position: { group: 0, endOffset: 200 } }),
        marker({ tickMs: 3000, position: { group: 0, endOffset: 300 } }),
      ];
    }

    test("an intact stream cuts at the newest marker", () => {
      const r = planMarkedReplay({
        listing: streamListing(),
        generation: GEN,
        markers: markers(),
      });
      expect(r.cutTickMs).toBe(3000);
      expect(r.newestMarkerTickMs).toBe(3000);
      expect(r.plan.lastTickMs).toBe(3000);
    });

    test("a LOST TAIL (listing simply ends — no hole) walks back to the last provable marker", () => {
      const l = streamListing();
      l.segments = l.segments.slice(0, 2);
      const r = planMarkedReplay({
        listing: l,
        generation: GEN,
        markers: markers(),
      });
      expect(r.cutTickMs).toBe(2000);
      expect(r.newestMarkerTickMs).toBe(3000);
      expect(r.plan.lastTickMs).toBe(2000);
    });

    test("an IDLE stream (no new segments, unchanged position) is NOT a truncation", () => {
      const l = listing([
        seg({ group: 0, startOffset: 0, endOffset: 100, tickMs: 1000 }),
      ]);
      const idleMarkers = markers().map((m) => ({
        ...m,
        position: { group: 0, endOffset: 100 },
      }));
      const r = planMarkedReplay({
        listing: l,
        generation: GEN,
        markers: idleMarkers,
      });
      expect(r.cutTickMs).toBe(3000);
      expect(r.newestMarkerTickMs).toBe(3000);
      expect(r.plan.lastTickMs).toBe(1000);
    });

    test("a marker whose GROUP CLOSER is missing is unsatisfiable", () => {
      const rolled = markers();
      rolled[2] = marker({
        tickMs: 3000,
        position: { group: 1, endOffset: 0 },
      });
      const r = planMarkedReplay({
        listing: streamListing(),
        generation: GEN,
        markers: rolled,
      });
      expect(r.cutTickMs).toBe(2000);

      const closed = streamListing();
      closed.closers = [closer({ group: 0, endOffset: 300 })];
      const ok = planMarkedReplay({
        listing: closed,
        generation: GEN,
        markers: rolled,
      });
      expect(ok.cutTickMs).toBe(3000);
    });

    test("a HOLE before a marker makes it unsatisfiable, however the arithmetic falls", () => {
      const holed = streamListing();
      holed.segments = [holed.segments[0]!, holed.segments[2]!]; // the [100,200) middle is gone
      const r = planMarkedReplay({
        listing: holed,
        generation: GEN,
        markers: markers(),
      });
      expect(r.cutTickMs).toBe(1000);
      expect(r.plan.lastTickMs).toBe(1000);
    });

    test("markers naming ANOTHER generation are never considered", () => {
      const foreign = markers().map((m) => ({ ...m, generation: GEN2 }));
      const r = planMarkedReplay({
        listing: streamListing(),
        generation: GEN,
        markers: foreign,
      });
      expect(r.cutTickMs).toBe(-1);
    });

    test("NO markers at all ⇒ the base floor, however much the listing offers", () => {
      const r = planMarkedReplay({
        listing: streamListing(),
        generation: GEN,
        markers: [],
      });
      expect(r.cutTickMs).toBe(-1);
      expect(r.newestMarkerTickMs).toBe(-1);
      expect(r.plan.segments).toStrictEqual([]);
    });

    test("an explicit point-in-time cut selects the newest marker AT OR BEFORE it", () => {
      const r = planMarkedReplay({
        listing: streamListing(),
        generation: GEN,
        markers: markers(),
        cutTickMs: 2500,
      });
      expect(r.cutTickMs).toBe(2000);
      expect(r.newestMarkerTickMs).toBe(2000);
      expect(r.plan.lastTickMs).toBe(2000);
    });

    test("a cut before any marker is the base, and is not a truncation", () => {
      const r = planMarkedReplay({
        listing: streamListing(),
        generation: GEN,
        markers: markers(),
        cutTickMs: 999,
      });
      expect(r.cutTickMs).toBe(-1);
      expect(r.newestMarkerTickMs).toBe(-1);
    });
  });
});
