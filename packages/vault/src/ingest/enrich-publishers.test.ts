// Enrichment publisher unit tests (#545) — concept notation + ATTRIBUTED contract.

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { uuidv7 } from "../ids.js";
import { conceptKey, conceptNotation } from "./concept-writes.js";
import { ENRICH_PUBLISHERS } from "./enrich-publishers.js";

let db: VaultDb;
let boot: BootstrapResult;

describe("enrich-publishers", () => {
  beforeEach(() => {
    db = openVaultDb();
    boot = bootstrapVault(db, { ownerName: "Priya" });
  });

  afterEach(() => {
    db.close();
  });

  // The slug is DISPLAY NOTATION (#996, R20(d)); `conceptKey` is what selects
  // a concept, and the test below proves the two are no longer the same thing.
  test("conceptNotation lowercases, slugifies, and caps length", () => {
    expect(conceptNotation("Beach Sunset")).toBe("beach-sunset");
    expect(conceptNotation("  Hello___World!! ")).toBe("hello-world");
    expect(conceptNotation("!!!")).toBe("untitled");
    expect(conceptNotation("a".repeat(100))).toHaveLength(64);
  });

  test("ENRICH_PUBLISHERS covers the five derived-data entity types", () => {
    expect(ENRICH_PUBLISHERS.map((p) => p.entityType).sort()).toStrictEqual([
      "core.collection",
      "core.content_item",
      "core.tag",
      "knowledge.annotation",
      "media.face_region",
    ]);
  });

  test("annotation publisher attributes the enricher party and re-derives in place", () => {
    const publisher = ENRICH_PUBLISHERS.find(
      (p) => p.entityType === "knowledge.annotation"
    )!;
    const targetId = boot.ownerPartyId;
    const agentParty = uuidv7();
    const now = new Date().toISOString();
    db.vault
      .prepare(
        `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
       VALUES (?, 'org', 'vision-agent', ?, ?)`
      )
      .run(agentParty, now, now);

    const created = publisher.create(
      db.vault,
      boot.ownerPartyId,
      {
        target_type: "core.party",
        target_id: targetId,
        body: "A warm outdoor portrait",
        author_party_id: agentParty,
      },
      now
    );
    expect(created.entityId.length).toBeGreaterThan(10);
    const row = db.vault
      .prepare(
        `SELECT body_text, author_party_id FROM knowledge_annotation WHERE annotation_id = ?`
      )
      .get(created.entityId) as { body_text: string; author_party_id: string };
    expect(row.body_text).toBe("A warm outdoor portrait");
    expect(row.author_party_id).toBe(agentParty);

    const probed = publisher.probe(db.vault, {
      target_type: "core.party",
      target_id: targetId,
      body: "Updated caption",
      author_party_id: agentParty,
    });
    expect(probed).toMatchObject({
      entityId: created.entityId,
      disposition: "update",
    });
    publisher.update(
      db.vault,
      created.entityId,
      {
        target_type: "core.party",
        target_id: targetId,
        body: "Updated caption",
        author_party_id: agentParty,
      },
      now,
      boot.ownerPartyId
    );
    const updated = db.vault
      .prepare(
        `SELECT body_text FROM knowledge_annotation WHERE annotation_id = ?`
      )
      .get(created.entityId) as { body_text: string };
    expect(updated.body_text).toBe("Updated caption");
  });

  test("tag publisher mints a machine concept and stamps confidence without tagged_by", () => {
    const publisher = ENRICH_PUBLISHERS.find(
      (p) => p.entityType === "core.tag"
    )!;
    const now = new Date().toISOString();
    const created = publisher.create(
      db.vault,
      boot.ownerPartyId,
      {
        target_type: "core.party",
        target_id: boot.ownerPartyId,
        label: "Beach Sunset",
        confidence: 0.91,
      },
      now
    );
    const tag = db.vault
      .prepare(
        `SELECT concept_id, confidence, tagged_by_party_id FROM core_tag WHERE tag_id = ?`
      )
      .get(created.entityId) as {
      concept_id: string;
      confidence: number | null;
      tagged_by_party_id: string | null;
    };
    expect(tag.confidence).toBeCloseTo(0.91);
    expect(tag.tagged_by_party_id).toBeNull();
    const concept = db.vault
      .prepare(
        `SELECT notation, pref_label FROM core_concept WHERE concept_id = ?`
      )
      .get(tag.concept_id) as { notation: string; pref_label: string };
    expect(concept.notation).toBe("beach-sunset");
    expect(concept.pref_label).toBe("Beach Sunset");
  });

  // A CONCEPT'S LABEL IS NOT ITS IDENTITY (#996 wave 0b, ruling R20(d)).
  // The slug strips everything outside [a-z0-9], so every one of these
  // four labels slugged to `untitled` and selected the SAME concept: four
  // animals filed as one idea, on every vault that does not write in Latin
  // script. Driven through the real tag publisher, read through the real
  // concept rows the tag points at.
  test("猫, 犬, कुत्ता and बिल्ली are four concepts, not one", () => {
    const publisher = ENRICH_PUBLISHERS.find(
      (p) => p.entityType === "core.tag"
    )!;
    const now = new Date().toISOString();
    const labels = ["猫", "犬", "कुत्ता", "बिल्ली"];
    const conceptIds = labels.map((label, index) => {
      const created = publisher.create(
        db.vault,
        boot.ownerPartyId,
        {
          target_type: "core.party",
          target_id: boot.ownerPartyId,
          label,
          confidence: 0.5 + index / 100,
        },
        now
      );
      // One tag per (target, concept) — a second tag for the SAME concept
      // would be refused by `core_tag`'s UNIQUE, so four rows landing is
      // itself the proof that four concepts exist.
      const row = db.vault
        .prepare("SELECT concept_id FROM core_tag WHERE tag_id = ?")
        .get(created.entityId) as { concept_id: string };
      return row.concept_id;
    });
    expect(new Set(conceptIds).size).toBe(4);

    const concepts = db.vault
      .prepare(
        `SELECT pref_label, notation, normalized_key FROM core_concept
          WHERE concept_id IN (${conceptIds.map(() => "?").join(", ")})
          ORDER BY notation`
      )
      .all(...conceptIds) as {
      pref_label: string;
      notation: string;
      normalized_key: string | null;
    }[];
    expect(concepts.map((c) => c.pref_label).toSorted()).toStrictEqual(
      labels.toSorted()
    );
    // The KEY is the identity and preserves the script; the slug is a display
    // notation and is allowed to collide, which is why it carries a suffix.
    expect(concepts.map((c) => c.normalized_key).toSorted()).toStrictEqual(
      labels.map((l) => conceptKey(l)).toSorted()
    );
    expect(concepts.map((c) => c.notation)).toStrictEqual([
      "untitled",
      "untitled-2",
      "untitled-3",
      "untitled-4",
    ]);
  });

  test("the same label in the same scheme still selects one concept", () => {
    // The key narrowed identity; it did not stop dedupe. Case and width fold,
    // because NFKC and case-folding are what the key is.
    const publisher = ENRICH_PUBLISHERS.find(
      (p) => p.entityType === "core.tag"
    )!;
    const now = new Date().toISOString();
    const first = publisher.create(
      db.vault,
      boot.ownerPartyId,
      {
        target_type: "core.party",
        target_id: boot.ownerPartyId,
        label: "Beach Sunset",
        confidence: 0.9,
      },
      now
    );
    const firstConcept = (
      db.vault
        .prepare("SELECT concept_id FROM core_tag WHERE tag_id = ?")
        .get(first.entityId) as { concept_id: string }
    ).concept_id;
    const probed = publisher.probe(db.vault, {
      target_type: "core.party",
      target_id: boot.ownerPartyId,
      label: "  beach   sunset ",
      confidence: 0.4,
    });
    expect(probed?.entityId).toBe(first.entityId);
    expect(
      (
        db.vault
          .prepare(
            "SELECT count(*) AS n FROM core_concept WHERE normalized_key = ?"
          )
          .get(conceptKey("Beach Sunset")) as { n: number }
      ).n
    ).toBe(1);
    expect(firstConcept).toBeTruthy();
  });
});
