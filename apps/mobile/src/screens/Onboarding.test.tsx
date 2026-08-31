import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @vitest-environment jsdom
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
    // The flow sizes its hero against the window and the safe area; a fixed
    // iPhone-sized viewport keeps that arithmetic deterministic here.
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

// The hero art animates. Stub the driver rather than the art itself, so the
// real artwork still renders here and a crash in it fails this suite.
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

// Mocked, not stubbed-around: the real module pulls AsyncStorage in at import
// time, which does not resolve under vitest's jsdom environment.
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
    // Default: a roster that does not name this person yet, so the profile
    // step runs. Individual tests override it.
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

  /**
   * Reveal the pasted-code fallback. Scanning is the primary path, so the code
   * box does not exist until someone asks for it — every paste-based scenario
   * has to open it first, exactly as a person would.
   */
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

  /** Paste a pair ticket and land on the profile step. */
  async function pairWithPastedTicket(deviceName?: string): Promise<void> {
    if (deviceName !== undefined)
      typeValue(container!.querySelector("input")!, deviceName);
    revealPasteFallback();
    typeValue(ticketInput(), "pair-ticket");
    click(button("Connect"));
    await flush();
    expect(container!.textContent).toContain("Who's using");
  }

  /** Paste a pair ticket without asserting which step it lands on. */
  async function pasteTicket(): Promise<void> {
    revealPasteFallback();
    typeValue(ticketInput(), "pair-ticket");
    click(button("Connect"));
    await flush();
  }

  describe("naming an already-known person", () => {
    // Self-pairing a second device is the common case: the household roster
    // already carries the name. Asking again would be a second chance to
    // disagree with yourself, and the answer would overwrite the roster.
    it("skips the profile step when the roster already names this person", async () => {
      mocks.readSelfMemberName.mockResolvedValue("Ada Lovelace");
      await pasteTicket();
      expect(container!.textContent).not.toContain("Who's using");
      expect(container!.textContent).toContain("You're all set, Ada");
      // The roster's name is adopted, not re-asked and not re-written to it.
      expect(mocks.setProfileName).toHaveBeenCalledWith("Ada Lovelace");
      expect(mocks.setOnboarded).toHaveBeenCalledWith(true);
    });

    it("still asks when the roster carries only the placeholder", async () => {
      mocks.readSelfMemberName.mockResolvedValue("");
      await pasteTicket();
      expect(container!.textContent).toContain("Who's using");
    });

    // A failed read is not evidence of a name. Asking is the safe branch:
    // the worst case is one redundant question, not a silently wrong identity.
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

      // Name is required — an empty profile cannot be saved.
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

    // Scanning is the way in; pasting a ticket is the fallback for when it
    // cannot work. The screen has to say so by what it shows, not only by what
    // it calls things — a permanent code box outweighs any button label.
    it("offers scanning first and keeps the code box out of the way", () => {
      expect(button("Scan the QR code")).toBeTruthy();
      expect(queryTicketInput()).toBeNull();
      expect(container!.textContent).not.toContain("PAIRING CODE");

      revealPasteFallback();
      expect(ticketInput()).toBeTruthy();
      expect(container!.textContent).toContain("PAIRING CODE");

      // …and the way back to the primary path stays open.
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

    it("reports a pairing failure, drops the capability, and accepts a fresh ticket", async () => {
      mocks.pair.mockRejectedValueOnce(new Error("gateway refused the ticket"));
      revealPasteFallback();
      typeValue(ticketInput(), "pair-ticket");
      click(button("Connect"));
      await flush();

      expect(container!.textContent).toContain("gateway refused the ticket");
      // Redemption may have consumed a one-time capability even when the
      // response was lost. Never retain or silently replay it after failure.
      expect(container!.textContent).toContain("PAIRING CODE");
      expect(ticketInput().value).toBe("");
      expect(mocks.setOnboarded).not.toHaveBeenCalled();

      typeValue(ticketInput(), "fresh-pair-ticket");
      click(button("Connect"));
      await flush();
      expect(mocks.pair).toHaveBeenLastCalledWith(
        "fresh-pair-ticket",
        "iPhone"
      );
      expect(container!.textContent).toContain("Who's using");
    });
  });
});
