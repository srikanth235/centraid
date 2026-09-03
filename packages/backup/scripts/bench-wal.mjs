#!/usr/bin/env node
// governance: allow-repo-hygiene file-size-limit (#408) the benchmark is one reproducible 1 GiB/10 GiB capture-and-restore experiment; splitting it would duplicate the measurement harness and risk incomparable scenarios

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";

const here = import.meta.dirname;
const dist = path.join(here, "..", "dist");
const vaultDist = path.join(here, "..", "..", "vault", "dist");

const {
  lastCommitBoundary,
  walPageSize,
  sealWalSegment,
  sealWalCloser,
  newWalGeneration,
} = await import(path.join(dist, "wal-format.js"));
const { replayWalSegments } = await import(path.join(dist, "wal-restore.js"));
const { FsObjectStore } = await import(path.join(dist, "object-store.js"));
const { PART_BYTES, partStream } = await import(path.join(dist, "parts.js"));
const { chunkId, deriveNonce, encryptWithNonce, decrypt } = await import(
  path.join(dist, "crypto.js")
);
const { cloneDbFile } = await import(path.join(vaultDist, "wal-shipper.js"));

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const SIZE_MB = Number(flag("--size-mb", "1024"));
const WORK =
  flag("--work-dir", null) ?? mkdtempSync(path.join(tmpdir(), "bench-wal-"));
mkdirSync(WORK, { recursive: true });

const DAY_TICKS = 1440; // one shipper tick (and one transaction) per minute
const ROWS_PER_TICK = 5; // 7,200 rows/day
const ROW_BYTES = 200; // 200 B of hex text per row => 1.44 MB/day of row payload
const THRESHOLD = 16 * 1024 * 1024; // shipper's WAL group-rollover threshold

const MiB = 1024 * 1024;
const fmtMB = (b) => `${(b / MiB).toFixed(1)} MiB`;
const secs = (t0) => (performance.now() - t0) / 1000;

const dfBytes = () => {
  const out = execFileSync("df", ["-k", WORK], { encoding: "utf8" })
    .trim()
    .split("\n")[1];
  return Number(out.split(/\s+/u)[3]) * 1024; // available KiB -> bytes
};
const freeAtStart = dfBytes();
let peakPhysical = 0;
const marks = [];
const mark = (label) => {
  const used = freeAtStart - dfBytes();
  peakPhysical = Math.max(peakPhysical, used);
  marks.push({ label, used });
  return used;
};

const sha256FileStreamed = async (file) => {
  const h = createHash("sha256");
  await pipeline(
    createReadStream(file, { highWaterMark: 4 * MiB }),
    async function* (src) {
      for await (const c of src) h.update(c);
      yield Buffer.alloc(0);
    }
  );
  return h.digest("hex");
};

