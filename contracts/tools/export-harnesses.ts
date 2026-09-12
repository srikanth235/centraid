// Export v0's harness registry as one language-neutral fixture (#1020, wave 4
// lane assist, D-1020-AS1).
//
// `packages/server/src/acp/registry.ts` states the law the port inherits:
// NOTHING ELSE BRANCHES ON THE KIND. Seventeen kinds differ only in how the ACP
// process is launched, and every one of those differences is data — `acpArgs`,
// `env`, `minVersion`, `defaultBin`, the adapter package and its bin-path
// environment variable, whether a model probe may spawn the harness at boot.
// So the registry is exported rather than re-typed: a second hand-written copy
// of `["exec","--output-format","acp-daemon"]` is how droid quietly stops
// launching.
//
// Regenerate with:
//
//   bun contracts/tools/export-harnesses.ts > contracts/assist/harnesses.json
//   bun run format
//
// ## Why this reads the source as TEXT rather than importing it
//
// `registry.ts` imports `./backends/acp/backend.js`, which pulls the whole ACP
// stack and `@agentclientprotocol/sdk` with it. Importing the module to read
// its data would mean installing v0's runtime dependencies to export a table of
// constants. So each `makeAcpHarness({ … })` argument is extracted as source
// and evaluated as a single object literal with `resolveModel` erased to its
// function NAME — the only non-data field in the shape, and one the Rust side
// resolves by name (`crates/assist/src/registry.rs`).
//
// ## The two SAFETY notes, and why they are not parsed
//
// `registry.ts:232`–`:235` (opencode) and `:270` (copilot) are prose comments
// that state a product decision: `--mdns` publishes an unauthenticated
// code-execution harness to the whole LAN, and `--port` would sit the harness
// on an unread socket. A regex over English would be a rule that a reworded
// comment silently deletes. So the refused arguments are declared HERE, as
// data, and this script ASSERTS that the comment it was derived from is still
// in the source — if someone removes the SAFETY note, the export fails loudly
// instead of shipping a refusal nobody can trace.

import { readFileSync } from "node:fs";

const SOURCE = "packages/server/src/acp/registry.ts";
const source = readFileSync(SOURCE, "utf8");

interface Adapter {
  packageName: string;
  binPathEnvVar: string;
  sessionModeId?: string;
  bypassNeedsSandboxWhenRoot?: boolean;
}

interface RawSpec {
  kind: string;
  label: string;
  defaultBin?: string;
  acpArgs: string[];
  minVersion: { major: number; minor: number; patch: number };
  installHint: string;
  env?: Record<string, string>;
  adapter?: Adapter;
  resolveModel?: string;
  probeModels?: boolean;
}

/**
 * An argument a user must never be able to add for this kind, and the sentence
 * that says why. Derived from the SAFETY comments cited in `assertNote`.
 */
const REFUSE_ARGS: Record<string, { arg: string; because: string }[]> = {
  opencode: [
    {
      arg: "--mdns",
      because:
        "it defaults opencode's listen host to 0.0.0.0, publishing an unauthenticated code-execution harness to the whole LAN (registry.ts:232-235)",
    },
  ],
  copilot: [
    {
      arg: "--port",
      because:
        "copilot is stdio only; --port would sit the harness on an unread socket (registry.ts:270)",
    },
  ],
};

/** The SAFETY prose each refusal was derived from must still be in the source. */
function assertNote(fragment: string): void {
  if (!source.includes(fragment)) {
    throw new Error(
      `${SOURCE} no longer contains the SAFETY note this export derives a refused argument from: ${JSON.stringify(fragment)}. Re-judge the refusal before regenerating.`
    );
  }
}

assertNote("never add `--mdns` to these args");
assertNote("`--port` would sit the harness on an unread socket");

/** Every `makeAcpHarness({ … })` argument, as source text. */
function specSources(): string[] {
  const found: string[] = [];
  const marker = "makeAcpHarness({";
  let at = source.indexOf(marker);
  while (at !== -1) {
    const open = at + marker.length - 1;
    let depth = 0;
    let end = -1;
    for (let index = open; index < source.length; index += 1) {
      const char = source[index];
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
    if (end === -1) throw new Error(`unbalanced ${marker} at ${at} in ${SOURCE}`);
    found.push(source.slice(open, end));
    at = source.indexOf(marker, end);
  }
  return found;
}

/**
 * Evaluate one object literal. `resolveModel` is the single field whose value
 * is a function; it is replaced by its own identifier so the fixture names the
 * resolver instead of pretending it is absent.
 */
function evaluateSpec(text: string): RawSpec {
  const resolvers = new Proxy(
    {},
    { get: (_target, name: string): string => name }
  );
  const build = new Function(
    "resolveClaudeModel",
    `"use strict"; return (${text});`
  ) as (resolveClaudeModel: unknown) => RawSpec;
  return build((resolvers as Record<string, string>).resolveClaudeModel);
}

/** The `SUPPORTED_HARNESS_KINDS` array literal, read from the same source. */
function supportedKinds(): string[] {
  const at = source.indexOf("export const SUPPORTED_HARNESS_KINDS");
  if (at === -1) throw new Error(`no SUPPORTED_HARNESS_KINDS in ${SOURCE}`);
  const open = source.indexOf("[", at);
  const close = source.indexOf("]", open);
  return (JSON.parse(
    `[${source
      .slice(open + 1, close)
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => entry.replace(/^"|"$/gu, '"'))
      .join(",")}]`
  ) as string[]).map((kind) => kind);
}

const specs = specSources().map(evaluateSpec);
const supported = supportedKinds();

for (const kind of supported) {
  if (!specs.some((spec) => spec.kind === kind)) {
    throw new Error(`SUPPORTED_HARNESS_KINDS names ${kind}, which is not registered`);
  }
}

const harnesses = specs.map((spec) => ({
  kind: spec.kind,
  label: spec.label,
  defaultBin: spec.defaultBin ?? null,
  acpArgs: spec.acpArgs,
  minVersion: `${spec.minVersion.major}.${spec.minVersion.minor}.${spec.minVersion.patch}`,
  installHint: spec.installHint,
  env: spec.env ?? {},
  adapter: spec.adapter
    ? {
        packageName: spec.adapter.packageName,
        binPathEnvVar: spec.adapter.binPathEnvVar,
        sessionModeId: spec.adapter.sessionModeId ?? null,
        bypassNeedsSandboxWhenRoot:
          spec.adapter.bypassNeedsSandboxWhenRoot ?? false,
      }
    : null,
  resolveModel: spec.resolveModel ?? null,
  probeModels: spec.probeModels ?? false,
  refuseArgs: REFUSE_ARGS[spec.kind] ?? [],
}));

process.stdout.write(
  `${JSON.stringify(
    {
      origin: {
        source: SOURCE,
        generator: "contracts/tools/export-harnesses.ts",
        issue: "https://github.com/srikanth235/centraid/issues/1020",
        note: "GENERATED — do not edit. Regenerate from the v0 registry; see the generator's header.",
      },
      // The five-of-seventeen distinction is load-bearing: twelve kinds are
      // registered and launchable and are NOT in the supported list, and a port
      // that kept one list would either drop twelve kinds or claim support for
      // them (census §B1).
      supportedKinds: supported,
      harnesses,
    },
    null,
    2
  )}\n`
);
