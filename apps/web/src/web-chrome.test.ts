import { afterEach, describe, expect, test } from "vitest";

import type { CentraidGatewayRuntime } from "../../../packages/client/src/centraid-api.js";
import { installWebChrome } from "./web-chrome.js";
import { saveSettingsPatch } from "./web-state.js";

describe("web chrome gateway status", () => {
  afterEach(() => {
    document
      .querySelectorAll(".web-notice")
      .forEach((element) => element.remove());
    localStorage.clear();
  });

  test("offline notice follows the gateway runtime, not navigator.onLine", async () => {
    saveSettingsPatch({ onboardingCompletedAt: new Date().toISOString() });
    let publish: ((snapshot: CentraidGatewayRuntime) => void) | undefined;
    const up = { status: "up" } as CentraidGatewayRuntime;
    Object.defineProperty(window, "CentraidApi", {
      configurable: true,
      value: {
        getGatewayRuntime: () => Promise.resolve(up),
        onGatewayRuntime: (callback: typeof publish) => {
          publish = callback;
          return () => undefined;
        },
      },
    });

    installWebChrome();
    await Promise.resolve();
    const notice = document.querySelector<HTMLElement>(".web-notice-offline")!;
    expect(Object.hasOwn(notice.dataset, "visible")).toBe(false);

    publish?.({ ...up, status: "down" });
    expect(Object.hasOwn(notice.dataset, "visible")).toBe(true);
    publish?.(undefined as unknown as CentraidGatewayRuntime);
    expect(Object.hasOwn(notice.dataset, "visible")).toBe(false);
    publish?.(up);
    expect(Object.hasOwn(notice.dataset, "visible")).toBe(false);
  });
});
