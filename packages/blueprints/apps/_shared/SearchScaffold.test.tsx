// The shared search scaffold's rendering half (issue #712 S1) — a generic
// smoke test with invented copy, independent of any one app's strings. The
// exact-copy assertions for a real consumer live with that consumer
// (`src/photos-shelves-v4.test.ts` for Photos; this file only proves the
// four states/config-driven groups render at all, for an app that is
// neither Photos nor Tally.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  SearchGroupRow,
  SearchStateCopy,
  SearchStatus,
} from "./search-scaffold.ts";
import { SearchScaffold } from "./SearchScaffold.tsx";

const COPY: SearchStateCopy = {
  resting: {
    eyebrow: "Nothing typed",
    title: "Search everything",
    body: "Try one of these.",
  },
  searching: {
    lead: "Searching.",
    trail: (count) => `${count} ${count === 1 ? "match" : "matches"} so far.`,
  },
  miss: {
    eyebrow: "No matches",
    title: (query) => `Nothing matches "${query}"`,
    body: "Nothing matched.",
    clear: "Clear",
  },
  unreachable: {
    eyebrow: "Cannot reach the gateway",
    title: "Search needs the gateway",
    body: "It could not be reached.",
    facts: [{ label: "what still works", value: "everything else" }],
    retry: "Retry",
  },
};

const EXAMPLES = ["one", "two"];

function render(props: {
  query: string;
  status: SearchStatus;
  count: number;
  groups?: readonly SearchGroupRow[];
}): string {
  return renderToStaticMarkup(
    createElement(
      SearchScaffold,
      {
        scope: "the live library",
        copy: COPY,
        examples: EXAMPLES,
        onQuery: () => undefined,
        onClear: () => undefined,
        onRetry: () => undefined,
        onOpenGroup: () => undefined,
        ...props,
      },
      createElement("p", null, "the caller's own results")
    )
  );
}

describe("SearchScaffold's four states", () => {
  it("rests on the caller's own example chips when nothing is typed", () => {
    const html = render({ query: "", status: "resting", count: 0 });
    expect(html).toContain("Search everything");
    expect(html).toContain("one");
    expect(html).toContain("two");
    expect(html).not.toContain("the caller's own results");
  });

  it("is determinate while searching, driven by the caller's own copy", () => {
    const html = render({ query: "x", status: "searching", count: 4 });
    expect(html).toContain("Searching.");
    expect(html).toContain(">4<");
    expect(html).toContain("matches so far");
  });

  it("echoes the query and the caller's honest miss body on a real miss", () => {
    const html = render({ query: "zzz", status: "ready", count: 0 });
    expect(html).toContain('Nothing matches "zzz"');
    expect(html).toContain("Nothing matched.");
    expect(html).not.toContain("the caller's own results");
  });

  it("takes the unreachable panel over the miss line — never both", () => {
    const html = render({ query: "x", status: "unreachable", count: 0 });
    expect(html).toContain("Search needs the gateway");
    expect(html).toContain("Retry");
    expect(html).not.toContain("Nothing matches");
  });

  it("shows the caller's results and the status line once ready with hits", () => {
    const html = render({ query: "x", status: "ready", count: 3 });
    expect(html).toContain(">3<");
    expect(html).toContain("results · searched the live library");
    expect(html).toContain("the caller's own results");
  });

  it("a query with zero primary hits but a real group hit is still results, not a miss", () => {
    const groups: SearchGroupRow[] = [
      {
        kind: "thing",
        key: "t1",
        title: "Thing",
        meta: "thing · 1",
        openTarget: "t1",
      },
    ];
    const html = render({ query: "x", status: "ready", count: 0, groups });
    expect(html).not.toContain("Nothing matches");
    expect(html).toContain("Thing");
    expect(html).toContain("Open →");
  });

  it("caps nothing itself — it renders exactly the rows it is given", () => {
    const groups: SearchGroupRow[] = Array.from({ length: 5 }, (_, i) => ({
      kind: "thing",
      key: `t${i}`,
      title: `Thing ${i}`,
      meta: "thing",
      openTarget: `t${i}`,
    }));
    const html = render({ query: "x", status: "ready", count: 1, groups });
    for (const row of groups) expect(html).toContain(row.title);
  });
});
