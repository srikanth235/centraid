import { describe, expect, test } from "vitest";

import { ATLAS_KIND_FRIENDLY, atlasTablesByLogical } from "./atlas.js";
import { assertFtsSpecsRegistered } from "./fts.js";
import {
  VAULT_ENTITIES,
  assertRegistryLabels,
  assertVaultRegistryLabels,
  entityDeclaration,
  resolveEntity,
} from "./tables.js";

describe("entity labels", () => {
  test("every registered entity declares a label", () => {
    expect(() => assertVaultRegistryLabels()).not.toThrow();
    for (const [schema, entities] of Object.entries(VAULT_ENTITIES)) {
      for (const [table, declaration] of Object.entries(entities)) {
        expect(
          declaration.label.trim(),
          `${schema}.${table} needs a label`
        ).not.toBe("");
      }
    }
  });

  test("an entity with no label fails validation", () => {
    expect(() =>
      assertRegistryLabels(
        { scratch: { nameless: { label: "", lifecycle: "machinery" } } },
        "vault"
      )
    ).toThrow(/scratch\.nameless has no label/u);
  });

  test("two entities in one pack may not share a name", () => {
    expect(() =>
      assertRegistryLabels(
        {
          scratch: {
            first: { label: "Tasks", lifecycle: "machinery" },
            second: { label: "Tasks", lifecycle: "machinery" },
          },
        },
        "vault"
      )
    ).toThrow(/both called "Tasks"/u);
  });

  test("a blurb is left out rather than fabricated empty", () => {
    expect(() =>
      assertRegistryLabels(
        {
          scratch: {
            thing: { label: "Things", blurb: "  ", lifecycle: "mutable" },
          },
        },
        "vault"
      )
    ).toThrow(/empty blurb/u);
  });

  test("machinery is named but carries no blurb — we never describe plumbing", () => {
    for (const [schema, entities] of Object.entries(VAULT_ENTITIES)) {
      for (const [table, declaration] of Object.entries(entities)) {
        const entry = atlasTablesByLogical().get(`${schema}.${table}`)!;
        if (entry.packKind !== "machinery") continue;
        expect(declaration.blurb, `${schema}.${table}`).toBeUndefined();
      }
    }
  });

  test("the Atlas's friendly names are the registry's, not a second copy", () => {
    const byLogical = atlasTablesByLogical();
    for (const [logical, entry] of byLogical) {
      expect(entry.friendly).toBe(entityDeclaration(logical)!.label);
    }
    for (const [logical, friendly] of Object.entries(ATLAS_KIND_FRIENDLY)) {
      const declaration = entityDeclaration(logical)!;
      expect(friendly.name).toBe(declaration.label);
      expect(friendly.blurb).toBe(declaration.blurb);
    }
  });

  test("the registry is an allow-list before it is a name table", () => {
    expect(resolveEntity("core.constructor")).toBeUndefined();
    expect(entityDeclaration("core.toString")).toBeUndefined();
    expect(resolveEntity("constructor.party")).toBeUndefined();
  });

  test("every live FTS spec names a registered entity", () => {
    expect(() => assertFtsSpecsRegistered()).not.toThrow();
  });
});
