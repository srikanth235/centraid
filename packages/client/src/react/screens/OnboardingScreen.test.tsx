import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IDENTITY_COLORS } from "@centraid/design";
import { forEachSequentially } from "@centraid/test-kit/sequential";

import type * as TypeImport_bmsl46 from "../../gateway-client.js";
import OnboardingScreen from "./OnboardingScreen.js";
import type {
  OnboardingCompleteInput,
  OnboardingScreenProps,
} from "./OnboardingScreen.js";

vi.mock(import("../../gateway-client.js"), () => ({
  listVaults: () => listVaultsMock(),
  listGatewayDevices: () => listGatewayDevicesMock(),
  renameGatewayMember: (memberId: string, label: string) =>
    renameGatewayMemberMock(memberId, label),
  vaultImportStage: (
    input: Parameters<typeof TypeImport_bmsl46.vaultImportStage>[0]
  ) => vaultImportStageMock(input),
}));

const listVaultsMock = vi.fn<typeof TypeImport_bmsl46.listVaults>();
const listGatewayDevicesMock =
  vi.fn<typeof TypeImport_bmsl46.listGatewayDevices>();
const renameGatewayMemberMock =
  vi.fn<typeof TypeImport_bmsl46.renameGatewayMember>();
const vaultImportStageMock = vi.fn<typeof TypeImport_bmsl46.vaultImportStage>();
const getSettings = vi.fn<(...args: unknown[]) => unknown>();
const setActiveGateway = vi.fn<(...args: unknown[]) => unknown>();
const setActiveVault = vi.fn<(...args: unknown[]) => unknown>();
const createVault = vi.fn<(...args: unknown[]) => unknown>();
const redeemGatewayPairing = vi.fn<(...args: unknown[]) => unknown>();
const onCompleteMock = () =>
  vi.fn<(input: OnboardingCompleteInput) => Promise<void>>();

/** A roster row for the device making the request, acting as `memberLabel`. */
function selfDevice(memberLabel: string): unknown {
  return {
    deviceId: "enr_1",
    endpointId: "ep_1",
    memberId: "mem_1",
    memberLabel,
    label: "Web browser",
    transport: "iroh",
    vaultId: "personal",
    role: "admin",
    rememberDevice: false,
    current: true,
  };
}

