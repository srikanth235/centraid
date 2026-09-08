// MACHINE ASSERTIONS LINK TO THEIR EVIDENCE (#996, ruling R22).
//
// Written through the real enrichment publisher — the one path that files a
// machine tag — and read through `competingAssertions` / `preferredAssertion`,
// which is what a surface uses. Never by asserting on the columns this change
// is about.
//
//   1. TWO ENGINES CAN DISAGREE. `core_tag`'s `UNIQUE (target, concept)` made
//      that unrepresentable: the second profile's claim silently replaced the
//      first, so the disagreement — the thing a member would want to see —
//      could not exist.
//   2. THE ANSWER IS DERIVED. No column says "this is the one". The owner's
//      assertion wins; among machines, the profile policy points at wins, then
//      the built-in engines, then a stable tie-break.
//   3. A CLAIM CARRIES ITS EVIDENCE. Which derivation, which model, which
//      revision of the target it was made about.

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { ENRICH_PUBLISHERS } from "../ingest/enrich-publishers.js";
import type { TagPayload } from "../ingest/enrich-publishers.js";
import {
  competingAssertions,
  preferredAssertion,
  preferredAssertions,
} from "./assertions.js";
import { stampDerivation } from "./derivation.js";

const NOW = "2026-03-01T00:00:00.000Z";

let db: VaultDb;
let boot: BootstrapResult;

const tagPublisher = () =>
  ENRICH_PUBLISHERS.find((publisher) => publisher.entityType === "core.tag")!;

