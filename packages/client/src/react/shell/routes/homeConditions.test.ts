import { describe, expect, it, vi } from "vitest";

import type { LocalUsageReportDTO } from "../../../gateway-client-local-storage.js";
import { HOME_CONFLICTS, homeOutOfRoom } from "./homeConditions.js";

function report(
  limit: Partial<LocalUsageReportDTO["limit"]>
): LocalUsageReportDTO {
  return {
    components: [],
    disk: null,
    limit: {
      fractionUsed: 1,
      limitBytes: 20 * 1024 ** 3,
      status: "error",
      usedBytes: 20 * 1024 ** 3,
      ...limit,
    },
    limits: {
      journalLimitBytes: null,
      totalLimitBytes: 20 * 1024 ** 3,
      warnAtPercent: 85,
    },
    scannedAt: 0,
    totalBytes: 0,
    vaults: [],
  };
}

describe("shell/routes/homeConditions", () => {
  describe(homeOutOfRoom, () => {
    it("says nothing when there is no report yet", () => {
      expect(homeOutOfRoom(undefined, vi.fn<() => void>())).toBeUndefined();
    });

    it("says nothing when the owner set no budget", () => {
      expect(
        homeOutOfRoom(
          report({ limitBytes: null, status: "ok" }),
          vi.fn<() => void>()
        )
      ).toBeUndefined();
    });

    it("says nothing while there is room — a meter nobody needs is noise", () => {
      expect(
        homeOutOfRoom(
          report({ fractionUsed: 0.3, status: "ok" }),
          vi.fn<() => void>()
        )
      ).toBeUndefined();
    });

    it("leads with the CONSEQUENCE, in the future tense, once it is full", () => {
      const state = homeOutOfRoom(report({}), vi.fn<() => void>());
      expect(state?.consequence).toBe(
        "New photos and files will stop syncing to this device."
      );
      expect(state?.cause).toContain("20.0 GB");
      expect(state?.fractionUsed).toBe(1);
    });

    it("warns before it is full without claiming it already stopped", () => {
      const state = homeOutOfRoom(
        report({ fractionUsed: 0.88, status: "degraded" }),
        vi.fn<() => void>()
      );
      expect(state?.consequence).toBe(
        "New photos and files will stop syncing once it is full."
      );
      expect(state?.cause).toContain("close to");
    });

    it("offers exactly one action, and it is the caller's", () => {
      const onManage = vi.fn<() => void>();
      homeOutOfRoom(report({}), onManage)?.action.run();
      expect(onManage).toHaveBeenCalledOnce();
    });
  });

  describe("the conflict list Home reads", () => {
    it("is empty until a conflict record carries both versions (named seam)", () => {
      expect(HOME_CONFLICTS).toStrictEqual([]);
    });
  });
});
