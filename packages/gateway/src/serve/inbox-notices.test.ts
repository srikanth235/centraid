import { afterEach, describe, expect, test } from "vitest";

import { openVaultDb } from "@centraid/vault";
import type { VaultDb } from "@centraid/vault";

import {
  createInboxDecisionWakeTracker,
  InboxEventBus,
} from "./inbox-events.js";
import {
  InboxNoticeStore,
  shouldWriteAutomationNotice,
} from "./inbox-notices.js";

describe("Inbox notice delivery", () => {
  let db: VaultDb | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  describe(InboxNoticeStore, () => {
    test("collapses repeats by kind/source and reopens an archived card", () => {
      db = openVaultDb();
      const changes: Array<{ wake: boolean }> = [];
      const store = new InboxNoticeStore(db.vault, (change) =>
        changes.push({ wake: change.wake })
      );
      const first = store.put({
        kind: "automation",
        sourceRef: "mail/digest",
        headline: "Digest failed",
        detail: { outcome: "failure" },
        severity: "high",
        at: "2026-07-30T01:00:00.000Z",
      });
      store.archive(first.noticeId, "2026-07-30T01:01:00.000Z");
      const repeated = store.put({
        kind: "automation",
        sourceRef: "mail/digest",
        headline: "Digest recovered",
        detail: { outcome: "success" },
        at: "2026-07-30T01:02:00.000Z",
      });

      expect(repeated).toMatchObject({
        noticeId: first.noticeId,
        count: 2,
        headline: "Digest recovered",
        readAt: null,
        archivedAt: null,
        lastAt: "2026-07-30T01:02:00.000Z",
      });
      expect(store.list()).toHaveLength(1);
      expect(changes.map((change) => change.wake)).toStrictEqual([
        true,
        false,
        false,
      ]);
    });

    test("read and archive transitions are idempotent and archived rows are opt-in", () => {
      db = openVaultDb();
      const store = new InboxNoticeStore(db.vault);
      const notice = store.put({
        kind: "outbox",
        sourceRef: "item-1",
        headline: "Message sent",
      });

      expect(
        store.markRead(notice.noticeId, "2026-07-30T02:00:00.000Z")?.readAt
      ).toBe("2026-07-30T02:00:00.000Z");
      expect(
        store.archive(notice.noticeId, "2026-07-30T03:00:00.000Z")
      ).toMatchObject({
        archivedAt: "2026-07-30T03:00:00.000Z",
        readAt: "2026-07-30T02:00:00.000Z",
      });
      expect(store.list()).toStrictEqual([]);
      expect(store.list({ includeArchived: true })).toHaveLength(1);
      expect(store.archive("missing")).toBeUndefined();
    });

    test("idempotent external replay does not inflate count or ring again", () => {
      db = openVaultDb();
      const changes: Array<{ wake: boolean }> = [];
      const store = new InboxNoticeStore(db.vault, (change) =>
        changes.push({ wake: change.wake })
      );
      const input = {
        kind: "gateway-health",
        sourceRef: "local:down:1785391200000:connection refused",
        headline: "Local is unreachable",
        severity: "high" as const,
        at: "2026-07-30T10:00:00.000Z",
      };

      const first = store.putIfAbsent(input);
      const replayed = store.putIfAbsent(input);

      expect(replayed).toStrictEqual(first);
      expect(replayed.count).toBe(1);
      expect(changes).toStrictEqual([{ wake: true }]);
    });

    test("prunes old archives, enforces the cap, and never evicts active cards first", () => {
      db = openVaultDb();
      const insert = db.vault.prepare(
        `INSERT INTO inbox_notice(
         notice_id, kind, source_ref, headline, detail_json, severity,
         count, first_at, last_at, read_at, archived_at
       ) VALUES (?, 'seed', ?, 'Seed', '{}', 'info', 1, ?, ?, ?, ?)`
      );
      db.vault.exec("BEGIN");
      insert.run(
        "old",
        "old",
        "2026-03-01T00:00:00.000Z",
        "2026-03-01T00:00:00.000Z",
        "2026-03-01T00:00:00.000Z",
        "2026-03-01T00:00:00.000Z"
      );
      for (let i = 0; i < 999; i += 1) {
        insert.run(
          `archived-${i}`,
          `archived-${i}`,
          "2026-07-29T00:00:00.000Z",
          "2026-07-29T00:00:00.000Z",
          "2026-07-29T00:00:00.000Z",
          "2026-07-29T00:00:00.000Z"
        );
      }
      insert.run(
        "active-existing",
        "active-existing",
        "2026-07-29T12:00:00.000Z",
        "2026-07-29T12:00:00.000Z",
        null,
        null
      );
      db.vault.exec("COMMIT");

      const store = new InboxNoticeStore(db.vault);
      store.put({
        kind: "seed",
        sourceRef: "active-new",
        headline: "New active card",
        at: "2026-07-30T00:00:00.000Z",
      });

      const count = db.vault
        .prepare("SELECT count(*) AS n FROM inbox_notice")
        .get() as unknown as { n: number };
      expect(count.n).toBe(1_000);
      expect(store.getBySource("seed", "old")).toBeUndefined();
      expect(store.getBySource("seed", "active-existing")).toBeDefined();
      expect(store.getBySource("seed", "active-new")).toBeDefined();
      expect(store.list({ includeArchived: true })).toHaveLength(200);
    });
  });

  describe(shouldWriteAutomationNotice, () => {
    test("defaults to failures plus only the first recovery", () => {
      expect(shouldWriteAutomationNotice(undefined, "failure")).toBe(true);
      expect(
        shouldWriteAutomationNotice("failures", "success", "failure")
      ).toBe(true);
      expect(
        shouldWriteAutomationNotice("failures", "success", "success")
      ).toBe(false);
      expect(shouldWriteAutomationNotice("always", "success")).toBe(true);
      expect(shouldWriteAutomationNotice("never", "failure")).toBe(false);
    });
  });

  describe(InboxEventBus, () => {
    test("delivers a vault-scoped content-free doorbell and unsubscribes", () => {
      const bus = new InboxEventBus();
      const events: Array<{ vaultId: string; wake: boolean }> = [];
      const unsubscribe = bus.subscribe("vault-a", (event) =>
        events.push(event)
      );

      bus.publish("vault-b", true);
      bus.publish("vault-a");
      bus.publish("vault-a", true);
      unsubscribe();
      bus.publish("vault-a", true);

      expect(events).toStrictEqual([
        { vaultId: "vault-a", wake: false },
        { vaultId: "vault-a", wake: true },
      ]);
    });
  });

  describe(createInboxDecisionWakeTracker, () => {
    test("wakes only when a vault's canonical open-decision count rises", () => {
      const tracker = createInboxDecisionWakeTracker();

      expect(tracker.observe("vault-a", 0)).toBe(false);
      expect(tracker.observe("vault-a", 1)).toBe(true);
      expect(tracker.observe("vault-a", 1)).toBe(false);
      expect(tracker.observe("vault-a", 0)).toBe(false);
      expect(tracker.observe("vault-a", 2)).toBe(true);
      expect(tracker.observe("vault-b", 1)).toBe(true);
    });
  });
});
