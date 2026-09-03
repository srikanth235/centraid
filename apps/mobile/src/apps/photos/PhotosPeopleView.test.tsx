// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PhotosPeopleView from "./PhotosPeopleView";

type ReactNative = typeof import("react-native");
type ThemeModule = typeof import("../../kit/theme");
type UseReplicaQueryModule = typeof import("../../kit/hooks/useReplicaQuery");
type DesignModule = typeof import("@centraid/design");
type ReplicaProviderModule = typeof import("../../kit/replica/ReplicaProvider");
type WriteOutcomeModule = typeof import("../../kit/replica/write-outcome");
type StatusLineModule = typeof import("../../kit/components/status-line");
type ConsentGateModule = typeof import("../../kit/components/ConsentGate");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  colors: {
    line: "#mock-line",
    text: "#mock-text",
    textFaint: "#mock-text-faint",
  },
  postStatus: vi.fn<(message: string) => void>(),
  policies: [{ domain: "photos", tier: "device" }] as Array<{
    domain: string;
    tier: string;
  }>,
  session: {
    write: vi.fn<(app: string, intent: unknown) => Promise<{ status: string }>>(
      async () => ({ status: "executed" })
    ),
  },
  faces: [
    {
      region_id: "f1",
      asset_id: "a1",
      party_id: "p1",
      confirmed_by_party_id: "p1",
      review_state: "confirmed",
    },
    {
      region_id: "f2",
      asset_id: "a2",
      party_id: "p2",
      confirmed_by_party_id: "p2",
      review_state: "confirmed",
    },
    {
      region_id: "f3",
      asset_id: "a3",
      confirmed_by_party_id: undefined,
      review_state: "proposed",
    },
    {
      region_id: "f4",
      asset_id: "a4",
      confirmed_by_party_id: undefined,
      review_state: "proposed",
    },
    {
      region_id: "f5",
      asset_id: "a5",
      confirmed_by_party_id: undefined,
      review_state: "dismissed",
    },
  ],
  clusters: [
    { region_id: "f3", cluster_id: "cluster-1" },
    { region_id: "f4", cluster_id: "cluster-1" },
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
      radii: { lg: 12, md: 8, pill: 999, sm: 4, xl: 16, xs: 0 },
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
      ): { loading: boolean; rows: unknown[] } => ({
        loading: false,
        rows:
          query.entity === "media.face_region"
            ? mocks.faces
            : query.entity === "media.face_cluster"
              ? mocks.clusters
              : query.entity === "core.party"
                ? mocks.parties
                : mocks.policies,
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

vi.mock(
  import("../../kit/replica/ReplicaProvider"),
  () =>
    ({
      useReplica: () => ({ session: mocks.session }),
    }) as unknown as Partial<ReplicaProviderModule>
);

vi.mock(
  import("../../kit/replica/write-outcome"),
  () =>
    ({
      surfaceWriteFailure: vi.fn<(error: unknown, title?: string) => void>(),
      surfaceWriteOutcome: (result: { status: string }) =>
        result.status === "executed",
    }) as unknown as Partial<WriteOutcomeModule>
);

vi.mock(
  import("../../kit/components/status-line"),
  () =>
    ({
      postStatus: mocks.postStatus,
    }) as unknown as Partial<StatusLineModule>
);

vi.mock(import("./PhotosScreen"), async () => {
  const ReactModule = await import("react");
  return {
    default: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  } as never;
});

vi.mock(import("../../kit/components/ConsentGate"), async () => {
  const ReactModule = await import("react");
  return {
    ConsentGate: (props: {
      domain: string;
      onRunOnDevice: () => void;
      onDecline: () => void;
      onDevice: { available: boolean; reason?: string };
      answered?: string | null;
      busy?: boolean;
    }) =>
      ReactModule.createElement(
        "div",
        { "data-domain": props.domain, "data-testid": "consent-gate" },
        ReactModule.createElement(
          "button",
          {
            disabled: !props.onDevice.available,
            onClick: props.onRunOnDevice,
            type: "button",
          },
          "Run on this device"
        ),
        props.onDevice.reason,
        ReactModule.createElement(
          "button",
          { onClick: props.onDecline, type: "button" },
          "Not now"
        )
      ),
  } as unknown as Partial<ConsentGateModule>;
});

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let navigate: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;

function renderView(): void {
  navigate = vi.fn<(...args: unknown[]) => void>();
  act(() => {
    root = createRoot(container!);
    root.render(
      <PhotosPeopleView
        navigation={{ navigate } as never}
        route={{} as never}
      />
    );
  });
}

describe("the people roster's grid and card behaviour", () => {
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
    expect(container!.textContent).toContain(
      "2 faces are not matched to anyone — face review proposes them one at a time."
    );
  });

  it("renders clustered proposals as unnamed groups and opens Face review", () => {
    renderView();
    const group = Array.from(container!.querySelectorAll("button")).find(
      (button) =>
        button.getAttribute("aria-label") === "Unnamed group, 2 photographs"
    );
    expect(group).toBeTruthy();
    act(() => group!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(navigate).toHaveBeenCalledWith("FaceReview");
  });
});

describe("the people roster's consent gate (issue 712 C2)", () => {
  const facesWithConfirmed = mocks.faces;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mocks.faces = [];
    mocks.policies = [{ domain: "photos", tier: "device" }];
    mocks.session.write.mockClear();
    mocks.postStatus.mockClear();
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    mocks.faces = facesWithConfirmed;
  });

  it("renders the gate instead of the plain empty copy when the roster is empty and unanswered", () => {
    renderView();
    expect(
      container!.querySelector('[data-testid="consent-gate"]')
    ).toBeTruthy();
    expect(container!.textContent).not.toContain("No people yet");
  });

  it("falls back to the plain empty copy once the question is declined", () => {
    renderView();
    const decline = Array.from(container!.querySelectorAll("button")).find(
      (button) => button.textContent === "Not now"
    );
    act(() =>
      decline!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    expect(
      container!.querySelector('[data-testid="consent-gate"]')
    ).toBeFalsy();
    expect(container!.textContent).toContain("No people yet");
    expect(mocks.session.write).not.toHaveBeenCalled();
    expect(mocks.postStatus).toHaveBeenCalledOnce();
  });

  it("does not render the gate once a non-empty roster answers the question on its own", () => {
    mocks.faces = facesWithConfirmed;
    renderView();
    expect(
      container!.querySelector('[data-testid="consent-gate"]')
    ).toBeFalsy();
  });

  it("does not offer a device run when this build has no device faces producer", () => {
    renderView();
    expect(mocks.session.write).not.toHaveBeenCalled();
    const run = Array.from(container!.querySelectorAll("button")).find(
      (button) => button.textContent === "Run on this device"
    );
    expect(run).toBeTruthy();
    expect((run as HTMLButtonElement).disabled).toBe(true);
    expect(container!.textContent).toContain(
      "this build has no device-side face detector"
    );
    act(() => run!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(mocks.session.write).not.toHaveBeenCalled();
  });
});
