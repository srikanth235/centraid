import { describe, expect, test, vi } from "vitest";

import { waitForMetroReachable } from "./metro.ts";

describe(waitForMetroReachable, () => {
  test("waits through transient startup failures", async () => {
    const probe = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue();

    await expect(
      waitForMetroReachable({ attempts: 5, intervalMs: 25, probe, sleep })
    ).resolves.toBe(true);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 25);
    expect(sleep).toHaveBeenNthCalledWith(2, 25);
  });

  test("stops after the bounded attempt budget", async () => {
    const probe = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue();

    await expect(
      waitForMetroReachable({ attempts: 3, intervalMs: 10, probe, sleep })
    ).resolves.toBe(false);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
