// EVIDENCE AND ERASURE — the scenarios wave 0e landed (#996, ruling R22).
//
//   1. A CLAIM CARRIES ITS EVIDENCE, AND CLAIMS DISAGREE. Two engine profiles
//      may both say "beach" about one photo; the answer is DERIVED (owner
//      first, then the profile policy points at), never stored as a flag.
//   2. DELETION IS DECLARED BY RELATIONSHIP ROLE. One purge, watched per role:
//      an owned child goes, an attribution survives unattributed, and a
//      participation REFUSES the purge and names what blocked it.

import {
  competingAssertions,
  preferredAssertion,
} from "../../../src/enrich/assertions.js";
import { stampDerivation } from "../../../src/enrich/derivation.js";
import { ENRICH_PUBLISHERS } from "../../../src/ingest/enrich-publishers.js";
import { deletionRoleOf } from "../../../src/schema/deletion-roles.js";
import type {
  ScenarioCheck,
  ScenarioContext,
  ScenarioDefinition,
} from "./types.js";

const tagPublisher = () =>
  ENRICH_PUBLISHERS.find((publisher) => publisher.entityType === "core.tag")!;

/** A stamped derivation, and the id a claim cites it by. */
function derivation(
  ctx: ScenarioContext,
  profile: string,
  model: string
): string {
  stampDerivation(ctx.db.vault, {
    targetType: "core.party",
    targetId: ctx.boot.ownerPartyId,
    variant: "tags",
    capability: "vision",
    profile,
    model,
    now: ctx.clock.nowIso(),
  });
  return ctx.row<{ derivation_id: string }>(
    `SELECT derivation_id FROM enrich_derivation
      WHERE target_type = 'core.party' AND target_id = ?
        AND variant = 'tags' AND profile = ?`,
    ctx.boot.ownerPartyId,
    profile
  )!.derivation_id;
}

/** Trash a person and let the retention window lapse, so the next sweep is the
 *  real purge rather than a scheduled one. */
function trashAndLapse(ctx: ScenarioContext, partyId: string): void {
  ctx.db.vault
    .prepare(
      `UPDATE people_profile SET deleted_at = '2020-01-01T00:00:00Z',
          purge_at = '2020-01-02T00:00:00Z' WHERE party_id = ?`
    )
    .run(partyId);
}

