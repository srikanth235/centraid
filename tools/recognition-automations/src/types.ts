// Shared internal value shapes used by the inference implementations bundled
// directly into release-managed automation handlers. These are function
// contracts, not an HTTP or process boundary.

/** Every model id parses as "<name>@<version>", e.g. "clip-vit-b-32@1". */
export type ModelId = `${string}@${string}`;

/** Per-item failure shape returned by each bundled model implementation. */
export interface ItemError {
  id: string;
  error: string;
}

export type ItemResult<T> = (T & { id: string }) | ItemError;

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

// --- transcript ------------------------------------------------------------

export interface TranscriptItem {
  id: string;
  mediaType: string;
  /** Base64-encoded audio or video container bytes. */
  bytes: string;
}

export interface TranscriptResult {
  text: string;
}
