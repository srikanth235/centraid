// THE CAPTURE-TIME OCR CONSENT GATE (issue #712 C3) — the second instance of
// the §8 consent gate, after Photos' face detection.
//
// Scan.tsx used to call `extract()` unconditionally the moment a photograph
// was captured or chosen: no consent moment existed at all. This file pins
// the moment that closes that gap:
//
//   1. THE GATE SHOWS BEFORE THE FIRST EXTRACTION on a device that has
//      never answered — `recognizeText` must not be called until the
//      question is answered.
//   2. DECLINING STILL SAVES THE SCAN. The destination flow appears with no
//      extracted text and a stated inline explanation, never a dead field.
//   3. THE ON-DEVICE ANSWER TRIGGERS EXTRACTION, and latches so the gate
//      does not return on a later render.
//
// Every dependency outside the gate itself (camera, replica, uploads,
// receipt parsing) is stubbed — this file is about the consent wiring, not
// about scanning or saving.
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @vitest-environment jsdom
import ScanScreen from "./Scan";

type ReactNative = typeof import("react-native");
type SafeAreaContext = typeof import("react-native-safe-area-context");
type ExpoCamera = typeof import("expo-camera");
type ExpoFileSystem = typeof import("expo-file-system");
type OcrModule = typeof import("../../modules/centraid-ocr");
type ThemeModule = typeof import("../kit/theme");
type NativeTextModule = typeof import("../kit/components/NativeText");
type IconModule = typeof import("../kit/components/Icon");
type ReplicaProviderModule = typeof import("../kit/replica/ReplicaProvider");
type UseReplicaQueryModule = typeof import("../kit/hooks/useReplicaQuery");
type WriteOutcomeModule = typeof import("../kit/replica/write-outcome");
type StatusLineModule = typeof import("../kit/components/status-line");
type GatewayModule = typeof import("../lib/gateway");
type MediaProducerModule = typeof import("../lib/upload/media-producer");
type StorageModule = typeof import("../storage");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  colors: {
    accent: "#mock-accent",
    accentFill: "#mock-accent-fill",
    bg: "#mock-bg",
    bgElev: "#mock-bg-elev",
    bgSunken: "#mock-bg-sunken",
    danger: "#mock-danger",
    line: "#mock-line",
    lineStrong: "#mock-line-strong",
    net: "#mock-net",
    text: "#mock-text",
    textDisabled: "#mock-text-disabled",
    textFaint: "#mock-text-faint",
    textInv: "#mock-text-inv",
    textSoft: "#mock-text-soft",
  },
  recognizeText: vi.fn<(uri: string) => Promise<unknown>>(async () => ({
    text: "Merchant\n10.00",
    confidence: 0.95,
    engine: "apple-vision",
    lines: [],
  })),
  // The latch's own durable store — mirrors transfer-consent.test.ts /
  // scan-consent.test.ts's stand-in, shared across this file's tests so the
  // real `scan-consent.ts` module (not mocked — its own suite covers it) can
  // be exercised through Scan.tsx unmodified.
  storeCache: new Map<string, unknown>(),
}));

