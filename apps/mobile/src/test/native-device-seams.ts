// The RNTL project's device-service seams (#890 W5), registered once for every
// file in `@centraid/mobile-rn` instead of eighty repeated lines per test.
//
// WHY THIS IS A SETUP FILE, NOT A HELPER EACH TEST SPREADS. `vi.mock` calls in
// a Vitest setup file register against every test file the project runs, and
// the setup file executes before that file's imports — so a seam declared here
// is in place by the time a component's module graph is evaluated. That timing
// is the whole point: every package below dereferences a native module at
// MODULE scope, so an unmocked one throws on import, long before a renderer
// exists to observe. A per-file `vi.mock` still wins over anything here when a
// test needs a specific device answer.
//
// THE RULE FOR ADDING TO THIS FILE: a DEVICE SERVICE only — a package whose
// implementation is native code the simulator provides and Node cannot. Never
// an application module, never a component under test, never a blueprint
// model. Substituting one of those here would silently hollow out every RNTL
// file at once, and the tests would still be green. `src/`-local modules named
// below are the local Expo native modules (`modules/`), which are device code
// living in this repository, not application logic.
//
// These are DELIBERATELY INERT, not simulated. A seam that answers "nothing
// happened" cannot be mistaken for the device; a test asserting a device
// outcome must say so itself, in its own file, and Maestro owns the rest.

import React from "react";
import { vi } from "vitest";

/** Expo's fetch, used by the gateway and change-feed transports. */
vi.mock("expo/fetch", () => ({ fetch: vi.fn<typeof fetch>() }));

vi.mock("expo-file-system", () => ({
  Directory: vi.fn<() => object>(() => ({})),
  File: vi.fn<() => object>(() => ({})),
  Paths: { cache: { uri: "file:///cache" }, document: { uri: "file:///doc" } },
}));

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: vi.fn<() => Promise<string>>(async () => "digest"),
  getRandomBytes: vi.fn<(n: number) => Uint8Array>((n) =>
    new Uint8Array(n).fill(7)
  ),
  randomUUID: vi.fn<() => string>(() => "00000000-0000-4000-8000-000000000000"),
}));

// The keychain. Its accessibility CONSTANTS are part of the module's surface,
// not just its functions: Locker reads one at call sites, and a seam missing it
// fails on import rather than at the call (#890).
vi.mock("expo-secure-store", () => ({
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: "whenPasscodeSetThisDeviceOnly",
  WHEN_UNLOCKED: "whenUnlocked",
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "whenUnlockedThisDeviceOnly",
  // No biometrics off-device: a test that needs the device-unlock branch says
  // so in its own file rather than inheriting a fake yes from here.
  canUseBiometricAuthentication: vi.fn<() => boolean>(() => false),
  deleteItemAsync: vi.fn<() => Promise<void>>(async () => undefined),
  getItemAsync: vi.fn<() => Promise<string | null>>(async () => null),
  isAvailableAsync: vi.fn<() => Promise<boolean>>(async () => false),
  setItemAsync: vi.fn<() => Promise<void>>(async () => undefined),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn<() => Promise<string | null>>(async () => null),
    multiRemove: vi.fn<() => Promise<void>>(async () => undefined),
    removeItem: vi.fn<() => Promise<void>>(async () => undefined),
    setItem: vi.fn<() => Promise<void>>(async () => undefined),
  },
}));

// The insets are the simulator's; zero is the honest answer off-device, and no
// assertion in this tier may depend on a notch.
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));

// SVG is a native view; the glyph set itself (`@centraid/design`) stays real,
// so an icon name that does not resolve still fails.
vi.mock("react-native-svg", () => {
  const host = (name: string) => {
    const Host = React.forwardRef<unknown, Record<string, unknown>>(
      (props, ref) => React.createElement(name, { ...props, ref })
    );
    Host.displayName = `${name}Seam`;
    return Host;
  };
  return {
    Circle: host("Circle"),
    default: host("Svg"),
    G: host("G"),
    Path: host("Path"),
    Rect: host("Rect"),
    Svg: host("Svg"),
  };
});

