/*
 * [law:provider-egress-dispatch] — outbound provider work leaves centraid by
 * ONE road (issue #839, G5).
 *
 * THE LAW. A request that reaches a third-party model provider happens only via
 * the ACP dispatch path: `runTurn` (`acp/runtime.ts`) resolves a spec from
 * `HARNESSES` (`acp/registry.ts`) and launches it through `harnessSpawnEnv`
 * (`acp/spawn-env.ts`), and an ENRICHMENT fire may only get there after
 * `decideEnrichmentGate` (`automation/fire/enrich-gate.ts`) said yes. Nothing
 * in the gateway host's request path or in the shells may open its own road:
 * no provider SDK import, no bare `fetch`/`undici`/`node:https` at a provider
 * host, no dynamic `import()` of a provider package.
 *
 * WHY THIS AND NOT `no-inference-client.test.ts`. That law — recognition
 * self-containment, owned there — governs BLUEPRINT seats: apps,
 * automations, and the mobile client — and says a blueprint reaches a model
 * only through `ctx.delegate` or the device work-lease lane. This one governs
 * the HOST: `packages/server/src/{acp,enrich,engine,routes,serve}` and
 * `apps/{desktop,web,extension}/src`, the surfaces a blueprint's seat law never
 * looks at, and it is about the dispatch path rather than about the seat. Two
 * laws, two owners, no overlap in either roster or root — deliberately separate
 * files so "one law, one home" stays true (`scripts/lint-law-registry.mjs`).
 *
 * IT IS A TRIPWIRE, NOT A PROOF — the same caveat the sibling law carries. A
 * determined author dodges it with an alias, a computed specifier, or a host
 * assembled from fragments. It catches the ordinary mistake: reaching for the
 * SDK, or curling the provider directly, because it was the fastest way. The
 * SABOTAGE cases at the bottom exist so the scanner cannot rot into a
 * green no-op when a roster or a root silently stops matching anything.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { HARNESSES, getHarness } from "./acp/registry.js";
import { runTurn } from "./acp/runtime.js";
import { harnessSpawnEnv } from "./acp/spawn-env.js";
import { decideEnrichmentGate } from "./automation/fire/enrich-gate.js";

const SERVER_SRC = path.resolve(import.meta.dirname);
const REPO_ROOT = path.resolve(SERVER_SRC, "../../..");

/**
 * The host request path (where a provider client would be smuggled into a
 * route, a turn, or the enrichment lane) plus the three shells. `acp/` is
 * INCLUDED even though it owns the legal road: the road is a subprocess spawn,
 * so an HTTP client appearing there would be a second road wearing the first
 * one's name.
 */
const SCANNED_ROOTS = [
  ...["acp", "enrich", "engine", "routes", "serve"].map((dir) =>
    path.join(SERVER_SRC, dir)
  ),
  ...["desktop", "web", "extension"].map((app) =>
    path.join(REPO_ROOT, "apps", app, "src")
  ),
] as const;

/** Third-party inference/provider SDKs. No host-path file has business importing one. */
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

/**
 * Provider API hosts. A literal carrying one of these IS the bare-fetch road —
 * it is the only part of `fetch(url, …)` that a text scan can recognise, and
 * the only part an author cannot omit.
 */
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

/**
 * HTTP client modules whose only reason to appear on the host request path
 * would be talking to something the ACP dispatch path already talks to.
 * `node:http` is deliberately ABSENT — the gateway's own listener is built on
 * it, and banning the server would say nothing about egress.
 */
const HTTP_CLIENT_MODULES = [
  "undici",
  "node:https",
  "axios",
  "got",
  "node-fetch",
  "superagent",
] as const;

/**
 * Matches the specifier of `import … from "X"`, bare `import "X"`,
 * `require("X")`, or a dynamic `import("X")` — single or double quoted. Same
 * shape as the sibling law's matcher: only real specifiers, never prose.
 */
const IMPORT_SPECIFIER_RE =
  /(?:from\s+|require\(|import\()\s*["'](?<specifier>[^"']+)["']/gu;

/**
 * String literals (single, double, template). Provider HOSTS are matched only
 * inside one of these, so a comment that names a provider's API — or this
 * file's own prose — is not a violation. A URL that is actually fetched cannot
 * avoid being a literal somewhere on the path.
 */
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

/** Provider SDK specifiers imported (statically, by require, or dynamically). */
function importedProviderSdks(text: string): string[] {
  return specifiers(text).filter((specifier) =>
    PROVIDER_PACKAGES.some(
      (name) => specifier === name || specifier.startsWith(name)
    )
  );
}

/** HTTP-client module specifiers — the carriers of a bare provider request. */
function importedHttpClients(text: string): string[] {
  return specifiers(text).filter((specifier) =>
    HTTP_CLIENT_MODULES.some(
      (name) => specifier === name || specifier.startsWith(`${name}/`)
    )
  );
}

/** Provider hosts appearing inside a string literal. */
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

/**
 * Assemble a specifier or host from fragments. The SABOTAGE case needs real
 * violating text; writing it whole would put a provider specifier into this
 * file's own source, where the next widening of `SCANNED_ROOTS` would find it.
 */
const fragments = (...parts: readonly string[]): string => parts.join("");

/** Every violation the three detectors find, as `file → what`. */
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
    // Without this the whole law degrades to a green no-op the first time a
    // directory is renamed — the failure mode a source scan has and a unit test
    // does not.
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
    // The positive half. A negative scan over an absent path proves nothing, so
    // the law also pins that the path it points at still exists and still has
    // the shape it claims: a turn entry, a closed dispatch table, a spawn env,
    // and a gate upstream of the enrichment lane.
    expect(runTurn).toBeTypeOf("function");
    expect(getHarness).toBeTypeOf("function");
    expect(decideEnrichmentGate).toBeTypeOf("function");
    expect(Object.keys(HARNESSES).length).toBeGreaterThan(0);
    // Every registered harness is a launchable CLI spec — provider reach is a
    // subprocess boundary, which is why no HTTP client belongs on this path.
    for (const [kind, spec] of Object.entries(HARNESSES)) {
      expect(spec, `harness ${kind} has no spec`).toBeDefined();
      expect(getHarness(kind as keyof typeof HARNESSES)).toBe(spec);
    }
    // The spawn env is a pure function over an env bag: it never opens a socket.
    expect(harnessSpawnEnv({ baseEnv: { PATH: "/usr/bin" } })).toMatchObject({
      PATH: "/usr/bin",
    });
  });

  it("[law:provider-egress-dispatch] SABOTAGE: each detector catches a violation it would otherwise miss", () => {
    // Specifiers and hosts are interpolated so this file does not trip its own
    // scan — and so a roster that silently stopped matching fails HERE, loudly,
    // instead of leaving the three scans above green over nothing.
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

    // …and the false-positive guards hold: a provider named in PROSE, or a
    // model id carried as DATA, is not a road.
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
