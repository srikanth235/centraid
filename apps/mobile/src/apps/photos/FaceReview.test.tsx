// @vitest-environment jsdom
// Pins the three defects issue #711 found in the native Face review screen
// (see FaceReview.tsx's own header for the full list) — a regression net,
// not a styling snapshot:
//
//   1. CONFIDENCE IS NEVER A PERCENTAGE (README.md:285). The old screen said
//      `{pct}% confidence`; nothing rendered here may contain a `%`.
//   2. ONE FACE AT A TIME (v4 3967). The old screen was a FlatList over every
//      unconfirmed region; exactly one "Is this someone you know?" panel is
//      ever on screen.
//   3. AN UNMATCHED FACE HAS A FORWARD ACTION. The old screen rendered
//      Confirm only when `party_id` was already set, so a proposal with no
//      match — the PRIMARY case a face detector produces — was reject-only.
//   4. THE QUEUE CAN BE FINISHED (issue #712). "Keep unnamed" writes a real
//      `dismiss` answer through the one `answer-face` verb instead of setting
//      an apologetic note; an already-answered region stays out of the queue
//      across pulls; and Skip is the only control that still writes nothing.
//
// Same react-native-as-DOM mocking technique as PhotosPeopleView.test.tsx:
// every RN primitive becomes a plain DOM element so the screen can be driven
// with react-dom/client under jsdom, without a native runtime.
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ReactNative = typeof import("react-native");
type ThemeModule = typeof import("../../kit/theme");
type UseReplicaQueryModule = typeof import("../../kit/hooks/useReplicaQuery");
type ReplicaProviderModule = typeof import("../../kit/replica/ReplicaProvider");
type WriteOutcomeModule = typeof import("../../kit/replica/write-outcome");
type TimelineSourceModule = typeof import("./timeline-source");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  colors: {
    accentFill: "#mock-accent-fill",
    accentText: "#mock-accent-text",
    bg: "#mock-bg",
    bgElev: "#mock-bg-elev",
    bgSunken: "#mock-bg-sunken",
    line: "#mock-line",
    onStage: "#mock-on-stage",
    skel: "#mock-skel",
    text: "#mock-text",
    textDisabled: "#mock-text-disabled",
    textFaint: "#mock-text-faint",
    textInv: "#mock-text-inv",
    textSoft: "#mock-text-soft",
  },
  // r1: proposed match "Ana", 8 other matching photographs — the confidence
  // rule's fixture. r2: NO party_id at all — the "no forward action" bug's
  // primary case. Neither is `confirmed_by_party_id`, so both are queued.
  faces: [
    {
      region_id: "r1",
      asset_id: "a1",
      party_id: "p-ana",
      review_state: "proposed",
      bbox_json: JSON.stringify({ x: 0.3, y: 0.3, w: 0.2, h: 0.2 }),
    },
    {
      region_id: "r2",
      asset_id: "a2",
      party_id: null,
      review_state: "proposed",
      bbox_json: null,
    },
    // Already answered and NOT confirmed (issue #712) — a face the member
    // deliberately left unnamed. It must not be in the queue, and it must not
    // be counted as one of Ana's matches either.
    {
      region_id: "r-dismissed",
      asset_id: "a-dismissed",
      party_id: null,
      review_state: "dismissed",
      bbox_json: null,
    },
    // 8 more photographs already confirmed as Ana — exactly what "8
    // matching faces" (README.md:285's match-count rule) is counting.
    ...Array.from({ length: 8 }, (_, i) => ({
      region_id: `r-confirmed-${i}`,
      asset_id: `a-confirmed-${i}`,
      party_id: "p-ana",
      confirmed_by_party_id: "p-ana",
      review_state: "confirmed",
      bbox_json: null,
    })),
  ],
  parties: [{ party_id: "p-ana", display_name: "Ana" }],
  assets: [
    {
      asset_id: "a1",
      captured_at: "2026-06-12T00:00:00.000Z",
      width: 1000,
      height: 1000,
    },
    {
      asset_id: "a2",
      captured_at: "2026-06-01T00:00:00.000Z",
      width: 1000,
      height: 1000,
    },
  ],
  timelineAssets: [
    { assetId: "a1", uri: "file://a1.jpg", width: 1000, height: 1000 },
    { assetId: "a2", uri: "file://a2.jpg", width: 1000, height: 1000 },
  ],
  write: vi.fn<() => Promise<{ status: string }>>(() =>
    Promise.resolve({ status: "executed" })
  ),
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
      children,
      disabled,
      onPress,
    }: {
      accessibilityLabel?: string;
      accessibilityRole?: string;
      children?: React.ReactNode;
      disabled?: boolean;
      onPress?: () => void;
    }) =>
      element("button", {
        "aria-label": accessibilityLabel,
        children,
        disabled,
        onClick: disabled ? undefined : onPress,
        role: accessibilityRole,
        type: "button",
      }),
    RefreshControl: () => null,
    FlatList: ({
      data,
      ListEmptyComponent,
      ListFooterComponent,
      renderItem,
    }: {
      data?: readonly unknown[];
      ListEmptyComponent?: React.ReactNode;
      ListFooterComponent?: React.ReactNode;
      renderItem?: (info: { item: unknown; index: number }) => React.ReactNode;
    }) =>
      element("div", {
        children: [
          ...(data?.length
            ? data.map((item, index) => renderItem?.({ item, index }))
            : [ListEmptyComponent]),
          ListFooterComponent,
        ],
      }),
    StyleSheet: {
      create: <T,>(styles: T): T => styles,
    },
    View: ({ children }: { children?: React.ReactNode }) =>
      element("div", { children }),
  } as unknown as Partial<ReactNative>;
});

