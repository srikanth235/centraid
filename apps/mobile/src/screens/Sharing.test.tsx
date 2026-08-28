// People & circles on the phone (#880). Three claims, each about a fact the
// screen used to state without having learned it:
//
//  1. L-READ (#821): a read that did not land renders ABSENT. "No people
//     linked yet." is an answer, and this screen may only print it when it got
//     one — and offline must not read the same as refused.
//  2. Every MOUNTED vault is listed, each row named by the vault it came from.
//     Pairing can grant several vaults and up to four are mounted, so a
//     pending invitation on a non-focused one was previously invisible.
//  3. A tapped `centraid://commons-invite` link arrives as route params and is
//     redeemed, with the one-time token lifted straight back out of navigation
//     state. Redeem-by-paste still works.
// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encodeCommonsInvite } from "@centraid/blueprints/apps/_shared/commons-invite";

import SharingScreen from "./Sharing";
import { shareAbsentLine } from "./sharing-reads";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const wire = vi.hoisted(() => ({
  listLinks: vi.fn<() => Promise<unknown[]>>(),
  approveLink: vi.fn<() => Promise<unknown>>(),
  listEdges: vi.fn<() => Promise<unknown[]>>(),
  listCommonsInvitations:
    vi.fn<(base: string, v: string) => Promise<unknown[]>>(),
  listCommonsRecovery: vi.fn<(base: string, v: string) => Promise<unknown[]>>(),
  claimCommonsInvitation:
    vi.fn<
      (
        base: string,
        actor: string,
        steward: string,
        token: string
      ) => Promise<unknown>
    >(),
  answerCommonsInvitation: vi.fn<() => Promise<unknown>>(),
  recoverCommons: vi.fn<() => Promise<unknown>>(),
}));

const replica = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));

vi.mock(import("react-native"), async () => {
  const ReactModule = await import("react");
  const stub = await import("../test/react-native-stub");
  return {
    ...stub.reactNativeStub(),
    // The shared stub drops `onChangeText`, and this suite types an invitation
    // into the field to prove redeem-by-paste survived the deep link.
    TextInput: (props: {
      accessibilityLabel?: string;
      value?: string;
      onChangeText?: (value: string) => void;
    }) =>
      ReactModule.createElement("input", {
        "aria-label": props.accessibilityLabel,
        onChange: (event: { target: { value: string } }) =>
          props.onChangeText?.(event.target.value),
        value: props.value ?? "",
      }),
  } as unknown as typeof import("react-native");
});
vi.mock(import("@react-native-async-storage/async-storage"), async () => {
  const stub = await import("../test/react-native-stub");
  return stub.asyncStorageStub() as unknown as {
    default: typeof import("@react-native-async-storage/async-storage").default;
  };
});
vi.mock(import("react-native-svg"), async () => {
  const stub = await import("../test/react-native-stub");
  return stub.svgStub() as unknown as typeof import("react-native-svg");
});
vi.mock(
  import("../kit/components/TopSafeArea"),
  () =>
    ({
      default: ({ children }: { children?: React.ReactNode }) =>
        React.createElement("div", null, children),
    }) as never
);
vi.mock(
  import("../kit/components/Icon"),
  () => ({ default: () => null }) as never
);
// The link ceremony has its own file and its own Clipboard/Expo reach; here it
// is a recorder, so this suite stays about what Sharing READ and SAID.
vi.mock(
  import("./SharingLinkRow"),
  () =>
    ({
      default: ({ label }: { label: string }) =>
        React.createElement("span", null, label),
      LinkTicketPanel: () => null,
    }) as never
);
vi.mock(
  import("../kit/replica/ReplicaProvider"),
  () => ({ useReplica: () => replica.value }) as never
);
vi.mock(
  import("../lib/replica/links-transport"),
  () => ({ listLinks: wire.listLinks, approveLink: wire.approveLink }) as never
);
vi.mock(
  import("../lib/replica/edges-transport"),
  () => ({ listEdges: wire.listEdges }) as never
);
vi.mock(
  import("../lib/replica/placement-transport"),
  () =>
    ({
      listCommonsInvitations: wire.listCommonsInvitations,
      listCommonsRecovery: wire.listCommonsRecovery,
      claimCommonsInvitation: wire.claimCommonsInvitation,
      answerCommonsInvitation: wire.answerCommonsInvitation,
      recoverCommons: wire.recoverCommons,
    }) as never
);

const BASE = "http://127.0.0.1:4599";
const HOME = { vaultId: "vault-home", label: "Home", canWrite: true };
const STUDIO = { vaultId: "vault-studio", label: "Studio", canWrite: true };

function invitation(overrides: Record<string, unknown> = {}) {
  return {
    invitationId: "inv-1",
    grantId: "grant-1",
    stewardVaultId: "vault-priya",
    memberVaultId: STUDIO.vaultId,
    currentSizeBytes: 2048,
    status: "pending",
    createdAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

let root: Root | undefined;
let container: HTMLElement | undefined;

const setParams = vi.fn<(params: Record<string, unknown>) => void>();

async function show(params?: {
  stewardVaultId?: string;
  claimToken?: string;
}): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(
      <SharingScreen
        navigation={
          {
            goBack: vi.fn<() => void>(),
            setParams,
          } as unknown as React.ComponentProps<
            typeof SharingScreen
          >["navigation"]
        }
        route={
          { key: "Sharing", name: "Sharing", params } as React.ComponentProps<
            typeof SharingScreen
          >["route"]
        }
      />
    );
  });
  return container;
}

