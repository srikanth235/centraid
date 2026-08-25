// @vitest-environment jsdom
//
// The `docs` file-kind colour code, pinned to the design contract.
//
// A file kind is painted in two different jobs — the "PDF"/"IMG" label as
// TEXT, and the thumbnail tint / mock-page rules as a FILL — and one hex cannot
// serve both. `--c-<hue>` is an icon fill (DESIGN.md: "These are icon fills,
// not text surfaces"); `--c-<hue>-text` is the rung the design package solves
// per theme so the same hue can be `color:`.
//
// This app reads the raw `--c-*` rungs, never a hand-picked kind hex (#686):
// a hex literal doing solved-contrast work by hand is how five of six kinds
// fall below AA as text — `--kind-pdf` at 2.24:1. The contrast
// itself is measured in `packages/design/src/contrast.test.ts`, off the emitted
// CSS, for every hue in both themes. What is checked HERE is the binding those
// measurements assume: that this app reads the text rung for text and the fill
// rung for fills, and that its six kinds are six DISTINCT hues.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { fillVar, tintBg, typeMeta } from "./format.js";

// `import.meta.dirname`, not `new URL(…, import.meta.url)`: this file runs
// under jsdom (the app's kit subclasses `HTMLElement` at import time), and
// there `import.meta.url` is an http: origin that `fileURLToPath` rejects.
const chrome = readFileSync(
  path.join(import.meta.dirname, "Chrome.module.css"),
  "utf8"
);

/** The `--name: value;` pairs declared on `.shell`. */
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
    // Not a literal, and not the raw fill: the text rung, which is what
    // carries a measured floor in both themes.
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
    // Reusing one hue for two kinds makes the colour code lie regardless of
    // how well each individual rung measures.
    const hues = KINDS.map(
      (kind) =>
        /--c-(?<hue>[a-z]+)-text/u.exec(shell[`--kind-${kind}`] ?? "")?.groups
          ?.hue ?? ""
    );
    expect(new Set(hues).size, hues.join(",")).toBe(KINDS.length);
    // `ochre` is `amber` at lower chroma; solved to the same contrast floor the
    // two converge (0.125 apart in oklab as fills, 0.028 as light text), so
    // this app must not carry both. See contrast.test.ts in packages/design.
    expect(hues).not.toContain("ochre");
  });

  test("no dark override re-declares the kind rungs", () => {
    // The design package emits both halves of `--c-*-text`, so an app-local
    // dark block for these would be a second, unmeasured source of truth —
    // which is exactly what the pre-#686 file had.
    const dark = chrome.slice(chrome.indexOf('data-theme="dark"'));
    for (const kind of KINDS) {
      expect(dark, `--kind-${kind} redeclared in a dark block`).not.toContain(
        `--kind-${kind}:`
      );
    }
  });

  test("tints are built from the FILL rung, never the text rung", () => {
    // Tinting a surface with the ink that lands on it walks the background
    // toward the foreground and eats the contrast the solve just bought.
    const meta = typeMeta("application/pdf");
    expect(meta.cv).toBe("--kind-pdf");
    expect(fillVar(meta.cv)).toBe("--kind-pdf-fill");
    expect(tintBg(meta.cv, 12)).toContain("var(--kind-pdf-fill)");
    expect(tintBg(meta.cv, 12)).not.toContain("var(--kind-pdf)");
  });
});
