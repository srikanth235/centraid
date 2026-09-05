// NO SILENT TRUNCATION, AT THE GATEWAY (#922 0a). The default 1,000-row window
// (#262) is kept as a bound; a read that fills it now says so. Three cases,
// because a wrong screen comes from any of them: the default cap fills, a
// declared window fills, and — the case a `rows.length === limit` check gets
// wrong — a set of exactly the window size hid nothing and must not claim it
// did.

import { beforeEach, describe, expect, test } from "vitest";

import { answeredAutomation } from "../grant/automation-principal.test-fixtures.js";
import { openOwnerVault } from "./owner-vault.test-fixtures.js";
import type { OwnerVault } from "./owner-vault.test-fixtures.js";
import { GATEWAY_DEFAULT_READ_ROWS } from "./types.js";

let vault: OwnerVault;

/**
 * Rows straight into the physical table: this suite is about the WINDOW, and a
 * thousand command invocations would measure the command runner instead. One
 * shared body content item, because a note's body is not what is under test.
 */
function seedNotes(count: number): void {
  vault.db.vault
    .prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, created_at)
       VALUES (?, 'text/markdown', 'centraid:body', 'sha-truncation', 0, ?)`
    )
    .run("content-truncation", "2026-01-01T00:00:00Z");
  const insert = vault.db.vault.prepare(
    `INSERT INTO knowledge_note
       (note_id, author_party_id, title, body_content_id, format, pinned,
        created_at, updated_at)
     VALUES (?, ?, ?, 'content-truncation', 'markdown', 0, ?, ?)`
  );
  for (let index = 0; index < count; index += 1) {
    insert.run(
      `note-${String(index).padStart(6, "0")}`,
      vault.boot.ownerPartyId,
      `note ${index}`,
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z"
    );
  }
}

describe("gateway read truncation", () => {
  beforeEach(() => {
    vault = openOwnerVault();
  });

  test("the default cap filling is reported, with the limit that was applied", () => {
    seedNotes(GATEWAY_DEFAULT_READ_ROWS + 1);
    const result = vault.gateway.read(vault.owner, {
      entity: "knowledge.note",
    });
    expect(result.rows).toHaveLength(GATEWAY_DEFAULT_READ_ROWS);
    expect(result.truncated).toBe(true);
    expect(result.appliedLimit).toBe(GATEWAY_DEFAULT_READ_ROWS);
  });

  test("a page under the cap is not truncated", () => {
    seedNotes(3);
    const result = vault.gateway.read(vault.owner, {
      entity: "knowledge.note",
    });
    expect(result.rows).toHaveLength(3);
    expect(result.truncated).toBeUndefined();
    expect(result.appliedLimit).toBeUndefined();
  });

  test("a set of exactly the window fills it without hiding a row", () => {
    seedNotes(4);
    const result = vault.gateway.read(vault.owner, {
      entity: "knowledge.note",
      limit: 4,
    });
    expect(result.rows).toHaveLength(4);
    expect(result.truncated).toBeUndefined();
  });

  test("an explicit window that fills reports that window, not the default", () => {
    seedNotes(10);
    const result = vault.gateway.read(vault.owner, {
      entity: "knowledge.note",
      limit: 4,
    });
    expect(result.rows).toHaveLength(4);
    expect(result.truncated).toBe(true);
    expect(result.appliedLimit).toBe(4);
  });

  test("the receipt counts the rows the caller got, never the probe row", () => {
    seedNotes(10);
    // Owner-direct reads write no receipt (#928), so the count is asserted
    // where a receipt still exists: a non-owner principal's read.
    const reader = answeredAutomation(vault.db, vault.boot, "counter", [
      { schema: "knowledge", verbs: "read" },
      { schema: "core", table: "content_item", verbs: "read" },
    ]);
    const result = vault.gateway.read(reader.credential, {
      entity: "knowledge.note",
      limit: 4,
    });
    const receipt = vault.db.audit
      .prepare("SELECT detail_json FROM access_receipt WHERE receipt_id = ?")
      .get(result.receiptId!) as { detail_json: string } | undefined;
    expect(
      (JSON.parse(receipt!.detail_json) as { rowCount: number }).rowCount
    ).toBe(4);
  });
});
