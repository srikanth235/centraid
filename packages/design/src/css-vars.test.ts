// Unit laws for the shared var()-resolution reader (#686). The two consumers
// (packages/blueprints, packages/client) walk real stylesheets; these pin the
// parsing edges those walks depend on and would otherwise only exercise by
// accident.

import { describe, expect, test } from "vitest";

import {
  declaredCustomProps,
  stripCssComments,
  unresolvedVarRefs,
} from "./css-vars.js";

describe("reading declarations", () => {
  test("reads declarations after `{`, after `;`, and at line start", () => {
    expect(
      declaredCustomProps(":root { --a: 1; --b: 2;\n  --c: 3;\n}")
    ).toStrictEqual(["--a", "--b", "--c"]);
  });

  test("does not mistake a reference for a declaration", () => {
    expect(declaredCustomProps(".x { color: var(--a); }")).toStrictEqual([]);
  });

  test("dedupes a property declared in several blocks", () => {
    expect(
      declaredCustomProps(":root { --a: 1; }\n[data-theme] { --a: 2; }")
    ).toStrictEqual(["--a"]);
  });

  test("finds every declaration on repeated calls", () => {
    // Regression guard: a module-scope `/g` regex carries `lastIndex`, so a
    // shared instance would return a different answer the second time.
    const css = ":root { --a: 1; --b: 2; }";
    expect(declaredCustomProps(css)).toStrictEqual(declaredCustomProps(css));
  });
});

describe("reporting unresolved references", () => {
  const declared = new Set(["--known"]);

  test("reports a fallback-less reference to an undeclared property", () => {
    expect(
      unresolvedVarRefs(".x { color: var(--ghost); }", declared)
    ).toStrictEqual(["--ghost"]);
  });

  test("accepts a reference that names a declared property", () => {
    expect(
      unresolvedVarRefs(".x { color: var(--known); }", declared)
    ).toStrictEqual([]);
  });

  test("ignores a reference that carries an explicit fallback", () => {
    expect(
      unresolvedVarRefs(".x { color: var(--ghost, #000); }", declared)
    ).toStrictEqual([]);
  });

  test("reads through whitespace inside var()", () => {
    expect(
      unresolvedVarRefs(".x { color: var( --ghost ); }", declared)
    ).toStrictEqual(["--ghost"]);
  });

  test("sorts and dedupes", () => {
    expect(
      unresolvedVarRefs(
        ".x { color: var(--z); border-color: var(--a); outline-color: var(--z); }",
        declared
      )
    ).toStrictEqual(["--a", "--z"]);
  });
});

describe("comment stripping", () => {
  test("removes a documented reference so it is not read as live", () => {
    expect(
      unresolvedVarRefs(
        stripCssComments("/* was var(--ink-1) */\n.x { color: var(--known); }"),
        new Set(["--known"])
      )
    ).toStrictEqual([]);
  });

  test("removes a commented-out declaration so it does not resolve anything", () => {
    expect(
      declaredCustomProps(stripCssComments(":root { /* --a: 1; */ --b: 2; }"))
    ).toStrictEqual(["--b"]);
  });

  test("spans multiple lines", () => {
    expect(stripCssComments("a/* one\ntwo */b")).toBe("ab");
  });
});
