import { beforeEach, describe, expect, test, vi } from "vitest";

import type {
  BrowserEndpoint as WasmBrowserEndpoint,
  InitOutput,
} from "./generated/centraid_web_iroh.js";
import {
  irohBridgeIdForConsent,
  irohFetch,
  moveIrohDeviceKeyForConsent,
  pairGatewayOverIroh,
  purgeIrohDeviceState,
} from "./iroh-transport.js";
import { loadConnection } from "./web-state.js";

const wasm = vi.hoisted(() => {
  const connectFailureMarker = "IROH_CONNECT_FAILURE";
  class BrowserEndpoint {
    static readonly spawn = vi.fn<typeof WasmBrowserEndpoint.spawn>(
      async (_key?: Uint8Array, _relays?: string[]) => new BrowserEndpoint()
    );
    secret_key = vi.fn<WasmBrowserEndpoint["secret_key"]>(
      () => new Uint8Array([1, 2, 3])
    );
    endpoint_id = vi.fn<WasmBrowserEndpoint["endpoint_id"]>(
      () => "endpoint-web-1"
    );
    pair_gateway = vi.fn<WasmBrowserEndpoint["pair_gateway"]>(async () =>
      JSON.stringify({
        ok: true,
        gatewayId: "gw-1",
        vaultId: "vault-1",
        vaultName: "Personal",
      })
    );
    request = vi.fn<WasmBrowserEndpoint["request"]>();
    close = vi.fn<WasmBrowserEndpoint["close"]>(async () => undefined);
    // Present only to match the real wasm-bindgen-generated `BrowserEndpoint`
    // shape (which the typed `vi.mock(import(...))` factory below now checks
    // against) — the real methods free/dispose the underlying Rust value;
    // nothing to release in this in-memory stand-in.
    free = vi.fn<WasmBrowserEndpoint["free"]>();
    [Symbol.dispose] = vi.fn<WasmBrowserEndpoint[typeof Symbol.dispose]>();
  }
  return {
    connectFailureMarker,
    BrowserEndpoint,
    // The real default export resolves to the wasm-bindgen `InitOutput`
    // (dozens of internal exports table entries); `iroh-transport.ts` only
    // awaits it and never reads the result, so a placeholder cast here is
    // honest — asserting only this one property, not the whole module.
    initWasm: vi.fn<typeof import("./generated/centraid_web_iroh.js").default>(
      async (): Promise<InitOutput> => undefined as unknown as InitOutput
    ),
    connect_failure_marker: vi.fn<
      typeof import("./generated/centraid_web_iroh.js").connect_failure_marker
    >(() => connectFailureMarker),
  };
});

vi.mock(import("./generated/centraid_web_iroh.js"), () => ({
  default: wasm.initWasm,
  BrowserEndpoint: wasm.BrowserEndpoint,
  connect_failure_marker: wasm.connect_failure_marker,
}));

vi.mock(import("./web-state.js"), () => ({
  loadConnection: vi.fn<typeof import("./web-state.js").loadConnection>(() => ({
    endpointTicket: "ticket-abc",
    endpointId: "gw-1",
    vaultId: "vault-1",
    label: "Web",
    displayName: "Web",
    avatarColor: "#6f5bf6",
    rememberDevice: true,
  })),
  webGatewayId: vi.fn<typeof import("./web-state.js").webGatewayId>(
    () => "gw-1"
  ),
}));

const DEVICE_KEY = "centraid.web.v1.iroh-device-key";
const BRIDGE_KEY = "centraid.web.v1.iroh-bridge";

