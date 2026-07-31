import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import GatewayServiceTip from "./GatewayServiceTip.js";

type Api = NonNullable<typeof window.CentraidApi>;

/**
 * Minimal bridge stub — only the three methods this component touches.
 * Overrides are loose on purpose: `CentraidApi` is the full desktop surface,
 * and pinning stubs to its exact signatures would drag the whole settings DTO
 * into every case for no gain.
 */
function makeApi(over: Record<string, unknown> = {}): Api {
  return {
    getSettings: () => Promise.resolve({}),
    installGatewayService: () => Promise.resolve({ ok: true as const }),
    saveSettings: () => Promise.resolve(),
    ...over,
  } as unknown as Api;
}

describe("GatewayServiceTip — the H5 service offer", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  // Each mount is a fresh instance (`key`), so a second call models a relaunch
  // reading persisted settings rather than a re-render of live state.
  let generation = 0;
  const mount = async (api: Api): Promise<void> => {
    generation += 1;
    await act(async () => {
      root.render(<GatewayServiceTip api={api} key={generation} />);
    });
    // The settings read resolves a microtask after the effect runs.
    await act(async () => {});
  };
  const q = (id: string): HTMLElement | null =>
    host.querySelector(`[data-testid="${id}"]`);
  const click = async (id: string): Promise<void> => {
    await act(async () => (q(id) as HTMLButtonElement).click());
    await act(async () => {});
  };

  it("offers the tip while the setting is unset, and hides it once decided", async () => {
    await mount(makeApi());
    expect(q("gateway-service-tip")).not.toBeNull();
    expect(host.textContent).toContain("Keep your vault reachable");

    // Installed — nothing left to offer, in either shape.
    await mount(
      makeApi({
        getSettings: () => Promise.resolve({ offerGatewayService: true }),
      })
    );
    expect(q("gateway-service-tip")).toBeNull();
    expect(q("gateway-service-standing")).toBeNull();

    // Declined — the pitch is gone for good.
    await mount(
      makeApi({
        getSettings: () => Promise.resolve({ offerGatewayService: false }),
      })
    );
    expect(q("gateway-service-tip")).toBeNull();
  });

  it("renders nothing on a host without the bridge method (web)", async () => {
    await mount(makeApi({ installGatewayService: undefined }));
    expect(host.textContent).toBe("");
  });

  it("installs, records the opt-in, and takes the offer away", async () => {
    const installGatewayService = vi.fn<() => Promise<{ ok: true }>>(() =>
      Promise.resolve({ ok: true as const })
    );
    const saveSettings = vi.fn<() => Promise<void>>(() => Promise.resolve());
    await mount(makeApi({ installGatewayService, saveSettings }));

    await click("gateway-service-tip-accept");
    expect(installGatewayService).toHaveBeenCalledOnce();
    expect(saveSettings).toHaveBeenCalledWith({ offerGatewayService: true });
    expect(q("gateway-service-tip")).toBeNull();
    expect(q("gateway-service-standing")).toBeNull();
  });

  it("keeps the offer and shows the reason when the install fails", async () => {
    const saveSettings = vi.fn<() => Promise<void>>(() => Promise.resolve());
    await mount(
      makeApi({
        installGatewayService: () =>
          Promise.resolve({ ok: false as const, error: "launchctl refused" }),
        saveSettings,
      })
    );

    await click("gateway-service-tip-accept");
    expect(q("gateway-service-tip")).not.toBeNull();
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("launchctl refused");
    // A failed install is not a decision — nothing may be persisted.
    expect(saveSettings).not.toHaveBeenCalled();
    // …and the button is live again for a retry.
    expect(
      (q("gateway-service-tip-accept") as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it("persists a dismissal so the pitch does not come back", async () => {
    const saveSettings = vi.fn<() => Promise<void>>(() => Promise.resolve());
    await mount(makeApi({ saveSettings }));

    await click("gateway-service-tip-dismiss");
    expect(saveSettings).toHaveBeenCalledWith({ offerGatewayService: false });
    expect(q("gateway-service-tip")).toBeNull();
  });

  // The strand this component nearly caused: it is the ONLY caller of
  // `installGatewayService` in the client, so a dismissal that hid it
  // completely retired the whole feature on one click, with no way back.
  it("keeps the service installable after a dismissal — this session and the next", async () => {
    const installGatewayService = vi.fn<() => Promise<{ ok: true }>>(() =>
      Promise.resolve({ ok: true as const })
    );
    const saveSettings = vi.fn<() => Promise<void>>(() => Promise.resolve());
    await mount(makeApi({ installGatewayService, saveSettings }));
    await click("gateway-service-tip-dismiss");

    // Same session: the pitch is gone, the action is not.
    expect(q("gateway-service-tip")).toBeNull();
    expect(q("gateway-service-standing")).not.toBeNull();
    expect(q("gateway-service-install")).not.toBeNull();

    // Next launch: the persisted `false` still yields the standing control,
    // and it still installs.
    await mount(
      makeApi({
        getSettings: () => Promise.resolve({ offerGatewayService: false }),
        installGatewayService,
        saveSettings,
      })
    );
    expect(q("gateway-service-tip")).toBeNull();
    expect(q("gateway-service-install")).not.toBeNull();

    await click("gateway-service-install");
    expect(installGatewayService).toHaveBeenCalledOnce();
    expect(saveSettings).toHaveBeenLastCalledWith({
      offerGatewayService: true,
    });
    expect(q("gateway-service-standing")).toBeNull();
  });

  it("fails open when the settings read rejects", async () => {
    await mount(
      makeApi({
        getSettings: () => Promise.reject(new Error("gateway.db locked")),
      })
    );
    // An unreadable preference must not silently swallow the offer.
    expect(q("gateway-service-tip")).not.toBeNull();
  });
});
