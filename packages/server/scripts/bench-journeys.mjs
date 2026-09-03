#!/usr/bin/env node

// #922 F3/B4 — the journeys the low-end gate never measured: a replica intent
// (the offline drain's unit of work), a blueprint handler worker cold and
// warm, an SSE projection under N subscribers, and a bootstrap page. Runs
// under either hardware profile so the `synchronous=FULL` desktop path is
// measured beside the constrained gate's `NORMAL` one.
//
// This script PUBLISHES; it gates nothing. `low-end-budgets.json` is the
// constrained gate's ceiling set and is untouched here (#922 wave 1).

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { serve } from "../dist/index.js";
import { expectedPayloadHash } from "../dist/routes/replica-intent-shape.js";
import {
  argReader,
  fsyncCallsIn,
  hostRecord,
  latencySummary,
  markTraceEpoch,
  quietLogger,
  resolvedProfileFrom,
  straceAvailable,
} from "./bench-support.mjs";

const args = process.argv.slice(2);
const { option, positiveInteger } = argReader(args);
const underTrace = args.includes("--internal");

// Resolved inside `serve()` from the environment, so it must be pinned before
// the gateway boots — this is the whole point of the B4 pairing.
const profileArg = option("--profile", "");
if (profileArg) {
  if (profileArg !== "standard" && profileArg !== "constrained")
    throw new Error("--profile must be standard or constrained");
  process.env.CENTRAID_HARDWARE_PROFILE = profileArg;
}

const intentCount = positiveInteger("--intents", 20);
const fillRows = Number(option("--fill", "2000"));
const bootstrapWindow = positiveInteger("--bootstrap-window", 5000);
const commitsPerLevel = positiveInteger("--commits", 5);
const subscriberLevels = String(option("--subscribers", "1,10,40"))
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map(Number);
const deliveryTimeoutMs = positiveInteger("--delivery-timeout-ms", 20_000);

function jsonHeaders(handle) {
  return {
    Authorization: `Bearer ${handle.token}`,
    "content-type": "application/json",
  };
}

async function expectOk(response, what) {
  if (!response.ok)
    throw new Error(
      `${what} failed: ${response.status} ${await response.text()}`
    );
  return response;
}

async function insertPlace(handle, headers, label) {
  const started = performance.now();
  await expectOk(
    await fetch(`${handle.url}/centraid/_vault/atlas/browse/insert`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        table: "core.place",
        values: {
          name: label,
          kind: "venue",
          created_at: new Date().toISOString(),
        },
      }),
    }),
    "atlas insert"
  );
  return performance.now() - started;
}

/**
 * Realistic volume through the real write path: every bundled blueprint's own
 * demo seed, then `--fill` plain rows. A direct SQLite insert would skip the
 * journal sequence the replica cursor is derived from, so it cannot stand in.
 */
async function seedVolume(handle, headers) {
  const started = performance.now();
  const listed = await (
    await expectOk(
      await fetch(`${handle.url}/centraid/_vault/demo`, { headers }),
      "demo list"
    )
  ).json();
  const seeded = [];
  for (const app of listed.apps.filter((entry) => entry.seedable)) {
    // oxlint-disable-next-line no-await-in-loop -- one demo seed per app, in order
    const response = await expectOk(
      // oxlint-disable-next-line no-await-in-loop -- one demo seed per app, in order
      await fetch(`${handle.url}/centraid/_vault/demo/${app.appId}`, {
        method: "POST",
        headers,
        body: "{}",
      }),
      `demo seed ${app.appId}`
    );
    // oxlint-disable-next-line no-await-in-loop -- the fill rate is the gateway's own serial write path
    const body = await response.json();
    seeded.push({ appId: app.appId, rows: body.rows ?? null });
  }
  let filled = 0;
  if (fillRows > 0) {
    const labels = Array.from(
      { length: fillRows },
      (_, index) => `Journey fill place ${index}`
    );
    let next = 0;
    const worker = async () => {
      while (next < labels.length) {
        const label = labels[next++];
        // oxlint-disable-next-line no-await-in-loop -- the fill rate is the gateway's own serial write path
        await insertPlace(handle, headers, label);
        filled += 1;
      }
    };
    await Promise.all(Array.from({ length: 4 }, () => worker()));
  }
  return {
    demoApps: seeded,
    filledRows: filled,
    seedDurationMs: performance.now() - started,
  };
}

