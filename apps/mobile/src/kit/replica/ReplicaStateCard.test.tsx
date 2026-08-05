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

  it("renders a visible explanation for the offline connection state, not null", async () => {
    // This is the sabotage target: swap `connection: "offline"` back to a
    // path the old `connection !== "unavailable" && !error` guard treated as
    // "nothing to say" and this assertion goes red.
    await renderCard({ connection: "offline", noun: "Notes" });
    expect(container.textContent).toContain("Notes is offline");
    expect(container.textContent?.length).toBeGreaterThan(0);
  });

  it("renders a visible explanation for the unavailable connection state", async () => {
    await renderCard({ connection: "unavailable", noun: "Tasks" });
    expect(container.textContent).toContain("Tasks is not connected");
  });

  it("renders nothing when connected with no error", async () => {
    await renderCard({ connection: "current", noun: "Photos" });
    expect(container.innerHTML).toBe("");
  });

  it("draws the bordered --net block, not a filled icon card", async () => {
    await renderCard({ connection: "offline", noun: "Notes" });
    const card = container.querySelector<HTMLElement>("div[data-style]");
    const style = JSON.parse(card?.dataset.style ?? "{}");
    expect(style.borderColor).toBe("#mock-net");
    expect(style.backgroundColor).toBeUndefined();
  });

  it("renders an outlined Retry, not a filled 'Try again'", async () => {
    const onRetry = vi.fn<() => void>();
    await renderCard({ connection: "offline", noun: "Notes", onRetry });
    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Retry");
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
