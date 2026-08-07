import type AsyncStorage from "@react-native-async-storage/async-storage";
import { act, fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { StyleSheet, View } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useFakeClock } from "@centraid/test-kit/fake-clock";

import { resolveTheme } from "../../kit/theme";
import CollectionShelfBody from "./CollectionShelfBody";
import PhotoAccessPanel from "./PhotoAccessPanel";
import { PhotoFilmstrip } from "./PhotoFilmstrip";
import PhotoGrainView from "./PhotoGrainView";
import { ViewerTopChrome } from "./PhotoLightboxChrome";
import { makePhotosFixture } from "./photos-fixtures";
import PhotosGridSkeleton from "./PhotosGridSkeleton";
import PhotosHome from "./PhotosHome";
import PhotosSearchEmptyState from "./PhotosSearchEmptyState";
import PhotosSearchRestingState from "./PhotosSearchRestingState";
import PhotosSelectChip from "./PhotosSelectChip";
import ScrubRail from "./ScrubRail";
import TimelineGrainControl from "./TimelineGrainControl";

const homeMocks = vi.hoisted(() => ({
  timeline: {
    assets: [] as ReturnType<typeof makePhotosFixture>["assets"],
    error: undefined as string | undefined,
    loading: false,
    permission: "granted",
    sections: [] as ReturnType<typeof makePhotosFixture>["sections"],
  },
}));

vi.mock(import("@react-native-async-storage/async-storage"), () => ({
  default: {
    getItem: vi.fn<typeof AsyncStorage.getItem>(async () => null),
    setItem: vi.fn<typeof AsyncStorage.setItem>(async () => undefined),
  } as unknown as typeof AsyncStorage,
}));

vi.mock(import("expo-image"), async () => {
  const ReactModule = await import("react");
  const Image = (props: Record<string, unknown>) =>
    ReactModule.createElement("Image", props);
  Image.displayName = "ExpoImageMock";
  return {
    Image,
  } as never;
});

vi.mock(
  import("expo-file-system"),
  () =>
    ({
      Directory: vi.fn<() => object>(() => ({})),
      File: vi.fn<() => object>(() => ({})),
    }) as never
);

vi.mock(
  import("expo-crypto"),
  () =>
    ({
      CryptoDigestAlgorithm: { SHA256: "SHA-256" },
      digestStringAsync: vi.fn<() => Promise<string>>(async () => "digest"),
      randomUUID: vi.fn<() => string>(
        () => "00000000-0000-4000-8000-000000000000"
      ),
    }) as never
);

vi.mock(import("expo-media-library"), () => ({
  usePermissions: vi.fn<
    (typeof import("expo-media-library"))["usePermissions"]
  >(() => [null, vi.fn<() => Promise<never>>(), vi.fn<() => Promise<never>>()]),
}));

vi.mock(import("expo-haptics"), () => ({
  NotificationFeedbackType: { Success: "success" } as never,
  notificationAsync: vi.fn<
    (typeof import("expo-haptics"))["notificationAsync"]
  >(async () => undefined),
  selectionAsync: vi.fn<(typeof import("expo-haptics"))["selectionAsync"]>(
    async () => undefined
  ),
}));

vi.mock(import("expo-notifications"), () => ({
  SchedulableTriggerInputTypes: { DATE: "date" } as never,
  getPermissionsAsync: vi.fn<
    (typeof import("expo-notifications"))["getPermissionsAsync"]
  >(
    async () =>
      ({
        canAskAgain: false,
        expires: "never",
        granted: false,
        status: "denied",
      }) as never
  ),
  scheduleNotificationAsync: vi.fn<
    (typeof import("expo-notifications"))["scheduleNotificationAsync"]
  >(async () => "notice"),
}));

vi.mock(import("react-native-safe-area-context"), () => ({
  useSafeAreaInsets: vi.fn<
    () => {
      bottom: number;
      left: number;
      right: number;
      top: number;
    }
  >(() => ({ bottom: 0, left: 0, right: 0, top: 0 })),
}));

vi.mock(import("react-native-gesture-handler"), async () => {
  const ReactModule = await import("react");
  const gesture = (): Record<string, unknown> => {
    const chain: Record<string, unknown> = {};
    for (const method of [
      "activeOffsetY",
      "enabled",
      "failOffsetX",
      "maxDuration",
      "maxDistance",
      "numberOfTaps",
      "onBegin",
      "onEnd",
      "onFinalize",
      "onStart",
      "onUpdate",
      "runOnJS",
    ])
      chain[method] = () => chain;
    return chain;
  };
  return {
    Gesture: {
      Pan: gesture,
      Pinch: gesture,
      Simultaneous: gesture,
      Tap: gesture,
    },
    GestureDetector: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  } as never;
});

