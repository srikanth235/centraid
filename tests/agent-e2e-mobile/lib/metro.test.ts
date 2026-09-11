import { describe, expect, test, vi } from "vitest";

import { waitForMetroReachable } from "./metro.mjs";

describe("waitForMetroReachable", () => {
  test("waits through transient startup failures", async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      waitForMetroReachable({ attempts: 5, intervalMs: 25, probe, sleep })
    ).resolves.toBe(true);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 25);
    expect(sleep).toHaveBeenNthCalledWith(2, 25);
  });

  test("stops after the bounded attempt budget", async () => {
    const probe = vi.fn().mockResolvedValue(false);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      waitForMetroReachable({ attempts: 3, intervalMs: 10, probe, sleep })
    ).resolves.toBe(false);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
