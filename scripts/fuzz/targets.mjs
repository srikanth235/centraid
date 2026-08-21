/**
 * Fuzz target catalog (#839 G10).
 *
 * A target is a parser or expression compiler that eats bytes somebody else
 * chose — a wire frame, a QR payload, an object key from a storage provider, a
 * search box. Each entry names the entry function, the committed seed corpus,
 * and the *invariant*: the property that must hold for every input, not just
 * the ones we thought of.
 *
 * Every invariant is stated as `invariant(condition, class, message)`. The
 * `class` is the finding's identity: `scripts/fuzz/known-findings.json` is
 * keyed by it, so a divergence we have already recorded is reported without
 * failing the lane while anything new fails it. Inputs are always bytes — the
 * per-target `run` decodes them, which is where the structure-awareness lives.
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

import { utf8 } from "./mutate.mjs";

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
function stableStringify(value) {
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
async function importByPath(relative, buildHint) {
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

const BUILD = "bun run build";
/** packages/client emits declarations only — its source is the artifact. */
const CLIENT_SOURCE_HINT = "git checkout packages/client/src";

/** FTS5 prefix grammar the gateway promises: quoted phrases joined by AND. */
const FTS_GRAMMAR = /^"[^"]+"\*(?: "[^"]+"\*)*$/u;

/** Reasons `judgeGatewayInfo` is allowed to refuse with. */
const HANDSHAKE_REASONS = new Set([
  "unreachable",
  "malformed",
  "protocol_mismatch",
]);