vi.mock(import("../../kit/hooks/useReplicaQuery"), () => ({
  useReplicaQuery: vi.fn<
    (typeof import("../../kit/hooks/useReplicaQuery"))["useReplicaQuery"]
  >(() => ({
    connection: "current",
    error: undefined,
    loading: false,
    refresh: async () => undefined,
    rows: [],
  })),
}));

vi.mock(
  import("react-native-reanimated"),
  () =>
    ({
      default: { Image: "AnimatedImage", View: "AnimatedView" },
      runOnJS: <Arguments extends unknown[], Result>(
        callback: (...args: Arguments) => Result
      ) => callback,
      useAnimatedStyle: (build: () => unknown) => build(),
      useSharedValue: <Value,>(value: Value) => ({ value }),
      withTiming: <Value,>(value: Value) => value,
    }) as never
);

vi.mock(
  import("../../lib/gateway"),
  () =>
    ({
      apiHeaders: vi.fn<() => Record<string, string>>(() => ({})),
      authHeader: vi.fn<() => Record<string, string>>(() => ({})),
      fetchJson: vi.fn<() => Promise<never>>(),
      requireGatewayBase: vi.fn<(base?: string) => string>(
        (base) => base ?? ""
      ),
      resolveGatewayBase: vi.fn<() => Promise<string>>(async () => ""),
    }) as never
);

vi.mock(import("../../lib/upload/media-producer"), () => ({
  backupDeviceMedia:
    vi.fn<
      (typeof import("../../lib/upload/media-producer"))["backupDeviceMedia"]
    >(),
}));

vi.mock(import("../../kit/replica/ReplicaProvider"), () => ({
  useReplica: vi.fn<
    (typeof import("../../kit/replica/ReplicaProvider"))["useReplica"]
  >(() => ({
    online: true,
    ready: true,
    refresh: vi.fn<() => Promise<void>>(async () => undefined),
    scopes: [],
  })),
}));

vi.mock(import("./timeline-source"), () => ({
  usePhotoTimeline: vi.fn<
    (typeof import("./timeline-source"))["usePhotoTimeline"]
  >(() => homeMocks.timeline),
}));

vi.mock(import("./photos-backup"), () => ({
  runBackup: vi.fn<(typeof import("./photos-backup"))["runBackup"]>(),
  useAutomaticPhotoBackup:
    vi.fn<(typeof import("./photos-backup"))["useAutomaticPhotoBackup"]>(),
}));

vi.mock(import("react-native-svg"), async () => {
  const ReactModule = await import("react");
  const host = (name: string) => {
    const Host = ReactModule.forwardRef<unknown, Record<string, unknown>>(
      (props, ref) => ReactModule.createElement(name, { ...props, ref })
    );
    Host.displayName = `${name}Mock`;
    return Host;
  };
  return { default: host("Svg"), Path: host("Path") } as never;
});

vi.mock(import("../../kit/media/media-source"), () => ({
  imageSource: (uri: string) => uri,
  videoSource: (uri: string) => uri,
}));

vi.mock(import("../../../modules/centraid-storage"), () => ({
  nativeDirectorySize: vi.fn<(path: string) => number>(() => 0),
  replicaStorageDirectory: vi.fn<() => string | undefined>(() => undefined),
}));

