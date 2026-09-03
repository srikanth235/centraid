// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";

import Onboarding from "./Onboarding";

type ExpoCamera = typeof import("expo-camera");
type ExpoHaptics = typeof import("expo-haptics");
type ReactNative = typeof import("react-native");
type SafeAreaContext = typeof import("react-native-safe-area-context");
type ReactNativeSvg = typeof import("react-native-svg");
type ThemeModule = typeof import("../kit/theme");
type GatewayModule = typeof import("../lib/gateway");
type PhoneLinkModule = typeof import("../lib/phone-link");
type ProfileModule = typeof import("../lib/profile");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  notificationAsync: vi.fn<(type?: unknown) => Promise<void>>(),
  onDone: vi.fn<() => void>(),
  readSelfMemberName: vi.fn<() => Promise<string | undefined>>(),
  pair: vi.fn<
    (
      ticket: string,
      deviceName: string
    ) => Promise<{ desktopName: string; deviceId: string }>
  >(),
  requestPermission: vi.fn<() => Promise<unknown>>(),
  setOnboarded: vi.fn<(value: boolean) => void>(),
  setProfileColor: vi.fn<(value: string) => void>(),
  setProfileName: vi.fn<(value: string) => void>(),
}));

vi.mock(import("react-native"), async () => {
  const ReactModule = await import("react");
  const element = (
    tag: string,
    props: Record<string, unknown> & { children?: React.ReactNode } = {}
  ): React.JSX.Element => {
    const { children, style: _style, ...rest } = props;
    return ReactModule.createElement(tag, rest, children);
  };
  return {
    Platform: { OS: "ios" },
    Pressable: ({
      accessibilityLabel,
      accessibilityRole,
      accessibilityState,
      children,
      disabled,
      onPress,
      style,
    }: {
      accessibilityLabel?: string;
      accessibilityRole?: string;
      accessibilityState?: { checked?: boolean; selected?: boolean };
      children?: React.ReactNode;
      disabled?: boolean;
      onPress?: () => void;
      style?: unknown;
    }) =>
      element("button", {
        "aria-checked": accessibilityState?.checked,
        "aria-label": accessibilityLabel,
        "aria-selected": accessibilityState?.selected,
        children,
        disabled,
        onClick: onPress,
        role: accessibilityRole,
        style: typeof style === "function" ? undefined : style,
        type: "button",
      }),
    ScrollView: ({ children }: { children?: React.ReactNode }) =>
      element("main", { children }),
    StyleSheet: {
      absoluteFill: {},
      create: <T,>(styles: T): T => styles,
    },
    Text: ({ children }: { children?: React.ReactNode }) =>
      element("span", { children }),
    TextInput: ({
      autoCapitalize: _autoCapitalize,
      autoCorrect: _autoCorrect,
      multiline,
      onChangeText,
      onSubmitEditing: _onSubmitEditing,
      placeholderTextColor: _placeholderTextColor,
      returnKeyType: _returnKeyType,
      secureTextEntry,
      textAlignVertical: _textAlignVertical,
      ...props
    }: {
      multiline?: boolean;
      onChangeText?: (value: string) => void;
      secureTextEntry?: boolean;
      [key: string]: unknown;
    }) =>
      element(multiline ? "textarea" : "input", {
        ...props,
        onChange: (
          event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
        ) =>
          onChangeText?.(
            (event.target as HTMLInputElement | HTMLTextAreaElement).value
          ),
        type: !multiline && secureTextEntry ? "password" : undefined,
      }),
    View: ({ children }: { children?: React.ReactNode }) =>
      element("div", { children }),
    useWindowDimensions: () => ({ height: 874, scale: 3, width: 402 }),
  } as unknown as Partial<ReactNative>;
});

vi.mock(import("react-native-safe-area-context"), async () => {
  const ReactModule = await import("react");
  return {
    SafeAreaView: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement("section", null, children),
    useSafeAreaInsets: () => ({ bottom: 34, left: 0, right: 0, top: 59 }),
  } as unknown as Partial<SafeAreaContext>;
});

vi.mock(import("react-native-reanimated"), async () => {
  const identity = <T,>(value: T): T => value;
  return {
    createAnimatedComponent: identity,
    default: { createAnimatedComponent: identity },
    Easing: {
      cubic: identity,
      linear: identity,
      out: identity,
    },
    interpolate: (_value: number, _input: number[], output: number[]) =>
      output[output.length - 1],
    useAnimatedProps: (build: () => unknown) => build(),
    useReducedMotion: () => false,
    useSharedValue: (value: number) => ({ value }),
    withDelay: (_delay: number, animation: unknown) => animation,
    withRepeat: (animation: unknown) => animation,
    withTiming: (value: number) => value,
  } as unknown as typeof import("react-native-reanimated");
});

