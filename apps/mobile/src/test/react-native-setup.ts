import { createRequire } from "node:module";
import path from "node:path";

import register from "@babel/register";
import mockRequire from "mock-require";
import React from "react";
import { vi } from "vitest";

// Metro defines this compile-time global for React Native internals.
(globalThis as { __DEV__?: boolean }).__DEV__ = true;
(globalThis as unknown as { window?: typeof globalThis }).window ??= globalThis;
(
  globalThis as { nativeModuleProxy?: Record<string, unknown> }
).nativeModuleProxy = {};
(
  globalThis as { nativeFabricUIManager?: Record<string, unknown> }
).nativeFabricUIManager = {};
(
  globalThis as { IS_REACT_NATIVE_TEST_ENVIRONMENT?: boolean }
).IS_REACT_NATIVE_TEST_ENVIRONMENT = true;

// Metro evaluates React Native's Flow-annotated source after applying the Expo
// preset. Vitest executes dependencies in Node, so install the equivalent
// require transform before a component test imports RNTL or `react-native`.
register({
  babelrc: false,
  cache: false,
  configFile: false,
  extensions: [".js"],
  only: [/node_modules\/(?:react-native|@react-native\/[^/]+)\//u],
  presets: ["babel-preset-expo"],
});

const nodeRequire = createRequire(import.meta.url);
const presetMockDirectory = path.dirname(
  nodeRequire.resolve("@react-native/jest-preset/jest/mocks/View")
);
(globalThis as unknown as { jest: unknown }).jest = {
  fn: vi.fn,
  requireActual: (id: string) => {
    if (id.startsWith("."))
      return nodeRequire(path.resolve(presetMockDirectory, id));
    const replacement = presetMockTargets.get(id);
    if (!replacement) return nodeRequire(id);
    const resolved = nodeRequire.resolve(id);
    mockRequire.stop(id);
    mockRequire.stop(resolved);
    const actual = nodeRequire(id);
    mockRequire(id, replacement);
    mockRequire(resolved, replacement);
    return actual;
  },
};

// These are the native seams from React Native's own 0.86 Jest preset. The
// application components and every JS helper above them remain real; only the
// bridge-backed host components and device services are substituted.
const presetMocks = [
  ["react-native/Libraries/AppState/AppState", "AppState"],
  ["react-native/Libraries/BatchedBridge/NativeModules", "NativeModules"],
  [
    "react-native/Libraries/Components/AccessibilityInfo/AccessibilityInfo",
    "AccessibilityInfo",
  ],
  [
    "react-native/Libraries/Components/ActivityIndicator/ActivityIndicator",
    "ActivityIndicator",
  ],
  ["react-native/Libraries/Components/Clipboard/Clipboard", "Clipboard"],
  [
    "react-native/Libraries/Components/RefreshControl/RefreshControl",
    "RefreshControl",
  ],
  ["react-native/Libraries/Components/ScrollView/ScrollView", "ScrollView"],
  ["react-native/Libraries/Components/TextInput/TextInput", "TextInput"],
  ["react-native/Libraries/Components/View/View", "View"],
  [
    "react-native/Libraries/Components/View/ViewNativeComponent",
    "ViewNativeComponent",
  ],
  ["react-native/Libraries/Core/InitializeCore", "InitializeCore"],
  ["react-native/Libraries/Image/Image", "Image"],
  ["react-native/Libraries/Linking/Linking", "Linking"],
  ["react-native/Libraries/Modal/Modal", "Modal"],
  [
    "react-native/Libraries/NativeComponent/NativeComponentRegistry",
    "NativeComponentRegistry",
  ],
  ["react-native/Libraries/ReactNative/RendererProxy", "RendererProxy"],
  [
    "react-native/Libraries/ReactNative/requireNativeComponent",
    "requireNativeComponent",
  ],
  ["react-native/Libraries/ReactNative/UIManager", "UIManager"],
  ["react-native/Libraries/Text/Text", "Text"],
  ["react-native/Libraries/Utilities/useColorScheme", "useColorScheme"],
  ["react-native/Libraries/Vibration/Vibration", "Vibration"],
] as const;

const presetMockTargets = new Map<string, string>(
  presetMocks.map(([source, target]) => [
    source,
    nodeRequire.resolve(`@react-native/jest-preset/jest/mocks/${target}`),
  ])
);

for (const [source, target] of presetMocks) {
  const replacement = nodeRequire.resolve(
    `@react-native/jest-preset/jest/mocks/${target}`
  );
  mockRequire(source, replacement);
  mockRequire(nodeRequire.resolve(source), replacement);
}

// Jest's RN resolver chooses the iOS variant for extensionless platform
// imports. Node has no `.ios.js` resolution rule, so make that one resolver
// decision explicit for the Vitest process.
mockRequire(
  "react-native/Libraries/Utilities/Platform",
  nodeRequire.resolve("react-native/Libraries/Utilities/Platform.ios")
);

// The host renderer's development-only container mounts LogBox and inspector
// overlays. They are native debugging surfaces, not part of an application
// component tree, and depend on Metro-only image resolution.
const appContainerMock = {
  default: ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
};
for (const source of [
  "react-native/Libraries/ReactNative/AppContainer",
  "react-native/Libraries/ReactNative/AppContainer-dev",
]) {
  mockRequire(source, appContainerMock);
  mockRequire(nodeRequire.resolve(source), appContainerMock);
}

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