describe("the Sharing screen", () => {
  beforeEach(() => {
    for (const call of Object.values(wire)) call.mockReset();
    setParams.mockReset();
    wire.listLinks.mockResolvedValue([]);
    wire.listEdges.mockResolvedValue([]);
    wire.listCommonsInvitations.mockResolvedValue([]);
    wire.listCommonsRecovery.mockResolvedValue([]);
    wire.claimCommonsInvitation.mockResolvedValue({ claimed: true });
    replica.value = {
      gatewayBase: BASE,
      vaultId: HOME.vaultId,
      scopes: [HOME, STUDIO],
      online: true,
      ready: true,
    };
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  describe("a read that did not land", () => {
    it("renders absent, never 'no people linked yet'", async () => {
      wire.listLinks.mockRejectedValue(new Error("list links failed (403)"));
      const el = await show();
      expect(el.textContent).not.toContain("No people linked yet.");
      expect(el.textContent).toContain(
        shareAbsentLine("Who is linked", "refused")
      );
    });

    it("says out of reach when the request never left the device", async () => {
      wire.listEdges.mockRejectedValue(new TypeError("Network request failed"));
      const el = await show();
      expect(el.textContent).not.toContain(
        "No copies between your vaults yet."
      );
      expect(el.textContent).toContain(
        shareAbsentLine("Copies between your vaults", "unreachable")
      );
      // The refusal sentence is a DIFFERENT sentence, and this is not it.
      expect(el.textContent).not.toContain(
        shareAbsentLine("Copies between your vaults", "refused")
      );
    });

    it("still says 'none' when the gateway actually answered none", async () => {
      const el = await show();
      expect(el.textContent).toContain("No people linked yet.");
      expect(el.textContent).toContain("No copies between your vaults yet.");
    });

    it("does not blank the sections that did answer", async () => {
      wire.listLinks.mockRejectedValue(new Error("list links failed (500)"));
      wire.listEdges.mockResolvedValue([]);
      const el = await show();
      expect(el.textContent).toContain("No copies between your vaults yet.");
    });
  });

  describe("every mounted vault", () => {
    it("is asked, not just the focused one", async () => {
      await show();
      expect(
        wire.listCommonsInvitations.mock.calls.map((call) => call[1])
      ).toStrictEqual([HOME.vaultId, STUDIO.vaultId]);
      expect(
        wire.listCommonsRecovery.mock.calls.map((call) => call[1])
      ).toStrictEqual([HOME.vaultId, STUDIO.vaultId]);
    });

    it("names the vault each offered space arrived in", async () => {
      wire.listCommonsInvitations.mockImplementation((_base, vaultId) =>
        Promise.resolve(
          vaultId === STUDIO.vaultId
            ? [invitation({ invitationId: "inv-studio" })]
            : []
        )
      );
      const el = await show();
      expect(el.textContent).toContain("Ongoing shared space from vault-priya");
      // The row is on a vault this member is not currently focused on.
      expect(el.textContent).toContain("Studio");
    });

    it("says which vaults it could not read rather than showing a short list", async () => {
      wire.listCommonsInvitations.mockImplementation((_base, vaultId) =>
        vaultId === STUDIO.vaultId
          ? Promise.reject(new TypeError("Network request failed"))
          : Promise.resolve([invitation()])
      );
      const el = await show();
      expect(el.textContent).toContain("Not everything is shown");
      expect(el.textContent).toContain("Studio");
    });
  });

  describe("a tapped invitation link", () => {
    const CLAIM = { stewardVaultId: "vault-priya", claimToken: "one-time" };

    it("redeems the claim the link carried", async () => {
      await show(CLAIM);
      expect(wire.claimCommonsInvitation.mock.calls).toStrictEqual([
        [BASE, HOME.vaultId, CLAIM.stewardVaultId, CLAIM.claimToken],
      ]);
    });

    it("lifts the one-time token straight out of navigation state", async () => {
      await show(CLAIM);
      expect(setParams.mock.calls).toStrictEqual([
        [{ stewardVaultId: undefined, claimToken: undefined }],
      ]);
    });

    it("claims nothing when the link carried no claim", async () => {
      await show();
      expect(wire.claimCommonsInvitation).not.toHaveBeenCalled();
      expect(setParams).not.toHaveBeenCalled();
    });

    it("keeps redeem-by-paste working", async () => {
      const el = await show();
      const field = el.querySelector("input") as HTMLInputElement;
      const uri = encodeCommonsInvite({
        stewardVaultId: "vault-ravi",
        claimToken: "pasted-token",
      });
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value"
        )?.set?.call(field, uri);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        [...el.querySelectorAll("button")]
          .find((button) => button.textContent === "Redeem")
          ?.click();
      });
      expect(wire.claimCommonsInvitation.mock.calls).toStrictEqual([
        [BASE, HOME.vaultId, "vault-ravi", "pasted-token"],
      ]);
    });
  });
});
