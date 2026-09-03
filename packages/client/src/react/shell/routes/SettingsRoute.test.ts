import { beforeAll, describe, expect, it } from "vitest";

import type * as TypeImport_11x360t from "./SettingsRoute.js";

let resolveSettingsPage: typeof TypeImport_11x360t.resolveSettingsPage;

describe("resolveSettingsPage", () => {
  beforeAll(async () => {
    Object.defineProperty(window, "CentraidApi", {
      configurable: true,
      value: {
        onGatewayChanged: () => () => undefined,
        onVaultChanged: () => () => undefined,
      },
    });
    ({ resolveSettingsPage } = await import("./SettingsRoute.js"));
  });

  it.each([
    "workspace",
    "storage",
    "import",
    "device",
    "profile",
    "not-a-page",
  ])("redirects the retired %s deep link to a real Settings page", (page) => {
    expect(resolveSettingsPage(page)).toBe("appearance");
  });

  it("preserves a visible Settings deep link", () => {
    expect(resolveSettingsPage("vault")).toBe("vault");
  });

  it("opens the Enrichment page from the app popover's deep link", () => {
    expect(resolveSettingsPage("enrichment")).toBe("enrichment");
  });

  it("opens Access — the one dashboard over standing answers", () => {
    expect(resolveSettingsPage("access")).toBe("access");
  });
});