async function bootstrapPage(handle, headers) {
  const started = performance.now();
  const response = await expectOk(
    await fetch(
      `${handle.url}/centraid/_vault/replica/bootstrap?window=${bootstrapWindow}`,
      { headers }
    ),
    "bootstrap"
  );
  const text = await response.text();
  const elapsed = performance.now() - started;
  const body = JSON.parse(text);
  return {
    durationMs: elapsed,
    rows: body.rows?.length ?? 0,
    shapes: body.shapes?.length ?? 0,
    bytes: Buffer.byteLength(text),
    msPerRow: body.rows?.length ? elapsed / body.rows.length : null,
    cursor: body.cursor ?? null,
    hasMore: body.hasMore ?? false,
  };
}

/**
 * One intent per HTTP round trip, which is what the outbox drain does today
 * (#922 A6 batches it in wave 3 — the batched path does not exist yet, so
 * only the single path is measured here).
 */
async function runIntents(handle, headers, count) {
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const input = { title: `Journey benchmark task ${index}` };
    const body = {
      intentId: crypto.randomUUID(),
      appId: "tasks",
      action: "add",
      input,
      payloadHash: expectedPayloadHash("tasks", "add", input, []),
    };
    const started = performance.now();
    // oxlint-disable-next-line no-await-in-loop -- one demo seed per app, in order
    const response = await expectOk(
      // oxlint-disable-next-line no-await-in-loop -- one demo seed per app, in order
      await fetch(`${handle.url}/centraid/_vault/replica/intents`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
      `replica intent ${index}`
    );
    const elapsed = performance.now() - started;
    // oxlint-disable-next-line no-await-in-loop -- the fill rate is the gateway's own serial write path
    const outcome = await response.json();
    if (outcome.outcome?.status !== "executed")
      throw new Error(`intent ${index} was ${outcome.outcome?.status}`);
    samples.push(elapsed);
  }
  return samples;
}

/**
 * One SSE subscriber, resolving each `event: change` frame it observes.
 * Returns the refusal instead of throwing when the gateway's global
 * subscriber cap (`SSE_MAX_SUBSCRIBERS`, #351) turns the request away — a
 * household above the cap is a number this instrument must publish, not an
 * error that ends the run.
 */
async function openSubscriber(handle, headers, since) {
  const controller = new AbortController();
  const response = await fetch(
    `${handle.url}/centraid/_vault/changes?since=${encodeURIComponent(since)}&stream=1`,
    { headers, signal: controller.signal }
  );
  if (response.status === 503) {
    const body = await response.json().catch(() => ({}));
    controller.abort();
    return { refused: body.error ?? "sse_capacity" };
  }
  await expectOk(response, "sse subscribe");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let pending = null;
  const deliver = (at) => {
    const resolve = pending;
    pending = null;
    resolve?.(at);
  };
  const pump = async () => {
    try {
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- one intent per HTTP round trip is the drain's unit of work; parallelising it would measure a different journey
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let cut = buffer.indexOf("\n\n");
        while (cut >= 0) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          if (frame.startsWith("event: change")) deliver(performance.now());
          cut = buffer.indexOf("\n\n");
        }
      }
    } catch {
      /* the abort at teardown is the ordinary end of a stream */
    }
  };
  void pump();
  return {
    nextChange: () =>
      new Promise((resolve) => {
        pending = resolve;
      }),
    close: () => controller.abort(),
  };
}

