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
    // Two section heads, each ABOVE its own container (binding layer v11).
    // There is no "On this machine" in-panel head on the footprint card: the
    // Capacity head states that figure itself.
    const headings = [...el.querySelectorAll("h2")].map(
      (heading) => heading.textContent
    );
    // ONE section head. Limits is a named row list, not a section of its own:
    // its rows say what each limit is and carry the verb that changes it, so a
    // head above them would only repeat the fieldset's own name.
    expect(headings).toStrictEqual(["Capacity"]);
    expect(
      el.querySelector('[aria-label="Limits"]'),
      "the limits list still names itself for assistive tech"
    ).not.toBeNull();
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

  // TWO vaults, not one: a single row here is the headline figure said again
  // under a bar that is necessarily full, so the block draws nothing below two
  // (VaultFootprintRows). The breakdown exists for exactly this case - several
  // vaults, one of them somebody else's.
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
        {
          vaultId: "v-mine",
          name: "My vault",
          bytes: 1 * GB,
          components: [{ component: "attachments", bytes: 1 * GB, files: 1 }],
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
    // Whose it is, said ON the row rather than in a parenthesis after the name.
    expect(byVault?.textContent).toContain("Priya's vault");
    expect(byVault?.textContent).toContain("Priya");
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
        {
          vaultId: "v-mine",
          name: "My vault",
          bytes: 1 * GB,
          components: [{ component: "attachments", bytes: 1 * GB, files: 1 }],
        },
      ],
    };
    const el = await mount({
      loadLocalUsage: () => Promise.resolve(withVaults),
    });
    const byVault = el.querySelector('[data-testid="footprint-by-vault"]');
    expect(byVault?.textContent).toContain("Priya's vault");
    // No roster to join, so the row falls back to "yours" rather than
    // inventing a name for a person it cannot identify.
    expect(byVault?.textContent).toContain("yours");
  });

  it("round-trips a limit change through the gateway", async () => {
    const saveStorageLimits = vi
      .fn<StorageScreenProps["saveStorageLimits"]>()
      .mockResolvedValue(report().limits);
    const el = await mount({ saveStorageLimits });
    // The LEDGER limit, because the disk budget is no longer offered: it was a
    // warning figure Centraid never stopped at, so the panel only surfaces one
    // if a stored value is stranded there, and then only to turn it off.
    const change = [...el.querySelectorAll("button")].find(
      (button) => button.title === "Change the ledger limit"
    ) as HTMLButtonElement;
    await act(async () => change.click());
    const control = el.querySelector('[data-testid="limit-control-ledger"]')!;
    const preset = [...control.querySelectorAll("button")].find(
      (button) => button.textContent === "1 GB"
    ) as HTMLButtonElement;
    await act(async () => preset.click());
    expect(saveStorageLimits).toHaveBeenCalledWith({
      journalLimitBytes: GB,
    });
  });

  it("keeps live capacity facts but removes Rescan and limit mutations for a viewer", async () => {
    const saveStorageLimits = vi.fn<StorageScreenProps["saveStorageLimits"]>();
    const el = await mount({ readOnly: true, saveStorageLimits });
    expect(el.textContent).toContain("3.0 GB");
    expect(
      el.querySelector('[data-testid="storage-limits-panel"]')
    ).not.toBeNull();
    // Read-only is the ABSENCE of the verb, not a second panel: one panel,
    // one testid, and the viewer's rows simply carry no action.
    expect(el.textContent).not.toContain("Change");
    expect(el.textContent).not.toContain("Rescan");
    expect(el.textContent).not.toContain("Set");
    expect(el.querySelector("input")).toBeNull();
    expect(saveStorageLimits).not.toHaveBeenCalled();
  });
});