vi.mock(import("react-native-svg"), async () => {
  const ReactModule = await import("react");
  const component = (tag: string) => {
    const SvgMock = ({
      children,
    }: {
      children?: React.ReactNode;
    }): React.JSX.Element => ReactModule.createElement(tag, null, children);
    SvgMock.displayName = `SvgMock(${tag})`;
    return SvgMock;
  };
  return {
    default: component("svg"),
    Circle: component("circle"),
    Defs: component("defs"),
    Ellipse: component("ellipse"),
    G: component("g"),
    Line: component("line"),
    LinearGradient: component("linearGradient"),
    Path: component("path"),
    RadialGradient: component("radialGradient"),
    Rect: component("rect"),
    Stop: component("stop"),
  } as unknown as Partial<ReactNativeSvg>;
});

vi.mock(import("expo-camera"), async () => {
  const ReactModule = await import("react");
  return {
    CameraView: ({
      onBarcodeScanned,
    }: {
      onBarcodeScanned: (event: { data: string }) => void;
    }) =>
      ReactModule.createElement(
        "button",
        {
          "data-testid": "camera",
          onClick: () => onBarcodeScanned({ data: "ticket-from-camera" }),
          type: "button",
        },
        "camera"
      ),
    useCameraPermissions: () =>
      [{ canAskAgain: true, granted: true }, mocks.requestPermission] as const,
  } as unknown as Partial<ExpoCamera>;
});

vi.mock(
  import("expo-haptics"),
  () =>
    ({
      NotificationFeedbackType: { Success: "success" },
      notificationAsync: mocks.notificationAsync,
    }) as unknown as Partial<ExpoHaptics>
);

vi.mock(
  import("../kit/theme"),
  () =>
    ({
      borders: { hairline: 1 },
      family: {
        monoMedium: "mono-medium",
        monoRegular: "mono",
        sansBold: "sans-bold",
        sansMedium: "sans-medium",
        sansRegular: "sans",
      },
      radii: { lg: 12, md: 8, pill: 999, sm: 4, xl: 16, xs: 0 },
      t: () => ({}),
    }) as unknown as Partial<ThemeModule>
);

vi.mock(
  import("../lib/profile"),
  () =>
    ({
      BRAND: "#22a78f",
      PROFILE_COLORS: ["#22a78f", "#4e68dd", "#e55772"],
      initialsOf: (name: string) =>
        name.trim() ? name.trim().slice(0, 1).toUpperCase() : "·",
      setOnboarded: mocks.setOnboarded,
      setProfileColor: mocks.setProfileColor,
      setProfileName: mocks.setProfileName,
    }) as unknown as Partial<ProfileModule>
);

vi.mock(
  import("../lib/gateway"),
  () =>
    ({
      readSelfMemberName: mocks.readSelfMemberName,
    }) as unknown as Partial<GatewayModule>
);

vi.mock(
  import("../lib/phone-link"),
  () =>
    ({
      isTunnelAvailable: () => true,
      pair: mocks.pair,
    }) as unknown as Partial<PhoneLinkModule>
);

let root: Root | undefined;
let container: HTMLDivElement | undefined;

