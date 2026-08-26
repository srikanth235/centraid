// Enrichment publisher unit tests (#545) — tagNotation + ATTRIBUTED contract.

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { uuidv7 } from "../ids.js";
import { ENRICH_PUBLISHERS, tagNotation } from "./enrich-publishers.js";

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

  test("tagNotation lowercases, slugifies, and caps length", () => {
    expect(tagNotation("Beach Sunset")).toBe("beach-sunset");
    expect(tagNotation("  Hello___World!! ")).toBe("hello-world");
    expect(tagNotation("!!!")).toBe("untitled");
    expect(tagNotation("a".repeat(100))).toHaveLength(64);
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
        `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at, ontology_version)
       VALUES (?, 'org', 'vision-agent', ?, ?, '1.4')`
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
});