vi.mock(
  import("expo-image"),
  () =>
    ({
      Image: () => null,
    }) as never
);
vi.mock(
  import("react-native-safe-area-context"),
  () =>
    ({
      SafeAreaView: ({ children }: { children?: React.ReactNode }) =>
        React.createElement("div", {}, children),
    }) as never
);
vi.mock(
  import("../../kit/components/Icon"),
  () =>
    ({
      default: () => null,
    }) as never
);
vi.mock(
  import("../../kit/components/NativeText"),
  () =>
    ({
      Text: ({ children }: { children?: React.ReactNode }) =>
        React.createElement("span", {}, children),
    }) as never
);
vi.mock(
  import("../../kit/media/grid-image"),
  () =>
    ({
      gridImageProps: () => ({}),
    }) as never
);
vi.mock(
  import("../../kit/media/media-source"),
  () =>
    ({
      imageSource: (uri: string) => uri,
    }) as never
);
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
      ): { rows: unknown[] } => {
        if (query.entity === "media.face_region") return { rows: mocks.faces };
        if (query.entity === "core.party") return { rows: mocks.parties };
        if (query.entity === "media.media_asset") return { rows: mocks.assets };
        return { rows: [] };
      },
    }) as unknown as Partial<UseReplicaQueryModule>
);
vi.mock(
  import("../../kit/replica/ReplicaProvider"),
  () =>
    ({
      useReplica: () => ({
        session: { write: mocks.write },
        refresh: () => Promise.resolve(),
      }),
    }) as unknown as Partial<ReplicaProviderModule>
);
vi.mock(
  import("../../kit/replica/ReplicaStatusBar"),
  () =>
    ({
      default: () => null,
    }) as never
);
vi.mock(
  import("../../kit/replica/useReplicaRefresh"),
  () =>
    ({
      useReplicaRefresh: () => ({
        refreshing: false,
        refreshNow: () => undefined,
      }),
    }) as never
);
vi.mock(
  import("../../kit/replica/write-outcome"),
  () =>
    ({
      surfaceWriteFailure: () => undefined,
      surfaceWriteOutcome: () => true,
    }) as unknown as Partial<WriteOutcomeModule>
);
vi.mock(
  import("./timeline-source"),
  () =>
    ({
      usePhotoTimeline: () => ({ assets: mocks.timelineAssets }),
    }) as unknown as Partial<TimelineSourceModule>
);

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let navigate: ReturnType<typeof vi.fn>;
let goBack: ReturnType<typeof vi.fn>;