describe("Onboarding scenarios", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.notificationAsync.mockResolvedValue(undefined);
    mocks.pair.mockResolvedValue({
      desktopName: "Gateway",
      deviceId: "device-1",
    });
    mocks.readSelfMemberName.mockResolvedValue("");
    container = document.createElement("div");
    document.body.appendChild(container);
    const handleDone = mocks.onDone;
    act(() => {
      root = createRoot(container!);
      root.render(<Onboarding onDone={handleDone} />);
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  function button(label: string): HTMLButtonElement {
    const match = Array.from(container!.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.includes(label)
    );
    if (!match) throw new Error(`button not found: ${label}`);
    return match;
  }

  function swatch(hex: string): HTMLButtonElement {
    const match = container!.querySelector<HTMLButtonElement>(
      `button[aria-label="Colour ${hex}"]`
    );
    if (!match) throw new Error(`swatch not found: ${hex}`);
    return match;
  }

  function click(target: Element): void {
    void act(() =>
      target.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
  }

  function typeValue(
    target: HTMLInputElement | HTMLTextAreaElement,
    value: string
  ): void {
    const prototype =
      target instanceof HTMLTextAreaElement
        ? globalThis.HTMLTextAreaElement.prototype
        : globalThis.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    act(() => {
      setter?.call(target, value);
      target.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function flush(times = 4): Promise<void> {
    await forEachSequentially(Array.from({ length: times }), async () => {
      await act(async () => {
        await Promise.resolve();
      });
    });
  }

  function revealPasteFallback(): void {
    click(button("Can't scan? Paste a code instead"));
  }

  function queryTicketInput(): HTMLInputElement | null {
    return container!.querySelector<HTMLInputElement>(
      'input[placeholder="Paste the one-line ticket"]'
    );
  }

  function ticketInput(): HTMLInputElement {
    const input = queryTicketInput();
    if (!input) throw new Error("one-line pairing ticket input not found");
    return input;
  }

  async function pairWithPastedTicket(deviceName?: string): Promise<void> {
    if (deviceName !== undefined)
      typeValue(container!.querySelector("input")!, deviceName);
    revealPasteFallback();
    typeValue(ticketInput(), "pair-ticket");
    click(button("Connect"));
    await flush();
    expect(container!.textContent).toContain("Who's using");
  }

  async function pasteTicket(): Promise<void> {
    revealPasteFallback();
    typeValue(ticketInput(), "pair-ticket");
    click(button("Connect"));
    await flush();
  }

  describe("naming an already-known person", () => {
    it("skips the profile step when the roster already names this person", async () => {
      mocks.readSelfMemberName.mockResolvedValue("Ada Lovelace");
      await pasteTicket();
      expect(container!.textContent).not.toContain("Who's using");
      expect(container!.textContent).toContain("You're all set, Ada");
      expect(mocks.setProfileName).toHaveBeenCalledWith("Ada Lovelace");
      expect(mocks.setOnboarded).toHaveBeenCalledWith(true);
    });

    it("still asks when the roster carries only the placeholder", async () => {
      mocks.readSelfMemberName.mockResolvedValue("");
      await pasteTicket();
      expect(container!.textContent).toContain("Who's using");
    });

    it("still asks when the roster could not be read", async () => {
      mocks.readSelfMemberName.mockResolvedValue(undefined);
      await pasteTicket();
      expect(container!.textContent).toContain("Who's using");
    });
  });

  describe("mobile ticket-only onboarding", () => {
    it("pairs from a pasted ticket, then persists the profile from the unified step", async () => {
      await pairWithPastedTicket("Ada Phone");
      expect(mocks.pair).toHaveBeenCalledWith("pair-ticket", "Ada Phone");

      click(button("Continue"));
      expect(mocks.setProfileName).not.toHaveBeenCalled();
      expect(container!.textContent).toContain("Enter a name");

      typeValue(container!.querySelector("input")!, "  Ada Lovelace  ");
      click(swatch("#e55772"));
      click(button("Continue"));

      expect(mocks.setProfileName).toHaveBeenCalledWith("Ada Lovelace");
      expect(mocks.setProfileColor).toHaveBeenCalledWith("#e55772");
      expect(mocks.setOnboarded).toHaveBeenCalledWith(true);
      expect(container!.textContent).toContain("You're all set, Ada");

      click(button("Enter Centraid"));
      expect(mocks.notificationAsync).toHaveBeenCalledWith("success");
      expect(mocks.onDone).toHaveBeenCalledOnce();
    });

    it("defaults the profile colour to the brand teal when no swatch is tapped", async () => {
      await pairWithPastedTicket();
      typeValue(container!.querySelector("input")!, "Grace");
      click(button("Continue"));

      expect(mocks.pair).toHaveBeenCalledWith("pair-ticket", "iPhone");
      expect(mocks.setProfileColor).toHaveBeenCalledWith("#22a78f");
      expect(mocks.setProfileName).toHaveBeenCalledWith("Grace");
    });

    it("offers scanning first and keeps the code box out of the way", () => {
      expect(button("Scan the QR code")).toBeTruthy();
      expect(queryTicketInput()).toBeNull();
      expect(container!.textContent).not.toContain("PAIRING CODE");

      revealPasteFallback();
      expect(ticketInput()).toBeTruthy();
      expect(container!.textContent).toContain("PAIRING CODE");

      click(button("Scan the QR code instead"));
      expect(queryTicketInput()).toBeNull();
    });

    it("scans a pair ticket through the camera path", async () => {
      click(button("Scan the QR code"));
      expect(container!.textContent).toContain("Point at the code");
      click(container!.querySelector('[data-testid="camera"]')!);
      await flush();

      expect(mocks.pair).toHaveBeenCalledWith("ticket-from-camera", "iPhone");
      expect(container!.textContent).toContain("Who's using");
    });

    it("reports a pairing failure honestly and allows a retry", async () => {
      mocks.pair.mockRejectedValueOnce(new Error("gateway refused the ticket"));
      revealPasteFallback();
      typeValue(ticketInput(), "pair-ticket");
      click(button("Connect"));
      await flush();

      expect(container!.textContent).toContain("gateway refused the ticket");
      expect(container!.textContent).toContain("PAIRING CODE");
      expect(mocks.setOnboarded).not.toHaveBeenCalled();

      click(button("Connect"));
      await flush();
      expect(container!.textContent).toContain("Who's using");
    });
  });
});
