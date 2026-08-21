// Regression net for issue #711's two ReplicaStateCard defects.
//
// Sabotage-verified: reverting the `connection === "offline"` branch back to
// the old `connection !== "unavailable" && !error` guard makes the offline
// test below fail (the card renders `null` for the offline case, same as the
// shipped bug — README:333, "a grey mosaic with no explanation is a bug").
//
// react-native is mocked to plain DOM elements (the same approach
// `EnrichmentConsent.test.tsx` uses) so this can run under jsdom without a
// full RN test renderer in this workspace.
// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ReplicaStateCard from "./ReplicaStateCard";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type ReactNative = typeof import("react-native");
type NativeTextModule = typeof import("../components/NativeText");
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
    StyleSheet: {
      create: <T,>(styles: T): T => styles,
    },
    View: ({
      accessibilityRole,
      children,
      style,
    }: {
      accessibilityRole?: string;
      children?: React.ReactNode;
      style?: unknown;
    }) =>
      ReactModule.createElement(
        "div",
        {
          role: accessibilityRole,
          "data-style": JSON.stringify(flattenStyle(style)),
        },
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
  import("../theme"),
  () =>
    ({
      borders: { hairline: 1 },
      family: { sansMedium: "sans-medium", sansRegular: "sans-regular" },
      radii: { lg: 12, md: 7 },
      t: () => ({}),
      useTheme: () => ({
        colors: {
          line: "#mock-line",
          net: "#mock-net",
          text: "#mock-text",
        },
      }),
    }) as unknown as Partial<ThemeModule>
);

let container: HTMLDivElement;
let root: Root;

async function renderCard(
  props: Partial<React.ComponentProps<typeof ReplicaStateCard>>
): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(ReplicaStateCard, {
        connection: "unavailable",
        noun: "Tally",
        ...props,
      })
    );
  });
}

describe("offline/unavailable explanation card (issue #711)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("says nothing at all when the gateway is merely unreachable", async () => {
    // Offline renders NOTHING: a vault is a local replica, so offline the grid
    // renders from bytes already on the phone. Carding that as an incident
    // over-announces the product's own premise.
    await renderCard({ connection: "offline", noun: "Notes" });
    expect(container.innerHTML).toBe("");
  });

  it("shows the error message and 'could not be loaded' when offline WITH error", async () => {
    await renderCard({
      connection: "offline",
      noun: "Notes",
      error: "Read failed",
    });
    expect(container.textContent).toContain("Notes could not be loaded");
    expect(container.textContent).toContain("Read failed");
  });

  it("shows 'is not connected' for the unavailable state", async () => {
    await renderCard({ connection: "unavailable", noun: "Tasks" });
    expect(container.textContent).toContain("Tasks is not connected");
  });

  it("renders nothing when connected with no error", async () => {
    await renderCard({ connection: "current", noun: "Photos" });
    expect(container.innerHTML).toBe("");
  });

  it("unavailable card has borderColor #mock-net and role alert", async () => {
    await renderCard({ connection: "unavailable", noun: "Tally" });
    const card = container.querySelector<HTMLElement>("div[data-style]");
    const style = JSON.parse(card?.dataset.style ?? "{}");
    expect(style.borderColor).toBe("#mock-net");
    expect(card?.getAttribute("role")).toBe("alert");
  });

  it("Retry button works for unavailable state", async () => {
    const onRetry = vi.fn<() => void>();
    await renderCard({
      connection: "unavailable",
      noun: "Tasks",
      onRetry,
    });
    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Retry");
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
