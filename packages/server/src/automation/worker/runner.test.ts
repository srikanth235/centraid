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

  function waitForMessage(
    w: Worker,
    pred: (msg: Record<string, unknown>) => boolean,
    ms = 10_000
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

  test("automation worker runs a handler and posts result (names worker/runner.ts)", async () => {
    const dir = await tempDir("auto-worker-");
    const handlerFile = path.join(dir, "handler.js");
    await writeFile(
      handlerFile,
      `export default async ({ ctx, log }) => {
       log.info('hi');
       const v = await ctx.state.get('cursor');
       await ctx.state.set('cursor', (v ?? 0) + 1);
       return { summary: 'ok', input: ctx.input };
     };`
    );

    worker = new Worker(RUNNER, {
      workerData: {
        pooled: true,
      },
      execArgv: [],
    });

    worker.postMessage({
      type: "run",
      request: {
        handlerFile,
        args: {},
        now: new Date(0).toISOString(),
        input: { n: 1 },
      },
    });

    worker.on("message", (msg: Record<string, unknown>) => {
      if (msg.type === "state" && msg.method === "get") {
        worker!.postMessage({
          type: "state-reply",
          id: msg.id,
          ok: true,
          result: 3,
        });
      } else if (msg.type === "state" && msg.method === "set") {
        worker!.postMessage({ type: "state-reply", id: msg.id, ok: true });
      }
    });

    const result = await waitForMessage(worker, (m) => m.type === "result");
    expect(result.ok).toBe(true);
    expect(result.value).toStrictEqual({ summary: "ok", input: { n: 1 } });
  }, 15_000);

  test("importing runner as a non-worker throws the parentPort guard", async () => {
    await expect(
      import(/* @vite-ignore */ `${RUNNER}?guard=${Date.now()}`)
    ).rejects.toThrow(/must be run as a worker_thread/u);
  });
});
