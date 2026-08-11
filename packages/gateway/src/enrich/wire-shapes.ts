// The enrichment wire SHAPES — every item and result the contract defines,
// and nothing that talks to a socket.
//
// Split out of `service-client.ts` (#739) when a sixth capability pushed that
// file past the repo's size limit. The seam is the honest one rather than a
// line-count convenience: this module is the frozen contract, and it is what a
// consumer imports when it needs to name a shape without wanting a client.
// `service-client.ts` owns configuration, transport and the caps it enforces
// on a foreign program; `result-readers.ts` owns turning a JSON blob into one
// of these. Types here import nothing else, which is what keeps that ordering
// acyclic.
//
// The contract itself — endpoints, ordering, box space, model identity — is
// documented in full at the head of `service-client.ts`.

import type { EnrichCapability } from "./service-client.js";

export interface EnrichImageItem {
  id: string;
  mediaType: string;
  /** Base64 of the DERIVATIVE bytes — never an owner's original (see the sweep). */
  bytes: string;
}

export interface EnrichRegionItem extends EnrichImageItem {
  /** Declared so returned boxes come back in the original's pixel space. */
  originalWidth?: number;
  originalHeight?: number;
}

export interface EnrichTextItem {
  id: string;
  text: string;
}

export interface EnrichVectorResult {
  id: string;
  vector: number[];
}

/** `[x, y, w, h]`, integers, origin top-left. */
export type EnrichBox = [number, number, number, number];

export interface EnrichOcrRegion {
  text: string;
  /** 0..1. A service that cannot score its own output must say so per region. */
  confidence: number;
  box: EnrichBox;
}

export interface EnrichOcrResult {
  id: string;
  regions: EnrichOcrRegion[];
}

/**
 * Sort a COPY of a service's OCR regions into reading order — top-to-bottom
 * by `box[1]` (y), then left-to-right by `box[0]` (x) — and join their text
 * with newlines. Never mutates `regions`. Shared by every consumer of the
 * `ocr` capability (the background sweep, `enrich/ocr-sweep.ts`, and the
 * capture route's live single-shot ask, `capture/capture-ocr.ts`) so reading
 * order is one rule, not two copies that can drift.
 */
export function ocrReadingOrderText(
  regions: readonly EnrichOcrRegion[]
): string {
  return [...regions]
    .sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0])
    .map((region) => region.text)
    .join("\n");
}

export interface EnrichFace {
  box: EnrichBox;
  confidence: number;
  embedding: number[];
}

export interface EnrichFacesResult {
  id: string;
  faces: EnrichFace[];
}

export interface EnrichTranscriptResult {
  id: string;
  text: string;
  confidence?: number;
}

/**
 * A COORDINATE, not bytes — the one capability whose item carries no part of
 * a member's file.
 *
 * Reverse geocoding is the odd one out in this contract and it is worth
 * saying why it belongs here anyway. Every other capability hands a model
 * some of the owner's content; this one hands it two numbers the vault
 * already computed and asks what that spot is called. It rides the same seam
 * because it needs the same three things the others need — an offline index
 * too heavy for a client, a versioned model id so a better index can supersede
 * an older one's answers, and a consent tier that governs whether it runs at
 * all — and because the alternative was a sixth mechanism with its own config
 * and its own failure vocabulary, which is exactly what issue #724 deleted.
 */
export interface EnrichPlaceItem {
  id: string;
  lat: number;
  lng: number;
}

export interface EnrichPlaceNameResult {
  id: string;
  /**
   * What to call this spot, or `null` for HONEST EMPTY — an index with no
   * settlement near an ocean coordinate must be able to say "nothing", and a
   * nearest-populated-place answer 400km away would be worse than the
   * coordinate string it replaced.
   */
  name: string | null;
  /** A larger containing place, when the index knows one: "California",
   *  "Devon". Surfaces may show it beside the name; nothing depends on it. */
  region?: string | null;
  /** 0..1. How sure the index is that this name belongs to this coordinate —
   *  distance-derived, in practice. */
  confidence?: number;
}
/** One item the service could not derive. Counted by callers, never fatal. */
export interface EnrichItemFailure {
  id: string;
  error: string;
}

/** The item/result pairing per capability — the table the generics read. */
interface EnrichShapes {
  "embed-image": { item: EnrichImageItem; result: EnrichVectorResult };
  "embed-text": { item: EnrichTextItem; result: EnrichVectorResult };
  ocr: { item: EnrichRegionItem; result: EnrichOcrResult };
  faces: { item: EnrichRegionItem; result: EnrichFacesResult };
  transcript: { item: EnrichImageItem; result: EnrichTranscriptResult };
  "place-name": { item: EnrichPlaceItem; result: EnrichPlaceNameResult };
}

export type EnrichItem<C extends EnrichCapability> = EnrichShapes[C]["item"];
export type EnrichResult<C extends EnrichCapability> =
  EnrichShapes[C]["result"];
/** One slot of a batch answer: the payload, or this item's own failure. */
export type EnrichItemOutcome<C extends EnrichCapability> =
  | EnrichResult<C>
  | EnrichItemFailure;

export type EnrichBatchOutcome<C extends EnrichCapability> =
  | { status: "ok"; model: string; results: EnrichItemOutcome<C>[] }
  | { status: "unavailable"; reason: string };

/** Narrow an outcome slot without re-reading its shape at every call site. */
export function isEnrichFailure(
  outcome: EnrichItemOutcome<EnrichCapability>
): outcome is EnrichItemFailure {
  return "error" in outcome;
}
