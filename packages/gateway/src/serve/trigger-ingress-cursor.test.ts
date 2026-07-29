/*
 * The cursor-advance invariant (issue #541 review). The regression this
 * guards: reporting the source's LATEST durable id after returning only a
 * capped prefix, which counted the surplus as `skipped` and dropped every
 * webhook delivery past the 51st in one window — even though those rows were
 * still sitting in `trigger_ingress`.
 */

import type {
  AutomationTriggerStore,
  PruneIngressResult,
  TriggerIngressRecord,
} from "@centraid/app-engine";
import { describe, expect, test } from "vitest";

import {
  ingressRetentionGap,
  readIngressCursor,
} from "./trigger-ingress-cursor.js";

const NOW = 5_000;

type Row = Pick<
  TriggerIngressRecord,
  "id" | "receivedAt" | "payloadJson" | "payloadRef"
>;

function record(row: Row): TriggerIngressRecord {
  return {
    source: "webhook",
    sourceKey: "hook-1",
    deliveryId: `d-${row.id}`,
    expiresAt: 0,
    ...row,
  };
}

type IngressStore = Pick<
  AutomationTriggerStore,
  "listIngressAfter" | "pruneIngress"
>;

/** Minimal `listIngressAfter` / `pruneIngress` over an in-memory ingress table. */
function storeOf(
  rowsLocal: readonly Row[],
  prune?: PruneIngressResult
): IngressStore {
  return {
    listIngressAfter: (_sourceKey: string, afterId: number, limit: number) =>
      rowsLocal
        .filter((row) => row.id > afterId)
        .slice(0, limit)
        .map(record),
    pruneIngress: () => prune ?? { deleted: 0, gaps: [] },
  };
}

function rows(count: number, from = 1): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    id: from + index,
    receivedAt: 1_000 + from + index,
    payloadJson: JSON.stringify({ n: from + index }),
  }));
}

describe("trigger-ingress-cursor", () => {
  test("the cursor advances only to the last row actually returned", () => {
    const result = readIngressCursor(
      storeOf(rows(60)),
      "hook-1",
      undefined,
      50,
      NOW
    );
    expect(result.elements).toHaveLength(50);
    expect(result.elements.at(-1)?.position).toBe("50");
    // NOT '60': rows 51..60 are still durable and undelivered.
    expect(result.positionJson).toBe("50");
    // Surplus past the cap is not a gap, so nothing is reported as skipped.
    expect(result.skipped).toBeUndefined();
    expect(result.gapReason).toBeUndefined();
  });

  test("the surplus is delivered on the next read instead of being dropped", () => {
    const store = storeOf(rows(60));
    const first = readIngressCursor(store, "hook-1", undefined, 50, NOW);
    const second = readIngressCursor(
      store,
      "hook-1",
      first.positionJson,
      50,
      NOW
    );
    expect(second.elements.map((element) => element.position)).toStrictEqual(
      Array.from({ length: 10 }, (_, index) => String(51 + index))
    );
    expect(second.positionJson).toBe("60");
    const third = readIngressCursor(
      store,
      "hook-1",
      second.positionJson,
      50,
      NOW
    );
    expect(third.elements).toStrictEqual([]);
    expect(third.positionJson).toBe("60");
  });

  test("an empty source preserves the caller position rather than rewinding", () => {
    const result = readIngressCursor(storeOf([]), "hook-1", "42", 50, NOW);
    expect(result.elements).toStrictEqual([]);
    expect(result.positionJson).toBe("42");
  });

  test("a corrupt or absent position restarts from the beginning of the source", () => {
    for (const position of [undefined, "not-json", "-3", '{"ingressId":4}']) {
      const result = readIngressCursor(
        storeOf(rows(2)),
        "hook-1",
        position,
        50,
        NOW
      );
      expect(result.elements.map((element) => element.position)).toStrictEqual([
        "1",
        "2",
      ]);
    }
  });

  test("payloads decode as JSON, fall back to raw text, and expose a blob ref", () => {
    const result = readIngressCursor(
      storeOf([
        { id: 1, receivedAt: 10, payloadJson: '{"a":1}' },
        { id: 2, receivedAt: 11, payloadJson: "not json" },
        { id: 3, receivedAt: 12, payloadRef: "blob-9" },
      ]),
      "hook-1",
      undefined,
      50,
      NOW
    );
    expect(result.elements.map((element) => element.payload)).toStrictEqual([
      { a: 1 },
      "not json",
      { payloadRef: "blob-9" },
    ]);
    expect(result.elements[0]?.occurredAt).toBe(10);
  });

  test("retention that drops undelivered rows is an accounted gap, not a silent loss", () => {
    const prune: PruneIngressResult = {
      deleted: 7,
      gaps: [{ sourceKey: "hook-1", pruned: 7, throughId: 30 }],
    };
    // The reader had delivered through 20, so rows 21..30 expired unread.
    const result = readIngressCursor(
      storeOf(rows(5, 31), prune),
      "hook-1",
      "20",
      50,
      NOW
    );
    expect(result.skipped).toBe(7);
    expect(result.gapReason).toBe("ingress_retention");
    // The surviving rows still ride through on the same read.
    expect(result.elements.map((element) => element.position)).toStrictEqual([
      "31",
      "32",
      "33",
      "34",
      "35",
    ]);
  });

  test("retention that only drops already-delivered rows costs nothing", () => {
    const prune: PruneIngressResult = {
      deleted: 4,
      gaps: [{ sourceKey: "hook-1", pruned: 4, throughId: 20 }],
    };
    const result = readIngressCursor(
      storeOf(rows(2, 21), prune),
      "hook-1",
      "20",
      50,
      NOW
    );
    expect(result.skipped).toBeUndefined();
    expect(result.gapReason).toBeUndefined();
  });

  test("another source key never charges its retention loss to this reader", () => {
    const prune: PruneIngressResult = {
      deleted: 9,
      gaps: [{ sourceKey: "hook-2", pruned: 9, throughId: 99 }],
    };
    expect(ingressRetentionGap(prune, "hook-1", 0)).toBeUndefined();
    expect(ingressRetentionGap(prune, "hook-2", 0)).toStrictEqual({
      skipped: 9,
      gapReason: "ingress_retention",
    });
  });
});