const runT0 = performance.now();
const dir = path.join(WORK, `vault-${SIZE_MB}mb`);
mkdirSync(dir, { recursive: true });
const dbPath = path.join(dir, "vault.db");
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`])
  rmSync(f, { force: true });

console.log(`\n== bench-wal: building a ~${SIZE_MB} MiB vault at ${dir}`);
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA wal_autocheckpoint = 0");
db.exec("CREATE TABLE bulk (id INTEGER PRIMARY KEY, v BLOB)");
db.exec("CREATE TABLE day (id INTEGER PRIMARY KEY, v TEXT)");
{
  db.exec("PRAGMA synchronous = OFF");
  const stmt = db.prepare("INSERT INTO bulk (v) VALUES (?)");
  const chunk = randomBytes(64 * 1024); // incompressible, so no free lunch anywhere
  const t0 = performance.now();
  const target = SIZE_MB * MiB;
  let lastLog = 0;
  for (;;) {
    db.exec("BEGIN");
    for (let i = 0; i < 256; i++) stmt.run(chunk); // 16 MiB per transaction
    db.exec("COMMIT");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const size = statSync(dbPath).size;
    if (size - lastLog >= 1024 * MiB) {
      lastLog = size;
      process.stdout.write(
        `   ...${(size / MiB / 1024).toFixed(1)} GiB at ${secs(t0).toFixed(0)}s\n`
      );
    }
    if (size >= target) break;
  }
  db.exec("PRAGMA synchronous = FULL");
  console.log(
    `   built ${fmtMB(statSync(dbPath).size)} in ${secs(t0).toFixed(1)}s`
  );
}
const buildSecs = secs(runT0);
mark("after build");

db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
const generation = newWalGeneration((n) => randomBytes(n));
const dbSize = statSync(dbPath).size;
console.log(
  `\n== base A (generation start) — production cloneDbFile of ${fmtMB(dbSize)}`
);

const basePath = path.join(dir, "base-A.db");
rmSync(basePath, { force: true });
const freeBeforeClone = dfBytes();
const tCloneA = performance.now();
cloneDbFile(dbPath, basePath);
const cloneASecs = secs(tCloneA);
const cloneAPhysical = Math.max(freeBeforeClone - dfBytes(), 0);
console.log(
  `   cloneDbFile: ${cloneASecs.toFixed(2)}s, ${fmtMB(cloneAPhysical)} physical ` +
    `(logical size ${fmtMB(statSync(basePath).size)})`
);
mark("after base-A clone");
const tHashA = performance.now();
const baseASha = await sha256FileStreamed(basePath);
const hashASecs = secs(tHashA);
console.log(
  `   sha256 of the base (full read):  ${hashASecs.toFixed(1)}s  [${baseASha.slice(0, 12)}]`
);

const dataKey = randomBytes(32);
const dedupKey = randomBytes(32);
const vaultId = "bench-vault";
const storeDir = path.join(WORK, "store");
const store = new FsObjectStore(storeDir);

const readFileStreamOf = async function* (file) {
  const s = createReadStream(file, { highWaterMark: 256 * 1024 });
  for await (const c of s) yield new Uint8Array(c);
};
const sealPart = (plain) => {
  const id = chunkId(dedupKey, plain);
  const nonce = deriveNonce(dataKey, `centraid-backup:chunk-nonce:${id}`);
  return { id, sealed: encryptWithNonce(dataKey, nonce, plain) };
};

const knownChunks = new Set();
const baseAChunks = []; // ordered part ids — the manifest's entry.chunks
let baseAWire = 0;
{
  const t0 = performance.now();
  for await (const plain of partStream(
    readFileStreamOf(basePath),
    PART_BYTES
  )) {
    const { id, sealed } = sealPart(plain);
    baseAChunks.push(id);
    if (!knownChunks.has(id)) {
      knownChunks.add(id);
      await store.put(`chunks/${id}`, sealed);
      baseAWire += sealed.length;
    }
  }
  console.log(`\n== full backup of base A (one-time, O(database))`);
  console.log(
    `   ${baseAChunks.length} parts of ${PART_BYTES / MiB} MiB, ${knownChunks.size} unique ` +
      `-> ${fmtMB(baseAWire)} sealed on the wire in ${secs(t0).toFixed(1)}s`
  );
}
mark("after full base-A upload");

const walPath = `${dbPath}-wal`;
const freeBeforeDay = dfBytes();
let group = 0;
let offset = 0;
let pageSize = null;
let tickMs = Date.now();
let localBytes = 0;
let wireBytes = 0;
let segments = 0;
let rowBytes = 0;
const stmt = db.prepare("INSERT INTO day (v) VALUES (?)");
const tDay = performance.now();
const captureNextTick = async (tick) => {
  if (tick >= DAY_TICKS) return;
  db.exec("BEGIN");
  for (let r = 0; r < ROWS_PER_TICK; r++) {
    const v = randomBytes(ROW_BYTES / 2).toString("hex");
    rowBytes += v.length;
    stmt.run(v);
  }
  db.exec("COMMIT");
  tickMs += 60_000;
  const head = statSync(walPath).size;
  let captured = false;
  if (head >= 32 && head > offset) {
    const buf = readFileSync(walPath);
    pageSize ??= walPageSize(buf.subarray(0, 32));
    const boundary = lastCommitBoundary(buf.subarray(offset), offset, pageSize);
    if (boundary > offset) {
      const plain = buf.subarray(offset, boundary);
      const addr = {
        db: "vault",
        generation,
        group,
        startOffset: offset,
        endOffset: boundary,
        tickMs,
      };
      const sealed = sealWalSegment(dataKey, vaultId, addr, plain);
      await store.put(
        `wal/vault/${generation}/${String(group).padStart(8, "0")}/${String(offset).padStart(12, "0")}-${String(boundary).padStart(12, "0")}-${String(tickMs).padStart(13, "0")}`,
        sealed
      );
      localBytes += plain.length;
      wireBytes += sealed.length;
      segments++;
      offset = boundary;
      captured = true;
    }
  }
  if (captured && head > THRESHOLD) {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const closer = { db: "vault", generation, group, endOffset: offset };
    const sealedCloser = sealWalCloser(dataKey, vaultId, closer);
    await store.put(
      `wal/vault/${generation}/${String(group).padStart(8, "0")}/closed-${String(offset).padStart(12, "0")}`,
      sealedCloser
    );
    wireBytes += sealedCloser.length;
    group++;
    offset = 0;
  }
  return captureNextTick(tick + 1);
};
await captureNextTick(0);
const captureSecs = secs(tDay);
const dayEndSize = statSync(dbPath).size;
const dayPhysical = Math.max(freeBeforeDay - dfBytes(), 0);
const dayWalResidual = statSync(walPath).size;
const dayDbGrowth = Math.max(dayEndSize - dbSize, 0);
const dayCowDerived = dayPhysical - wireBytes - dayDbGrowth - dayWalResidual;
mark("after busy day");

const vacuumPathBytes = dbSize * DAY_TICKS; // VACUUM INTO staging per tick
console.log(`\n== one simulated busy day`);
console.log(
  `   workload: ${DAY_TICKS} transactions x ${ROWS_PER_TICK} rows x ${ROW_BYTES} B ` +
    `= ${DAY_TICKS * ROWS_PER_TICK} rows, ${(rowBytes / MiB).toFixed(2)} MiB of row payload`
);
console.log(`   segments: ${segments} across ${group + 1} group(s)`);
console.log(
  `   local bytes written/day:  ${fmtMB(localBytes)}  (WAL segment files)`
);
console.log(
  `   bytes/day on the wire:    ${fmtMB(wireBytes)}  (sealed segments + closers)`
);
console.log(
  `   volume delta over the day: ${fmtMB(dayPhysical)} physical ` +
    `(= ${fmtMB(wireBytes)} store + ${fmtMB(dayDbGrowth)} db growth + ` +
    `${fmtMB(dayWalResidual)} live WAL + ${fmtMB(dayCowDerived)} base COW divergence, derived)`
);
console.log(
  `   old VACUUM-INTO path at the same cadence would have written ${fmtMB(vacuumPathBytes)}/day ` +
    `locally — ${Math.round(vacuumPathBytes / Math.max(localBytes, 1))}x more`
);
console.log(
  `   capture overhead: ${captureSecs.toFixed(1)}s for the whole day`
);

const restoreDir = path.join(WORK, `restore-${SIZE_MB}mb`);
rmSync(restoreDir, { recursive: true, force: true });
mkdirSync(restoreDir, { recursive: true });
const destDb = path.join(restoreDir, "vault.db");

const tMaterialize = performance.now();
{
  const out = createWriteStream(destDb);
  const materializeNextChunk = async (index) => {
    const id = baseAChunks[index];
    if (id === undefined) return;
    const sealed = await store.get(`chunks/${id}`);
    const plain = decrypt(dataKey, sealed);
    if (!out.write(Buffer.from(plain)))
      await new Promise((resolve) => {
        out.once("drain", resolve);
      });
    await store.delete(`chunks/${id}`); // remote store => no local footprint
    return materializeNextChunk(index + 1);
  };
  await materializeNextChunk(0);
  await new Promise((resolve) => {
    out.end(resolve);
  });
}
const materializeSecs = secs(tMaterialize);
mark("after base materialization");

const tReplay = performance.now();
const outcome = await replayWalSegments({
  store,
  dataKey,
  vaultId,
  destDir: restoreDir,
  generationByDb: { vault: generation },
});
const replaySecs = secs(tReplay);
mark("after replay");
const restoreSecs = materializeSecs + replaySecs;

console.log(`\n== restore (${fmtMB(dbSize)} vault)`);
console.log(
  `   base materialize (unseal ${baseAChunks.length} parts + write): ${materializeSecs.toFixed(1)}s`
);
console.log(
  `   wal replay + integrity_check + foreign_key_check:  ${replaySecs.toFixed(1)}s`
);
console.log(`   FULL RESTORE WALL-CLOCK: ${restoreSecs.toFixed(1)}s`);
console.log(
  `   replayed ${outcome.perDb.vault.segmentsApplied} segments / ` +
    `${outcome.perDb.vault.groupsApplied} group(s), integrity=${outcome.perDb.vault.integrityCheck}`
);
{
  const r = new DatabaseSync(destDb, { readOnly: true });
  const n = r.prepare("SELECT count(*) AS n FROM day").get().n;
  const b = r.prepare("SELECT count(*) AS n FROM bulk").get().n;
  r.close();
  console.log(
    `   restored rows: day=${n} (expected ${DAY_TICKS * ROWS_PER_TICK}), bulk=${b}`
  );
}
rmSync(restoreDir, { recursive: true, force: true });

db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
db.close();
const basePathB = path.join(dir, "base-B.db");
rmSync(basePathB, { force: true });
const freeBeforeCloneB = dfBytes();
const tCloneB = performance.now();
cloneDbFile(dbPath, basePathB); // production path — same function mintBase calls
const cloneBSecs = secs(tCloneB);
const cloneBPhysical = Math.max(freeBeforeCloneB - dfBytes(), 0);
mark("after base-B clone");
const tHashB = performance.now();
await sha256FileStreamed(basePathB);
const hashBSecs = secs(tHashB);

let baseBWire = 0;
let baseBParts = 0;
let baseBNewParts = 0;
const tPartB = performance.now();
for await (const plain of partStream(readFileStreamOf(basePathB), PART_BYTES)) {
  baseBParts++;
  const { id, sealed } = sealPart(plain);
  if (knownChunks.has(id)) continue; // deduped against base A — no upload
  knownChunks.add(id);
  baseBNewParts++;
  baseBWire += sealed.length;
}
const partBSecs = secs(tPartB);
const rebaseSecs = cloneBSecs + hashBSecs + partBSecs;

console.log(
  `\n== the 24h base-cadence break (DEFAULT_BASE_INTERVAL_MS = 24h => every day)`
);
console.log(
  `   cloneDbFile (production): ${cloneBSecs.toFixed(2)}s, ${fmtMB(cloneBPhysical)} physical`
);
console.log(`   sha256: ${hashBSecs.toFixed(1)}s`);
console.log(
  `   re-part + dedup: ${baseBNewParts}/${baseBParts} parts changed -> ` +
    `${fmtMB(baseBWire)} on the wire in ${partBSecs.toFixed(1)}s`
);
console.log(
  `   total re-base cost: ${rebaseSecs.toFixed(1)}s ` +
    `(of which ${(hashBSecs + partBSecs).toFixed(1)}s is reading the whole DB twice)`
);
rmSync(basePath, { force: true });
mark("after retiring base-A");
rmSync(basePathB, { force: true });

const steadyLocal = localBytes + cloneBPhysical;
const steadyWire = wireBytes + baseBWire;
const totalSecs = secs(runT0);
mark("end");

const productionFootprint = dbSize + cloneAPhysical; // live DB + its base clone
console.log(`\n${"=".repeat(72)}`);
console.log(
  `RESULT — ${SIZE_MB} MiB vault (${fmtMB(dbSize)} at base, ${fmtMB(dayEndSize)} at day end)`
);
console.log(`${"=".repeat(72)}`);
console.log(
  `  busy day             ${DAY_TICKS} txns / ${DAY_TICKS * ROWS_PER_TICK} rows / ${(rowBytes / MiB).toFixed(2)} MiB payload`
);
console.log(
  `  LOCAL bytes/day      ${fmtMB(steadyLocal)}   (= ${fmtMB(localBytes)} WAL segments + ${fmtMB(cloneBPhysical)} daily base clone, physical)`
);
console.log(
  `  WIRE bytes/day       ${fmtMB(steadyWire)}   (= ${fmtMB(wireBytes)} segments + ${fmtMB(baseBWire)} changed base parts)`
);
console.log(
  `  restore wall-clock   ${restoreSecs.toFixed(1)}s  (${materializeSecs.toFixed(1)}s materialize + ${replaySecs.toFixed(1)}s replay+checks)`
);
console.log(
  `  peak local disk      ${fmtMB(peakPhysical)} physical (this bench, df delta)`
);
console.log(
  `  prod steady disk     ${fmtMB(productionFootprint)} (live DB + the base clone it keeps)`
);
console.log(`  one-time full backup ${fmtMB(baseAWire)}`);
console.log(
  `  daily O(db) READ     ${fmtMB(dbSize * 2)} (sha256 + re-part), ${(hashBSecs + partBSecs).toFixed(1)}s`
);
console.log(
  `  clone (production)   ${fmtMB(cloneBPhysical)} physical / ${cloneBSecs.toFixed(2)}s ` +
    `— reflink on APFS/btrfs/xfs; a FULL BYTE COPY on ext4, where this line becomes ${fmtMB(dbSize)}`
);
console.log(
  `  measurement run took ${(totalSecs / 60).toFixed(1)} min (build ${(buildSecs / 60).toFixed(1)} min)`
);
console.log(`\n  disk marks:`);
for (const m of marks)
  console.log(`    ${m.label.padEnd(38)} ${fmtMB(m.used)}`);
console.log(
  `\n  MACHINE-READABLE: ${JSON.stringify({
    sizeMb: SIZE_MB,
    dbSize,
    dayEndSize,
    rowBytes,
    segments,
    localSegmentBytesPerDay: localBytes,
    localBaseClonePerDay: cloneBPhysical,
    localTotalPerDay: steadyLocal,
    wireSegmentsPerDay: wireBytes,
    wireBasePartsPerDay: baseBWire,
    wireTotalPerDay: steadyWire,
    baseBNewParts,
    baseBParts,
    restoreSecs,
    materializeSecs,
    replaySecs,
    peakPhysical,
    productionFootprint,
    oneTimeFullBackup: baseAWire,
    cloneASecs,
    cloneAPhysical,
    cloneBSecs,
    cloneBPhysical,
    dayPhysical,
    dayDbGrowth,
    dayWalResidual,
    dayCowDerived,
    rebaseReadSecs: hashBSecs + partBSecs,
    hashASecs,
    captureSecs,
    totalSecs,
    buildSecs,
  })}`
);
console.log(`\nwork dir: ${WORK} (delete it when done)\n`);
