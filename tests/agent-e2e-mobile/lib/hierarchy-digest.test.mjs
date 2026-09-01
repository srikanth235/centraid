// Spec for the failure-path screen digest (#905). Run by the
// `test-report-scripts` vitest project, which already includes
// `tests/agent-e2e-mobile/lib/**` — beside `spawn-redaction.test.mjs`.
//
// The digest's whole job is to survive whatever Maestro wrote, while an error
// is already in flight, without becoming the failure. So the cases are the
// shapes that break a naive walker, plus the two real screens it exists to tell
// apart: Home's `DayOne` branch and Home's `LauncherGrid` branch, which the log
// cannot currently distinguish because `HOME_READY_MARKER` renders in both.

import { describe, expect, it } from "vitest";

import { digestHierarchy, digestLines } from "./hierarchy-digest.mjs";

const node = (attributes, children = []) => ({ attributes, children });

/** The first-run branch: `DayOne`, and NOT one launcher tile. */
const dayOne = node({}, [
  node({ "resource-id": "dev.centraid.mobile:id/day-one" }),
  node({ text: "All apps and places" }),
]);

/** The branch a flow's `Open Notes.*` tap needs. */
const springboard = node({}, [
  node({ "resource-id": "dev.centraid.mobile:id/launcher-grid" }, [
    node({
      "resource-id": "dev.centraid.mobile:id/home-tile-notes",
      accessibilityText: "Open Notes, 16 notes",
    }),
  ]),
  node({ text: "All apps and places" }),
]);

describe("the screen digest", () => {
  it("tells Home's two branches apart", () => {
    const first = digestHierarchy(dayOne);
    expect(first).toContain("id:day-one");
    expect(first.some((entry) => entry.startsWith("id:home-tile-"))).toBe(
      false
    );

    const grid = digestHierarchy(springboard);
    expect(grid).toContain("id:home-tile-notes");
    expect(grid).not.toContain("id:day-one");
    // The label the flow's regex matches, beside the handle it did not name.
    expect(grid).toContain('"Open Notes, 16 notes"');
  });

  it("strips the package prefix so entries read as a flow names them", () => {
    expect(
      digestHierarchy(node({ "resource-id": "dev.centraid.mobile:id/photos" }))
    ).toStrictEqual(["id:photos"]);
    // Already bare (iOS, and Maestro's own synthetic nodes) passes through.
    expect(digestHierarchy(node({ resourceId: "photos" }))).toStrictEqual([
      "id:photos",
    ]);
  });

  it("dedupes and caps, so eight tiles cannot become a dump", () => {
    const many = node(
      {},
      Array.from({ length: 200 }, (_, i) =>
        node({ "resource-id": `tile-${i}` })
      )
    );
    expect(digestHierarchy(many, { limit: 10 })).toHaveLength(10);
    const repeated = node({}, [
      node({ text: "Home" }),
      node({ text: "Home" }),
      node({ text: "Home" }),
    ]);
    expect(digestHierarchy(repeated)).toStrictEqual(['"Home"']);
  });

  it("drops prose, which is body copy and the likeliest member data", () => {
    expect(digestHierarchy(node({ text: "x".repeat(49) }))).toStrictEqual([]);
    expect(digestHierarchy(node({ text: "x".repeat(48) }))).toStrictEqual([
      `"${"x".repeat(48)}"`,
    ]);
  });

  it("survives the shapes a naive walker dies on", () => {
    // A bare array of roots, a flat node with no `attributes`, null children.
    expect(
      digestHierarchy([node({ text: "a" }), node({ text: "b" })])
    ).toStrictEqual(['"a"', '"b"']);
    expect(digestHierarchy({ "resource-id": "flat" })).toStrictEqual([
      "id:flat",
    ]);
    expect(digestHierarchy({ attributes: {}, children: null })).toStrictEqual(
      []
    );
    expect(digestHierarchy(null)).toStrictEqual([]);
    expect(digestHierarchy("not a tree")).toStrictEqual([]);
  });

  it("does not blow the stack on a deeply nested screen", () => {
    let deep = node({ "resource-id": "leaf" });
    for (let i = 0; i < 50_000; i += 1) deep = node({}, [deep]);
    expect(digestHierarchy(deep)).toStrictEqual(["id:leaf"]);
  });

  it("never throws on the failure path", () => {
    expect(digestLines("{not json")).toStrictEqual([]);
    expect(digestLines("")).toStrictEqual([]);
    expect(digestLines(undefined)).toStrictEqual([]);
    expect(
      digestLines(JSON.stringify(node({ "resource-id": "day-one" })))
    ).toStrictEqual(["id:day-one"]);
  });
});
