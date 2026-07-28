import { beforeEach, describe, expect, test } from "vitest";

import { bootstrapVault, type BootstrapResult } from "../bootstrap.js";
import { openVaultDb, type VaultDb } from "../db.js";
import { createGateway, Gateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { registerTallyCommands } from "./tally.js";

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;
let me: string;

describe("tally: groups", () => {
  beforeEach(() => {
    db = openVaultDb();
    boot = bootstrapVault(db, { ownerName: "Alex" });
    gw = createGateway(db);
    registerTallyCommands(gw);
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
    me = (
      db.vault
        .prepare("SELECT owner_party_id AS id FROM core_vault LIMIT 1")
        .get() as {
        id: string;
      }
    ).id;
  });

  function invoke(command: string, input: Record<string, unknown>) {
    return gw.invoke(owner, {
      command,
      input,
      purpose: "dpv:ServiceProvision",
    });
  }

  function out<T = Record<string, unknown>>(o: ReturnType<typeof invoke>): T {
    expect(o.status).toBe("executed");
    return (o as { output: T }).output;
  }

  function addFriend(name = "Priya Nair") {
    return out<{ party_id: string }>(invoke("tally.add_friend", { name }))
      .party_id;
  }

  test("a group is a social.circle decoration: name and members on the circle", () => {
    const priya = addFriend();
    const gid = out<{ group_id: string }>(
      invoke("tally.create_group", {
        name: "Goa Trip",
        icon: "🌴",
        member_ids: [priya],
      })
    ).group_id;
    const g = db.vault
      .prepare(
        `SELECT c.name, c.kind, c.owner_party_id FROM tally_group tg JOIN social_circle c ON c.circle_id = tg.circle_id WHERE tg.group_id = ?`
      )
      .get(gid) as { name: string; kind: string; owner_party_id: string };
    expect(g).toMatchObject({
      name: "Goa Trip",
      kind: "custom",
      owner_party_id: me,
    });
    out(invoke("tally.rename_group", { group_id: gid, name: "Goa 2026" }));
    expect(
      (
        db.vault
          .prepare(
            `SELECT c.name FROM tally_group tg JOIN social_circle c ON c.circle_id = tg.circle_id WHERE tg.group_id = ?`
          )
          .get(gid) as { name: string }
      ).name
    ).toBe("Goa 2026");
    expect(
      invoke("tally.create_group", {
        name: "Goa 2026",
        icon: "🌴",
        member_ids: [],
      }).status
    ).toBe("failed");
  });

  test("delete_group removes its circle and membership with it", () => {
    const priya = addFriend();
    const gid = out<{ group_id: string }>(
      invoke("tally.create_group", {
        name: "Temp",
        icon: "📦",
        member_ids: [priya],
      })
    ).group_id;
    const circle = db.vault
      .prepare("SELECT circle_id FROM tally_group WHERE group_id = ?")
      .get(gid) as { circle_id: string };
    out(invoke("tally.delete_group", { group_id: gid }));
    expect(
      (
        db.vault
          .prepare(
            "SELECT count(*) AS n FROM social_circle WHERE circle_id = ?"
          )
          .get(circle.circle_id) as { n: number }
      ).n
    ).toBe(0);
    expect(
      (
        db.vault
          .prepare(
            "SELECT count(*) AS n FROM social_circle_member WHERE circle_id = ?"
          )
          .get(circle.circle_id) as { n: number }
      ).n
    ).toBe(0);
  });

  test("set_expense_memo writes the canonical annotation; empty note clears it (#310 C6)", () => {
    const priya = addFriend();
    const gid = out<{ group_id: string }>(
      invoke("tally.create_group", {
        name: "Apt2",
        icon: "🏠",
        member_ids: [priya],
      })
    ).group_id;
    const xid = out<{ expense_id: string }>(
      invoke("tally.add_expense", {
        group_id: gid,
        description: "Dinner at Olive",
        amount_minor: 400,
        paid_by: me,
        category: "food",
        splits: [
          { party_id: me, share_minor: 200 },
          { party_id: priya, share_minor: 200 },
        ],
      })
    ).expense_id;
    out(
      invoke("tally.set_expense_memo", {
        expense_id: xid,
        note: "Landlord still owes us",
      })
    );
    const memo = db.vault
      .prepare(
        `SELECT body_text FROM knowledge_annotation WHERE target_type = 'tally.expense' AND target_id = ?`
      )
      .get(xid) as { body_text: string } | undefined;
    expect(memo?.body_text).toBe("Landlord still owes us");
    out(invoke("tally.set_expense_memo", { expense_id: xid, note: "" }));
    expect(
      (
        db.vault
          .prepare(
            `SELECT count(*) AS n FROM knowledge_annotation WHERE target_type = 'tally.expense' AND target_id = ?`
          )
          .get(xid) as { n: number }
      ).n
    ).toBe(0);
    expect(
      (
        db.vault
          .prepare(
            `SELECT expense_id FROM fts_tally_expense WHERE fts_tally_expense MATCH 'olive'`
          )
          .get() as { expense_id: string } | undefined
      )?.expense_id
    ).toBe(xid);
  });
});
