import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  cloneAutomationTemplate,
  listAutomationTurns,
  listAutomationTemplates,
  runAutomation,
} from "./automations";

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

  test("loads the exact automation conversation thread", async () => {
    const turns = [
      {
        turnId: "brief/main:manual:1",
        triggerKind: "manual",
        startedAt: 1,
        ok: true,
      },
    ];
    fetchJson.mockResolvedValue({ turns });
    await expect(listAutomationTurns("brief/main")).resolves.toStrictEqual(
      turns
    );
    expect(fetchJson).toHaveBeenCalledWith(
      "https://gateway.example/centraid/_automations/turns?ref=brief%2Fmain&limit=50",
      {
        headers: { authorization: "Bearer paired" },
        method: "GET",
      }
    );
  });

  test("lists only the curated automation gallery", async () => {
    fetchJson.mockResolvedValue([
      {
        id: "obligation-extractor",
        name: "Document deadlines",
        desc: "Find deadlines in documents.",
        kind: "automation",
      },
      {
        id: "unlisted-automation",
        name: "Hidden",
        desc: "Not in v0.",
        kind: "automation",
      },
      {
        id: "docs",
        name: "Docs",
        desc: "An app.",
        kind: "app",
      },
    ]);
    await expect(listAutomationTemplates()).resolves.toStrictEqual([
      {
        id: "obligation-extractor",
        name: "Document deadlines",
        desc: "Find deadlines in documents.",
        kind: "automation",
      },
    ]);
    expect(fetchJson).toHaveBeenCalledWith(
      "https://gateway.example/centraid/_templates",
      {
        headers: { authorization: "Bearer paired" },
        method: "GET",
      }
    );
  });

  test("publishes a selected automation starter", async () => {
    fetchJson.mockResolvedValue({ app: { id: "document-deadlines-2" } });
    await cloneAutomationTemplate("obligation-extractor");
    expect(fetchJson).toHaveBeenCalledWith(
      "https://gateway.example/centraid/_apps/_clone",
      {
        body: JSON.stringify({
          templateId: "obligation-extractor",
          publish: true,
        }),
        headers: {
          authorization: "Bearer paired",
          "content-type": "application/json",
        },
        method: "POST",
      }
    );
  });
});
