// THE PEOPLE SHELF'S EMPTY STATE, NATIVE (ruled 2026-09-09). Replaces the
// enrichment-consent net: that surface lied, since recognition is ambient.
// Three rules are load-bearing and all three are cheap to break:
//   1. SIGNAGE, NOT A QUESTION — it names the recipe and the switch under
//      Automations → Recognition, and offers no answer.
//   2. NO WRITE WITHOUT AN EXPLICIT PRESS, never from an inert control.
//   3. AN INERT ACTION STATES WHY, BESIDE ITSELF.
// Assertions read the rendered tree, not the source text; the copy is asserted
// against the SHARED module the web client renders, so the two cannot drift.

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CLOUD_EGRESS_DISCLOSURE,
  ENRICHMENT_STATUS_LINE,
  ENRICHMENT_UNAVAILABLE,
  PEOPLE_EMPTY_LINE,
  PRIORITISE_ACTION,
  prioritiseAnswerFor,
} from "@centraid/blueprints/apps/photos/enrichment-consent";

// @vitest-environment jsdom
import PeopleEmptyState from "./PeopleEmptyState";

type ReactNative = typeof import("react-native");
type ThemeModule = typeof import("../../kit/theme");
type NativeTextModule = typeof import("../../kit/components/NativeText");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  colors: {
    line: "#mock-line",
    net: "#mock-net",
    text: "#mock-text",
    textDisabled: "#mock-text-disabled",
    textFaint: "#mock-text-faint",
    textSoft: "#mock-text-soft",
  },
}));

vi.mock(import("react-native"), async () => {
  const ReactModule = await import("react");
  return {
    Pressable: ({
      accessibilityLabel,
      accessibilityRole,
      accessibilityState,
      children,
      disabled,
      onPress,
    }: {
      accessibilityLabel?: string;
      accessibilityRole?: string;
      accessibilityState?: { disabled?: boolean };
      children?: React.ReactNode;
      disabled?: boolean;
      onPress?: () => void;
    }) =>
      ReactModule.createElement(
        "button",
        {
          "aria-disabled": accessibilityState?.disabled ? "true" : undefined,
          "aria-label": accessibilityLabel,
          // The mock does NOT swallow the press when `disabled` is set: a
          // live handler behind a disabled flag is the regression to catch.
          disabled: undefined,
          "data-disabled": disabled ? "true" : "false",
          onClick: onPress,
          role: accessibilityRole,
          type: "button",
        },
        children
      ),
    StyleSheet: { create: <T,>(styles: T): T => styles },
    View: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement("div", null, children),
  } as unknown as Partial<ReactNative>;
});

vi.mock(import("../../kit/components/NativeText"), async () => {
  const ReactModule = await import("react");
  return {
    Text: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement("span", null, children),
  } as unknown as Partial<NativeTextModule>;
});

vi.mock(
  import("../../kit/theme"),
  () =>
    ({
      borders: { hairline: 1 },
      radii: { lg: 12, md: 8, pill: 999, sm: 4, xl: 16, xs: 0 },
      spacing: [0, 4, 8, 12, 16, 20, 24],
      t: () => ({}),
      useTheme: () => ({ colors: mocks.colors, scheme: "light" }),
    }) as unknown as Partial<ThemeModule>
);

describe("the People shelf's empty state on the phone seat", () => {
  let host: HTMLDivElement;
  let root: Root;
  const onPrioritise = vi.fn<() => void>();

  beforeEach(() => {
    onPrioritise.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function render(props: Record<string, unknown> = {}): void {
    act(() => {
      root.render(
        React.createElement(PeopleEmptyState, {
          onPrioritise,
          prioritise: { available: true },
          ...props,
        } as React.ComponentProps<typeof PeopleEmptyState>)
      );
    });
  }

  function action(): HTMLButtonElement {
    const button = [...host.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === PRIORITISE_ACTION
    );
    expect(button, `no control labelled ${PRIORITISE_ACTION}`).toBeTruthy();
    return button as HTMLButtonElement;
  }

  it("names the recipe and the switch, and nothing it cannot know", () => {
    render();
    expect(host.textContent).toContain(ENRICHMENT_STATUS_LINE);
    expect(host.textContent).toContain(PEOPLE_EMPTY_LINE);
    expect(host.textContent).toContain("Faces recipe");
    expect(host.textContent).toContain("Automations → Recognition");
    expect(onPrioritise).not.toHaveBeenCalled();
  });

  it("asks nothing: no consent panel, no answer, no decline", () => {
    render();
    for (const gone of [
      "Run face detection",
      "Not now",
      "what leaves the device",
      "asked once",
      CLOUD_EGRESS_DISCLOSURE,
    ])
      expect(host.textContent).not.toContain(gone);
    expect(host.querySelectorAll("button")).toHaveLength(1);
  });

  it("fires the priority ask only from an explicit press", () => {
    render();
    expect(onPrioritise).not.toHaveBeenCalled();
    act(() => action().click());
    expect(onPrioritise).toHaveBeenCalledOnce();
  });

  it("states WHY it is inert, beside the control, and cannot fire", () => {
    render({ prioritise: prioritiseAnswerFor("device") });
    expect(host.textContent).toContain(ENRICHMENT_UNAVAILABLE.deviceTier);
    const control = action();
    expect(control.dataset.disabled).toBe("true");
    expect(control.getAttribute("aria-disabled")).toBe("true");
    // Inert means it CANNOT FIRE, not that it looks grey.
    control.click();
    expect(onPrioritise).not.toHaveBeenCalled();
  });

  it("keeps `off` inert with the tier named as the reason", () => {
    render({ prioritise: prioritiseAnswerFor("off") });
    expect(host.textContent).toContain(ENRICHMENT_UNAVAILABLE.offTier);
    action().click();
    expect(onPrioritise).not.toHaveBeenCalled();
  });

  it("cannot be asked twice, nor while a write is in flight", () => {
    render({ prioritised: true });
    action().click();
    expect(onPrioritise).not.toHaveBeenCalled();
    render({ busy: true });
    action().click();
    expect(onPrioritise).not.toHaveBeenCalled();
  });
});
