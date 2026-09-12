// What a Locker route may no longer say about itself (#1015 Wave 2, audit B7).

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  isLockerPlace,
  lockerDestinationFor,
  lockerParentPlace,
} from "./locker-places";

describe(lockerDestinationFor, () => {
  it("lights the band tab a route sits under", () => {
    expect(lockerDestinationFor("items")).toBe("items");
    expect(lockerDestinationFor("watch")).toBe("watch");
    expect(lockerDestinationFor("item")).toBe("items");
    expect(lockerDestinationFor("edit")).toBe("items");
  });

  it("lights none of the four for a More surface", () => {
    expect(lockerDestinationFor("trash")).toBe("more");
    expect(lockerDestinationFor("access")).toBe("more");
    expect(lockerDestinationFor("export")).toBe("more");
  });

  it("keeps the wall standing in Items' own place", () => {
    expect(isLockerPlace("lock")).toBe(true);
    expect(isLockerPlace("item")).toBe(false);
  });
});

describe(lockerParentPlace, () => {
  // The place is named `Items` since #1015 (locker/findings #6): the band tab
  // and the bar above it used to name the same root two different things, so
  // "Back to Locker" was the app's name standing in for a place inside it.
  it("names the parent a pushed surface actually descends from", () => {
    expect(lockerParentPlace("item").title).toBe("Items");
    expect(lockerParentPlace("edit").title).toBe("Items");
    expect(lockerParentPlace("editNew").title).toBe("Items");
  });

  it("sends a More surface back to the app, which is where it came from", () => {
    expect(lockerParentPlace("trash").title).toBe("Locker");
    expect(lockerParentPlace("access").title).toBe("Locker");
  });
});

describe("the Locker tree", () => {
  const dir = import.meta.dirname;
  const sources = readdirSync(dir)
    .filter((name) => name.endsWith(".tsx") && !name.includes(".test."))
    .map((name) => [name, readFileSync(path.join(dir, name), "utf8")] as const);

  it("has sources to sweep", () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  it("writes down no band tab and no back target", () => {
    const spelled = sources.filter(([, source]) =>
      /\b(?:backTo|current)=["']/u.test(source)
    );
    expect(spelled.map(([name]) => name)).toStrictEqual([]);
  });

  it("asks nothing through Alert.alert", () => {
    const alerting = sources.filter(([, source]) =>
      source.includes("Alert.alert")
    );
    expect(alerting.map(([name]) => name)).toStrictEqual([]);
  });

  it("roots the frame in a room, and every surface in the frame", () => {
    const frame = readFileSync(path.join(dir, "LockerScreen.tsx"), "utf8");
    expect(frame).toContain("<AppPlace");
    expect(frame).toContain("<PushedPage");
    for (const [name, source] of sources) {
      if (!name.endsWith("Screen.tsx") || name === "LockerScreen.tsx") continue;
      expect([name, source.includes("<LockerScreen")]).toStrictEqual([
        name,
        true,
      ]);
    }
  });
});
