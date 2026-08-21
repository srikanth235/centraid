/**
 * Shared machinery for the fuzz target catalog (#839 G10).
 *
 * The invariant primitives, the module-resolution helper every target loads
 * its entry point through, and the reusable assertions that more than one
 * target's `run` leans on. `targets.mjs` re-exports the parts of this that are
 * public surface (`invariant`, `FuzzInvariantError`); the per-domain target
 * modules import the rest directly.
 *
 * Module resolution: five targets import the package's built
 * `dist/**.js` (run `bun run build` first), matching how
 * `scripts/design-gallery.mjs` reads `packages/design/dist/font-faces.js`.
 * `packages/client` emits declarations only, so its source `.ts` is imported
 * directly — see `scripts/fuzz/ts-resolve.mjs`.
 */
import { existsSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "../..");

/** A violated invariant. Carries the finding class the register is keyed by. */
export class FuzzInvariantError extends Error {
  /**
   * @param {string} className Stable finding class.
   * @param {string} message Human-readable detail.
   */
  constructor(className, message) {
    super(message);
    this.name = "FuzzInvariantError";
    this.className = className;
  }
}

/**
 * Assert a target invariant.
 * @param {unknown} condition Must be truthy.
 * @param {string} className Stable finding class (register key).
 * @param {string} message Human-readable detail.
 * @returns {asserts condition} Throws {@link FuzzInvariantError} when false.
 */
export function invariant(condition, className, message) {
  if (!condition) throw new FuzzInvariantError(className, message);
}

/**
 * Key-ordered JSON so two structurally equal values compare as strings.
 * @param {unknown} value Any JSON value.
 * @returns {string} Canonical serialization.
 */
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

/**
 * Import a module by absolute repo path.
 * @param {string} relative Repo-relative module path.
 * @param {string} buildHint What to run when the file is missing.
 * @returns {Promise<Record<string, Function>>} Module namespace.
 */
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
/** packages/client emits declarations only — its source is the artifact. */
export const CLIENT_SOURCE_HINT = "git checkout packages/client/src";

/** FTS5 prefix grammar the gateway promises: quoted phrases joined by AND. */
const FTS_GRAMMAR = /^"[^"]+"\*(?: "[^"]+"\*)*$/u;

/** Reasons `judgeGatewayInfo` is allowed to refuse with. */
export const HANDSHAKE_REASONS = new Set([
  "unreachable",
  "malformed",
  "protocol_mismatch",
]);

/** Every field `judgeGatewayInfo` may place on an accepted `GatewayInfo`. */
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

/** How many bytes of a decoded CBSF directory get a corruption probe. */
const CBSF_CORRUPTION_PROBES = 32;

/**
 * Byte offsets to corrupt when probing a cleanly-decoded CBSF directory.
 * The 16-byte fixed prefix is probed exhaustively; the variable-length
 * sealed-length table is sampled on a fixed stride so the probe cost per
 * execution stays bounded and fully deterministic.
 * @param {number} length Directory byte length.
 * @returns {number[]} Ascending, de-duplicated offsets.
 */
export function corruptionOffsets(length) {
  const offsets = new Set();
  for (let offset = 0; offset < Math.min(16, length); offset += 1)
    offsets.add(offset);
  const stride = Math.max(4, Math.ceil((length - 16) / CBSF_CORRUPTION_PROBES));
  for (let offset = 16; offset < length; offset += stride) offsets.add(offset);
  return [...offsets];
}

/**
 * Is `value` a plain uint32?
 * @param {unknown} value Candidate.
 * @returns {boolean} True for 0..2^32-1 integers.
 */
export const isUint32 = (value) =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= UINT32_MAX;

/**
 * Assert a compiled FTS expression cannot escape its own quoting.
 * @param {string} expression Compiled MATCH expression.
 * @param {string} className Finding class prefix.
 */
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

/**
 * Assert that re-formatting a parsed address reproduces the key it came from.
 *
 * Split into two finding classes on purpose. A formatter that THROWS means the
 * parser admitted an address the formatter refuses to emit — the two halves of
 * the codec disagree about what is legal, which is how a corrupt provider
 * listing becomes a "valid" address downstream. A formatter that returns a
 * DIFFERENT string means the key is not a faithful encoding of the address.
 * @param {(address: object) => string} format Key formatter.
 * @param {object} address Parsed address.
 * @param {string} key Key the address was parsed from.
 * @param {string} className Finding class prefix.
 */
export function assertKeyRoundtrip(format, address, key, className) {
  let formatted;
  try {
    formatted = format(address);
  } catch (error) {
    // Typed translation into a finding — the throw IS the result being tested.
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
