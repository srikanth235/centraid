import type { CursorReadResult } from "@centraid/server/automation";
import type {
  AutomationTriggerStore,
  PruneIngressResult,
} from "@centraid/server/engine";

export function ingressRetentionGap(
  prune: PruneIngressResult,
  sourceKey: string,
  deliveredThrough: number
): { skipped: number; gapReason: string } | undefined {
  const lost = prune.gaps.find((gap) => gap.sourceKey === sourceKey);
  if (!lost || lost.throughId <= deliveredThrough) return undefined;
  return { skipped: lost.pruned, gapReason: "ingress_retention" };
}

function parseIngressPosition(positionJson: string | undefined): number {
  if (!positionJson) return 0;
  try {
    const value = Number(JSON.parse(positionJson));
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function parseIngressPayload(payloadJson: string | undefined): unknown {
  if (payloadJson === undefined) return undefined;
  try {
    return JSON.parse(payloadJson) as unknown;
  } catch {
    return payloadJson;
  }
}

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

export function readIngressCursor(
  store: Pick<AutomationTriggerStore, "listIngressAfter" | "pruneIngress">,
  sourceKey: string,
  positionJson: string | undefined,
  limit: number,
  now: number
): CursorReadResult {
  const afterId = parseIngressPosition(positionJson);
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
