/**
 * The DISTRIBUTION half of the golden year-3 vault (#927 P4).
 *
 * `year3-vault.ts` owns the artifact's identity — its version, its profile,
 * its content-addressed cache — and the version-1 row axes every caller has
 * always had. This module owns the seeding that turns those counts into the
 * shape of an owner's third year: notes whose bodies cross the replica's
 * 64 KiB value ceiling, three calendar years of events, the phone's replica
 * volume, automations with durable ledger state, grantees with live bindings
 * and standing authority, and a year of receipts in the audit band.
 *
 * They are two files because they are two concerns and because one file
 * holding both is a god file (`repo-hygiene`, 625-line limit); the seam is the
 * one call `seedYear3Vault` makes when `counts.distributions` is present.
 *
 * Every statement here writes the row the PRODUCT writes, and each block names
 * the writer it mirrors — a fixture row that no command could produce is a
 * fixture lying about the product. `@centraid/test-kit` deliberately does not
 * depend on `@centraid/vault` (the vault devDepends on the kit), so the
 * writers are mirrored rather than imported; the column lists are held honest
 * by `year3-vault.test.ts` running them against a real bootstrapped schema.
 */
import { seededRandom } from "./random.js";
import { YEAR3_NOTE_NEEDLE, YEAR3_NOTE_NEEDLE_INDEX } from "./year3-shape.js";
import type {
  Year3Distributions,
  Year3VaultProfile,
  Year3VaultTarget,
} from "./year3-shape.js";

export interface Year3SeedContext {
  readonly at: (index: number) => string;
  readonly id: (prefix: string, index: number) => string;
  readonly digest: (value: string) => string;
  readonly ownerPartyId: string;
  readonly parties: number;
  readonly photos: number;
}

/** Words the long-note bodies are drawn from; nonsense on purpose, so FTS
 *  matches on a needle are unambiguous. */
const NOTE_WORDS = [
  "aurora",
  "basalt",
  "cinder",
  "dahlia",
  "ember",
  "fathom",
  "glimmer",
  "harbour",
  "indigo",
  "junction",
  "kelvin",
  "lantern",
  "meridian",
  "nocturne",
  "obsidian",
  "pallas",
];

/**
 * The distribution half of the golden vault. Every statement here writes the
 * row the PRODUCT writes, and each block names the writer it mirrors — a
 * fixture row that no command could produce is a fixture lying about the
 * product. `@centraid/test-kit` deliberately does not depend on
 * `@centraid/vault` (see `year3FixtureCacheKey`), so the writers are mirrored
 * rather than imported; the column lists are held honest by
 * `year3-vault.test.ts` running them against a real bootstrapped schema.
 */
