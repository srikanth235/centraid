import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";

import type * as TypeImport_gateway from "../../gateway-client.js";
import OnboardingScreen from "./OnboardingScreen.js";
import type {
  OnboardingCompleteInput,
  OnboardingScreenProps,
} from "./OnboardingScreen.js";

vi.mock(import("../../gateway-client.js"), () => ({
  listVaults: () => listVaultsMock(),
}));

const listVaultsMock = vi.fn<typeof TypeImport_gateway.listVaults>();
const setActiveGateway = vi.fn<(...args: unknown[]) => unknown>();
const setActiveVault = vi.fn<(...args: unknown[]) => unknown>();
const redeemGatewayPairing = vi.fn<(...args: unknown[]) => unknown>();
const testGatewayConnection = vi.fn<(...args: unknown[]) => unknown>();
const onCompleteMock = () =>
  vi.fn<(input: OnboardingCompleteInput) => Promise<void>>();

describe("OnboardingScreen scenarios", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listVaultsMock.mockResolvedValue([
      { ownerPartyId: "party-1", vaultId: "personal", name: "Personal" },
    ]);
    setActiveGateway.mockResolvedValue(undefined);
    setActiveVault.mockResolvedValue(undefined);
    redeemGatewayPairing.mockResolvedValue({
      gatewayId: "gw1",
      ok: true,
      vaultId: "v1",
      vaultName: "Office",
    });
    testGatewayConnection.mockResolvedValue({
      ok: true,
      stages: [],
      ticket: { expiresAt: "", gatewayEndpointId: "", vaultName: "Office" },
    });
    (globalThis as unknown as { CentraidApi: unknown }).CentraidApi = {
      redeemGatewayPairing,
      setActiveGateway,
      setActiveVault,
      testGatewayConnection,
    };
  });

  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  function mount(
    props: Partial<OnboardingScreenProps> &
      Pick<OnboardingScreenProps, "onComplete">
  ): HTMLDivElement {
    const full: OnboardingScreenProps = { path: "ticket", ...props };
    container = document.createElement("div");
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container as HTMLDivElement);
      root.render(<OnboardingScreen {...full} />);
    });
    return container;
  }

  function clickText(el: Element, text: string): void {
    const button = [...el.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === text
    );
    act(() =>
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
  }

  async function flush(times = 3): Promise<void> {
    await forEachSequentially(Array.from({ length: times }), async () => {
      await act(async () => {
        await Promise.resolve();
      });
    });
  }

  it("opens on pairing without a profile question", () => {
    const el = mount({ onComplete: onCompleteMock() });
    expect(el.textContent).toContain("Connect your");
    expect(el.textContent).not.toContain("Make yourself");
    expect(el.textContent).not.toContain("Your name");
    expect(el.querySelector("textarea")).toBeTruthy();
  });

  it("fresh desktop setup enters the app after connecting", async () => {
    const onComplete = onCompleteMock().mockResolvedValue(undefined);
    const el = mount({ path: "fresh", onComplete });
    await flush(5);
    expect(setActiveVault).toHaveBeenCalledWith({ vaultId: "personal" });
    expect(onComplete).toHaveBeenCalledWith({ path: "fresh" });
    expect(el.textContent).not.toContain("Make yourself");
    expect(el.querySelector(".input")).toBeNull();
  });

  it("existing-host pairing still completes through the ticket flow", async () => {
    const onComplete = onCompleteMock().mockResolvedValue(undefined);
    const el = mount({ onComplete });
    const textarea = el.querySelector("textarea") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(
      globalThis.HTMLTextAreaElement.prototype,
      "value"
    )?.set;
    act(() => {
      setter?.call(textarea, "a-ticket");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    clickText(el, "Continue");
    await flush(4);
    clickText(el, "Continue");
    await flush(4);
    clickText(el, "Enter Centraid");
    await flush(4);

    expect(redeemGatewayPairing).toHaveBeenCalledWith({
      label: undefined,
      rememberDevice: true,
      ticket: "a-ticket",
    });
    expect(onComplete).toHaveBeenCalledWith({ path: "ticket" });
  });

  it("keeps a failed fresh connection on its own recovery step", async () => {
    listVaultsMock.mockRejectedValue(new Error("gateway.db is locked"));
    const el = mount({ path: "fresh", onComplete: onCompleteMock() });
    await flush(4);
    expect(
      el.querySelector('[data-testid="onboarding-connecting"]')
    ).not.toBeNull();
    expect(
      el.querySelector('[data-testid="onboarding-connect-retry"]')
    ).not.toBeNull();
    expect(el.querySelector(".connectPanel")).toBeNull();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      "Centraid couldn't start on this Mac"
    );
  });

  it("uses the fallback vault without renaming it", async () => {
    listVaultsMock.mockResolvedValue([
      { ownerPartyId: "party-1", vaultId: "shared", name: "Shared" },
      { ownerPartyId: "party-1", vaultId: "ada", name: "Ada" },
    ]);
    const onComplete = onCompleteMock().mockResolvedValue(undefined);
    const el = mount({ path: "fresh", onComplete });
    await flush(5);
    expect(setActiveVault).toHaveBeenCalledWith({ vaultId: "shared" });
    expect(onComplete).toHaveBeenCalledWith({ path: "fresh" });
    expect(el.textContent).not.toContain("Make yourself");
  });

  it("shows a retryable error when entering the app fails", async () => {
    const onComplete = onCompleteMock().mockRejectedValue(new Error("nope"));
    const el = mount({ path: "fresh", onComplete });
    await flush(5);
    expect(el.querySelector(".error")?.textContent).toContain("nope");
    expect(
      el.querySelector('[data-testid="onboarding-connect-retry"]')
    ).not.toBeNull();
  });
});
