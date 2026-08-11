// The frozen wire contract (issue #724 W8). The gateway's client is built
// against exactly these shapes — do not change field names or optionality
// without updating the gateway side in the same PR. See docs/protocol.md
// for the repo's general two-contract stance; this service is a satellite
// process, not part of the gateway's own RPC plane, so it is documented here
// rather than in packages/protocol.

/** Every model id parses as "<name>@<version>", e.g. "clip-vit-b-32@1". */
export type ModelId = `${string}@${string}`;

export interface CapabilityInfo {
  model: ModelId;
}

export interface CapabilitiesResponse {
  capabilities: Record<string, CapabilityInfo>;
}

/** Per-item failure shape used across every /enrich/<cap> response. */
export interface ItemError {
  id: string;
  error: string;
}

export type ItemResult<T> = (T & { id: string }) | ItemError;

export interface EnrichResponse<T> {
  model: ModelId;
  results: Array<ItemResult<T>>;
}

// --- embed-image / embed-text -----------------------------------------

export interface EmbedImageItem {
  id: string;
  mediaType: string;
  /** Base64-encoded image bytes. */
  bytes: string;
}

export interface EmbedTextItem {
  id: string;
  text: string;
}

export interface EmbedResult {
  vector: number[];
}

// --- ocr -----------------------------------------------------------------

export interface OcrItem {
  id: string;
  mediaType: string;
  bytes: string;
  originalWidth?: number;
  originalHeight?: number;
}

/** [x, y, w, h] in integer pixels, origin top-left. */
export type Box = readonly [number, number, number, number];

export interface OcrRegion {
  text: string;
  /** 0..1 */
  confidence: number;
  box: Box;
}

export interface OcrResult {
  regions: OcrRegion[];
}

// --- faces -----------------------------------------------------------------

export type FacesItem = OcrItem;

export interface FaceDetection {
  box: Box;
  confidence: number;
  embedding: number[];
}

export interface FacesResult {
  faces: FaceDetection[];
}

// --- transcript --------------------------------------------------------

export interface TranscriptItem {
  id: string;
  mediaType: string;
  bytes: string;
}

export interface TranscriptResult {
  text: string;
  confidence?: number;
}

// --- place-name --------------------------------------------------------

/** The one item in this contract that carries no bytes: a coordinate the
 *  vault already computed, and nothing of the member's file. */
export interface PlaceItem {
  id: string;
  lat: number;
  lng: number;
}

export interface PlaceNameResult {
  /** `null` is a real answer: no settlement reaches this coordinate. */
  name: string | null;
  region?: string | null;
  confidence?: number;
}

/** The `POST /enrich/<cap>` request body — validated at the route boundary in src/server.ts. */
export interface EnrichItemsRequest {
  items?: unknown;
}
