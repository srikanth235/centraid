import { forEachSequentially } from "@centraid/test-kit/sequential";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as TypeImport_bmsl46 from "../../gateway-client.js";
import OnboardingScreen from "./OnboardingScreen.js";
import type {
  OnboardingCompleteInput,
  OnboardingScreenProps,
} from "./OnboardingScreen.js";

vi.mock(import("../../gateway-client.js"), () => ({
  listVaults: () => listVaultsMock(),
}));

const listVaultsMock = vi.fn<typeof TypeImport_bmsl46.listVaults>();
const getSettings = vi.fn<(...args: unknown[]) => unknown>();
const setActiveGateway = vi.fn<(...args: unknown[]) => unknown>();
const setActiveVault = vi.fn<(...args: unknown[]) => unknown>();
const createVault = vi.fn<(...args: unknown[]) => unknown>();
const redeemGatewayPairing = vi.fn<(...args: unknown[]) => unknown>();
const onCompleteMock = () =>
  vi.fn<(input: OnboardingCompleteInput) => Promise<void>>();

describe("OnboardingScreen scenarios", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listVaultsMock.mockResolvedValue([
      { ownerPartyId: "party-1", vaultId: "a", name: "Personal" },
    ]);
    getSettings.mockResolvedValue({ activeGatewayId: "local" });
    setActiveGateway.mockResolvedValue({});
    setActiveVault.mockResolvedValue({});
    createVault.mockResolvedValue({ vaultId: "new1" });
    (globalThis as unknown as { CentraidApi: unknown }).CentraidApi = {
      addGateway: vi.fn<(...args: unknown[]) => unknown>(),
      createVault,
      getSettings,
      redeemGatewayPairing,
      setActiveGateway,
      setActiveVault,
      testGatewayConnection: async () => ({ ok: false }),
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

  function typeName(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(
      globalThis.HTMLInputElement.prototype,
      "value"
    )?.set;
    act(() => {
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function click(el: Element | null | undefined): void {
    act(() =>
      (el as HTMLButtonElement)?.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      )
    );
  }

  // Swatches and method cards are native radios inside a styled <label> that
  // carries the visible text / state attributes (issue #573).
  function radioIn(el: Element | null | undefined): HTMLInputElement | null {
    return el?.querySelector<HTMLInputElement>('input[type="radio"]') ?? null;
  }

  async function flush(times = 3): Promise<void> {
    await forEachSequentially(Array.from({ length: times }), async () => {
      await act(async () => {
        await Promise.resolve();
      });
    });
  }

  describe(OnboardingScreen, () => {
    it("renders the identity step with 8 swatches and a disabled CTA until a name is entered", () => {
      const el = mount({ onComplete: onCompleteMock() });
      expect(el.textContent).toContain("Make yourself");
      expect(el.querySelectorAll(".swatch")).toHaveLength(8);
      const cta = el.querySelector(".cta") as HTMLButtonElement;
      expect(cta.disabled).toBe(true);
      typeName(el.querySelector(".input") as HTMLInputElement, "Ada Lovelace");
      expect((el.querySelector(".cta") as HTMLButtonElement).disabled).toBe(
        false
      );
      expect(el.querySelector(".initials")?.textContent).toBe("AL");
    });

    it("selects a swatch on click", () => {
      const el = mount({ onComplete: onCompleteMock() });
      const swatch = el.querySelectorAll(".swatch")[3] as HTMLLabelElement;
      click(radioIn(swatch));
      expect(swatch.dataset.selected).toBe("true");
      expect(el.querySelectorAll('[data-selected="true"]')).toHaveLength(1);
    });

    it("the ticket path goes from identity straight into the ticket paste", () => {
      const el = mount({ onComplete: onCompleteMock() });
      typeName(el.querySelector(".input") as HTMLInputElement, "Ada");
      click(el.querySelector(".cta"));
      expect(el.textContent).toContain("Connect your");
      // No method grid at all — the host already chose (issue #603).
      expect(el.querySelectorAll('input[type="radio"]')).toHaveLength(0);
      expect(el.querySelector("textarea")).toBeTruthy();
      expect(el.querySelector(".cta")).toBeNull();
    });

    it("the fresh path skips connect entirely and completes on the local Personal vault", async () => {
      listVaultsMock.mockResolvedValue([
        { ownerPartyId: "party-1", vaultId: "shared", name: "Shared" },
        { ownerPartyId: "party-1", vaultId: "personal", name: "Personal" },
      ]);
      const onComplete = onCompleteMock().mockResolvedValue(undefined);
      const el = mount({ path: "fresh", onComplete });
      typeName(el.querySelector(".input") as HTMLInputElement, "Grace");
      click(el.querySelector(".cta"));
      await flush(4);
      expect(setActiveVault).toHaveBeenCalledWith({ vaultId: "personal" });
      expect(onComplete).toHaveBeenCalledWith({
        avatarColor: expect.any(String),
        displayName: "Grace",
        gatewayId: "local",
        path: "fresh",
        vaultId: "personal",
      });
    });

    it("the fresh path surfaces an unreachable local gateway inline", async () => {
      listVaultsMock.mockRejectedValue(new Error("ECONNREFUSED"));
      const el = mount({ path: "fresh", onComplete: onCompleteMock() });
      typeName(el.querySelector(".input") as HTMLInputElement, "Grace");
      click(el.querySelector(".cta"));
      await flush(4);
      expect(el.querySelector(".error")?.textContent).toContain("ECONNREFUSED");
    });

    it("renders a Back affordance only when the host supplies one", () => {
      const withBack = mount({
        onBack: vi.fn<(...args: unknown[]) => unknown>(),
        onComplete: onCompleteMock(),
      });
      expect(
        [...withBack.querySelectorAll("button")].some(
          (b) => b.textContent === "Back"
        )
      ).toBe(true);
    });

    it('"Start over" from the connect step returns to the identity step', () => {
      const el = mount({ onComplete: onCompleteMock() });
      typeName(el.querySelector(".input") as HTMLInputElement, "Ada");
      click(el.querySelector(".cta"));
      click(
        [...el.querySelectorAll("button")].find(
          (b) => b.textContent === "Start over"
        )
      );
      expect(el.textContent).toContain("Make yourself");
      expect(el.querySelector(".cta")).toBeTruthy();
    });

    it("trims the name and carries the chosen swatch through", async () => {
      listVaultsMock.mockResolvedValue([
        { ownerPartyId: "party-1", vaultId: "personal", name: "Personal" },
      ]);
      const onComplete = onCompleteMock().mockResolvedValue(undefined);
      const el = mount({ path: "fresh", onComplete });
      typeName(el.querySelector(".input") as HTMLInputElement, "  Grace  ");
      click(radioIn(el.querySelectorAll(".swatch")[2] as HTMLLabelElement));
      click(el.querySelector(".cta"));
      await flush(4);
      expect(onComplete).toHaveBeenCalledWith({
        avatarColor: "#E36AD2",
        displayName: "Grace",
        gatewayId: "local",
        path: "fresh",
        vaultId: "personal",
      });
    });

    it('completing the "Existing gateway" ticket flow finishes onboarding with the connected gatewayId', async () => {
      const api = (
        globalThis as unknown as {
          CentraidApi: { testGatewayConnection: () => Promise<unknown> };
        }
      ).CentraidApi;
      vi.spyOn(api, "testGatewayConnection").mockResolvedValue({
        ok: true,
        stages: [],
        ticket: { expiresAt: "", gatewayEndpointId: "", vaultName: "Office" },
      });
      redeemGatewayPairing.mockResolvedValue({
        gatewayId: "gw1",
        ok: true,
        vaultId: "v1",
        vaultName: "Office",
      });
      const onComplete = onCompleteMock().mockResolvedValue(undefined);
      const el = mount({ onComplete });
      typeName(el.querySelector(".input") as HTMLInputElement, "Ada");
      click(el.querySelector(".cta"));

      await flush();
      const textarea = el.querySelector("textarea") as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(
        globalThis.HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      act(() => {
        setter?.call(textarea, "a-ticket");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      click(
        [...el.querySelectorAll("button")].find(
          (b) => b.textContent === "Continue"
        )
      );
      await flush(3);
      click(
        [...el.querySelectorAll("button")].find(
          (b) => b.textContent === "Continue"
        )
      );
      await flush();
      click(
        [...el.querySelectorAll("button")].find(
          (b) => b.textContent === "Enter Centraid"
        )
      );
      await flush(3);
      expect(redeemGatewayPairing).toHaveBeenCalledWith({
        label: undefined,
        rememberDevice: false,
        ticket: "a-ticket",
      });
      expect(onComplete).toHaveBeenCalledWith({
        avatarColor: expect.any(String),
        displayName: "Ada",
        gatewayId: "gw1",
        path: "ticket",
        vaultId: "v1",
      });
    });

    it("surfaces an error inline when onComplete rejects", async () => {
      listVaultsMock.mockResolvedValue([
        { ownerPartyId: "party-1", vaultId: "personal", name: "Personal" },
      ]);
      const onComplete = onCompleteMock().mockRejectedValue(new Error("nope"));
      const el = mount({ path: "fresh", onComplete });
      typeName(el.querySelector(".input") as HTMLInputElement, "X");
      click(el.querySelector(".cta"));
      await flush(4);
      expect(el.querySelector(".error")?.textContent).toContain("nope");
    });
  });
});
