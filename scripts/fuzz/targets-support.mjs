import { existsSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "../..");

export class FuzzInvariantError extends Error {
  constructor(className, message) {
    super(message);
    this.name = "FuzzInvariantError";
    this.className = className;
  }
}

export function invariant(condition, className, message) {
  if (!condition) throw new FuzzInvariantError(className, message);
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = /** @type {Record<string, unknown>} */ (value);
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

let tsHookRegistered = false;

export async function importByPath(relative, buildHint) {
  const absolute = path.join(root, relative);
  if (!existsSync(absolute)) {
    throw new Error(`fuzz: missing ${relative} — run \`${buildHint}\` first`);
  }
  if (relative.endsWith(".ts") && !tsHookRegistered && !process.env.VITEST) {
    register(new URL("ts-resolve.mjs", import.meta.url));
    tsHookRegistered = true;
  }
  return import(pathToFileURL(absolute).href);
}

export const BUILD = "bun run build";
export const CLIENT_SOURCE_HINT = "git checkout packages/client/src";

const FTS_GRAMMAR = /^"[^"]+"\*(?: "[^"]+"\*)*$/u;

export const HANDSHAKE_REASONS = new Set([
  "unreachable",
  "malformed",
  "protocol_mismatch",
]);

export const HANDSHAKE_INFO_FIELDS = new Set([
  "version",
  "protocolVersion",
  "minSupportedProtocol",
  "capabilities",
  "instanceId",
  "startedAt",
  "uptimeMs",
  "authenticated",
  "endpointId",
  "endpointTicket",
]);

export const UINT32_MAX = 0xff_ff_ff_ff;

const CBSF_CORRUPTION_PROBES = 32;

export function corruptionOffsets(length) {
  const offsets = new Set();
  for (let offset = 0; offset < Math.min(16, length); offset += 1)
    offsets.add(offset);
  const stride = Math.max(4, Math.ceil((length - 16) / CBSF_CORRUPTION_PROBES));
  for (let offset = 16; offset < length; offset += stride) offsets.add(offset);
  return [...offsets];
}

export const isUint32 = (value) =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= UINT32_MAX;

export function assertFtsGrammar(expression, className) {
  invariant(
    typeof expression === "string",
    `${className}.type`,
    `expected a string expression, got ${typeof expression}`
  );
  invariant(
    FTS_GRAMMAR.test(expression),
    `${className}.grammar`,
    `expression escapes the quoted-prefix grammar: ${JSON.stringify(expression)}`
  );
  const terms = expression.split(" ");
  invariant(
    terms.length <= 16,
    `${className}.bound`,
    `expression carries ${terms.length} terms, bound is 16`
  );
  const quotes = [...expression].filter((char) => char === '"').length;
  invariant(
    quotes === terms.length * 2,
    `${className}.quoting`,
    `expression has ${quotes} quote characters for ${terms.length} terms — a token smuggled a quote through`
  );
}

export function assertKeyRoundtrip(format, address, key, className) {
  let formatted;
  try {
    formatted = format(address);
  } catch (error) {
    invariant(
      false,
      `${className}-rejected`,
      `the parser accepted ${JSON.stringify(key)} but the formatter refuses the address it produced: ${String(error)}`
    );
  }
  invariant(
    formatted === key,
    className,
    `re-formatting the parsed address yields ${JSON.stringify(formatted)}, not the input key ${JSON.stringify(key)}`
  );
}

/**
 * @typedef {object} FuzzTarget
 * @property {string} id Stable target id (corpus + crasher directory name).
 * @property {string} title One-line description for the summary.
 * @property {string} entry Source of truth being fuzzed.
 * @property {"json" | "text" | "bytes"} structure Mutation shape hint.
 * @property {readonly string[]} dictionary Grammar tokens worth splicing in.
 * @property {number} iterations Executions in the full lane.
 * @property {number} smokeIterations Executions in `--smoke`.
 * @property {() => Promise<(bytes: Uint8Array) => string>} load Resolve the target; returns a runner that yields a behaviour signature.
 */
