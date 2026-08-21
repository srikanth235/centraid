// The `[[` powerbox: what it groups, what opens it, and what an anchored
// passage carries.
import { describe, expect, test } from "vitest";

import { KIND_ORDER, anchorFrom, groupTargets, probeAt, resolveAnchor } from "./powerbox.ts";
import type { LinkTarget } from "./types.ts";

const target = (app: string, id: string): LinkTarget => ({
  app,
  id,
  type: `${app.toLowerCase()}.thing`,
  title: `${app} ${id}`,
});

describe("grouping", () => {
  test("the seven kinds come back in the sheet's own order", () => {
    const groups = groupTargets([
      target("Docs", "d1"),
      target("Notes", "n1"),
      target("People", "p1"),
      target("Notes", "n2"),
    ]);
    expect(groups.map((group) => group.app)).toStrictEqual([
      "Notes",
      "People",
      "Docs",
    ]);
    expect(groups[0]?.targets).toHaveLength(2);
  });

  test("a kind that answered nothing is absent, never an empty column", () => {
    const groups = groupTargets([target("Tasks", "t1")]);
    expect(groups).toHaveLength(1);
    expect(KIND_ORDER).toContain("Tasks");
  });

  test("a kind this table has not heard of still lists, after the seven", () => {
    const groups = groupTargets([target("Atlas", "a1"), target("Notes", "n1")]);
    expect(groups.map((group) => group.app)).toStrictEqual(["Notes", "Atlas"]);
  });

  test("Locker is not one of the kinds", () => {
    expect(KIND_ORDER).not.toContain("Locker");
  });
});

describe("the sigil", () => {
  test("an unclosed pair with the caret after it is the probe", () => {
    expect(probeAt("see [[road", 10)).toStrictEqual({ start: 4, term: "road" });
  });

  test("a closed pair, or one a line back, is not what is being typed now", () => {
    expect(probeAt("see [[roadmap]] and more", 24)).toBeNull();
    expect(probeAt("[[roadmap\nnext line", 19)).toBeNull();
  });
});

describe("anchored passages", () => {
  const body = "The plan is simple. Ship the boiler note by Friday.";

  test("a selection becomes an exact passage with its own context", () => {
    const anchor = anchorFrom(body, 20, 30);
    expect(anchor).toMatchObject({ exact: "Ship the b", start: 20 });
    expect(anchor?.prefix).toBe("The plan is simple. ");
  });

  test("an empty selection anchors nothing, so the link is to the note", () => {
    expect(anchorFrom(body, 12, 12)).toBeNull();
  });

  test("the passage is found again after the text around it moved", () => {
    const anchor = anchorFrom(body, 20, 30)!;
    const edited = `Some new opening. ${body}`;
    expect(resolveAnchor(edited, anchor)).toStrictEqual({
      start: 38,
      end: 48,
    });
  });

  test("a passage edited away degrades rather than pointing at the wrong words", () => {
    expect(resolveAnchor("nothing like it here", anchorFrom(body, 20, 30))).toBeNull();
  });
});