describe("competing machine assertions", () => {
  beforeEach(() => {
    db = openVaultDb();
    boot = bootstrapVault(db, { ownerName: "Priya" });
  });

  afterEach(() => {
    db.close();
  });

  /** A stamped derivation, and the id a claim cites it by. */
  function derivation(profile: string, model: string): string {
    stampDerivation(db.vault, {
      targetType: "core.party",
      targetId: boot.ownerPartyId,
      variant: "tags",
      capability: "vision",
      profile,
      model,
      now: NOW,
    });
    const row = db.vault
      .prepare(
        `SELECT derivation_id FROM enrich_derivation
          WHERE target_type = 'core.party' AND target_id = ?
            AND variant = 'tags' AND profile = ?`
      )
      .get(boot.ownerPartyId, profile) as { derivation_id: string };
    return row.derivation_id;
  }

  function claim(
    payload: Partial<TagPayload> & { confidence: number }
  ): string {
    const created = tagPublisher().create(
      db.vault,
      boot.ownerPartyId,
      {
        target_type: "core.party",
        target_id: boot.ownerPartyId,
        label: "Beach",
        ...payload,
      } as unknown as Record<string, unknown>,
      NOW
    );
    return created.entityId!;
  }

  test("two engine profiles both claim the same concept, with their own confidences", () => {
    const builtIn = derivation("built-in", "vision@1");
    const other = derivation("acme", "acme-vision@3");
    const first = claim({ confidence: 0.6, derivation_id: builtIn });
    const second = claim({ confidence: 0.9, derivation_id: other });
    expect(first).not.toBe(second);

    const all = competingAssertions(db.vault, {
      targetType: "core.party",
      targetId: boot.ownerPartyId,
    });
    expect(all).toHaveLength(2);
    expect(all.map((assertion) => assertion.profile)).toStrictEqual([
      "built-in",
      "acme",
    ]);
    expect(all.map((assertion) => assertion.confidence)).toStrictEqual([
      0.6, 0.9,
    ]);
    expect(all.map((assertion) => assertion.model)).toStrictEqual([
      "vision@1",
      "acme-vision@3",
    ]);
  });

  test("the preferred claim follows POLICY, not the bigger number", () => {
    derivation("built-in", "vision@1");
    const other = derivation("acme", "acme-vision@3");
    claim({
      confidence: 0.6,
      derivation_id: derivation("built-in", "vision@1"),
    });
    claim({ confidence: 0.9, derivation_id: other });
    const conceptId = competingAssertions(db.vault, {
      targetType: "core.party",
      targetId: boot.ownerPartyId,
    })[0]!.conceptId;

    // Default policy: the built-in engines, even though `acme` is more sure.
    expect(
      preferredAssertion(db.vault, {
        targetType: "core.party",
        targetId: boot.ownerPartyId,
        conceptId,
      })?.profile
    ).toBe("built-in");
    // Policy pointed at `acme`: the same rows, a different answer, and no
    // column anywhere changed.
    expect(
      preferredAssertion(db.vault, {
        targetType: "core.party",
        targetId: boot.ownerPartyId,
        conceptId,
        preferredProfile: "acme",
      })?.profile
    ).toBe("acme");
  });

  test("the owner's own assertion is the answer, and the machine's sits beside it", () => {
    const built = derivation("built-in", "vision@1");
    claim({ confidence: 0.95, derivation_id: built });
    const conceptId = competingAssertions(db.vault, {
      targetType: "core.party",
      targetId: boot.ownerPartyId,
    })[0]!.conceptId;
    db.vault
      .prepare(
        `INSERT INTO core_tag
           (tag_id, target_type, target_id, concept_id, tagged_by_party_id,
            confidence, tagged_at)
         VALUES ('owner-tag', 'core.party', ?, ?, ?, 1.0, ?)`
      )
      .run(boot.ownerPartyId, conceptId, boot.ownerPartyId, NOW);

    const preferred = preferredAssertion(db.vault, {
      targetType: "core.party",
      targetId: boot.ownerPartyId,
      conceptId,
    });
    expect(preferred?.assertedByPartyId).toBe(boot.ownerPartyId);
    expect(preferred?.derivationId).toBeNull();
    // The machine's claim did not go anywhere.
    expect(
      competingAssertions(db.vault, {
        targetType: "core.party",
        targetId: boot.ownerPartyId,
        conceptId,
      })
    ).toHaveLength(2);
  });

  test("an owner's tag may not cite a model", () => {
    const built = derivation("built-in", "vision@1");
    expect(() =>
      db.vault
        .prepare(
          `INSERT INTO core_tag
             (tag_id, target_type, target_id, concept_id, tagged_by_party_id,
              confidence, derivation_id, tagged_at)
           VALUES ('bad-tag', 'core.party', ?, ?, ?, 1.0, ?, ?)`
        )
        .run(
          boot.ownerPartyId,
          // Any concept the vault already holds.
          (
            db.vault
              .prepare("SELECT concept_id FROM core_concept LIMIT 1")
              .get() as { concept_id: string }
          ).concept_id,
          boot.ownerPartyId,
          built,
          NOW
        )
    ).toThrow(/CHECK constraint failed/u);
  });

  test("re-running one profile refreshes its own claim, never the other's", () => {
    const builtIn = derivation("built-in", "vision@1");
    const other = derivation("acme", "acme-vision@3");
    claim({ confidence: 0.6, derivation_id: builtIn });
    claim({ confidence: 0.9, derivation_id: other });
    const publisher = tagPublisher();
    const payload = {
      target_type: "core.party",
      target_id: boot.ownerPartyId,
      label: "Beach",
      confidence: 0.7,
      derivation_id: builtIn,
    } as unknown as Record<string, unknown>;
    const probed = publisher.probe(db.vault, payload);
    expect(probed?.disposition).toBe("update");
    publisher.update(
      db.vault,
      probed!.entityId,
      payload,
      NOW,
      boot.ownerPartyId
    );

    const all = competingAssertions(db.vault, {
      targetType: "core.party",
      targetId: boot.ownerPartyId,
    });
    expect(all).toHaveLength(2);
    expect(
      all.find((assertion) => assertion.profile === "built-in")?.confidence
    ).toBe(0.7);
    expect(
      all.find((assertion) => assertion.profile === "acme")?.confidence
    ).toBe(0.9);
  });

  test("a claim names the revision of the target it was made about", () => {
    const builtIn = derivation("built-in", "vision@1");
    db.vault
      .prepare(
        `INSERT INTO core_entity_revision
           (revision_id, entity_type, entity_id, operation, snapshot_json,
            recorded_at, undo_until)
         VALUES ('rev-1', 'core.party', ?, 'update', '{}', ?, ?)`
      )
      .run(boot.ownerPartyId, NOW, NOW);
    claim({
      confidence: 0.8,
      derivation_id: builtIn,
      input_revision_id: "rev-1",
    });
    const [assertion] = preferredAssertions(db.vault, {
      targetType: "core.party",
      targetId: boot.ownerPartyId,
    });
    expect(assertion?.inputRevisionId).toBe("rev-1");
    expect(assertion?.derivationId).toBe(builtIn);
    expect(assertion?.model).toBe("vision@1");
  });
});
