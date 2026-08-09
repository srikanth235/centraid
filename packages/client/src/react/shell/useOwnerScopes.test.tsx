import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as TypeImport_bmsl46 from "../../gateway-client.js";
import type * as TypeImport_4z974v from "./useOwnerScopes.js";

const { listAppScopes, listVaults } = vi.hoisted(() => ({
  listAppScopes: vi.fn<typeof TypeImport_bmsl46.listAppScopes>(),
  listVaults: vi.fn<typeof TypeImport_bmsl46.listVaults>(),
}));
vi.mock(import("../../gateway-client.js") as Promise<unknown>, () => ({
  listAppScopes,
  listVaults,
}));

let useOwnerScopes: typeof TypeImport_4z974v.useOwnerScopes;
let root: Root | null = null;
let host: HTMLElement | null = null;
describe("useOwnerScopes suite", () => {
  beforeEach(async () => {
    listAppScopes.mockReset();
    listVaults.mockReset();
    (globalThis as unknown as { CentraidApi: unknown }).CentraidApi = {
      getGatewayAuth: () => Promise.resolve({ baseUrl: "", vaultId: "a" }),
      getSettings: () =>
        Promise.resolve({
          activeGatewayId: "local",
          activeGatewayLabel: "This Mac",
          activeGatewayKind: "local",
        }),
      onVaultChanged: () => () => {},
      onGatewayChanged: () => () => {},
    };
    ({ useOwnerScopes } = await import("./useOwnerScopes.js"));
  });

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  let ctl: ReturnType<typeof useOwnerScopes>;
  function Harness(): null {
    const value = useOwnerScopes();
    // Published from a commit-time effect, not the render body — assigning to an
    // outer binding during render is a side effect.
    useEffect(() => {
      ctl = value;
    });
    return null;
  }
  async function mount(): Promise<void> {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<Harness />);
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  describe("useOwnerScopes", () => {
    it("reads the owner scope plane, sourced from the gateway's canWrite, own vault first", async () => {
      listAppScopes.mockResolvedValue([
        {
          vaultId: "a",
          label: "Mine",
          canWrite: true,
          color: "#4E68DD",
        },
        { vaultId: "b", label: "Family", canWrite: false },
      ]);
      await mount();
      expect(ctl.loading).toBe(false);
      expect(ctl.scopes.map((s) => s.label)).toStrictEqual(["Mine", "Family"]);
      expect(ctl.primary?.id).toBe("a");
      expect(ctl.scopes[1]?.canWrite).toBe(false);
      expect(ctl.defaultScopeId).toBe("a");
      expect(ctl.gatewayLabel).toBe("This Mac");
      expect(ctl.gatewayKind).toBe("local");
      expect(listVaults).not.toHaveBeenCalled();
    });

    it("falls back to the vault list when the gateway mounts no scopes plane", async () => {
      listAppScopes.mockResolvedValue(undefined);
      listVaults.mockResolvedValue([
        { vaultId: "only", name: "Solo", ownerPartyId: "p1" },
      ]);
      await mount();
      expect(ctl.scopes).toHaveLength(1);
      // A gateway without the scopes plane is a single-owner world: the one
      // person there owns what they can see.
      expect(ctl.scopes[0]).toMatchObject({
        id: "only",
        label: "Solo",
        canWrite: true,
      });
    });

    it("falls back to the first scope when nothing names a default pointer", async () => {
      (
        globalThis as unknown as {
          CentraidApi: { getGatewayAuth: () => Promise<unknown> };
        }
      ).CentraidApi.getGatewayAuth = () => Promise.resolve({ baseUrl: "" });
      listAppScopes.mockResolvedValue([
        { vaultId: "first", label: "First", canWrite: true },
      ]);
      await mount();
      expect(ctl.defaultScopeId).toBe("first");
    });

    it("degrades to an empty, non-crashing registry when both sources fail", async () => {
      listAppScopes.mockRejectedValue(new Error("offline"));
      listVaults.mockRejectedValue(new Error("offline"));
      await mount();
      expect(ctl.loading).toBe(false);
      expect(ctl.scopes).toStrictEqual([]);
      expect(ctl.primary).toBeUndefined();
    });
  });
});