export function seedYear3Distributions(
  target: Year3VaultTarget,
  distributions: Year3Distributions,
  profile: Year3VaultProfile,
  context: Year3SeedContext
): void {
  const random = seededRandom(profile.seed);
  const { at, id, digest, ownerPartyId } = context;
  const lastDay = 1_095;
  target.vault.exec("BEGIN IMMEDIATE");

  // ── Notes, with a measured share of bodies over the replica's value ceiling.
  //    Mirrors what `knowledge.create_note` writes: the body is a data: URI on
  //    a `core_content_item` (rent the bytes, own the reference — schema/fts.ts)
  //    and the note row points at it.
  const insertContent = target.vault.prepare(
    `INSERT INTO core_content_item
       (content_id, media_type, content_uri, sha256, byte_size, title,
        created_at)
     VALUES (?, 'text/markdown', ?, ?, ?, ?, ?)`
  );
  const insertNote = target.vault.prepare(
    `INSERT INTO knowledge_note
       (note_id, author_party_id, title, body_content_id, format, pinned,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, 'markdown', ?, ?, ?)`
  );
  for (let index = 0; index < distributions.notes; index += 1) {
    // Evenly spread rather than clustered at the front: `floor(i*share)`
    // steps exactly `round(notes*share)` times across the corpus, so the long
    // bodies land throughout the id range a paged read walks.
    const long =
      Math.floor(index * distributions.longNoteShare) !==
      Math.floor((index + 1) * distributions.longNoteShare);
    const body = long
      ? longNoteBody(
          random.int(
            distributions.longNoteMinBytes,
            distributions.longNoteMaxBytes
          ),
          random
        )
      : `Year 3 note body ${index}`;
    const withNeedle =
      index === YEAR3_NOTE_NEEDLE_INDEX % Math.max(1, distributions.notes)
        ? `${body} ${YEAR3_NOTE_NEEDLE}`
        : body;
    const contentId = id("year3-note-content", index);
    const timestamp = at(index % 1_096);
    insertContent.run(
      contentId,
      `data:text/markdown;base64,${Buffer.from(withNeedle, "utf8").toString("base64")}`,
      digest(contentId),
      Buffer.byteLength(withNeedle),
      `Year 3 note ${index}`,
      timestamp
    );
    insertNote.run(
      id("year3-note", index),
      ownerPartyId,
      `Year 3 note ${index}`,
      contentId,
      index % 50 === 0 ? 1 : 0,
      timestamp,
      timestamp
    );
  }

  // ── Automations with durable ledger state. Mirrors what the automation
  //    runner persists per fire (`packages/server/src/automation/**`): one
  //    state key and one trigger cursor per automation.
  const insertAutomationState = target.vault.prepare(
    `INSERT INTO automation_state (automation_id, key, value_json, updated_at)
     VALUES (?, 'last_fired_at', ?, ?)`
  );
  const insertAutomationCursor = target.vault.prepare(
    `INSERT INTO automation_trigger_cursor
       (automation_id, trigger_index, source_kind, position_json, updated_at)
     VALUES (?, 0, 'schedule', ?, ?)`
  );
  for (let index = 0; index < distributions.automations; index += 1) {
    const automationId = id("year3-automation", index);
    const day = lastDay - (index % distributions.receiptDays);
    const millis = Date.parse(at(day));
    insertAutomationState.run(automationId, JSON.stringify(at(day)), millis);
    insertAutomationCursor.run(
      automationId,
      JSON.stringify({ cursor: day }),
      millis
    );
  }

  // ── Three calendar years of events, one per day. Mirrors what
  //    `schedule.create_event` writes for a confirmed, untimed-zone entry.
  const insertEvent = target.vault.prepare(
    `INSERT INTO core_event
       (event_id, summary, dtstart, start_tz, status, sequence, created_at,
        updated_at)
     VALUES (?, ?, ?, 'UTC', 'confirmed', 0, ?, ?)`
  );
  for (let index = 0; index < distributions.eventDays; index += 1) {
    const timestamp = at(index);
    insertEvent.run(
      id("year3-event", index),
      `Year 3 event ${index}`,
      timestamp,
      timestamp,
      timestamp
    );
  }

  // ── The phone's replica volume, as the rows a phone actually mirrors.
  //    Mirrors `schedule.create_task`: a `needs-action` task owned by the
  //    member. The id scheme is the one the reconnect rig already walks, so
  //    mounting the golden vault leaves its assertions untouched.
  const insertTask = target.vault.prepare(
    `INSERT INTO schedule_task
       (task_id, owner_party_id, title, status, priority, created_at,
        updated_at)
     VALUES (?, ?, ?, 'needs-action', 0, ?, ?)`
  );
  for (let index = 0; index < distributions.replicaRows; index += 1) {
    const timestamp = at(index % 1_096);
    insertTask.run(
      `year3-${String(index).padStart(6, "0")}`,
      ownerPartyId,
      `Year 3 task ${index}`,
      timestamp,
      timestamp
    );
  }

  // ── The circle a grantee is reached through. Mirrors `social.create_circle`
  //    + `tally.create_group`: a tally group IS a circle with a ledger, which
  //    is why it is the one subject type the share registry offers `edit` on
  //    (packages/vault/src/grant/subject-registry.ts).
  const circleId = "year3-circle";
  target.vault
    .prepare(
      `INSERT INTO social_circle
         (circle_id, owner_party_id, name, kind, created_at, updated_at)
       VALUES (?, ?, 'Year 3 household', 'family', ?, ?)`
    )
    .run(circleId, ownerPartyId, at(0), at(0));
  const groupId = "year3-tally-group";
  target.vault
    .prepare(
      `INSERT INTO tally_group
         (group_id, circle_id, icon, color, currency, created_at, updated_at)
       VALUES (?, ?, 'home', '#2f6f4f', 'USD', ?, ?)`
    )
    .run(groupId, circleId, at(0), at(0));

  // ── Grantees: a live party↔vault binding and a standing authority row each.
  //    Mirrors `share/party-vault-binding.ts#bindPartyToVault` (one LIVE vault
  //    per party, `revoked_at` NULL) and `grant/grant-store.ts#createShareGrant`
  //    (principal from the audience kind, `duration 'standing'`, `decision
  //    'granted'`, `granted_by` the answering party, no receipt yet). Ids are
  //    deterministic where the commands mint a uuidv7 — an id is opaque, and a
  //    fixture that is not byte-reproducible is not an artifact.
  const insertBinding = target.vault.prepare(
    `INSERT INTO share_party_vault_binding
       (binding_id, party_id, vault_id, vault_public_key, linked_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, NULL)`
  );
  const insertMember = target.vault.prepare(
    `INSERT INTO social_circle_member
       (member_id, circle_id, party_id, added_at, updated_at, capability)
     VALUES (?, ?, ?, ?, ?, 'read')`
  );
  const insertAuthority = target.vault.prepare(
    `INSERT INTO share_authority
       (authority_id, principal_kind, principal_id, subject_type, subject_id,
        verb, duration, expires_at, decision, granted_at, granted_by,
        revoked_at, receipt_id)
     VALUES (?, ?, ?, ?, ?, ?, 'standing', NULL, 'granted', ?, ?, NULL, NULL)`
  );
  for (let index = 0; index < distributions.grantees; index += 1) {
    // Grantees are drawn from the contact corpus, spread across it, and never
    // land on the search needle's row.
    const partyIndex =
      (index *
        Math.max(1, Math.floor(context.parties / distributions.grantees)) +
        1) %
      Math.max(1, context.parties);
    const partyId = id("year3-party", partyIndex);
    const timestamp = at(lastDay - index);
    insertBinding.run(
      id("year3-binding", index),
      partyId,
      `year3-peer-vault-${index}`,
      digest(`peer-key:${index}`),
      timestamp
    );
    insertMember.run(
      id("year3-circle-member", index),
      circleId,
      partyId,
      timestamp,
      timestamp
    );
    // View over a real photo the library holds — the subject type the registry
    // fulfils by closure reprojection.
    insertAuthority.run(
      id("year3-authority-view", index),
      "person",
      partyId,
      "media.asset",
      id("year3-photo", (index * 97) % Math.max(1, context.photos)),
      "view",
      timestamp,
      ownerPartyId
    );
  }
  for (let index = 0; index < distributions.granteeCircles; index += 1) {
    // The one EDIT answer the vault can honour, held by a CIRCLE principal —
    // the case `core_entity_revoke_on_purge`'s principal clause exists for.
    insertAuthority.run(
      id("year3-authority-edit", index),
      "circle",
      circleId,
      "tally.group",
      groupId,
      "edit",
      at(lastDay - index),
      ownerPartyId
    );
  }

  target.vault.exec("COMMIT");

  // ── A year of receipts in the audit band. `access_receipt` is append-only by
  //    trigger (schema/audit.ts), so this is INSERT-only by construction: what
  //    the gateway writes per allowed or refused call, with `seq` as the chain
  //    position and `hash` the chain link.
  const insertReceipt = target.vault.prepare(
    `INSERT INTO access_receipt
       (receipt_id, grant_id, invocation_id, action, object_type, object_id,
        purpose_concept_id, decision, occurred_at, hash, detail_json, seq)
     VALUES (?, NULL, NULL, ?, ?, ?, NULL, ?, ?, ?, NULL, ?)`
  );
  target.vault.exec("BEGIN IMMEDIATE");
  let previousHash = digest("year3-receipt-chain-genesis");
  for (let index = 0; index < distributions.receiptDays; index += 1) {
    const day = lastDay - (distributions.receiptDays - 1 - index);
    const receiptId = id("year3-receipt", index);
    previousHash = digest(`${previousHash}:${receiptId}`);
    insertReceipt.run(
      receiptId,
      index % 7 === 0 ? "search" : "read",
      "media.asset",
      id("year3-photo", (index * 13) % Math.max(1, context.photos)),
      index % 29 === 0 ? "deny" : "allow",
      at(day),
      previousHash,
      index + 1
    );
  }
  target.vault.exec("COMMIT");
}

/** A deterministic markdown body of at least `bytes` bytes. */
function longNoteBody(
  bytes: number,
  random: { int: (min: number, max: number) => number }
): string {
  const parts: string[] = ["# Year 3 long note", ""];
  let size = 20;
  while (size < bytes) {
    const word = NOTE_WORDS[random.int(0, NOTE_WORDS.length - 1)] ?? "aurora";
    parts.push(word);
    size += word.length + 1;
  }
  return parts.join(" ");
}
