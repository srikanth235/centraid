export type ModelId = `${string}@${string}`;

export interface ItemError {
  id: string;
  error: string;
}

export type ItemResult<T> = (T & { id: string }) | ItemError;

export interface EmbedImageItem {
  id: string;
  mediaType: string;
  bytes: string;
}

export interface EmbedTextItem {
  id: string;
  text: string;
}

export interface EmbedResult {
  vector: number[];
}

export interface OcrItem {
  id: string;
  mediaType: string;
  bytes: string;
  originalWidth?: number;
  originalHeight?: number;
}

export type Box = readonly [number, number, number, number];

export interface OcrRegion {
  text: string;
  confidence: number;
  box: Box;
}

export interface OcrResult {
  regions: OcrRegion[];
}

export type FacesItem = OcrItem;

export interface FaceDetection {
  box: Box;
  confidence: number;
  embedding: number[];
}

export interface FacesResult {
  faces: FaceDetection[];
}

export interface TranscriptItem {
  id: string;
  mediaType: string;
  bytes: string;
}

export interface TranscriptResult {
  text: string;
}
