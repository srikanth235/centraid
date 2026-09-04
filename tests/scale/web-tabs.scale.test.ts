import { BroadcastChannel } from "node:worker_threads";

import { describe, expect, onTestFinished, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";

const OWNER = "tests/scale/web-tabs.scale.test.ts";
const TABS = 64;

describe("web-tabs.scale", () => {
  test("broadcasts one replica invalidation to many tab contexts", async () => {
    const name = `centraid-scale-${crypto.randomUUID()}`;
    const sender = new BroadcastChannel(name);
    const tabs = Array.from({ length: TABS }, () => new BroadcastChannel(name));
    onTestFinished(() => {
      sender.close();
      for (const tab of tabs) tab.close();
    });
    const received = tabs.map(
      (tab) =>
        new Promise<string>((resolve) => {
          tab.addEventListener(
            "message",
            (event) => resolve(String(event.data)),
            { once: true }
          );
        })
    );
    const started = performance.now();
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- (#587) worker_threads BroadcastChannel has no targetOrigin parameter.
    sender.postMessage("invalidate");
    const messages = await Promise.all(received);
    const durationMs = performance.now() - started;
    // Published, not gated (#927): the paired candidate/PR run compares two
    // trees; a threshold on one sample here would fence the runner.
    const passed = true;
    expect(messages.every((message) => message === "invalidate")).toBe(true);
    await recordQualityResult({
      lane: "scale",
      owner: OWNER,
      name: `${TABS} web-tab invalidation fan-out`,
      status: passed ? "passed" : "failed",
      measurements: [
        {
          name: "wall clock",
          value: durationMs,
          unit: "ms",
        },
        { name: "tabs", value: TABS, unit: "count" },
      ],
    });
    expect(passed).toBe(true);
  });
});
