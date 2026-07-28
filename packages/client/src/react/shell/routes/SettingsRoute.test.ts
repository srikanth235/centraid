import { beforeAll, describe, expect, it } from "vitest";

let resolveSettingsPage: typeof import("./SettingsRoute.js").resolveSettingsPage;

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

  it.each(["workspace", "storage", "import"])(
    "redirects the hidden %s deep link to a real Settings page",
    (page) => {
      expect(resolveSettingsPage(page)).toBe("appearance");
    }
  );

  it("preserves a visible Settings deep link", () => {
    expect(resolveSettingsPage("space")).toBe("space");
  });
});
