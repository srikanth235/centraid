import { beforeEach, describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import type { Gateway } from "../gateway/gateway.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { registerTallyCommands } from "./tally.js";

let db: VaultDb;
let gateway: Gateway;
let owner: Credential;
let ownerPartyId: string;

describe("Tally receipt capture", () => {
  beforeEach(() => {
    db = openVaultDb();
    const boot = bootstrapVault(db, { ownerName: "Alex" });
    gateway = createGateway(db);
    registerTallyCommands(gateway);
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
    ownerPartyId = (
      db.vault
        .prepare("SELECT owner_party_id AS id FROM core_vault LIMIT 1")
        .get() as { id: string }
    ).id;
  });

  function invoke(command: string, input: Record<string, unknown>) {
    return gateway.invoke(owner, {
      command,
      input,
      purpose: "dpv:ServiceProvision",
    });
  }

  function output<T>(result: ReturnType<typeof invoke>): T {
    expect(result.status).toBe("executed");
    return (result as { output: T }).output;
  }

  test("claims canonical bytes and persists allocated reviewed OCR lines", () => {
    const friendId = output<{ party_id: string }>(
      invoke("tally.add_friend", { name: "Priya Nair" })
    ).party_id;
    const groupId = output<{ group_id: string }>(
      invoke("tally.create_group", {
        name: "Dinner",
        icon: "🍽️",
        member_ids: [friendId],
      })
    ).group_id;
    const staged = gateway.stageBlob(owner, {
      bytes: Buffer.from("receipt image"),
      filename: "receipt.jpg",
      mediaType: "image/jpeg",
    });
    const created = output<{
      expense_id: string;
      receipt_id: string;
      content_id: string;
    }>(
      invoke("tally.add_receipt_expense", {
        group_id: groupId,
        description: "Dinner",
        amount_minor: 1_200,
        paid_by: ownerPartyId,
        category: "food",
        staged_sha: staged.sha256,
        ocr_text: "Pasta 10.00\nTax 2.00\nTotal 12.00",
        splits: [
          { party_id: ownerPartyId, share_minor: 600 },
          { party_id: friendId, share_minor: 600 },
        ],
        line_items: [
          {
            kind: "item",
            description: "Pasta",
            amount_minor: 1_000,
            allocations: [
              { party_id: ownerPartyId, share_minor: 500 },
              { party_id: friendId, share_minor: 500 },
            ],
          },
          {
            kind: "tax",
            description: "Tax",
            amount_minor: 200,
            allocations: [
              { party_id: ownerPartyId, share_minor: 100 },
              { party_id: friendId, share_minor: 100 },
            ],
          },
        ],
      })
    );
    expect(
      db.vault
        .prepare(
          `SELECT target_id, content_id, role, is_primary FROM core_attachment
            WHERE attachment_id = ?`
        )
        .get(created.receipt_id)
    ).toMatchObject({
      target_id: created.expense_id,
      content_id: created.content_id,
      role: "receipt",
      is_primary: 1,
    });
    expect(
      db.vault
        .prepare(
          `SELECT count(*) AS n FROM core_attachment
            WHERE target_type = 'tally.expense' AND target_id = ?`
        )
        .get(created.expense_id)
    ).toMatchObject({ n: 1 });
    expect(
      db.vault
        .prepare(
          `SELECT text_content FROM core_content_derivative
            WHERE content_id = ? AND variant = 'text'`
        )
        .get(created.content_id)
    ).toMatchObject({
      text_content: "Pasta 10.00\nTax 2.00\nTotal 12.00",
    });
    expect(
      (
        db.vault
          .prepare(
            `SELECT count(*) AS n FROM tally_expense_line_allocation a
              JOIN tally_expense_line_item l
                ON l.line_item_id = a.line_item_id
             WHERE l.receipt_id = ?`
          )
          .get(created.receipt_id) as { n: number }
      ).n
    ).toBe(4);

    const bad = gateway.stageBlob(owner, {
      bytes: Buffer.from("bad receipt"),
      filename: "bad.jpg",
      mediaType: "image/jpeg",
    });
    expect(
      invoke("tally.add_receipt_expense", {
        group_id: groupId,
        description: "Bad total",
        amount_minor: 1_200,
        paid_by: ownerPartyId,
        category: "food",
        staged_sha: bad.sha256,
        ocr_text: "Only 10.00",
        splits: [{ party_id: ownerPartyId, share_minor: 1_200 }],
        line_items: [
          {
            kind: "item",
            description: "Only",
            amount_minor: 1_000,
            allocations: [{ party_id: ownerPartyId, share_minor: 1_000 }],
          },
        ],
      }).status
    ).toBe("failed");
  });
});
