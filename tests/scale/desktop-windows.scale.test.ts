import {
  qualityRegressionBudget,
  recordQualityResult,
} from "@centraid/test-kit/quality-result";
import { describe, expect, test } from "vitest";

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
    const budget = await qualityRegressionBudget("scale", OWNER);
    const passed = budget == null || durationMs < budget;
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
          ...(budget == null ? {} : { budget }),
        },
        { name: "window deliveries", value: WINDOWS * EVENTS, unit: "count" },
      ],
    });
    expect(passed).toBe(true);
  });
});
