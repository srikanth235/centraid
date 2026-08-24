// The shared search scaffold's rendering half (#712) — a generic
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
  reachFacts?: readonly { label: string; value: string }[];
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
    // renderToStaticMarkup HTML-escapes quotes in text nodes too, not just
    // attributes — assert against what actually lands in the markup.
    expect(html).toContain("Nothing matches &quot;zzz&quot;");
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
    // Same escaping note as above — the apostrophe lands as `&#x27;`.
    expect(html).toContain("the caller&#x27;s own results");
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

  it("names an unreached scope BESIDE otherwise-good results — issue #726 D10/D11, never a swap for the results", () => {
    const html = render({
      query: "x",
      status: "ready",
      count: 3,
      reachFacts: [{ label: "commons", value: "peer offline" }],
    });
    expect(html).toContain("Not every scope answered");
    expect(html).toContain("commons");
    expect(html).toContain("peer offline");
    // The results are STILL there — a partial reach never collapses `ready`
    // into the miss/unreachable panels.
    expect(html).toContain("own results"); // the caller's own children
    expect(html).toContain("results · searched the live library");
  });

  it("names an unreached scope beside a genuine miss too — zero own hits is not the same claim as 'nothing was asked'", () => {
    const html = render({
      query: "zzz",
      status: "ready",
      count: 0,
      reachFacts: [{ label: "commons", value: "peer offline" }],
    });
    expect(html).toContain("Nothing matches");
    expect(html).toContain("zzz");
    expect(html).toContain("Not every scope answered");
    expect(html).toContain("peer offline");
  });

  it("draws no partial-reach panel when every scope answered (the default, empty `reachFacts`)", () => {
    const html = render({ query: "x", status: "ready", count: 3 });
    expect(html).not.toContain("Not every scope answered");
  });

  it("draws no partial-reach panel while `unreachable` owns the panel instead — never both", () => {
    const html = render({
      query: "x",
      status: "unreachable",
      count: 0,
      reachFacts: [{ label: "commons", value: "peer offline" }],
    });
    expect(html).not.toContain("Not every scope answered");
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
