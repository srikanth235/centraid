import { beforeEach, describe, expect, test, vi } from "vitest";

import { runAutomation } from "./automations";

const { fetchJson } = vi.hoisted(() => ({
  // `fetchJson` is generic (`<T>(href, init?) => Promise<T>`); a typed mock erases
  // the type parameter, so `Mock<...>` stops being assignable to the export.
  fetchJson: vi.fn<(href: string, init?: RequestInit) => Promise<unknown>>(),
}));

vi.mock(import("./gateway") as Promise<unknown>, () => ({
  authHeader: () => ({ authorization: "Bearer paired" }),
  fetchJson,
  requireGatewayBase: async () => "https://gateway.example",
}));

describe("automations", () => {
  beforeEach(() => {
    fetchJson.mockReset();
  });

  test("runAutomation consumes the native turnId response contract", async () => {
    fetchJson.mockResolvedValue({ turnId: "brief/main:manual:1" });
    await expect(runAutomation("brief/main")).resolves.toBe(
      "brief/main:manual:1"
    );
    expect(fetchJson).toHaveBeenCalledWith(
      "https://gateway.example/centraid/_automations/turn-now?ref=brief%2Fmain",
      {
        headers: { authorization: "Bearer paired" },
        method: "POST",
      }
    );
  });
});
