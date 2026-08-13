/* oxlint-disable import/first -- vi.mock is hoisted; subject imports intentionally follow */
/**
 * Connections client (issue #765) — the wire mapping the Connectors place
 * depends on. The gateway HTTP core is mocked so vitest never loads react
 * native; what is under test is the URL, the header set, and the snake_case →
 * camelCase boundary.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(import("./gateway") as Promise<unknown>, () => ({
  apiHeaders: (extra?: Record<string, string>) => ({ auth: "1", ...extra }),
  beginNotificationsConnectionAuthorization:
    vi.fn<typeof GatewayModule.beginNotificationsConnectionAuthorization>(),
  completeNotificationsConnectionAuthorization:
    vi.fn<typeof GatewayModule.completeNotificationsConnectionAuthorization>(),
  fetchJson: vi.fn<typeof GatewayModule.fetchJson>(),
  requireGatewayBase: vi.fn<typeof GatewayModule.requireGatewayBase>(
    async () => "http://127.0.0.1:9"
  ),
}));

import {
  beginConnectionAuthorization,
  completeConnectionAuthorization,
  listConnections,
  setConnectionStatus,
} from "./connections";
import type * as GatewayModule from "./gateway";
import { fetchJson } from "./gateway";

const json = vi.mocked(fetchJson);

const WIRE_ROW = {
  allowed_hosts: ["googleapis.com"],
  auth_note: "token expired",
  connection_id: "c1",
  created_at: "2026-01-01T00:00:00.000Z",
  cred_kind: "oauth2" as const,
  has_refresh_token: true,
  kind: "google",
  label: "Gmail",
  last_run_at: null,
  principal: "you@example.com",
  provider: "google",
  scopes: "gmail.readonly",
  status: "needs-auth" as const,
  token_expires_at: null,
  trust: "staged" as const,
};

describe("mobile connections client", () => {
  beforeEach(() => {
    json.mockReset();
  });

  describe(listConnections, () => {
    it("maps the raw column shape onto camelCase", async () => {
      json.mockResolvedValue({ connections: [WIRE_ROW] });
      const rows = await listConnections();
      expect(rows).toStrictEqual([
        {
          allowedHosts: ["googleapis.com"],
          authNote: "token expired",
          connectionId: "c1",
          createdAt: "2026-01-01T00:00:00.000Z",
          credKind: "oauth2",
          hasRefreshToken: true,
          kind: "google",
          label: "Gmail",
          lastRunAt: null,
          // No `oauth_mode` on the wire + an OAuth credential ⇒ a BYO client.
          oauthMode: "byo",
          principal: "you@example.com",
          provider: "google",
          scopes: "gmail.readonly",
          status: "needs-auth",
          tokenExpiresAt: null,
          trust: "staged",
        },
      ]);
      expect(json).toHaveBeenCalledWith(
        "http://127.0.0.1:9/centraid/_vault/connections",
        { headers: { auth: "1" }, method: "GET" }
      );
    });

    it("reads an absent list as no connections, not as a failure", async () => {
      json.mockResolvedValue({});
      await expect(listConnections()).resolves.toStrictEqual([]);
    });

    it("keeps a credential-less row's mode null", async () => {
      json.mockResolvedValue({
        connections: [{ ...WIRE_ROW, cred_kind: null }],
      });
      const [row] = await listConnections();
      expect(row?.oauthMode).toBeNull();
      expect(row?.credKind).toBeNull();
    });
  });

  describe(setConnectionStatus, () => {
    it("PATCHes the status, and the note only when given", async () => {
      json.mockResolvedValue({ ok: true });
      await setConnectionStatus("c 1", "paused");
      expect(json).toHaveBeenCalledWith(
        "http://127.0.0.1:9/centraid/_vault/connections/c%201",
        {
          body: JSON.stringify({ status: "paused" }),
          headers: { auth: "1", "content-type": "application/json" },
          method: "PATCH",
        }
      );
      await setConnectionStatus("c1", "active", "resumed by you");
      expect(json).toHaveBeenLastCalledWith(
        expect.stringContaining("/connections/c1"),
        expect.objectContaining({
          body: JSON.stringify({ note: "resumed by you", status: "active" }),
        })
      );
    });
  });

  describe("re-exported authorization flow", () => {
    it("is the phone's existing implementation, not a second one", async () => {
      const gateway = await import("./gateway");
      expect(beginConnectionAuthorization).toBe(
        gateway.beginNotificationsConnectionAuthorization
      );
      expect(completeConnectionAuthorization).toBe(
        gateway.completeNotificationsConnectionAuthorization
      );
    });
  });
});
