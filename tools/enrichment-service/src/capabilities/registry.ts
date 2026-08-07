import type { ServiceConfig } from "../config.js";
import type {
  EmbedImageItem,
  EmbedTextItem,
  FacesItem,
  ItemResult,
  ModelId,
  OcrItem,
  TranscriptItem,
} from "../types.js";
import {
  EMBED_MODEL_ID,
  embedImage,
  embedText,
  embedWeightsPresent,
} from "./embed.js";
import { FACES_MODEL_ID, faces, facesWeightsPresent } from "./faces.js";
import { OCR_MODEL_ID, ocr, ocrWeightsPresent } from "./ocr.js";
import {
  probeTranscriptEndpoint,
  TRANSCRIPT_MODEL_ID,
  transcript,
} from "./transcript.js";

// Central capability registry: the single place that knows what
// /capabilities advertises and how /enrich/<cap> dispatches. Partial
// availability is a feature (issue #724 W8) — each capability's
// `isAvailable` check is independent, so missing weights for one
// capability (e.g. faces/) never take down embed-image/embed-text/ocr.
// "Honest absence": a capability whose weights are missing is simply not
// advertised, never a fake result (see AGENTS.md / docs/coding-standards.md).

export interface CapabilityDefinition {
  name: string;
  modelId: () => ModelId;
  isAvailable: (config: ServiceConfig) => Promise<boolean>;
  handle: (
    items: readonly unknown[],
    config: ServiceConfig
  ) => Promise<Array<ItemResult<unknown>>>;
}

function isEmbedImageItem(value: unknown): value is EmbedImageItem {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { mediaType?: unknown }).mediaType === "string" &&
    typeof (value as { bytes?: unknown }).bytes === "string"
  );
}

function isEmbedTextItem(value: unknown): value is EmbedTextItem {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

const embedImageCapability: CapabilityDefinition = {
  name: "embed-image",
  modelId: () => EMBED_MODEL_ID,
  isAvailable: () => Promise.resolve(embedWeightsPresent()),
  handle: async (items) =>
    Promise.all(
      items.map((item) =>
        isEmbedImageItem(item)
          ? embedImage(item)
          : Promise.resolve({
              id: String((item as { id?: unknown })?.id ?? ""),
              error: "malformed embed-image item",
            })
      )
    ),
};

const embedTextCapability: CapabilityDefinition = {
  name: "embed-text",
  modelId: () => EMBED_MODEL_ID,
  isAvailable: () => Promise.resolve(embedWeightsPresent()),
  handle: async (items) =>
    Promise.all(
      items.map((item) =>
        isEmbedTextItem(item)
          ? embedText(item)
          : Promise.resolve({
              id: String((item as { id?: unknown })?.id ?? ""),
              error: "malformed embed-text item",
            })
      )
    ),
};

function isMediaItem(value: unknown): value is OcrItem {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { mediaType?: unknown }).mediaType === "string" &&
    typeof (value as { bytes?: unknown }).bytes === "string"
  );
}

const ocrCapability: CapabilityDefinition = {
  name: "ocr",
  modelId: () => OCR_MODEL_ID,
  isAvailable: () => Promise.resolve(ocrWeightsPresent()),
  handle: async (items) =>
    Promise.all(
      items.map((item) =>
        isMediaItem(item)
          ? ocr(item)
          : Promise.resolve({
              id: String((item as { id?: unknown })?.id ?? ""),
              error: "malformed ocr item",
            })
      )
    ),
};

const facesCapability: CapabilityDefinition = {
  name: "faces",
  modelId: () => FACES_MODEL_ID,
  isAvailable: () => Promise.resolve(facesWeightsPresent()),
  handle: async (items) =>
    Promise.all(
      items.map((item) =>
        isMediaItem(item)
          ? faces(item as FacesItem)
          : Promise.resolve({
              id: String((item as { id?: unknown })?.id ?? ""),
              error: "malformed faces item",
            })
      )
    ),
};

const transcriptCapability: CapabilityDefinition = {
  name: "transcript",
  modelId: () => TRANSCRIPT_MODEL_ID,
  isAvailable: async (config) => {
    if (!config.transcriptUrl) {
      return false;
    }
    return probeTranscriptEndpoint(config.transcriptUrl);
  },
  handle: async (items, config) => {
    if (!config.transcriptUrl) {
      throw new Error(
        "transcript capability invoked without ENRICH_SERVICE_TRANSCRIPT_URL set"
      );
    }
    const url = config.transcriptUrl;
    return Promise.all(
      items.map((item) =>
        isMediaItem(item)
          ? transcript(item as TranscriptItem, url)
          : Promise.resolve({
              id: String((item as { id?: unknown })?.id ?? ""),
              error: "malformed transcript item",
            })
      )
    );
  },
};

export const CAPABILITIES: readonly CapabilityDefinition[] = [
  embedImageCapability,
  embedTextCapability,
  ocrCapability,
  facesCapability,
  transcriptCapability,
];

export function findCapability(name: string): CapabilityDefinition | undefined {
  return CAPABILITIES.find((cap) => cap.name === name);
}
