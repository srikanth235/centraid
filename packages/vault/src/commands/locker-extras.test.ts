import { beforeEach, describe, expect, test } from "vitest";

import { resolveEntity } from "../schema/tables.js";
import { lockerFixture } from "./locker-test-kit.js";
import type { LockerFixture } from "./locker-test-kit.js";
import { templateFor } from "./locker-types.js";

let fx: LockerFixture;

describe("locker #872 surface", () => {
  beforeEach(() => {
    fx = lockerFixture();
  });

  describe("the alias mapping is a registered table now (README-Locker §8)", () => {
    test("locker.item_alias resolves through the entity registry", () => {
      expect(resolveEntity("locker.item_alias")).toMatchObject({
        schema: "locker",
        table: "item_alias",
        physical: "locker_item_alias",
      });
    });

    test("an alias set on create reads back, clears, and reassigns", () => {
      const itemId = fx.addLogin({ alias: "github" });
      const aliasOf = (id: string): string | undefined =>
        (
          fx.db.vault
            .prepare("SELECT alias FROM locker_item_alias WHERE item_id = ?")
            .get(id) as { alias: string } | undefined
        )?.alias;
      expect(aliasOf(itemId)).toBe("github");
      fx.out(fx.invoke("locker.edit_item", { item_id: itemId, alias: "gh" }));
      expect(aliasOf(itemId)).toBe("gh");
      fx.out(fx.invoke("locker.edit_item", { item_id: itemId, alias: "" }));
      expect(aliasOf(itemId)).toBeUndefined();
    });
  });

  describe("archive is distinct from trash (GAPS §3.3 #9)", () => {
    test("archiving sets no purge date and unarchiving restores the item", () => {
      const itemId = fx.addLogin();
      fx.out(fx.invoke("locker.archive_item", { item_id: itemId }));
      const archived = fx.itemRow(itemId);
      expect(archived.archived_at).not.toBeNull();
      expect(archived.deleted_at).toBeNull();
      expect(archived.purge_at).toBeNull();
      fx.out(fx.invoke("locker.unarchive_item", { item_id: itemId }));
      expect(fx.itemRow(itemId).archived_at).toBeNull();
    });

    test("archived and trashed cannot both be true", () => {
      const itemId = fx.addLogin();
      fx.out(fx.invoke("locker.archive_item", { item_id: itemId }));
      expect(() =>
        fx.db.vault
          .prepare("UPDATE locker_item SET deleted_at = ? WHERE item_id = ?")
          .run("2026-01-01T00:00:00.000Z", itemId)
      ).toThrow(/CHECK constraint failed/u);
    });
  });

  describe("custom fields and sections (GAPS §3.3 #2)", () => {
    test("a sealed custom value is ciphertext at rest and never in the plain column", () => {
      const itemId = fx.addLogin();
      const { field_id: fieldId } = fx.out<{ field_id: string }>(
        fx.invoke("locker.set_field", {
          item_id: itemId,
          section: "Recovery",
          label: "Recovery code",
          kind: "sealed",
          value: "swordfish-42",
        })
      );
      const row = fx.db.vault
        .prepare("SELECT * FROM locker_item_field WHERE field_id = ?")
        .get(fieldId) as Record<string, unknown>;
      expect(row.value_text).toBeNull();
      expect(
        fx.unsealCell(
          "locker_item_field",
          "value_sealed",
          fieldId,
          row.value_sealed
        )
      ).toBe("swordfish-42");
    });

    test("a text custom value stays readable and out of the sealed column", () => {
      const itemId = fx.addLogin();
      const { field_id: fieldId } = fx.out<{ field_id: string }>(
        fx.invoke("locker.set_field", {
          item_id: itemId,
          label: "Account manager",
          kind: "text",
          value: "Robin",
        })
      );
      const row = fx.db.vault
        .prepare("SELECT * FROM locker_item_field WHERE field_id = ?")
        .get(fieldId) as Record<string, unknown>;
      expect(row.value_text).toBe("Robin");
      expect(row.value_sealed).toBeNull();
    });

    test("the round-tripped placeholder leaves the stored secret alone", () => {
      const itemId = fx.addLogin();
      const { field_id: fieldId } = fx.out<{ field_id: string }>(
        fx.invoke("locker.set_field", {
          item_id: itemId,
          label: "PIN",
          kind: "sealed",
          value: "8080",
        })
      );
      fx.out(
        fx.invoke("locker.set_field", {
          item_id: itemId,
          field_id: fieldId,
          label: "Card PIN",
          kind: "sealed",
          value: "«sealed»",
        })
      );
      const row = fx.db.vault
        .prepare("SELECT * FROM locker_item_field WHERE field_id = ?")
        .get(fieldId) as Record<string, unknown>;
      expect(row.label).toBe("Card PIN");
      expect(
        fx.unsealCell(
          "locker_item_field",
          "value_sealed",
          fieldId,
          row.value_sealed
        )
      ).toBe("8080");
    });

    test("the journal records a keyed hash of a sealed custom value, never the value", () => {
      const itemId = fx.addLogin();
      fx.out(
        fx.invoke("locker.set_field", {
          item_id: itemId,
          label: "Recovery code",
          kind: "sealed",
          value: "never-journal-me",
        })
      );
      const journalled = fx.db.audit
        .prepare(
          "SELECT input_json FROM agent_command_invocation ORDER BY invocation_id DESC LIMIT 1"
        )
        .get() as { input_json: string } | undefined;
      expect(journalled?.input_json).not.toContain("never-journal-me");
      expect(journalled?.input_json).toContain("sealed:sha256:");
    });

    test("removing a field drops it", () => {
      const itemId = fx.addLogin();
      const { field_id: fieldId } = fx.out<{ field_id: string }>(
        fx.invoke("locker.set_field", {
          item_id: itemId,
          label: "Scratch",
          kind: "text",
          value: "x",
        })
      );
      fx.out(
        fx.invoke("locker.remove_field", { item_id: itemId, field_id: fieldId })
      );
      expect(
        fx.count(
          "SELECT count(*) AS n FROM locker_item_field WHERE field_id = ?",
          fieldId
        )
      ).toBe(0);
    });
  });

  describe("nine new item types are templates, not columns (GAPS §3.3 #1)", () => {
    test("creating an SSH key mints its template fields, sealed where the spec says", () => {
      const itemId = fx.out<{ item_id: string }>(
        fx.invoke("locker.add_item", { type: "ssh_key", title: "build box" })
      ).item_id;
      const rows = fx.db.vault
        .prepare(
          "SELECT label, kind FROM locker_item_field WHERE item_id = ? ORDER BY position"
        )
        .all(itemId) as { label: string; kind: string }[];
      expect(rows).toHaveLength(templateFor("ssh_key").length);
      expect(rows.find((row) => row.label === "Private key")?.kind).toBe(
        "sealed"
      );
      expect(rows.find((row) => row.label === "Public key")?.kind).toBe("text");
    });

    test("every expansion type carries a template and none adds a column", () => {
      const before = (
        fx.db.vault.prepare("PRAGMA table_info(locker_item)").all() as {
          name: string;
        }[]
      ).map((column) => column.name);
      for (const type of [
        "api_credential",
        "passport",
        "bank_account",
        "driving_licence",
        "software_licence",
        "crypto_wallet",
        "membership",
        "document",
      ]) {
        expect(templateFor(type).length).toBeGreaterThan(0);
        fx.out(fx.invoke("locker.add_item", { type, title: `a ${type}` }));
      }
      const after = (
        fx.db.vault.prepare("PRAGMA table_info(locker_item)").all() as {
          name: string;
        }[]
      ).map((column) => column.name);
      expect(after).toStrictEqual(before);
    });
  });

  describe("multiple addresses per login (GAPS §3.3 #4)", () => {
    test("each carries its own match policy and the primary stays on the item", () => {
      const itemId = fx.addLogin({ url: "https://example.test" });
      fx.out(
        fx.invoke("locker.set_addresses", {
          item_id: itemId,
          addresses: [
            { url: "https://login.example.test", match_policy: "exact-host" },
            { url: "https://accounts.example.test" },
          ],
        })
      );
      expect(
        (
          fx.db.vault
            .prepare(
              "SELECT url, match_policy FROM locker_item_address WHERE item_id = ? ORDER BY position"
            )
            .all(itemId) as { url: string; match_policy: string }[]
        ).map((row) => ({ url: row.url, match_policy: row.match_policy }))
      ).toStrictEqual([
        { url: "https://login.example.test", match_policy: "exact-host" },
        {
          url: "https://accounts.example.test",
          match_policy: "registrable-domain",
        },
      ]);
      expect(fx.itemRow(itemId).url).toBe("https://example.test");
    });
  });

  describe("the passkey slot (GAPS §3.3 #3)", () => {
    test("metadata stays plain and key material is sealed", () => {
      const itemId = fx.addLogin();
      fx.out(
        fx.invoke("locker.set_passkey", {
          item_id: itemId,
          rp_id: "example.test",
          user_handle: "alex",
          private_key: "-----BEGIN PRIVATE KEY-----",
        })
      );
      const row = fx.db.vault
        .prepare("SELECT * FROM locker_item_passkey WHERE item_id = ?")
        .get(itemId) as Record<string, unknown>;
      expect(row.rp_id).toBe("example.test");
      expect(row.user_handle).toBe("alex");
      expect(
        fx.unsealCell(
          "locker_item_passkey",
          "private_key",
          itemId,
          row.private_key
        )
      ).toBe("-----BEGIN PRIVATE KEY-----");
      fx.out(fx.invoke("locker.clear_passkey", { item_id: itemId }));
      expect(
        fx.count(
          "SELECT count(*) AS n FROM locker_item_passkey WHERE item_id = ?",
          itemId
        )
      ).toBe(0);
    });
  });
});
