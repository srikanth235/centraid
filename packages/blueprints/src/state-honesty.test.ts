import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

const appsRoot = path.resolve(import.meta.dirname, "../apps");

const read = (relative: string): string =>
  readFileSync(path.resolve(appsRoot, relative), "utf8");

describe("blueprint state honesty", () => {
  // Requirements on an interface, never exemptions for an app: an app with no
  // interface asserts nothing.
  test.each(["locker", "tasks"])(
    "%s paints a skeleton until its first read settles",
    (app) => {
      expect(read(`${app}/Chrome.tsx`)).toContain("LoadingSkeleton");
      expect(read(`${app}/app-root.tsx`)).toMatch(/loading=\{!.*loaded\}/u);
    }
  );

  // Per ROUTE: a route added without a skeleton, or wired to a gate of its
  // own invention, fails here.
  test("people gates every route on its own skeleton", () => {
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
    const root = read("people/app-root.tsx");
    expect(root).toContain("<PeopleRouteBody");
    expect(root).toContain("loaded={loaded}");
    const body = read("people/components/PeopleRouteBody.tsx");
    for (const [route] of routes) expect(body, route).toContain(`<${route}`);
    expect(body).toContain("const loading = !props.loaded");
    expect(body.match(/loading=\{loading\}/gu)).toHaveLength(routes.length);
  });

  // A skeleton in these chromes outlives the read it stands in for.
  test.each([
    ["agenda", "LoadingSkeleton"],
    ["notes", "<Skeletons"],
  ])("%s paints its boot skeleton from the route body", (app, marker) => {
    const root = read(`${app}/app-root.tsx`);
    expect(root).toContain(marker);
    expect(root).toMatch(/if \(!loaded\)/u);
    expect(read(`${app}/Chrome.tsx`)).not.toContain("LoadingSkeleton");
  });

  // A denied read always offers a way to the grant, never a dead end: the
  // chrome must draw `ConsentBanner` and the banner must carry the button.
  test.each([
    ["locker", "locker/Chrome.tsx"],
    ["docs", "docs/Chrome.tsx"],
    ["people", "people/Chrome.tsx"],
    ["agenda", "agenda/Chrome.tsx"],
    ["notes", "notes/Chrome.tsx"],
    ["tasks", "tasks/Chrome.tsx"],
  ])("%s gives denied reads a direct vault-access action", (_app, file) => {
    expect(read(file)).toContain("<ConsentBanner");
  });

  test("the shared consent banner IS the way to the grant", () => {
    expect(read("_shared/AppChrome.tsx")).toContain("<VaultAccessButton />");
  });

  // Photos' denial is a SCREEN, not a banner (v4 §13).
  test("photos' permission screen offers the grant directly", () => {
    expect(read("photos/components/Permission.tsx")).toContain(
      "VaultAccessButton"
    );
  });

  test.each([
    ["locker", "locker/components/List.tsx"],
    ["people", "people/components/EmptyState.tsx"],
    ["agenda", "agenda/components/Shared.tsx"],
    ["tasks", "tasks/components/States.tsx"],
  ])("%s primary empty state uses kit vocabulary with a CTA", (_app, file) => {
    const source = read(file);
    expect(source).toContain("kit-empty");
    expect(source).toContain("kit-btn");
  });

  test("notes day one offers acts in kit vocabulary", () => {
    const source = read("notes/components/States.tsx");
    expect(source).toContain("EMPTY_DAY_ONE");
    expect(source).toContain("kit-btn");
  });

  // Docs draws its own block (§4.6), naming its reason.
  test("docs draws the five empty states, only one with a display serif", () => {
    const block = read("docs/components/EmptyState.tsx");
    expect(block).toContain("kit-btn");
    expect(block).toContain("runFor");
    expect(block).toContain("data-variant");
    const css = read("docs/components/EmptyState.module.css");
    expect(css).toContain("var(--t-display)");
    expect(css).toContain("var(--t-reading)");
    // The gate is the SHARED kit's, so no app answers "empty" its own way.
    const viewState = read("docs/view-state.ts");
    expect(viewState).toContain("emptyStateView");
    expect(viewState).toContain("showsEmptyState");
    expect(read("_shared/view-state-kit.ts")).toContain("gate.loaded");
  });

  test("photos draws its own empty block, in its own two registers", () => {
    const chrome = read("photos/Chrome.tsx");
    expect(chrome).toContain('id="emptyText"');
    expect(chrome).toContain('id="emptyBody"');
    expect(chrome).toContain("kit-btn");
    const css = read("photos/Chrome.module.css");
    expect(css).toContain("var(--t-display)");
    expect(css).toContain("var(--t-reading)");
    expect(css).toContain("44ch");
  });
});
