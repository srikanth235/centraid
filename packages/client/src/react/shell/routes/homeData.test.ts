import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AutomationFeedEntry } from "./automationsData.js";
import { buildHomeAppItems, buildHomeAutoItems } from "./homeData.js";

vi.mock(import("../../../gateway-client.js"), () => ({}));

describe("homeData", () => {
  beforeEach(() => {
    (globalThis as unknown as { CentraidTokens: unknown }).CentraidTokens = {
      tileFinish: () => ({
        background: "#111",
        boxShadow: "none",
        glyphColor: "#fff",
      }),
    };
  });

  const userApp = (id: string): UserAppMeta =>
    ({
      id,
      name: id,
      iconKey: "Todo",
      color: "#123",
      updatedAt: "2020-01-01T00:00:00Z",
    }) as unknown as UserAppMeta;
  const row = (
    over: Partial<CentraidAutomationRow> = {}
  ): CentraidAutomationRow =>
    ({
      id: "digest",
      ref: "digest/main",
      name: "Digest",
      enabled: true,
      triggers: [{ kind: "cron", expr: "0 9 * * *" }],
      manifest: { requires: { mcps: [] }, description: "runs daily" },
      ...over,
    }) as unknown as CentraidAutomationRow;

  const entry = (ok: boolean): AutomationFeedEntry => ({
    automationId: "digest/main",
    automationName: "Digest",
    run: {
      runId: "r",
      automationId: "digest/main",
      startedAt: Date.now(),
      ok,
    } as unknown as CentraidAutomationTurnRecord,
  });

  describe("homeData", () => {
    it("builds app items, flagging starred and stamping the last edit", () => {
      const items = buildHomeAppItems([userApp("todos"), userApp("notes")], {
        userApps: [userApp("todos")],
        isStarred: (id) => id === "todos",
        tileVariant: "gradient",
      });
      expect(items[0]).toMatchObject({
        id: "todos",
        starred: true,
        tone: null,
      });
      expect(items[1]).toMatchObject({ id: "notes", starred: false });
    });

    it("builds automation items with status + trigger labels", () => {
      const items = buildHomeAutoItems([row()], [entry(true)], () => false);
      expect(items[0]).toMatchObject({
        ref: "digest/main",
        name: "Digest",
        triggerIcon: "Clock",
      });
      expect(items[0]?.footOk).toBe(true);
    });
  });
});
