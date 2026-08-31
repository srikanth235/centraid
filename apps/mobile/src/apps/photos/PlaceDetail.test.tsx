// @vitest-environment jsdom
// One place's photographs (#781) — the screen a Places card opens.
//
// What this file owns that `places-model.test.ts` cannot: the head's sentence,
// the empty state's, and the two exits. Specifically:
//
//   1. THE COUNT IS THIS PLACE'S, and it is a sentence, not a numeral with a
//      noun bolted on — "1 photograph", never "1 photographs".
//   2. AN EMPTY PLACE SAYS WHICH PLACE IS EMPTY. A bare "Nothing here" would
//      leave a member unable to tell an empty place from a screen that failed
//      to load one.
//   3. THE BACK CHEVRON STAYS AND GOES BACK. `PlacesView` is this screen's
//      genuine parent (the split `DuplicatesShelf` states: the shell owns the
//      band, the screen owns its own head), so the chevron must pop rather
//      than push a second copy of the shelf.
//   4. TAPPING A PHOTOGRAPH OPENS THAT PHOTOGRAPH in the lightbox.
//
// `PhotoTimeline` is stubbed to render the ids it was handed: it draws through
// FlashList, which cannot mount in this renderer, and its own grid contract is
// owned elsewhere. Rendering the ids keeps the assertion an OUTCOME — which
// photographs reached the timeline — rather than a claim about a mock call.
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makePhotosFixture } from "./photos-fixtures";
import PlaceDetail from "./PlaceDetail";

type ReactNative = typeof import("react-native");
type ThemeModule = typeof import("../../kit/theme");
type UseReplicaQueryModule = typeof import("../../kit/hooks/useReplicaQuery");
type TimelineSourceModule = typeof import("./timeline-source");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  assets: [] as unknown[],
  colors: {
    accentText: "#mock-accent-text",
    line: "#mock-line",
    text: "#mock-text",
    textSoft: "#mock-text-soft",
  },
  places: [] as unknown[],
  /** Every `session.write` this screen fired, in order. */
  writes: [] as unknown[],
  /** Whether the replica has a session at all — a screen with none must not
   *  offer a control that cannot land (§1: no silent no-ops). */
  session: true,
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
    StyleSheet: {
      create: <T,>(styles: T): T => styles,
    },
    View: ({ children }: { children?: React.ReactNode }) =>
      element("div", { children }),
  } as unknown as Partial<ReactNative>;
});

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
      // The naming input, as an ordinary DOM input: `onChangeText` is the
      // native contract and `input`/`change` is how this renderer expresses it.
      TextInput: ({
        accessibilityLabel,
        onChangeText,
        placeholder,
        value,
      }: {
        accessibilityLabel?: string;
        onChangeText?: (text: string) => void;
        placeholder?: string;
        value?: string;
      }) =>
        React.createElement("input", {
          "aria-label": accessibilityLabel,
          onChange: (event: { target: { value: string } }) =>
            onChangeText?.(event.target.value),
          placeholder,
          value: value ?? "",
        }),
    }) as never
);

vi.mock(
  import("../../kit/replica/ReplicaProvider"),
  () =>
    ({
      useReplica: () => ({
        session: mocks.session
          ? {
              write: (app: string, request: unknown) => {
                mocks.writes.push({ app, request });
                return Promise.resolve({ status: "executed" });
              },
            }
          : undefined,
      }),
    }) as never
);

vi.mock(
  import("../../kit/replica/write-outcome"),
  () =>
    ({
      surfaceWriteFailure: () => undefined,
      surfaceWriteOutcome: () => true,
    }) as never
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
      useReplicaQuery: (): { rows: unknown[] } => ({ rows: mocks.places }),
    }) as unknown as Partial<UseReplicaQueryModule>
);

vi.mock(
  import("./timeline-source"),
  () =>
    ({
      usePhotoTimeline: () => ({ assets: mocks.assets }),
    }) as unknown as Partial<TimelineSourceModule>
);

