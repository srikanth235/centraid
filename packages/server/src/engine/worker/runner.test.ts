/* oxlint-disable unicorn/require-post-message-target-origin -- node:worker_threads postMessage has no targetOrigin */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

const RUNNER = fileURLToPath(new URL("runner.ts", import.meta.url));

let worker: Worker | undefined;

describe("runner", () => {
  afterEach(async () => {
    if (!worker) return;
    await worker.terminate();
    worker = undefined;
  });

  function waitFor(
    w: Worker,
    pred: (msg: Record<string, unknown>) => boolean,
    ms = 15_000
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("timeout waiting for worker message")),
        ms
      );
      const onMsg = (msg: Record<string, unknown>) => {
        if (!pred(msg)) return;
        clearTimeout(t);
        w.off("message", onMsg);
        resolve(msg);
      };
      w.on("message", onMsg);
    });
  }

  test("handler worker executes a JS handler and returns result (names worker/runner.ts)", async () => {
    const dir = await tempDir("handler-worker-");
    const handlerFile = path.join(dir, "q.js");
    await writeFile(
      handlerFile,
      `export default async ({ body }) => ({ sum: body.a + body.b });`
    );

    worker = new Worker(RUNNER, {
      workerData: { pooled: true },
      execArgv: [],
    });

    worker.postMessage({
      type: "run",
      request: {
        handlerFile,
        handlerKind: "query",
        args: { body: { a: 2, b: 40 } },
      },
    });

    const result = await waitFor(worker, (m) => m.type === "result");
    expect(result.ok).toBe(true);
    expect(result.value).toStrictEqual({ sum: 42 });
  }, 20_000);

  test("handler worker reports handler throw as ok:false", async () => {
    const dir = await tempDir("handler-worker-err-");
    const handlerFile = path.join(dir, "bad.js");
    await writeFile(
      handlerFile,
      `export default async () => { throw new Error('nope'); };`
    );

    worker = new Worker(RUNNER, {
      workerData: {
        handlerFile,
        handlerKind: "action",
        args: {},
      },
      execArgv: [],
    });

    const result = await waitFor(worker, (m) => m.type === "result");
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/nope/u);
  }, 20_000);
});
