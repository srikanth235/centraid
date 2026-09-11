// @vitest-environment jsdom
// R-NY-1 (#1015): the Home band on a place root. It draws with the place's own
// tab active, draws nothing on a sub-page pushed inside a place, and a tab
// press resets the ROOT stack to Home + one place — never deeper, never a
// second Home. `band-navigation.test.ts` holds the arithmetic; this holds the
// wiring from a press to the root navigator.
import fs from "node:fs";
import path from "node:path";

import {
  NavigationContext,
  NavigationRouteContext,
} from "@react-navigation/native";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StackRoute } from "./band-navigation";
import PlaceBand from "./PlaceBand";
import type { PlaceId } from "./places";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock(import("@react-navigation/native"), async () => {
  const ReactModule = await import("react");
  return {
    CommonActions: {
      reset: (state: unknown) => ({ payload: state, type: "RESET" }),
    },
    NavigationContext: ReactModule.createContext<unknown>(undefined),
    NavigationRouteContext: ReactModule.createContext<unknown>(undefined),
  } as never;
});

// The band's own drawing is HomeBand's; this stands one button per tab.
vi.mock(import("./HomeBand"), async () => {
  const ReactModule = await import("react");
  return {
    default: ({
      active,
      onSelect,
    }: {
      active: string;
      onSelect: (target: string) => void;
    }) =>
      ReactModule.createElement(
        "nav",
        { "data-active": active },
        ["home", "stats", "data", "more"].map((tab) =>
          ReactModule.createElement("button", {
            "data-tab": tab,
            key: tab,
            onClick: () => onSelect(tab),
            type: "button",
          })
        )
      ),
  } as never;
});

interface FakeNavigator {
  dispatched: { payload: unknown }[];
  dispatch: (action: { payload: unknown }) => void;
  getParent: () => FakeNavigator | undefined;
  getState: () => { index: number; routes: StackRoute[] };
}

function navigator(
  routes: StackRoute[],
  parent?: FakeNavigator
): FakeNavigator {
  const dispatched: { payload: unknown }[] = [];
  return {
    dispatch: (action) => dispatched.push(action),
    dispatched,
    getParent: () => parent,
    getState: () => ({ index: routes.length - 1, routes }),
  };
}

const home: StackRoute = { key: "home-1", name: "Home" };

let host: HTMLDivElement;
let root: Root;

function mount(
  place: PlaceId,
  navigation?: FakeNavigator,
  routeKey?: string
): void {
  const node = <PlaceBand place={place} />;
  act(() =>
    root.render(
      navigation && routeKey ? (
        <NavigationContext.Provider value={navigation as never}>
          <NavigationRouteContext.Provider
            value={{ key: routeKey, name: "screen" } as never}
          >
            {node}
          </NavigationRouteContext.Provider>
        </NavigationContext.Provider>
      ) : (
        node
      )
    )
  );
}

function band(): HTMLElement | null {
  return host.querySelector("nav");
}

function press(tab: string): void {
  act(() => (host.querySelector(`[data-tab="${tab}"]`) as HTMLElement).click());
}

describe(PlaceBand, () => {
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("draws the Home band with its own tab active on a root-stack place", () => {
    mount("stats", navigator([home, { key: "ins", name: "Insights" }]), "ins");
    expect(band()?.dataset.active).toBe("stats");
  });

  it("draws on a place alone at the bottom of its own stack", () => {
    const rootStack = navigator([home, { key: "set", name: "Settings" }]);
    mount(
      "storage",
      navigator([{ key: "ps", name: "PhoneStorage" }], rootStack),
      "ps"
    );
    expect(band()?.dataset.active).toBe("storage");
  });

  it("draws nothing on a sub-page pushed inside a place", () => {
    // Settings → On this phone: the sub-page keeps its back key instead.
    const rootStack = navigator([home, { key: "set", name: "Settings" }]);
    mount(
      "storage",
      navigator(
        [
          { key: "sh", name: "SettingsHome" },
          { key: "ps", name: "PhoneStorage" },
        ],
        rootStack
      ),
      "ps"
    );
    expect(band()).toBeNull();
  });

  it("draws nothing on a place pushed from a place (Vault → Copies)", () => {
    mount(
      "devices",
      navigator([
        home,
        { key: "data", name: "Data" },
        { key: "dev", name: "Devices" },
      ]),
      "dev"
    );
    expect(band()).toBeNull();
  });

  it("draws nothing outside a navigator, where no tab could go", () => {
    mount("stats");
    expect(band()).toBeNull();
  });

  it("switches tabs on the ROOT stack, to Home + one place", () => {
    const rootStack = navigator([home, { key: "set", name: "Settings" }]);
    const settings = navigator(
      [{ key: "ps", name: "PhoneStorage" }],
      rootStack
    );
    mount("storage", settings, "ps");
    press("data");
    expect(settings.dispatched).toStrictEqual([]);
    expect(rootStack.dispatched).toStrictEqual([
      {
        payload: { index: 1, routes: [home, { name: "Data" }] },
        type: "RESET",
      },
    ]);
  });

  it("pops to Home for the Home tab", () => {
    const rootStack = navigator([home, { key: "dev", name: "Devices" }]);
    mount("devices", rootStack, "dev");
    press("home");
    expect(rootStack.dispatched).toStrictEqual([
      { payload: { index: 0, routes: [home] }, type: "RESET" },
    ]);
  });

  it("returns to the one Home with the all-apps sheet for More", () => {
    const rootStack = navigator([home, { key: "ins", name: "Insights" }]);
    mount("stats", rootStack, "ins");
    press("more");
    expect(rootStack.dispatched).toStrictEqual([
      {
        payload: {
          index: 0,
          routes: [{ ...home, params: { sheet: "all-apps" } }],
        },
        type: "RESET",
      },
    ]);
  });

  it("does nothing for the tab already active", () => {
    const rootStack = navigator([home, { key: "ins", name: "Insights" }]);
    mount("stats", rootStack, "ins");
    press("stats");
    expect(rootStack.dispatched).toStrictEqual([]);
  });
});

// Every place root takes its frame chrome from `usePlaceFrame`: the band when
// it stands on Home, a back key when pushed. Keyed by place id, so a new
// place is a typecheck failure here until its root file is named. A text
// sweep, as `rooms.test.tsx` reads `SheetRoom.tsx`: the screens' own tests
// stand the frame down, so this is where the wiring is held.
const PLACE_ROOTS: Readonly<Record<Exclude<PlaceId, "home">, string>> = {
  autos: "../../apps/automations/Automations.tsx",
  conn: "../connectors/Connectors.tsx",
  data: "../data/Data.tsx",
  devices: "../devices/Devices.tsx",
  gateway: "../SystemOnPhone.tsx",
  notifs: "../Approvals.tsx",
  settings: "../Settings.tsx",
  stats: "../../apps/insights/Insights.tsx",
  storage: "../PhoneStorage.tsx",
};

describe("the place roots", () => {
  it.each(Object.entries(PLACE_ROOTS))(
    "%s's root takes its band or its back key from its own frame",
    (id, file) => {
      const source = fs.readFileSync(
        path.resolve(import.meta.dirname, file),
        "utf8"
      );
      // Needs you hands its room the band directly; its back key is lane A's.
      expect(source).toContain(
        id === "notifs"
          ? `band={<PlaceBand place="${id}" />}`
          : `usePlaceFrame("${id}")`
      );
    }
  );
});