// FlashList is a native recycling list. The seam renders EVERY row it is
// handed, in order, with the header/footer/empty slots the real component
// honours — so a list's contents and its empty state are still observable,
// while recycling and measurement remain Maestro's.
vi.mock("@shopify/flash-list", () => {
  interface ListProps {
    ListEmptyComponent?: React.ReactNode;
    ListFooterComponent?: React.ReactNode;
    ListHeaderComponent?: React.ReactNode;
    data?: readonly unknown[];
    keyExtractor?: (item: unknown, index: number) => string;
    renderItem?: (info: { index: number; item: unknown }) => React.ReactNode;
  }
  const FlashList = (props: ListProps) => {
    const data = props.data ?? [];
    return React.createElement(
      "FlashList",
      {},
      props.ListHeaderComponent,
      data.length === 0
        ? props.ListEmptyComponent
        : data.map((item, index) =>
            React.createElement(
              React.Fragment,
              { key: props.keyExtractor?.(item, index) ?? String(index) },
              props.renderItem?.({ index, item })
            )
          ),
      props.ListFooterComponent
    );
  };
  return { FlashList };
});

vi.mock("expo-image", () => ({
  Image: (props: Record<string, unknown>) =>
    React.createElement("ExpoImage", props),
  useImage: () => null,
}));

vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: { Light: "light", Medium: "medium" },
  NotificationFeedbackType: { Success: "success" },
  impactAsync: vi.fn<() => Promise<void>>(async () => undefined),
  notificationAsync: vi.fn<() => Promise<void>>(async () => undefined),
  selectionAsync: vi.fn<() => Promise<void>>(async () => undefined),
}));

vi.mock("expo-clipboard", () => ({
  getStringAsync: vi.fn<() => Promise<string>>(async () => ""),
  setStringAsync: vi.fn<() => Promise<boolean>>(async () => true),
}));

vi.mock("expo-notifications", () => ({
  SchedulableTriggerInputTypes: { DATE: "date" },
  cancelScheduledNotificationAsync: vi.fn<() => Promise<void>>(
    async () => undefined
  ),
  getAllScheduledNotificationsAsync: vi.fn<() => Promise<never[]>>(
    async () => []
  ),
  getPermissionsAsync: vi.fn<() => Promise<object>>(async () => ({
    canAskAgain: false,
    expires: "never",
    granted: false,
    status: "denied",
  })),
  scheduleNotificationAsync: vi.fn<() => Promise<string>>(async () => "notice"),
}));

vi.mock("expo-network", () => ({
  getNetworkStateAsync: vi.fn<() => Promise<object>>(async () => ({
    isConnected: true,
    isInternetReachable: true,
  })),
}));

vi.mock("expo-sharing", () => ({
  isAvailableAsync: vi.fn<() => Promise<boolean>>(async () => false),
  shareAsync: vi.fn<() => Promise<void>>(async () => undefined),
}));

vi.mock("expo-document-picker", () => ({
  getDocumentAsync: vi.fn<() => Promise<object>>(async () => ({
    canceled: true,
  })),
}));

vi.mock("expo-web-browser", () => ({
  openBrowserAsync: vi.fn<() => Promise<object>>(async () => ({
    type: "cancel",
  })),
}));

vi.mock("expo-linking", () => ({
  createURL: vi.fn<(path: string) => string>((path) => `centraid://${path}`),
  openURL: vi.fn<() => Promise<void>>(async () => undefined),
}));

vi.mock("expo-camera", () => ({
  CameraView: (props: Record<string, unknown>) =>
    React.createElement("CameraView", props),
  useCameraPermissions: () => [null, vi.fn<() => Promise<never>>()],
}));

vi.mock("expo-media-library", () => ({
  usePermissions: () => [
    null,
    vi.fn<() => Promise<never>>(),
    vi.fn<() => Promise<never>>(),
  ],
}));

vi.mock("expo-image-manipulator", () => ({
  SaveFormat: { JPEG: "jpeg", PNG: "png" },
  useImageManipulator: () => null,
}));

vi.mock("expo-video", () => ({
  VideoView: (props: Record<string, unknown>) =>
    React.createElement("VideoView", props),
  useVideoPlayer: () => ({ pause: () => undefined, play: () => undefined }),
}));

vi.mock("expo-video-thumbnails", () => ({
  getThumbnailAsync: vi.fn<() => Promise<object>>(async () => ({ uri: "" })),
}));

vi.mock("expo-battery", () => ({
  getPowerStateAsync: vi.fn<() => Promise<object>>(async () => ({
    batteryLevel: 1,
    lowPowerMode: false,
  })),
}));

vi.mock("expo-background-task", () => ({
  BackgroundTaskResult: { Success: 1 },
  registerTaskAsync: vi.fn<() => Promise<void>>(async () => undefined),
  unregisterTaskAsync: vi.fn<() => Promise<void>>(async () => undefined),
}));

