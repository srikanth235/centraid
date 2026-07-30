import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LocalUsageReportDTO } from "../../gateway-client-local-storage.js";
import StorageScreen from "./StorageScreen.js";
import type { StorageScreenProps } from "./StorageScreen.js";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const GB = 1024 ** 3;

function report(): LocalUsageReportDTO {
  return {
    scannedAt: Date.UTC(2026, 6, 11),
    totalBytes: 3 * GB,
    components: [{ component: "logs", bytes: 100, files: 1 }],
    vaults: [],
    disk: { freeBytes: 120 * GB, totalBytes: 500 * GB },
    limits: {
      totalLimitBytes: null,
      warnAtPercent: 80,
      journalLimitBytes: null,
    },
    limit: {
      status: "ok",
      fractionUsed: null,
      usedBytes: 3 * GB,
      limitBytes: null,
    },
  };
}

async function mount(
  over: Partial<StorageScreenProps> = {}
): Promise<HTMLDivElement> {
  const props: StorageScreenProps = {
    loadLocalUsage: () => Promise.resolve(report()),
    saveStorageLimits: () => Promise.resolve(report().limits),
    ...over,
  };
  host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<StorageScreen {...props} />);
  });
  await act(
    async () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      })
  );
  return host;
}

describe(StorageScreen, () => {
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    vi.clearAllMocks();
  });

  it("renders only local footprint and limits, with independent partial state", async () => {
    const el = await mount();
    const headings = [...el.querySelectorAll("h2")].map(
      (heading) => heading.textContent
    );
    expect(headings).toStrictEqual(["On this machine", "Limits"]);
    expect(el.textContent).not.toContain("Backups");
  });

  it("loads the local report without a gateway-runtime gate", async () => {
    const loadLocalUsage = vi
      .fn<StorageScreenProps["loadLocalUsage"]>()
      .mockResolvedValue(report());
    const el = await mount({ loadLocalUsage });
    expect(loadLocalUsage).toHaveBeenCalledWith({});
    expect(el.textContent).not.toContain("Listening for the gateway heartbeat");
  });

  it("round-trips a limit change through the gateway", async () => {
    const saveStorageLimits = vi
      .fn<StorageScreenProps["saveStorageLimits"]>()
      .mockResolvedValue(report().limits);
    const el = await mount({ saveStorageLimits });
    const budget = el.querySelector('[data-testid="limit-control-budget"]')!;
    const preset = [...budget.querySelectorAll("button")].find(
      (button) => button.textContent === "30 GB"
    ) as HTMLButtonElement;
    await act(async () => preset.click());
    expect(saveStorageLimits).toHaveBeenCalledWith({
      totalLimitBytes: 30 * GB,
    });
  });
});
