import { beforeEach, describe, expect, test, vi } from "vitest";

import type * as TypeImport_lorinj from "./iroh-transport.js";
import { installWebHost } from "./web-host.js";

const { pairGatewayOverIroh, purgeIrohDeviceState, syncIrohWakeConfiguration } =
  vi.hoisted(() => ({
    pairGatewayOverIroh: vi.fn<typeof TypeImport_lorinj.pairGatewayOverIroh>(),
    purgeIrohDeviceState:
      vi.fn<typeof TypeImport_lorinj.purgeIrohDeviceState>(),
    syncIrohWakeConfiguration: vi.fn<
      typeof TypeImport_lorinj.syncIrohWakeConfiguration
    >(async () => undefined),
  }));
vi.mock(import("./iroh-transport.js"), () => ({
  pairGatewayOverIroh,
  purgeIrohDeviceState,
  syncIrohWakeConfiguration,
}));

function ticket(): string {
  return btoa(
    JSON.stringify({
      v: 1,
      kind: "centraid-gw-pair",
      gw: "endpoint",
      t: "ticket",
      s: "secret",
      vaultName: "Personal",
      exp: Date.now() + 60_000,
    })
  );
}

describe("web-host", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
    pairGatewayOverIroh.mockReset();
    installWebHost();
  });

  test("ticket-only pairing enrolls the stable browser identity over Iroh", async () => {
    pairGatewayOverIroh.mockResolvedValue({
      endpointId: "browser-endpoint",
      response: {
        ok: true,
        gatewayId: "gateway-endpoint",
        gatewayName: "Home gateway",
        vaultId: "vault-1",
        vaultName: "Personal",
      },
    });

    await expect(
      window.CentraidApi.redeemGatewayPairing({ ticket: ticket() })
    ).resolves.toMatchObject({
      ok: true,
      vaultId: "vault-1",
      vaultName: "Personal",
    });
    expect(pairGatewayOverIroh).toHaveBeenCalledWith({
      endpointTicket: "endpoint",
      ticketId: "ticket",
      secret: "secret",
      deviceName: expect.stringMatching(/^Web browser · [A-F0-9]{4}$/u),
      rememberDevice: false,
    });
    // Durable even though `rememberDevice` defaulted to false: the enrollment
    // must survive closing the browser, or the device silently unpairs.
    const persisted = JSON.parse(
      localStorage.getItem("centraid.web.v1.connection") ?? "{}"
    ) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      endpointTicket: "endpoint",
      endpointId: "gateway-endpoint",
      vaultId: "vault-1",
      label: "Home gateway",
    });
    expect(JSON.stringify(persisted)).not.toContain("secret");
    await expect(window.CentraidApi.getGatewayAuth()).resolves.toMatchObject({
      gatewayId: "gateway-endpoint",
      vaultId: "vault-1",
    });
  });

  test("an unremembered pairing survives closing the browser", async () => {
    pairGatewayOverIroh.mockResolvedValue({
      endpointId: "browser-endpoint",
      response: {
        ok: true,
        gatewayId: "gateway-endpoint",
        vaultId: "vault-1",
        vaultName: "Personal",
      },
    });
    await window.CentraidApi.redeemGatewayPairing({ ticket: ticket() });

    // A browser restart drops sessionStorage and nothing else. Declining the
    // offline copy used to put the enrollment there, so the next launch asked
    // for a pairing ticket a device that was already paired.
    sessionStorage.clear();

    await expect(window.CentraidApi.getGatewayAuth()).resolves.toMatchObject({
      gatewayId: "gateway-endpoint",
      vaultId: "vault-1",
      rememberDevice: false,
    });
  });

  test("remembered pairing opts the connection into durable browser storage", async () => {
    pairGatewayOverIroh.mockResolvedValue({
      endpointId: "browser-endpoint",
      response: {
        ok: true,
        gatewayId: "gateway-endpoint",
        vaultId: "vault-1",
        vaultName: "Personal",
      },
    });

    await expect(
      window.CentraidApi.redeemGatewayPairing({
        ticket: ticket(),
        rememberDevice: true,
      })
    ).resolves.toMatchObject({ ok: true, vaultId: "vault-1" });
    expect(pairGatewayOverIroh).toHaveBeenCalledWith(
      expect.objectContaining({ rememberDevice: true })
    );
    expect(localStorage.getItem("centraid.web.v1.connection")).toContain(
      '"rememberDevice":true'
    );
    expect(sessionStorage.getItem("centraid.web.v1.connection")).toBeNull();
  });

  test("expired pairing tickets fail before any network request", async () => {
    const expired = btoa(
      JSON.stringify({
        v: 1,
        kind: "centraid-gw-pair",
        gw: "endpoint",
        t: "ticket",
        s: "secret",
        vaultName: "Personal",
        exp: Date.now() - 1,
      })
    );
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      window.CentraidApi.redeemGatewayPairing({
        ticket: expired,
      })
    ).resolves.toMatchObject({ ok: false, error: "ticket_expired" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("vault previews use the canonical gateway vault-list route", async () => {
    sessionStorage.setItem(
      "centraid.web.v1.connection",
      JSON.stringify({
        endpointId: "gateway-endpoint",
        endpointTicket: "endpoint-ticket",
        label: "Gateway",
        displayName: "Gateway",
        avatarColor: "#123456",
      })
    );
    const tunnelFetch = vi
      .fn<(path: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ vaults: [{ vaultId: "v1", name: "Personal" }] }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        )
      );
    window.CentraidIroh = {
      fetch: tunnelFetch,
      url: async (path: string) => path,
    };
    await expect(
      window.CentraidApi.listGatewayVaults({ gatewayId: "web" })
    ).resolves.toStrictEqual({
      ok: true,
      vaults: [{ vaultId: "v1", name: "Personal" }],
    });
    expect(tunnelFetch).toHaveBeenCalledWith(
      "/centraid/_vault/vaults",
      expect.any(Object)
    );
  });

  test("connection replacement and consent downgrade publish targeted replica purge hints", async () => {
    const changed =
      vi.fn<Parameters<typeof window.CentraidApi.onGatewayChanged>[0]>();
    const off = window.CentraidApi.onGatewayChanged(changed);
    await window.CentraidApi.addGateway({
      label: "First",
      endpointId: "endpoint-one",
      rememberDevice: true,
    });
    await window.CentraidApi.addGateway({
      label: "Second",
      endpointId: "endpoint-two",
      rememberDevice: false,
    });
    off();

    expect(changed).toHaveBeenLastCalledWith({
      activeGatewayId: "web",
      gatewayId: "endpoint-two",
      removedGatewayId: "endpoint-one",
      purgeReplicaGatewayId: "endpoint-two",
    });
  });

  // Pairing stopped asking about the offline copy, so Settings → This device
  // is the only place it is answered — and turning it off has to actually
  // take the replica with it, not just flip a stored flag.
  test("turning the offline copy off persists it and asks the shell to purge the replica", async () => {
    await window.CentraidApi.addGateway({
      label: "Home",
      endpointId: "gateway-endpoint",
      rememberDevice: true,
    });
    const changed =
      vi.fn<Parameters<typeof window.CentraidApi.onGatewayChanged>[0]>();
    const off = window.CentraidApi.onGatewayChanged(changed);

    await expect(
      window.CentraidApi.setGatewayRememberDevice({ rememberDevice: false })
    ).resolves.toStrictEqual({ rememberDevice: false });
    off();

    expect(localStorage.getItem("centraid.web.v1.connection")).toContain(
      '"rememberDevice":false'
    );
    expect(changed).toHaveBeenLastCalledWith({
      activeGatewayId: "web",
      gatewayId: "gateway-endpoint",
      purgeReplicaGatewayId: "gateway-endpoint",
    });
  });

  test("turning the offline copy back on publishes no purge hint", async () => {
    await window.CentraidApi.addGateway({
      label: "Home",
      endpointId: "gateway-endpoint",
      rememberDevice: false,
    });
    const changed =
      vi.fn<Parameters<typeof window.CentraidApi.onGatewayChanged>[0]>();
    const off = window.CentraidApi.onGatewayChanged(changed);

    await expect(
      window.CentraidApi.setGatewayRememberDevice({ rememberDevice: true })
    ).resolves.toStrictEqual({ rememberDevice: true });
    off();

    expect(changed).toHaveBeenLastCalledWith({
      activeGatewayId: "web",
      gatewayId: "gateway-endpoint",
    });
  });

  test("removing a remembered gateway clears durable consent and device state", async () => {
    localStorage.setItem(
      "centraid.web.v1.connection",
      JSON.stringify({
        endpointId: "gateway-endpoint",
        endpointTicket: "ticket",
        label: "Gateway",
        displayName: "Gateway",
        avatarColor: "#123456",
        rememberDevice: true,
      })
    );
    const changed =
      vi.fn<Parameters<typeof window.CentraidApi.onGatewayChanged>[0]>();
    const off = window.CentraidApi.onGatewayChanged(changed);

    await window.CentraidApi.removeGateway({ id: "web" });
    off();

    expect(purgeIrohDeviceState).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem("centraid.web.v1.connection")).toBeNull();
    const cleared = JSON.parse(
      localStorage.getItem("centraid.web.v1.connection") ?? "{}"
    ) as Record<string, unknown>;
    expect(cleared).toMatchObject({ rememberDevice: false });
    expect(cleared["endpointId"]).toBeUndefined();
    expect(changed).toHaveBeenLastCalledWith({
      activeGatewayId: "web",
      removedGatewayId: "gateway-endpoint",
    });
  });
});