async function renderScreen(): Promise<void> {
  const { default: FaceReview } = await import("./FaceReview");
  navigate = vi.fn<() => void>();
  goBack = vi.fn<() => void>();
  act(() => {
    root = createRoot(container!);
    root!.render(
      <FaceReview
        navigation={{ navigate, goBack } as never}
        route={{ key: "FaceReview", name: "FaceReview" } as never}
      />
    );
  });
}

describe("Face review (native)", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.write.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it('titles the screen "Face review", not "People review"', async () => {
    await renderScreen();
    expect(container!.textContent).toContain("Face review");
    expect(container!.textContent).not.toContain("People review");
  });

  it("rule 1: confidence never renders as a percentage", async () => {
    await renderScreen();
    expect(container!.textContent).not.toMatch(/%/u);
    expect(container!.textContent).toMatch(/8 matching faces/u);
  });

  it("rule 2: exactly one proposal is on screen at a time", async () => {
    await renderScreen();
    expect(container!.textContent).toMatch(/Proposed: Ana/u);
    expect(container!.textContent).not.toMatch(/No proposed match/u);
    // Only one panel's worth of facts — "confidence" appears once.
    const occurrences = (container!.textContent!.match(/confidence/gu) ?? [])
      .length;
    expect(occurrences).toBe(1);
  });

  it("rule 3: an unmatched face (no proposed person) still has a forward action", async () => {
    await renderScreen();
    // Skip to the second (unmatched) proposal.
    const skipBtn = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Skip this face"
    )!;
    act(() =>
      skipBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    expect(container!.textContent).toMatch(/No proposed match/u);
    const labels = Array.from(container!.querySelectorAll("button")).map((b) =>
      b.getAttribute("aria-label")
    );
    expect(labels).toContain("Not this person");
    expect(labels).toContain("Skip this face");
    expect(labels).toContain("Keep unnamed");
    expect(container!.textContent).not.toMatch(/Confirm as/u);
  });

  it("does not render the CONFIRMED PEOPLE carousel", async () => {
    await renderScreen();
    expect(container!.textContent).not.toMatch(/CONFIRMED PEOPLE/iu);
    expect(container!.textContent).not.toMatch(/\d+ photos\b/u);
  });

  it("Keep unnamed fires a real dismiss answer (issue #712)", async () => {
    await renderScreen();
    const keep = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Keep unnamed"
    )!;
    await act(async () => {
      keep.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(mocks.write).toHaveBeenCalledOnce();
    const [app, request] = mocks.write.mock.calls[0] as unknown as [
      string,
      {
        action: string;
        input: Record<string, unknown>;
        optimistic: { op: string; values: Record<string, unknown> }[];
      },
    ];
    expect(app).toBe("photos");
    expect(request.action).toBe("answer-face");
    expect(request.input).toStrictEqual({
      region_id: "r1",
      answer: "dismiss",
    });
    // The optimistic row is an UPSERT, not a delete: an answered region
    // survives now, so the local copy has to land in the answered state or
    // the queue rebuilds with the face still in it.
    expect(request.optimistic[0]!.op).toBe("upsert");
    expect(request.optimistic[0]!.values).toStrictEqual({
      review_state: "dismissed",
      party_id: null,
      confirmed_by_party_id: null,
    });
  });

  it("an already-answered region is not in the queue", async () => {
    await renderScreen();
    // Two proposals pending (r1, r2) — the dismissed one is not a third.
    expect(container!.textContent).toMatch(/1 of 2/u);
    expect(container!.textContent).toMatch(/2 to go/u);
  });

  it("Skip never fires a write", async () => {
    await renderScreen();
    const skipBtn = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Skip this face"
    )!;
    act(() =>
      skipBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
