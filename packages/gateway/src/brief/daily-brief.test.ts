import { afterEach, describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";
import { bootstrapVault, openVaultDb, uuidv7 } from "@centraid/vault";

import { buildDailyBrief } from "./daily-brief.js";

const open = [] as ReturnType<typeof openVaultDb>[];

describe("daily brief", () => {
  afterEach(() => {
    while (open.length) open.pop()?.close();
  });

  test("combines events, due tasks, photos, and the owner's Tally stance", () => {
    const dir = tempDirSync("centraid-daily-brief-");
    const db = openVaultDb({ dir });
    open.push(db);
    const boot = bootstrapVault(db, {
      ownerName: "Priya",
      vaultId: "vault-priya",
    });
    const now = "2026-07-29T00:00:00.000Z";
    db.vault
      .prepare(
        `INSERT INTO core_event
           (event_id, summary, dtstart, dtend, start_tz, rrule, status,
            sequence, created_at, updated_at)
         VALUES (?, 'Standup', '2026-07-29T09:00:00.000Z', NULL, 'UTC',
                 NULL, 'confirmed', 0, ?, ?)`
      )
      .run(uuidv7(), now, now);
    db.vault
      .prepare(
        `INSERT INTO core_event
           (event_id, summary, dtstart, dtend, start_tz, rrule, status,
            recurrence_semantics, sequence, created_at, updated_at)
         VALUES (?, 'Daily review', '2026-07-28T08:00:00.000Z', NULL, 'UTC',
                 'FREQ=DAILY;COUNT=3', 'confirmed', 'zoned', 0, ?, ?)`
      )
      .run(uuidv7(), now, now);
    db.vault
      .prepare(
        `INSERT INTO schedule_task
           (task_id, owner_party_id, title, status, priority, due_at)
         VALUES (?, ?, 'Submit report', 'needs-action', 5,
                 '2026-07-29T12:00:00.000Z')`
      )
      .run(uuidv7(), boot.ownerPartyId);
    db.vault
      .prepare(
        `INSERT INTO core_content_item
           (content_id, media_type, content_uri, sha256, byte_size, created_at)
         VALUES (?, 'image/jpeg', 'data:image/jpeg;base64,AA==', ?, 1, ?)`
      )
      .run(uuidv7(), "a".repeat(64), now);
    const content = db.vault
      .prepare("SELECT content_id FROM core_content_item LIMIT 1")
      .get() as { content_id: string };
    db.vault
      .prepare(
        `INSERT INTO media_media_asset
           (asset_id, content_id, kind, captured_at, favorite)
         VALUES (?, ?, 'photo', '2026-07-29T08:00:00.000Z', 0)`
      )
      .run(uuidv7(), content.content_id);
    const friend = uuidv7();
    db.vault
      .prepare(
        `INSERT INTO core_party
           (party_id, kind, display_name, created_at, updated_at,
            ontology_version)
         VALUES (?, 'person', 'Sid', ?, ?, 'v0')`
      )
      .run(friend, now, now);
    const circle = uuidv7();
    db.vault
      .prepare(
        `INSERT INTO social_circle
           (circle_id, owner_party_id, name, kind)
         VALUES (?, ?, 'Trip', 'friends')`
      )
      .run(circle, boot.ownerPartyId);
    const group = uuidv7();
    db.vault
      .prepare(
        `INSERT INTO tally_group
           (group_id, circle_id, icon, color, created_at)
         VALUES (?, ?, '✈️', '#123456', ?)`
      )
      .run(group, circle, now);
    const expense = uuidv7();
    db.vault
      .prepare(
        `INSERT INTO tally_expense
           (expense_id, group_id, description, amount_minor, paid_by,
            spent_on, category, created_at)
         VALUES (?, ?, 'Taxi', 4000, ?, '2026-07-29', 'transport', ?)`
      )
      .run(expense, group, boot.ownerPartyId, now);
    const split = db.vault.prepare(
      `INSERT INTO tally_expense_split
         (expense_id, party_id, share_minor) VALUES (?, ?, ?)`
    );
    split.run(expense, boot.ownerPartyId, 2000);
    split.run(expense, friend, 2000);

    const brief = buildDailyBrief(db, {
      date: "2026-07-29",
      from: "2026-07-29T00:00:00.000Z",
      to: "2026-07-30T00:00:00.000Z",
      timeZone: "UTC",
    });

    expect(brief).toMatchObject({
      date: "2026-07-29",
      events: [{ title: "Daily review" }, { title: "Standup" }],
      tasks: [{ title: "Submit report" }],
      newPhotos: 1,
      balanceMinor: 2000,
    });
  });
});
