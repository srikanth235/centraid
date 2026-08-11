// @vitest-environment jsdom
// Board's per-scope reach panel (issue #726 D10/D11 finding 3, job 1's last
// mile): `scope-fanout.ts`'s `readBoard` has computed `reach` for a while —
// this pins that the BOARD actually draws it, the render-layer half nothing
// exercised before this test existed. Same SSR technique
// `_shared/SearchScaffold.test.tsx` uses: `renderToStaticMarkup` over the
// component's own props, no jsdom needed for a pure view.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ScopeSearchReach } from "../../_shared/search-scaffold.ts";
import type { BoardSection, Task } from "../types.ts";
import { Board } from "./Board.tsx";

const TASK: Task = {
  task_id: "t1",
  status: "needs-action",
  title: "Own scope's task",
};

const SECTIONS: BoardSection[] = [
  { key: "today", label: "Today", tone: "accent", count: 1, rows: [TASK] },
];

function render(reach?: readonly ScopeSearchReach[]): string {
  return renderToStaticMarkup(
    createElement(Board, {
      view: "today",
      showCapture: false,
      captureProps: { onSubmit: async () => true, registerFocus: () => {} },
      sections: SECTIONS,
      isEmpty: false,
      emptyTitle: "All clear",
      emptySub: "Nothing here.",
      search: "",
      snippets: null,
      pendingByRowId: new Map(),
      projects: [],
      projectSections: [],
      footer: null,
      reach,
      onShowMore: () => {},
      onEmptyAction: () => {},
      onOpenDetail: () => {},
      onToggle: async () => true,
      onOrganize: async () => true,
      onReorder: async () => true,
    })
  );
}

describe("Board's per-scope reach panel", () => {
  it("draws no panel when reach is absent — the single-scope-mount default", () => {
    const html = render(undefined);
    expect(html).not.toContain("Not every scope answered");
    // renderToStaticMarkup HTML-escapes the apostrophe in text nodes too.
    expect(html).toContain("Own scope&#x27;s task");
  });

  it("draws no panel when every scope reached", () => {
    const reach: ScopeSearchReach[] = [{ scope: "own", state: "reached" }];
    const html = render(reach);
    expect(html).not.toContain("Not every scope answered");
  });

  it("names an unreached scope BESIDE the own scope's rows — never a swap for them", () => {
    const reach: ScopeSearchReach[] = [
      { scope: "own", state: "reached" },
      { scope: "commons-priya", state: "unreached", detail: "peer offline" },
    ];
    const html = render(reach);
    expect(html).toContain("Not every scope answered");
    expect(html).toContain("commons-priya");
    expect(html).toContain("peer offline");
    // The reached scope's tasks are still on screen — the point of a NAMED
    // gap is that it sits beside good results, never in place of them.
    expect(html).toContain("Own scope&#x27;s task");
  });

  it("names a refused scope with the mask's own reason, distinct from unreached", () => {
    const reach: ScopeSearchReach[] = [
      { scope: "own", state: "reached" },
      {
        scope: "commons-read-only",
        state: "refused",
        detail: "search excludes a masked column",
      },
    ];
    const html = render(reach);
    expect(html).toContain("commons-read-only");
    expect(html).toContain("search excludes a masked column");
  });
});