vi.mock(import("react-native"), async () => {
  const ReactModule = await import("react");
  const element = (
    tag: string,
    props: Record<string, unknown> & { children?: React.ReactNode } = {}
  ): React.JSX.Element => {
    const { children, ...rest } = props;
    return ReactModule.createElement(tag, rest, children);
  };
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
      element("button", {
        "aria-disabled": accessibilityState?.disabled ? "true" : undefined,
        "aria-label": accessibilityLabel,
        children,
        disabled,
        onClick: onPress,
        role: accessibilityRole,
        type: "button",
      }),
    ScrollView: ({ children }: { children?: React.ReactNode }) =>
      element("main", { children }),
    StyleSheet: { absoluteFill: {}, create: <T,>(styles: T): T => styles },
    View: ({ children }: { children?: React.ReactNode }) =>
      element("div", { children }),
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

vi.mock(
  import("expo-camera"),
  () =>
    ({
      CameraView: () => null,
      useCameraPermissions: () => [{ granted: false }, vi.fn<() => void>()],
    }) as unknown as Partial<ExpoCamera>
);

vi.mock(
  import("expo-file-system"),
  () =>
    ({
      File: class {
        constructor(_uri: string) {}
        async bytes() {
          return new Uint8Array();
        }
      },
    }) as unknown as Partial<ExpoFileSystem>
);

vi.mock(
  import("../../modules/centraid-ocr"),
  () =>
    ({
      recognizeText: mocks.recognizeText,
    }) as unknown as Partial<OcrModule>
);

vi.mock(
  import("../kit/theme"),
  () =>
    ({
      borders: { hairline: 1 },
      family: {
        sansMedium: "mock-sans-medium",
        sansRegular: "mock-sans-regular",
      },
      radii: { lg: 12, md: 8, pill: 999, sm: 4, xl: 16, xs: 0 },
      spacing: Array.from({ length: 8 }, (_, index) => index * 4),
      t: () => ({}),
      useTheme: () => ({ colors: mocks.colors }),
    }) as unknown as Partial<ThemeModule>
);

vi.mock(import("../kit/components/NativeText"), async () => {
  const ReactModule = await import("react");
  return {
    Text: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement("span", null, children),
    // Deliberately ignores every RN-only prop (style arrays, multiline,
    // placeholderTextColor, …) — these tests never assert on a field's
    // rendered value, only that the destination flow renders at all once
    // extraction is answered.
    TextInput: ({ value }: { value?: string }) =>
      ReactModule.createElement("input", {
        readOnly: true,
        value: value ?? "",
      }),
  } as unknown as Partial<NativeTextModule>;
});

vi.mock(import("../kit/components/Icon"), async () => {
  const ReactModule = await import("react");
  return {
    default: () => ReactModule.createElement("i", null),
  } as unknown as IconModule;
});

vi.mock(
  import("../kit/replica/ReplicaProvider"),
  () =>
    ({
      useReplica: () => ({
        gatewayBase: undefined,
        session: undefined,
        vaultId: undefined,
      }),
    }) as unknown as Partial<ReplicaProviderModule>
);

vi.mock(
  import("../kit/hooks/useReplicaQuery"),
  () =>
    ({
      useReplicaQuery: (): { rows: unknown[] } => ({ rows: [] }),
    }) as unknown as Partial<UseReplicaQueryModule>
);

vi.mock(
  import("../kit/replica/write-outcome"),
  () =>
    ({
      surfaceWriteFailure: vi.fn<(error: unknown, title?: string) => void>(),
      surfaceWriteOutcome: () => true,
    }) as unknown as Partial<WriteOutcomeModule>
);

vi.mock(
  import("../kit/components/status-line"),
  () =>
    ({
      postStatus: vi.fn<(text: string, options?: unknown) => void>(),
    }) as unknown as Partial<StatusLineModule>
);

vi.mock(
  import("../lib/gateway"),
  () =>
    ({
      authHeader: () => ({}),
    }) as unknown as Partial<GatewayModule>
);

vi.mock(
  import("../lib/upload/media-producer"),
  () =>
    ({
      backupDeviceMedia: vi.fn<(...args: unknown[]) => Promise<void>>(),
      backupDocument: vi.fn<(...args: unknown[]) => Promise<void>>(),
      backupReceiptExpense: vi.fn<(...args: unknown[]) => Promise<void>>(),
    }) as unknown as Partial<MediaProducerModule>
);

// The latch's real module, with only its AsyncStorage-backed store swapped
// for an in-memory one — same technique scan-consent.test.ts uses.
vi.mock(
  import("../storage"),
  () =>
    ({
      Store: {
        get: <T,>(key: string, fallback: T): T =>
          mocks.storeCache.has(key)
            ? (mocks.storeCache.get(key) as T)
            : fallback,
        hydrate: <T,>(key: string, fallback: T): Promise<T> =>
          Promise.resolve(
            mocks.storeCache.has(key)
              ? (mocks.storeCache.get(key) as T)
              : fallback
          ),
        set: <T,>(key: string, value: T): void => {
          mocks.storeCache.set(key, value);
        },
      },
    }) as unknown as Partial<StorageModule>
);

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function renderScan(): void {
  act(() => {
    root = createRoot(container!);
    root.render(
      <ScanScreen
        navigation={
          {
            goBack: vi.fn<() => void>(),
            navigate: vi.fn<() => void>(),
          } as never
        }
        route={
          {
            params: {
              fileUri: "file:///scan.jpg",
              mediaType: "image/jpeg",
            },
          } as never
        }
      />
    );
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("the capture-time OCR consent gate", () => {
  beforeEach(() => {
    mocks.storeCache.clear();
    mocks.recognizeText.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it("shows the gate before the first extraction, on a device that has never answered", async () => {
    renderScan();
    await flush();
    expect(container!.textContent).toContain("Extract on this phone");
    expect(container!.textContent).toContain("The gateway backstop");
    expect(mocks.recognizeText).not.toHaveBeenCalled();
  });

  it("states the #630 size caps in the backstop panel's facts, disclosed not offered", async () => {
    renderScan();
    await flush();
    expect(container!.textContent).toContain(
      "up to 20 megapixels or 25 MiB per scan"
    );
    expect(container!.textContent).toContain("Not a separate choice");
  });

  it("declining answers the latch, hides the gate, and saves without extracted text", async () => {
    renderScan();
    await flush();
    const decline = Array.from(container!.querySelectorAll("button")).find(
      (button) => button.textContent === "Not now"
    );
    act(() => decline!.click());
    await flush();
    expect(container!.textContent).not.toContain("Extract on this phone");
    expect(mocks.recognizeText).not.toHaveBeenCalled();
    // Stated inline, never a dead control — the destination flow still shows.
    expect(container!.textContent).toContain(
      "Text extraction declined — this scan saves without extracted text."
    );
    expect(container!.textContent).toContain("Docs scan");
  });

  it("the on-device answer triggers extraction and latches so the gate does not return", async () => {
    renderScan();
    await flush();
    const run = Array.from(container!.querySelectorAll("button")).find(
      (button) => button.textContent === "Extract on this phone"
    );
    act(() => run!.click());
    await flush();
    expect(mocks.recognizeText).toHaveBeenCalledExactlyOnceWith(
      "file:///scan.jpg"
    );
    expect(container!.textContent).not.toContain("Extract on this phone");
  });
});
