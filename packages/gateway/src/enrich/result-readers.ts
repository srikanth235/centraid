// Turning a service's JSON into a result this repo will store — one reader per
// capability, and every cap the client enforces on a foreign program's numbers.
//
// Split out of `service-client.ts` (#739). The client owns the socket and the
// bytes; this module owns the distrust. A local enrichment service is still a
// foreign program: it may answer a vector of four million dimensions, a
// confidence of 7, or a face box that runs off the edge of the photograph it
// claims to describe. Validating here rather than at each call site is what
// makes "a derived row is a row this repo vouches for" true in one place.
//
// A reader THROWS on a payload it cannot trust. `enrichBatch` catches per item
// and turns it into that item's own `{id, error}`, so one unreadable
// photograph costs one result and never the batch.

import type { EnrichCapability } from "./service-client.js";
import type {
  EnrichBox,
  EnrichItem,
  EnrichRegionItem,
  EnrichResult,
} from "./wire-shapes.js";

/** Mirrors `enrich.upsert_embedding`'s ceiling — ~16 KiB of float32 per row. */
const MAX_VECTOR_DIM = 4096;
/** The same cap desktop's deleted on-device ASR adapter applied: a transcript, not a corpus. */
const MAX_TRANSCRIPT_CHARS = 1_000_000;

/**
 * A place name is a LABEL — it sits in a section head and on a pin. Anything
 * longer than this is not a name the index knows, it is a payload, and it
 * would blow out the one row it lands in. Truncation rather than refusal, the
 * same trade the transcript reader makes.
 */
const MAX_PLACE_NAME_CHARS = 120;

/** A JSON value the reader is about to index into, without trusting it. */
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function finiteVector(raw: unknown, label: string): number[] {
  if (!Array.isArray(raw)) throw new Error(`${label} is not an array`);
  if (raw.length === 0 || raw.length > MAX_VECTOR_DIM) {
    throw new Error(
      `${label} has ${raw.length} dimensions; the ledger accepts 1..${MAX_VECTOR_DIM}`
    );
  }
  return raw.map((value) => {
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error(`${label} contains a non-finite value`);
    return value;
  });
}

function confidenceOf(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1)
    throw new Error("confidence must be a number in 0..1");
  return raw;
}

/**
 * Validate one box against the item's declared dimensions. A box outside the
 * photograph it claims to describe is worse than no box: a surface would draw
 * a face marker over empty canvas and the owner would be told the model saw
 * something it did not.
 */
function boxOf(raw: unknown, item: EnrichRegionItem): EnrichBox {
  if (!Array.isArray(raw) || raw.length !== 4)
    throw new Error("box must be [x, y, w, h]");
  const values = raw.map((value) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw new Error("box values must be non-negative integers");
    return value;
  }) as EnrichBox;
  const [x, y, width, height] = values;
  if (width === 0 || height === 0) throw new Error("box has no area");
  if (item.originalWidth !== undefined && x + width > item.originalWidth)
    throw new Error("box runs past the declared width");
  if (item.originalHeight !== undefined && y + height > item.originalHeight)
    throw new Error("box runs past the declared height");
  return values;
}

export type ResultReader<C extends EnrichCapability> = (
  raw: Record<string, unknown>,
  item: EnrichItem<C>,
  id: string
) => EnrichResult<C>;

/**
 * One reader per capability rather than a switch at the parse site: the wire
 * contract has five payload shapes and this table is where all five live, so
 * adding a sixth is one entry and one type, not an edit in three branches.
 */
export const READERS: { [C in EnrichCapability]: ResultReader<C> } = {
  "embed-image": (raw, _item, id) => ({
    id,
    vector: finiteVector(raw["vector"], "vector"),
  }),
  "embed-text": (raw, _item, id) => ({
    id,
    vector: finiteVector(raw["vector"], "vector"),
  }),
  ocr: (raw, item, id) => {
    const regions = raw["regions"];
    if (!Array.isArray(regions)) throw new Error("regions is not an array");
    return {
      id,
      regions: regions.map((region) => {
        const entry = asRecord(region);
        const text = entry["text"];
        if (typeof text !== "string")
          throw new Error("region text is not a string");
        return {
          text,
          confidence: confidenceOf(entry["confidence"]),
          box: boxOf(entry["box"], item),
        };
      }),
    };
  },
  faces: (raw, item, id) => {
    const faces = raw["faces"];
    if (!Array.isArray(faces)) throw new Error("faces is not an array");
    return {
      id,
      faces: faces.map((face) => {
        const entry = asRecord(face);
        return {
          box: boxOf(entry["box"], item),
          confidence: confidenceOf(entry["confidence"]),
          embedding: finiteVector(entry["embedding"], "face embedding"),
        };
      }),
    };
  },
  transcript: (raw, _item, id) => {
    const text = raw["text"];
    if (typeof text !== "string")
      throw new Error("transcript text is not a string");
    const confidence = raw["confidence"];
    return {
      id,
      // Truncation rather than refusal, the same trade desktop's deleted
      // on-device ASR adapter made: an hour of speech is still a usable
      // transcript at a million characters, and an owner gets the
      // recording's words either way.
      text: text.slice(0, MAX_TRANSCRIPT_CHARS),
      ...(confidence === undefined
        ? {}
        : { confidence: confidenceOf(confidence) }),
    };
  },
  "place-name": (raw, _item, id) => {
    const name = raw["name"];
    // `null` is a real answer — "there is no settlement near this coordinate"
    // — and it has to survive as itself. Coercing it to "" would land an
    // empty name in a section head; treating it as a parse failure would make
    // the sweep retry the middle of an ocean forever.
    if (name !== null && typeof name !== "string")
      throw new Error("place name is not a string or null");
    const region = raw["region"];
    if (region !== undefined && region !== null && typeof region !== "string")
      throw new Error("place region is not a string or null");
    const confidence = raw["confidence"];
    const trimmed = name === null ? null : name.trim();
    return {
      id,
      name:
        trimmed === null || trimmed === ""
          ? null
          : trimmed.slice(0, MAX_PLACE_NAME_CHARS),
      ...(region === undefined
        ? {}
        : {
            region:
              region === null
                ? null
                : region.trim().slice(0, MAX_PLACE_NAME_CHARS) || null,
          }),
      ...(confidence === undefined
        ? {}
        : { confidence: confidenceOf(confidence) }),
    };
  },
};