/** Every field `judgeGatewayInfo` may place on an accepted `GatewayInfo`. */
const HANDSHAKE_INFO_FIELDS = new Set([
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

const UINT32_MAX = 0xff_ff_ff_ff;

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
function corruptionOffsets(length) {
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
const isUint32 = (value) =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= UINT32_MAX;

/**
 * Assert a compiled FTS expression cannot escape its own quoting.
 * @param {string} expression Compiled MATCH expression.
 * @param {string} className Finding class prefix.
 */
function assertFtsGrammar(expression, className) {
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
function assertKeyRoundtrip(format, address, key, className) {
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

/** @type {FuzzTarget[]} */
export const FUZZ_TARGETS = [
  {
    id: "protocol-handshake",
    title: "gateway info handshake judge",
    entry: "packages/core/src/protocol/handshake.ts",
    structure: "json",
    dictionary: [
      '{"version":"0.1.0","protocolVersion":3,"minSupportedProtocol":3,"capabilities":',
      '"protocolVersion":',
      '"minSupportedProtocol":',
      '"capabilities":',
      '"version":',
      '"endpointTicket":',
      '"authenticated":',
      "3",
      "-1",
      "1e309",
    ],
    iterations: 4_000_000,
    smokeIterations: 4_000,
    async load() {
      const { judgeGatewayInfo, readProtocolFromInfo, isGatewayCapabilities } =
        await importByPath("packages/core/dist/protocol/index.js", BUILD);
      return (bytes) => {
        const text = utf8(bytes);
        let value;
        let wasJson = true;
        try {
          value = JSON.parse(text);
        } catch {
          // A non-JSON body is a legitimate handshake input (a proxy error
          // page, a truncated response); feed the raw text through instead.
          wasJson = false;
          value = text;
        }
        const result = judgeGatewayInfo(value);
        invariant(
          result !== null && typeof result === "object",
          "handshake.result-shape",
          `judgeGatewayInfo returned ${String(result)}`
        );
        if (result.ok) {
          const { info } = result;
          invariant(
            typeof info.version === "string",
            "handshake.accepted-version",
            "accepted info carries a non-string version"
          );
          invariant(
            Number.isSafeInteger(info.protocolVersion) &&
              Number.isSafeInteger(info.minSupportedProtocol),
            "handshake.accepted-protocol",
            `accepted info carries protocolVersion ${info.protocolVersion} / min ${info.minSupportedProtocol}`
          );
          invariant(
            isGatewayCapabilities(info.capabilities),
            "handshake.accepted-capabilities",
            "accepted info carries a capability map the guard rejects"
          );
          for (const key of Object.keys(info)) {
            invariant(
              HANDSHAKE_INFO_FIELDS.has(key),
              "handshake.field-leak",
              `accepted info leaked an undeclared field "${key}" from the wire`
            );
          }
          invariant(
            judgeGatewayInfo(info).ok,
            "handshake.not-idempotent",
            "re-judging an accepted GatewayInfo refuses it"
          );
        } else {
          invariant(
            HANDSHAKE_REASONS.has(result.reason),
            "handshake.reason",
            `refusal used an undeclared reason "${result.reason}"`
          );
          invariant(
            typeof result.detail === "string" && result.detail.length > 0,
            "handshake.detail",
            "refusal carries no detail string"
          );
        }
        if (value !== null && typeof value === "object") {
          const read = readProtocolFromInfo(value);
          for (const field of ["protocolVersion", "minSupportedProtocol"]) {
            invariant(
              read[field] === null || Number.isSafeInteger(read[field]),
              "handshake.protocol-read",
              `readProtocolFromInfo returned ${String(read[field])} for ${field}`
            );
          }
        }
        // The refusal detail is drawn from a small fixed set, so it is a
        // usable stand-in for "which branch did we reach".
        return `json:${wasJson}|ok:${result.ok}|${result.ok ? `accepted:${Object.keys(result.info).length}` : `${result.reason}:${result.detail.slice(0, 40)}`}`;
      };
    },
  },
  {
    id: "tunnel-wire",
    title: "pair QR payload + header frame codec",
    entry: "packages/tunnel/src/protocol.ts",
    structure: "json",
    dictionary: [
      '{"v":1,"kind":"centraid-pair","ticket":"',
      '","code":"',
      '"kind":"centraid-pair"',
      '"v":1',
      '"ticket":',
      '"code":',
      '{"method":"GET","target":"/centraid/","headers":{}}',
      '"headers":',
      '"transfer-encoding"',
    ],
    iterations: 1_600_000,
    smokeIterations: 3_000,
    async load() {
      const { parsePairQrPayload, encodeHeaderFrame } = await importByPath(
        "packages/tunnel/dist/protocol.js",
        BUILD
      );
      return (bytes) => {
        const text = utf8(bytes);
        const payload = parsePairQrPayload(text);
        if (payload !== undefined) {
          invariant(
            payload.v === 1 && payload.kind === "centraid-pair",
            "tunnel.pair-discriminant",
            "accepted a payload without the pair discriminant"
          );
          invariant(
            typeof payload.ticket === "string" &&
              typeof payload.code === "string",
            "tunnel.pair-fields",
            "accepted payload carries non-string ticket/code"
          );
          invariant(
            Object.keys(payload).length === 4,
            "tunnel.pair-field-leak",
            `accepted payload carries ${Object.keys(payload).length} fields — extra wire fields must not survive parsing`
          );
          invariant(
            stableStringify(parsePairQrPayload(JSON.stringify(payload))) ===
              stableStringify(payload),
            "tunnel.pair-roundtrip",
            "re-encoding an accepted payload does not re-parse to itself"
          );
        }
        // Header frames are encoded from values the peer supplied, so the
        // length prefix must always describe exactly the JSON that follows.
        let header;
        try {
          header = JSON.parse(text);
        } catch {
          header = { method: text.slice(0, 64), target: "/", headers: {} };
        }
        const frame = encodeHeaderFrame(header);
        invariant(
          Array.isArray(frame) && frame.length >= 4,
          "tunnel.frame-shape",
          `encodeHeaderFrame returned ${frame?.length} bytes`
        );
        invariant(
          frame.every(
            (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255
          ),
          "tunnel.frame-bytes",
          "encoded frame contains a non-byte value"
        );
        const buffer = Buffer.from(frame);
        const declared = buffer.readUInt32BE(0);
        invariant(
          declared === buffer.length - 4,
          "tunnel.frame-length",
          `length prefix says ${declared} but ${buffer.length - 4} JSON bytes follow`
        );
        const decoded = JSON.parse(buffer.subarray(4).toString("utf8"));
        invariant(
          stableStringify(decoded) === stableStringify(header),
          "tunnel.frame-roundtrip",
          "decoding an encoded header frame does not reproduce the header"
        );
        const headerShape = Array.isArray(header)
          ? `array:${Math.min(header.length, 8)}`
          : header !== null && typeof header === "object"
            ? `object:${Math.min(Object.keys(header).length, 8)}`
            : `${header === null ? "null" : typeof header}`;
        return `pair:${payload === undefined ? "reject" : "accept"}|hdr:${headerShape}|frame:${Math.min(frame.length, 512)}`;
      };
    },
  },
  {
    id: "cbsf-directory",
    title: "CBSF v2 blob directory decoder",
    entry: "packages/core/src/blob/cbsf.ts",
    structure: "bytes",
    // Byte target: the interesting-word strategy already supplies the
    // integer boundaries; the only useful literal is the format magic.
    dictionary: ["CBSF"],
    iterations: 2_000_000,
    smokeIterations: 1_500,
    async load() {
      const { decodeCbsfDirectory, encodeCbsfDirectory } = await importByPath(
        "packages/core/dist/blob/index.js",
        BUILD
      );
      // `frameCount` reaches the decoder from a CBSF trailer `getUint32`, so
      // the reachable domain is exactly uint32 (see
      // packages/client/src/device-blob-source.ts).
      const frameCountsFor = (bytes) => {
        const exact =
          bytes.length >= 16 && (bytes.length - 16) % 4 === 0
            ? (bytes.length - 16) / 4
            : 0;
        const fromBytes =
          bytes.length >= 4
            ? new DataView(
                bytes.buffer,
                bytes.byteOffset,
                bytes.byteLength
              ).getUint32(0, false)
            : 0;
        return [exact, bytes[0] ?? 0, fromBytes, UINT32_MAX];
      };
      return (bytes) => {
        const outcomes = [];
        for (const frameCount of frameCountsFor(bytes)) {
          let decoded = null;
          let failure = null;
          try {
            decoded = decodeCbsfDirectory(bytes, frameCount);
          } catch (error) {
            failure = error;
          }
          if (failure) {
            invariant(
              failure instanceof Error,
              "cbsf.non-error-throw",
              `decode threw a non-Error: ${String(failure)}`
            );
            invariant(
              failure.message.startsWith("CBSF directory "),
              "cbsf.uncontrolled-error",
              `decode threw an uncontrolled ${failure.name}: ${failure.message}`
            );
            outcomes.push("reject");
            continue;
          }
          invariant(
            isUint32(decoded.frameSize),
            "cbsf.frame-size",
            `frameSize ${decoded.frameSize} is not a uint32`
          );
          invariant(
            Number.isSafeInteger(decoded.totalSize) && decoded.totalSize >= 0,
            "cbsf.total-size",
            `totalSize ${decoded.totalSize} is not a non-negative safe integer`
          );
          invariant(
            decoded.sealedLens.length === frameCount &&
              decoded.sealedLens.every(isUint32),
            "cbsf.sealed-lens",
            `sealedLens has ${decoded.sealedLens.length} uint32 entries for frameCount ${frameCount}`
          );
          invariant(
            Buffer.compare(
              Buffer.from(
                encodeCbsfDirectory(
                  decoded.frameSize,
                  decoded.totalSize,
                  decoded.sealedLens
                )
              ),
              Buffer.from(bytes)
            ) === 0,
            "cbsf.roundtrip",
            "re-encoding a decoded directory is not byte-identical to its input"
          );
          // Valid-prefix corruption: a directory that decoded cleanly must not
          // absorb a flipped bit silently — every byte of it is load-bearing.
          // The 16-byte fixed prefix is always probed; the sealed-length table
          // is sampled on a fixed stride so a 4 KiB directory still costs a
          // bounded number of decodes per execution.
          for (const offset of corruptionOffsets(bytes.length)) {
            const corrupted = Uint8Array.from(bytes);
            corrupted[offset] ^= 0x80;
            let corruptDecoded = null;
            let corruptFailure = null;
            try {
              corruptDecoded = decodeCbsfDirectory(corrupted, frameCount);
            } catch (error) {
              corruptFailure = error;
            }
            if (corruptFailure) {
              invariant(
                corruptFailure instanceof Error &&
                  corruptFailure.message.startsWith("CBSF directory "),
                "cbsf.uncontrolled-error",
                `corrupted decode threw an uncontrolled error: ${String(corruptFailure)}`
              );
              continue;
            }
            invariant(
              stableStringify(corruptDecoded) !== stableStringify(decoded),
              "cbsf.silent-corruption",
              `flipping bit 7 of byte ${offset} decodes to the same directory — the byte is not read`
            );
          }
          outcomes.push(`accept:${decoded.sealedLens.length}`);
        }
        return `len:${bytes.length}|${outcomes.join(",")}`;
      };
    },
  },
  {
    id: "wal-keys",
    title: "WAL segment / closer / pair-marker key parsers",
    entry: "packages/backup/src/wal-format.ts",
    structure: "text",
    dictionary: [
      "wal/vault/",
      "wal/journal/",
      "wal/tick/",
      "closed-",
      "00000000",
      "000000000000",
      "0000000000000",
      "0123456789abcdef0123456789abcdef",
      "-",
      "/",
    ],
    iterations: 14_000_000,
    smokeIterations: 6_000,
    async load() {
      const {
        parseWalSegmentKey,
        parseWalCloserKey,
        parseWalPairMarkerKey,
        walSegmentKey,
        walGroupCloserKey,
        walPairMarkerKey,
      } = await importByPath("packages/backup/dist/wal-format.js", BUILD);
      const GENERATION = /^[0-9a-f]{32}$/u;
      const isOffset = (value) =>
        Number.isSafeInteger(value) && value >= 0 && value <= 999_999_999_999;
      return (bytes) => {
        const key = utf8(bytes);
        const segment = parseWalSegmentKey(key);
        const closer = parseWalCloserKey(key);
        const marker = parseWalPairMarkerKey(key);
        invariant(
          [segment, closer, marker].filter(Boolean).length <= 1,
          "wal.ambiguous-key",
          `key parses as more than one WAL object kind: ${JSON.stringify(key)}`
        );
        if (segment) {
          invariant(
            segment.db === "vault" || segment.db === "journal",
            "wal.segment-db",
            `segment db "${segment.db}" is not a WAL database`
          );
          invariant(
            GENERATION.test(segment.generation),
            "wal.segment-generation",
            `segment generation "${segment.generation}" is not 32 lowercase hex`
          );
          invariant(
            isOffset(segment.startOffset) &&
              isOffset(segment.endOffset) &&
              segment.endOffset > segment.startOffset,
            "wal.segment-offsets",
            `segment offsets ${segment.startOffset}..${segment.endOffset} are not a forward range`
          );
          invariant(
            Number.isSafeInteger(segment.group) &&
              segment.group >= 0 &&
              Number.isSafeInteger(segment.tickMs) &&
              segment.tickMs >= 0,
            "wal.segment-numbers",
            `segment group ${segment.group} / tick ${segment.tickMs} are not non-negative safe integers`
          );
          assertKeyRoundtrip(
            walSegmentKey,
            segment,
            key,
            "wal.segment-roundtrip"
          );
        }
        if (closer) {
          invariant(
            (closer.db === "vault" || closer.db === "journal") &&
              GENERATION.test(closer.generation) &&
              Number.isSafeInteger(closer.group) &&
              closer.group >= 0 &&
              isOffset(closer.endOffset),
            "wal.closer-fields",
            `closer fields are out of contract: ${JSON.stringify(closer)}`
          );
          assertKeyRoundtrip(
            walGroupCloserKey,
            closer,
            key,
            "wal.closer-roundtrip"
          );
        }
        if (marker) {
          invariant(
            GENERATION.test(marker.vaultGeneration) &&
              GENERATION.test(marker.journalGeneration) &&
              Number.isSafeInteger(marker.tickMs) &&
              marker.tickMs >= 0,
            "wal.marker-fields",
            `pair-marker fields are out of contract: ${JSON.stringify(marker)}`
          );
          assertKeyRoundtrip(
            walPairMarkerKey,
            marker,
            key,
            "wal.marker-roundtrip"
          );
        }
        const kind = segment
          ? "segment"
          : closer
            ? "closer"
            : marker
              ? "marker"
              : "none";
        // Coarse on purpose: the signature drives corpus promotion, so it
        // classifies key SHAPES (kind, depth, first segment) rather than key
        // contents — otherwise every random byte string looks "new".
        return `${kind}|seg:${key.split("/").length}|head:${key.slice(0, 4)}`;
      };
    },
  },
  {
    id: "fts-match",
    title: "FTS5 MATCH expression compilers (gateway + replica)",
    entry: "packages/vault/src/gateway/search.ts",
    structure: "text",
    dictionary: [
      '"',
      "*",
      "AND",
      "OR",
      "NOT",
      "NEAR",
      "-",
      "^",
      ":",
      "(",
      ")",
      "\u0301",
      "\u200B",
      "  ",
      "budget",
    ],
    iterations: 2_800_000,
    smokeIterations: 4_000,
    async load() {
      const { ftsMatchExpression } = await importByPath(
        "packages/vault/dist/gateway/search.js",
        BUILD
      );
      const { replicaFtsMatchExpression } = await importByPath(
        "packages/client/src/replica/search.ts",
        CLIENT_SOURCE_HINT
      );
      return (bytes) => {
        const query = utf8(bytes);
        const gateway = ftsMatchExpression(query);
        if (gateway !== null) assertFtsGrammar(gateway, "fts.gateway");
        let replica = null;
        let refusal = null;
        try {
          replica = replicaFtsMatchExpression(query);
        } catch (error) {
          refusal = error;
        }
        if (refusal) {
          invariant(
            refusal instanceof Error && refusal.name === "ReplicaProtocolError",
            "fts.replica-untyped-throw",
            `replica compiler threw an untyped ${String(refusal)}`
          );
        } else {
          assertFtsGrammar(replica, "fts.replica");
        }
        const terms = (expression) =>
          expression === null ? "null" : String(expression.split(" ").length);
        return `gw:${terms(gateway)}|rep:${refusal ? "refuse" : terms(replica)}|punct:${gateway !== null && /[^\p{L}\p{N}"*\s]/u.test(gateway)}`;
      };
    },
  },
  {
    id: "fts-mirror",
    title: "replica FTS compiler mirrors the canonical gateway",
    entry: "packages/client/src/replica/search.ts",
    structure: "text",
    dictionary: [
      "-",
      ".",
      "_",
      "'",
      "\u0301",
      "a-b",
      "3.14",
      "don't",
      "budget",
      " ",
    ],
    iterations: 3_600_000,
    smokeIterations: 3_000,
    async load() {
      const { ftsMatchExpression } = await importByPath(
        "packages/vault/dist/gateway/search.js",
        BUILD
      );
      const { replicaFtsMatchExpression } = await importByPath(
        "packages/client/src/replica/search.ts",
        CLIENT_SOURCE_HINT
      );
      return (bytes) => {
        const query = utf8(bytes);
        const gateway = ftsMatchExpression(query);
        let replica = null;
        let refused = false;
        try {
          replica = replicaFtsMatchExpression(query);
        } catch {
          // A refusal is the replica's way of saying "no searchable words";
          // the gateway says the same thing by returning null.
          refused = true;
        }
        invariant(
          refused === (gateway === null),
          "fts-mirror.decision",
          `gateway ${gateway === null ? "refused" : "compiled"} but replica ${refused ? "refused" : "compiled"}: ${JSON.stringify(query)}`
        );
        if (!refused) {
          invariant(
            replica === gateway,
            "fts-mirror.expression",
            `gateway compiled ${JSON.stringify(gateway)} but replica compiled ${JSON.stringify(replica)}: ${JSON.stringify(query)}`
          );
        }
        return `agree:${refused ? "refuse" : `${replica === gateway}:${gateway.split(" ").length}`}`;
      };
    },
  },
];

/**
 * Look up a target by id.
 * @param {string} id Target id.
 * @returns {FuzzTarget} The target.
 */
export function targetById(id) {
  const target = FUZZ_TARGETS.find((entry) => entry.id === id);
  if (!target) throw new Error(`fuzz: unknown target "${id}"`);
  return target;
}
