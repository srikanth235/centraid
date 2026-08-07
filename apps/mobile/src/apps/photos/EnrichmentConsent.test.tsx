// THE ENRICHMENT CONSENT MOMENT, NATIVE (v4 handoff §8, issue #711).
//
// Two rules are load-bearing, and both were BROKEN on this client before this
// suite existed — this is a privacy regression net, not a styling snapshot:
//
//   1. NO ENRICHMENT WRITE MAY BE ISSUED WITHOUT AN EXPLICIT ANSWER. Library's
//      `Enrichment` row used to call `request-enrichment` straight from its
//      `onPress`: one tap, one write, no panels and no facts. The surface now
//      routes every answer through a callback, and only the `Run on this
//      device` control may reach it.
//   2. THE EGRESS DISCLOSURE MUST BE ON SCREEN. The cloud panel is the only
//      place the product tells a member that a downscaled copy of every
//      photograph would leave the device. It renders even though no cloud
//      helper can be chosen from an app — an unwired action is a stated fact,
//      never a reason to drop a disclosure.
//
// The assertions read the rendered tree (through mocked primitives), not the
// source text, so a rename or a restyle cannot fake them. The copy itself is
// asserted against the SHARED module the web client renders, so the two
// surfaces cannot drift on a promise about a member's photographs.

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CLOUD_ANSWER,
  CLOUD_EGRESS_DISCLOSURE,
  CLOUD_PANEL,
  deviceAnswerFor,
  ENRICHMENT_NOTE,
  ENRICHMENT_STATUS_LINE,
  ENRICHMENT_UNAVAILABLE,
  ON_DEVICE_PANEL,
  onDeviceTitle,
} from "@centraid/blueprints/apps/photos/enrichment-consent";

// @vitest-environment jsdom
import EnrichmentConsent from "./EnrichmentConsent";

type ReactNative = typeof import("react-native");
type SafeAreaContext = typeof import("react-native-safe-area-context");
type ThemeModule = typeof import("../../kit/theme");
type NativeTextModule = typeof import("../../kit/components/NativeText");
type IconModule = typeof import("../../kit/components/Icon");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  colors: {
    accentFill: "#mock-accent-fill",
    bg: "#mock-bg",
    bgElev: "#mock-bg-elev",
    bgSunken: "#mock-bg-sunken",
    line: "#mock-line",
    net: "#mock-net",
    text: "#mock-text",
    textDisabled: "#mock-text-disabled",
    textFaint: "#mock-text-faint",
    textInv: "#mock-text-inv",
    textSoft: "#mock-text-soft",
  },
}));

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
          // The mock deliberately does NOT swallow the press when `disabled`
          // is set: a control that still carries a live handler behind a
          // disabled flag is exactly the regression worth catching.
          disabled: undefined,
          "data-disabled": disabled ? "true" : "false",
          onClick: onPress,
          role: accessibilityRole,
          type: "button",
        },
        children
      ),
    ScrollView: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement("main", null, children),
    StyleSheet: {
      create: <T,>(styles: T): T => styles,
    },
    // A `borderLeftColor` in the (possibly array) style becomes `data-rule`,
    // so the egress flag can be inspected in the rendered tree rather than
    // trusted from the source.
    View: ({
      children,
      style,
    }: {
      children?: React.ReactNode;
      style?: unknown;
    }) => {
      const flat = flattenStyle(style);
      const rule = flat.borderLeftColor;
      const border = flat.borderColor;
      return ReactModule.createElement(
        "div",
        {
          ...(typeof border === "string" ? { "data-border": border } : {}),
          ...(typeof rule === "string" ? { "data-rule": rule } : {}),
        },
        children
      );
    },
  } as unknown as Partial<ReactNative>;
});

