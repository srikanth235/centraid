/* oxlint-disable import/first -- vi.hoisted must precede the subject import it primes */
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { encodeCommonsInvite } from "@centraid/blueprints/apps/_shared/commons-invite";

// The renderer guarantees the preload bridge before any script runs, and the
// gateway client registers its gateway-change listener at module load. This
// screen reaches that client through the sharing card, so the bridge has to
// exist before the import graph is evaluated, not in a beforeEach.
vi.hoisted(() => {
  (window as unknown as { CentraidApi: unknown }).CentraidApi = {
    getGatewayAuth: async () => ({
      baseUrl: "https://gateway.test",
      token: "tok",
      vaultId: "v1",
    }),
    onGatewayChanged: () => () => undefined,
    onVaultChanged: () => () => undefined,
  };
});

import type { CentraidGatewayDevice } from "../../gateway-client.js";
import type { OwnerScope } from "../shell/ownerScope.js";
import { readVitals, resetVitals } from "../shell/routeVitals.js";
import { readRouteHealth } from "../shell/statusChannel.js";
import HouseholdScreen from "./HouseholdScreen.js";
import type { HouseholdScreenProps } from "./HouseholdScreen.js";
import type { SharingCardProps } from "./SharingCard.js";

// Devices (#599, #726) in its v9 shape (#765). The page has no header of its
// own: its title, count line, verbs and health sentence are the frame's, and
// they are published from here — so the assertions below read the published
// signals rather than looking for a heading the page no longer draws.
//
// Ownership (#726) means every listed vault is owned outright — there is no
// role tier left to badge.

const NOW = Date.UTC(2026, 6, 13, 12, 0, 0);

let root: Root | null = null;
let container: HTMLDivElement | null = null;

