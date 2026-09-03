import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PhotoEditor } from "./PhotoEditor";
import type { PhotoAsset } from "./timeline-model";

type ReactNative = typeof import("react-native");
type ThemeModule = typeof import("../../kit/theme");
type NativeTextModule = typeof import("../../kit/components/NativeText");
type ExpoImage = typeof import("expo-image");
type GestureHandler = typeof import("react-native-gesture-handler");
type EditGestures = typeof import("./photo-edit-gestures");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  colors: {
    net: "#mock-net",
    onStage: "#mock-on-stage",
    stage: "#mock-stage",
    stageLine: "#mock-stage-line",
    textDisabled: "#mock-text-disabled",
    textSoft: "#mock-text-soft",
  },
  crop: {} as { move?: (dx: number, dy: number) => void },
}));

vi.mock(import("react-native"), async () => {
  const ReactModule = await import("react");
  return {
    Pressable: ({
      accessibilityLabel,
      accessibilityState,
      children,
      disabled,
      onPress,
    }: {
      accessibilityLabel?: string;
      accessibilityState?: { disabled?: boolean; selected?: boolean };
      children?: React.ReactNode;
      disabled?: boolean;
      onPress?: () => void;
    }) =>
      ReactModule.createElement(
        "button",
        {
          "aria-disabled": accessibilityState?.disabled ? "true" : undefined,
          "aria-label": accessibilityLabel,
          "aria-pressed": accessibilityState?.selected ? "true" : undefined,
          "data-disabled": disabled ? "true" : "false",
          onClick: onPress,
          type: "button",
        },
        children
      ),
    StyleSheet: { create: <T,>(styles: T): T => styles },
    View: ({ children }: { children?: React.ReactNode; style?: unknown }) =>
      ReactModule.createElement("div", null, children),
  } as unknown as Partial<ReactNative>;
});

vi.mock(import("expo-image"), async () => {
  const ReactModule = await import("react");
  return {
    Image: () => ReactModule.createElement("img"),
  } as unknown as Partial<ExpoImage>;
});

vi.mock(import("react-native-gesture-handler"), async () => {
  const ReactModule = await import("react");
  return {
    GestureDetector: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement("div", null, children),
  } as unknown as Partial<GestureHandler>;
});

vi.mock(
  import("./photo-edit-gestures"),
  () =>
    ({
      buildCropGesture: (
        _frame: unknown,
        onMove: (dx: number, dy: number) => void
      ) => {
        mocks.crop.move = onMove;
        return {};
      },
    }) as unknown as EditGestures
);

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
      radii: { lg: 12, md: 8, pill: 999, sm: 4 },
      spacing: [0, 4, 8, 12, 16, 20, 24],
      t: () => ({}),
      useTheme: () => ({ colors: mocks.colors, scheme: "dark" }),
    }) as unknown as Partial<ThemeModule>
);

const ASSET: PhotoAsset = {
  archived: false,
  assetId: "asset-1",
  backupState: "backed-up",
  canWrite: true,
  capturedAt: "2026-07-30T17:42:00Z",
  deleted: false,
  favorite: false,
  filename: "IMG_4913.HEIC",
  height: 2000,
  id: "row-1",
  kind: "photo",
  originalUri: "file:///original.heic",
  previewUri: "file:///preview.jpg",
  source: "replica",
  sourceVaultId: "vault-1",
  uri: "file:///preview.jpg",
  width: 3000,
};

describe("the phone's photo editor", () => {
  let host: HTMLDivElement;
  let root: Root;
  const onSave = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const onCancel = vi.fn<() => void>();
  const onStatus = vi.fn<(line: string) => void>();

  beforeEach(() => {
    onSave.mockClear();
    onCancel.mockClear();
    onStatus.mockClear();
    mocks.crop.move = undefined;
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
        <PhotoEditor
          asset={ASSET}
          onCancel={onCancel}
          onSave={onSave}
          onStatus={onStatus}
          width={390}
          {...props}
        />
      );
    });
  }

  function press(label: string): void {
    const button = [...host.querySelectorAll("button")].find(
      (candidate) => candidate.getAttribute("aria-label") === label
    );
    if (!button) throw new Error(`no control labelled ${label}`);
    act(() => button.click());
  }

  function labels(): string[] {
    return [...host.querySelectorAll("button")].map(
      (button) => button.getAttribute("aria-label") ?? ""
    );
  }

  it("carries the proto's tool row, the commit and the way out", () => {
    render();
    expect(labels()).toStrictEqual([
      "Crop",
      "Rotate 90°",
      "Straighten 0°",
      "Flip",
      "Original",
      "Square",
      "3 : 2",
      "Reset",
      "Cancel",
      "Save as a new photograph",
    ]);
  });

  it("writes NOTHING until the commit is pressed", () => {
    render();
    press("Rotate 90°");
    press("Straighten 0°");
    press("3 : 2");
    press("Square");
    press("Reset");
    act(() => mocks.crop.move?.(0.05, 0.05));
    expect(onSave).not.toHaveBeenCalled();

    press("Cancel");
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();

    press("Save as a new photograph");
    expect(onSave).toHaveBeenCalledOnce();
  });

  it("says so, at every step, in the status line", () => {
    render();
    press("Rotate 90°");
    press("3 : 2");
    for (const [line] of onStatus.mock.calls)
      expect(line).toContain("nothing written yet");
    expect(onStatus.mock.calls.at(-1)?.[0]).toBe(
      "Crop 3 : 2 · rotation +90° · nothing written yet"
    );
  });

  it("carries the live angle on the one straighten control", () => {
    render();
    press("Straighten 0°");
    press("Straighten −1°");
    expect(labels()).toContain("Straighten −2°");
  });

  it("refuses the commit in a read-only vault, and says why on screen", () => {
    render({ saveDisabledReason: "This vault is read-only for you." });
    const commit = [...host.querySelectorAll("button")].find(
      (button) =>
        button.getAttribute("aria-label") === "Save as a new photograph"
    );
    expect(commit?.getAttribute("aria-disabled")).toBe("true");
    expect(host.textContent).toContain("This vault is read-only for you.");
    act(() => commit?.click());
    expect(onSave).not.toHaveBeenCalled();
  });
});
// @vitest-environment jsdom