vi.mock(import("react-native-safe-area-context"), async () => {
  const ReactModule = await import("react");
  return {
    SafeAreaView: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement("section", null, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  } as unknown as Partial<SafeAreaContext>;
});

vi.mock(import("../../kit/components/NativeText"), async () => {
  const ReactModule = await import("react");
  return {
    Text: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement("span", null, children),
  } as unknown as Partial<NativeTextModule>;
});

vi.mock(import("../../kit/components/Icon"), async () => {
  const ReactModule = await import("react");
  return {
    default: () => ReactModule.createElement("i", null),
  } as unknown as IconModule;
});

vi.mock(
  import("../../kit/theme"),
  () =>
    ({
      borders: { hairline: 1 },
      spacing: [0, 4, 8, 12, 16, 20, 24],
      t: () => ({}),
      useTheme: () => ({ colors: mocks.colors, scheme: "light" }),
    }) as unknown as Partial<ThemeModule>
);

describe("the native enrichment consent surface", () => {
  let host: HTMLDivElement;
  let root: Root;
  const onRunOnDevice = vi.fn<() => void>();
  const onDecline = vi.fn<() => void>();
  const onChooseCloud = vi.fn<() => void>();

  beforeEach(() => {
    onRunOnDevice.mockClear();
    onDecline.mockClear();
    onChooseCloud.mockClear();
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
        React.createElement(EnrichmentConsent, {
          cloud: CLOUD_ANSWER,
          count: 6214,
          onClose: () => undefined,
          onDecline,
          onDevice: { available: true },
          onRunOnDevice,
          ...props,
        } as React.ComponentProps<typeof EnrichmentConsent>)
      );
    });
  }

  function control(label: string): HTMLButtonElement {
    const button = [...host.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === label
    );
    expect(button, `no control labelled ${label}`).toBeTruthy();
    return button as HTMLButtonElement;
  }

  it("asks the question over the live count, before anything runs", () => {
    render();
    expect(host.textContent).toContain(
      "Run face detection over 6,214 photographs?"
    );
    expect(host.textContent).toContain(ON_DEVICE_PANEL.body);
    expect(host.textContent).toContain(ENRICHMENT_STATUS_LINE);
    expect(onRunOnDevice).not.toHaveBeenCalled();
  });

  it("states all nine facts", () => {
    render();
    for (const fact of [...ON_DEVICE_PANEL.facts, ...CLOUD_PANEL.facts]) {
      expect(host.textContent).toContain(fact.label);
      expect(host.textContent).toContain(fact.value);
    }
  });

  it("carries the egress disclosure, flagged with the net rule", () => {
    render();
    // THE line. Its absence is the defect this file exists to catch.
    expect(host.textContent).toContain(CLOUD_EGRESS_DISCLOSURE);
    expect(host.textContent).toContain("a downscaled copy of every photograph");
    const flagged = [
      ...host.querySelectorAll<HTMLElement>("[data-rule]"),
    ].filter((el) => el.dataset.rule === mocks.colors.net);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.textContent).toContain(CLOUD_EGRESS_DISCLOSURE);
    // The whole cloud panel is bordered in `net` — the panel IS the
    // disclosure, so the mark belongs to the box.
    expect(
      [...host.querySelectorAll<HTMLElement>("[data-border]")].some(
        (el) => el.dataset.border === mocks.colors.net
      )
    ).toBe(true);
  });

  it("renders the cloud panel even though no helper can be chosen", () => {
    render();
    const cloud = control(CLOUD_PANEL.action);
    expect(cloud.dataset.disabled).toBe("true");
    expect(host.textContent).toContain(ENRICHMENT_UNAVAILABLE.cloudUnavailable);
    // Unavailable means it CANNOT FIRE, not merely that it looks grey.
    cloud.click();
    expect(onRunOnDevice).not.toHaveBeenCalled();
    expect(onChooseCloud).not.toHaveBeenCalled();
  });

  it("says it is not a settings toggle", () => {
    render();
    expect(host.textContent).toContain(ENRICHMENT_NOTE);
    expect(host.textContent).toContain(
      "This is not a settings toggle. It is asked once, answered once, and receipted — and the answer is visible in Privacy afterwards."
    );
  });

  it("runs only from the explicit on-device answer", () => {
    render();
    expect(onRunOnDevice).not.toHaveBeenCalled();
    act(() => control(ON_DEVICE_PANEL.action).click());
    expect(onRunOnDevice).toHaveBeenCalledOnce();
    expect(onDecline).not.toHaveBeenCalled();
  });

  it("declining answers without running anything", () => {
    render();
    act(() => control(ON_DEVICE_PANEL.action2 ?? "Not now").click());
    expect(onDecline).toHaveBeenCalledOnce();
    expect(onRunOnDevice).not.toHaveBeenCalled();
  });

  it("cannot be answered once the vault's tier will not honour it", () => {
    render({ onDevice: deviceAnswerFor("gateway") });
    expect(host.textContent).toContain(ENRICHMENT_UNAVAILABLE.modelTier);
    const run = control(ON_DEVICE_PANEL.action);
    expect(run.dataset.disabled).toBe("true");
    run.click();
    expect(onRunOnDevice).not.toHaveBeenCalled();
  });

  it("cannot be answered twice", () => {
    render({ answered: "device" });
    const run = control(ON_DEVICE_PANEL.action);
    expect(run.dataset.disabled).toBe("true");
    run.click();
    expect(onRunOnDevice).not.toHaveBeenCalled();
  });

  it("asks about `these photographs` rather than inventing a count", () => {
    render({ count: null });
    expect(host.textContent).toContain(
      "Run face detection over these photographs?"
    );
    expect(onDeviceTitle(1)).toBe("Run face detection over 1 photograph?");
  });
});