describe("iroh-transport", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();
    // Drop the memoized endpoint promise between tests.
    purgeIrohDeviceState();
    wasm.BrowserEndpoint.spawn.mockImplementation(
      async () => new wasm.BrowserEndpoint()
    );
    (loadConnection as ReturnType<typeof vi.fn>).mockReturnValue({
      endpointTicket: "ticket-abc",
      endpointId: "gw-1",
      vaultId: "vault-1",
      label: "Web",
      displayName: "Web",
      avatarColor: "#6f5bf6",
      rememberDevice: true,
    });
  });

  describe("Iroh remember-device boundaries", () => {
    test("moves one stable device key between session and durable storage", () => {
      sessionStorage.setItem(DEVICE_KEY, "stable-key");
      expect(moveIrohDeviceKeyForConsent(true)).toBe("stable-key");
      expect(localStorage.getItem(DEVICE_KEY)).toBe("stable-key");
      expect(sessionStorage.getItem(DEVICE_KEY)).toBeNull();

      expect(moveIrohDeviceKeyForConsent(false)).toBe("stable-key");
      expect(sessionStorage.getItem(DEVICE_KEY)).toBe("stable-key");
      expect(localStorage.getItem(DEVICE_KEY)).toBeNull();
    });

    test("marks only remembered bridge scopes as durable-cache eligible", () => {
      const scope = "00000000-0000-4000-8000-000000000001";
      expect(irohBridgeIdForConsent(true, scope)).toBe(`d-${scope}`);
      expect(irohBridgeIdForConsent(false, scope)).toBe(`e-${scope}`);
    });
  });

  describe(pairGatewayOverIroh, () => {
    test("spawns an endpoint, pairs, and returns gateway identity", async () => {
      const result = await pairGatewayOverIroh({
        endpointTicket: "ticket-abc",
        ticketId: "t1",
        secret: "s1",
        deviceName: "Browser",
        rememberDevice: true,
      });
      expect(result.endpointId).toBe("endpoint-web-1");
      expect(result.response).toMatchObject({
        ok: true,
        gatewayId: "gw-1",
        vaultId: "vault-1",
      });
      expect(wasm.BrowserEndpoint.spawn).toHaveBeenCalledOnce();
      // encodeBytes([1,2,3]) is deterministic base64 'AQID'.
      expect(localStorage.getItem(DEVICE_KEY)).toBe("AQID");
    });

    test("propagates WASM spawn failures and clears the memoized endpoint", async () => {
      wasm.BrowserEndpoint.spawn.mockRejectedValueOnce(
        new Error("wasm init failed")
      );
      await expect(
        pairGatewayOverIroh({
          endpointTicket: "ticket-abc",
          ticketId: "t1",
          secret: "s1",
          deviceName: "Browser",
          rememberDevice: false,
        })
      ).rejects.toThrow("wasm init failed");
      // A subsequent call must re-spawn rather than reuse the failed promise.
      wasm.BrowserEndpoint.spawn.mockImplementation(
        async () => new wasm.BrowserEndpoint()
      );
      await expect(
        pairGatewayOverIroh({
          endpointTicket: "ticket-abc",
          ticketId: "t1",
          secret: "s1",
          deviceName: "Browser",
          rememberDevice: false,
        })
      ).resolves.toMatchObject({ endpointId: "endpoint-web-1" });
    });
  });

  describe(irohFetch, () => {
    test("throws when no iroh connection is configured", async () => {
      (loadConnection as ReturnType<typeof vi.fn>).mockReturnValue({
        label: "Web",
        displayName: "Web",
        avatarColor: "#6f5bf6",
      });
      await expect(irohFetch("/centraid/_gateway/health")).rejects.toThrow(
        "No Iroh gateway is connected."
      );
    });

    test("returns a Response from a successful stream and retries connect failures on GET", async () => {
      const node = new wasm.BrowserEndpoint();
      let attempts = 0;
      node.request.mockImplementation(async () => {
        attempts += 1;
        if (attempts === 1)
          throw new Error(`dial ${wasm.connectFailureMarker}`);
        return {
          status: 200,
          headers_json: JSON.stringify({ "content-type": "application/json" }),
          free: () => undefined,
          [Symbol.dispose]: () => undefined,
          take_body: () =>
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"ok":true}'));
                controller.close();
              },
            }),
        };
      });
      wasm.BrowserEndpoint.spawn.mockResolvedValueOnce(node);

      const response = await irohFetch("/centraid/_gateway/health", {
        method: "GET",
      });
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('{"ok":true}');
      expect(attempts).toBe(2);
    });

    test("does not retry non-idempotent failures that are not connect failures", async () => {
      const node = new wasm.BrowserEndpoint();
      node.request.mockImplementation(async () => {
        throw new Error("stream reset mid-body");
      });
      wasm.BrowserEndpoint.spawn.mockResolvedValueOnce(node);

      await expect(
        irohFetch("/centraid/_apps", { method: "POST", body: "{}" })
      ).rejects.toThrow("stream reset mid-body");
      expect(node.request).toHaveBeenCalledOnce();
    });
  });

  describe(purgeIrohDeviceState, () => {
    test("clears device key + bridge scope from both storage buckets", () => {
      localStorage.setItem(DEVICE_KEY, "k");
      localStorage.setItem(BRIDGE_KEY, '{"id":"d-1"}');
      sessionStorage.setItem(DEVICE_KEY, "k2");
      sessionStorage.setItem(BRIDGE_KEY, '{"id":"e-1"}');
      purgeIrohDeviceState();
      expect(localStorage.getItem(DEVICE_KEY)).toBeNull();
      expect(localStorage.getItem(BRIDGE_KEY)).toBeNull();
      expect(sessionStorage.getItem(DEVICE_KEY)).toBeNull();
      expect(sessionStorage.getItem(BRIDGE_KEY)).toBeNull();
    });
  });
});