/**
 * The projection cost the gateway pays per commit is paid once per SUBSCRIBER
 * today (the hub memo keys on `deviceId`), so the levels mirror the golden
 * household replica counts: one device, ten, forty.
 */
async function fanOutLevel(handle, headers, subscribers, cursor) {
  const since = `${cursor.epoch}:${cursor.seq}`;
  const streams = [];
  let refusal = null;
  for (let index = 0; index < subscribers; index += 1) {
    // oxlint-disable-next-line no-await-in-loop -- a subscriber is admitted or refused in order, so the cap's boundary is observable
    const stream = await openSubscriber(handle, headers, since);
    if (stream.refused) {
      refusal ??= stream.refused;
      continue;
    }
    streams.push(stream);
  }
  // Let every stream reach its first read before the first commit lands.
  await new Promise((resolve) => {
    setTimeout(resolve, 250);
  });
  const commitMs = [];
  const deliveryMs = [];
  try {
    for (let index = 0; index < commitsPerLevel; index += 1) {
      const waiters = streams.map((stream) => stream.nextChange());
      const started = performance.now();
      commitMs.push(
        // oxlint-disable-next-line no-await-in-loop -- a commit and its fan-out are one measured sample; overlapping them would hide the per-commit cost
        await insertPlace(handle, headers, `Fan-out ${subscribers} #${index}`)
      );
      const timeout = new Promise((resolve) => {
        setTimeout(() => {
          resolve("timeout");
        }, deliveryTimeoutMs);
      });
      const settled =
        waiters.length === 0
          ? []
          : // oxlint-disable-next-line no-await-in-loop -- a commit and its fan-out are one measured sample; overlapping them would hide the per-commit cost
            await Promise.race([Promise.all(waiters), timeout]);
      if (settled === "timeout")
        throw new Error(
          `no SSE change frame within ${deliveryTimeoutMs} ms at ${subscribers} subscribers`
        );
      if (settled.length > 0) deliveryMs.push(Math.max(...settled) - started);
    }
  } finally {
    for (const stream of streams) stream.close();
  }
  return {
    subscribers,
    admitted: streams.length,
    refused: subscribers - streams.length,
    refusalError: refusal,
    commits: commitsPerLevel,
    commit: latencySummary(commitMs),
    lastSubscriberDelivery: latencySummary(deliveryMs),
  };
}

