import { describe, expect, it } from "vitest";

import { DiskFullTracker } from "@centraid/vault";

import {
  createDiskHealthProbe,
  DISK_DEGRADED_BELOW_BYTES,
  DISK_DEGRADED_BELOW_PERCENT,
  DISK_ERROR_BELOW_BYTES,
  DISK_ERROR_BELOW_PERCENT,
  evaluateDiskFreeStatus,
  formatBytes,
} from "./disk-health.js";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

function statfsReturning(freeBytes: number, totalBytes: number) {
  return () => ({ bavail: freeBytes, bsize: 1, blocks: totalBytes });
}

describe("evaluateDiskFreeStatus (percent + absolute floor)", () => {
  it("is ok with healthy free space on a large volume", () => {
    expect(evaluateDiskFreeStatus(50 * GIB, 100 * GIB)).toMatchObject({
      status: "ok",
      freePercent: 50,
    });
  });

  it("degrades a small volume by percent even when free exceeds the absolute floor", () => {
    const free = Math.floor(32 * GIB * 0.11);
    const result = evaluateDiskFreeStatus(free, 32 * GIB);
    expect(result.freePercent).toBeLessThan(DISK_DEGRADED_BELOW_PERCENT);
    expect(result.freeBytes).toBeGreaterThan(DISK_DEGRADED_BELOW_BYTES);
    expect(result.status).toBe("degraded");
  });

  it("keeps a small volume ok when free percent and absolute floor are both healthy", () => {
    const result = evaluateDiskFreeStatus(10 * GIB, 32 * GIB);
    expect(result.freePercent).toBeGreaterThan(DISK_DEGRADED_BELOW_PERCENT);
    expect(result.status).toBe("ok");
  });

  it("errors on low free percent of a huge volume even above the absolute error floor", () => {
    const total = 2 * 1024 * GIB;
    const free = 40 * GIB;
    const result = evaluateDiskFreeStatus(free, total);
    expect(result.freePercent).toBeLessThan(DISK_ERROR_BELOW_PERCENT);
    expect(result.freeBytes).toBeGreaterThan(DISK_ERROR_BELOW_BYTES);
    expect(result.status).toBe("error");
  });

  it("errors under the absolute error floor regardless of percent", () => {
    expect(
      evaluateDiskFreeStatus(DISK_ERROR_BELOW_BYTES - 1, 100 * GIB).status
    ).toBe("error");
  });

  it("degrades under the absolute degraded floor when percent is still healthy", () => {
    const free = 1.5 * GIB;
    const total = 8 * GIB;
    const result = evaluateDiskFreeStatus(free, total);
    expect(result.freePercent).toBeGreaterThan(DISK_DEGRADED_BELOW_PERCENT);
    expect(result.freeBytes).toBeLessThan(DISK_DEGRADED_BELOW_BYTES);
    expect(result.status).toBe("degraded");
  });
});

describe(createDiskHealthProbe, () => {
  it("reports ok well above the degraded watermark", async () => {
    const probe = createDiskHealthProbe({
      rootDir: "/vaults",
      vaults: () => [],
      statfs: statfsReturning(50 * GIB, 100 * GIB),
    });
    const result = await probe();
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("50.0 GB free of 100.0 GB");
    expect(result.detail).toContain("50.0% free");
  });

  it("reports degraded just under the absolute degraded watermark", async () => {
    const probe = createDiskHealthProbe({
      rootDir: "/vaults",
      vaults: () => [],
      statfs: statfsReturning(DISK_DEGRADED_BELOW_BYTES - 1, 10 * GIB),
    });
    expect((await probe()).status).toBe("degraded");
  });

  it("reports error under the absolute error watermark", async () => {
    const probe = createDiskHealthProbe({
      rootDir: "/vaults",
      vaults: () => [],
      statfs: statfsReturning(DISK_ERROR_BELOW_BYTES - 1, 100 * GIB),
    });
    const result = await probe();
    expect(result.status).toBe("error");
  });

  it("stays ok exactly at the absolute degraded watermark when percent is healthy", async () => {
    const probe = createDiskHealthProbe({
      rootDir: "/vaults",
      vaults: () => [],
      statfs: statfsReturning(DISK_DEGRADED_BELOW_BYTES, 10 * GIB),
    });
    expect((await probe()).status).toBe("ok");
  });

  it("includes per-vault DB size in the detail, summed from vault.db + its -wal file", async () => {
    const sizes: Record<string, number> = {
      "/vaults/v1/vault.db": 15 * MIB,
      "/vaults/v1/vault.db-wal": 1 * MIB,
    };
    const probe = createDiskHealthProbe({
      rootDir: "/vaults",
      vaults: () => [{ vaultId: "vault-0001-abcdef", dir: "/vaults/v1" }],
      statfs: statfsReturning(50 * GIB, 100 * GIB),
      fileSize: (file) => sizes[file] ?? 0,
    });
    const result = await probe();
    expect(result.detail).toContain("vault-00");
    expect(result.detail).toContain("16.0 MB");
  });

  it("never statSyncs into a blob CAS directory — only the two fixed filenames", async () => {
    const seen: string[] = [];
    const probe = createDiskHealthProbe({
      rootDir: "/vaults",
      vaults: () => [{ vaultId: "v1", dir: "/vaults/v1" }],
      statfs: statfsReturning(50 * GIB, 100 * GIB),
      fileSize: (file) => {
        seen.push(file);
        return 0;
      },
    });
    await probe();
    expect(seen.sort()).toStrictEqual(
      ["/vaults/v1/vault.db", "/vaults/v1/vault.db-wal"].sort()
    );
  });
});

