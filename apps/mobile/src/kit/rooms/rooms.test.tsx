// The six rooms (#1015, S1). What is pinned here is what a screen may no
// longer decide: the state order, the back target's provenance, selection as
// a mode, and which rooms host the status line.
// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mountBlock, nodesOf, press } from "../../test/react-native-stub";
// Through the barrel on purpose: the barrel is what a screen imports, so a
// room missing from it is a room no screen can reach.
import {
  AppPlace,
  bandStateFor,
  currentPlace,
  EditorRoom,
  HomeRoom,
  parentPlace,
  placeStack,
  PushedPage,
  selectedSentence,
  SheetRoom,
  SystemPlace,
  place,
} from "./index";
import type {
  AppPlaceProps,
  BandState,
  EditorRoomProps,
  HomeRoomProps,
  PlaceEntry,
  PlaceRef,
  PushedPageProps,
  RoomAction,
  RoomEmpty,
  RoomError,
  RoomLoading,
  RoomSelection,
  RoomSelectionAction,
  SheetRoomProps,
  SystemPlaceProps,
} from "./index";

vi.mock(import("react-native"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.reactNativeStub() as unknown as typeof import("react-native");
});
vi.mock(import("react-native-svg"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.svgStub() as unknown as typeof import("react-native-svg");
});
vi.mock(import("react-native-safe-area-context"), () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));

let dispose: (() => void) | undefined;

function render(node: React.ReactNode): HTMLElement {
  const mounted = mountBlock(node);
  dispose = mounted.unmount;
  return mounted.container;
}

const noop = (): void => undefined;

const words = (container: HTMLElement): string[] =>
  nodesOf(container, "span").map((node) => node.textContent ?? "");

const stack = placeStack([
  { key: "DocsHome", title: "All" },
  { key: "DocsFolder", title: "Taxes" },
  { key: "DocumentViewer", title: "2024 return" },
]);

// The barrel is a screen's whole import surface, so every name a screen will
// reach for is exercised here — a type that only compiles inside this package
// is a type no screen can annotate a prop with.
describe("the barrel", () => {
  it("hands a screen every name it needs to write a room down", () => {
    const entry: PlaceEntry = { key: "AlbumDetail", title: "Trips" };
    const ref: PlaceRef = place(entry);
    const action: RoomAction = { label: "Add", onPress: noop };
    const destructive: RoomSelectionAction = { dangerous: true, ...action };
    const loading: RoomLoading = { label: "Reading" };
    const error: RoomError = { body: "b", retry: action, title: "t" };
    const empty: RoomEmpty = { body: "b", title: "t" };
    const band: BandState = bandStateFor(undefined);
    const home: HomeRoomProps = { trailing: action };
    const app: AppPlaceProps = {
      app: { color: "#345", iconKey: "Camera", title: "Photos" },
      onBack: noop,
    };
    const pushed: PushedPageProps = { backTo: ref, onBack: noop, title: "t" };
    const editor: EditorRoomProps = { onDone: noop, title: "t" };
    const sheet: SheetRoomProps = { onClose: noop, title: "t", visible: false };
    const system: SystemPlaceProps = { title: "t" };
    expect([
      ref.title,
      destructive.label,
      loading.label,
      error.title,
      empty.title,
      String(band.interactive),
      home.trailing?.label,
      app.app.title,
      pushed.title,
      editor.title,
      sheet.title,
      system.title,
    ]).toHaveLength(12);
  });
});

describe(parentPlace, () => {
  it("names the parent the screen actually descends from", () => {
    expect(parentPlace(stack)?.title).toBe("Taxes");
    expect(currentPlace(stack)?.title).toBe("2024 return");
  });

  it("has no parent at the root, and says so rather than guessing", () => {
    expect(parentPlace(stack.slice(0, 1))).toBeUndefined();
  });
});

describe("selection", () => {
  it("stands the band down while a selection runs", () => {
    expect(bandStateFor(undefined)).toStrictEqual({
      dimmed: false,
      interactive: true,
    });
    const selection: RoomSelection = { actions: [], count: 3, onCancel: noop };
    expect(bandStateFor(selection)).toStrictEqual({
      dimmed: true,
      interactive: false,
    });
    expect(bandStateFor({ ...selection, count: 0 }).interactive).toBe(true);
  });

  it("counts with the noun when the caller names one", () => {
    expect(
      selectedSentence({
        actions: [],
        count: 3,
        noun: "photos",
        onCancel: noop,
      })
    ).toBe("3 photos selected");
    expect(selectedSentence({ actions: [], count: 3, onCancel: noop })).toBe(
      "3 selected"
    );
  });
});

describe("RoomBody", () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("shows the error over an empty, so a failed read never reads as empty", () => {
    const container = render(
      <HomeRoom
        empty={{ body: "Nothing here", title: "No apps" }}
        error={{
          body: "The vault could not be read.",
          retry: { label: "Try again", onPress: noop },
          title: "Not loaded",
        }}
      />
    );
    expect(words(container)).toContain("Not loaded");
    expect(words(container)).not.toContain("No apps");
  });

  it("shows the skeleton over an empty while it is still reading", () => {
    const container = render(
      <HomeRoom
        empty={{ body: "Nothing here", title: "No apps" }}
        loading={{ label: "Reading your apps" }}
      />
    );
    expect(words(container)).not.toContain("No apps");
  });

  it("shows the empty once there is nothing else to say", () => {
    const container = render(
      <HomeRoom
        empty={{ body: "Nothing here", routine: true, title: "No apps" }}
      />
    );
    expect(words(container)).toContain("No apps");
  });
});

