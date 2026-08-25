/*
 * Tripwire for docs/blueprint-seats.md "Enrichment doctrine" (#712): greps
 * import specifiers for known provider SDKs. Not a proof — aliases, dynamic
 * `import(computed)`, and bare fetch dodge it. Specifiers only, so a model
 * pin in `automation.json` and prose naming a package do not trip (pinned
 * below). Recognition uses ctx.vault content/invoke; billed calls use
 * `ctx.delegate`. No third road.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");

// Authored source. `src` is in because a provider import in package tooling
// is still a third road.
const SOURCE_DIRS = ["apps", "automations", "scripts", "src", "types"] as const;

// Native tree too (#712 E1, engine C): the work-lease lane is where a
// provider SDK is tempting. One check for one rule — this file already
// crosses into `packages/vault` the same way.
const EXTRA_ROOTS = [
  path.resolve(PACKAGE_ROOT, "../../apps/mobile/src"),
  path.resolve(PACKAGE_ROOT, "../server/src/automation"),
] as const;

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

const IMPORT_SPECIFIER_RE =
  /(?:from\s+|require\(|import\()\s*["'](?<specifier>[^"']+)["']/gu;

const OBSOLETE_INFERENCE_TERMS = [
  "@centraid/enrichment-service",
  "CENTRAID_ENRICH_URL",
  "enrich/service-client",
  "centraid://enrichment/",
  "ctx.infer",
  "ctx.enrich",
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

function obsoleteInferenceReferences(text: string): string[] {
  return OBSOLETE_INFERENCE_TERMS.filter((term) => text.includes(term));
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
    // Count guards a layout drift that would scan nothing.
    expect(allFiles.length).toBeGreaterThan(50);
  });

  it("sanity: the widened scan actually reaches the native tree", () => {
    // EXTRA_ROOTS must actually resolve; otherwise engine C is ungated.
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
          `the only roads to a model are ctx.delegate (the ACP harness registry) ` +
          `and the device work-lease lane (docs/blueprint-seats.md ` +
          `"Enrichment doctrine")`
      ).toStrictEqual([]);
    }
  );

  it("does not false-positive on a provider name that is data or prose", () => {
    expect(
      importedProviderPackages(
        '{ "requires": { "model": "anthropic/claude-3-5-sonnet" } }'
      )
    ).toStrictEqual([]);
    expect(
      importedProviderPackages("// never reach for openai or @anthropic-ai/sdk")
    ).toStrictEqual([]);
    // Interpolated so this file does not trip its own scan.
    const provider = "openai";
    expect(
      importedProviderPackages(`import OpenAI from "${provider}";`)
    ).toStrictEqual([provider]);
  });

  it.each(
    allFiles
      .filter((file) => file !== import.meta.filename)
      .map((file) => [path.relative(PACKAGE_ROOT, file), file] as const)
  )("%s uses no obsolete inference road", (_label, file) => {
    const hits = obsoleteInferenceReferences(readFileSync(file, "utf8"));
    expect(
      hits,
      `${path.relative(PACKAGE_ROOT, file)} uses obsolete inference terms: ${hits.join(", ")}; recognition handlers bundle model execution and use ctx.vault content/invoke`
    ).toStrictEqual([]);
  });

  it("[law:recognition-self-contained] SABOTAGE: detects deleted inference roads", () => {
    expect(
      obsoleteInferenceReferences(
        'await ctx.infer.embed(input); fetch("centraid://enrichment/ocr");'
      )
    ).toStrictEqual(["centraid://enrichment/", "ctx.infer"]);
  });
});
