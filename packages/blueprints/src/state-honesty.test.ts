import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

const appsRoot = path.resolve(import.meta.dirname, "../apps");

const read = (relative: string): string =>
  readFileSync(path.resolve(appsRoot, relative), "utf8");

describe("blueprint state honesty", () => {
  test.each(["agenda", "locker", "notes", "tasks"])(
    "%s paints a skeleton until its first read settles",
    (app) => {
      expect(read(`${app}/Chrome.tsx`)).toContain("LoadingSkeleton");
      expect(read(`${app}/app-root.tsx`)).toMatch(/loading=\{!.*loaded\}/u);
    }
  );

  // People is not on that row, for the reason Docs is not on the one below it:
  // the row asserts ONE skeleton in the chrome, and People's chrome draws no
  // content at all — it owns geometry and hands the scroll host a route
  // (apps/people/Chrome.tsx). Every screen therefore paints its OWN skeleton,
  // sized to the rows that screen is about. So the requirement is asserted per
  // ROUTE here instead, and is stronger than the generic row: not "the string
  // appears somewhere in the chrome" but "every one of the eight routes gates
  // on `loading` before it draws, and the orchestrator hands every one of them
  // the same `!loaded` gate" — a route added without a skeleton, or wired to a
  // gate of its own invention, fails here.
  test("people gates every route on its own skeleton", () => {
    // Route → the pending-read condition its skeleton stands behind. Seven
    // screens wait on the roster read; Search waits on its OWN read instead
    // (`status === "searching"`), because blanking the field while an
    // unrelated read settles would take away the one control that screen is.
    const routes: Array<[string, string]> = [
      ["EditRoute", "props.loading"],
      ["LogRoute", "props.loading"],
      ["MergeRoute", "props.loading"],
      ["PersonRoute", "props.loading"],
      ["RosterRoute", "props.loading"],
      ["SearchRoute", 'props.status === "searching"'],
      ["TouchRoute", "props.loading"],
      ["TrashRoute", "props.loading"],
    ];
    for (const [route, gate] of routes) {
      const source = read(`people/components/${route}.tsx`);
      expect(source, route).toContain("LoadingSkeleton");
      expect(source, route).toContain(gate);
    }
    // …and the orchestrator hands all eight the same `!loaded` gate, so no
    // screen can invent a second answer to "has a read landed". The shelf →
    // route map lives in PeopleRouteBody; app-root still owns `loaded`.
    const root = read("people/app-root.tsx");
    expect(root).toContain("<PeopleRouteBody");
    expect(root).toContain("loaded={loaded}");
    const body = read("people/components/PeopleRouteBody.tsx");
    for (const [route] of routes) expect(body, route).toContain(`<${route}`);
    expect(body).toContain("const loading = !props.loaded");
    expect(body.match(/loading=\{loading\}/gu)).toHaveLength(routes.length);
  });

  // The file that carries the recovery action, per app. It is the chrome for
  // every app that renders a denial as a banner inside its own shell; Photos
  // renders permission as a designed SCREEN instead (v4 handoff §13), so its
  // action lives in that screen. What is asserted is unchanged: a denied read
  // always offers a direct way to the grant, never a dead end.
  test.each([
    ["agenda", "agenda/Chrome.tsx"],
    ["locker", "locker/Chrome.tsx"],
    ["notes", "notes/Chrome.tsx"],
    ["tasks", "tasks/Chrome.tsx"],
    ["docs", "docs/Chrome.tsx"],
    ["tally", "tally/Chrome.tsx"],
    ["photos", "photos/components/Permission.tsx"],
    ["people", "people/Chrome.tsx"],
  ])("%s gives denied reads a direct vault-access action", (_app, file) => {
    expect(read(file)).toContain("VaultAccessButton");
  });

  test.each([
    ["agenda", "agenda/components/ScheduleView.tsx"],
    ["locker", "locker/components/List.tsx"],
    ["notes", "notes/components/Wall.tsx"],
    ["tasks", "tasks/components/Board.tsx"],
    ["tally", "tally/components/Ledger.tsx"],
    ["people", "people/components/EmptyState.tsx"],
  ])("%s primary empty state uses kit vocabulary with a CTA", (_app, file) => {
    const source = read(file);
    expect(source).toContain("kit-empty");
    expect(source).toContain("kit-btn");
  });

  // Docs left that row for the same reason Photos never joined it. `.kit-empty`
  // is a centred notice card with one line of copy, and the Docs spec (§4.6)
  // asks this state for FIVE distinguishable variants — a new drive, an empty
  // folder, an empty shelf, a filter with no matches, a search with no matches
  // — of which only the first takes a display serif and a paragraph about
  // where a member's bytes go. So Docs draws its own block too. The
  // requirement this row is really testing — an empty view that names its own
  // reason and offers a way forward — is asserted here instead, and is
  // stronger than it was: the way forward is only drawn where the app can
  // actually perform it (`runFor`), so no variant dead-ends.
  test("docs draws the five empty states, only one with a display serif", () => {
    const block = read("docs/components/EmptyState.tsx");
    expect(block).toContain("kit-btn");
    expect(block).toContain("runFor");
    expect(block).toContain("data-variant");
    const css = read("docs/components/EmptyState.module.css");
    expect(css).toContain("var(--t-display)");
    expect(css).toContain("var(--t-reading)");
    // The five variants and the gate on "has a read even landed" are one pure
    // function each, not a cascade inside a render. The gate is the SHARED
    // kit's, so Docs and Photos cannot answer "is this view empty" two
    // different ways.
    const viewState = read("docs/view-state.ts");
    expect(viewState).toContain("emptyStateView");
    expect(viewState).toContain("showsEmptyState");
    expect(read("_shared/view-state-kit.ts")).toContain("gate.loaded");
  });

  // Photos is deliberately NOT in that list. `.kit-empty` is a centred notice
  // card with no node for a paragraph, and v4 §14 asks this one state for a
  // display-serif title, a reading-register paragraph carrying the truth about
  // where the bytes go, and up to two actions — so Photos draws its own block
  // (Chrome.tsx `.empty`). The requirement the row above was really testing —
  // an empty state that offers the member a way forward — is unchanged.
  test("photos draws its own empty block, in its own two registers", () => {
    const chrome = read("photos/Chrome.tsx");
    expect(chrome).toContain('id="emptyText"');
    // The node the shared kit has no equivalent of, and the reason the truth
    // about where the bytes go was never on screen.
    expect(chrome).toContain('id="emptyBody"');
    expect(chrome).toContain("kit-btn");
    const css = read("photos/Chrome.module.css");
    expect(css).toContain("var(--t-display)");
    expect(css).toContain("var(--t-reading)");
    expect(css).toContain("44ch");
  });
});
