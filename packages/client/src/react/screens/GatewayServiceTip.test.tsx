import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import GatewayServiceTip from "./GatewayServiceTip.js";

type Api = NonNullable<typeof window.CentraidApi>;

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

  let generation = 0;
  const mount = async (api: Api): Promise<void> => {
    generation += 1;
    await act(async () => {
      root.render(<GatewayServiceTip api={api} key={generation} />);
    });
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

    await mount(
      makeApi({
        getSettings: () => Promise.resolve({ offerGatewayService: true }),
      })
    );
    expect(q("gateway-service-tip")).toBeNull();
    expect(q("gateway-service-standing")).toBeNull();

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
    expect(saveSettings).not.toHaveBeenCalled();
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

  it("keeps the service installable after a dismissal — this session and the next", async () => {
    const installGatewayService = vi.fn<() => Promise<{ ok: true }>>(() =>
      Promise.resolve({ ok: true as const })
    );
    const saveSettings = vi.fn<() => Promise<void>>(() => Promise.resolve());
    await mount(makeApi({ installGatewayService, saveSettings }));
    await click("gateway-service-tip-dismiss");

    expect(q("gateway-service-tip")).toBeNull();
    expect(q("gateway-service-standing")).not.toBeNull();
    expect(q("gateway-service-install")).not.toBeNull();

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
    expect(q("gateway-service-tip")).not.toBeNull();
  });
});
