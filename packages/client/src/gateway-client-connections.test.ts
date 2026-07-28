import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import type * as TypeImport_1jh8y15 from "./gateway-client-connections.js";
import type * as TypeImport_dar201 from "./gateway-client-core.js";

let completeAssistAuthorization: typeof TypeImport_1jh8y15.completeAssistAuthorization;
let resetGatewayAuthCache: typeof TypeImport_dar201.resetGatewayAuthCache;

const getGatewayAuth = vi.fn<typeof window.CentraidApi.getGatewayAuth>();
const irohFetch = vi.fn<NonNullable<typeof window.CentraidIroh>["fetch"]>();

describe("gateway-client-connections", () => {
  beforeAll(async () => {
    window.CentraidApi = {
      getGatewayAuth,
      onGatewayChanged: () => () => undefined,
      onVaultChanged: () => () => undefined,
    } as unknown as typeof window.CentraidApi;
    window.CentraidIroh = {
      fetch: irohFetch,
      url: vi.fn<NonNullable<typeof window.CentraidIroh>["url"]>(),
    };
    ({ completeAssistAuthorization } =
      await import("./gateway-client-connections.js"));
    ({ resetGatewayAuthCache } = await import("./gateway-client-core.js"));
  });

  beforeEach(() => {
    sessionStorage.clear();
    getGatewayAuth.mockReset().mockResolvedValue({
      baseUrl: "",
      gatewayId: "iroh:gateway-1",
      iroh: true,
      token: "device-token",
      vaultId: "vault-1",
    });
    irohFetch.mockReset().mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, connection_id: "connection-1" }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        }
      )
    );
    resetGatewayAuthCache();
  });

  test("PWA completion re-dials the originating gateway over Iroh after navigation", async () => {
    const state = `w.${"A".repeat(43)}`;
    await expect(
      completeAssistAuthorization({
        code: "authorization-code",
        receipt: `v1.1999999999.${"B".repeat(43)}`,
        state,
      })
    ).resolves.toStrictEqual({ connectionId: "connection-1" });

    expect(irohFetch).toHaveBeenCalledWith(
      "/centraid/_vault/connections/assist/complete",
      expect.objectContaining({ method: "POST" })
    );
    const init = irohFetch.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer device-token");
    expect(headers.get("x-centraid-vault")).toBe("vault-1");
    expect(headers.get("x-centraid-client-session")).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.parse(String(init.body))).toStrictEqual({
      code: "authorization-code",
      receipt: `v1.1999999999.${"B".repeat(43)}`,
      state,
    });
  });
});