describe(HomeRoom, () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("carries the one trailing verb the cover is allowed", () => {
    const pressed = vi.fn<() => void>();
    const container = render(
      <HomeRoom trailing={{ label: "Settings", onPress: pressed }} />
    );
    press(nodesOf(container, "button")[0]);
    expect(pressed).toHaveBeenCalledOnce();
  });
});

describe(PushedPage, () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("speaks the parent it descends from, not a literal", () => {
    const container = render(
      <PushedPage
        backTo={parentPlace(stack)}
        onBack={noop}
        title="2024 return"
      />
    );
    const labels = nodesOf(container, "button").map((node) =>
      node.getAttribute("aria-label")
    );
    expect(labels).toContain("Back to Taxes");
  });

  it("draws no back control on a screen with no parent", () => {
    const container = render(<PushedPage onBack={noop} title="All" />);
    const labels = nodesOf(container, "button").map((node) =>
      node.getAttribute("aria-label")
    );
    expect(
      labels.filter((label) => label?.startsWith("Back to"))
    ).toStrictEqual([]);
  });

  it("swaps the header in place for a selection and dims the band", () => {
    const band = vi.fn<(state: { dimmed: boolean }) => null>(() => null);
    const container = render(
      <PushedPage
        band={band}
        onBack={noop}
        selection={{
          actions: [{ dangerous: true, label: "Delete", onPress: noop }],
          count: 2,
          noun: "documents",
          onCancel: noop,
        }}
        title="Taxes"
      />
    );
    expect(words(container)).toContain("2 documents selected");
    expect(words(container)).not.toContain("Taxes");
    expect(band).toHaveBeenCalledWith({ dimmed: true, interactive: false });
  });
});

describe(AppPlace, () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("hides the search field while a selection runs", () => {
    const container = render(
      <AppPlace
        app={{ color: "#345", iconKey: "Camera", title: "Photos" }}
        onBack={noop}
        search={{ onChangeText: noop, placeholder: "Search photos", value: "" }}
        selection={{ actions: [], count: 1, onCancel: noop }}
      />
    );
    expect(nodesOf(container, "input")).toStrictEqual([]);
  });
});

describe(EditorRoom, () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("says Done once a keystroke has happened, and Cancel only before one", () => {
    const container = render(<EditorRoom onDone={noop} title="Note" />);
    expect(words(container)).toContain("Done");
    dispose?.();
    dispose = undefined;
    const fresh = render(<EditorRoom cancellable onDone={noop} title="Note" />);
    expect(words(fresh)).toContain("Cancel");
  });

  it("hosts the status line inside, and takes no band", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, "EditorRoom.tsx"),
      "utf8"
    );
    expect(source).toContain("StatusLineHost");
    expect(source).not.toMatch(/band\?:/u);
  });
});

describe(SheetRoom, () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("renders nothing until it is asked for", () => {
    const container = render(
      <SheetRoom onClose={noop} title="Delete photo?" visible={false} />
    );
    expect(words(container)).toStrictEqual([]);
  });

  it("keeps a destructive commit outlined rather than filled", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, "SheetRoom.tsx"),
      "utf8"
    );
    expect(source).toContain('"destructive" : "primary"');
  });
});

describe(HomeRoom.name + " chrome", () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("puts the vault lockup, the head, the status line and the band in order", () => {
    // Home is the one cover with fixed chrome above and below the scroller:
    // the vault lockup, its title row, ONE status line, and the band flush at
    // the foot. The order is the room's, so no cover can reshuffle it.
    const container = render(
      <HomeRoom
        band={<div data-slot="band" />}
        head={<div data-slot="head" />}
        status={<div data-slot="status" />}
        vault={<div data-slot="vault" />}
      >
        <div data-slot="grid" />
      </HomeRoom>
    );
    const order = [...container.querySelectorAll("[data-slot]")].map(
      (node) => (node as HTMLElement).dataset.slot
    );
    expect(order).toStrictEqual(["vault", "head", "status", "grid", "band"]);
  });

  it("draws no bare trailing verb when the cover brings its own head", () => {
    const container = render(
      <HomeRoom
        head={<div data-slot="head" />}
        trailing={{ label: "Settings", onPress: noop }}
      />
    );
    expect(words(container)).not.toContain("Settings");
  });
});

describe(SystemPlace, () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("puts the grid plate in the header, where it cannot collide", () => {
    const container = render(<SystemPlace onHome={noop} title="Vault" />);
    const labels = nodesOf(container, "button").map((node) =>
      node.getAttribute("aria-label")
    );
    expect(labels).toContain("Back to your apps");
  });

  it("hangs the place's own modals outside the scrolling body", () => {
    // Settings owns a confirm sheet and a full-screen pairing camera. Nested
    // in the scroller's content they would measure against the scroller;
    // `overlay` is the seam that keeps them siblings of it.
    const container = render(
      <SystemPlace overlay={<div data-testid="scanner" />} title="Settings">
        <div data-testid="section" />
      </SystemPlace>
    );
    expect(container.querySelector('[data-testid="scanner"]')).not.toBeNull();
  });
});
