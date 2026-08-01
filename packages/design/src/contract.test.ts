import { describe, expect, test } from "vitest";

import { toBlueprintCss } from "./blueprint.js";
import { BLUEPRINT_TOKEN_CONTRACT, SHELL_TOKEN_CONTRACT } from "./contract.js";
import { toCss } from "./css.js";

function properties(css: string, selector: string): string[] {
  const start = css.indexOf(`${selector} {`);
  const body = start < 0 ? "" : css.slice(start, css.indexOf("\n}", start));
  return [...body.matchAll(/^\s*(?<property>--[\w-]+):/gmu)]
    .map((match) => match.groups?.property ?? "")
    .filter((property): property is string => property.length > 0)
    .sort();
}

describe("CSS token contract", () => {
  test("shell root emits the canonical contract", () => {
    expect(properties(toCss(), ":root")).toStrictEqual(SHELL_TOKEN_CONTRACT);
  });

  test("blueprint root emits its canonical contract", () => {
    expect(properties(toBlueprintCss(), ":root")).toStrictEqual(
      BLUEPRINT_TOKEN_CONTRACT
    );
  });
});
