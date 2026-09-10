// The one search field (#1015, S4 — audit S4). Eight hand-rolled fields, five
// placements, three keyboard contracts and one with no way to clear the term.
// What this pins is the contract every app inherits: Locker's keyboard props,
// a clear control that appears only when there is something to clear, and a
// result line that is the caller's words.
// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mountBlock, nodesOf, press } from "../../test/react-native-stub";
import SearchField from "./SearchField";

vi.mock(import("react-native"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.reactNativeStub() as unknown as typeof import("react-native");
});
vi.mock(import("react-native-svg"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.svgStub() as unknown as typeof import("react-native-svg");
});

let dispose: (() => void) | undefined;

function render(node: React.ReactNode): HTMLElement {
  const mounted = mountBlock(node);
  dispose = mounted.unmount;
  return mounted.container;
}

const noop = (): void => undefined;

const input = (container: HTMLElement): HTMLElement =>
  nodesOf(container, "input")[0] ?? nodesOf(container, "textarea")[0]!;

describe(SearchField, () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  // The keyboard props are asserted from the source: this file's host stub
  // renders a DOM `input` and drops every prop it does not map, so a DOM
  // assertion here would pass whatever the field actually sets.
  it("takes Locker's keyboard contract, so a term is never auto-corrected", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, "SearchField.tsx"),
      "utf8"
    );
    expect(source).toContain('autoCapitalize="none"');
    expect(source).toContain("autoCorrect={false}");
    expect(source).toContain('returnKeyType="search"');
  });

  it("speaks its placeholder unless the caller says otherwise", () => {
    const container = render(
      <SearchField
        onChangeText={noop}
        placeholder="Search your documents"
        value=""
      />
    );
    expect(input(container).getAttribute("aria-label")).toBe(
      "Search your documents"
    );
    dispose?.();
    dispose = undefined;
    const named = render(
      <SearchField
        accessibilityLabel="Search this album"
        onChangeText={noop}
        placeholder="Search"
        value=""
      />
    );
    expect(input(named).getAttribute("aria-label")).toBe("Search this album");
  });

  it("shows no clear control while there is nothing to clear", () => {
    const container = render(
      <SearchField onChangeText={noop} placeholder="Search" value="" />
    );
    expect(nodesOf(container, "button")).toStrictEqual([]);
  });

  it("clears the term and tells the caller", () => {
    const changed: string[] = [];
    const cleared = vi.fn<() => void>();
    const container = render(
      <SearchField
        onChangeText={(next) => changed.push(next)}
        onClear={cleared}
        placeholder="Search"
        value="tax"
      />
    );
    press(nodesOf(container, "button")[0]);
    expect(changed).toStrictEqual([""]);
    expect(cleared).toHaveBeenCalledOnce();
  });

  it("says how many matched, in the caller's own words", () => {
    const container = render(
      <SearchField
        count="12 matched"
        onChangeText={noop}
        placeholder="Search"
        value="tax"
      />
    );
    expect(nodesOf(container, "span").map((n) => n.textContent)).toContain(
      "12 matched"
    );
  });

  it("leaves the count line out when the caller says nothing", () => {
    const container = render(
      <SearchField onChangeText={noop} placeholder="Search" value="tax" />
    );
    expect(nodesOf(container, "span").map((n) => n.textContent)).toStrictEqual(
      []
    );
  });
});
