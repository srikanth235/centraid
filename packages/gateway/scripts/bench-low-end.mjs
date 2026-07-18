#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serve } from '../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.dirname(here);
const args = process.argv.slice(2);

function option(name, fallback) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

function positiveInteger(name, fallback) {
  const value = Number(option(name, String(fallback)));
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function ratePerHour(delta, durationMs) {
  return durationMs > 0 ? (delta * 3_600_000) / durationMs : 0;
}

async function readProcIo() {
  try {
    const text = await fs.readFile('/proc/self/io', 'utf8');
    return Object.fromEntries(
      text
        .trim()
        .split('\n')
        .map((line) => line.split(':').map((part) => part.trim()))
        .map(([key, value]) => [key, Number(value)]),
    );
  } catch {
    return undefined;
  }
}

function resourceCounters() {
  const usage = process.resourceUsage();
  return {
    fsWrites: usage.fsWrite,
    contextSwitches: usage.voluntaryContextSwitches + usage.involuntaryContextSwitches,
  };
}

async function directoryBytes(dir) {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(target);
    else if (entry.isFile()) total += (await fs.stat(target)).size;
  }
  return total;
}

function quietLogger() {
  return { info: () => undefined, warn: () => undefined, error: () => undefined };
}

async function markTraceEpoch(suffix) {
  const marker = process.env.CENTRAID_BENCH_TRACE_MARKER;
  if (marker) await fs.writeFile(`${marker}.${suffix}`, '');
}