describe("OnboardingScreen scenarios", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listVaultsMock.mockResolvedValue([
      { ownerPartyId: "party-1", vaultId: "a", name: "Personal" },
    ]);
    // Default: an auto-founded gateway whose owner is still the placeholder,
    // so onboarding has a reason to ask for a name.
    listGatewayDevicesMock.mockResolvedValue([selfDevice("You")] as never);
    getSettings.mockResolvedValue({ activeGatewayId: "local" });
    setActiveGateway.mockResolvedValue({});
    setActiveVault.mockResolvedValue({});
    createVault.mockResolvedValue({ vaultId: "new1" });
    (globalThis as unknown as { CentraidApi: unknown }).CentraidApi = {
      addGateway: vi.fn<(...args: unknown[]) => unknown>(),
      createVault,
      getSettings,
      getGatewayAuth: async () => ({ baseUrl: "", gatewayId: "local" }),
      listGateways: async () => [
        { id: "local", avatarColor: "#5B8DEF", label: "Local" },
      ],
      redeemGatewayPairing,
      setActiveGateway,
      setActiveVault,
      testGatewayConnection: async () => ({ ok: false }),
      updateProfileMetadata: vi.fn<(...args: unknown[]) => unknown>(),
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

  /** Drive a file onto the import picker — jsdom's `files` is otherwise read-only. */
  function pickFile(el: HTMLDivElement, file: File): void {
    const input = el.querySelector("#cd-onb-import") as HTMLInputElement;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    });
    act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
  }

  /** Fresh path → identity → tick "I have data to import" → Continue. */
  async function reachImportStep(): Promise<HTMLDivElement> {
    const el = mount({ path: "fresh", onComplete: onCompleteMock() });
    await flush(4);
    typeName(el.querySelector(".input") as HTMLInputElement, "Ada");
    click(el.querySelector('.importChoice input[type="checkbox"]'));
    click(el.querySelector(".cta"));
    await flush(3);
    return el;
  }

  async function flush(times = 3): Promise<void> {
    await forEachSequentially(Array.from({ length: times }), async () => {
      await act(async () => {
        await Promise.resolve();
      });
    });
  }

  describe(OnboardingScreen, () => {
    it("opens on the pairing step, never on a name question", () => {
      const el = mount({ onComplete: onCompleteMock() });
      expect(el.textContent).toContain("Connect your");
      expect(el.textContent).not.toContain("Make yourself");
      // No method grid at all — the host already chose (issue #603).
      expect(el.querySelectorAll('input[type="radio"]')).toHaveLength(0);
      expect(el.querySelector("textarea")).toBeTruthy();
    });

    it("asks for a name once connected, while the roster still says 'You'", async () => {
      const el = mount({ path: "fresh", onComplete: onCompleteMock() });
      await flush(4);
      expect(el.textContent).toContain("Make yourself");
      // One swatch per identity fill — ink first, then the hue wheel.
      expect(el.querySelectorAll(".swatch")).toHaveLength(
        IDENTITY_COLORS.length
      );
      const cta = el.querySelector(".cta") as HTMLButtonElement;
      expect(cta.disabled).toBe(true);
      typeName(el.querySelector(".input") as HTMLInputElement, "Ada Lovelace");
      expect((el.querySelector(".cta") as HTMLButtonElement).disabled).toBe(
        false
      );
      expect(el.querySelector(".initials")?.textContent).toBe("AL");
    });

    // The whole point of moving pairing first: a device joining a household
    // that already knows this person must not re-ask for their name.
    it("skips the name step when the household already knows this person", async () => {
      listGatewayDevicesMock.mockResolvedValue([selfDevice("Grace")] as never);
      const onComplete = onCompleteMock().mockResolvedValue(undefined);
      const el = mount({ path: "fresh", onComplete });
      await flush(5);
      expect(el.textContent).not.toContain("Make yourself");
      expect(onComplete).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: "", path: "fresh" })
      );
      // No memberId: nothing was asked, so nothing should be renamed.
      expect(onComplete.mock.calls[0]?.[0].memberId).toBeUndefined();
    });

    // A gateway with no device plane answers 404, so the roster reads as
    // empty. Skipping the question there would finish first run nameless —
    // and the host would then try to rename the Personal vault to "".
    it("still asks when the roster cannot be read at all", async () => {
      listGatewayDevicesMock.mockResolvedValue([] as never);
      const onComplete = onCompleteMock().mockResolvedValue(undefined);
      const el = mount({ path: "fresh", onComplete });
      await flush(5);
      expect(el.textContent).toContain("Make yourself");
      expect(onComplete).not.toHaveBeenCalled();
      typeName(el.querySelector(".input") as HTMLInputElement, "Ada");
      click(el.querySelector(".cta"));
      await flush(4);
      expect(onComplete).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: "Ada" })
      );
      // Nobody to rename — the roster is the thing we could not read.
      expect(onComplete.mock.calls[0]?.[0].memberId).toBeUndefined();
    });

    it("selects a swatch on click", async () => {
      const el = mount({ path: "fresh", onComplete: onCompleteMock() });
      await flush(4);
      const swatch = el.querySelectorAll(".swatch")[3] as HTMLLabelElement;
      click(radioIn(swatch));
      expect(swatch.dataset.selected).toBe("true");
      expect(el.querySelectorAll('.swatch[data-selected="true"]')).toHaveLength(
        1
      );
    });

    it("the fresh path completes on the local Personal vault", async () => {
      listVaultsMock.mockResolvedValue([
        { ownerPartyId: "party-1", vaultId: "shared", name: "Shared" },
        { ownerPartyId: "party-1", vaultId: "personal", name: "Personal" },
      ]);
      const onComplete = onCompleteMock().mockResolvedValue(undefined);
      const el = mount({ path: "fresh", onComplete });
      await flush(4);
      typeName(el.querySelector(".input") as HTMLInputElement, "Grace");
      click(el.querySelector(".cta"));
      await flush(4);
      expect(setActiveVault).toHaveBeenCalledWith({ vaultId: "personal" });
      expect(onComplete).toHaveBeenCalledWith({
        avatarColor: expect.any(String),
        displayName: "Grace",
        gatewayId: "local",
        memberId: "mem_1",
        ownerVault: true,
        path: "fresh",
        vaultId: "personal",
      });
    });

    it("the fresh path surfaces an unreachable local gateway inline", async () => {
      listVaultsMock.mockRejectedValue(new Error("ECONNREFUSED"));
      const el = mount({ path: "fresh", onComplete: onCompleteMock() });
      await flush(4);
      expect(el.querySelector(".error")?.textContent).toContain("ECONNREFUSED");
    });

    it("renders a Back affordance only when the host supplies one", async () => {
      const withBack = mount({
        path: "fresh",
        onBack: vi.fn<(...args: unknown[]) => unknown>(),
        onComplete: onCompleteMock(),
      });
      await flush(4);
      expect(
        [...withBack.querySelectorAll("button")].some(
          (b) => b.textContent === "Back"
        )
      ).toBe(true);
    });

    it("trims the name and carries the chosen swatch through", async () => {
      listVaultsMock.mockResolvedValue([
        { ownerPartyId: "party-1", vaultId: "personal", name: "Personal" },
      ]);
      const onComplete = onCompleteMock().mockResolvedValue(undefined);
      const el = mount({ path: "fresh", onComplete });
      await flush(4);
      typeName(el.querySelector(".input") as HTMLInputElement, "  Grace  ");
      click(radioIn(el.querySelectorAll(".swatch")[2] as HTMLLabelElement));
      click(el.querySelector(".cta"));
      await flush(4);
      expect(onComplete).toHaveBeenCalledWith({
        avatarColor: IDENTITY_COLORS[2],
        displayName: "Grace",
        gatewayId: "local",
        memberId: "mem_1",
        ownerVault: true,
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
      await flush(4);
      expect(redeemGatewayPairing).toHaveBeenCalledWith({
        label: undefined,
        // ON by default now — pairing no longer asks (Settings owns it).
        rememberDevice: true,
        ticket: "a-ticket",
      });
      // Paired, and only now asked who this is.
      typeName(el.querySelector(".input") as HTMLInputElement, "Ada");
      click(el.querySelector(".cta"));
      await flush(4);
      expect(onComplete).toHaveBeenCalledWith({
        avatarColor: expect.any(String),
        displayName: "Ada",
        gatewayId: "gw1",
        memberId: "mem_1",
        path: "ticket",
        vaultId: "v1",
      });
    });

    // Issue #603 C10: reinstalling over existing data has no "Personal" vault
    // (it was renamed on the first first-run), and the fallback is the OLDEST
    // vault — "Shared". The host must not rename that, so the flag is false.
    it("the fresh path does not flag the fallback vault as renamable", async () => {
      listVaultsMock.mockResolvedValue([
        { ownerPartyId: "party-1", vaultId: "shared", name: "Shared" },
        { ownerPartyId: "party-1", vaultId: "grace", name: "Grace" },
      ]);
      const onComplete = onCompleteMock().mockResolvedValue(undefined);
      const el = mount({ path: "fresh", onComplete });
      await flush(4);
      typeName(el.querySelector(".input") as HTMLInputElement, "Grace");
      click(el.querySelector(".cta"));
      await flush(4);
      expect(setActiveVault).toHaveBeenCalledWith({ vaultId: "shared" });
      expect(onComplete).toHaveBeenCalledWith({
        avatarColor: expect.any(String),
        displayName: "Grace",
        gatewayId: "local",
        memberId: "mem_1",
        ownerVault: false,
        path: "fresh",
        vaultId: "shared",
      });
    });

    // The H5 service offer is no longer a blocking onboarding step: it moved to
    // GatewayServiceTip. A fresh run must reach identity WITHOUT being asked,
    // even on a build that exposes `installGatewayService`.
    it("does not ask about the OS service on the fresh path", async () => {
      listVaultsMock.mockResolvedValue([
        { ownerPartyId: "party-1", vaultId: "personal", name: "Personal" },
      ]);
      const api = (
        globalThis as unknown as { CentraidApi: Record<string, unknown> }
      ).CentraidApi;
      Object.assign(api, {
        installGatewayService: () => Promise.resolve({ ok: true }),
      });
      const el = mount({ path: "fresh", onComplete: onCompleteMock() });
      await flush(4);
      expect(
        el.querySelector('[data-testid="onboarding-service-accept"]')
      ).toBeNull();
      expect(
        el.querySelector('[data-testid="onboarding-service-decline"]')
      ).toBeNull();
      // Landed on identity, not on a question about background daemons.
      expect(el.querySelector(".input")).not.toBeNull();
    });

    // The fresh path must never fall through to ConnectFlow: a failed local
    // dial used to unmask the `connect` step, so "Start fresh on this Mac"
    // answered with a paste/scan-a-pair-ticket screen.
    it("keeps a failed fresh dial on its own step with a retry", async () => {
      // The dial fails at vault enumeration — the same shape as a local gateway
      // that could not start.
      listVaultsMock.mockRejectedValue(new Error("gateway.db is locked"));
      const el = mount({ path: "fresh", onComplete: onCompleteMock() });
      await flush(4);
      expect(
        el.querySelector('[data-testid="onboarding-connecting"]')
      ).not.toBeNull();
      expect(el.querySelector(".error")).not.toBeNull();
      expect(
        el.querySelector('[data-testid="onboarding-connect-retry"]')
      ).not.toBeNull();
      // The join-a-gateway UI must not be on screen.
      expect(el.querySelector(".connectPanel")).toBeNull();
    });

    // UX-1: a fresh dial that fails used to put the raw exception on screen as
    // the whole message. The owner reads a sentence; the exception is still
    // there, one disclosure away, for whoever files the bug.
    it("leads a failed fresh dial with a sentence and folds the exception away", async () => {
      listVaultsMock.mockRejectedValue(new Error("gateway.db is locked"));
      const el = mount({ path: "fresh", onComplete: onCompleteMock() });
      await flush(4);
      const alert = el.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain(
        "Centraid couldn't start on this Mac"
      );
      expect(alert?.textContent).not.toContain("gateway.db is locked");
      const details = el.querySelector("details") as HTMLDetailsElement | null;
      expect(details?.open).toBe(false);
      expect(details?.textContent).toContain("Technical detail");
      expect(details?.textContent).toContain("gateway.db is locked");
      // UX-8: one word for this moment, on the title as well as the failure.
      expect(el.textContent).toContain("Centraid");
      expect(el.textContent).not.toContain("your vault");
      expect(el.textContent).not.toContain("your gateway");
    });

    // UX-4: Continue disables the moment the field is empty, and nothing said
    // why. The cue is a hint, never a red error on a field nobody has touched.
    it("says why Continue is unavailable while the name is empty", async () => {
      const el = mount({ path: "fresh", onComplete: onCompleteMock() });
      await flush(4);
      expect(
        el.querySelector('[data-testid="onboarding-name-hint"]')?.textContent
      ).toContain("Add a name to continue");
      expect(el.querySelector(".error")).toBeNull();
      typeName(el.querySelector(".input") as HTMLInputElement, "Ada");
      expect(
        el.querySelector('[data-testid="onboarding-name-hint"]')
      ).toBeNull();
    });

    // UX-5: the binary branch reads the whole file into a per-byte JS array, so
    // a multi-GB Takeout took the renderer with it. Refuse before reading, and
    // name the actual limit.
    it("refuses an export too big to read into memory, before reading it", async () => {
      const el = await reachImportStep();
      const file = new File(["x"], "takeout.zip", { type: "application/zip" });
      Object.defineProperty(file, "size", { value: 3 * 1024 * 1024 * 1024 });
      pickFile(el, file);
      await flush(3);
      expect(vaultImportStageMock).not.toHaveBeenCalled();
      const alert = el.querySelector('[role="alert"]')?.textContent ?? "";
      expect(alert).toContain("3.0 GB");
      expect(alert).toContain("64 MB");
      expect(alert).toContain("Export a smaller date range");
      // A refusal is not a technical failure — there is no exception to fold.
      expect(el.querySelector("details")).toBeNull();
    });

    it("stages an export that fits", async () => {
      vaultImportStageMock.mockResolvedValue({
        batchId: "b1",
        kind: "ics",
        staged: { schedule_event: 12 },
        total: 12,
        unrouted: [],
      });
      const el = await reachImportStep();
      pickFile(el, new File(["BEGIN:VCALENDAR"], "cal.ics"));
      await flush(4);
      expect(vaultImportStageMock).toHaveBeenCalledOnce();
      expect(el.textContent).toContain("12 rows staged");
      expect(el.querySelector(".error")).toBeNull();
    });

    // UX-6: import used to be a one-way door — only staging or "Skip for now".
    it("lets the import step go back to name and color with state intact", async () => {
      const el = await reachImportStep();
      expect(el.querySelector(".input")).toBeNull();
      click(el.querySelector('[data-testid="onboarding-import-back"]'));
      await flush();
      const input = el.querySelector(".input") as HTMLInputElement;
      expect(input.value).toBe("Ada");
      // And the choice itself is now un-makeable: unticking it and continuing
      // finishes onboarding instead of returning to import.
      click(el.querySelector('.importChoice input[type="checkbox"]'));
      click(el.querySelector(".cta"));
      await flush(4);
      expect(
        el.querySelector('[data-testid="onboarding-import-back"]')
      ).toBeNull();
    });

    it("surfaces an error inline when onComplete rejects", async () => {
      listVaultsMock.mockResolvedValue([
        { ownerPartyId: "party-1", vaultId: "personal", name: "Personal" },
      ]);
      const onComplete = onCompleteMock().mockRejectedValue(new Error("nope"));
      const el = mount({ path: "fresh", onComplete });
      await flush(4);
      typeName(el.querySelector(".input") as HTMLInputElement, "X");
      click(el.querySelector(".cta"));
      await flush(4);
      expect(el.querySelector(".error")?.textContent).toContain("nope");
    });
  });
});
