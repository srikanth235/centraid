// What a People route may no longer say about itself (#1015 Wave 2, audit B7).
//
// Six surfaces drew their own `BackRow` and each decided what to call the
// place it descended from; three said the app's name and three a person's.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  isPeoplePlace,
  peopleDestinationFor,
  peopleParentPlace,
  peopleTitleFor,
  personPlace,
} from "./people-places";

describe(peopleDestinationFor, () => {
  it("lights the tab a route sits under", () => {
    expect(peopleDestinationFor("people")).toBe("people");
    expect(peopleDestinationFor("search")).toBe("search");
    // The touch log is over Touch, which is where the member was looking.
    expect(peopleDestinationFor("logTouch")).toBe("touch");
    expect(peopleDestinationFor("merge")).toBe("people");
  });

  it("knows the three places from what is pushed over them", () => {
    expect(isPeoplePlace("touch")).toBe(true);
    expect(isPeoplePlace("person")).toBe(false);
  });
});

describe(peopleTitleFor, () => {
  it("titles a person's route with their name, which is data", () => {
    expect(peopleTitleFor("person", "Ada")).toBe("Ada");
    expect(peopleTitleFor("trash")).toBe("Trash");
    expect(peopleTitleFor("people")).toBe("People");
  });
});

describe(peopleParentPlace, () => {
  const ada = personPlace("Ada", "p1");

  it("sends a surface about one person back to that person", () => {
    expect(peopleParentPlace("editPerson", ada).title).toBe("Ada");
    expect(peopleParentPlace("merge", ada).title).toBe("Ada");
    expect(peopleParentPlace("logTouch", ada).title).toBe("Ada");
  });

  it("falls back to the roster rather than guessing a name", () => {
    expect(peopleParentPlace("editPerson").title).toBe("People");
    expect(peopleParentPlace("trash").title).toBe("People");
  });
});

describe("the People tree", () => {
  const dir = import.meta.dirname;
  const sources = readdirSync(dir)
    .filter((name) => name.endsWith(".tsx") && !name.includes(".test."))
    .map((name) => [name, readFileSync(path.join(dir, name), "utf8")] as const);

  it("has sources to sweep", () => {
    expect(sources.length).toBeGreaterThan(6);
  });

  it("writes down no band tab and no back target", () => {
    const spelled = sources.filter(([, source]) =>
      /\b(?:backTo|current)=["']/u.test(source)
    );
    expect(spelled.map(([name]) => name)).toStrictEqual([]);
  });

  it("draws no back affordance of its own", () => {
    const own = sources.filter(([, source]) => source.includes("BackRow"));
    expect(own.map(([name]) => name)).toStrictEqual(["PeopleScreen.tsx"]);
  });

  it("asks nothing through Alert.alert", () => {
    const alerting = sources.filter(([, source]) =>
      source.includes("Alert.alert")
    );
    expect(alerting.map(([name]) => name)).toStrictEqual([]);
  });

  it("roots the frame in a room, and its confirm in the sheet room", () => {
    const frame = readFileSync(path.join(dir, "PeopleScreen.tsx"), "utf8");
    expect(frame).toContain("<AppPlace");
    expect(frame).toContain("<PushedPage");
    const confirm = readFileSync(path.join(dir, "PeopleConfirm.tsx"), "utf8");
    expect(confirm).toContain("<SheetRoom");
  });
});
