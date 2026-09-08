import { assert, beforeEach, describe, expect, test } from "vitest";

import { bootstrapVault, enrollAgent, enrollDevice } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import type { Gateway } from "../gateway/gateway.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential, InvokeOutcome } from "../gateway/types.js";
import { answerScopes } from "../grant/automation-principal.test-fixtures.js";
import { uuidv7 } from "../ids.js";
import { registerLinkCommands } from "./links.js";
import { registerPeopleCommands } from "./people.js";
import { registerSocialCommands } from "./social.js";

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;
let raviId: string;

describe("social", () => {
  beforeEach(() => {
    db = openVaultDb();
    boot = bootstrapVault(db, { ownerName: "Priya" });
    gw = createGateway(db);
    registerSocialCommands(gw);
    registerPeopleCommands(gw);
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
    raviId = uuidv7();
    const now = new Date().toISOString();
    db.vault
      .prepare(
        `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
       VALUES (?, 'person', 'Ravi Kumar', ?, ?)`
      )
      .run(raviId, now, now);
    db.vault
      .prepare(
        `INSERT INTO people_profile
           (profile_id, party_id, cadence_days, created_at, updated_at)
         VALUES (?, ?, 30, ?, ?)`
      )
      .run(uuidv7(), raviId, now, now);
  });

  function draft(body = "Invoice attached — due in 14 days."): {
    messageId: string;
    threadId: string;
  } {
    const outcome = gw.invoke(owner, {
      command: "social.draft_message",
      input: {
        body_text: body,
        recipient_party_id: raviId,
        channel: "email",
        subject: "Invoice 2026-014",
      },
    });
    if (outcome.status !== "executed")
      throw new Error(`draft failed: ${JSON.stringify(outcome)}`);
    const output = outcome.output as { message_id: string; thread_id: string };
    return { messageId: output.message_id, threadId: output.thread_id };
  }

  test("draft_message opens a thread with both participants and a draft-state message", () => {
    const { messageId, threadId } = draft();
    const message = db.vault
      .prepare(
        "SELECT delivery, sender_party_id FROM social_message WHERE message_id = ?"
      )
      .get(messageId);
    expect(message).toMatchObject({
      delivery: "draft",
      sender_party_id: boot.ownerPartyId,
    });
    const participants = db.vault
      .prepare(
        "SELECT count(*) AS n FROM social_thread_participant WHERE thread_id = ?"
      )
      .get(threadId) as { n: number };
    expect(participants.n).toBe(2);
  });

  test("identical draft bodies dedupe onto one content_item (P2: sha256 identity)", () => {
    const first = draft("same words");
    const second = draft("same words");
    const firstBody = db.vault
      .prepare(
        "SELECT body_content_id FROM social_message WHERE message_id = ?"
      )
      .get(first.messageId) as { body_content_id: string };
    const secondBody = db.vault
      .prepare(
        "SELECT body_content_id FROM social_message WHERE message_id = ?"
      )
      .get(second.messageId) as { body_content_id: string };
    expect(secondBody.body_content_id).toBe(firstBody.body_content_id);
  });

  test("send_message: owner sends directly; draft → sent; thread last_message_at set", () => {
    const { messageId, threadId } = draft();
    const outcome = gw.invoke(owner, {
      command: "social.send_message",
      input: { message_id: messageId },
    });
    expect(outcome.status).toBe("executed");
    const message = db.vault
      .prepare("SELECT delivery FROM social_message WHERE message_id = ?")
      .get(messageId);
    expect(message).toMatchObject({ delivery: "sent" });
    const thread = db.vault
      .prepare("SELECT last_message_at FROM social_thread WHERE thread_id = ?")
      .get(threadId) as { last_message_at: string | null };
    expect(thread.last_message_at).not.toBeNull();
  });

  test("send_message refuses a non-draft (state machine holds)", () => {
    const { messageId } = draft();
    gw.invoke(owner, {
      command: "social.send_message",
      input: { message_id: messageId },
    });
    const again = gw.invoke(owner, {
      command: "social.send_message",
      input: { message_id: messageId },
    });
    expect(again.status).toBe("failed");
    assert(again.status === "failed");
    expect(again.predicate).toContain("message_is_draft");
  });

  test("agent send parks (risk=high > medium ceiling); owner approval releases it", () => {
    const { messageId } = draft();
    const agent = enrollAgent(db, { name: "assistant", modelRef: "model-x" });
    const device = enrollDevice(db, boot.ownerPartyId, "agent-host");
    answerScopes(db, boot, "assistant", [
      { schema: "social", verbs: "read+act" },
    ]);
    const cred: Credential = {
      kind: "agent",
      agentId: agent.agentId,
      deviceId: device.deviceId,
      deviceKey: device.deviceKey,
    };
    const parked: InvokeOutcome = gw.invoke(cred, {
      command: "social.send_message",
      input: { message_id: messageId },
    });
    expect(parked.status).toBe("parked");
    if (parked.status !== "parked") return;
    const still = db.vault
      .prepare("SELECT delivery FROM social_message WHERE message_id = ?")
      .get(messageId);
    expect(still).toMatchObject({ delivery: "draft" });
    const released = gw.confirm(owner, parked.invocationId, true);
    expect(released.status).toBe("executed");
    const sent = db.vault
      .prepare("SELECT delivery FROM social_message WHERE message_id = ?")
      .get(messageId);
    expect(sent).toMatchObject({ delivery: "sent" });
  });

  test("resolve_identity binds a handle and backfills unresolved participants and senders", () => {
    const threadId = uuidv7();
    const now = new Date().toISOString();
    db.vault
      .prepare(
        `INSERT INTO social_thread (thread_id, channel, created_at) VALUES (?, 'email', ?)`
      )
      .run(threadId, now);
    db.vault
      .prepare(
        `INSERT INTO social_thread_participant (tp_id, thread_id, party_id, handle, muted)
       VALUES (?, ?, NULL, 'ravi@example.com', 0)`
      )
      .run(uuidv7(), threadId);
    const contentId = uuidv7();
    db.vault
      .prepare(
        `INSERT INTO core_content_item (content_id, media_type, content_uri, sha256, byte_size, created_at)
       VALUES (?, 'text/plain', 'file:///m1', 'aa11', 5, ?)`
      )
      .run(contentId, now);
    db.vault
      .prepare(
        `INSERT INTO social_message (message_id, thread_id, sender_party_id, sender_handle, sent_at, body_content_id, delivery)
       VALUES (?, ?, NULL, 'ravi@example.com', ?, ?, 'delivered')`
      )
      .run(uuidv7(), threadId, now, contentId);

    const outcome = gw.invoke(owner, {
      command: "social.resolve_identity",
      input: { party_id: raviId, scheme: "email", value: "ravi@example.com" },
    });
    expect(outcome.status).toBe("executed");
    if (outcome.status !== "executed") return;
    expect(outcome.output).toMatchObject({
      participants_resolved: 1,
      messages_resolved: 1,
    });
    const message = db.vault
      .prepare(
        "SELECT sender_party_id, sender_handle FROM social_message WHERE thread_id = ?"
      )
      .get(threadId);
    // The raw handle stays for audit.
    expect(message).toMatchObject({
      sender_party_id: raviId,
      sender_handle: "ravi@example.com",
    });
  });

  test("resolve_identity refuses a handle claimed by a different party (no identity forks)", () => {
    gw.invoke(owner, {
      command: "social.resolve_identity",
      input: { party_id: raviId, scheme: "email", value: "ravi@example.com" },
    });
    const other = uuidv7();
    const now = new Date().toISOString();
    db.vault
      .prepare(
        `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
       VALUES (?, 'person', 'Impostor', ?, ?)`
      )
      .run(other, now, now);
    const outcome = gw.invoke(owner, {
      command: "social.resolve_identity",
      input: { party_id: other, scheme: "email", value: "ravi@example.com" },
    });
    expect(outcome.status).toBe("failed");
    assert(outcome.status === "failed");
    expect(outcome.predicate).toContain("handle_not_claimed_elsewhere");
  });

  /** Starred flags-scheme tag rows on a target (#274). */
  function starredTags(targetType: string, targetId: string) {
    return db.vault
      .prepare(
        `SELECT t.tagged_by_party_id FROM core_tag t
         JOIN core_concept c ON c.concept_id = t.concept_id
         JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
        WHERE t.target_type = ? AND t.target_id = ?
          AND s.uri = 'https://centraid.dev/schemes/flags' AND c.notation = 'starred'`
      )
      .all(targetType, targetId) as { tagged_by_party_id: string | null }[];
  }

  test("the card's display facts are the profile's, and identity is untouched", () => {
    const edit = gw.invoke(owner, {
      command: "people.edit_person",
      input: { party_id: raviId, nickname: "Rav" },
    });
    expect(edit.status).toBe("executed");
    expect(
      gw.invoke(owner, {
        command: "people.star_person",
        input: { party_id: raviId },
      }).status
    ).toBe("executed");
    expect(
      gw.invoke(owner, {
        command: "people.add_note",
        input: { party_id: raviId, text: "met at the wedding" },
      }).status
    ).toBe("executed");
    // The nickname is a `people_profile` column.
    expect(
      db.vault
        .prepare("SELECT nickname FROM people_profile WHERE party_id = ?")
        .get(raviId)
    ).toMatchObject({ nickname: "Rav" });
    // The note is a memo annotation on the canonical party…
    const memo = db.vault
      .prepare(
        `SELECT body_text, author_party_id FROM knowledge_annotation
        WHERE target_type = 'core.party' AND target_id = ?`
      )
      .get(raviId) as { body_text: string; author_party_id: string };
    expect(memo).toMatchObject({
      body_text: "met at the wedding",
      author_party_id: boot.ownerPartyId,
    });
    // …and the favourite a starred tag.
    expect(starredTags("core.party", raviId)).toHaveLength(1);
    expect(
      db.vault
        .prepare("SELECT display_name FROM core_party WHERE party_id = ?")
        .get(raviId)
    ).toMatchObject({ display_name: "Ravi Kumar" });
  });

  test("favorite is one starred tag on the party: re-star stays single, unstar removes it", () => {
    const setFavorite = (favorite: number) =>
      gw.invoke(owner, {
        command: favorite === 1 ? "people.star_person" : "people.unstar_person",
        input: { party_id: raviId },
      });
    expect(setFavorite(1).status).toBe("executed");
    expect(setFavorite(1).status).toBe("executed");
    const tags = starredTags("core.party", raviId);
    expect(tags).toHaveLength(1);
    // Provenance a boolean column never carried.
    expect(tags[0]?.tagged_by_party_id).toBe(boot.ownerPartyId);
    expect(setFavorite(0).status).toBe("executed");
    expect(starredTags("core.party", raviId)).toHaveLength(0);
  });

  test("a self-thread (note to self) drafts with one participant and sends", () => {
    const outcome = gw.invoke(owner, {
      command: "social.draft_message",
      input: {
        body_text: "Buy stamps before Friday.",
        recipient_party_id: boot.ownerPartyId,
        channel: "dm",
      },
    });
    expect(outcome.status).toBe("executed");
    const output = (
      outcome as { output: { message_id: string; thread_id: string } }
    ).output;
    // The owner appears once, not a UNIQUE collision.
    const participants = db.vault
      .prepare(
        "SELECT party_id FROM social_thread_participant WHERE thread_id = ?"
      )
      .all(output.thread_id) as { party_id: string }[];
    expect(participants.map((row) => ({ ...row }))).toStrictEqual([
      { party_id: boot.ownerPartyId },
    ]);
    const sent = gw.invoke(owner, {
      command: "social.send_message",
      input: { message_id: output.message_id },
    });
    expect(sent.status).toBe("executed");
  });

  test("mark_thread_read stamps only the owner cursor and moves it forward", () => {
    const { threadId } = draft();
    const first = gw.invoke(owner, {
      command: "social.mark_thread_read",
      input: { thread_id: threadId, read_at: "2026-07-03T10:00:00Z" },
    });
    expect(first.status).toBe("executed");
    const rows = db.vault
      .prepare(
        "SELECT party_id, last_read_at FROM social_thread_participant WHERE thread_id = ?"
      )
      .all(threadId) as { party_id: string; last_read_at: string | null }[];
    const ravi = rows.find((r) => r.party_id === raviId);
    expect(ravi?.last_read_at ?? null).toBeNull(); // only the owner reads their inbox
    const mine = rows.find((r) => r.party_id !== raviId);
    expect(mine?.last_read_at).toBe("2026-07-03T10:00:00Z");

    const again = gw.invoke(owner, {
      command: "social.mark_thread_read",
      input: { thread_id: threadId, read_at: "2026-07-03T11:30:00Z" },
    });
    expect(again.status).toBe("executed");
    const later = db.vault
      .prepare(
        "SELECT last_read_at FROM social_thread_participant WHERE thread_id = ? AND party_id = ?"
      )
      .get(threadId, mine?.party_id ?? "") as { last_read_at: string };
    expect(later.last_read_at).toBe("2026-07-03T11:30:00Z");

    const ghost = gw.invoke(owner, {
      command: "social.mark_thread_read",
      input: { thread_id: "no-such-thread", read_at: "2026-07-03T10:00:00Z" },
    });
    expect(ghost.status).toBe("failed");
  });

  test("employment is a works-for link with provenance; the card keeps only a display label", () => {
    const orgId = uuidv7();
    const now = new Date().toISOString();
    db.vault
      .prepare(
        `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
       VALUES (?, 'org', 'Acme Studio', ?, ?)`
      )
      .run(orgId, now, now);
    registerLinkCommands(gw);
    // The display label rides the People profile's role line (#883)…
    const card = gw.invoke(owner, {
      command: "people.edit_person",
      input: { party_id: raviId, role: "Design lead, Acme Studio" },
    });
    expect(card.status).toBe("executed");
    const row = db.vault
      .prepare("SELECT role FROM people_profile WHERE party_id = ?")
      .get(raviId) as { role: string };
    expect(row.role).toBe("Design lead, Acme Studio");
    // …while the claim itself is a typed, temporal core.link.
    const link = gw.invoke(owner, {
      command: "core.link_entities",
      input: {
        from_type: "core.party",
        from_id: raviId,
        to_type: "core.party",
        to_id: orgId,
        relation: "works-for",
      },
    });
    expect(link.status).toBe("executed");
    const stored = db.vault
      .prepare(
        `SELECT l.asserted_by, l.valid_to FROM core_link l
         JOIN core_concept c ON c.concept_id = l.relation_concept_id
        WHERE l.from_id = ? AND l.to_id = ? AND c.notation = 'works-for'`
      )
      .get(raviId, orgId) as { asserted_by: string; valid_to: string | null };
    expect(stored).toMatchObject({ asserted_by: "owner", valid_to: null });
  });

  // `people.add_note` keeps a LIST of notes, not one running memo.
});
