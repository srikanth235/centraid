import { randomBytes } from "node:crypto";

import { describe, expect, test } from "vitest";

import { sealAad, sealValue } from "../schema/sealed.js";
import type { VaultExport } from "./portability.js";
import {
  auditArtifactSealedValues,
  sealedArtifactTotal,
} from "./sealed-artifact.js";

function artifactOf(
  tables: Record<string, Record<string, unknown>[]>
): VaultExport {
  return {
    format: "jsonld",
    ontologyVersion: "test",
    exportedAt: "2026-01-01T00:00:00.000Z",
    tables,
    verifyHash: "unchecked",
  };
}

describe("sealed-artifact suite", () => {
  const key = randomBytes(32);
  const secret = sealValue(key, sealAad("ext_app_secrets", "token", "r1"), "s");

  // The ext band's declaration travels under its ONTOLOGY name. When the
  // access plane was renamed (#916, D4) this reader still asked for
  // `consent.app_ext`, so every ext-declared sealed column read as
  // `unexpected` and a legitimate export refused its own import.
  test("an ext app's sealed columns are read from the access.app_ext rows", () => {
    const audit = auditArtifactSealedValues(
      artifactOf({
        "access.app_ext": [
          {
            app_id: "notes",
            table_name: "secrets",
            band: "live",
            spec_json: JSON.stringify({ sealed: ["token"] }),
          },
        ],
        "ext.notes.secrets": [{ row_id: "r1", token: secret }],
      })
    );
    expect(audit.unexpected).toStrictEqual([]);
    expect(sealedArtifactTotal(audit)).toBe(1);
  });

  test("a sealed value in a column no declaration covers is unexpected", () => {
    const audit = auditArtifactSealedValues(
      artifactOf({
        "access.app_ext": [
          {
            app_id: "notes",
            table_name: "secrets",
            band: "live",
            spec_json: JSON.stringify({ sealed: ["token"] }),
          },
        ],
        "ext.notes.secrets": [{ row_id: "r1", other: secret }],
      })
    );
    expect(audit.unexpected).toStrictEqual(["ext.notes.secrets.other"]);
    expect(sealedArtifactTotal(audit)).toBe(0);
  });

  test("a draft ext row declares nothing — only the live band is exported", () => {
    const audit = auditArtifactSealedValues(
      artifactOf({
        "access.app_ext": [
          {
            app_id: "notes",
            table_name: "secrets",
            band: "draft",
            spec_json: JSON.stringify({ sealed: ["token"] }),
          },
        ],
        "ext.notes.secrets": [{ row_id: "r1", token: secret }],
      })
    );
    expect(audit.unexpected).toStrictEqual(["ext.notes.secrets.token"]);
  });
});