vi.mock("expo-task-manager", () => ({
  defineTask: vi.fn<() => void>(),
  isTaskRegisteredAsync: vi.fn<() => Promise<boolean>>(async () => false),
}));

vi.mock("expo-share-intent", () => ({
  useShareIntent: () => ({
    hasShareIntent: false,
    resetShareIntent: vi.fn<() => void>(),
    shareIntent: null,
  }),
}));

// The on-device SQLite engine. A replica read/write in this tier is answered by
// the test's own `useReplicaQuery` seam, never by a fake database.
vi.mock("@op-engineering/op-sqlite", () => ({
  open: vi.fn<() => never>(() => {
    throw new Error(
      "op-sqlite is a device engine: an RNTL test must seam the replica read layer instead"
    );
  }),
}));

vi.mock("react-native-quick-crypto", () => ({
  default: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
}));

// Reanimated's worklets need the UI runtime. The seam runs every worklet on the
// JS thread and resolves animated styles to their target value immediately, so
// a component's settled appearance is observable and its motion is not.
vi.mock("react-native-reanimated", () => ({
  default: {
    Image: "AnimatedImage",
    ScrollView: "AnimatedScrollView",
    Text: "AnimatedText",
    View: "AnimatedView",
  },
  Easing: { inOut: () => undefined, ease: undefined },
  runOnJS:
    <Arguments extends unknown[], Result>(fn: (...a: Arguments) => Result) =>
    (...a: Arguments) =>
      fn(...a),
  useAnimatedStyle: (build: () => unknown) => build(),
  useSharedValue: <Value>(value: Value) => ({ value }),
  withSpring: <Value>(value: Value) => value,
  withTiming: <Value>(value: Value) => value,
}));

// Gesture Handler's recognizers ARE the device claim; RNTL cannot arbitrate
// them and Maestro owns them (TESTING.md). The seam keeps the builder chain
// callable and renders children, so a screen using it still mounts.
vi.mock("react-native-gesture-handler", () => {
  const chainable = (): Record<string, unknown> => {
    const chain: Record<string, unknown> = {};
    for (const method of [
      "activateAfterLongPress",
      "activeOffsetX",
      "activeOffsetY",
      "enabled",
      "failOffsetX",
      "failOffsetY",
      "maxDistance",
      "maxDuration",
      "minDistance",
      "numberOfTaps",
      "onBegin",
      "onEnd",
      "onFinalize",
      "onStart",
      "onUpdate",
      "runOnJS",
      "shouldCancelWhenOutside",
      "simultaneousWithExternalGesture",
    ])
      chain[method] = () => chain;
    return chain;
  };
  const passthrough = ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  return {
    Gesture: {
      Exclusive: chainable,
      LongPress: chainable,
      Pan: chainable,
      Pinch: chainable,
      Race: chainable,
      Simultaneous: chainable,
      Tap: chainable,
    },
    GestureDetector: passthrough,
    GestureHandlerRootView: passthrough,
  };
});

vi.mock("@react-native-community/datetimepicker", () => ({
  default: (props: Record<string, unknown>) =>
    React.createElement("DateTimePicker", props),
}));

// The map SDKs are native renderers with no JS fallback of any kind. Nothing in
// this tier may claim a map fact; place geography is a Maestro claim.
vi.mock("@maplibre/maplibre-react-native", () => ({
  Camera: (props: Record<string, unknown>) =>
    React.createElement("MapCamera", props),
  MapView: (props: Record<string, unknown>) =>
    React.createElement("MapView", props),
  MarkerView: (props: Record<string, unknown>) =>
    React.createElement("MarkerView", props),
  ShapeSource: (props: Record<string, unknown>) =>
    React.createElement("ShapeSource", props),
}));

vi.mock("expo-maps", () => ({
  AppleMaps: {
    View: (props: Record<string, unknown>) =>
      React.createElement("AppleMaps", props),
  },
  GoogleMaps: {
    View: (props: Record<string, unknown>) =>
      React.createElement("GoogleMaps", props),
  },
}));

// This repository's own Expo native modules under `modules/` — device code that
// happens to live in-tree, so they seam here rather than in each test file.
vi.mock("../../modules/centraid-storage", () => ({
  nativeDirectorySize: vi.fn<() => number>(() => 0),
  replicaStorageDirectory: vi.fn<() => string | undefined>(() => undefined),
}));
