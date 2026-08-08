/*
 * docs/blueprint-seats.md "Enrichment doctrine" (issue #712 C5), checked
 * mechanically: a blueprint app or automation reaches a model through
 * through host-owned seams only. Provider model calls use `ctx.agent`; local
 * model-derived features use the gateway's one enrichment-service client.
 * A blueprint app, automation, or mobile seat may import neither a provider
 * SDK nor the enrichment client/service package directly.
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

// WIDENED TO THE NATIVE TREE (issue #712 E1, engine C). The doctrine says "no
// blueprint app OR AUTOMATION" invents a third road, and the native client is
// where the device work-lease lane actually runs (iOS Vision / Android ML
// Kit): it is the surface with both the motive and the opportunity to reach
// for a provider SDK instead. `apps/mobile` is a separate package with its own
// vitest project, so this file reaches ACROSS the package boundary the same
// way it already reaches into `packages/vault` for `SHAREABLE_ITEM_TYPES` —
// one check for one rule beats two that drift.
const EXTRA_ROOTS = [
  path.resolve(PACKAGE_ROOT, "../../apps/mobile/src"),
  path.resolve(PACKAGE_ROOT, "../automation/src"),
] as const;

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

const ENRICHMENT_CLIENT_TERMS = [
  "@centraid/enrichment-service",
  "CENTRAID_ENRICH_URL",
  "enrich/service-client",
] as const;

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

function enrichmentClientReferences(text: string): string[] {
  return ENRICHMENT_CLIENT_TERMS.filter((term) => text.includes(term));
}

const allFiles = [
  ...SOURCE_DIRS.map((rel) => path.join(PACKAGE_ROOT, rel)),
  ...EXTRA_ROOTS,
].flatMap((dir) => {
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

  it("sanity: the widened scan actually reaches the native tree", () => {
    // Without this the EXTRA_ROOTS path could silently resolve to nothing
    // (a moved package, a renamed `src`) and engine C's native half would go
    // ungated while the suite stayed green.
    expect(
      allFiles.filter((f) =>
        f.includes(`${path.sep}apps${path.sep}mobile${path.sep}`)
      ).length
    ).toBeGreaterThan(50);
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

  it.each(
    allFiles
      .filter((file) => file !== import.meta.filename)
      .map((file) => [path.relative(PACKAGE_ROOT, file), file] as const)
  )("%s does not own the enrichment-service client", (_label, file) => {
    const hits = enrichmentClientReferences(readFileSync(file, "utf8"));
    expect(
      hits,
      `${path.relative(PACKAGE_ROOT, file)} reaches the enrichment service directly; only packages/gateway/src/enrich/service-client.ts may do that`
    ).toStrictEqual([]);
  });

  it("[law:enrichment-single-client] SABOTAGE: detects a direct service client", () => {
    expect(
      enrichmentClientReferences(
        'import { createEnrichmentClient } from "@centraid/enrichment-service";'
      )
    ).toStrictEqual(["@centraid/enrichment-service"]);
  });
});
