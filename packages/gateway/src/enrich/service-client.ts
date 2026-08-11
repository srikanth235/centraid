// The enrichment service client (issue #724 W1): the ONE seam between this
// gateway and every model that derives something from an owner's bytes.
//
// WHY ONE SEAM. Before this module the gateway had a different mechanism per
// capability — a spawned embedder program, an OCR child process, a desktop ASR
// adapter reachable only from Electron's main process — each with its own
// configuration, its own timeout, its own failure vocabulary, and its own
// answer to "is this switched on here?". Three mechanisms is three sets of
// operator instructions and three places a privacy claim can quietly stop
// being true. One HTTP service is one thing to configure, one place to point
// at a machine the owner controls, and one contract to test against.
//
// LOOPBACK ONLY, AND WHY THAT IS THE WHOLE PRIVACY ARGUMENT. The endpoint must
// resolve to this machine (localhost, ::1, 127.x.x.x) — the same validation
// desktop's now-deleted on-device file-ASR adapter carried since issue #414
// D13 (removed in #724 W6; transcription moved to this seam), promoted here
// because it is the reason the design is acceptable at all:
// the gateway hands an owner's photographs and recordings to a process, and
// the only version of that which needs no trust argument is one where the
// bytes cannot leave the host. A hostname that is not loopback is not a
// misconfiguration to warn about; it is a config this module REFUSES to read,
// so there is no code path in which a photograph is POSTed to the internet.
// Credentials embedded in the URL are refused for the same reason a token
// belongs in a header: a URL ends up in logs.
//
// UNAVAILABLE IS A STATUS, NEVER AN EXCEPTION. Nothing here throws because a
// service is absent, asleep, out of date, or missing the capability asked for.
// Those are the ORDINARY states of a gateway whose owner has not switched
// enrichment on, and every caller — a background sweep, a search route — must
// be able to say "not available here" without rendering a failure. Only a
// caller bug (an empty or oversized batch) throws, because that is a bug.
//
// THE WIRE CONTRACT, in full. It is frozen; other modules are written against
// exactly these shapes.
//
//   GET /capabilities
//     -> 200 {"capabilities": {"<cap>": {"model": "<name>@<version>"}}}
//
//   POST /enrich/<cap>   {"items": [ … ]}
//     -> 200 {"model": "<name>@<version>", "results": [ … ]}
//     -> 404 {"error": "unavailable"}   (capability not advertised)
//
//   results are IN REQUEST ORDER, one per item, each either the capability's
//   success payload or {"id", "error"} — so one photograph the model cannot
//   read costs one result, never the batch.
//
//   embed-image  {id, mediaType, bytes(base64)}      -> {id, vector[]}
//   embed-text   {id, text}                          -> {id, vector[]}
//   ocr          {id, mediaType, bytes, originalWidth?, originalHeight?}
//                                                    -> {id, regions[{text, confidence, box}]}
//   faces        (same item shape as ocr)            -> {id, faces[{box, confidence, embedding[]}]}
//   transcript   {id, mediaType, bytes}              -> {id, text, confidence?}
//
//   Boxes are `[x, y, w, h]` integers with the origin at top-left, expressed
//   in the ORIGINAL image's pixels when the item declared its dimensions — the
//   service downscales for its model, and the caller must never have to know
//   by how much.
//
// MODEL IDENTITY IS LOAD-BEARING. Every advertised capability names its model
// as `"<name>@<version>"` (`@centraid/vault`'s `enrich/model-id.ts`). A
// capability whose model id does not parse is treated as UNAVAILABLE rather
// than accepted under a fabricated key: a derived row keyed "my model (final)"
// can never be found by an upgrade query, and a backfill that cannot find its
// own old rows is not a backfill.
//
// THE CAPS ARE THE CLIENT'S, NOT THE SERVICE'S. A local service is still a
// foreign program: it may hang, stream forever, or answer 40 results to a
// 3-item ask. The timeout, the response ceiling, the batch cap and the vector
// width are enforced HERE, on the reading side, because that is the side whose
// event loop and memory are at stake.

import { parseModelId } from "@centraid/vault";

import { asRecord, READERS } from "./result-readers.js";
import type { ResultReader } from "./result-readers.js";
import type {
  EnrichBatchOutcome,
  EnrichItem,
  EnrichItemOutcome,
} from "./wire-shapes.js";

/** One batch of previews plus their JSON. Generous; a ceiling, not a budget. */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/** Long enough for a cold model load on a Pi, short enough to never wedge a sweep. */
const BATCH_TIMEOUT_MS = 60_000;
/** A probe answers from memory or not at all. */
const PROBE_TIMEOUT_MS = 15_000;

/** Items per POST. Matches the sweep batch: one round trip, one pass. */
export const MAX_ENRICH_BATCH = 16;

/** Every capability the wire contract defines. */
export const ENRICH_CAPABILITIES = [
  "embed-image",
  "embed-text",
  "ocr",
  "faces",
  "transcript",
  "place-name",
] as const;
export type EnrichCapability = (typeof ENRICH_CAPABILITIES)[number];

