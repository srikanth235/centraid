// The band is on every Photos surface, and a live selection stands it down.
//
// Rewritten for the rooms (#1015 Wave 2): the frame is `AppPlace` on a band
// destination and `PushedPage` over one, so what is pinned here is what the
// frame still decides for itself — which tab is lit, where the capsule goes,
// and how a selection reaches the room — plus D5, which the old frame broke:
// the band is DIMMED AND DEAF under a selection, not merely replaced, because
// a live band under a foot bar is two bars and a tap aimed at Delete
// navigated away (audit B8).
// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildSelectionActions } from "@centraid/blueprints/apps/_shared/selection-engine";

import { hapticsStub } from "../../test/haptics-stub";
import { mountBlock, nodesOf, press } from "../../test/react-native-stub";
import PhotosScreen from "./PhotosScreen";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn<(...args: unknown[]) => void>(),
  popTo: vi.fn<(...args: unknown[]) => void>(),
}));

// The vault lockup every app frame draws. Stubbed because this file's claim is
// PhotosScreen's own composition, not the header's: mounting the real one
// pulls the active-vault read and its native storage into a plain jsdom run.
vi.mock(import("expo-haptics"), () => hapticsStub());
vi.mock(
  import("../../screens/home/VaultBar"),
  () => ({ default: () => null }) as never
);

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
vi.mock(
  import("@react-navigation/native"),
  () =>
    ({
      useNavigation: () => ({ navigate: mocks.navigate, popTo: mocks.popTo }),
    }) as never
);
// The app's identity chip is resolved through the gateway module, which pulls
// expo-crypto; the mark's colour is not what this file asserts.
vi.mock(
  import("../../lib/gateway"),
  () =>
    ({
      resolveAppMeta: () => ({ color: "#345", iconKey: "Camera" }),
    }) as never
);
// The band owner's latch reads through the app store, which reaches the Expo
// module runtime; this run is plain jsdom.
vi.mock(
  import("../../storage"),
  () =>
    ({
      Store: {
        get: <T,>(_key: string, fallback: T): T => fallback,
        hydrate: async () => "app",
        set: () => undefined,
        subscribe: () => () => undefined,
      },
    }) as never
);
vi.mock(import("./PhotosMoreSheet"), () => ({ default: () => null }) as never);

let container: HTMLElement | undefined;
let dispose: (() => void) | undefined;

function render(node: React.ReactNode): void {
  const mounted = mountBlock(node);
  container = mounted.container;
  dispose = mounted.unmount;
}

function control(label: string): HTMLElement | undefined {
  return nodesOf(container!, "button").find(
    (node) => node.getAttribute("aria-label") === label
  );
}

/** A control by its visible word, which is how a Button is labelled. */
function verb(word: string): HTMLElement | undefined {
  return nodesOf(container!, "button").find(
    (node) => node.textContent === word
  );
}

const selection = (readOnlyReason: string | null) => ({
  addToAlbum: { run: vi.fn<() => void>() },
  copyLabel: "Copy to Family",
  count: 2,
  download: { run: vi.fn<() => void>() },
  favorite: { run: vi.fn<() => void>() },
  onCancel: vi.fn<() => void>(),
  readOnlyReason,
  share: { run: vi.fn<() => void>() },
  shelf: "normal" as const,
  trash: { run: vi.fn<() => void>() },
});

function fresh(): void {
  mocks.navigate.mockClear();
  mocks.popTo.mockClear();
}

function clear(): void {
  dispose?.();
  dispose = undefined;
  container = undefined;
}

describe("the band is on every Photos surface", () => {
  beforeEach(fresh);
  afterEach(clear);

  it("renders the four destinations and the frame's Home capsule", () => {
    render(
      <PhotosScreen route="places" title="Places">
        {null}
      </PhotosScreen>
    );
    for (const label of ["Library", "Collections", "Search", "More"])
      expect(control(label)).toBeTruthy();
    expect(control("Home")).toBeTruthy();
  });

  it("SABOTAGE: the capsule POPS home, never back and never navigate", () => {
    render(
      <PhotosScreen route="collections" title="Collections">
        {null}
      </PhotosScreen>
    );
    press(control("Home"));
    expect(mocks.popTo).toHaveBeenCalledWith("Home");
    // `navigate` PUSHES a second Home; UIKit then presents it as a card sheet.
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("SABOTAGE: a destination pops to the stack's home, never pushes a second", () => {
    render(
      <PhotosScreen route="places" title="Places">
        {null}
      </PhotosScreen>
    );
    press(control("Library"));
    expect(mocks.popTo).toHaveBeenCalledWith("PhotosHome", {
      destination: "library",
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("lights the tab the ROUTE sits under, which no screen writes down", () => {
    render(
      <PhotosScreen route="album" title="Trips">
        {null}
      </PhotosScreen>
    );
    // An album is under Collections, though it is not Collections itself.
    expect(control("Collections")?.getAttribute("aria-selected")).toBe("true");
    expect(control("Library")?.getAttribute("aria-selected")).toBe("false");
  });

  it("names the place a pushed surface descends from, computed", () => {
    render(
      <PhotosScreen route="placeDetail" title="Lisbon">
        {null}
      </PhotosScreen>
    );
    // Not "Photos": a place's detail is opened from the Places shelf.
    expect(control("Back to Places")).toBeTruthy();
  });
});

describe("a live selection stands the band down", () => {
  beforeEach(fresh);
  afterEach(clear);

  it("draws the engine's verbs in the room's one foot row", () => {
    const props = selection(null);
    render(
      <PhotosScreen route="library" selection={props} title="Library">
        {null}
      </PhotosScreen>
    );
    const labels = buildSelectionActions(props).map((action) => action.label);
    expect(labels).toHaveLength(5);
    for (const label of labels) expect(verb(label)).toBeTruthy();
    expect(container!.textContent).toContain("2 photographs selected");
  });

  // D5, and audit B8: the band used to be REPLACED, which left the Home
  // capsule live under a foot bar on every other surface that kept it.
  it("SABOTAGE: the band is deaf while a selection runs", () => {
    const props = selection(null);
    render(
      <PhotosScreen route="library" selection={props} title="Library">
        {null}
      </PhotosScreen>
    );
    const home = control("Home");
    expect(home).toBeTruthy();
    expect(home?.getAttribute("aria-disabled")).toBe("true");
    press(home);
    expect(mocks.popTo).not.toHaveBeenCalled();
  });

  it("SABOTAGE: a disabled write target's handler does not fire", () => {
    const props = selection("This vault is read-only for you.");
    render(
      <PhotosScreen route="library" selection={props} title="Library">
        {null}
      </PhotosScreen>
    );
    const favorite = verb("Favorite");
    expect(favorite?.getAttribute("aria-disabled")).toBe("true");
    press(favorite);
    expect(props.favorite.run).not.toHaveBeenCalled();
    // Never the only place the reason lives; it is the control's hint too.
    expect(container!.textContent).toContain(
      "This vault is read-only for you."
    );
  });

  it("leaves the mode through the room's one word", () => {
    const props = selection(null);
    render(
      <PhotosScreen route="library" selection={props} title="Library">
        {null}
      </PhotosScreen>
    );
    press(verb("Cancel"));
    expect(props.onCancel).toHaveBeenCalledWith();
  });
});
