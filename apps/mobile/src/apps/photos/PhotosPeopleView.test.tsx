// Pins #711 people-roster defects plus #712's re-homed empty state: a party
// without display_name still shows as "Unnamed" (README:217, proto:3760); card
// taps open THAT PERSON'S photographs (`PhotoStateView`, mode "person"), never
// `FaceReview`; an empty roster shows signage, never a consent question, and
// its one action writes the PRIORITY `enrich.request`; the unmatched-faces
// note takes the LIVE count, not the mock's 54 (proto:4433).
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @vitest-environment jsdom
import PhotosPeopleView from "./PhotosPeopleView";

type ReactNative = typeof import("react-native");
type ThemeModule = typeof import("../../kit/theme");
type DesignModule = typeof import("@centraid/design");
type ReplicaProviderModule = typeof import("../../kit/replica/ReplicaProvider");
type WriteOutcomeModule = typeof import("../../kit/replica/write-outcome");
type StatusLineModule = typeof import("../../kit/components/status-line");
type PeopleEmptyStateModule = typeof import("./PeopleEmptyState");

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
  // `enrich.policy`'s photos row: `gateway`, the Faces recipe's lane.
  policies: [{ domain: "photos", tier: "gateway" }] as Array<{
    domain: string;
    tier: string;
  }>,
  session: {
    write: vi.fn<(app: string, intent: unknown) => Promise<{ status: string }>>(
      async () => ({ status: "executed" })
    ),
  },
  // p2 has no display_name — the unnamed case; p1 and p2 both have ≥1
  // confirmed face so both must render.
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
    // Never answered — counted by the unmatched note, not shown as a card.
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
    // Answered without confirmation (#712): nobody's card, nobody's backlog.
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

// The seat's paged reads (#996 wave 4b). Photos' five shared sets and the
// screen-local ones are walks over this phone's own copy now; the double keys
// on the entity the read declares, exactly as the old one keyed on the request.
vi.mock(
  import("../../kit/hooks/useSeatPages"),
  () =>
    ({
      useSeatPages: (
        _app: string,
        _query: unknown,
        read: { entity: string }
      ): { loading: boolean; rows: unknown[] } => ({
        loading: false,
        rows:
          read.entity === "media.face_region"
            ? mocks.faces
            : read.entity === "media.face_cluster"
              ? mocks.clusters
              : read.entity === "core.party"
                ? mocks.parties
                : mocks.policies,
      }),
    }) as never
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
      // result→boolean mapping is pinned by `write-outcome` itself; only
      // "executed" must read as success here.
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

// PhotosScreen pulls in react-navigation, the band-owner hook and the band/
// selection-bar tree — none of this file's claims. Stubbed to a children
// passthrough; `PhotosScreen.test.tsx` owns the shell's behaviour.
vi.mock(import("./PhotosScreen"), async () => {
  const ReactModule = await import("react");
  return {
    default: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  } as never;
});

vi.mock(import("./PeopleEmptyState"), async () => {
  const ReactModule = await import("react");
  return {
    default: (props: {
      prioritise: { available: boolean; reason?: string };
      busy?: boolean;
      prioritised?: boolean;
      onPrioritise: () => void;
    }) =>
      ReactModule.createElement(
        "div",
        { "data-testid": "people-empty-state" },
        ReactModule.createElement(
          "button",
          {
            disabled:
              !props.prioritise.available ||
              !!props.busy ||
              !!props.prioritised,
            onClick: props.onPrioritise,
            type: "button",
          },
          "Prioritise faces"
        ),
        props.prioritise.reason
      ),
  } as unknown as Partial<PeopleEmptyStateModule>;
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
    // f3 and f4 are unconfirmed — 2, not the mock's 54.
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

describe("the people roster's empty state (issue 712 C2, ruled 2026-09-09)", () => {
  const facesWithConfirmed = mocks.faces;

  const priorityButton = (): HTMLButtonElement | undefined =>
    Array.from(container!.querySelectorAll("button")).find(
      (button) => button.textContent === "Prioritise faces"
    );

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mocks.faces = [];
    mocks.policies = [{ domain: "photos", tier: "gateway" }];
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

  it("shows the empty state on an empty roster, and writes nothing to do it", () => {
    renderView();
    expect(
      container!.querySelector('[data-testid="people-empty-state"]')
    ).toBeTruthy();
    expect(mocks.session.write).not.toHaveBeenCalled();
    expect(mocks.postStatus).not.toHaveBeenCalled();
  });

  it("writes exactly one manual request from the priority press", () => {
    renderView();
    act(() =>
      priorityButton()!.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      )
    );
    expect(mocks.session.write).toHaveBeenCalledExactlyOnceWith("photos", {
      action: "request-enrichment",
      input: { entity_type: "media.asset" },
    });
  });

  it("says the run comes SOONER, never that it was withheld until now", async () => {
    renderView();
    act(() =>
      priorityButton()!.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      )
    );
    await act(async () => undefined);
    expect(mocks.postStatus).toHaveBeenCalledExactlyOnceWith(
      "Faces prioritised — this library runs sooner"
    );
  });

  it("does not show the empty state once the roster has people in it", () => {
    mocks.faces = facesWithConfirmed;
    renderView();
    expect(
      container!.querySelector('[data-testid="people-empty-state"]')
    ).toBeFalsy();
  });

  it("withholds the ask on the device tier, with the lane named, and writes nothing", () => {
    mocks.policies = [{ domain: "photos", tier: "device" }];
    renderView();
    const control = priorityButton();
    expect(control).toBeTruthy();
    expect(control!.disabled).toBe(true);
    expect(container!.textContent).toContain(
      "the Faces recipe runs on the gateway"
    );
    act(() =>
      control!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    expect(mocks.session.write).not.toHaveBeenCalled();
  });
});
