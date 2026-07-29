import { forEachSequentially } from "@centraid/test-kit/sequential";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as TypeImport_1gl5zx7 from "../../../gateway-client.js";
import type { ConnectFlowResult } from "./connectFlow-core.js";
import ConnectFlow from "./ConnectFlow.js";
import type { ConnectFlowProps } from "./ConnectFlow.js";

vi.mock(import("../../../gateway-client.js"), () => ({
  listVaults: () => listVaultsMock(),
}));

const listVaultsMock = vi.fn<typeof TypeImport_1gl5zx7.listVaults>();
const getSettings = vi.fn<(...args: unknown[]) => unknown>();
const setActiveGateway = vi.fn<(...args: unknown[]) => unknown>();
const setActiveVault = vi.fn<(...args: unknown[]) => unknown>();
const createVault = vi.fn<(...args: unknown[]) => unknown>();
const redeemGatewayPairing = vi.fn<(...args: unknown[]) => unknown>();
const addGateway = vi.fn<(...args: unknown[]) => unknown>();
const testGatewayConnection = vi.fn<(...args: unknown[]) => unknown>();
const onDoneMock = () => vi.fn<(result: ConnectFlowResult) => void>();

describe("ConnectFlow scenarios", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listVaultsMock.mockResolvedValue([
      {
        color: "#4E68DD",
        ownerPartyId: "party-1",
        vaultId: "a",
        name: "Personal",
      },
    ]);
    getSettings.mockResolvedValue({ activeGatewayId: "local" });
    setActiveGateway.mockResolvedValue({});
    setActiveVault.mockResolvedValue({});
    createVault.mockResolvedValue({ vaultId: "new1" });
    (globalThis as unknown as { CentraidApi: unknown }).CentraidApi = {
      addGateway,
      createVault,
      getSettings,
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
    props: Partial<ConnectFlowProps> &
      Pick<ConnectFlowProps, "context" | "onDone">
  ): HTMLDivElement {
    container = document.createElement("div");
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container as HTMLDivElement);
      root.render(<ConnectFlow {...props} />);
    });
    return container;
  }

  async function flush(times = 3): Promise<void> {
    await forEachSequentially(Array.from({ length: times }), async () => {
      await act(async () => {
        await Promise.resolve();
      });
    });
  }

  function click(el: Element | null | undefined): void {
    act(() =>
      (el as HTMLButtonElement)?.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      )
    );
  }

  function typeInto(
    el: HTMLInputElement | HTMLTextAreaElement,
    value: string
  ): void {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    act(() => {
      setter?.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  // Every radio in the flow is a native <input type="radio"> wrapped in the
  // styled <label> that carries the visible text (issue #573).
  function radios(el: HTMLElement, name: string): HTMLInputElement[] {
    return [...el.querySelectorAll("label")]
      .filter((l) => l.textContent?.includes(name))
      .map((l) => l.querySelector<HTMLInputElement>('input[type="radio"]'))
      .filter((i): i is HTMLInputElement => i !== null);
  }

  describe(ConnectFlow, () => {
    it("renders both surviving method cards by default — SSH is gone (#603)", () => {
      const el = mount({ context: "onboarding", onDone: onDoneMock() });
      expect(el.querySelectorAll('input[type="radio"]')).toHaveLength(2);
      expect(el.textContent).toContain("This Mac");
      expect(el.textContent).toContain("Existing gateway");
      expect(el.textContent).not.toContain("Over SSH");
    });

    it('a switcher ConnectFlowModal-style caller can omit the "This Mac" card', () => {
      const el = mount({
        context: "switcher",
        methods: ["gateway"],
        onDone: onDoneMock(),
      });
      expect(el.querySelectorAll('input[type="radio"]')).toHaveLength(1);
      expect(el.textContent).not.toContain("This Mac");
    });

    it("initialMethod skips the method grid entirely", () => {
      const el = mount({
        context: "onboarding",
        initialMethod: "gateway",
        methods: ["gateway"],
        onDone: onDoneMock(),
      });
      expect(el.querySelector("textarea")).toBeTruthy();
      expect(el.textContent).not.toContain("Existing gateway");
    });

    // #603: a fresh gateway auto-founds TWO vaults, so onboarding no longer
    // auto-commits a local connect — the pick is always an explicit act.
    it('onboarding + "This Mac" shows the picker rather than auto-committing', async () => {
      const el = mount({ context: "onboarding", onDone: onDoneMock() });
      click(radios(el, "This Mac")[0]);
      await flush(4);
      expect(
        el.querySelector('[role="radiogroup"][aria-label="Space"]')
      ).toBeTruthy();
      expect(setActiveVault).not.toHaveBeenCalled();
    });

    it("a failed local vault read shows the honest error instead of offering a create", async () => {
      listVaultsMock.mockRejectedValue(new Error("gateway is down"));
      const el = mount({ context: "onboarding", onDone: onDoneMock() });
      click(radios(el, "This Mac")[0]);
      await flush(4);
      expect(el.querySelector('[role="alert"]')?.textContent).toContain(
        "gateway is down"
      );
      expect(el.textContent).not.toContain("Create new space");
      const cta = [...el.querySelectorAll("button")].find(
        (b) => b.textContent === "Enter Centraid"
      ) as HTMLButtonElement;
      expect(cta.disabled).toBe(true);
    });

    it('switcher + "This Mac" with one vault still shows the picker (no auto-commit)', async () => {
      const el = mount({ context: "switcher", onDone: onDoneMock() });
      click(radios(el, "This Mac")[0]);
      await flush(3);
      expect(
        el.querySelector('[role="radiogroup"][aria-label="Space"]')
      ).toBeTruthy();
      expect(setActiveVault).not.toHaveBeenCalled();
    });

    it("local: picking a different existing vault and committing calls setActiveVault + onDone", async () => {
      listVaultsMock.mockResolvedValue([
        { ownerPartyId: "party-1", vaultId: "a", name: "Personal" },
        { ownerPartyId: "party-1", vaultId: "b", name: "Work" },
      ]);
      const onDone = onDoneMock();
      const el = mount({ context: "switcher", onDone });
      click(radios(el, "This Mac")[0]);
      await flush(3);
      const workRow = radios(el, "Work")[0];
      click(workRow);
      const connectBtn = [...el.querySelectorAll("button")].find(
        (b) => b.textContent === "Connect"
      );
      click(connectBtn);
      await flush(3);
      expect(setActiveVault).toHaveBeenCalledWith({ vaultId: "b" });
      expect(onDone).toHaveBeenCalledWith({
        displayLabel: "This Mac",
        gatewayId: "local",
        vaultId: "b",
      });
    });

    it("local: creating a new vault calls createVault + setActiveVault", async () => {
      listVaultsMock.mockResolvedValue([
        { ownerPartyId: "party-1", vaultId: "a", name: "Personal" },
        { ownerPartyId: "party-1", vaultId: "b", name: "Work" },
      ]);
      const el = mount({ context: "switcher", onDone: onDoneMock() });
      click(radios(el, "This Mac")[0]);
      await flush(3);
      const createRow = radios(el, "Create new space")[0];
      click(createRow);
      typeInto(
        el.querySelector('input[placeholder="Space name"]') as HTMLInputElement,
        "Play"
      );
      const connectBtn = [...el.querySelectorAll("button")].find(
        (b) => b.textContent === "Connect"
      );
      click(connectBtn);
      await flush(3);
      expect(createVault).toHaveBeenCalledWith({ name: "Play" });
      expect(setActiveVault).toHaveBeenCalledWith({ vaultId: "new1" });
    });

    it("gateway/ticket happy path: test decodes the ticket, vault is locked, commit redeems it", async () => {
      testGatewayConnection.mockResolvedValue({
        ok: true,
        stages: [
          { detail: "", id: "decode", label: "Decode ticket", status: "pass" },
        ],
        ticket: {
          expiresAt: "2030-01-01T00:00:00Z",
          gatewayEndpointId: "ep1",
          vaultName: "Office",
        },
      });
      redeemGatewayPairing.mockResolvedValue({
        gatewayId: "gw1",
        ok: true,
        vaultId: "v1",
        vaultName: "Office",
      });
      const onDone = onDoneMock();
      const el = mount({ context: "onboarding", onDone });
      click(radios(el, "Existing gateway")[0]);
      await flush();
      typeInto(el.querySelector("textarea") as HTMLTextAreaElement, "a-ticket");
      const continueBtn1 = [...el.querySelectorAll("button")].find(
        (b) => b.textContent === "Continue"
      );
      click(continueBtn1);
      await flush(3);
      expect(testGatewayConnection).toHaveBeenCalledWith({
        kind: "ticket",
        ticket: "a-ticket",
      });
      expect(el.textContent).toContain("Decode ticket");

      const continueBtn2 = [...el.querySelectorAll("button")].find(
        (b) => b.textContent === "Continue"
      );
      click(continueBtn2);
      await flush();
      expect(el.textContent).toContain("Office");

      const connectBtn = [...el.querySelectorAll("button")].find(
        (b) => b.textContent === "Enter Centraid"
      );
      click(connectBtn);
      await flush(3);
      expect(redeemGatewayPairing).toHaveBeenCalledWith({
        label: undefined,
        rememberDevice: false,
        ticket: "a-ticket",
      });
      expect(onDone).toHaveBeenCalledWith({
        displayLabel: "Office",
        gatewayId: "gw1",
        vaultId: "v1",
      });
    });

    // Issue #603 D10: a ticket that decodes but names no vault used to land
    // on an empty, actionless list with "Enter Centraid" still enabled.
    it("a ticket that grants no vault explains itself and blocks the CTA", async () => {
      testGatewayConnection.mockResolvedValue({
        ok: true,
        stages: [
          { detail: "", id: "decode", label: "Decode ticket", status: "pass" },
        ],
      });
      const el = mount({ context: "onboarding", onDone: onDoneMock() });
      click(radios(el, "Existing gateway")[0]);
      await flush();
      typeInto(el.querySelector("textarea") as HTMLTextAreaElement, "a-ticket");
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
      expect(el.textContent).toContain("shared no space with this device");
      const cta = [...el.querySelectorAll("button")].find(
        (b) => b.textContent === "Enter Centraid"
      ) as HTMLButtonElement;
      expect(cta.disabled).toBe(true);
    });

    it("gateway test failure shows Retry, which re-runs the test", async () => {
      testGatewayConnection.mockResolvedValueOnce({
        error: "invalid_ticket",
        ok: false,
        stages: [{ id: "decode", label: "Decode ticket", status: "fail" }],
      });
      const el = mount({ context: "onboarding", onDone: onDoneMock() });
      click(radios(el, "Existing gateway")[0]);
      await flush();
      typeInto(
        el.querySelector("textarea") as HTMLTextAreaElement,
        "bad-ticket"
      );
      click(
        [...el.querySelectorAll("button")].find(
          (b) => b.textContent === "Continue"
        )
      );
      await flush(3);
      const retry = [...el.querySelectorAll("button")].find(
        (b) => b.textContent === "Retry"
      );
      expect(retry).toBeTruthy();

      testGatewayConnection.mockResolvedValueOnce({
        ok: true,
        stages: [],
        ticket: { expiresAt: "", gatewayEndpointId: "", vaultName: "Office" },
      });
      click(retry);
      await flush(3);
      expect(testGatewayConnection).toHaveBeenCalledTimes(2);
    });

    it("a failed commit lands on the error step with a Retry that re-attempts", async () => {
      redeemGatewayPairing.mockRejectedValueOnce(new Error("host unreachable"));
      redeemGatewayPairing.mockResolvedValueOnce({
        gatewayId: "gw",
        ok: true,
        vaultId: "a",
        vaultName: "A",
      });
      testGatewayConnection.mockResolvedValue({
        ok: true,
        stages: [],
        ticket: { expiresAt: "", gatewayEndpointId: "", vaultName: "A" },
      });
      const onDone = onDoneMock();
      const el = mount({ context: "switcher", methods: ["gateway"], onDone });
      click(radios(el, "Existing gateway")[0]);
      await flush();
      typeInto(el.querySelector("textarea") as HTMLTextAreaElement, "a-ticket");
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
          (b) => b.textContent === "Connect"
        )
      );
      await flush(3);
      expect(el.querySelector('[role="alert"]')?.textContent).toContain(
        "host unreachable"
      );

      click(
        [...el.querySelectorAll("button")].find(
          (b) => b.textContent === "Retry"
        )
      );
      await flush(3);
      expect(onDone).toHaveBeenCalledWith({
        displayLabel: "A",
        gatewayId: "gw",
        vaultId: "a",
      });
    });

    it('"Start over" fires onCancel when supplied', () => {
      const onCancel = vi.fn<() => void>();
      const el = mount({
        context: "onboarding",
        onCancel,
        onDone: onDoneMock(),
      });
      click(
        [...el.querySelectorAll("button")].find(
          (b) => b.textContent === "Start over"
        )
      );
      expect(onCancel).toHaveBeenCalledOnce();
    });
  });
});