async function runJourneys() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "centraid-journeys-"));
  let handle;
  try {
    handle = await serve({
      paths: { vaultDir: path.join(root, "vault") },
      logger: quietLogger(),
      token: "centraid-journey-benchmark-token",
    });
    const headers = jsonHeaders(handle);
    const health = await (
      await expectOk(
        await fetch(`${handle.url}/centraid/_gateway/health`, { headers }),
        "health"
      )
    ).json();
    const resolvedProfile = resolvedProfileFrom(health);
    // B4: the boot fsync probe is an INPUT here, not a recorded curiosity —
    // #922 B7's adaptive commit window and the profile's sync choice are the
    // two decisions that must read it.
    const storageFsyncMs = health.metrics?.storageFsyncMs ?? null;

    const volume = await seedVolume(handle, headers);
    const bootstrap = underTrace ? null : await bootstrapPage(handle, headers);

    // Cold: the first invocation after boot, which on a pool of 0 spawns and
    // disposes a worker thread. Warm: every later one, which does so again
    // unless the pool holds a thread (#922 B3).
    await markTraceEpoch("start");
    const intentSamples = await runIntents(handle, headers, intentCount);
    await markTraceEpoch("end");

    const fanOut = [];
    if (!underTrace) {
      const cursor = (
        await (
          await expectOk(
            await fetch(
              `${handle.url}/centraid/_vault/replica/bootstrap?window=1`,
              { headers }
            ),
            "cursor bootstrap"
          )
        ).json()
      ).cursor;
      for (const subscribers of subscriberLevels)
        // oxlint-disable-next-line no-await-in-loop -- each fan-out level runs alone so its subscribers are the only ones on the stream
        fanOut.push(await fanOutLevel(handle, headers, subscribers, cursor));
    }

    return {
      schema: "centraid-gateway-journey-benchmark/1",
      generatedAt: new Date().toISOString(),
      host: hostRecord(),
      profile: {
        requested: process.env.CENTRAID_HARDWARE_PROFILE ?? "auto",
        resolvedClass: resolvedProfile.class,
        sqliteSynchronous: resolvedProfile.sqliteSynchronous,
        workerPoolSize: resolvedProfile.workerPoolSize,
        detail: resolvedProfile.detail,
        // The measured input B7's window and the profile's sync mode owe.
        storageFsyncMs,
      },
      volume,
      journeys: {
        bootstrapPage: bootstrap,
        replicaIntent: {
          path: "single",
          batched: null,
          note: "one intent per HTTP round trip; the batch endpoint is #922 wave 3 (A6), so only the single path exists to measure",
          cold: intentSamples.length > 0 ? intentSamples[0] : null,
          warm: latencySummary(intentSamples.slice(1)),
          all: latencySummary(intentSamples),
        },
        handlerWorker: {
          note: "cold is the first blueprint handler invocation after boot; warm is every later one. With workerPoolSize 0 every invocation is a cold spawn (#922 B3).",
          coldMs: intentSamples.length > 0 ? intentSamples[0] : null,
          warm: latencySummary(intentSamples.slice(1)),
          workerPoolSize: resolvedProfile.workerPoolSize,
        },
        sseProjection: fanOut,
      },
      storage: { fsyncCalls: null, fsyncPerIntent: null },
    };
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** Re-run only the intent phase under strace so fsyncs per intent are exact. */
async function traceFsyncPerIntent() {
  const traceFile = path.join(
    os.tmpdir(),
    `centraid-journey-fsync-${process.pid}.log`
  );
  const traceMarker = path.join(
    os.tmpdir(),
    `centraid-journey-epoch-${process.pid}`
  );
  const childArgs = [
    "--internal",
    `--intents=${intentCount}`,
    "--fill=0",
    "--subscribers=",
    ...(profileArg ? [`--profile=${profileArg}`] : []),
  ];
  try {
    const result = spawnSync(
      "strace",
      [
        "-f",
        "-qq",
        "-e",
        "trace=fsync,fdatasync,openat",
        "-o",
        traceFile,
        process.execPath,
        import.meta.filename,
        ...childArgs,
      ],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          CENTRAID_BENCH_QUIET: "1",
          CENTRAID_BENCH_TRACE_MARKER: traceMarker,
        },
      }
    );
    if (result.status !== 0)
      throw new Error(
        `strace journey child failed with status ${result.status ?? "unknown"}`
      );
    return fsyncCallsIn(await fs.readFile(traceFile, "utf8"), traceMarker);
  } finally {
    await Promise.all([
      fs.rm(traceFile, { force: true }),
      fs.rm(`${traceMarker}.start`, { force: true }),
      fs.rm(`${traceMarker}.end`, { force: true }),
    ]);
  }
}

const report = await runJourneys();
if (!underTrace && straceAvailable()) {
  const fsyncCalls = await traceFsyncPerIntent();
  report.storage = {
    fsyncCalls,
    fsyncPerIntent: fsyncCalls / intentCount,
    method:
      "strace -f on a second run of the intent phase only, bracketed by trace-epoch markers",
  };
} else if (!underTrace) {
  report.storage = {
    fsyncCalls: null,
    fsyncPerIntent: null,
    method: "unmeasured: strace is unavailable on this host",
  };
}

const output = option("--output", "");
if (output) await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
if (process.env.CENTRAID_BENCH_QUIET !== "1")
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
