import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GatewayDeviceTicket } from "../../gateway-client.js";
import DevicePairPanel from "./DevicePairPanel.js";
import type { DevicePairPanelProps } from "./DevicePairPanel.js";

// Pairing another device is always for YOURSELF (#726): access is ownership,
// so there is no person picker and no role ladder — just how long the ticket
// stays good for.

const NOW = Date.UTC(2026, 6, 13, 12, 0, 0);

const TICKET: GatewayDeviceTicket = {
  ticket: "CENTRAID-TICKET-XYZ",
  ownerId: "o-priya",
  ownerLabel: "Priya",
  vaults: [{ vaultId: "v1", vaultName: "Personal" }],
  vaultId: "v1",
  vaultName: "Personal",
  expiresAt: new Date(NOW + 900_000).toISOString(),
};

/** What "Add someone" (#726) mints back: a NEW owner+vault, not the caller's. */
const PERSON_TICKET: GatewayDeviceTicket = {
  ticket: "CENTRAID-TICKET-PERSON",
  ownerId: "o-new",
  ownerLabel: "Priya",
  vaults: [{ vaultId: "v-new", vaultName: "Priya's vault" }],
  vaultId: "v-new",
  vaultName: "Priya's vault",
  expiresAt: new Date(NOW + 900_000).toISOString(),
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
describe("DevicePairPanel suite", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  async function mount(
    onCreateTicket: DevicePairPanelProps["onCreateTicket"],
    opts: { forPerson?: boolean } = {}
  ): Promise<HTMLDivElement> {
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      root.render(
        <DevicePairPanel
          now={NOW}
          onCreateTicket={onCreateTicket}
          onClose={() => undefined}
          {...(opts.forPerson ? { forPerson: true } : {})}
        />
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    return container;
  }

  function typeName(el: HTMLElement, value: string): void {
    const input = el.querySelector<HTMLInputElement>(
      '[data-testid="add-someone-name"]'
    )!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    act(() => {
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function generate(el: HTMLElement): Promise<void> {
    const btn = [...el.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Generate ticket"
    );
    await act(async () => {
      btn!.click();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  describe(DevicePairPanel, () => {
    it("offers no person picker — self-pair is the only shape", async () => {
      const el = await mount(
        vi
          .fn<DevicePairPanelProps["onCreateTicket"]>()
          .mockResolvedValue(TICKET)
      );
      expect(el.querySelector("select")).toBeNull();
      expect(el.querySelector('input[type="text"]')).toBeNull();
      expect(el.textContent).toContain("your current access");
    });

    it("self-pairs by sending only the ticket lifetime", async () => {
      const onCreateTicket = vi
        .fn<DevicePairPanelProps["onCreateTicket"]>()
        .mockResolvedValue(TICKET);
      const el = await mount(onCreateTicket);
      await generate(el);
      expect(onCreateTicket).toHaveBeenCalledWith({ ttlMinutes: 15 });
      expect(el.textContent).toContain("CENTRAID-TICKET-XYZ");
      // The issued ticket states whose it is and what it reaches.
      expect(el.textContent).toContain("Priya");
      expect(el.textContent).toContain("Personal");
    });

    it("picks a different ticket lifetime before generating", async () => {
      const onCreateTicket = vi
        .fn<DevicePairPanelProps["onCreateTicket"]>()
        .mockResolvedValue(TICKET);
      const el = await mount(onCreateTicket);
      const oneHour = [...el.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "1 hour"
      )!;
      act(() => oneHour.click());
      await generate(el);
      expect(onCreateTicket).toHaveBeenCalledWith({ ttlMinutes: 60 });
    });

    it("reads owner_vaults_only back as the ownership sentence it is", async () => {
      const el = await mount(
        vi
          .fn<DevicePairPanelProps["onCreateTicket"]>()
          .mockRejectedValue(
            new Error(
              'mint pairing ticket: {"error":"owner_vaults_only","message":"…"}'
            )
          )
      );
      await generate(el);
      expect(el.textContent).toContain("pairs only for its own owner");
    });

    it("reads no_iroh_endpoint back as an honest, actionable sentence", async () => {
      const el = await mount(
        vi
          .fn<DevicePairPanelProps["onCreateTicket"]>()
          .mockRejectedValue(
            new Error(
              'mint pairing ticket: {"error":"no_iroh_endpoint","message":"…"}'
            )
          )
      );
      await generate(el);
      expect(el.textContent).toContain("has no network identity yet");
    });

    it("reads owner_only back as the host-custody sentence it is", async () => {
      const el = await mount(
        vi
          .fn<DevicePairPanelProps["onCreateTicket"]>()
          .mockRejectedValue(
            new Error(
              'mint pairing ticket: {"error":"owner_only","message":"…"}'
            )
          )
      );
      await generate(el);
      expect(el.textContent).toContain("only its owner can do this");
    });
  });

  describe("Add someone (#726 P1)", () => {
    it("offers a name field, not a role or a person picker", async () => {
      const el = await mount(
        vi
          .fn<DevicePairPanelProps["onCreateTicket"]>()
          .mockResolvedValue(PERSON_TICKET),
        { forPerson: true }
      );
      expect(el.querySelector("select")).toBeNull();
      expect(el.querySelector('[data-testid="add-someone-name"]')).toBeTruthy();
      expect(el.textContent).toContain("a vault of their own");
    });

    it("keeps the mint disabled until a name is entered", async () => {
      const onCreateTicket = vi
        .fn<DevicePairPanelProps["onCreateTicket"]>()
        .mockResolvedValue(PERSON_TICKET);
      const el = await mount(onCreateTicket, { forPerson: true });
      const btn = [...el.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Generate ticket"
      ) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);

      typeName(el, "Priya");
      expect(btn.disabled).toBe(false);
    });

    it("mints for the named person, not the caller", async () => {
      const onCreateTicket = vi
        .fn<DevicePairPanelProps["onCreateTicket"]>()
        .mockResolvedValue(PERSON_TICKET);
      const el = await mount(onCreateTicket, { forPerson: true });
      typeName(el, "Priya");
      await generate(el);

      expect(onCreateTicket).toHaveBeenCalledWith({
        ttlMinutes: 15,
        forPerson: { label: "Priya" },
        // The mint's idempotency key (#750), generated at call initiation.
        operationId: expect.any(String),
      });
      // The minted ticket names the new person, not whoever is hosting.
      expect(el.textContent).toContain("Priya");
    });

    it("a retry after a failed mint reuses the SAME operationId (#750)", async () => {
      const onCreateTicket = vi
        .fn<DevicePairPanelProps["onCreateTicket"]>()
        .mockRejectedValueOnce(new Error("gateway unreachable"))
        .mockResolvedValue(PERSON_TICKET);
      const el = await mount(onCreateTicket, { forPerson: true });
      typeName(el, "Priya");
      await generate(el);
      await generate(el);

      expect(onCreateTicket).toHaveBeenCalledTimes(2);
      const firstId = onCreateTicket.mock.calls[0]![0]!.operationId;
      const retryId = onCreateTicket.mock.calls[1]![0]!.operationId;
      expect(firstId).toBeTruthy();
      // Same intent → same key: the gateway replays instead of re-minting.
      expect(retryId).toBe(firstId);
    });

    it("states the hosting posture on the minted ticket, verbatim", async () => {
      const el = await mount(
        vi
          .fn<DevicePairPanelProps["onCreateTicket"]>()
          .mockResolvedValue(PERSON_TICKET),
        { forPerson: true }
      );
      typeName(el, "Priya");
      await generate(el);

      const posture = el.querySelector(
        '[data-testid="hosting-posture"]'
      )?.textContent;
      expect(posture).toContain(
        "This vault lives on this machine: whoever owns the machine can read what it holds while it is hosted here."
      );
      expect(posture).toContain(
        "While hosted here, this machine also signs for the vault when its owner is away — moving the vault elsewhere ends both."
      );
    });

    it("does not show the hosting posture on a self-pair ticket", async () => {
      const el = await mount(
        vi
          .fn<DevicePairPanelProps["onCreateTicket"]>()
          .mockResolvedValue(TICKET)
      );
      await generate(el);
      expect(el.querySelector('[data-testid="hosting-posture"]')).toBeNull();
    });
  });
});
