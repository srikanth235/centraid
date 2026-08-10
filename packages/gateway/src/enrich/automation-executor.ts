/**
 * Host-owned implementation of the recognition templates' reserved
 * `ctx.fetch` target. The automation engine still owns scheduling, policy,
 * ledgering and content consent; this adapter only translates already
 * consent-checked attachments onto the frozen enrichment-service wire.
 */

import type { DeterministicFetch } from "@centraid/automation";

import {
  enrichBatch,
  ENRICH_CAPABILITIES,
  probeEnrichService,
} from "./service-client.js";
import type {
  EnrichCapability,
  EnrichImageItem,
  EnrichRegionItem,
  EnrichServiceConfig,
  EnrichTextItem,
} from "./service-client.js";

interface ItemMeta {
  id?: unknown;
  bytes?: unknown;
  mediaType?: unknown;
  text?: unknown;
  originalWidth?: unknown;
  originalHeight?: unknown;
}

function capabilityOf(url: string): EnrichCapability {
  const value = url.slice("centraid://enrichment/".length);
  if (!ENRICH_CAPABILITIES.includes(value as EnrichCapability)) {
    throw new Error(`unknown deterministic enrichment capability "${value}"`);
  }
  return value as EnrichCapability;
}

function metadata(body: string | undefined): ItemMeta[] {
  if (!body) return [];
  const parsed = JSON.parse(body) as { items?: unknown };
  if (!Array.isArray(parsed.items)) return [];
  return parsed.items.map((item) =>
    item && typeof item === "object" ? (item as ItemMeta) : {}
  );
}

function idAt(items: readonly ItemMeta[], index: number): string {
  const id = items[index]?.id;
  return typeof id === "string" && id.length > 0 ? id : `item-${index}`;
}

function inlineImageAt(
  items: readonly ItemMeta[],
  index: number
): EnrichImageItem {
  const item = items[index];
  if (
    typeof item?.bytes !== "string" ||
    typeof item.mediaType !== "string" ||
    item.mediaType.length === 0
  ) {
    throw new Error(`enrichment item[${index}] has no binary content`);
  }
  return {
    id: idAt(items, index),
    mediaType: item.mediaType,
    bytes: item.bytes,
  };
}

/** Build one gateway-local deterministic fetch executor. */
export function makeAutomationEnrichmentExecutor(
  config: EnrichServiceConfig | null
): DeterministicFetch {
  return async (call) => {
    const capability = capabilityOf(call.url);
    if (call.method === "GET") {
      const outcome = await probeEnrichService(config, capability);
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        text: JSON.stringify(outcome),
      };
    }
    if (call.method !== "POST") {
      throw new Error("deterministic enrichment fetches must use GET or POST");
    }
    const meta = metadata(call.body);
    const count = Math.max(call.attachments.length, meta.length);
    const imageItems: EnrichImageItem[] = Array.from(
      { length: count },
      (_, index) => {
        const attachment = call.attachments[index];
        if (!attachment) return inlineImageAt(meta, index);
        if (!attachment.base64) {
          throw new Error(`${capability} content[${index}] is not binary`);
        }
        return {
          id: idAt(meta, index),
          mediaType: attachment.mediaType,
          bytes: attachment.base64,
        };
      }
    );
    let outcome: unknown;
    if (capability === "embed-text") {
      const textItems: EnrichTextItem[] = Array.from(
        { length: count },
        (_, index) => {
          const text = call.attachments[index]?.text ?? meta[index]?.text;
          if (typeof text !== "string") {
            throw new Error(`embed-text content[${index}] is not text`);
          }
          return { id: idAt(meta, index), text };
        }
      );
      outcome = await enrichBatch(config, capability, textItems);
    } else if (capability === "ocr" || capability === "faces") {
      const regionItems: EnrichRegionItem[] = imageItems.map((item, index) => {
        const width = meta[index]?.originalWidth;
        const height = meta[index]?.originalHeight;
        return {
          ...item,
          ...(typeof width === "number" ? { originalWidth: width } : {}),
          ...(typeof height === "number" ? { originalHeight: height } : {}),
        };
      });
      outcome = await enrichBatch(config, capability, regionItems);
    } else if (capability === "embed-image") {
      outcome = await enrichBatch(config, capability, imageItems);
    } else {
      outcome = await enrichBatch(config, "transcript", imageItems);
    }
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      text: JSON.stringify(outcome),
    };
  };
}
