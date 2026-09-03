import { describe, expect, test } from "vitest";

import {
  ATLAS_KIND_FRIENDLY,
  ATLAS_PACK_LABELS,
  MACHINERY_BANDS,
  ONTOLOGY_PACKS,
  atlasTables,
  atlasTablesByLogical,
  atlasTablesByPhysical,
  packKindOf,
} from "./atlas.js";
import { VAULT_TABLES } from "./tables.js";

function registrySize(): number {
  return Object.values(VAULT_TABLES).reduce((n, t) => n + t.length, 0);
}

describe("atlas", () => {
  test("atlasTables covers exactly the registry — derived, never hand-listed", () => {
    const entries = atlasTables();
    expect(entries).toHaveLength(registrySize());
    const logicalFromRegistry = new Set<string>();
    for (const [schema, tables] of Object.entries(VAULT_TABLES)) {
      for (const t of tables) logicalFromRegistry.add(`${schema}.${t}`);
    }
    const logicalFromAtlas = new Set(entries.map((e) => e.logical));
    expect(logicalFromAtlas).toStrictEqual(logicalFromRegistry);
  });

  test("every registered schema is classified — no unclassified pack slips through", () => {
    const schemas = new Set(Object.keys(VAULT_TABLES));
    for (const schema of schemas) {
      expect(packKindOf(schema)).toBeDefined();
      expect(ATLAS_PACK_LABELS[schema]).toBeTypeOf("string");
    }
    const ontology = new Set(ONTOLOGY_PACKS);
    const machinery = new Set(MACHINERY_BANDS);
    for (const schema of schemas) {
      expect(ontology.has(schema)).not.toBe(machinery.has(schema));
    }
  });

  test("classification matches the life-data vs plumbing split", () => {
    expect(packKindOf("people")).toBe("ontology");
    expect(packKindOf("media")).toBe("ontology");
    expect(packKindOf("core")).toBe("ontology");
    expect(packKindOf("access")).toBe("machinery");
    expect(packKindOf("audit")).toBe("machinery");
    expect(packKindOf("ledger")).toBe("machinery");
    expect(packKindOf("blob")).toBe("machinery");
    expect(packKindOf("outbox")).toBe("machinery");
    expect(packKindOf("share")).toBe("machinery");
  });

  test("every ATLAS_KIND_FRIENDLY key is a real registry logical name — no dead keys", () => {
    const byLogical = atlasTablesByLogical();
    for (const logical of Object.keys(ATLAS_KIND_FRIENDLY)) {
      const entry = byLogical.get(logical);
      expect(
        entry,
        `curated key "${logical}" is not a registered logical name`
      ).toBeDefined();
      expect(entry!.packKind).toBe("ontology");
    }
  });

  test("ontology kinds carry name+blurb; machinery is named with no blurb", () => {
    const byLogical = atlasTablesByLogical();
    const party = byLogical.get("core.party")!;
    expect(party.friendly).toBe("People");
    expect(party.blurb).toBe(ATLAS_KIND_FRIENDLY["core.party"]!.blurb);
    expect(party.friendly).not.toBe(party.label); // the name overrode "Party".

    const app = byLogical.get("access.app")!;
    expect(app.friendly).toBe("Installed apps");
    expect(app.blurb).toBeUndefined();
    const authority = byLogical.get("share.authority")!;
    expect(authority.friendly).toBe("Access answers");
    expect(authority.blurb).toBeUndefined();
  });

  test("physical/logical names derive from schema_table and index round-trips", () => {
    const byPhysical = atlasTablesByPhysical();
    const byLogical = atlasTablesByLogical();
    const party = byLogical.get("core.party");
    expect(party).toBeDefined();
    expect(party!.physical).toBe("core_party");
    expect(party!.packKind).toBe("ontology");
    expect(byPhysical.get("core_party")).toStrictEqual(party);
  });
});
