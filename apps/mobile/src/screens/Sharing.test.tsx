import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SharingScreen from "./Sharing";
import { shareAbsentLine } from "./sharing-reads";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const wire = vi.hoisted(() => ({
  listLinks: vi.fn<() => Promise<unknown[]>>(),
  approveLink: vi.fn<() => Promise<unknown>>(),
}));

const replica = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));

vi.mock(import("react-native"), async () => {
  const stub = await import("../test/react-native-stub");
  return stub.reactNativeStub() as unknown as typeof import("react-native");
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

const BASE = "http://127.0.0.1:4599";
const HOME = { vaultId: "vault-home", label: "Home", canWrite: true };

let root: Root | undefined;
let container: HTMLElement | undefined;

async function show(): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(
      <SharingScreen
        navigation={
          {
            goBack: vi.fn<() => void>(),
            setParams: vi.fn<() => void>(),
          } as unknown as React.ComponentProps<
            typeof SharingScreen
          >["navigation"]
        }
        route={
          {
            key: "Sharing",
            name: "Sharing",
          } as React.ComponentProps<typeof SharingScreen>["route"]
        }
      />
    );
  });
  return container;
}

describe("the Sharing screen", () => {
  beforeEach(() => {
    for (const call of Object.values(wire)) call.mockReset();
    wire.listLinks.mockResolvedValue([]);
    replica.value = {
      gatewayBase: BASE,
      vaultId: HOME.vaultId,
      scopes: [HOME],
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
      wire.listLinks.mockRejectedValue(new TypeError("Network request failed"));
      const el = await show();
      expect(el.textContent).toContain(
        shareAbsentLine("Who is linked", "unreachable")
      );
      expect(el.textContent).not.toContain(
        shareAbsentLine("Who is linked", "refused")
      );
    });

    it("still says 'none' when the gateway actually answered none", async () => {
      const el = await show();
      expect(el.textContent).toContain("No people linked yet.");
    });
  });

  it("lists the people a link produced", async () => {
    wire.listLinks.mockResolvedValue([
      {
        linkId: "link-1",
        vaultA: HOME.vaultId,
        vaultB: "vault-bob",
        labelB: "Bob's vault",
        remoteVaultId: "vault-bob",
      },
    ]);
    const el = await show();
    expect(el.textContent).toContain("Bob's vault");
    expect(el.textContent).not.toContain("No people linked yet.");
  });
});
// @vitest-environment jsdom
