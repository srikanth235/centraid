import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { fillVar, tintBg, typeMeta } from "./format.js";

const chrome = readFileSync(
  path.join(import.meta.dirname, "Chrome.module.css"),
  "utf8"
);

function shellDeclarations(): Record<string, string> {
  const start = chrome.indexOf(".shell {");
  expect(start, "Chrome.module.css declares a .shell block").toBeGreaterThan(
    -1
  );
  const body = chrome.slice(start, chrome.indexOf("\n}", start));
  const out: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const match = /^\s*(?<name>--[\w-]+)\s*:\s*(?<value>.+?);\s*$/u.exec(line);
    if (match?.groups?.name && match.groups.value) {
      out[match.groups.name] = match.groups.value;
    }
  }
  return out;
}

const KINDS = ["pdf", "image", "doc", "sheet", "slide", "media"] as const;

describe("docs file-kind colours", () => {
  const shell = shellDeclarations();

  test.each(KINDS)("--kind-%s reads the SOLVED text rung", (kind) => {
    const value = shell[`--kind-${kind}`];
    expect(value, `--kind-${kind} is declared`).toBeDefined();
    expect(value, `--kind-${kind}`).toMatch(/^var\(--c-[a-z]+-text\)$/u);
  });

  test.each(KINDS)("--kind-%s-fill reads the raw palette hue", (kind) => {
    const value = shell[`--kind-${kind}-fill`];
    expect(value, `--kind-${kind}-fill is declared`).toBeDefined();
    expect(value, `--kind-${kind}-fill`).toMatch(/^var\(--c-[a-z]+\)$/u);
  });

  test("each kind's two rungs are the same hue", () => {
    for (const kind of KINDS) {
      const text = /--c-(?<hue>[a-z]+)-text/u.exec(
        shell[`--kind-${kind}`] ?? ""
      );
      const fill = /--c-(?<hue>[a-z]+)\)/u.exec(
        shell[`--kind-${kind}-fill`] ?? ""
      );
      expect(text?.groups?.hue, `--kind-${kind} hue`).toBeDefined();
      expect(fill?.groups?.hue, `--kind-${kind}-fill hue`).toBe(
        text?.groups?.hue
      );
    }
  });

  test("the six kinds are six distinct hues", () => {
    const hues = KINDS.map(
      (kind) =>
        /--c-(?<hue>[a-z]+)-text/u.exec(shell[`--kind-${kind}`] ?? "")?.groups
          ?.hue ?? ""
    );
    expect(new Set(hues).size, hues.join(",")).toBe(KINDS.length);
    expect(hues).not.toContain("ochre");
  });

  test("no dark override re-declares the kind rungs", () => {
    const dark = chrome.slice(chrome.indexOf('data-theme="dark"'));
    for (const kind of KINDS) {
      expect(dark, `--kind-${kind} redeclared in a dark block`).not.toContain(
        `--kind-${kind}:`
      );
    }
  });

  test("tints are built from the FILL rung, never the text rung", () => {
    const meta = typeMeta("application/pdf");
    expect(meta.cv).toBe("--kind-pdf");
    expect(fillVar(meta.cv)).toBe("--kind-pdf-fill");
    expect(tintBg(meta.cv, 12)).toContain("var(--kind-pdf-fill)");
    expect(tintBg(meta.cv, 12)).not.toContain("var(--kind-pdf)");
  });
});
// @vitest-environment jsdom
