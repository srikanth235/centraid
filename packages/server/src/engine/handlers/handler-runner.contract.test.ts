import { writeFile } from "node:fs/promises";
// Worker-spawn admission control (#351 Tier 4 hygiene): `runHandler`
// spawns one 256MB-capped worker thread per request, and ungated that has no
// cap at all — a request burst could spawn unboundedly and OOM the host. These
// pin the gate: a fixed number of concurrent slots, a short FIFO queue for the
// rest, and a fast "busy" failure once both are exhausted — never a hang,
// never an unbounded pile of workers.
//
// Each test builds its own small `WorkerAdmission` (2-4 slots) rather than
// the shared production default (8 concurrent + 16 queued) so the cap is
// cheap to exercise without spinning up dozens of real worker threads.
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
    // Sleeps long enough that several worker calls genuinely overlap
    // in-flight, short enough to keep the test fast.
    // Park on a shared file gate (written by the test after slots fill) so the
    // handlers genuinely overlap without a fixed wall-clock sleep.
    //
    // The gate is probed with `import()`, not `fs.access` (#842):
    // the app-handler sandbox refuses `node:fs/promises` to every handler
    // graph, and a fixture that needs a capability no real handler has would
    // be testing the wrong worker. Module resolution is not the filesystem
    // API — a missing module rejects and is not cached, so retrying until the
    // test writes the file is the same causal gate with no privilege.
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
    // 2 concurrent + 2 queued = 4 slots total; a 5th call must be refused.
    const admission = new WorkerAdmission(2, 2, 5_000);
    const [c1, c2, c3, c4, c5] = [1, 2, 3, 4, 5].map((seq) =>
      run(admission, seq)
    );

    // The 5th call is refused immediately — it must not sit behind the
    // admitted handlers waiting for a slot that will never come. Assert the
    // causal ordering instead of a wall-clock threshold that flakes when the
    // package suite saturates the host. Handlers park on a file gate (not a
    // fixed sleep) so they stay in-flight until we release them.
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

    // Release the gate once the busy refusal is proven so the admitted four finish.
    await writeFile(path.join(appDir, "release.gate.mjs"), "export default 1;");
    const admitted = await admittedPromise;
    for (const outcome of admitted) expect(outcome.ok).toBe(true);
    const seqs = admitted
      .map((o) => (o.value as { seq: number }).seq)
      .toSorted((a, b) => a - b);
    expect(seqs).toStrictEqual([1, 2, 3, 4]);

    // The gate is empty again once every call has settled, and the cumulative
    // resource actuals (#528) recorded all four admitted tasks (the refused 5th
    // never acquired a slot, so it is not a task).
    const settled = admission.stats();
    expect(settled.inFlight).toBe(0);
    expect(settled.queued).toBe(0);
    expect(settled.tasks).toBe(4);
    expect(settled.busyMs).toBeGreaterThanOrEqual(0);
  });

  test("cumulative task + busyMs counters track admitted work with an injected clock (#528)", async () => {
    let clock = 0;
    const admission = new WorkerAdmission(1, 4, 5_000, () => clock);

    await admission.acquire(); // task 1 acquires at t=0
    clock = 30;
    admission.release(); // task 1 ran 30ms
    await admission.acquire(); // task 2 acquires at t=30
    clock = 100;
    admission.release(); // task 2 ran 70ms

    const stats = admission.stats();
    expect(stats.tasks).toBe(2);
    expect(stats.busyMs).toBe(100);
    expect(stats.inFlight).toBe(0);
  });

  test("queued requests drain in FIFO order as slots free up", async () => {
    // Only 1 concurrent slot — every later call queues behind the first.
    // Gate is open so handlers finish promptly; ordering is still forced by
    // the single admission slot.
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
    // 1 concurrent slot, held by a handler that parks on the gate past the
    // queue wait timeout; the second call times out after 60ms.
    const admission = new WorkerAdmission(1, 1, 60);
    const holder = run(admission, 1); // occupies the only slot until gate opens
    const queued = run(admission, 2); // waits, but times out after 60ms
    const outcome = await queued;
    expect(outcome.ok).toBe(false);
    expect(outcome.busy).toBe(true);
    expect(outcome.error).toMatch(/timed out/iu);
    await writeFile(path.join(appDir, "release.gate.mjs"), "export default 1;");
    await holder; // let the first handler finish and release its slot
  });
});