async function runInternal() {
  const writes = positiveInteger('--requests', 120);
  const concurrency = positiveInteger('--concurrency', 4);
  // Cover issue #456's active 30/60-second service cadences so idle rates
  // include real timer work instead of extrapolating a scheduler blip.
  const idleMs = positiveInteger('--idle-ms', 65_000);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-low-end-bench-'));
  let handle;
  try {
    handle = await serve({
      paths: { vaultDir: path.join(root, 'vault'), prefsFile: path.join(root, 'prefs.json') },
      logger: quietLogger(),
      token: 'centraid-low-end-benchmark-token',
    });
    const headers = {
      Authorization: `Bearer ${handle.token}`,
      'content-type': 'application/json',
    };

    // Warm routing, auth, prepared statements, and the native lag histogram
    // without adding unmeasured writes to the fsync denominator.
    for (let i = 0; i < 12; i += 1) {
      const response = await fetch(`${handle.url}/centraid/_vault/status`, { headers });
      if (!response.ok)
        throw new Error(`warmup failed: ${response.status} ${await response.text()}`);
    }

    // Boot/install prewarming has its own latency metrics. Start the CI lag
    // epoch here so peak p99 describes the authenticated write workload, not
    // one-time esbuild/module initialization that completed before readiness.
    handle.health.resetPerformanceMetrics();

    const resourcesBeforeWrites = resourceCounters();
    const procBeforeWrites = await readProcIo();
    const writeLatencies = [];
    const readLatencies = [];
    let maxRssBytes = process.memoryUsage().rss;
    let next = 0;
    const workload = [];
    for (let index = 0; index < writes; index += 1) {
      workload.push({ kind: 'write', shape: index % 2 === 0 ? 'core.party' : 'core.place', index });
      if ((index + 1) % 4 === 0) workload.push({ kind: 'read', shape: 'vault.status', index });
    }
    const reads = workload.length - writes;

    const worker = async () => {
      while (next < workload.length) {
        const operation = workload[next++];
        if (!operation) return;
        const { index } = operation;
        const now = new Date().toISOString();
        const started = performance.now();
        const response =
          operation.kind === 'read'
            ? await fetch(`${handle.url}/centraid/_vault/status`, { headers })
            : await fetch(`${handle.url}/centraid/_vault/atlas/browse/insert`, {
                method: 'POST',
                headers,
                body: JSON.stringify(
                  operation.shape === 'core.party'
                    ? {
                        table: 'core.party',
                        values: {
                          kind: index % 4 === 0 ? 'org' : 'person',
                          display_name: `Gateway benchmark party ${index}`,
                          created_at: now,
                          updated_at: now,
                          ontology_version: '1.3',
                        },
                      }
                    : {
                        table: 'core.place',
                        values: {
                          name: `Gateway benchmark place ${index}`,
                          kind: index % 4 === 1 ? 'work' : 'venue',
                          created_at: now,
                        },
                      },
                ),
              });
        const elapsed = performance.now() - started;
        if (!response.ok) {
          throw new Error(
            `${operation.kind} ${index} failed: ${response.status} ${await response.text()}`,
          );
        }
        (operation.kind === 'write' ? writeLatencies : readLatencies).push(elapsed);
        maxRssBytes = Math.max(maxRssBytes, process.memoryUsage().rss);
      }
    };

    await markTraceEpoch('start');
    const writeStarted = performance.now();
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    const writeDurationMs = performance.now() - writeStarted;
    await markTraceEpoch('end');
    const resourcesAfterWrites = resourceCounters();
    const procAfterWrites = await readProcIo();
    const diskWriteBytes =
      procBeforeWrites && procAfterWrites
        ? procAfterWrites.write_bytes - procBeforeWrites.write_bytes
        : null;

    const healthResponse = await fetch(`${handle.url}/centraid/_gateway/health`, { headers });
    if (!healthResponse.ok) throw new Error(`health failed: ${healthResponse.status}`);
    const health = await healthResponse.json();
    maxRssBytes = Math.max(
      maxRssBytes,
      health.metrics.rssBytes,
      process.resourceUsage().maxRSS * 1024,
    );

    const liveDataBytesBeforeIdle = await directoryBytes(root);
    const idleResourcesBefore = resourceCounters();
    const idleProcBefore = await readProcIo();
    const idleStarted = performance.now();
    await new Promise((resolve) => setTimeout(resolve, idleMs));
    const idleDurationMs = performance.now() - idleStarted;
    const idleResourcesAfter = resourceCounters();
    const idleProcAfter = await readProcIo();
    const liveDataBytesAfterIdle = await directoryBytes(root);

    writeLatencies.sort((a, b) => a - b);
    readLatencies.sort((a, b) => a - b);
    const report = {
      schema: 'centraid-gateway-low-end-benchmark/1',
      generatedAt: new Date().toISOString(),
      host: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        cpus: os.availableParallelism(),
        totalMemoryBytes: os.totalmem(),
        requestedHardwareProfile: process.env.CENTRAID_HARDWARE_PROFILE ?? 'auto',
      },
      workload: {
        requests: workload.length,
        writes,
        reads,
        writeMix: {
          'atlas.insert core.party': Math.ceil(writes / 2),
          'atlas.insert core.place': Math.floor(writes / 2),
        },
        readMix: { 'vault.status': reads },
        concurrency,
        idleMs: idleDurationMs,
      },
      request: {
        p50Ms: percentile(writeLatencies, 0.5),
        p99Ms: percentile(writeLatencies, 0.99),
        maxMs: writeLatencies.at(-1) ?? 0,
        throughputPerSecond: writes / (writeDurationMs / 1_000),
      },
      readRequest: {
        p50Ms: percentile(readLatencies, 0.5),
        p99Ms: percentile(readLatencies, 0.99),
        maxMs: readLatencies.at(-1) ?? 0,
        throughputPerSecond: reads / (writeDurationMs / 1_000),
      },
      memory: { rssPeakBytes: maxRssBytes },
      eventLoop: {
        p50Ms: health.metrics.eventLoopLagP50Ms ?? null,
        p99Ms: health.metrics.eventLoopLagP99Ms ?? null,
        maxMs: health.metrics.eventLoopLagMaxMs ?? null,
        peakP99Ms: health.metrics.eventLoopLagPeakP99Ms ?? null,
        samples: health.metrics.eventLoopLagSamples ?? 0,
      },
      storage: {
        bootFsyncMs: health.metrics.storageFsyncMs ?? null,
        fsyncCalls: null,
        fsyncPerWrite: null,
        resourceFsWrites: resourcesAfterWrites.fsWrites - resourcesBeforeWrites.fsWrites,
        resourceFsWritesPerWrite:
          (resourcesAfterWrites.fsWrites - resourcesBeforeWrites.fsWrites) / writes,
        diskWriteBytes,
        diskWriteBytesPerWrite: diskWriteBytes === null ? null : diskWriteBytes / writes,
        liveDataBytes: liveDataBytesAfterIdle,
      },
      idle: {
        contextSwitchesPerHour: ratePerHour(
          idleResourcesAfter.contextSwitches - idleResourcesBefore.contextSwitches,
          idleDurationMs,
        ),
        resourceFsWritesPerHour: ratePerHour(
          idleResourcesAfter.fsWrites - idleResourcesBefore.fsWrites,
          idleDurationMs,
        ),
        diskWriteBytesPerHour:
          idleProcBefore && idleProcAfter
            ? ratePerHour(idleProcAfter.write_bytes - idleProcBefore.write_bytes, idleDurationMs)
            : null,
        liveDataGrowthBytesPerHour: ratePerHour(
          Math.max(0, liveDataBytesAfterIdle - liveDataBytesBeforeIdle),
          idleDurationMs,
        ),
      },
    };
    return report;
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
}

