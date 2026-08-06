// Pins the People destination's two defects from issue #711:
//
//  - a party with no display_name still shows, as "Unnamed" — never dropped
//    from the grid (README:217, proto:3760)
//  - tapping a person card opens THAT PERSON'S PHOTOGRAPHS
//    (`PhotoStateView`, mode "person"), never `FaceReview` — the previous
//    `PhotosCollectionsView` behaviour this screen replaced always opened
//    Face review regardless of which person card was tapped, which is
//    exactly the "labelled destination opens something else" bug this issue
//    is about
//
// Also checks the unmatched-faces note substitutes the LIVE count for the
// mock's 54, and keeps the exact proto:4433 sentence around it.
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @vitest-environment jsdom
import PhotosPeopleView from "./PhotosPeopleView";

type ReactNative = typeof import("react-native");
type ThemeModule = typeof import("../../kit/theme");
type UseReplicaQueryModule = typeof import("../../kit/hooks/useReplicaQuery");
type DesignModule = typeof import("@centraid/design");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  colors: { text: "#mock-text", textFaint: "#mock-text-faint" },
  // party "p2" has no display_name/name at all — the unnamed case. Both p1
  // and p2 have at least one confirmed face so both must render.
  faces: [
    { region_id: "f1", asset_id: "a1", confirmed_by_party_id: "p1" },
    { region_id: "f2", asset_id: "a2", confirmed_by_party_id: "p2" },
    // Never confirmed to anyone — counted by the unmatched note, not shown
    // as a card.
    { region_id: "f3", asset_id: "a3", confirmed_by_party_id: undefined },
    { region_id: "f4", asset_id: "a4", confirmed_by_party_id: undefined },
  ],
  parties: [{ party_id: "p1", display_name: "Ana" }, { party_id: "p2" }],
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
    FlatList: <T,>({
      data,
      renderItem,
      ListEmptyComponent,
      ListFooterComponent,
      keyExtractor,
    }: {
      data: readonly T[];
      renderItem: (info: { item: T }) => React.ReactNode;
      ListEmptyComponent?: React.ReactNode;
      ListFooterComponent?: React.ReactNode;
      keyExtractor: (item: T) => string;
    }) =>
      element("div", {
        children: [
          data.length
            ? data.map((item) =>
                ReactModule.createElement(
                  React.Fragment,
                  { key: keyExtractor(item) },
                  renderItem({ item })
                )
              )
            : ListEmptyComponent,
          ListFooterComponent,
        ],
      }),
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
      element("button", {
        "aria-label": accessibilityLabel,
        children,
        onClick: onPress,
        role: accessibilityRole,
        type: "button",
      }),
    StyleSheet: { create: <T,>(styles: T): T => styles },
    Text: ({ children }: { children?: React.ReactNode }) =>
      element("span", { children }),
    View: ({ children }: { children?: React.ReactNode }) =>
      element("div", { children }),
  } as unknown as Partial<ReactNative>;
});

vi.mock(
  import("../../kit/theme"),
  () =>
    ({
      borders: { hairline: 1 },
      spacing: Array.from({ length: 8 }, (_, index) => index * 4),
      t: () => ({}),
      useTheme: () => ({ colors: mocks.colors }),
    }) as unknown as Partial<ThemeModule>
);

vi.mock(
  import("../../kit/hooks/useReplicaQuery"),
  () =>
    ({
      useReplicaQuery: (
        _app: string,
        query: { entity: string }
      ): { rows: unknown[] } => ({
        rows:
          query.entity === "media.face_region" ? mocks.faces : mocks.parties,
      }),
    }) as unknown as Partial<UseReplicaQueryModule>
);

vi.mock(
  import("@centraid/design"),
  () =>
    ({
      identityColor: () => "#mock-identity",
      tileFinish: () => ({ backgroundColor: "#mock-tile" }),
    }) as unknown as Partial<DesignModule>
);

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let navigate: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;

function renderView(): void {
  navigate = vi.fn<(...args: unknown[]) => void>();
  act(() => {
    root = createRoot(container!);
    root.render(<PhotosPeopleView navigation={{ navigate } as never} />);
  });
}

describe("the People destination's grid and card behaviour", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it("shows a party with no display_name as Unnamed, not dropped from the grid", () => {
    renderView();
    expect(container!.textContent).toContain("Ana");
    expect(container!.textContent).toContain("Unnamed");
  });

  it("tapping a person card opens THEIR photographs, not Face review", () => {
    renderView();
    const anaButton = Array.from(container!.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-label")?.startsWith("Ana")
    );
    expect(anaButton).toBeTruthy();
    act(() =>
      anaButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    expect(navigate).toHaveBeenCalledExactlyOnceWith("PhotoStateView", {
      mode: "person",
      partyId: "p1",
      personName: "Ana",
    });
    expect(navigate).not.toHaveBeenCalledWith("FaceReview");
  });

  it("substitutes the live unmatched-face count into the exact proto note", () => {
    renderView();
    // f3 and f4 are unconfirmed — 2, not the mock's 54.
    expect(container!.textContent).toContain(
      "2 faces are not matched to anyone. Face review proposes them one at a time, and nothing is named until you name it."
    );
  });
});
