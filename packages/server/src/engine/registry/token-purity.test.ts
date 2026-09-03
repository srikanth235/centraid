import { describe, expect, test } from "vitest";

import { formatTokenPurityError, scanCssTokenPurity } from "./token-purity.ts";

const CONTRACT = [
  "--accent",
  "--line",
  "--font-code",
  "--scrim",
  "--shadow-md",
];

function scan(css: string) {
  return scanCssTokenPurity(css, { contractProps: CONTRACT });
}

describe("CSS token-purity scanning", () => {
  test("passes a stylesheet built entirely from contract tokens", () => {
    expect(
      scan(`:root { --app-hue: 222; --app-identity: var(--c-indigo); }
.row {
  background: var(--bg-elev);
  color: var(--text-soft);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  padding: var(--sp-3);
  font: var(--t-body);
  font-family: var(--font-sans);
}
.code { font-family: var(--font-code), inherit; }
.card { --card-gap: var(--sp-2); gap: var(--card-gap); }`)
    ).toStrictEqual([]);
  });

  test("flags hex literals, including inside color-mix()", () => {
    const findings = scan(`.a { color: #ff0; }
.b { background: color-mix(in oklab, #ffffff 20%, var(--bg)); }`);
    expect(findings.map((f) => [f.kind, f.line, f.text])).toStrictEqual([
      ["hex", 1, "#ff0"],
      ["hex", 2, "#ffffff"],
    ]);
    expect(findings[0]?.fix).toContain("var(--text)");
  });

  test("flags rgb()/rgba()/hsl()/hsla() literals", () => {
    expect(
      scan(`.a { color: rgb(1 2 3); }
.b { color: rgba(1,2,3,.5); }
.c { color: hsl(1 2% 3%); }
.d { color: hsla(1,2%,3%,.5); }`).map((f) => f.kind)
    ).toStrictEqual([
      "functional-color",
      "functional-color",
      "functional-color",
      "functional-color",
    ]);
  });

  test("flags a concrete font stack but not a token-only one", () => {
    const findings = scan(`.a { font-family: Inter, -apple-system, sans-serif; }
.b { font-family: var(--font-sans); }
.c { font-family: inherit; }`);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(1);
    expect(findings[0]?.text).toContain("Inter");
    expect(findings[0]?.fix).toContain("var(--t-body)");
  });

  test("flags reserved-namespace and contract custom-property declarations", () => {
    const findings = scan(`:root {
  --c-teal: #0aa;
  --t-body: 400 1rem/1.5 system-ui;
  --sp-3: 12px;
  --scrim: rgb(0 0 0 / .5);
}`);
    const props = findings
      .filter((f) => f.kind === "reserved-custom-prop")
      .map((f) => f.text);
    expect(props).toStrictEqual([
      "--c-teal:",
      "--t-body:",
      "--sp-3:",
      "--scrim:",
    ]);
    expect(findings[0]?.fix).toContain("var(--c-teal)");
  });

  test("lets an app declare its two identity knobs and its own names", () => {
    expect(
      scan(
        ":root { --app-hue: 200; --app-identity: var(--c-rose); --row-h: var(--sp-6); }"
      )
    ).toStrictEqual([]);
  });

  test("ignores literals inside comments but keeps line numbers honest", () => {
    const findings = scan(`/* was #ffffff
   before the token migration */
.a { color: #123456; }`);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(3);
  });

  test("enforces the reserved prefixes even without an injected contract", () => {
    expect(
      scanCssTokenPurity(":root { --text-loud: red; --scrim: red; }").map(
        (f) => f.text
      )
    ).toStrictEqual(["--text-loud:"]);
  });
});

describe("token-purity error text", () => {
  test("is empty for a clean sheet", () => {
    expect(formatTokenPurityError([], "app.css")).toBe("");
  });

  test("names the file, each declaration, and what to use instead", () => {
    const message = formatTokenPurityError(
      scan(".a { color: #fff; font-family: Georgia, serif; }"),
      "app.css"
    );
    expect(message).toContain("app.css breaks the design token contract");
    expect(message).toContain("2 violations");
    expect(message).toContain("app.css:1  #fff");
    expect(message).toContain("font-family: Georgia, serif");
    expect(message).toContain("var(--text)");
    expect(message).toContain("var(--font-sans)");
  });
});