/** Why nothing is available, in a sentence a surface can show an owner. */
export const ENRICH_UNCONFIGURED_REASON =
  "no enrichment service is configured on this gateway — set CENTRAID_ENRICH_URL to enable model-derived features";

export interface EnrichServiceConfig {
  /** Base URL; `/capabilities` and `/enrich/<cap>` hang off it. */
  endpoint: URL;
  /** Sent as `Authorization: Bearer`, never in the URL. */
  token?: string;
}

function loopback(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return (
    value === "localhost" ||
    value === "::1" ||
    /^127(?:\.\d{1,3}){3}$/u.test(value)
  );
}

/**
 * Read the explicitly configured, loopback-only enrichment service, or `null`
 * when this host has none. `null` is the shipped default and an ordinary
 * state — see the header on why a non-loopback URL yields `null` rather than
 * an error: there must be no code path that uploads an owner's bytes.
 */
export function readEnrichServiceConfig(
  env: NodeJS.ProcessEnv = process.env
): EnrichServiceConfig | null {
  const raw = env["CENTRAID_ENRICH_URL"]?.trim();
  if (!raw) return null;
  let endpoint: URL;
  try {
    // Translation at a parsing boundary: an operator's typo is "not
    // configured", which is a state, and not a crash at gateway start.
    endpoint = new URL(raw);
  } catch {
    return null;
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    !loopback(endpoint.hostname)
  )
    return null;
  if (endpoint.username || endpoint.password) return null;
  const token = env["CENTRAID_ENRICH_TOKEN"]?.trim();
  return { endpoint, ...(token ? { token } : {}) };
}

/** Per-call seams: tests inject a fetch and a timeout they can actually wait for. */
export interface EnrichCallOptions {
  fetchImpl?: typeof fetch;
  /** Overrides the client's own ceiling; only ever lowered in tests. */
  timeoutMs?: number;
}

/** What the service advertises. An absent key means "not available here". */
export type EnrichCapabilityMap = Partial<
  Record<EnrichCapability, { model: string }>
>;

export type EnrichCapabilitiesOutcome =
  | { status: "ok"; capabilities: EnrichCapabilityMap }
  | { status: "unavailable"; reason: string };

/** One capability's availability, resolved down to the model that would run. */
export type EnrichCapabilityStatus =
  | { status: "ok"; model: string }
  | { status: "unavailable"; reason: string };

function headers(config: EnrichServiceConfig, json: boolean): Headers {
  const value = new Headers({ accept: "application/json" });
  if (json) value.set("content-type", "application/json");
  if (config.token) value.set("authorization", `Bearer ${config.token}`);
  return value;
}

/**
 * Resolve one of the service's paths against the configured base. Written the
 * long way rather than as `new URL(path, base)` because relative resolution
 * DROPS the last segment of a base without a trailing slash, which would
 * silently strip an operator's `/enrich-svc` prefix.
 */
function endpointFor(config: EnrichServiceConfig, path: string): URL {
  const base = config.endpoint.href.endsWith("/")
    ? config.endpoint.href
    : `${config.endpoint.href}/`;
  return new URL(path, base);
}

/**
 * Read a response body under a hard ceiling. A local service that streams
 * forever must cost this process a bounded amount of memory and then stop —
 * `response.text()` would happily buffer the whole thing.
 */
async function readCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES)
    throw new Error(`response exceeds the ${MAX_RESPONSE_BYTES}-byte ceiling`);
  const body = response.body;
  if (!body) throw new Error("response carried no body");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Recursive rather than an awaiting loop: a stream has ONE cursor, so the
  // reads are sequential by nature and "collect the promises and Promise.all
  // them" is not an option here — the same reason `blob/preview.ts`'s backstop
  // recurses.
  async function pump(): Promise<void> {
    const next = await reader.read();
    if (next.done) return;
    total += next.value.length;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(
        `response exceeds the ${MAX_RESPONSE_BYTES}-byte ceiling`
      );
    }
    chunks.push(next.value);
    return pump();
  }
  await pump();
  return Buffer.concat(chunks).toString("utf8");
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Ask the service what it can do. `unavailable` covers every way the answer
 * can fail to arrive — unreachable, slow, unauthorized, malformed — because to
 * a caller they are the same fact: nothing can be derived right now.
 */