export const EVIDENCE_SCENARIOS: readonly ScenarioDefinition[] = [
  {
    id: "R22/two-engines-may-disagree",
    drift: "R22",
    title: "competing machine claims, and the owner's assertion above them",
    surfaces: ["Photos — the tag row", "Photos — why this tag"],
    run(ctx): ScenarioCheck[] {
      const target = {
        targetType: "core.party",
        targetId: ctx.boot.ownerPartyId,
      };
      const builtIn = derivation(ctx, "built-in", "vision@1");
      const acme = derivation(ctx, "acme", "acme-vision@3");
      const claim = (confidence: number, derivationId: string): void => {
        tagPublisher().create(
          ctx.db.vault,
          ctx.boot.ownerPartyId,
          {
            target_type: "core.party",
            target_id: ctx.boot.ownerPartyId,
            label: "Beach",
            confidence,
            derivation_id: derivationId,
          },
          ctx.clock.nowIso()
        );
      };
      claim(0.6, builtIn);
      // More sure, and not the profile the member's policy points at.
      claim(0.9, acme);
      // Narrowed to the concept this scenario is about: the vault is shared,
      // and other scenarios have claimed other concepts about the same party.
      const conceptId = ctx.row<{ concept_id: string }>(
        "SELECT concept_id FROM core_concept WHERE pref_label = 'Beach'"
      )!.concept_id;
      const competing = competingAssertions(ctx.db.vault, {
        ...target,
        conceptId,
      });
      const byDefault = preferredAssertion(ctx.db.vault, {
        ...target,
        conceptId,
      });
      const byPolicy = preferredAssertion(ctx.db.vault, {
        ...target,
        conceptId,
        preferredProfile: "acme",
      });
      // The owner says so herself; nothing about the machines' rows changes.
      ctx.db.vault
        .prepare(
          `INSERT INTO core_tag
             (tag_id, target_type, target_id, concept_id, tagged_by_party_id,
              confidence, tagged_at)
           VALUES ('owner-tag', 'core.party', ?, ?, ?, 1.0, ?)`
        )
        .run(
          ctx.boot.ownerPartyId,
          conceptId,
          ctx.boot.ownerPartyId,
          ctx.clock.nowIso()
        );
      const afterOwner = preferredAssertion(ctx.db.vault, {
        ...target,
        conceptId,
      });
      const stillCompeting = competingAssertions(ctx.db.vault, {
        ...target,
        conceptId,
      });
      return [
        {
          claim: "both engines' claims are rows, each with its own evidence",
          actual: competing.map((assertion) => [
            assertion.profile,
            assertion.model,
            assertion.confidence,
          ]),
          expected: [
            ["built-in", "vision@1", 0.6],
            ["acme", "acme-vision@3", 0.9],
          ],
        },
        {
          claim: "the preferred claim follows policy, not the bigger number",
          actual: [byDefault?.profile, byPolicy?.profile],
          expected: ["built-in", "acme"],
        },
        {
          claim: "the owner's own assertion is the answer",
          actual: [
            afterOwner?.assertedByPartyId,
            afterOwner?.derivationId,
            stillCompeting.length,
          ],
          expected: [ctx.boot.ownerPartyId, null, 3],
        },
      ];
    },
  },
  {
    id: "R22/deletion-by-relationship-role",
    drift: "R22",
    title: "one purge, and each role behaves as its declaration says",
    surfaces: ["People — delete a person", "Photos — the library after"],
    run(ctx): ScenarioCheck[] {
      const person = (name: string): string =>
        ctx.execute<{ party_id: string }>("people.add_person", {
          display_name: name,
          cadence_days: 0,
        }).party_id;

      // (a) owned children + (b) an attribution.
      const mira = person("Mira");
      ctx.execute("people.add_important_date", {
        party_id: mira,
        label: "birthday",
        month_day: "03-01",
      });
      ctx.db.vault
        .prepare(
          `INSERT INTO core_content_item
             (content_id, content_uri, sha256, byte_size, creator_party_id, created_at)
           VALUES ('mira-bytes', 'file:///mira', ?, 4, ?, ?)`
        )
        .run("11".repeat(32), mira, ctx.clock.nowIso());

      // (c) a participation, which must REFUSE the purge and say by what.
      const ravi = person("Ravi");
      ctx.db.vault
        .prepare(
          `INSERT INTO schedule_calendar
             (calendar_id, owner_party_id, name, default_tz, visibility, created_at)
           VALUES ('cal-ravi', ?, 'Ravi', 'Etc/UTC', 'private', ?)`
        )
        .run(ravi, ctx.clock.nowIso());

      trashAndLapse(ctx, mira);
      trashAndLapse(ctx, ravi);
      const swept = ctx.gateway.sweep(ctx.owner);

      const dates = ctx.row<{ n: number }>(
        "SELECT count(*) AS n FROM people_important_date WHERE party_id = ?",
        mira
      )!;
      const bytes = ctx.row<{ creator_party_id: string | null }>(
        "SELECT creator_party_id FROM core_content_item WHERE content_id = 'mira-bytes'"
      );
      const refusal = swept.skipped.find(
        (skip) => skip.entity === "people.profile"
      );
      const raviLeft = ctx.row<{ n: number }>(
        "SELECT count(*) AS n FROM core_party WHERE party_id = ?",
        ravi
      )!;
      return [
        {
          claim: "an owned child goes with its parent",
          actual: [
            dates.n,
            ctx.row<{ n: number }>(
              "SELECT count(*) AS n FROM core_party WHERE party_id = ?",
              mira
            )!.n,
          ],
          expected: [0, 0],
        },
        {
          claim: "an attribution survives, unattributed",
          actual: [
            bytes === undefined ? "gone" : "kept",
            bytes?.creator_party_id,
          ],
          expected: ["kept", null],
        },
        {
          claim: "a participation refuses the purge and names what blocked it",
          actual: [
            refusal !== undefined,
            refusal?.reason.includes("schedule_calendar") ?? false,
            raviLeft.n,
          ],
          expected: [true, true, 1],
        },
        {
          claim: "each of those references carries its role in the census",
          actual: [
            deletionRoleOf("people_important_date", "party_id")?.role,
            deletionRoleOf("core_content_item", "creator_party_id")?.role,
            deletionRoleOf("schedule_calendar", "owner_party_id")?.role,
          ],
          expected: ["owned-child", "attribution", "participation"],
        },
      ];
    },
  },
];
