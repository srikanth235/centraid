import { describe, expect, it } from "vitest";

import {
  client,
  compile,
  editing,
  fetchMock,
  installGatewayContractHarness,
} from "./gateway-client-contract-fixtures.js";

installGatewayContractHarness();

interface SentRequest {
  method: string;
  path: string;
  query: URLSearchParams;
}

function transcript(): SentRequest[] {
  return fetchMock.mock.calls.map(([url, init]) => {
    const parsed = new URL(String(url));
    return {
      method: (init as RequestInit | undefined)?.method ?? "GET",
      path: parsed.pathname,
      query: parsed.searchParams,
    };
  });
}

function sentBy(
  requests: SentRequest[],
  path: string,
  predicate: (query: URLSearchParams) => boolean = () => true,
  method = "GET"
): boolean {
  return requests.some(
    (request) =>
      request.path === path &&
      request.method === method &&
      predicate(request.query)
  );
}

describe("renderer gateway automation contracts", () => {
  it("covers the app, version, prefs, and health surfaces", async () => {
    await expect(client.readGatewayCapabilities()).resolves.toMatchObject({
      automationTurns: true,
    });
    await client.appLogs({ id: "daily", limit: 7, sinceTs: 1, level: "info" });
    await client.appSettings({ id: "daily" });
    await client.appSettingWrite({
      id: "daily",
      key: "timezone",
      value: undefined,
    });
    await client.deregisterApp({ id: "old app" });
    await client.listApps();
    await client.listTemplates();
    await expect(client.listVersions({ id: "daily" })).resolves.toMatchObject({
      activeVersion: "v2",
      versions: [expect.objectContaining({ current: true, versionId: "v2" })],
    });
    await client.activateVersion({ id: "daily", versionId: "v2" });
    await client.getUserId();
    await client.getUserPrefs();
    await client.saveUserPrefs({ harness: "codex" });
    await client.getInsightsSummary({ windowDays: 7 });
    await client.getInsightsSummary();
    await client.getGatewayHealth();
    await client.pauseBackgroundWork(60_000);
    await client.pauseBackgroundWork();
    await client.resumeBackgroundWork();
  });

  it("covers the automation turn surface", async () => {
    await client.listAutomations();
    await expect(
      client.readAutomation({ automationId: "invalid" })
    ).resolves.toBeNull();
    await client.readAutomation({ automationId: "daily/daily" });
    await client.runAutomationNow({ automationId: "daily/daily" });
    await expect(
      client.invokeAutomationAndAwait({
        automationId: "daily/daily",
        payload: { variant: "deterministic" },
      })
    ).resolves.toMatchObject({
      turnId: "turn-awaited",
      result: { outcome: { ok: true } },
    });
    await client.listAutomationTurns({ automationId: "daily/daily", limit: 3 });
    await client.listAutomationTurns({});
    await client.readAutomationTurn({ turnId: "turn-1" });
    await client.readAutomationTurnExpanded({ turnId: "turn-1" });
    await client.readLatestAutomationTurnExpanded({
      automationId: "daily/daily",
    });
    await client.listAutomationItems({ turnId: "turn-1" });

    const turnEvents: string[] = [];
    await client.streamAutomationTurn(
      "turn-1",
      (event) => turnEvents.push(event.type),
      new AbortController().signal
    );
    expect(turnEvents).toStrictEqual(["turn.end"]);
    const conversationEvents: string[] = [];
    await expect(
      client.streamAutomationConversationTurn(
        "daily/daily",
        "revise it",
        (event) => conversationEvents.push(event.type),
        new AbortController().signal
      )
    ).resolves.toStrictEqual({ ended: true, turnId: "turn-2" });
    expect(conversationEvents).toContain("final");

    await client.pinAutomationTurn({ turnId: "turn-1", pinned: true });

    const requests = transcript();
    const sent = (
      path: string,
      predicate?: (query: URLSearchParams) => boolean,
      method?: string
    ): boolean => sentBy(requests, path, predicate, method);

    expect(
      sent(
        "/centraid/_automations/turn-now",
        (q) => q.get("ref") === "daily/daily",
        "POST"
      )
    ).toBe(true);
    expect(
      sent(
        "/centraid/_automations/invoke-and-await",
        (q) => q.get("ref") === "daily/daily",
        "POST"
      )
    ).toBe(true);
    expect(
      sent(
        "/centraid/_automations/turns",
        (q) => q.get("ref") === "daily/daily" && q.get("limit") === "3"
      )
    ).toBe(true);
    expect(
      sent(
        "/centraid/_automations/turns",
        (q) => !q.has("ref") && q.get("limit") === "50"
      )
    ).toBe(true);
    expect(
      sent(
        "/centraid/_automations/turn",
        (q) => q.get("turnId") === "turn-1" && q.get("expand") === "items"
      )
    ).toBe(true);
    expect(
      sent(
        "/centraid/_automations/turn",
        (q) => q.get("ref") === "daily/daily" && q.get("expand") === "items"
      )
    ).toBe(true);
    expect(
      sent(
        "/centraid/_automations/turn",
        (q) => q.get("turnId") === "turn-1" && !q.has("expand")
      )
    ).toBe(true);
    expect(
      sent(
        "/centraid/_automations/turn/items",
        (q) => q.get("turnId") === "turn-1"
      )
    ).toBe(true);
    expect(
      sent(
        "/centraid/_automations/turn/events",
        (q) => q.get("turnId") === "turn-1"
      )
    ).toBe(true);
    expect(
      sent(
        "/centraid/_automations/turn",
        (q) => q.get("ref") === "daily/daily",
        "POST"
      )
    ).toBe(true);
    expect(
      sent(
        "/centraid/_automations/turn/pin",
        (q) => q.get("turnId") === "turn-1",
        "POST"
      )
    ).toBe(true);
  });

  it("covers the automation compile and lifecycle surfaces", async () => {
    await compile.compileAutomation({
      automationId: "daily/daily",
      enableOnSuccess: true,
    });
    await compile.reviseAutomation({
      automationId: "daily/daily",
      message: "be concise",
    });
    await compile.readAutomationSource("daily/daily");

    const created = await editing.createAutomation({
      id: "daily",
      name: "Daily",
      prompt: "Run daily",
      triggers: [{ kind: "cron", expr: "0 9 * * *" }],
      harness: "codex",
      model: "openai/gpt-test",
    });
    expect(created.webhook?.secret).toBe("secret-1");
    const updated = await editing.updateAutomation({
      automationId: "daily/daily",
      name: "Daily revised",
      prompt: "Run every day",
      triggers: [{ kind: "webhook" }],
      connections: [
        { connectionId: "connection-1", kind: "github", label: "Work" },
      ],
      connector: {
        kind: "github",
        label: "Work",
        connectionId: "connection-1",
      },
      harness: null,
      model: null,
    });
    expect(updated.webhook?.secret).toBe("secret-2");
    await editing.setAutomationEnabled({
      automationId: "daily/daily",
      enabled: false,
    });
    await editing.rotateAutomationWebhookSecret({
      automationId: "daily/daily",
    });
    await editing.deleteAutomation({ automationId: "daily/daily" });

    const paths = transcript().map((request) => request.path);
    expect(paths).toContain("/centraid/_automations/compile");
    expect(paths).toContain("/centraid/_automations/revise");
    expect(paths).toContain("/centraid/_automations/set-enabled");
    expect(paths).toContain("/centraid/_apps/_sessions/desktop-daily");
  });

  it("fails a client that calls a path the gateway does not serve", () => {
    expect(() =>
      fetch("https://gateway.test/centraid/_automations/runs?ref=daily/daily")
    ).toThrow(/unrouted gateway path: GET \/centraid\/_automations\/runs/u);
  });
});
