import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { HARNESSES, getHarness } from "./acp/registry.js";
import { runTurn } from "./acp/runtime.js";
import { harnessSpawnEnv } from "./acp/spawn-env.js";
import { decideEnrichmentGate } from "./automation/fire/enrich-gate.js";

const SERVER_SRC = path.resolve(import.meta.dirname);
const REPO_ROOT = path.resolve(SERVER_SRC, "../../..");

const SCANNED_ROOTS = [
  ...["acp", "enrich", "engine", "routes", "serve"].map((dir) =>
    path.join(SERVER_SRC, dir)
  ),
  ...["desktop", "web", "extension"].map((app) =>
    path.join(REPO_ROOT, "apps", app, "src")
  ),
] as const;

const PROVIDER_PACKAGES = [
  "openai",
  "@anthropic-ai/",
  "@google/generative-ai",
  "@google/genai",
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
  "@azure/openai",
  "openrouter",
] as const;

const PROVIDER_HOSTS = [
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "aiplatform.googleapis.com",
  "api.mistral.ai",
  "api.cohere.ai",
  "api.cohere.com",
  "api.groq.com",
  "api.together.xyz",
  "api.together.ai",
  "api.replicate.com",
  "api-inference.huggingface.co",
  "bedrock-runtime.",
  "api.deepseek.com",
  "openrouter.ai",
  "api.x.ai",
  "api.perplexity.ai",
  "api.fireworks.ai",
  "127.0.0.1:11434",
  "localhost:11434",
] as const;

const HTTP_CLIENT_MODULES = [
  "undici",
  "node:https",
  "axios",
  "got",
  "node-fetch",
  "superagent",
] as const;

const IMPORT_SPECIFIER_RE =
  /(?:from\s+|require\(|import\()\s*["'](?<specifier>[^"']+)["']/gu;

const STRING_LITERAL_RE =
  /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/gu;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(?:ts|tsx|js|mjs)$/u.test(entry.name)) out.push(full);
  }
  return out;
}

function specifiers(text: string): string[] {
  return [...text.matchAll(IMPORT_SPECIFIER_RE)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]]
  );
}

function importedProviderSdks(text: string): string[] {
  return specifiers(text).filter((specifier) =>
    PROVIDER_PACKAGES.some(
      (name) => specifier === name || specifier.startsWith(name)
    )
  );
}

function importedHttpClients(text: string): string[] {
  return specifiers(text).filter((specifier) =>
    HTTP_CLIENT_MODULES.some(
      (name) => specifier === name || specifier.startsWith(`${name}/`)
    )
  );
}

function providerHostLiterals(text: string): string[] {
  const hits: string[] = [];
  for (const literal of text.match(STRING_LITERAL_RE) ?? []) {
    for (const host of PROVIDER_HOSTS) {
      if (literal.includes(host)) hits.push(host);
    }
  }
  return [...new Set(hits)];
}

const ALL_FILES = SCANNED_ROOTS.flatMap((dir) => {
  try {
    return statSync(dir).isDirectory() ? sourceFiles(dir) : [];
  } catch {
    return [];
  }
}).filter((file) => file !== import.meta.filename);

const relative = (file: string): string =>
  path.relative(REPO_ROOT, file).split(path.sep).join("/");

const fragments = (...parts: readonly string[]): string => parts.join("");

function violations(
  detect: (text: string) => string[]
): Array<{ file: string; hits: string[] }> {
  return ALL_FILES.flatMap((file) => {
    const hits = detect(readFileSync(file, "utf8"));
    return hits.length > 0 ? [{ file: relative(file), hits }] : [];
  });
}

