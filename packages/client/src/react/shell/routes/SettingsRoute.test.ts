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

  // Three pages were hidden for several releases and are gone (#807), and
  // `device` retired in #814; their deep links must still land somewhere real
  // rather than on an empty pane, which is the law this function carries for
  // EVERY unknown id.
  // `profile` is here for a different reason: it is not retired but MERGED,
  // so its deep link has to land on the page that now holds the profile
  // group rather than on a fallback that happens to be the same id.
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
});
