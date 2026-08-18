import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as GatewayClient from "../../../gateway-client.js";
import { loadStorageUsageAggregate } from "./gatewayStorageData.js";

const { getStorageUsage } = vi.hoisted(() => ({
  getStorageUsage: vi.fn<typeof GatewayClient.getStorageUsage>(),
}));

vi.mock(import("../../../gateway-client.js"), () => ({ getStorageUsage }));

describe(loadStorageUsageAggregate, () => {
  beforeEach(() => {
    getStorageUsage.mockReset();
  });

  it("returns null when no connection has reported usage", async () => {
    getStorageUsage.mockResolvedValue([]);
    await expect(loadStorageUsageAggregate()).resolves.toBeNull();
  });

  it("sums every home connection into one usage input", async () => {
    getStorageUsage.mockResolvedValue([
      {
        id: "a",
        providerReported: {
          backup: { bytesStored: 10, quotaBytes: 100 },
          cas: { bytesStored: 4, quotaBytes: null },
        },
      },
      {
        id: "b",
        providerReported: {
          backup: { bytesStored: 5, quotaBytes: 80 },
        },
      },
    ] as Awaited<ReturnType<typeof GatewayClient.getStorageUsage>>);
    await expect(loadStorageUsageAggregate()).resolves.toStrictEqual({
      backup: { bytesStored: 15, quotaBytes: 100 },
      cas: { bytesStored: 4, quotaBytes: null },
    });
  });
});
