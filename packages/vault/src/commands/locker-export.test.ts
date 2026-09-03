import { beforeEach, describe, expect, test } from "vitest";

import { VAULT_ENTITIES } from "../schema/entity-catalog.js";
import { revisionPolicyOf } from "../schema/entity-declaration.js";
import { lockerFixture } from "./locker-test-kit.js";
import type { LockerFixture } from "./locker-test-kit.js";

let fx: LockerFixture;

describe("locker #872 surface: history, duplicate and export", () => {
  beforeEach(() => {
    fx = lockerFixture();
  });

  describe("item and password history (GAPS §3.3 #5, #6d)", () => {
    test("a rotation keeps the previous password SEALED in history and re-stamps the age", () => {
      const itemId = fx.addLogin();
      const firstSetAt = fx.itemRow(itemId).password_set_at;
      expect(firstSetAt).not.toBeNull();
      fx.out(
        fx.invoke("locker.edit_item", {
          item_id: itemId,
          password: "a new one",
        })
      );
      const revision = fx.db.vault
        .prepare(
          `SELECT * FROM core_entity_revision
            WHERE entity_type = 'locker.item' AND entity_id = ?
            ORDER BY recorded_at DESC LIMIT 1`
        )
        .get(itemId) as Record<string, unknown>;
      const snapshot = JSON.parse(String(revision.snapshot_json)) as Record<
        string,
        unknown
      >;
      expect(
        fx.unsealCell("locker_item", "password", itemId, snapshot.password)
      ).toBe("correct horse battery");
      expect(fx.itemRow(itemId).password_set_at).not.toBe(firstSetAt);
    });

    test("an edit that does not touch the password does not re-stamp its age", () => {
      const itemId = fx.addLogin();
      const setAt = fx.itemRow(itemId).password_set_at;
      fx.out(
        fx.invoke("locker.edit_item", {
          item_id: itemId,
          title: "Work email",
          password: "«sealed»",
        })
      );
      expect(fx.itemRow(itemId).password_set_at).toBe(setAt);
    });

    test("history survives the undo window — the Locker retains FOREVER", () => {
      const itemId = fx.addLogin();
      for (const password of ["second", "third"])
        fx.out(fx.invoke("locker.edit_item", { item_id: itemId, password }));
      expect(
        fx.count(
          "SELECT count(*) AS n FROM core_entity_revision WHERE entity_type = 'locker.item' AND entity_id = ?",
          itemId
        )
      ).toBeGreaterThanOrEqual(2);
      expect(revisionPolicyOf(VAULT_ENTITIES.locker!.item!).retain).toBe(
        "forever"
      );
    });
  });

  describe("duplicate an item (GAPS §3.3 #10)", () => {
    test("sealed values are copied vault-side and re-sealed against the new row", () => {
      const sourceId = fx.addLogin({ alias: "github", otp_seed: "JBSWY3DPEB" });
      fx.out(fx.invoke("locker.star_item", { item_id: sourceId }));
      const copyId = fx.out<{ item_id: string }>(
        fx.invoke("locker.duplicate_item", { item_id: sourceId })
      ).item_id;
      expect(copyId).not.toBe(sourceId);
      const copy = fx.itemRow(copyId);
      expect(copy.title).toBe("Email copy");
      expect(
        fx.unsealCell("locker_item", "password", copyId, copy.password)
      ).toBe("correct horse battery");
      expect(
        fx.unsealCell("locker_item", "otp_seed", copyId, copy.otp_seed)
      ).toBe("JBSWY3DPEB");
      expect(
        fx.count(
          "SELECT count(*) AS n FROM locker_item_alias WHERE item_id = ?",
          copyId
        )
      ).toBe(0);
    });

    test("custom fields come with it, sealed values included", () => {
      const sourceId = fx.addLogin();
      fx.out(
        fx.invoke("locker.set_field", {
          item_id: sourceId,
          section: "Recovery",
          label: "Recovery code",
          kind: "sealed",
          value: "keep-me",
        })
      );
      const copyId = fx.out<{ item_id: string }>(
        fx.invoke("locker.duplicate_item", { item_id: sourceId })
      ).item_id;
      const copied = fx.db.vault
        .prepare("SELECT * FROM locker_item_field WHERE item_id = ?")
        .get(copyId) as Record<string, unknown>;
      expect(copied.label).toBe("Recovery code");
      expect(
        fx.unsealCell(
          "locker_item_field",
          "value_sealed",
          String(copied.field_id),
          copied.value_sealed
        )
      ).toBe("keep-me");
    });
  });

  describe("counts", () => {
    test("live, archived and trashed are counted apart", () => {
      const live = fx.addLogin();
      const archived = fx.addLogin({ title: "Old" });
      const trashed = fx.addLogin({ title: "Gone" });
      fx.out(fx.invoke("locker.archive_item", { item_id: archived }));
      fx.out(fx.invoke("locker.trash_item", { item_id: trashed }));
      expect(fx.out(fx.invoke("locker.counts", {}))).toMatchObject({
        live: 1,
        archived: 1,
        trashed: 1,
        by_type: [{ type: "login", n: 1 }],
      });
      expect(
        fx.count(
          "SELECT count(*) AS n FROM locker_item WHERE item_id = ? AND archived_at IS NULL AND deleted_at IS NULL",
          live
        )
      ).toBe(1);
    });
  });

  describe("plaintext export (GAPS §3.3 #7)", () => {
    test("it refuses without the confirm its lede names", () => {
      expect(fx.invoke("locker.export", { confirm: false }).status).not.toBe(
        "executed"
      );
    });

    test("it returns the plaintext and receipts the unseal of every column it read", () => {
      const itemId = fx.addLogin({ alias: "github" });
      fx.out(
        fx.invoke("locker.set_field", {
          item_id: itemId,
          label: "Recovery code",
          kind: "sealed",
          value: "swordfish",
        })
      );
      const outcome = fx.invoke("locker.export", { confirm: true });
      const payload = fx.out<{
        item_count: number;
        items: Record<string, unknown>[];
      }>(outcome);
      expect(payload.item_count).toBe(1);
      const exported = payload.items[0]!;
      expect(exported.password).toBe("correct horse battery");
      expect(exported.alias).toBe("github");
      expect(exported.fields).toStrictEqual([
        {
          section: "",
          label: "Recovery code",
          kind: "sealed",
          value: "swordfish",
        },
      ]);
      const receipt = fx.db.audit
        .prepare(
          `SELECT detail_json FROM access_receipt
            WHERE action = 'act locker.export' AND decision = 'allow'
            ORDER BY receipt_id DESC LIMIT 1`
        )
        .get() as { detail_json: string } | undefined;
      expect(receipt).toBeDefined();
      const detail = JSON.parse(String(receipt?.detail_json)) as {
        unsealed?: string[];
      };
      expect(detail.unsealed).toContain("locker.item.password");
      expect(detail.unsealed).toContain("locker.item_field.value_sealed");
    });

    test("the plaintext result is redacted from the journal", () => {
      fx.addLogin({ password: "do-not-journal-this" });
      fx.out(fx.invoke("locker.export", { confirm: true }));
      const journalled = [
        ...(fx.db.audit
          .prepare("SELECT detail_json AS text FROM access_receipt")
          .all() as { text: string | null }[]),
        ...(fx.db.audit
          .prepare("SELECT input_json AS text FROM agent_command_invocation")
          .all() as { text: string | null }[]),
        ...(fx.db.audit
          .prepare("SELECT summary AS text FROM agent_explanation")
          .all() as { text: string | null }[]),
        ...(fx.db.vault
          .prepare("SELECT audit_json AS text FROM replica_invocation_commit")
          .all() as { text: string | null }[]),
      ];
      expect(journalled.length).toBeGreaterThan(0);
      for (const row of journalled) {
        expect(row.text ?? "").not.toContain("do-not-journal-this");
      }
    });

    test("trashed items and history stay out unless asked for", () => {
      const itemId = fx.addLogin();
      fx.out(
        fx.invoke("locker.edit_item", { item_id: itemId, password: "second" })
      );
      const plain = fx.out<{ items: Record<string, unknown>[] }>(
        fx.invoke("locker.export", { confirm: true })
      );
      expect(plain.items[0]!.history).toStrictEqual([]);
      const withHistory = fx.out<{ items: Record<string, unknown>[] }>(
        fx.invoke("locker.export", { confirm: true, include_history: true })
      );
      const history = withHistory.items[0]!.history as {
        password: string | null;
      }[];
      expect(history.map((revision) => revision.password)).toContain(
        "correct horse battery"
      );
    });
  });

  describe("purge takes the sidecars with it", () => {
    test("nothing of a purged item is left behind", () => {
      const itemId = fx.addLogin({ alias: "github" });
      fx.out(
        fx.invoke("locker.set_field", {
          item_id: itemId,
          label: "Recovery code",
          kind: "sealed",
          value: "swordfish",
        })
      );
      fx.out(
        fx.invoke("locker.set_passkey", {
          item_id: itemId,
          rp_id: "example.test",
          private_key: "k",
        })
      );
      fx.out(
        fx.invoke("locker.set_addresses", {
          item_id: itemId,
          addresses: [{ url: "https://a.test" }],
        })
      );
      fx.out(fx.invoke("locker.trash_item", { item_id: itemId }));
      fx.out(fx.invoke("locker.purge_item", { item_id: itemId }));
      for (const table of [
        "locker_item",
        "locker_item_field",
        "locker_item_address",
        "locker_item_passkey",
        "locker_item_alias",
      ]) {
        expect(
          fx.count(
            `SELECT count(*) AS n FROM ${table} WHERE item_id = ?`,
            itemId
          ),
          `${table} still holds a row for the purged item`
        ).toBe(0);
      }
    });
  });
});
