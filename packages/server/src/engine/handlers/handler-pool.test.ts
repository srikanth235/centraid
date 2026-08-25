import { writeFile } from "node:fs/promises";
// Warm-spare worker pool (issue #404). These cover the four properties the
// pool must hold beyond "dispatch still works": it keeps warm spares between
// runs, it preserves per-run module isolation (a worker is never reused across
// handlers), a hung handler is still terminable, and a worker crash doesn't
// poison the pool for subsequent runs.
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { runHandler, HANDLER_WORKER_FILE } from "./handler-runner.js";
import type { HandlerOutcome, RunHandlerOptions } from "./handler-runner.js";
import {
  WorkerAdmission,
  workerMaxConcurrentFromEnv,
} from "./worker-admission.js";
import {
  WorkerPool,
  workerPoolSizeFromEnv,
  CONSTRAINED_WORKER_POOL_SIZE,
  workerResourceLimitsFromEnv,
  DEFAULT_WORKER_POOL_SIZE,
} from "./worker-pool.js";

let appDir: string;
let pool: WorkerPool;
let admission: WorkerAdmission;

describe("handler-pool", () => {
  beforeEach(async () => {
    appDir = await tempDir("centraid-worker-pool-");
    // Private gate: these cases must not share the process-wide production
    // admission slots with the rest of a coverage worker (#811).
    admission = new WorkerAdmission(4, 0, 1_000);
  });

  afterEach(() => {
    pool?.dispose();
  });

  /** Let queued microtasks (pool refill) and a beat of the loop settle. */
  function tick(ms = 40): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  async function writeHandler(name: string, src: string): Promise<string> {
    const file = path.join(appDir, name);
    await writeFile(file, src);
    return file;
  }

  function dispatch(
    opts: Omit<RunHandlerOptions, "admission" | "pool" | "app"> & {
      handlerFile: string;
    }
  ): Promise<HandlerOutcome> {
    return runHandler({
      app: { id: "demo", dir: appDir },
      admission,
      pool,
      ...opts,
    });
  }

  test("keeps warm spares between runs and refills after an acquire", async () => {
    pool = new WorkerPool(HANDLER_WORKER_FILE, 2);
    pool.prewarm();
    await tick();
    expect(pool.warm).toBe(2);

    const handlerFile = await writeHandler(
      "ok.js",
      `export default async () => ({ ok: 1 });`
    );
    const outcome = await dispatch({
      handlerFile,
      handlerKind: "query",
      args: { query: {} },
      timeoutMs: 5_000,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.value).toStrictEqual({ ok: 1 });

    // The acquired spare was consumed and a replacement warmed — back to size.
    await tick();
    expect(pool.warm).toBe(2);
  });

  test("a warmed pool serves a dispatch even after its spares are drained cold", async () => {
    // size 0 = warming disabled; every acquire spawns cold. Proves the pool is
    // correct without any pre-warm, i.e. warmth is a latency optimization only.
    pool = new WorkerPool(HANDLER_WORKER_FILE, 0);
    expect(pool.warm).toBe(0);
    const handlerFile = await writeHandler(
      "ok.js",
      `export default async () => 'cold';`
    );
    const outcome = await dispatch({
      handlerFile,
      handlerKind: "query",
      args: { query: {} },
      timeoutMs: 5_000,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.value).toBe("cold");
  });

  test("module-level state from run A is not visible to run B (no worker reuse)", async () => {
    pool = new WorkerPool(HANDLER_WORKER_FILE, 2);
    pool.prewarm();
    // A handler whose module-scope counter would climb across runs IF the worker
    // (and thus its module registry) were reused. Single-use workers guarantee a
    // fresh module each run, so both runs must observe the initial value.
    const handlerFile = await writeHandler(
      "stateful.js",
      `let seen = 0;\nexport default async () => { seen += 1; return { seen }; };`
    );
    const run = () =>
      dispatch({
        handlerFile,
        handlerKind: "query",
        args: { query: {} },
        timeoutMs: 5_000,
      });
    const first = await run();
    const second = await run();
    expect(first.value).toStrictEqual({ seen: 1 });
    // If the worker were reused, this would be { seen: 2 }.
    expect(second.value).toStrictEqual({ seen: 1 });
  });

  test("runs a TypeScript handler graph (typed source + relative .ts sibling import)", async () => {
    // TS-authored apps ship `.ts` handlers; the worker installs the esbuild
    // loader hook (worker/ts-loader-hooks) on demand so a `.ts` graph imports.
    // The sibling is imported by its emitted `.js` name while the file on disk
    // is `.ts` — the TS ESM convention the resolve hook bridges.
    await writeHandler(
      "util.ts",
      `export interface Sum { total: number }\n` +
        `export function addTyped(a: number, b: number): Sum { return { total: a + b }; }`
    );
    const handlerFile = await writeHandler(
      "compute.ts",
      `import { addTyped, type Sum } from './util.js';\n` +
        `interface Body { a: number; b: number }\n` +
        `export default async ({ body }: { body: Body }): Promise<Sum> => addTyped(body.a, body.b);`
    );
    pool = new WorkerPool(HANDLER_WORKER_FILE, 1);
    pool.prewarm();
    const outcome = await dispatch({
      handlerFile,
      handlerKind: "action",
      args: { body: { a: 40, b: 2 } },
      timeoutMs: 30_000,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.value).toStrictEqual({ total: 42 });
  }, 30_000);

  test("a hung handler is still terminated on timeout without poisoning the pool", async () => {
    pool = new WorkerPool(HANDLER_WORKER_FILE, 2);
    pool.prewarm();
    const hung = await writeHandler(
      "hang.js",
      `export default async () => { await new Promise(() => {}); };`
    );
    const outcome = await dispatch({
      handlerFile: hung,
      handlerKind: "query",
      args: { query: {} },
      timeoutMs: 100,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/timed out after 100ms/iu);

    // The pool is unharmed: a normal handler runs fine right after.
    const ok = await writeHandler(
      "ok.js",
      `export default async () => 'alive';`
    );
    const after = await dispatch({
      handlerFile: ok,
      handlerKind: "query",
      args: { query: {} },
      timeoutMs: 5_000,
    });
    expect(after.ok).toBe(true);
    expect(after.value).toBe("alive");
  }, 60_000);

  test("a worker that crashes mid-run leaves the pool usable for the next run", async () => {
    pool = new WorkerPool(HANDLER_WORKER_FILE, 2);
    pool.prewarm();
    const crash = await writeHandler(
      "crash.js",
      `export default async () => { process.exit(1); };`
    );
    const crashed = await dispatch({
      handlerFile: crash,
      handlerKind: "query",
      args: { query: {} },
      timeoutMs: 5_000,
    });
    expect(crashed.ok).toBe(false);

    const ok = await writeHandler(
      "ok.js",
      `export default async () => 'recovered';`
    );
    const after = await dispatch({
      handlerFile: ok,
      handlerKind: "query",
      args: { query: {} },
      timeoutMs: 5_000,
    });
    expect(after.ok).toBe(true);
    expect(after.value).toBe("recovered");
  });

  test("two concurrent dispatches both complete without sharing a result", async () => {
    pool = new WorkerPool(HANDLER_WORKER_FILE, 2);
    pool.prewarm();
    await tick();
    const handlerFile = await writeHandler(
      "echo.js",
      `export default async ({ query }) => query;`
    );
    const [left, right] = await Promise.all([
      dispatch({
        handlerFile,
        handlerKind: "query",
        args: { query: { n: 1 } },
        timeoutMs: 5_000,
      }),
      dispatch({
        handlerFile,
        handlerKind: "query",
        args: { query: { n: 2 } },
        timeoutMs: 5_000,
      }),
    ]);
    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    const values = [left.value, right.value];
    expect(values).toContainEqual({ n: 1 });
    expect(values).toContainEqual({ n: 2 });
  });

  test("workerPoolSizeFromEnv clamps and defaults sanely", () => {
    const standard = { CENTRAID_RESOLVED_HARDWARE_PROFILE: "standard" };
    expect(workerPoolSizeFromEnv(standard)).toBe(DEFAULT_WORKER_POOL_SIZE);
    expect(
      workerPoolSizeFromEnv({ ...standard, CENTRAID_WORKER_POOL_SIZE: "" })
    ).toBe(DEFAULT_WORKER_POOL_SIZE);
    // A constrained host keeps ONE warm spare (#659 G11): it is the target
    // hardware, and it is where a cold worker boot hurts most.
    expect(
      workerPoolSizeFromEnv({
        CENTRAID_RESOLVED_HARDWARE_PROFILE: "constrained",
      })
    ).toBe(CONSTRAINED_WORKER_POOL_SIZE);
    // Warming is still explicitly disableable.
    expect(
      workerPoolSizeFromEnv({
        CENTRAID_RESOLVED_HARDWARE_PROFILE: "constrained",
        CENTRAID_WORKER_POOL_SIZE: "0",
      })
    ).toBe(0);
    expect(workerPoolSizeFromEnv({ CENTRAID_WORKER_POOL_SIZE: "0" })).toBe(0);
    expect(workerPoolSizeFromEnv({ CENTRAID_WORKER_POOL_SIZE: "3" })).toBe(3);
    expect(workerPoolSizeFromEnv({ CENTRAID_WORKER_POOL_SIZE: "999" })).toBe(8);
    expect(
      workerPoolSizeFromEnv({
        ...standard,
        CENTRAID_WORKER_POOL_SIZE: "nonsense",
      })
    ).toBe(DEFAULT_WORKER_POOL_SIZE);
    expect(
      workerPoolSizeFromEnv({ ...standard, CENTRAID_WORKER_POOL_SIZE: "-2" })
    ).toBe(DEFAULT_WORKER_POOL_SIZE);
  });

  test("worker memory and concurrency ceilings default down on constrained hosts and remain tunable", () => {
    const constrained = { cores: 4, totalMemoryBytes: 2 * 1024 ** 3 };
    const large = { cores: 8, totalMemoryBytes: 16 * 1024 ** 3 };
    expect(workerMaxConcurrentFromEnv({}, constrained)).toBe(2);
    expect(workerMaxConcurrentFromEnv({}, large)).toBe(8);
    expect(
      workerMaxConcurrentFromEnv(
        { CENTRAID_RESOLVED_HARDWARE_PROFILE: "constrained" },
        large
      )
    ).toBe(2);
    expect(
      workerMaxConcurrentFromEnv(
        { CENTRAID_WORKER_MAX_CONCURRENT: "3" },
        constrained
      )
    ).toBe(3);
    expect(workerResourceLimitsFromEnv({}, constrained)).toStrictEqual({
      maxOldGenerationSizeMb: 128,
      maxYoungGenerationSizeMb: 16,
    });
    expect(
      workerResourceLimitsFromEnv(
        { CENTRAID_RESOLVED_HARDWARE_PROFILE: "constrained" },
        large
      )
    ).toStrictEqual({
      maxOldGenerationSizeMb: 128,
      maxYoungGenerationSizeMb: 16,
    });
    expect(
      workerResourceLimitsFromEnv(
        {
          CENTRAID_WORKER_MAX_OLD_GENERATION_MB: "96",
          CENTRAID_WORKER_MAX_YOUNG_GENERATION_MB: "12",
        },
        constrained
      )
    ).toStrictEqual({
      maxOldGenerationSizeMb: 96,
      maxYoungGenerationSizeMb: 12,
    });
  });
});
