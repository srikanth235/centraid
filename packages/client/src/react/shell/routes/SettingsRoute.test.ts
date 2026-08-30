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

  // `workspace`, `storage`, `import` and `device` are not Settings pages (#807,
  // #814); every unknown id must still land somewhere real, never on an empty
  // pane. `profile` is MERGED rather than gone, so its deep link must land on
  // the page holding the profile group, not on a same-named fallback.
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

  // Every surface that offers a revoke points here by this id (#883).
  it("opens Access — the one dashboard over standing answers", () => {
    expect(resolveSettingsPage("access")).toBe("access");
  });
});
