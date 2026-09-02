import { writeFile } from "node:fs/promises";
// Admission gate (#351): small WorkerAdmission per test, not the production default.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { beforeEach, describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { runHandler } from "./handler-runner.js";
import type { HandlerOutcome } from "./handler-runner.js";
import { WorkerAdmission } from "./worker-admission.js";

let appDir: string;
let handlerFile: string;

describe("handler-runner", () => {
  beforeEach(async () => {
    appDir = await tempDir("centraid-worker-admission-");
    handlerFile = path.join(appDir, "slow.js");
    // Park on `import()` of a gate file, not `fs.access` (#842): the sandbox refuses `node:fs/promises`, and a missing module rejects uncached.
    await writeFile(
      handlerFile,
      `const gate = ${JSON.stringify(pathToFileURL(path.join(appDir, "release.gate.mjs")).href)};
     export default async ({ body }) => {
       const deadline = Date.now() + 5_000;
       while (Date.now() < deadline) {
         try { await import(gate); break; } catch { await new Promise((r) => setImmediate(r)); }
       }
       return { seq: body.seq, finishedAt: Date.now() };
     };`
    );
  });

  function run(
    admission: WorkerAdmission,
    seq: number
  ): Promise<HandlerOutcome> {
    return runHandler({
      app: { id: "demo", dir: appDir },
      handlerFile,
      handlerKind: "action",
      args: { body: { seq } },
      admission,
    });
  }

  test("a burst beyond cap+queue fails fast with a busy outcome; admitted calls still complete", async () => {
    const admission = new WorkerAdmission(2, 2, 5_000);
    const [c1, c2, c3, c4, c5] = [1, 2, 3, 4, 5].map((seq) =>
      run(admission, seq)
    );

    // 5th refused immediately — causal order, not a wall-clock threshold.
    const admittedPromise = Promise.all([c1!, c2!, c3!, c4!]);
    let admittedSettled = false;
    void admittedPromise.finally(() => {
      admittedSettled = true;
    });
    const fifth = await c5!;
    expect(admittedSettled).toBe(false);
    expect(fifth.ok).toBe(false);
    expect(fifth.busy).toBe(true);
    expect(fifth.error).toMatch(/busy/iu);

    await writeFile(path.join(appDir, "release.gate.mjs"), "export default 1;");
    const admitted = await admittedPromise;
    for (const outcome of admitted) expect(outcome.ok).toBe(true);
    const seqs = admitted
      .map((o) => (o.value as { seq: number }).seq)
      .toSorted((a, b) => a - b);
    expect(seqs).toStrictEqual([1, 2, 3, 4]);

    // Refused 5th never acquired a slot, so it is not a task (#528).
    const settled = admission.stats();
    expect(settled.inFlight).toBe(0);
    expect(settled.queued).toBe(0);
    expect(settled.tasks).toBe(4);
    expect(settled.busyMs).toBeGreaterThanOrEqual(0);
  });

  test("cumulative task + busyMs counters track admitted work with an injected clock (#528)", async () => {
    let clock = 0;
    const admission = new WorkerAdmission(1, 4, 5_000, () => clock);

    await admission.acquire();
    clock = 30;
    admission.release();
    await admission.acquire();
    clock = 100;
    admission.release();

    const stats = admission.stats();
    expect(stats.tasks).toBe(2);
    expect(stats.busyMs).toBe(100);
    expect(stats.inFlight).toBe(0);
  });

  test("queued requests drain in FIFO order as slots free up", async () => {
    await writeFile(path.join(appDir, "release.gate.mjs"), "export default 1;");
    const admission = new WorkerAdmission(1, 3, 5_000);
    const calls = [1, 2, 3, 4].map((seq) => run(admission, seq));
    const outcomes = await Promise.all(calls);
    for (const outcome of outcomes) expect(outcome.ok).toBe(true);

    const finishOrder = outcomes
      .map((o) => o.value as { seq: number; finishedAt: number })
      .toSorted((a, b) => a.finishedAt - b.finishedAt)
      .map((v) => v.seq);
    expect(finishOrder).toStrictEqual([1, 2, 3, 4]);
  });

  test("a request that times out waiting in queue gets a busy outcome, not a hang", async () => {
    const admission = new WorkerAdmission(1, 1, 60);
    const holder = run(admission, 1);
    const queued = run(admission, 2);
    const outcome = await queued;
    expect(outcome.ok).toBe(false);
    expect(outcome.busy).toBe(true);
    expect(outcome.error).toMatch(/timed out/iu);
    await writeFile(path.join(appDir, "release.gate.mjs"), "export default 1;");
    await holder;
  });
});
