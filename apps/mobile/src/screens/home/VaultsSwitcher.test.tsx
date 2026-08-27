// The four-scope cap has a UX now (#880 W3.4). The mounted read plane holds
// four vaults (docs/mobile-offline.md); the switcher is where a member with
// more than four saved Vaults finds out which ones this phone is carrying.
//
// react-native is mocked to plain DOM elements so this runs under jsdom, the
// same approach ReplicaStatusBar.test.tsx takes.
// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import VaultsSwitcher from "./VaultsSwitcher";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type ReactNative = typeof import("react-native");
type SafeAreaContext = typeof import("react-native-safe-area-context");
type DesignModule = typeof import("@centraid/design");
type GrabberModule = typeof import("../../kit/components/Grabber");
type IconModule = typeof import("../../kit/components/Icon");
type NativeTextModule = typeof import("../../kit/components/NativeText");
type AnimatedValueModule = typeof import("../../kit/hooks/useAnimatedValue");
type ReducedMotionModule = typeof import("../../kit/hooks/useReducedMotion");
type ReplicaProviderModule = typeof import("../../kit/replica/ReplicaProvider");
type ThemeModule = typeof import("../../kit/theme");
type GatewayModule = typeof import("../../lib/gateway");
type PhoneLinkModule = typeof import("../../lib/phone-link");
type VaultLinksModule = typeof import("../../lib/vault-links");

vi.mock(import("react-native"), async () => {
  const ReactModule = await import("react");
  const passthrough = (
    tag: string
  ): React.FunctionComponent<{ children?: React.ReactNode }> => {
    const Passthrough = ({
      children,
    }: {
      children?: React.ReactNode;
    }): React.ReactNode => ReactModule.createElement(tag, null, children);
    Passthrough.displayName = `Mock(${tag})`;
    return Passthrough;
  };
  return {
    Alert: { alert: vi.fn<() => void>() },
    Animated: {
      View: passthrough("div"),
      parallel: () => ({ start: (): void => undefined }),
      timing: () => ({ start: (): void => undefined }),
    },
    Easing: {
      bezier: () => undefined,
      out: () => undefined,
      quad: undefined,
    },
    Modal: ({
      children,
      visible,
    }: {
      children?: React.ReactNode;
      visible?: boolean;
    }) =>
      visible
        ? ReactModule.createElement("div", { role: "dialog" }, children)
        : null,
    Pressable: ({
      accessibilityLabel,
      children,
      onPress,
    }: {
      accessibilityLabel?: string;
      children?: React.ReactNode;
      onPress?: () => void;
    }) =>
      ReactModule.createElement(
        "button",
        { "aria-label": accessibilityLabel, onClick: onPress, type: "button" },
        children
      ),
    ScrollView: passthrough("div"),
    StyleSheet: {
      absoluteFill: {},
      create: <T,>(styles: T): T => styles,
    },
    View: passthrough("div"),
  } as unknown as Partial<ReactNative>;
});

vi.mock(
  import("react-native-safe-area-context"),
  () =>
    ({
      useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
    }) as unknown as Partial<SafeAreaContext>
);

vi.mock(
  import("@centraid/design"),
  () =>
    ({
      icons: { Sparkle: () => null },
      identityInk: () => "#mock-ink",
    }) as unknown as Partial<DesignModule>
);

vi.mock(
  import("../../kit/components/Grabber"),
  () => ({ default: () => null }) as unknown as GrabberModule
);

vi.mock(
  import("../../kit/components/Icon"),
  () =>
    ({
      default: ({ name }: { name?: string }) =>
        React.createElement("i", { "data-icon": name }),
    }) as unknown as IconModule
);

vi.mock(
  import("../../kit/components/NativeText"),
  () =>
    ({
      Text: ({ children }: { children?: React.ReactNode }) =>
        React.createElement("span", null, children),
    }) as unknown as Partial<NativeTextModule>
);

// STABLE identity, deliberately: the sheet's open effect lists both animated
// values in its dependency array, so a fresh object per render re-runs it, and
// the registry sync inside it re-renders — a loop with no exit.
vi.mock(import("../../kit/hooks/useAnimatedValue"), () => {
  const value = { setValue: (): void => undefined };
  return {
    useAnimatedValue: () => value,
  } as unknown as Partial<AnimatedValueModule>;
});

vi.mock(
  import("../../kit/hooks/useReducedMotion"),
  () =>
    ({
      motionDuration: (value: number) => value,
      useReducedMotion: () => false,
    }) as unknown as Partial<ReducedMotionModule>
);

