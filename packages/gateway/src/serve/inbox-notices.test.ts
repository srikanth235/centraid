import { afterEach, describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";
import { openVaultDb } from "@centraid/vault";
import type { VaultDb } from "@centraid/vault";

import {
  createInboxDecisionWakeTracker,
  inboxDecisionKeys,
  InboxEventBus,
} from "./inbox-events.js";
import {
  humanizeAutomationRef,
  InboxNoticeStore,
  noticeGist,
  shouldWriteAutomationNotice,
} from "./inbox-notices.js";
import { configureApiKey, stageItem } from "./outbox-executor-test-kit.js";
import { openVaultPlane } from "./vault-plane.js";

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

    test("a repeated gateway-health transition bumps one card and reopens it", () => {
      db = openVaultDb();
      const changes: Array<{ wake: boolean }> = [];
      const store = new InboxNoticeStore(db.vault, (change) =>
        changes.push({ wake: change.wake })
      );
      // The desktop's sourceRef is stable per (gateway, scope, transition):
      // a flapping gateway must collapse into ONE card that counts up, not
      // dedupe into the first outage forever.
      const input = {
        kind: "gateway-health",
        sourceRef: "gateway-health:local:gateway:down",
        headline: "Local is unreachable",
        severity: "high" as const,
        at: "2026-07-30T10:00:00.000Z",
      };

      const first = store.put(input);
      store.markRead(first.noticeId);
      store.archive(first.noticeId);
      const again = store.put({ ...input, at: "2026-07-30T10:05:00.000Z" });

      expect(again.noticeId).toBe(first.noticeId);
      expect(again.count).toBe(2);
      expect(again.lastAt).toBe("2026-07-30T10:05:00.000Z");
      expect(again.firstAt).toBe(first.firstAt);
      // An outage the owner had already filed away comes back unread.
      expect(again.readAt).toBeNull();
      expect(again.archivedAt).toBeNull();
      expect(store.list()).toHaveLength(1);
      expect(changes.filter((change) => change.wake)).toHaveLength(2);
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

  describe(noticeGist, () => {
    test("reduces a failure message to one bounded headline-sized line", () => {
      expect(
        noticeGist("Request failed: 403 forbidden\n  at fetch (node:...)")
      ).toBe("Request failed: 403 forbidden");
      expect(noticeGist("  \n  spaced   out  message.  ")).toBe(
        "spaced out message"
      );
      expect(noticeGist("TypeError: cannot read 'id' of undefined")).toBe(
        "cannot read 'id' of undefined"
      );
      expect(noticeGist(undefined)).toBeUndefined();
      expect(noticeGist("   ")).toBeUndefined();
      const long = noticeGist("x".repeat(200));
      expect(long).toHaveLength(80);
      expect(long?.endsWith("…")).toBe(true);
    });
  });

  describe(humanizeAutomationRef, () => {
    test("never puts a raw ref in front of the owner", () => {
      expect(humanizeAutomationRef("myapp/nightly-digest")).toBe(
        "Nightly digest"
      );
      expect(humanizeAutomationRef("mail/pull_inbox")).toBe("Pull inbox");
      expect(humanizeAutomationRef("standalone")).toBe("Standalone");
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
    test("keys real open decisions: seeds at startup, wakes on a net-zero swap", async () => {
      const plane = openVaultPlane({
        bootstrap: true,
        dir: await tempDir(),
        logger: {
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
        ownerName: "Priya",
      });
      try {
        configureApiKey(plane);
        const first = stageItem(plane);
        const tracker = createInboxDecisionWakeTracker();
        const observe = (): boolean =>
          tracker.observe("vault-a", inboxDecisionKeys(plane.blocking()));

        // A decision open before this process started is not news: the first
        // observation after a restart seeds silently.
        expect(plane.blocking().outbox).toHaveLength(1);
        expect(observe()).toBe(false);

        // Net zero across one grouped commit — one decision closes while
        // another opens. The count never moves; the new decision still has
        // to reach a closed device.
        await plane.decideOutbox({ itemId: first, decision: "discard" });
        const second = stageItem(plane);
        expect(plane.blocking().outbox).toHaveLength(1);
        expect(plane.blocking().outbox[0]?.itemId).toBe(second);
        expect(observe()).toBe(true);

        // An unchanged projection is quiet; a plain new decision wakes.
        expect(observe()).toBe(false);
        stageItem(plane);
        expect(observe()).toBe(true);

        // Closing decisions never wakes.
        await plane.decideOutbox({ itemId: second, decision: "discard" });
        expect(observe()).toBe(false);
      } finally {
        plane.stop();
      }
    });

    test("tracks each vault separately", () => {
      const tracker = createInboxDecisionWakeTracker();
      expect(tracker.observe("vault-a", ["parked:i1"])).toBe(false);
      expect(tracker.observe("vault-b", ["parked:i2"])).toBe(false);
      expect(tracker.observe("vault-a", ["parked:i1", "parked:i2"])).toBe(true);
      expect(tracker.observe("vault-b", ["parked:i2"])).toBe(false);
    });
  });
});
