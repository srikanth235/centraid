/*
 * Durable-ingress cursor reads (#541 review).
 *
 * `trigger_ingress` is the durable landing zone for webhook deliveries and
 * polled provider events. The one invariant this module exists to hold:
 *
 *   A cursor may only advance to the position of an element that was actually
 *   delivered. Never report a target position beyond the last element
 *   returned.
 *
 * Rows past the per-read catch-up cap are still durably present, so they are
 * SURPLUS, not a gap: the next tick delivers them. Only genuinely
 * unrecoverable losses — a missed cron window, an expired Gmail history, a
 * pruned ingress row — are reported as `skipped`/`gapReason`, because the
 * source can no longer produce them at all.
 *
 * Kept out of `build-gateway.ts` so the invariant is unit-testable without
 * booting a gateway.
 */

import type { CursorReadResult } from "@centraid/server/automation";
import type {
  AutomationTriggerStore,
  PruneIngressResult,
} from "@centraid/server/engine";

/**
 * What the retention TTL cost *this* source, as the reader that owns it sees.
 *
 * `pruneIngress` deletes every row past its TTL and reports the loss per source
 * key. A row at or below the reader's own delivered position was already fired,
 * so dropping it costs nothing. A row ABOVE it was never delivered — that is a
 * real, unrecoverable gap (the landing zone no longer holds it), so it is
 * reported as `skipped` with an `ingress_retention` reason rather than
 * disappearing between two ticks.
 */
export function ingressRetentionGap(
  prune: PruneIngressResult,
  sourceKey: string,
  deliveredThrough: number
): { skipped: number; gapReason: string } | undefined {
  const lost = prune.gaps.find((gap) => gap.sourceKey === sourceKey);
  if (!lost || lost.throughId <= deliveredThrough) return undefined;
  return { skipped: lost.pruned, gapReason: "ingress_retention" };
}

/** A `positionJson` for an ingress source is just the last delivered row id. */
function parseIngressPosition(positionJson: string | undefined): number {
  if (!positionJson) return 0;
  try {
    const value = Number(JSON.parse(positionJson));
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

/** Stored payloads are JSON; a non-JSON body rides through as its raw text. */
function parseIngressPayload(payloadJson: string | undefined): unknown {
  if (payloadJson === undefined) return undefined;
  try {
    return JSON.parse(payloadJson) as unknown;
  } catch {
    return payloadJson;
  }
}

/** One ingress row, shaped as a cursor element. */
export function ingressElement(record: {
  id: number;
  receivedAt: number;
  payloadJson?: string;
  payloadRef?: string;
}): { position: string; occurredAt: number; payload: unknown } {
  return {
    position: String(record.id),
    occurredAt: record.receivedAt,
    payload:
      record.payloadJson === undefined
        ? { payloadRef: record.payloadRef }
        : parseIngressPayload(record.payloadJson),
  };
}

/**
 * Read at most `limit` undelivered ingress rows for one source, advancing the
 * cursor only as far as the last row returned.
 */
export function readIngressCursor(
  store: Pick<AutomationTriggerStore, "listIngressAfter" | "pruneIngress">,
  sourceKey: string,
  positionJson: string | undefined,
  limit: number,
  now: number
): CursorReadResult {
  const afterId = parseIngressPosition(positionJson);
  // Prune here, where the reader's own delivered position is known, so a row
  // that expired before it was ever delivered is accounted instead of silently
  // dropped.
  const retention = ingressRetentionGap(
    store.pruneIngress(now),
    sourceKey,
    afterId
  );
  const records = store.listIngressAfter(sourceKey, afterId, limit);
  const deliveredId = records.at(-1)?.id ?? afterId;
  return {
    elements: records.map(ingressElement),
    positionJson: JSON.stringify(deliveredId),
    ...retention,
  };
}
