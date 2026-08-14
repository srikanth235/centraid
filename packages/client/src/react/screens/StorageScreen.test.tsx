import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LocalUsageReportDTO } from "../../gateway-client-local-storage.js";
import type { GatewayOwner } from "../../gateway-client-owners.js";
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

  it("adds the owner label beside each vault line when a roster is available (#726 P1)", async () => {
    const withVaults: LocalUsageReportDTO = {
      ...report(),
      vaults: [
        {
          vaultId: "v-priya",
          name: "Priya's vault",
          bytes: 2 * GB,
          components: [{ component: "attachments", bytes: 2 * GB, files: 3 }],
        },
      ],
    };
    const owners: GatewayOwner[] = [
      {
        ownerId: "o-priya",
        label: "Priya",
        createdAt: "2026-07-25T00:00:00.000Z",
        vaults: [{ vaultId: "v-priya", vaultName: "Priya's vault" }],
        deviceCount: 1,
      },
    ];
    const el = await mount({
      loadLocalUsage: () => Promise.resolve(withVaults),
      loadOwners: vi
        .fn<NonNullable<StorageScreenProps["loadOwners"]>>()
        .mockResolvedValue(owners),
    });
    const byVault = el.querySelector('[data-testid="footprint-by-vault"]');
    expect(byVault?.textContent).toContain("Priya's vault");
    expect(byVault?.textContent).toContain("(Priya)");
  });

  it("renders the vault line unlabeled when there is no owner roster to join", async () => {
    const withVaults: LocalUsageReportDTO = {
      ...report(),
      vaults: [
        {
          vaultId: "v-priya",
          name: "Priya's vault",
          bytes: 2 * GB,
          components: [{ component: "attachments", bytes: 2 * GB, files: 3 }],
        },
      ],
    };
    const el = await mount({
      loadLocalUsage: () => Promise.resolve(withVaults),
    });
    const byVault = el.querySelector('[data-testid="footprint-by-vault"]');
    expect(byVault?.textContent).toContain("Priya's vault");
    expect(byVault?.textContent).not.toContain("(Priya)");
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

  it("keeps live capacity facts but removes Rescan and limit mutations for a viewer", async () => {
    const saveStorageLimits = vi.fn<StorageScreenProps["saveStorageLimits"]>();
    const el = await mount({ readOnly: true, saveStorageLimits });
    expect(el.textContent).toContain("3.0 GB");
    expect(
      el.querySelector('[data-testid="storage-limits-read-only"]')
    ).not.toBeNull();
    expect(el.textContent).not.toContain("Rescan");
    expect(el.textContent).not.toContain("Set");
    expect(el.querySelector("input")).toBeNull();
    expect(saveStorageLimits).not.toHaveBeenCalled();
  });
});
