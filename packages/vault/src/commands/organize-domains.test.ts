import { beforeEach, describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { createGateway } from "../gateway/gateway.js";
import type { Gateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { registerPartyCommands } from "./parties.js";
import { registerPeopleCommands } from "./people.js";
import { convertCurrencyMinor } from "./tally-organize.js";
import { registerTallyCommands } from "./tally.js";

let db: VaultDb;
let gateway: Gateway;
let owner: Credential;
let ownerPartyId: string;

describe("People and Tally organization contracts", () => {
  beforeEach(() => {
    db = openVaultDb();
    const boot = bootstrapVault(db, { ownerName: "Priya" });
    gateway = createGateway(db);
    registerPartyCommands(gateway);
    registerPeopleCommands(gateway);
    registerTallyCommands(gateway);
    ownerPartyId = boot.ownerPartyId;
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
  });

  function invoke(command: string, input: Record<string, unknown>) {
    return gateway.invoke(owner, {
      command,
      input,
      purpose: "dpv:ServiceProvision",
    });
  }

  function addPerson(name: string): string {
    const result = invoke("people.add_person", {
      display_name: name,
      cadence_days: 30,
    });
    expect(result.status).toBe("executed");
    return (result as { output: { party_id: string } }).output.party_id;
  }

  test("normalizes channels, warns on duplicates, and folds via core.merge_party", () => {
    const a = addPerson("Asha Rao");
    const b = addPerson("Asha R.");
    const first = invoke("people.save_contact_channel", {
      party_id: a,
      kind: "email",
      value: " Asha@Example.COM ",
      preferred: true,
      provenance: { source: "vcard", imported_at: "2026-07-29" },
    });
    expect(first.status).toBe("executed");
    expect(first).toMatchObject({
      output: {
        normalized_value: "asha@example.com",
        duplicate_party_ids: [],
      },
    });
    const duplicate = invoke("people.save_contact_channel", {
      party_id: b,
      kind: "email",
      value: "asha@example.com",
    });
    expect(duplicate).toMatchObject({
      status: "executed",
      output: { duplicate_party_ids: [a] },
    });

    // People surface maps source→merged / target→survivor onto the single
    // ontology primitive. Channels re-point (or dedupe on collision); the
    // merged party row is deleted — no soft-tombstone / undo fork.
    const merged = invoke("core.merge_party", {
      survivor_party_id: a,
      merged_party_id: b,
    });
    expect(merged.status).toBe("executed");
    expect(
      db.vault
        .prepare("SELECT 1 AS x FROM core_party WHERE party_id = ?")
        .get(b)
    ).toBeUndefined();
    expect(
      db.vault
        .prepare("SELECT 1 AS x FROM people_profile WHERE party_id = ?")
        .get(b)
    ).toBeUndefined();
    expect(
      db.vault
        .prepare(
          "SELECT normalized_value FROM social_contact_channel WHERE party_id = ?"
        )
        .all(a)
    ).toMatchObject([{ normalized_value: "asha@example.com" }]);
    expect(
      db.vault
        .prepare(
          "SELECT count(*) AS n FROM social_contact_channel WHERE party_id = ?"
        )
        .get(b)
    ).toMatchObject({ n: 0 });
  });

  test("uses fixed-point rates and idempotently materializes monthly expenses", () => {
    expect(convertCurrencyMinor(1000, 1_234_567, 6)).toBe(1235);
    const friend = invoke("tally.add_friend", { name: "Ravi" }) as {
      output: { party_id: string };
    };
    const friendId = friend.output.party_id;
    const group = invoke("tally.create_group", {
      name: "Home",
      icon: "🏠",
      member_ids: [friendId],
    }) as { output: { group_id: string } };
    const groupId = group.output.group_id;
    const template = invoke("tally.save_recurring_expense", {
      group_id: groupId,
      description: "Internet",
      original_amount_minor: 1000,
      original_currency: "EUR",
      settlement_currency: "USD",
      paid_by: ownerPartyId,
      category: "utilities",
      splits: [
        { party_id: ownerPartyId, weight: 1 },
        { party_id: friendId, weight: 1 },
      ],
      rrule: "FREQ=MONTHLY;COUNT=3",
      anchor_start: "2026-01-15T09:00:00.000Z",
      time_zone: "Etc/UTC",
      rate_scaled: 1_200_000,
      rate_scale: 6,
      rate_source: "manual",
      rate_date: "2026-01-15",
    }) as { output: { template_id: string; preview: string } };
    expect(template.output.preview).toBe("Every month, 3 times");

    const input = {
      template_id: template.output.template_id,
      original_start: "2026-02-15T09:00:00.000Z",
    };
    const first = invoke("tally.materialize_recurring_expense", input);
    const second = invoke("tally.materialize_recurring_expense", input);
    expect(first).toMatchObject({
      status: "executed",
      output: { status: "materialized" },
    });
    expect(second).toMatchObject({
      status: "executed",
      output: { status: "existing" },
    });
    expect(
      db.vault
        .prepare(
          `SELECT amount_minor, original_amount_minor, original_currency,
                  settlement_currency, rate_source
             FROM tally_expense WHERE recurring_template_id = ?`
        )
        .get(template.output.template_id)
    ).toMatchObject({
      amount_minor: 1200,
      original_amount_minor: 1000,
      original_currency: "EUR",
      settlement_currency: "USD",
      rate_source: "manual",
    });

    expect(
      invoke("tally.edit_recurring_expense_occurrence", {
        template_id: template.output.template_id,
        original_start: "2026-03-15T09:00:00.000Z",
        scope: "occurrence",
        action: "skip",
      }).status
    ).toBe("executed");
    expect(
      invoke("tally.materialize_recurring_expense", {
        template_id: template.output.template_id,
        original_start: "2026-03-15T09:00:00.000Z",
      })
    ).toMatchObject({
      status: "executed",
      output: { status: "skipped" },
    });
  });
});