describe("[law:provider-egress-dispatch] provider requests leave only via the ACP dispatch path", () => {
  it("sanity: the scan reaches every declared root", () => {
    const perRoot = Object.fromEntries(
      SCANNED_ROOTS.map((dir) => [
        relative(dir),
        ALL_FILES.filter((file) => file.startsWith(`${dir}${path.sep}`)).length,
      ])
    );
    for (const [root, count] of Object.entries(perRoot)) {
      expect(count, `${root} matched no source files`).toBeGreaterThan(10);
    }
    expect(ALL_FILES.length).toBeGreaterThan(500);
  });

  it("[law:provider-egress-dispatch] no host-path or shell file imports a provider SDK", () => {
    expect(
      violations(importedProviderSdks).map(
        (v) => `${v.file}: ${v.hits.join(", ")}`
      ),
      "the only road to a provider is the ACP dispatch path — runTurn resolves a " +
        "HARNESSES spec and spawns it through harnessSpawnEnv; a direct SDK import " +
        "is a second road with no gate in front of it"
    ).toStrictEqual([]);
  });

  it("[law:provider-egress-dispatch] no host-path or shell file names a provider API host", () => {
    expect(
      violations(providerHostLiterals).map(
        (v) => `${v.file}: ${v.hits.join(", ")}`
      ),
      "a provider host in a string literal is a bare fetch to a provider — the " +
        "request never passed decideEnrichmentGate and never appears on a turn"
    ).toStrictEqual([]);
  });

  it("[law:provider-egress-dispatch] no host-path or shell file imports its own HTTP client", () => {
    expect(
      violations(importedHttpClients).map(
        (v) => `${v.file}: ${v.hits.join(", ")}`
      ),
      "undici / node:https / axios-shaped clients on the host request path are how " +
        "a provider call gets written without naming a provider package. Outbound " +
        "connector reads ride ctx.fetch (host-pinned, allowlisted); provider work " +
        "rides the ACP harness subprocess"
    ).toStrictEqual([]);
  });

  it("[law:provider-egress-dispatch] the one legal road is present and is a spawned harness, not an HTTP client", () => {
    expect(runTurn).toBeTypeOf("function");
    expect(getHarness).toBeTypeOf("function");
    expect(decideEnrichmentGate).toBeTypeOf("function");
    expect(Object.keys(HARNESSES).length).toBeGreaterThan(0);
    for (const [kind, spec] of Object.entries(HARNESSES)) {
      expect(spec, `harness ${kind} has no spec`).toBeDefined();
      expect(getHarness(kind as keyof typeof HARNESSES)).toBe(spec);
    }
    expect(harnessSpawnEnv({ baseEnv: { PATH: "/usr/bin" } })).toMatchObject({
      PATH: "/usr/bin",
    });
  });

  it("[law:provider-egress-dispatch] SABOTAGE: each detector catches a violation it would otherwise miss", () => {
    const sdk = fragments("open", "ai");
    const scoped = fragments("@anthropic", "-ai/sdk");
    const host = fragments("api.", "openai", ".com");
    const client = fragments("und", "ici");
    const nodeHttps = fragments("node:", "https");

    expect(importedProviderSdks(`import OpenAI from "${sdk}";`)).toStrictEqual([
      sdk,
    ]);
    expect(
      importedProviderSdks(`const m = await import("${scoped}");`)
    ).toStrictEqual([scoped]);
    expect(
      importedProviderSdks(`const c = require("${sdk}/resources");`)
    ).toStrictEqual([`${sdk}/resources`]);
    expect(
      providerHostLiterals(`await fetch("https://${host}/v1/messages");`)
    ).toStrictEqual([host]);
    expect(
      importedHttpClients(`import { request } from "${client}";`)
    ).toStrictEqual([client]);
    expect(
      importedHttpClients(`import client from "${nodeHttps}";`)
    ).toStrictEqual([nodeHttps]);

    expect(
      importedProviderSdks(`// never reach for ${sdk} or ${scoped} here`)
    ).toStrictEqual([]);
    expect(
      providerHostLiterals(`// the gateway never calls ${host} directly`)
    ).toStrictEqual([]);
    expect(
      providerHostLiterals('{ "model": "anthropic/claude-3-5-sonnet" }')
    ).toStrictEqual([]);
    expect(importedHttpClients('import http from "node:http";')).toStrictEqual(
      []
    );
  });
});