vi.mock(
  import("../../kit/theme"),
  () =>
    ({
      family: { sansMedium: "sans-medium" },
      radii: { lg: 12, md: 7 },
      t: () => ({ fontSize: 12 }),
      useTheme: () => ({
        colors: {
          accent: "#mock-accent",
          bg: "#mock-bg",
          bgElev: "#mock-bg-elev",
          line: "#mock-line",
          scrim: "#mock-scrim",
          text: "#mock-text",
          textFaint: "#mock-text-faint",
          textGhost: "#mock-text-ghost",
          textInv: "#mock-text-inv",
        },
      }),
    }) as unknown as Partial<ThemeModule>
);

vi.mock(
  import("../../lib/gateway"),
  () =>
    ({
      listVaults: () => Promise.resolve([]),
    }) as unknown as Partial<GatewayModule>
);

vi.mock(
  import("../../lib/phone-link"),
  () =>
    ({
      forgetVaultLink: () => Promise.resolve(),
      switchVaultLink: () => Promise.resolve(),
    }) as unknown as Partial<PhoneLinkModule>
);

const registry = vi.hoisted(() => ({
  links: [] as Array<{
    id: string;
    gatewayId: string;
    vaultId: string;
    vaultName: string;
    desktopName: string;
  }>,
  activeId: "link-1",
}));

vi.mock(
  import("../../lib/vault-links"),
  () =>
    ({
      addActiveGatewayVault: () => Promise.resolve(),
      getActiveVaultLink: () =>
        registry.links.find((link) => link.id === registry.activeId),
      listVaultLinks: () => registry.links,
      noteActiveVaultMeta: () => Promise.resolve(),
      subscribeVaultLinks: () => (): void => undefined,
    }) as unknown as Partial<VaultLinksModule>
);

const replicaMock = vi.hoisted(() => ({
  scopes: [] as Array<{ vaultId: string }>,
}));

vi.mock(
  import("../../kit/replica/ReplicaProvider"),
  () =>
    ({
      useReplica: () => replicaMock,
    }) as unknown as Partial<ReplicaProviderModule>
);

function enrol(count: number, gatewayId = "gateway-1"): void {
  registry.links = Array.from({ length: count }, (_unused, index) => ({
    id: `link-${index + 1}`,
    gatewayId,
    vaultId: `vault-${index + 1}`,
    vaultName: `Vault ${index + 1}`,
    desktopName: "Studio",
  }));
}

let container: HTMLDivElement;
let root: Root;

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(VaultsSwitcher, {
        open: true,
        onClose: () => undefined,
        onPairDesktop: () => undefined,
      })
    );
  });
}

function rowSubs(): string[] {
  return [...container.querySelectorAll("span")].map(
    (node) => node.textContent ?? ""
  );
}

describe("what the switcher says about the four-vault cap (#880)", () => {
  beforeEach(() => {
    registry.activeId = "link-1";
    replicaMock.scopes = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("names which saved Vaults this phone is carrying and which it is not", async () => {
    enrol(6);
    replicaMock.scopes = ["vault-1", "vault-2", "vault-3", "vault-4"].map(
      (vaultId) => ({ vaultId })
    );

    await render();

    expect(container.textContent).toContain(
      "Four vaults stay on this phone at a time."
    );
    const subs = rowSubs();
    // Four mounted, so two of the five switchable rows say so and three do not.
    expect(subs.filter((text) => text === "On this phone")).toHaveLength(3);
    expect(
      subs.filter((text) => text === "Over the four-vault limit")
    ).toHaveLength(2);
  });

  // Sabotage target: drop the `> MAX_MOUNTED_NATIVE_SCOPES` guard and every
  // ordinary two- or three-vault household grows a limit notice it never hits.
  it("says nothing about a limit a household is nowhere near", async () => {
    enrol(3);
    replicaMock.scopes = ["vault-1", "vault-2", "vault-3"].map((vaultId) => ({
      vaultId,
    }));

    await render();

    expect(container.textContent).not.toContain("four-vault limit");
    expect(container.textContent).not.toContain("On this phone");
  });

  // A replica still mounting has no mounted set to report. Labelling from an
  // empty one would paint every saved Vault as evicted on every cold start.
  it("stays silent while the mounted set is still unknown", async () => {
    enrol(6);
    replicaMock.scopes = [];

    await render();

    expect(container.textContent).not.toContain("four-vault limit");
  });

  // A Vault on another desktop is absent for a different reason entirely, and
  // this gateway's mounted set says nothing about it.
  it("judges only the active gateway's own saved Vaults", async () => {
    enrol(6);
    registry.links = [
      ...registry.links,
      {
        id: "link-elsewhere",
        gatewayId: "gateway-2",
        vaultId: "vault-elsewhere",
        vaultName: "Elsewhere",
        desktopName: "Cabin",
      },
    ];
    replicaMock.scopes = ["vault-1", "vault-2", "vault-3", "vault-4"].map(
      (vaultId) => ({ vaultId })
    );

    await render();

    const subs = rowSubs();
    expect(subs).toContain("Cabin");
    expect(
      subs.filter((text) => text === "Over the four-vault limit")
    ).toHaveLength(2);
  });
});
