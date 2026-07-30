import path from "node:path";

import { describe, expect, it } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { makeJournalDbProvider } from "../stores/gateway-db.js";
import { AutomationTriggerStore } from "./trigger-store.js";

function store(): AutomationTriggerStore {
  return new AutomationTriggerStore(
    makeJournalDbProvider(
      path.join(tempDirSync("centraid-trigger-store-"), "journal.db")
    )
  );
}

describe(AutomationTriggerStore, () => {
  it("upserts independent per-trigger cursors and removes stale automations", () => {
    const subject = store();
    subject.putCursor({
      automationId: "mail/digest",
      triggerIndex: 0,
      sourceKind: "cron",
      positionJson: "100",
      pendingJson: '{"targetPositionJson":"200","acknowledged":[]}',
      skipped: 3,
      gapReason: "scheduler_gap",
      updatedAt: 200,
    });
    subject.putCursor({
      automationId: "mail/digest",
      triggerIndex: 1,
      sourceKind: "webhook",
      positionJson: "7",
      updatedAt: 201,
    });
    subject.putCursor({
      automationId: "old/gone",
      triggerIndex: 0,
      sourceKind: "data",
      updatedAt: 1,
    });

    expect(subject.getCursor("mail/digest", 0)).toMatchObject({
      sourceKind: "cron",
      positionJson: "100",
      pendingJson: '{"targetPositionJson":"200","acknowledged":[]}',
      skipped: 3,
      gapReason: "scheduler_gap",
    });
    expect(subject.getCursor("mail/digest", 1)).toMatchObject({
      sourceKind: "webhook",
      positionJson: "7",
    });
    expect(
      subject.deleteCursorsNotIn([
        { automationId: "mail/digest", triggerIndex: 0 },
        { automationId: "mail/digest", triggerIndex: 1 },
      ])
    ).toBe(1);
    expect(subject.getCursor("old/gone", 0)).toBeUndefined();
    expect(subject.getCursor("mail/digest", 0)).toBeDefined();
    expect(subject.getCursor("mail/digest", 1)).toBeDefined();
  });

  it("retains cursors per trigger index and treats an empty desired set as a no-op", () => {
    const subject = store();
    for (const triggerIndex of [0, 1, 2]) {
      subject.putCursor({
        automationId: "mail/digest",
        triggerIndex,
        sourceKind: "data",
        positionJson: `"p${triggerIndex}"`,
        updatedAt: 10,
      });
    }

    // An empty listing (a worktree swap mid-read, or everything disabled) must
    // never destroy watermarks — re-enabling has to resume, not bootstrap.
    expect(subject.deleteCursorsNotIn([])).toBe(0);
    expect(subject.getCursor("mail/digest", 0)?.positionJson).toBe('"p0"');

    // Shrinking three triggers to one drops the orphaned indexes so a re-added
    // same-kind trigger cannot inherit a stale position.
    expect(
      subject.deleteCursorsNotIn([
        { automationId: "mail/digest", triggerIndex: 0 },
      ])
    ).toBe(2);
    expect(subject.getCursor("mail/digest", 0)?.positionJson).toBe('"p0"');
    expect(subject.getCursor("mail/digest", 1)).toBeUndefined();
    expect(subject.getCursor("mail/digest", 2)).toBeUndefined();
  });

  it("deduplicates ingress, exposes bounded backlog metadata, and prunes retention", () => {
    const subject = store();
    const first = subject.appendIngress({
      source: "webhook",
      sourceKey: "hook-1",
      deliveryId: "delivery-1",
      receivedAt: 100,
      payloadJson: '{"n":1}',
      expiresAt: 500,
    });
    const duplicate = subject.appendIngress({
      source: "webhook",
      sourceKey: "hook-1",
      deliveryId: "delivery-1",
      receivedAt: 101,
      payloadJson: '{"n":999}',
      expiresAt: 500,
    });
    const second = subject.appendIngress({
      source: "webhook",
      sourceKey: "hook-1",
      deliveryId: "delivery-2",
      receivedAt: 200,
      payloadJson: '{"n":2}',
      expiresAt: 900,
    });

    expect(first.inserted).toBe(true);
    expect(duplicate).toStrictEqual({ inserted: false, id: first.id });
    expect(second.id).toBeGreaterThan(first.id);
    expect(subject.ingressBoundsAfter("hook-1", 0)).toStrictEqual({
      count: 2,
      latestId: second.id,
    });
    expect(subject.listIngressAfter("hook-1", 0, 1)).toStrictEqual([
      expect.objectContaining({ id: first.id, payloadJson: '{"n":1}' }),
    ]);
    expect(subject.pruneIngress(600)).toStrictEqual({
      deleted: 1,
      gaps: [{ sourceKey: "hook-1", pruned: 1, throughId: first.id }],
    });
    expect(subject.listIngressAfter("hook-1", 0, 10)).toStrictEqual([
      expect.objectContaining({ id: second.id }),
    ]);
  });

  it("reports the retention gap per source so a stalled reader can account for it", () => {
    const subject = store();
    const stale = subject.appendIngress({
      source: "webhook",
      sourceKey: "hook-stalled",
      deliveryId: "a",
      receivedAt: 1,
      payloadJson: "{}",
      expiresAt: 100,
    });
    subject.appendIngress({
      source: "webhook",
      sourceKey: "hook-stalled",
      deliveryId: "b",
      receivedAt: 2,
      payloadJson: "{}",
      expiresAt: 100,
    });
    subject.appendIngress({
      source: "poll",
      sourceKey: "poll-live",
      deliveryId: "c",
      receivedAt: 3,
      payloadJson: "{}",
      expiresAt: 10_000,
    });

    const pruned = subject.pruneIngress(200);

    expect(pruned.deleted).toBe(2);
    expect(pruned.gaps).toStrictEqual([
      { sourceKey: "hook-stalled", pruned: 2, throughId: stale.id + 1 },
    ]);
    // Nothing expired for the live source, so it reports no gap at all.
    expect(subject.pruneIngress(200)).toStrictEqual({ deleted: 0, gaps: [] });
    expect(subject.ingressBoundsAfter("poll-live", 0).count).toBe(1);
  });
});
