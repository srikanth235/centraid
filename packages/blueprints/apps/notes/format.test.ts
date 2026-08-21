// First-line promotion is the default case, so it is the first thing tested:
// over half the corpus has no title of its own, and every card, row, result
// and chip reads this one function.
import { describe, expect, test } from "vitest";

import {
  ageLabel,
  bodySegments,
  checkStats,
  daysLeft,
  deriveTitle,
  hasConcurrentVersions,
  placeholderOf,
  promote,
  tallyLabel,
} from "./format.ts";

describe("first-line promotion", () => {
  test("a titled note keeps its title and its whole preview", () => {
    const shown = promote({
      title: "Q3 roadmap",
      preview: "the three bets\nand what they cost",
    });
    expect(shown).toStrictEqual({
      heading: "Q3 roadmap",
      untitled: false,
      preview: "the three bets\nand what they cost",
    });
  });

  test("an untitled note promotes line one and previews from line two", () => {
    const shown = promote({
      title: "",
      preview: "call the plumber\nbefore Friday\nask about the boiler",
    });
    expect(shown.heading).toBe("call the plumber");
    expect(shown.untitled).toBe(true);
    expect(shown.preview).toBe("before Friday\nask about the boiler");
  });

  test("a title derived from the first line still reads as untitled", () => {
    // What `create-note` had to send, because the vault will not take a
    // nameless note — the member never typed it, so the card must not
    // print the same line twice.
    const body = "call the plumber\nbefore Friday";
    const shown = promote({ title: deriveTitle("", body), body });
    expect(shown.untitled).toBe(true);
    expect(shown.heading).toBe("call the plumber");
    expect(shown.preview).toBe("before Friday");
  });

  test("a note with nothing in it promotes nothing rather than inventing", () => {
    expect(promote({ title: "", preview: "" })).toStrictEqual({
      heading: "",
      untitled: true,
      preview: "",
    });
  });

  test("leading blank lines do not become the heading", () => {
    const shown = promote({
      title: "",
      preview: "\n\nthe first real line\nrest",
    });
    expect(shown.heading).toBe("the first real line");
    expect(shown.preview).toBe("rest");
  });
});

describe("checklists", () => {
  const body = "- [ ] one\n- [x] two\nprose\n- [X] three";

  test("the tally counts boxes, not lines", () => {
    expect(checkStats(body)).toStrictEqual({ total: 3, done: 2 });
    expect(tallyLabel(checkStats(body))).toBe("2 of 3");
  });

  test("a note with no boxes carries no tally at all", () => {
    expect(tallyLabel(checkStats("just prose"))).toBeNull();
  });

  test("the editor's runs keep box lines apart from the prose around them", () => {
    const segments = bodySegments("intro\n- [ ] one\nafter");
    expect(segments.map((segment) => segment.kind)).toStrictEqual([
      "text",
      "check",
      "text",
    ]);
    const [head, box, tail] = segments;
    expect(head).toMatchObject({ text: "intro", from: 0 });
    expect(box).toMatchObject({ line: 1, checked: false, text: "one" });
    // The run's offsets address the same string the anchor and the edit do.
    expect(tail).toMatchObject({ text: "after" });
    expect("from" in tail! ? tail.from : -1).toBe("intro\n- [ ] one\n".length);
  });
});

describe("age and custody", () => {
  const now = Date.parse("2026-08-21T12:00:00Z");

  test("recent notes say how long ago, old ones say when they stopped", () => {
    expect(ageLabel("2026-08-21T09:00:00Z", now)).toBe("today");
    expect(ageLabel("2026-08-20T09:00:00Z", now)).toBe("yesterday");
    expect(ageLabel("2026-08-10T09:00:00Z", now)).toBe("11 days ago");
    expect(ageLabel("2019-03-04T09:00:00Z", now)).toBe(
      "not changed since March 2019"
    );
  });

  test("a row with no purge date counts down from nothing", () => {
    expect(daysLeft(undefined, now)).toBeNull();
    expect(daysLeft("2026-09-01T12:00:00Z", now)).toBe(11);
  });
});

describe("the conflict signal", () => {
  test("two writes stamped at the same instant are a conflict", () => {
    expect(
      hasConcurrentVersions([
        { asserted_at: "2026-08-20T09:00:00Z" },
        { asserted_at: "2026-08-20T09:00:00Z" },
      ])
    ).toBe(true);
  });

  test("an ordinary chain is not one, however long", () => {
    expect(
      hasConcurrentVersions([
        { asserted_at: "2026-08-20T09:00:00Z" },
        { asserted_at: "2026-08-19T09:00:00Z" },
        { asserted_at: "2026-03-04T09:00:00Z" },
      ])
    ).toBe(false);
  });
});

describe("placeholders", () => {
  test("a note whose only content is an image says so", () => {
    expect(
      placeholderOf({ preview: "", attachments: [{ media_type: "image/png" }] })
    ).toBe("screenshot");
  });

  test("an audio note is audio whatever else it holds", () => {
    expect(
      placeholderOf({
        preview: "a memo",
        attachments: [{ media_type: "audio/m4a" }],
      })
    ).toBe("audio");
  });

  test("a pasted link is named rather than shown as a bare card", () => {
    expect(placeholderOf({ preview: "https://centraid.dev/notes" })).toBe(
      "link-only"
    );
  });

  test("prose is prose", () => {
    expect(placeholderOf({ preview: "the three bets" })).toBeNull();
  });
});