function fsyncCallsIn(trace, marker) {
  const lines = trace.split('\n');
  const start = lines.findIndex((line) => line.includes(`${marker}.start`));
  const end = lines.findIndex((line, index) => index > start && line.includes(`${marker}.end`));
  if (start < 0 || end < 0) throw new Error('strace workload epoch markers are missing');
  return lines.slice(start + 1, end).filter((line) => {
    // A blocking syscall can be split into `<unfinished ...>` and a later
    // `<... fsync resumed>` record. Count the resumed record exactly once;
    // ordinary one-line calls count through the opening-call form.
    if (/<\.\.\. (?:fsync|fdatasync) resumed>/.test(line)) return true;
    return /\b(?:fsync|fdatasync)\(/.test(line) && !line.includes('<unfinished ...>');
  }).length;
}

function checkBudgets(report, budgets, requireFsync) {
  const checks = [
    ['request.p99Ms', report.request.p99Ms, budgets.requestP99Ms],
    ['memory.rssPeakBytes', report.memory.rssPeakBytes, budgets.rssPeakBytes],
    ['eventLoop.peakP99Ms', report.eventLoop.peakP99Ms, budgets.eventLoopLagPeakP99Ms],
    [
      'idle.contextSwitchesPerHour',
      report.idle.contextSwitchesPerHour,
      budgets.idleContextSwitchesPerHour,
    ],
    [
      'idle.liveDataGrowthBytesPerHour',
      report.idle.liveDataGrowthBytesPerHour,
      budgets.idleLiveDataGrowthBytesPerHour,
    ],
  ];
  if (report.storage.diskWriteBytesPerWrite !== null) {
    checks.push([
      'storage.diskWriteBytesPerWrite',
      report.storage.diskWriteBytesPerWrite,
      budgets.diskWriteBytesPerWrite,
    ]);
  }
  if (report.storage.fsyncPerWrite !== null) {
    checks.push(['storage.fsyncPerWrite', report.storage.fsyncPerWrite, budgets.fsyncPerWrite]);
  } else if (requireFsync) {
    throw new Error('fsync metric required but strace is unavailable');
  }
  if (report.idle.diskWriteBytesPerHour !== null) {
    checks.push([
      'idle.diskWriteBytesPerHour',
      report.idle.diskWriteBytesPerHour,
      budgets.idleDiskWriteBytesPerHour,
    ]);
  } else {
    checks.push([
      'idle.resourceFsWritesPerHour',
      report.idle.resourceFsWritesPerHour,
      budgets.idleResourceFsWritesPerHour,
    ]);
  }
  const failures = checks.filter(([, actual, ceiling]) => actual === null || actual > ceiling);
  return {
    checks: checks.map(([metric, actual, ceiling]) => ({ metric, actual, ceiling })),
    failures,
  };
}

async function traceFsyncCalls() {
  const traceFile = path.join(os.tmpdir(), `centraid-fsync-${process.pid}.log`);
  const traceMarker = path.join(os.tmpdir(), `centraid-bench-epoch-${process.pid}`);
  const childArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--output' || arg === '--idle-ms') {
      index += 1;
      continue;
    }
    if (
      arg === '--trace-fsync' ||
      arg === '--check' ||
      arg === '--internal' ||
      arg.startsWith('--output=') ||
      arg.startsWith('--idle-ms=')
    ) {
      continue;
    }
    childArgs.push(arg);
  }
  // The trace epoch ends before idle measurement, so do not repeat the
  // primary run's 65-second observation window in this fsync-only child.
  childArgs.push('--internal', '--idle-ms=1');
  try {
    const result = spawnSync(
      'strace',
      [
        '-f',
        '-qq',
        '-e',
        'trace=fsync,fdatasync,openat',
        '-o',
        traceFile,
        process.execPath,
        fileURLToPath(import.meta.url),
        ...childArgs,
      ],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          CENTRAID_BENCH_QUIET: '1',
          CENTRAID_BENCH_TRACE_MARKER: traceMarker,
          // The parent applies the required gate after it injects the parsed trace count.
          CENTRAID_BENCH_REQUIRE_FSYNC: '0',
        },
      },
    );
    if (result.status !== 0) {
      throw new Error(`strace benchmark child failed with status ${result.status ?? 'unknown'}`);
    }
    return fsyncCallsIn(await fs.readFile(traceFile, 'utf8'), traceMarker);
  } finally {
    await Promise.all([
      fs.rm(traceFile, { force: true }),
      fs.rm(`${traceMarker}.start`, { force: true }),
      fs.rm(`${traceMarker}.end`, { force: true }),
    ]);
  }
}

const underTrace = args.includes('--internal');
const straceAvailable = process.platform === 'linux' && spawnSync('which', ['strace']).status === 0;
const report = await runInternal();
if (!underTrace && straceAvailable) {
  const fsyncCalls = await traceFsyncCalls();
  report.storage.fsyncCalls = fsyncCalls;
  report.storage.fsyncPerWrite = fsyncCalls / report.workload.writes;
}
const output = option('--output', '');
const budgets = JSON.parse(
  await fs.readFile(path.join(packageRoot, 'benchmarks', 'low-end-budgets.json'), 'utf8'),
);
const budgetResult = checkBudgets(
  report,
  budgets,
  process.env.CENTRAID_BENCH_REQUIRE_FSYNC === '1',
);
report.budgets = budgetResult;

if (output) await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
if (process.env.CENTRAID_BENCH_QUIET !== '1')
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (args.includes('--check') && budgetResult.failures.length > 0) process.exitCode = 1;