describe("Photos native component coverage", () => {
  beforeEach(() => {
    homeMocks.timeline.assets = [];
    homeMocks.timeline.error = undefined;
    homeMocks.timeline.loading = false;
    homeMocks.timeline.sections = [];
  });

  it("ports the real PhotosHome empty-library contract to the RN host tree", async () => {
    const navigate = vi.fn<() => void>();
    const screen = render(
      <PhotosHome
        navigation={{ navigate } as never}
        route={{ params: { destination: "library" } } as never}
      />
    );
    await act(async () => undefined);

    expect(screen.getByText("Your library starts here")).toBeTruthy();
    expect(
      screen.getByText(
        "Camera-roll photographs appear instantly; hold any one to back it up."
      )
    ).toBeTruthy();
    expect(screen.queryByLabelText("Opening your library")).toBeNull();
  });

  it("shares deterministic empty, temporal, video, and place fixtures", () => {
    expect(makePhotosFixture("empty").sections).toHaveLength(0);
    expect(makePhotosFixture("one-day").sections).toHaveLength(1);
    expect(makePhotosFixture("multi-month").sections).toHaveLength(3);
    expect(
      new Set(
        makePhotosFixture("year-spanning").assets.map((asset) =>
          // Every fixture asset in this corpus carries a real capturedAt.
          asset.capturedAt!.slice(0, 4)
        )
      ).size
    ).toBe(3);
    expect(
      makePhotosFixture("video-mixed").assets.some(
        (asset) => asset.kind === "video"
      )
    ).toBe(true);
    expect(
      makePhotosFixture("place-tagged").assets.every(
        (asset) => asset.placeId !== undefined
      )
    ).toBe(true);
  });

  it("keeps the grain control on screen at rest, with no timer to wait out", async () => {
    // THE DEFECT THIS PINS: its predecessor appeared only while the member was
    // scrolling and withdrew 3.2s after the last gesture, and the feature
    // behind it was never found at all. Time passing must change nothing here.
    const clock = useFakeClock("2026-08-06T00:00:00.000Z");
    const onGrain =
      vi.fn<React.ComponentProps<typeof TimelineGrainControl>["onGrain"]>();
    const screen = render(
      <TimelineGrainControl grain="all" onGrain={onGrain} />
    );
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByRole("tab", { name: "All" }).props).toMatchObject({
      accessibilityState: { selected: true },
    });

    await act(async () => clock.advance(60_000));
    expect(screen.getAllByRole("tab")).toHaveLength(3);

    fireEvent.press(screen.getByRole("tab", { name: "Months" }));
    expect(onGrain).toHaveBeenCalledExactlyOnceWith("months");

    screen.rerender(<TimelineGrainControl grain="months" onGrain={onGrain} />);
    await act(async () => clock.advance(60_000));
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByRole("tab", { name: "Months" }).props).toMatchObject({
      accessibilityState: { selected: true },
    });
  });

  it("says plainly when a grain has no periods, rather than showing a blank surface", () => {
    // A library whose photographs are ALL undated: they exist, and they are in
    // All, but not one of them holds a position in the calendar — so Years has
    // nothing to summarise. ONE QUIET LINE, never a card standing in for a
    // period that does not exist, and never an empty void.
    // (The populated grains are asserted in `timeline-grains.test.ts`: the
    // cards are drawn by a FlashList, which cannot mount in this renderer.)
    const undatedOnly = makePhotosFixture("undated-mixed").sections.filter(
      (section) => section.day === "undated"
    );
    const screen = render(
      <PhotoGrainView
        sections={undatedOnly}
        grain="years"
        onOpenPeriod={vi.fn<
          React.ComponentProps<typeof PhotoGrainView>["onOpenPeriod"]
        >()}
      />
    );
    expect(
      screen.getByText(/carry no capture date, so they have no year or month/u)
    ).toBeTruthy();
  });

  it("maps scrub offsets to ratios and positions the month bubble", () => {
    const onScrub = vi.fn<React.ComponentProps<typeof ScrubRail>["onScrub"]>();
    const screen = render(
      <ScrubRail
        label="Aug 2026"
        position={0.75}
        top={20}
        bottom={120}
        onScrub={onScrub}
        onScrubEnd={vi.fn<
          React.ComponentProps<typeof ScrubRail>["onScrubEnd"]
        >()}
      />
    );
    const rail = screen.getByLabelText("Scrub the timeline by month");
    fireEvent(rail, "responderGrant", {
      nativeEvent: { locationY: 25 },
    });
    expect(onScrub).toHaveBeenCalledExactlyOnceWith(0.25);
    expect(
      screen
        .UNSAFE_getAllByType(View)
        .some((node) => StyleSheet.flatten(node.props.style)?.top === 75)
    ).toBe(true);
  });

  it("renders packed deterministic loading geometry", () => {
    const screen = render(<PhotosGridSkeleton rung={2} />);
    const progress = screen.getByLabelText("Opening your library");
    expect(progress.findAllByType(View).length).toBeGreaterThan(10);
    expect(screen.queryByText(/Opening your library…/u)).toBeNull();
  });

  it("publishes Select as a worded button with honest disabled state", () => {
    const onPress =
      vi.fn<React.ComponentProps<typeof PhotosSelectChip>["onPress"]>();
    const screen = render(
      <PhotosSelectChip disabled={false} onPress={onPress} />
    );
    const chip = screen.getByRole("button", { name: "Select" });
    expect(chip.props).toMatchObject({
      accessibilityState: { disabled: false },
    });
    expect(screen.getByText("Select")).toBeTruthy();
    fireEvent.press(chip);
    expect(onPress).toHaveBeenCalledOnce();
    screen.rerender(<PhotosSelectChip disabled onPress={onPress} />);
    expect(screen.getByRole("button", { name: "Select" }).props).toMatchObject({
      accessibilityState: { disabled: true },
    });
  });

  it("renders search no-hits copy and clears through its one action", () => {
    const onClear =
      vi.fn<React.ComponentProps<typeof PhotosSearchEmptyState>["onClear"]>();
    const screen = render(
      <PhotosSearchEmptyState query="Atlantis" onClear={onClear} />
    );
    expect(screen.getByText("Nothing matches “Atlantis”")).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "Clear search" }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("distinguishes the empty-query search state from no hits", () => {
    const screen = render(<PhotosSearchRestingState />);
    expect(screen.getByText("Nothing typed")).toBeTruthy();
    expect(screen.getByText("Search the whole library")).toBeTruthy();
    expect(screen.queryByText(/Nothing matches/u)).toBeNull();
  });

  it("changes viewer chrome by mode and keeps filmstrip selection in sync", () => {
    const colors = resolveTheme("light").colors;
    const noop = vi.fn<() => void>();
    const screen = render(
      <ViewerTopChrome
        colors={colors}
        insets={{ top: 0, bottom: 0, left: 0, right: 0 }}
        title="6 August 2026"
        meta="18:30"
        name="Backyard"
        editing={false}
        slideshow={false}
        onClose={noop}
        onLeaveSlideshow={noop}
        onOverflow={noop}
      />
    );
    fireEvent.press(screen.getByRole("button", { name: "More actions" }));
    expect(noop).toHaveBeenCalledOnce();
    screen.rerender(
      <ViewerTopChrome
        colors={colors}
        insets={{ top: 0, bottom: 0, left: 0, right: 0 }}
        title="Slideshow"
        meta="1 of 2"
        name="Backyard"
        editing={false}
        slideshow
        onClose={noop}
        onLeaveSlideshow={noop}
        onOverflow={noop}
      />
    );
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
    fireEvent.press(screen.getByRole("button", { name: "Leave" }));
    expect(noop).toHaveBeenCalledTimes(2);

    const assets = makePhotosFixture("video-mixed").assets;
    const strip = render(
      <PhotoFilmstrip
        assets={assets}
        currentId={assets[0]!.id}
        onSelect={noop}
      />
    );
    expect(
      strip.getByRole("button", {
        name: `Show photograph ${assets[0]!.filename}`,
      }).props
    ).toMatchObject({ accessibilityState: { selected: true } });
    strip.rerender(
      <PhotoFilmstrip
        assets={assets}
        currentId={assets[1]!.id}
        onSelect={noop}
      />
    );
    expect(
      strip.getByRole("button", {
        name: `Show photograph ${assets[1]!.filename}`,
      }).props
    ).toMatchObject({ accessibilityState: { selected: true } });
  });

  it("renders collection shelf emptiness and collapse state", () => {
    const action =
      vi.fn<React.ComponentProps<typeof CollectionShelfBody>["onAction"]>();
    const empty = "Mark photographs as favorites to find them here.";
    const screen = render(
      <CollectionShelfBody
        collapsed={false}
        empty={empty}
        hasTiles={false}
        onAction={action}
        title="Favorites"
      >
        <></>
      </CollectionShelfBody>
    );
    expect(screen.getByText(empty)).toBeTruthy();
    screen.rerender(
      <CollectionShelfBody
        collapsed
        empty={empty}
        hasTiles={false}
        onAction={action}
        title="Favorites"
      >
        <></>
      </CollectionShelfBody>
    );
    expect(screen.queryByText(empty)).toBeNull();
  });

  it("takes the refused permission state over with a recovery action", () => {
    const onRequest =
      vi.fn<React.ComponentProps<typeof PhotoAccessPanel>["onRequest"]>();
    const screen = render(
      <PhotoAccessPanel
        state="denied"
        canAskAgain
        readableCount={0}
        onRequest={onRequest}
      />
    );
    expect(
      screen.getByText("Photos cannot reach your camera roll")
    ).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "Allow access" }));
    expect(onRequest).toHaveBeenCalledOnce();
  });
});