vi.mock(import("./PhotoTimeline"), async () => {
  const ReactModule = await import("react");
  return {
    default: ({
      sections,
      onOpen,
    }: {
      sections: Array<{ assets: Array<{ id: string }> }>;
      onOpen: (asset: { id: string }) => void;
    }) =>
      ReactModule.createElement(
        "div",
        null,
        sections
          .flatMap((section) => section.assets)
          .map((asset) =>
            ReactModule.createElement(
              "button",
              {
                key: asset.id,
                onClick: () => onOpen(asset),
                type: "button",
              },
              asset.id
            )
          )
      ),
  } as never;
});

vi.mock(import("./PhotosScreen"), async () => {
  const ReactModule = await import("react");
  return {
    default: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  } as never;
});

// The rows carry `geo_lat`/`geo_lng` — the columns `core_place` actually
// ships and the replica hands over raw (#787).
const [TAHOE_PHOTO, HOME_PHOTO] = makePhotosFixture("place-tagged").assets;
const PLACE_ROWS = [
  {
    place_id: "place-tahoe",
    name: "Lake Tahoe",
    geo_lat: 39.096_8,
    geo_lng: -120.032_4,
  },
  {
    place_id: "place-home",
    name: "Home",
    geo_lat: 37.44,
    geo_lng: -122.14,
  },
];
const TAHOE_KEY = "39.1:-120.0";

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let navigate: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
let goBack: ReturnType<typeof vi.fn<() => void>>;

function renderDetail(placeKey: string, placeName: string): void {
  navigate = vi.fn<(...args: unknown[]) => void>();
  goBack = vi.fn<() => void>();
  act(() => {
    root = createRoot(container!);
    root.render(
      <PlaceDetail
        navigation={{ goBack, navigate } as never}
        route={{ params: { placeKey, placeName } } as never}
      />
    );
  });
}