describe("HouseholdScreen suite", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    resetVitals();
    vi.clearAllMocks();
  });

  function scope(over: Partial<OwnerScope> = {}): OwnerScope {
    return {
      id: "v1",
      label: "Personal",
      canWrite: true,
      ...over,
    };
  }

  function device(
    over: Partial<CentraidGatewayDevice> = {}
  ): CentraidGatewayDevice {
    return {
      deviceId: "enr_1",
      endpointId: "http:abc",
      ownerId: "o_priya",
      ownerLabel: "Priya",
      label: "Priya’s browser",
      platform: "web",
      transport: "iroh",
      vaultId: "v1",
      vaultName: "Personal",
      addedAt: new Date(NOW - 86_400_000).toISOString(),
      lastUsedAt: new Date(NOW - 3_600_000).toISOString(),
      revoked: false,
      rememberDevice: true,
      ...over,
    };
  }

  /** A roster with two devices — the everyday, populated state. */
  function roster(): Partial<HouseholdScreenProps> {
    return {
      loadDevices: async () => [
        device({ current: true, label: "This laptop" }),
        device({
          deviceId: "enr_2",
          endpointId: "http:def",
          label: "Priya’s phone",
        }),
      ],
      onRevokeDevice: async () => ({ removed: true }),
    };
  }

  /** The sharing panel's props with every door answering "nothing here" —
   *  each test overrides only the door whose behaviour it is stating. */
  function sharing(): SharingCardProps {
    return {
      now: NOW,
      ownVaultIds: ["v1"],
      loadLinks: async () => [],
      onProposeLink: async () => {
        throw new Error("not used");
      },
      onApproveLink: async () => {
        throw new Error("not used");
      },
      loadEdges: async () => [],
      loadCommonsInvitations: async () => [],
      onClaimCommonsInvitation: async () => ({}),
      onAnswerCommonsInvitation: async () => ({}),
    };
  }

  async function mount(
    props: Partial<HouseholdScreenProps> = {}
  ): Promise<HTMLDivElement> {
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      root.render(
        <HouseholdScreen
          now={NOW}
          vaults={[scope()]}
          defaultScopeId="v1"
          onOpenStorage={() => {}}
          {...props}
        />
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    return container;
  }

  function button(
    el: HTMLElement,
    text: string
  ): HTMLButtonElement | undefined {
    return [...el.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === text
    );
  }

  /** The verb on the row whose title is `title` — device rows and vault rows
   *  both offer "Manage", so a bare text search would find the wrong one. */
  function rowAction(
    el: HTMLElement,
    title: string,
    label: string
  ): HTMLButtonElement | undefined {
    const row = [...el.querySelectorAll(".row")].find(
      (candidate) => candidate.querySelector(".title")?.textContent === title
    );
    return [...(row?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent?.trim() === label
    );
  }

  async function click(el: HTMLButtonElement | undefined): Promise<void> {
    await act(async () => {
      el!.click();
      await Promise.resolve();
    });
  }

  describe("merged into the Vault surface", () => {
    it("draws its own section head, and publishes nothing to a second channel", async () => {
      const reports: unknown[] = [];
      const el = await mount({
        ...roster(),
        embedded: true,
        onReport: (report) => reports.push(report),
        records: 41_208,
      });
      expect(el.textContent).toContain("Where it lives");
      // ONE PUBLISHER. Two channels behind one bar is two answers the bar can
      // only draw one of; the half reports upward instead.
      expect(readVitals("household")).toBeUndefined();
      expect(readVitals("atlas")).toBeUndefined();
      const last = reports.at(-1) as { custody: string; state: string };
      expect(last.state).toBe("ready");
      expect(last.custody).toBe(
        "41,208 records · 2 machines hold a full copy · 2 devices enrolled"
      );
    });

    it("omits the record clause when the census has not answered", async () => {
      const reports: { custody: string }[] = [];
      await mount({
        ...roster(),
        embedded: true,
        onReport: (report) => reports.push(report),
        records: null,
      });
      // An old gateway that cannot report a census must not cost the page the
      // two numbers it does know, and must not make it guess the third.
      const custody = reports.at(-1)?.custody ?? "";
      expect(custody).toBe("2 machines hold a full copy · 2 devices enrolled");
      expect(custody).not.toContain("records");
    });

    it("hides its rows outright when the section is closed", async () => {
      const el = await mount({
        ...roster(),
        embedded: true,
        collapsed: true,
        onToggle: () => {},
      });
      expect(el.textContent).toContain("Where it lives");
      expect(el.querySelectorAll(".row")).toHaveLength(0);
    });
  });

  describe(HouseholdScreen, () => {
    it("leads with the vaults, then the hardware, then the people (v11)", async () => {
      const el = await mount(roster());
      const text = el.textContent ?? "";
      expect(text).toContain("Vaults you own");
      expect(text).toContain("Yours");
      expect(text).toContain("This laptop");
      expect(text).toContain("People");
      // The order the question narrows: the containers, then the machines
      // holding them, then the people those machines belong to.
      expect(text.indexOf("Vaults you own")).toBeLessThan(
        text.indexOf("Yours")
      );
      expect(text.indexOf("Yours")).toBeLessThan(text.indexOf("People"));
      // Identity belongs to the frame now — the page draws no title of its own.
      expect(el.querySelector("h1")).toBeNull();
    });

    it("publishes the count line and a healthy status when nothing is waiting", async () => {
      await mount(roster());
      expect(readVitals("household")).toStrictEqual({
        count: "2 devices · 1 person · 0 pending",
        state: "ready",
      });
      expect(readRouteHealth()?.text).toBe(
        "No requests are pending · Every device that can reach this vault is one you paired."
      );
      expect(readRouteHealth()?.action).toBeUndefined();
    });

    it("counts what is waiting, names the first ask, and offers one way in", async () => {
      await mount({
        ...roster(),
        sharing: {
          ...sharing(),
          loadLinks: async () => [
            {
              linkId: "lnk_1",
              vaultA: "v1",
              vaultB: "v9",
              labelA: "Priya",
              labelB: "Ana Pemberton",
              approvedByA: false,
              approvedByB: true,
              approved: false,
              remoteVaultId: "v9",
              revoked: false,
              createdAt: "2026-08-10T09:00:00.000Z",
            },
          ],
        },
      });
      expect(readVitals("household")?.count).toBe(
        "2 devices · 1 person · 1 pending"
      );
      const health = readRouteHealth();
      expect(health?.text).toContain("1 request is pending");
      expect(health?.text).toContain("Ana Pemberton asked to connect on");
      expect(health?.action?.label).toBe("Review it");
      // Pending is neither an alarm nor nothing — it is the page's seam tone.
      expect(health?.tone).toBe("seam");
    });

    it("says the vault is reachable from here alone, and offers the one act that changes it", async () => {
      const el = await mount({
        loadDevices: async () => [device({ current: true })],
        onRevokeDevice: async () => ({ removed: true }),
        onCreateDeviceTicket:
          vi.fn<NonNullable<HouseholdScreenProps["onCreateDeviceTicket"]>>(),
      });
      expect(el.textContent).toContain("Only this device is enrolled");
      expect(el.textContent).toContain(
        "Pair a phone or a laptop to reach this vault from it."
      );
      expect(readVitals("household")).toStrictEqual({
        count: "This device only",
        state: "empty",
      });
      // The empty state's own verb opens this page's pairing panel.
      await click(button(el, "Pair a device"));
      expect(el.querySelector('[data-testid="pair-panel"]')).toBeTruthy();
    });

    it("states what a gateway it cannot reach costs, and what is unaffected", async () => {
      const el = await mount({
        loadDevices: async () => {
          throw new Error("offline");
        },
        onRevokeDevice: async () => ({ removed: true }),
      });
      const text = el.textContent ?? "";
      expect(text).toContain("Cannot reach the vault host");
      expect(text).toContain(
        "Pairing and revocation need the vault host — this page is a cached copy."
      );
      expect(button(el, "Try again")).toBeTruthy();
      expect(readVitals("household")?.state).toBe("error");
    });

    it("holds the row geometry while it reads, rather than spinning", async () => {
      container = document.createElement("div");
      document.body.appendChild(container);
      // A loader that never settles — the first paint is the assertion.
      await act(async () => {
        root = createRoot(container as HTMLDivElement);
        root.render(
          <HouseholdScreen
            now={NOW}
            vaults={[scope()]}
            defaultScopeId="v1"
            onOpenStorage={() => {}}
            loadDevices={() =>
              new Promise(() => {
                /* never settles — the first paint is the assertion */
              })
            }
            onRevokeDevice={async () => ({ removed: true })}
          />
        );
      });
      expect(container.querySelector("output")).toBeTruthy();
      expect(container.textContent).toContain(
        "A row knows its shape before its content arrives"
      );
      expect(readVitals("household")?.state).toBe("loading");
    });

    it("names each vault and states ownership plainly, never role jargon", async () => {
      const el = await mount({
        ...roster(),
        vaults: [
          scope(),
          scope({ id: "v2", label: "Family" }),
          scope({ id: "v3", label: "Shed project" }),
        ],
        defaultScopeId: "v1",
      });
      const text = el.textContent ?? "";
      expect(text).toContain("Family");
      expect(text).toContain("Shed project");
      expect(text).toContain("You own this vault.");
      expect(text).not.toMatch(/\badmin\b/u);
      expect(text).not.toMatch(/\b(?:Owner|Member|Viewer)\b/u);
      // "Vault" is the one user-facing word for a vault; the section head
      // says so, and no row calls one a "space".
      const vaultSection = [...el.querySelectorAll("h2")].find(
        (h) => h.textContent === "Vaults you own"
      );
      expect(vaultSection?.nextElementSibling?.textContent).toBe("3");
      expect(vaultSection?.parentElement?.querySelector("fieldset")).toBeNull();
    });

    it("marks exactly one vault the default and offers its settings only there", async () => {
      const onOpenVaultSettings =
        vi.fn<NonNullable<HouseholdScreenProps["onOpenVaultSettings"]>>();
      const el = await mount({
        ...roster(),
        vaults: [scope(), scope({ id: "v2", label: "Family" })],
        defaultScopeId: "v1",
        onOpenVaultSettings,
      });
      expect(el.textContent?.match(/Default/gu) ?? []).toHaveLength(1);
      // Settings → Vault edits whichever vault the client resolves to, so the
      // door must not open from a row it would silently mis-target.
      await click(rowAction(el, "Family", "Manage"));
      expect(button(el, "Vault settings")).toBeUndefined();
      await click(rowAction(el, "Family", "Close"));
      await click(rowAction(el, "Personal", "Manage"));
      await click(button(el, "Vault settings"));
      expect(onOpenVaultSettings).toHaveBeenCalledWith();
    });

    it("draws ONE door to storage for the gateway, not one per vault", async () => {
      const onOpenStorage = vi.fn<HouseholdScreenProps["onOpenStorage"]>();
      const el = await mount({
        ...roster(),
        onOpenStorage,
        vaults: [scope(), scope({ id: "v2", label: "Family" })],
      });
      // Capacity is one fact about the gateway. It used to be a button inside
      // each vault's own detail, which drew the same door once per vault and
      // implied it was a per-vault fact.
      expect(el.textContent?.match(/Storage on this gateway/gu)).toHaveLength(
        1
      );
      await click(rowAction(el, "Storage on this gateway", "Open"));
      expect(onOpenStorage).toHaveBeenCalledWith();
    });

    it("says so plainly when the gateway reports no roster, rather than rendering nothing", async () => {
      const el = await mount();
      expect(el.textContent).toContain("doesn’t report a roster");
    });

    it('distinguishes "still loading" from "genuinely no vaults"', async () => {
      const loading = await mount({
        ...roster(),
        vaults: [],
        vaultsLoading: true,
      });
      expect(loading.textContent).toContain("Loading vaults…");
      act(() => root?.unmount());
      container?.remove();
      const empty = await mount({
        ...roster(),
        vaults: [],
        vaultsLoading: false,
      });
      expect(empty.textContent).toContain("No vaults are reachable");
    });

    it('offers "Create a vault" only when the host can create one', async () => {
      let opened = 0;
      const withCreate = await mount({
        ...roster(),
        onNewVault: () => {
          opened += 1;
        },
      });
      expect(withCreate.textContent).toContain("Create a vault");
      await click(rowAction(withCreate, "Create a vault", "Create"));
      expect(opened).toBe(1);
      act(() => root?.unmount());
      container?.remove();
      // Withdrawn, not disabled: a gateway this client cannot create vaults on
      // offers no verb rather than a failing one.
      const without = await mount(roster());
      expect(without.textContent).not.toContain("Create a vault");
    });

    it("shows receiver Commons offers with size and explicit Accept/Refuse", async () => {
      const onAnswerCommonsInvitation = vi.fn<
        (
          invitationId: string,
          memberVaultId: string,
          answer: "accept" | "refuse"
        ) => Promise<unknown>
      >(async () => ({}));
      const el = await mount({
        ...roster(),
        sharing: {
          ...sharing(),
          loadCommonsInvitations: async () => [
            {
              invitationId: "invite-1",
              grantId: "grant-1",
              stewardVaultId: "other-vault",
              memberVaultId: "v1",
              currentSizeBytes: 4096,
              status: "pending",
              createdAt: "2026-08-10T00:00:00.000Z",
            },
          ],
          onAnswerCommonsInvitation,
        },
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(el.textContent).toContain("Shared spaces offered to you");
      expect(el.textContent).toContain("4.0 KB now");
      await click(button(el, "Accept"));
      expect(onAnswerCommonsInvitation).toHaveBeenCalledWith(
        "invite-1",
        "v1",
        "accept"
      );
    });

    it("puts a lost shared-space steward in front of the owner and runs the ceremony from here", async () => {
      const onRecoverCommons = vi.fn<
        NonNullable<SharingCardProps["onRecoverCommons"]>
      >(async () => ({
        state: "recovered",
        grantId: "grant-2",
        invitedPartyIds: ["party-b", "party-c"],
        replayed: false,
        invitations: [
          { partyId: "party-b", memberVaultId: "vault-b", state: "delivered" },
          { partyId: "party-c", state: "claim" },
        ],
      }));
      const el = await mount({
        ...roster(),
        sharing: {
          ...sharing(),
          loadCommonsRecovery: async () => [
            {
              actorVaultId: "v1",
              grantId: "grant-1",
              containerType: "album",
              steward: {
                presence: "absent",
                stewardVaultId: "vault-gone",
                silentForMs: 9 * 24 * 60 * 60 * 1000,
              },
            },
          ],
          onRecoverCommons,
        },
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(el.textContent).toContain("Shared-space recovery");
      expect(el.textContent).toContain("silent for 9 days");
      await click(button(el, "Recover from my copy"));
      expect(onRecoverCommons).toHaveBeenCalledWith("v1", "grant-1");
      // The seat with no link to this device cannot be invited over the wire;
      // saying so is the difference between a recovered circle and a smaller one.
      await act(async () => {
        await Promise.resolve();
      });
      expect(el.textContent).toContain("must be invited by hand");
    });

    it("never offers the ceremony for a seat parked on an unverified history", async () => {
      const el = await mount({
        ...roster(),
        sharing: {
          ...sharing(),
          loadCommonsRecovery: async () => [
            {
              actorVaultId: "v1",
              grantId: "grant-1",
              containerType: "album",
              steward: { presence: "parked", fault: "chain-divergence" },
            },
          ],
          onRecoverCommons: async () => {
            throw new Error("must not be reachable");
          },
        },
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(el.textContent).toContain("could not be verified");
      expect(button(el, "Recover from my copy")).toBeUndefined();
    });

    it("redeems a pasted one-time Commons invite into the selected vault", async () => {
      const onClaimCommonsInvitation = vi.fn<
        (
          actorVaultId: string,
          stewardVaultId: string,
          claimToken: string
        ) => Promise<unknown>
      >(async () => ({}));
      const el = await mount({
        ...roster(),
        sharing: { ...sharing(), onClaimCommonsInvitation },
      });
      const input = el.querySelector(
        'input[aria-label="Shared-space invitation"]'
      ) as HTMLInputElement;
      const code = encodeCommonsInvite({
        stewardVaultId: "vault-steward",
        claimToken: "one-time-secret",
      });
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value"
        )?.set;
        setter?.call(input, code);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await click(button(el, "Redeem"));

      expect(onClaimCommonsInvitation).toHaveBeenCalledWith(
        "v1",
        "vault-steward",
        "one-time-secret"
      );
      expect(input.value).toBe("");
    });
  });
});
