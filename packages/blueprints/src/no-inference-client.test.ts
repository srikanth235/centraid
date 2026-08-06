/*
 * docs/blueprint-seats.md "Enrichment doctrine" (issue #712 C5), checked
 * mechanically: a blueprint app or automation reaches a model through
 * exactly TWO roads — `ctx.agent` (the ACP runner registry, dispatcher-gated
 * for provider egress at #567) or the device work-lease lane
 * (`enrich_request.required_capability`). Neither road is a package a
 * blueprint imports; both are handed to handler code through `ctx`/the host.
 * So no blueprint source file may import a third-party inference/provider
 * SDK — doing so would be a THIRD road, invented per-app, invisible to the
 * dispatcher's egress gate and to the enrichment tier gate alike.
 *
 * This is a TRIPWIRE, not a proof (same caveat as
 * `blueprint-seats.test.ts`'s S1/S2/S5 check): it greps import specifiers
 * for a roster of known provider package names. A determined author could
 * dodge it with an alias, a dynamic `import(computedString)`, or a bare
 * `fetch` to a provider's REST endpoint — the point is to catch the
 * ordinary "I reached for the SDK because it was the fastest way" mistake,
 * not a sabotage attempt.
 *
 * FALSE-POSITIVE GUARD: `packages/blueprints/src/scaffold-defaults.ts`
 * contains a documentation template string that MENTIONS a model id
 * (`"anthropic/claude-3-5-sonnet"`, inside `requires.model` example JSON) —
 * that is data a scaffolded `automation.json` may legitimately carry (the
 * one billed rail, `ctx.agent`'s own model pin), not a package import, so
 * this check matches only actual `import`/`require`/`import()` specifiers,
 * never arbitrary file text.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");

// Source roots a blueprint app, automation, or the package's own build/
// scaffolding tooling lives under. node_modules and dist are build/vendor
// output, not authored source. `src` is included (not just `apps` and
// `automations`) because it is where the false-positive guard below lives
// (`scaffold-defaults.ts`'s model-id template string) and where a stray
// provider import in tooling would be just as much a third road.
const SOURCE_DIRS = ["apps", "automations", "scripts", "src", "types"] as const;

// Known third-party inference/provider SDK package names (and their scoped
// families) a handler or component has no business importing — the two
// roads named above are the only ones a blueprint may take to a model.
const PROVIDER_PACKAGES = [
  "openai",
  "@anthropic-ai/",
  "@google/generative-ai",
  "@google-cloud/vertexai",
  "@ai-sdk/",
  "ai/rsc",
  "cohere-ai",
  "@mistralai/",
  "mistralai",
  "ollama",
  "groq-sdk",
  "@huggingface/inference",
  "replicate",
  "together-ai",
  "@aws-sdk/client-bedrock",
] as const;

// Matches the specifier of a static `import ... from "X"`, a bare
// `import "X"`, a `require("X")`, or a dynamic `import("X")` — single or
// double quoted.
const IMPORT_SPECIFIER_RE =
  /(?:from\s+|require\(|import\()\s*["'](?<specifier>[^"']+)["']/gu;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.(?:ts|tsx|js|mjs)$/u.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function importedProviderPackages(text: string): string[] {
  const hits: string[] = [];
  for (const match of text.matchAll(IMPORT_SPECIFIER_RE)) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    const provider = PROVIDER_PACKAGES.find(
      (name) => specifier === name || specifier.startsWith(name)
    );
    if (provider) hits.push(specifier);
  }
  return hits;
}

const allFiles = SOURCE_DIRS.flatMap((rel) => {
  const dir = path.join(PACKAGE_ROOT, rel);
  try {
    return statSync(dir).isDirectory() ? sourceFiles(dir) : [];
  } catch {
    return [];
  }
});

describe("no blueprint imports a provider SDK directly (docs/blueprint-seats.md Enrichment doctrine)", () => {
  it("sanity: the source scan actually found blueprint files", () => {
    // A regression here means the directory list above drifted from the
    // package layout, not that the roster went clean — the count guards
    // against the check silently scanning nothing.
    expect(allFiles.length).toBeGreaterThan(50);
  });

  it.each(allFiles.map((f) => [path.relative(PACKAGE_ROOT, f), f] as const))(
    "%s imports no third-party inference/provider SDK",
    (_label, file) => {
      const text = readFileSync(file, "utf8");
      const hits = importedProviderPackages(text);
      expect(
        hits,
        `${path.relative(PACKAGE_ROOT, file)} imports ${hits.join(", ")} — ` +
          `the only roads to a model are ctx.agent (the ACP runner registry) ` +
          `and the device work-lease lane (docs/blueprint-seats.md ` +
          `"Enrichment doctrine")`
      ).toStrictEqual([]);
    }
  );

  it("does not false-positive on scaffold-defaults.ts's model-id template string", () => {
    const file = path.join(PACKAGE_ROOT, "src", "scaffold-defaults.ts");
    const text = readFileSync(file, "utf8");
    expect(text).toContain("anthropic/claude-3-5-sonnet");
    expect(importedProviderPackages(text)).toStrictEqual([]);
  });
});
