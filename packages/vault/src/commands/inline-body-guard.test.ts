import { describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import type { Gateway } from "../gateway/gateway.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import {
  INLINE_BODY_BUDGET_BYTES,
  InlineBodyTooLargeError,
  assertInlineDataUriWithinBudget,
  assertTextBodyWithinBudget,
  scanInlineBodyViolations,
} from "./inline-body-guard.js";
import { registerKnowledgeCommands } from "./knowledge.js";
import { registerSocialCommands } from "./social.js";

describe("inline-body-guard", () => {
  test("assertTextBodyWithinBudget allows bodies at or under budget", () => {
    expect(() =>
      assertTextBodyWithinBudget(
        "x".repeat(INLINE_BODY_BUDGET_BYTES),
        "text/plain"
      )
    ).not.toThrow();
  });

  test("assertTextBodyWithinBudget refuses a body over budget with a typed error", () => {
    const big = "x".repeat(INLINE_BODY_BUDGET_BYTES + 1);
    expect(() => assertTextBodyWithinBudget(big, "text/markdown")).toThrow(
      InlineBodyTooLargeError
    );
    // Capture the throw rather than asserting inside `catch`, so the four field
    // assertions always run: a silent no-throw leaves `thrown` undefined and
    // fails the instanceof check instead of skipping the block.
    let thrown: unknown;
    try {
      assertTextBodyWithinBudget(big, "text/markdown");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InlineBodyTooLargeError);
    const typed = thrown as InlineBodyTooLargeError;
    expect(typed.code).toBe("INLINE_BODY_TOO_LARGE");
    expect(typed.byteSize).toBe(big.length);
    expect(typed.budgetBytes).toBe(INLINE_BODY_BUDGET_BYTES);
  });

  test("assertInlineDataUriWithinBudget only gates text/* — binary payloads pass through untouched", () => {
    const bigBinary = Buffer.alloc(INLINE_BODY_BUDGET_BYTES * 2, 1).toString(
      "base64"
    );
    expect(() =>
      assertInlineDataUriWithinBudget(
        `data:application/octet-stream;base64,${bigBinary}`
      )
    ).not.toThrow();
  });

  test("assertInlineDataUriWithinBudget refuses an oversized text/* data URI", () => {
    const bigText = "y".repeat(INLINE_BODY_BUDGET_BYTES + 100);
    const uri = `data:text/plain;charset=utf-8,${encodeURIComponent(bigText)}`;
    expect(() => assertInlineDataUriWithinBudget(uri)).toThrow(
      InlineBodyTooLargeError
    );
  });

  test("a custom budget is honored", () => {
    expect(() => assertTextBodyWithinBudget("12345", "text/plain", 4)).toThrow(
      InlineBodyTooLargeError
    );
    expect(() =>
      assertTextBodyWithinBudget("1234", "text/plain", 4)
    ).not.toThrow();
  });

  function makeGateway(): { db: VaultDb; gw: Gateway; owner: Credential } {
    const db = openVaultDb();
    const boot = bootstrapVault(db, { ownerName: "Priya" });
    const gw = createGateway(db);
    registerKnowledgeCommands(gw);
    registerSocialCommands(gw);
    const owner: Credential = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
    return { db, gw, owner };
  }

  test("knowledge.create_note refuses an oversized body through the real command pipeline", () => {
    const { gw, owner } = makeGateway();
    const outcome = gw.invoke(owner, {
      command: "knowledge.create_note",
      input: {
        title: "Huge",
        body_text: "z".repeat(INLINE_BODY_BUDGET_BYTES + 1),
      },
    });
    expect(outcome.status).toBe("failed");
    expect((outcome as { reason: string }).reason).toMatch(
      /inline .* body is/u
    );
  });

  test("knowledge.create_note accepts a body at the budget", () => {
    const { gw, owner } = makeGateway();
    const outcome = gw.invoke(owner, {
      command: "knowledge.create_note",
      input: { title: "Fits", body_text: "z".repeat(INLINE_BODY_BUDGET_BYTES) },
    });
    expect(outcome.status).toBe("executed");
  });

  test("social.draft_message refuses an oversized body", () => {
    const { db, gw, owner } = makeGateway();
    const now = new Date().toISOString();
    db.vault
      .prepare(
        `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
       VALUES ('p2', 'person', 'Other', ?, ?)`
      )
      .run(now, now);
    const other = { party_id: "p2" };
    const outcome = gw.invoke(owner, {
      command: "social.draft_message",
      input: {
        recipient_party_id: other.party_id,
        body_text: "w".repeat(INLINE_BODY_BUDGET_BYTES + 1),
      },
    });
    expect(outcome.status).toBe("failed");
    expect((outcome as { reason: string }).reason).toMatch(
      /inline .* body is/u
    );
  });

  test("scanInlineBodyViolations finds pre-existing oversized inline bodies and attributes them by entity", () => {
    const db = openVaultDb();
    bootstrapVault(db, { ownerName: "Priya" });
    // Write directly, bypassing the guard, to simulate rows written before it
    // shipped — exactly what the diagnostics scan exists to surface.
    const bigText = "q".repeat(INLINE_BODY_BUDGET_BYTES + 500);
    const contentId = "content-1";
    db.vault
      .prepare(
        `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, title, language, creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
       VALUES (?, 'text/plain', ?, 'deadbeef', ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)`
      )
      .run(
        contentId,
        `data:text/plain;charset=utf-8,${encodeURIComponent(bigText)}`,
        Buffer.byteLength(bigText, "utf8"),
        new Date().toISOString()
      );
    db.vault
      .prepare(
        `INSERT INTO knowledge_note (note_id, author_party_id, title, body_content_id, format, pinned, created_at, updated_at)
       VALUES ('note-1', (SELECT self_party_id FROM core_vault LIMIT 1), 'Legacy', ?, 'plain', 0, ?, ?)`
      )
      .run(contentId, new Date().toISOString(), new Date().toISOString());

    const scan = scanInlineBodyViolations(db.vault);
    expect(scan.total).toStrictEqual({
      count: 1,
      bytes: Buffer.byteLength(bigText, "utf8"),
    });
    expect(scan.byEntity).toStrictEqual([
      {
        entity: "knowledge.note",
        count: 1,
        bytes: Buffer.byteLength(bigText, "utf8"),
      },
    ]);
  });

  test("scanInlineBodyViolations reports zero violations on a fresh vault", () => {
    const db = openVaultDb();
    bootstrapVault(db, { ownerName: "Priya" });
    const scan = scanInlineBodyViolations(db.vault);
    expect(scan.total).toStrictEqual({ count: 0, bytes: 0 });
    expect(scan.byEntity).toStrictEqual([]);
  });
});
