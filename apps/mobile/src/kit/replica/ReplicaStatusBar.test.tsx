// Regression net for issue #711's ReplicaStatusBar defects.
//
// Sabotage-verified: dropping the `pending.length > 0 ?` guard back to an
// unconditional render makes the "hides the chip" test below fail — the chip
// would stand at "Pending changes 0" forever, exactly the standing badge §18
// forbids.
//
// react-native is mocked to plain DOM elements (the same approach
// `EnrichmentConsent.test.tsx` uses) so this can run under jsdom.
// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ReplicaStatusBar from "./ReplicaStatusBar";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type ReactNative = typeof import("react-native");
type NativeTextModule = typeof import("../components/NativeText");
type IconModule = typeof import("../components/Icon");
type OutOfRoomModule = typeof import("../components/OutOfRoom");
type DesignModule = typeof import("@centraid/design");
type ThumbnailPackModule = typeof import("../../lib/replica/thumbnail-pack");
type StorageErrorModule =
  typeof import("../../lib/replica/replica-storage-error");
type PendingChangesModule = typeof import("./pending-changes");
type ReplicaProviderModule = typeof import("./ReplicaProvider");
type ThemeModule = typeof import("../theme");

function flattenStyle(style: unknown): Record<string, unknown> {
  if (!style) return {};
  if (Array.isArray(style))
    return style.reduce(
      (acc: Record<string, unknown>, s) => Object.assign(acc, flattenStyle(s)),
      {}
    );
  if (typeof style === "object") return style as Record<string, unknown>;
  return {};
}

vi.mock(import("react-native"), async () => {
  const ReactModule = await import("react");
  return {
    Alert: { alert: vi.fn<() => void>() },
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
      accessibilityRole,
      children,
      onPress,
    }: {
      accessibilityLabel?: string;
      accessibilityRole?: string;
      children?: React.ReactNode;
      onPress?: () => void;
    }) =>
      ReactModule.createElement(
        "button",
        {
          "aria-label": accessibilityLabel,
          role: accessibilityRole,
          onClick: onPress,
          type: "button",
        },
        children
      ),
    ScrollView: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement("div", null, children),
    StyleSheet: {
      create: <T,>(styles: T): T => styles,
    },
    View: ({
      children,
      style,
    }: {
      children?: React.ReactNode;
      style?: unknown;
    }) =>
      ReactModule.createElement(
        "div",
        { "data-style": JSON.stringify(flattenStyle(style)) },
        children
      ),
  } as unknown as Partial<ReactNative>;
});

vi.mock(
  import("../components/NativeText"),
  () =>
    ({
      Text: ({ children }: { children?: React.ReactNode }) =>
        React.createElement("span", null, children),
    }) as unknown as Partial<NativeTextModule>
);

vi.mock(
  import("../components/Icon"),
  () =>
    ({
      default: ({ name }: { name?: string }) =>
        React.createElement("i", { "data-icon": name }),
    }) as unknown as IconModule
);

vi.mock(
  import("../components/OutOfRoom"),
  () =>
    ({
      default: () => React.createElement("div", null, "out of room"),
    }) as unknown as OutOfRoomModule
);

vi.mock(
  import("@centraid/design"),
  () =>
    ({
      formatRelativeTime: () => "just now",
    }) as unknown as Partial<DesignModule>
);

vi.mock(
  import("../../lib/replica/thumbnail-pack"),
  () =>
    ({
      clearPinnedThumbnailPacks: vi.fn<() => void>(),
    }) as unknown as Partial<ThumbnailPackModule>
);

vi.mock(
  import("../../lib/replica/replica-storage-error"),
  () =>
    ({
      STORAGE_FULL_ACTION_LABEL: "Free up space",
      STORAGE_FULL_CAUSE: "cause",
      STORAGE_FULL_CONSEQUENCE: "consequence",
    }) as unknown as Partial<StorageErrorModule>
);

vi.mock(
  import("../theme"),
  () =>
    ({
      borders: { hairline: 1 },
      family: { sansMedium: "sans-medium", sansRegular: "sans-regular" },
      radii: { lg: 12, md: 7 },
      t: () => ({}),
      useTheme: () => ({
        colors: {
          accent: "#mock-accent",
          bgSunken: "#mock-bg-sunken",
          danger: "#mock-danger",
          line: "#mock-line",
          text: "#mock-text",
          textFaint: "#mock-text-faint",
          textSoft: "#mock-text-soft",
        },
      }),
    }) as unknown as Partial<ThemeModule>
);

const pendingMock = vi.hoisted(() => ({
  pending: [] as unknown[],
  refresh: vi.fn<() => void>(),
}));

vi.mock(
  import("./pending-changes"),
  () =>
    ({
      usePendingChanges: () => pendingMock,
    }) as unknown as Partial<PendingChangesModule>
);

const replicaMock = vi.hoisted(() => ({
  reachability: "current" as string,
  refresh: vi.fn<() => void>(),
  scopes: [] as unknown[],
  session: undefined,
  storageFull: false,
}));

vi.mock(
  import("./ReplicaProvider"),
  () =>
    ({
      useReplica: () => replicaMock,
    }) as unknown as Partial<ReplicaProviderModule>
);

let container: HTMLDivElement;
let root: Root;

async function render(): Promise<void> {
  await act(async () => {
    root.render(React.createElement(ReplicaStatusBar));
  });
}

describe("pending-changes chip visibility (issue #711)", () => {
  beforeEach(() => {
    pendingMock.pending = [];
    replicaMock.reachability = "current";
    replicaMock.storageFull = false;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("hides the pending-changes chip when there is nothing pending", async () => {
    pendingMock.pending = [];
    await render();
    expect(container.textContent).not.toContain("Pending changes");
  });

  it("says nothing at all when the replica is current", async () => {
    // The whole point of the bar mounting on ~20 screens: on a settled
    // replica it must not draw a row. Sabotage target — make the `label ||
    // pending.length > 0` guard unconditional and this fails on the border,
    // or restore the `Updated …`/`Refresh` pair and it fails on the text.
    replicaMock.reachability = "current";
    await render();
    expect(container.textContent).toBe("");
  });

  it("keeps an action only where pulling the grid would not help", async () => {
    replicaMock.reachability = "gateway-asleep";
    await render();
    expect(container.textContent).toContain("Gateway asleep");
    expect(container.textContent).toContain("Wake help");
    // Never the plain word: pull-to-refresh is that control already.
    expect(container.textContent).not.toContain("Refresh");
  });

  it("shows the pending-changes chip once there is something pending", async () => {
    // Sabotage target: remove the `pending.length > 0 ?` guard around this
    // chip and it renders unconditionally, including at zero — the standing
    // badge §18 forbids.
    pendingMock.pending = [{ id: "1" }, { id: "2" }];
    await render();
    expect(container.textContent).toContain("Pending changes");
    expect(container.textContent).toContain("2");
  });
});
