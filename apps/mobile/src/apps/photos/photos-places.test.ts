// What a Photos route may no longer say about itself, and what it may no
// longer ask through an alert (#1015 Wave 2, audit B7/S2/S7).

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  isPhotosPlace,
  photosDestinationFor,
  photosParentPlace,
} from "./photos-places";

describe(photosDestinationFor, () => {
  it("lights the tab a route sits under", () => {
    expect(photosDestinationFor("library")).toBe("library");
    expect(photosDestinationFor("album")).toBe("collections");
    expect(photosDestinationFor("picker")).toBe("collections");
  });

  it("lights none of the four for a surface opened from More", () => {
    expect(photosDestinationFor("places")).toBe("more");
    expect(photosDestinationFor("memories")).toBe("more");
  });

  it("knows the three places from what is pushed over them", () => {
    expect(isPhotosPlace("search")).toBe(true);
    expect(isPhotosPlace("duplicates")).toBe(false);
  });
});

describe(photosParentPlace, () => {
  it("names the parent a pushed surface actually descends from", () => {
    expect(photosParentPlace("album").title).toBe("Collections");
    expect(photosParentPlace("placeDetail").title).toBe("Places");
    expect(photosParentPlace("duplicateReview").title).toBe("Duplicates");
  });

  it("falls back to the app, which is where More opened from", () => {
    expect(photosParentPlace("memories").title).toBe("Photos");
    expect(photosParentPlace("people").title).toBe("Photos");
  });
});

describe("the Photos tree", () => {
  const dir = import.meta.dirname;
  const sources = readdirSync(dir)
    .filter((name) => name.endsWith(".tsx") && !name.includes(".test."))
    .map((name) => [name, readFileSync(path.join(dir, name), "utf8")] as const);

  it("has sources to sweep", () => {
    expect(sources.length).toBeGreaterThan(20);
  });

  it("writes down no band tab and no back target", () => {
    const spelled = sources.filter(([, source]) =>
      /\b(?:backTo|current)=["']/u.test(source)
    );
    expect(spelled.map(([name]) => name)).toStrictEqual([]);
  });

  // Fourteen calls across eight files: nine confirms and five pickers.
  it("asks nothing through Alert.alert", () => {
    const alerting = sources.filter(([, source]) =>
      source.includes("Alert.alert(")
    );
    expect(alerting.map(([name]) => name)).toStrictEqual([]);
  });

  it("draws no back affordance of its own", () => {
    const own = sources.filter(([, source]) =>
      source.includes("PhotosBackControl")
    );
    expect(own.map(([name]) => name)).toStrictEqual(["PhotosScreen.tsx"]);
  });

  it("roots the frame in a room, and its choices in the sheet room", () => {
    const frame = readFileSync(path.join(dir, "PhotosScreen.tsx"), "utf8");
    expect(frame).toContain("<AppPlace");
    expect(frame).toContain("<PushedPage");
    const choice = readFileSync(
      path.join(dir, "PhotosChoiceSheet.tsx"),
      "utf8"
    );
    expect(choice).toContain("<SheetRoom");
  });
});