export async function getEnrichCapabilities(
  config: EnrichServiceConfig | null,
  options: EnrichCallOptions = {}
): Promise<EnrichCapabilitiesOutcome> {
  if (!config)
    return { status: "unavailable", reason: ENRICH_UNCONFIGURED_REASON };
  const call = options.fetchImpl ?? fetch;
  try {
    const response = await call(endpointFor(config, "capabilities"), {
      method: "GET",
      headers: headers(config, false),
      signal: AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        `the enrichment service answered HTTP ${response.status}`
      );
    }
    const body = asRecord(JSON.parse(await readCapped(response)));
    const advertised = asRecord(body["capabilities"]);
    const capabilities: EnrichCapabilityMap = {};
    for (const capability of ENRICH_CAPABILITIES) {
      const entry = advertised[capability];
      if (typeof entry !== "object" || entry === null) continue;
      const model = (entry as { model?: unknown }).model;
      // An unparseable model id is not a capability with a funny name — it is
      // a capability whose rows could never be re-derived, so it is off.
      if (typeof model !== "string" || !parseModelId(model)) continue;
      capabilities[capability] = { model };
    }
    return { status: "ok", capabilities };
  } catch (error) {
    // The process boundary: a foreign program's every failure mode becomes one
    // sentence an owner could be shown, and no exception crosses this line.
    return {
      status: "unavailable",
      reason: `the enrichment service is not answering: ${reason(error)}`,
    };
  }
}

/**
 * Resolve ONE capability to the model that would run it. This is the shape a
 * surface wants — `semantic-search.ts` renders exactly this `unavailable`
 * reason — and the shape a sweep wants before it reads a single blob.
 */
export async function probeEnrichService(
  config: EnrichServiceConfig | null,
  capability: EnrichCapability,
  options: EnrichCallOptions = {}
): Promise<EnrichCapabilityStatus> {
  const outcome = await getEnrichCapabilities(config, options);
  if (outcome.status === "unavailable") return outcome;
  const advertised = outcome.capabilities[capability];
  if (!advertised) {
    return {
      status: "unavailable",
      reason: `the enrichment service does not offer ${capability}`,
    };
  }
  return { status: "ok", model: advertised.model };
}

/**
 * Derive one batch. Never throws for anything the SERVICE did — a refusal, a
 * hang, a garbled payload and a capability that is not offered all come back
 * as `unavailable` or as a per-item `error`, because a background sweep and a
 * search box both have to keep working when the model does not.
 *
 * It DOES throw for a caller bug: an empty batch, or one over the cap this
 * client enforces on itself. Those are this repo's mistakes, not the
 * operator's, and hiding them behind `unavailable` would make a sweep that
 * silently derives nothing look exactly like a gateway with no service.
 */
export async function enrichBatch<C extends EnrichCapability>(
  config: EnrichServiceConfig | null,
  capability: C,
  items: readonly EnrichItem<C>[],
  options: EnrichCallOptions = {}
): Promise<EnrichBatchOutcome<C>> {
  if (items.length === 0)
    throw new Error("enrichBatch needs at least one item");
  if (items.length > MAX_ENRICH_BATCH) {
    throw new Error(
      `enrichBatch accepts at most ${MAX_ENRICH_BATCH} items, got ${items.length}`
    );
  }
  if (!config)
    return { status: "unavailable", reason: ENRICH_UNCONFIGURED_REASON };
  const call = options.fetchImpl ?? fetch;
  let model: string;
  let raw: unknown[];
  try {
    const response = await call(endpointFor(config, `enrich/${capability}`), {
      method: "POST",
      headers: headers(config, true),
      body: JSON.stringify({ items }),
      signal: AbortSignal.timeout(options.timeoutMs ?? BATCH_TIMEOUT_MS),
    });
    // The contract's one expected refusal: this service does not do that.
    if (response.status === 404) {
      return {
        status: "unavailable",
        reason: `the enrichment service does not offer ${capability}`,
      };
    }
    if (!response.ok) {
      throw new Error(
        `the enrichment service answered HTTP ${response.status}`
      );
    }
    const body = asRecord(JSON.parse(await readCapped(response)));
    const declaredModel = body["model"];
    if (typeof declaredModel !== "string" || !parseModelId(declaredModel)) {
      throw new Error(
        `the enrichment service named its model ${JSON.stringify(declaredModel)}, which is not "<name>@<version>"`
      );
    }
    const results = body["results"];
    if (!Array.isArray(results) || results.length !== items.length) {
      throw new Error(
        `expected ${items.length} results in request order, got ${Array.isArray(results) ? results.length : "none"}`
      );
    }
    model = declaredModel;
    raw = results;
  } catch (error) {
    return {
      status: "unavailable",
      reason: `the enrichment service is not answering: ${reason(error)}`,
    };
  }
  // Position, not `id`, is what pairs a result with its item — the contract
  // says request order, and trusting a foreign program's echoed id would let a
  // buggy service write one photograph's vector onto another's row.
  const read = READERS[capability] as ResultReader<C>;
  const results = items.map((item, index): EnrichItemOutcome<C> => {
    const id = item.id;
    try {
      const entry = asRecord(raw[index]);
      const failure = entry["error"];
      if (failure !== undefined) {
        return { id, error: typeof failure === "string" ? failure : "failed" };
      }
      return read(entry, item, id);
    } catch (error) {
      // Per-item isolation, which is the whole reason results are a list: one
      // unreadable payload costs its own row and nothing else in the batch.
      return { id, error: reason(error) };
    }
  });
  return { status: "ok", model, results };
}
