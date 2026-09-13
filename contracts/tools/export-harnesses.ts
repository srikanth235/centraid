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
    if (end === -1)
      throw new Error(`unbalanced ${marker} at ${at} in ${SOURCE}`);
    found.push(source.slice(open, end));
    at = source.indexOf(marker, end);
  }
  return found;
}

/**
 * Turn one object literal into JSON, then parse it.
 *
 * NOT `eval`, and not `new Function`. This script reads v0's source, and
 * evaluating source to extract constants from it is a class of tool that
 * executes whatever the file happens to contain — including, one refactor from
 * now, an import.
 *
 * The transformer is a one-pass scanner rather than a chain of `replace`
 * calls, because the literals here contain the two sequences a regex gets
 * wrong: `https://` inside a string looks like a comment, and a `//` comment
 * can sit between a key and its value. So string state is tracked explicitly
 * and only text OUTSIDE a string is rewritten:
 *
 * - `//` to end of line is dropped (the two SAFETY notes among them);
 * - a bare key becomes a quoted key;
 * - the one bare identifier in the shape, `resolveClaudeModel`, becomes the
 *   string `"resolveClaudeModel"`, so the fixture NAMES the model resolver
 *   instead of pretending it is absent;
 * - a trailing comma before a close is dropped.
 *
 * Anything else unquoted is a shape this script does not understand, and
 * `JSON.parse` refuses it loudly rather than guessing.
 */
function toJson(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === '"') {
      // A string, copied verbatim including escapes.
      out += char;
      index += 1;
      while (index < text.length) {
        const inner = text[index] ?? "";
        out += inner;
        index += 1;
        if (inner === "\\") {
          out += text[index] ?? "";
          index += 1;
          continue;
        }
        if (inner === '"') break;
      }
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (/[A-Za-z_$]/u.test(char)) {
      let word = "";
      while (index < text.length && /[\w$]/u.test(text[index] ?? "")) {
        word += text[index];
        index += 1;
      }
      // A key is an identifier followed by a colon; a value is not.
      const isKey = /^\s*:/u.test(text.slice(index));
      if (isKey || word === "resolveClaudeModel") {
        out += `"${word}"`;
      } else if (word === "true" || word === "false" || word === "null") {
        // JSON's own literals. Quoting them would turn `probeModels: true`
        // into the STRING "true", which is truthy in both languages and so
        // would never fail a test — the worst kind of wrong.
        out += word;
      } else {
        throw new Error(
          `${SOURCE} has a bare identifier \`${word}\` in a harness entry; this exporter only understands data literals and the \`resolveClaudeModel\` resolver`
        );
      }
      continue;
    }
    if (char === ",") {
      // Drop it when the next non-space character closes a collection.
      const rest = text.slice(index + 1);
      if (/^\s*[}\]]/u.test(rest)) {
        index += 1;
        continue;
      }
    }
    out += char;
    index += 1;
  }
  return out;
}

function evaluateSpec(text: string): RawSpec {
  const json = toJson(text);
  try {
    return JSON.parse(json) as RawSpec;
  } catch (error) {
    throw new Error(
      `a harness entry in ${SOURCE} is not a plain data literal any more, so it cannot be exported without evaluating code:\n${json}`,
      { cause: error }
    );
  }
}

/** The `SUPPORTED_HARNESS_KINDS` array literal, read from the same source. */
function supportedKinds(): string[] {
  const at = source.indexOf("export const SUPPORTED_HARNESS_KINDS");
  if (at === -1) throw new Error(`no SUPPORTED_HARNESS_KINDS in ${SOURCE}`);
  const open = source.indexOf("[", at);
  const close = source.indexOf("]", open);
  return (
    JSON.parse(
      `[${source
        .slice(open + 1, close)
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) => entry.replace(/^"|"$/gu, '"'))
        .join(",")}]`
    ) as string[]
  ).map((kind) => kind);
}

const specs = specSources().map(evaluateSpec);
const supported = supportedKinds();

for (const kind of supported) {
  if (!specs.some((spec) => spec.kind === kind)) {
    throw new Error(
      `SUPPORTED_HARNESS_KINDS names ${kind}, which is not registered`
    );
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