function click(button: Element | undefined): void {
  expect(button).toBeDefined();
  act(() => button!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("one place's photographs, on the phone seat", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mocks.places = PLACE_ROWS;
    mocks.assets = [
      TAHOE_PHOTO,
      { ...TAHOE_PHOTO, id: "place-tahoe-2" },
      HOME_PHOTO,
    ];
    mocks.writes = [];
    mocks.session = true;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it("counts only the photographs taken at this place", () => {
    renderDetail(TAHOE_KEY, "Lake Tahoe");
    expect(container!.textContent).toContain("2 photographs");
  });

  it("says one photograph in the singular", () => {
    renderDetail("37.4:-122.1", "Home");
    expect(container!.textContent).toContain("1 photograph");
    expect(container!.textContent).not.toContain("1 photographs");
  });

  it("hands the timeline this place's photographs and no others", () => {
    renderDetail(TAHOE_KEY, "Lake Tahoe");
    expect(
      Array.from(container!.querySelectorAll("button"))
        .map((button) => button.textContent)
        .filter((text) => text !== "")
    ).toStrictEqual([TAHOE_PHOTO!.id, "place-tahoe-2"]);
  });

  it("names the empty place rather than saying nothing is here", () => {
    renderDetail("0.0:0.0", "Lake Tahoe");
    expect(container!.textContent).toContain(
      "No photographs at Lake Tahoe yet."
    );
    expect(container!.textContent).toContain("0 photographs");
  });

  it("pops back to Places instead of pushing another copy of the shelf", () => {
    renderDetail(TAHOE_KEY, "Lake Tahoe");
    click(
      Array.from(container!.querySelectorAll("button")).find(
        (button) => button.getAttribute("aria-label") === "Back to Places"
      )
    );
    expect(goBack).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("opens the photograph that was tapped", () => {
    renderDetail(TAHOE_KEY, "Lake Tahoe");
    click(
      Array.from(container!.querySelectorAll("button")).find(
        (button) => button.textContent === "place-tahoe-2"
      )
    );
    expect(navigate).toHaveBeenCalledExactlyOnceWith("PhotoLightbox", {
      assetId: "place-tahoe-2",
    });
  });
});

// THE NAMING CONVERSATION (#816) — the phone is the primary surface for
// it, because the phone is where the photographs were taken.
//
// A place minted from GPS carries its own coordinate as a label, and every
// surface phrases it as "A place with no name yet" rather than printing the
// digits. This screen is where that question gets asked: the ask appears
// exactly where the fallback phrase appears, one tap declares home, and a
// place the member already named is never asked again.
describe("naming this place, on the phone seat", () => {
  const COORD_ROWS = [
    {
      place_id: "place-coord",
      name: "39.0968, -120.0324",
      geo_lat: 39.096_8,
      geo_lng: -120.032_4,
    },
  ];

  const labelled = (label: string): HTMLElement | undefined =>
    Array.from(container!.querySelectorAll("button, input")).find(
      (node) => node.getAttribute("aria-label") === label
    ) as HTMLElement | undefined;

  /** Type into the naming field. Through the prototype's own value setter, the
   *  way `ShareSheet.test.tsx` does it: React tracks the node's value and
   *  ignores an `input` event whose value it believes it already applied. */
  function type(text: string): void {
    const field = labelled("Place name") as HTMLInputElement | undefined;
    expect(field).toBeDefined();
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(field, text);
      field!.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mocks.writes = [];
    mocks.session = true;
    mocks.places = COORD_ROWS;
    mocks.assets = [{ ...TAHOE_PHOTO, placeId: "place-coord" }];
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it("asks for a name where the fallback phrase stands, and prints no coordinate", () => {
    renderDetail(TAHOE_KEY, "A place with no name yet");
    expect(labelled("Name this place")).toBeDefined();
    expect(labelled("This is home")).toBeDefined();
    expect(container!.textContent).not.toContain("39.0968");
  });

  it("asks nothing of a place the member already named", () => {
    mocks.places = PLACE_ROWS;
    mocks.assets = [TAHOE_PHOTO];
    renderDetail(TAHOE_KEY, "Lake Tahoe");
    expect(labelled("Name this place")).toBeUndefined();
    expect(labelled("This is home")).toBeUndefined();
  });

  it("writes the name the member typed, for the place row this screen shows", () => {
    renderDetail(TAHOE_KEY, "A place with no name yet");
    click(labelled("Name this place"));
    type("  Grandma's house  ");
    click(labelled("Save place name"));
    expect(mocks.writes).toStrictEqual([
      {
        app: "photos",
        request: {
          action: "name-place",
          input: { place_id: "place-coord", name: "Grandma's house" },
        },
      },
    ]);
  });

  it("declares home in one tap, with the kind every relative phrase anchors on", () => {
    renderDetail(TAHOE_KEY, "A place with no name yet");
    click(labelled("This is home"));
    expect(mocks.writes).toStrictEqual([
      {
        app: "photos",
        request: {
          action: "name-place",
          input: { place_id: "place-coord", name: "Home", kind: "home" },
        },
      },
    ]);
  });

  // RETROACTIVE, BY CONSTRUCTION. The head reads the row, not the route
  // parameter the card handed over — so the moment the replica pushes the named
  // row this screen says the member's own name for the place. A pinned
  // parameter would leave the fallback standing over a place just named here.
  it("prints the name the row carries now, not the one the card was tapped with", () => {
    mocks.places = [{ ...COORD_ROWS[0], name: "Grandma's house" }] as unknown[];
    renderDetail(TAHOE_KEY, "A place with no name yet");
    expect(container!.textContent).toContain("Grandma's house");
    expect(container!.textContent).not.toContain("A place with no name yet");
    expect(labelled("Name this place")).toBeUndefined();
  });

  it("writes nothing when there is no session to write through", () => {
    mocks.session = false;
    renderDetail(TAHOE_KEY, "A place with no name yet");
    click(labelled("This is home"));
    expect(mocks.writes).toStrictEqual([]);
  });

  it("writes nothing for a blank name", () => {
    renderDetail(TAHOE_KEY, "A place with no name yet");
    click(labelled("Name this place"));
    type("   ");
    click(labelled("Save place name"));
    expect(mocks.writes).toStrictEqual([]);
  });
});
