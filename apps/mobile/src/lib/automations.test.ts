import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  cloneAutomationTemplate,
  listAutomations,
  listAutomationTurns,
  listAutomationTemplates,
  runAutomation,
  setAutomationEnabled,
} from "./automations";

const { fetchJson } = vi.hoisted(() => ({
  fetchJson: vi.fn<(href: string, init?: RequestInit) => Promise<unknown>>(),
}));

vi.mock(import("./gateway") as Promise<unknown>, () => ({
  apiHeaders: (extra?: Record<string, string>) => ({
    authorization: "Bearer paired",
    "x-centraid-vault": "vault-active",
    ...extra,
  }),
  fetchJson,
  requireGatewayBase: async () => "https://gateway.example",
}));

const AUTHED = {
  authorization: "Bearer paired",
  "x-centraid-vault": "vault-active",
};

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
        headers: AUTHED,
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
        headers: AUTHED,
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
        headers: AUTHED,
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
        headers: { ...AUTHED, "content-type": "application/json" },
        method: "POST",
      }
    );
  });

  test("every automation call is scoped to the active vault", async () => {
    const calls: Array<[string, Record<string, string>]> = [];
    fetchJson.mockImplementation(async (href, init) => {
      calls.push([href, (init?.headers ?? {}) as Record<string, string>]);
      return href.includes("/_templates")
        ? []
        : { rows: [], turns: [], turnId: "t", ok: true };
    });
    await listAutomations();
    await listAutomationTurns("brief/main");
    await runAutomation("brief/main");
    await setAutomationEnabled("brief/main", true);
    await cloneAutomationTemplate("obligation-extractor");
    await listAutomationTemplates();
    expect(calls).toHaveLength(6);
    for (const [href, headers] of calls) {
      expect([href, headers["x-centraid-vault"]]).toStrictEqual([
        href,
        "vault-active",
      ]);
      expect(headers.authorization).toBe("Bearer paired");
    }
  });
});