describe("createDiskHealthProbe: disk-full tracker (issue #351 wave 4)", () => {
  it("a replacement probe still names ENOSPC after the previous health loop is dropped", async () => {
    const tracker = new DiskFullTracker();
    tracker.report(
      Object.assign(new Error("no space left"), { code: "ENOSPC" }),
      "blob CAS write"
    );
    createDiskHealthProbe({
      rootDir: "/vaults",
      vaults: () => [],
      statfs: statfsReturning(50 * GIB, 100 * GIB),
      diskFullTracker: tracker,
    });
    const replacement = createDiskHealthProbe({
      rootDir: "/vaults",
      vaults: () => [],
      statfs: statfsReturning(50 * GIB, 100 * GIB),
      diskFullTracker: tracker,
    });
    const result = await replacement();
    expect(result.status).toBe("error");
    expect(result.detail).toContain("ENOSPC observed at");
    expect(result.detail).toContain("blob CAS write");
  });

  it("forces error and names the event even when statfs looks fine", async () => {
    const tracker = new DiskFullTracker();
    tracker.report(
      Object.assign(new Error("no space left"), { code: "ENOSPC" }),
      "blob CAS write"
    );
    const probe = createDiskHealthProbe({
      rootDir: "/vaults",
      vaults: () => [],
      statfs: statfsReturning(50 * GIB, 100 * GIB), // plenty free right now
      diskFullTracker: tracker,
    });
    const result = await probe();
    expect(result.status).toBe("error");
    expect(result.detail).toContain("ENOSPC observed at");
    expect(result.detail).toContain("blob CAS write");
  });

  it("surfaces the event for one tick, then clears once a recovered reading has been served", async () => {
    const tracker = new DiskFullTracker();
    tracker.report(
      Object.assign(new Error("no space left"), { code: "ENOSPC" }),
      "gateway log persistence"
    );
    const probe = createDiskHealthProbe({
      rootDir: "/vaults",
      vaults: () => [],
      statfs: statfsReturning(50 * GIB, 100 * GIB),
      diskFullTracker: tracker,
    });

    const first = await probe();
    expect(first.status).toBe("error");
    expect(first.detail).toContain("ENOSPC observed");
    expect(tracker.current()).toBeNull();

    const second = await probe();
    expect(second.status).toBe("ok");
  });

  it("a low reading still forces error even without a tracked event (unchanged threshold behavior)", async () => {
    const tracker = new DiskFullTracker();
    const probe = createDiskHealthProbe({
      rootDir: "/vaults",
      vaults: () => [],
      statfs: statfsReturning(DISK_ERROR_BELOW_BYTES - 1, 100 * GIB),
      diskFullTracker: tracker,
    });
    const result = await probe();
    expect(result.status).toBe("error");
    expect(result.detail).not.toContain("ENOSPC observed");
  });

  it("defaults to the process-wide sharedDiskFullTracker when none is injected", async () => {
    const probe = createDiskHealthProbe({
      rootDir: "/vaults",
      vaults: () => [],
      statfs: statfsReturning(50 * GIB, 100 * GIB),
    });
    expect((await probe()).status).toBe("ok");
  });
});

describe(formatBytes, () => {
  it("formats across units", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * MIB)).toBe("5.0 MB");
    expect(formatBytes(3 * GIB)).toBe("3.0 GB");
  });
});
