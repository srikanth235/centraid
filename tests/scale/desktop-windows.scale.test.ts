import { describe, expect, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";

import { gatewayChangedPayload } from "../../apps/desktop/src/main/ipc-core.js";

const OWNER = "tests/scale/desktop-windows.scale.test.ts";
const WINDOWS = 128;
const EVENTS = 500;

describe("desktop-windows.scale", () => {
  test("fans gateway state broadcasts across many window consumers", async () => {
    const inboxes = Array.from({ length: WINDOWS }, () => new Array<unknown>());
    const started = performance.now();
    for (let event = 0; event < EVENTS; event += 1) {
      const payload = gatewayChangedPayload({
        activeGatewayId: `gateway-${event}`,
        activeGatewayKind: "local",
        activeGatewayLabel: "Local",
        activeProfileDisplayName: "Owner",
        activeProfileAvatarColor: "green",
      });
      for (const inbox of inboxes) inbox.push(structuredClone(payload));
    }
    const durationMs = performance.now() - started;
    // Published, not gated (#927): the paired candidate/PR run compares two
    // trees; a threshold on one sample here would fence the runner.
    const passed = true;
    expect(inboxes.every((inbox) => inbox.length === EVENTS)).toBe(true);
    await recordQualityResult({
      lane: "scale",
      owner: OWNER,
      name: `${WINDOWS} desktop windows × ${EVENTS} broadcasts`,
      status: passed ? "passed" : "failed",
      measurements: [
        {
          name: "wall clock",
          value: durationMs,
          unit: "ms",
        },
        { name: "window deliveries", value: WINDOWS * EVENTS, unit: "count" },
      ],
    });
    expect(passed).toBe(true);
  });
});
