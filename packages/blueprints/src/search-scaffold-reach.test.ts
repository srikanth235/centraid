// SearchScaffold's per-scope reach panel (#726 D10/D11 finding 3),
// loaded by file URL like `photos-shelves-v4.test.ts` does for the rest of
// Photos' `.tsx` rendering — `apps/**/*.test.ts` is this package's own test
// include glob (`vitest.config.ts`), which does not pick up `.tsx` files as
// entry points, so a runnable assertion on `SearchScaffold.tsx` (co-located
// as `apps/_shared/SearchScaffold.test.tsx`) needs a `.test.ts` host the
// glob actually collects. `SearchScaffold.test.tsx` itself still carries the
// same cases for a reader who opens the component's own directory; this file
// is what actually EXECUTES under `bun run test`.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createElement } from "react";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

// Local restatements of `search-scaffold.ts`'s types, not an `import type`
// from `apps/` — this package's `tsconfig.test.json` roots at `src/`, so a
// static reference (even type-only) into `apps/` fails `rootDir`. The file
// URL dynamic import below is the one sanctioned way this suite reaches into
// `apps/`.
type SearchStatus = "resting" | "searching" | "ready" | "unreachable";
interface SearchGroupRow {
  kind: string;
  key: string;
  title: string;
  meta: string;
  here?: string;
  openTarget: string;
}
interface SearchStateCopy {
  resting: { eyebrow: string; title: string; body: string };
  searching: { lead: string; trail: (count: number) => string };
  miss: {
    eyebrow: string;
    title: (query: string) => string;
    body: string;
    clear: string;
  };
  unreachable: {
    eyebrow: string;
    title: string;
    body: string;
    facts: readonly { label: string; value: string }[];
    retry: string;
  };
}

const moduleUrl = pathToFileURL(
  path.resolve(import.meta.dirname, "../apps/_shared/SearchScaffold.tsx")
).href;
const { SearchScaffold } = (await import(moduleUrl)) as {
  SearchScaffold: ComponentType<Record<string, unknown>>;
};

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
        examples: ["one", "two"],
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

describe("SearchScaffold — per-scope reach beside results (#726 D10/D11)", () => {
  it("names an unreached scope BESIDE otherwise-good results, never in place of them", () => {
    const html = render({
      query: "x",
      status: "ready",
      count: 3,
      reachFacts: [{ label: "commons", value: "peer offline" }],
    });
    expect(html).toContain("Not every scope answered");
    expect(html).toContain("commons");
    expect(html).toContain("peer offline");
    expect(html).toContain("own results"); // the caller's own children, still rendered
    expect(html).toContain("results · searched the live library");
  });

  it("names an unreached scope beside a genuine miss too — zero own hits is a different claim from 'nothing was asked'", () => {
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

  it("draws no partial-reach panel once every scope answered (the default, empty reachFacts)", () => {
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
});
