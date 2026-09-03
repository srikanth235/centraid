import { describe, expect, test } from "vitest";

import { openVaultDb } from "../db.js";
import {
  deleteEnrichPolicyRule,
  listEnrichPolicyRules,
  putEnrichPolicyRule,
  readEnrichPolicyRule,
  readEnrichPolicyRuleChain,
} from "./policy-rules.js";
import type { EnrichScope } from "./policy-rules.js";

const T0 = "2026-08-16T00:00:00.000Z";
const T1 = "2026-08-17T00:00:00.000Z";

const VAULT_SCOPE: EnrichScope = { type: "vault", ref: "" };
const PHOTOS: EnrichScope = { type: "domain", ref: "photos" };
const ALBUM: EnrichScope = { type: "collection", ref: "album-screenshots" };

describe("enrich policy rules", () => {
  test("a rule states only what its scope decides; the rest inherits", () => {
    const db = openVaultDb();
    putEnrichPolicyRule(db.vault, {
      scope: ALBUM,
      capability: "faces",
      enabled: false,
      now: T0,
    });
    expect(readEnrichPolicyRule(db.vault, ALBUM, "faces")).toStrictEqual({
      scope: ALBUM,
      capability: "faces",
      enabled: false,
      profile: null,
      trigger: null,
      updatedAt: T0,
    });
    db.close();
  });

  test("rewriting a scope's rule replaces it rather than adding one", () => {
    const db = openVaultDb();
    putEnrichPolicyRule(db.vault, {
      scope: PHOTOS,
      capability: "ocr",
      enabled: true,
      trigger: "on-ingest",
      now: T0,
    });
    putEnrichPolicyRule(db.vault, {
      scope: PHOTOS,
      capability: "ocr",
      profile: "ocr-llm",
      now: T1,
    });
    expect(listEnrichPolicyRules(db.vault, "ocr")).toStrictEqual([
      {
        scope: PHOTOS,
        capability: "ocr",
        enabled: null,
        profile: "ocr-llm",
        trigger: null,
        updatedAt: T1,
      },
    ]);
    db.close();
  });

  test("a rule that decides nothing is unrepresentable", () => {
    const db = openVaultDb();
    expect(() =>
      putEnrichPolicyRule(db.vault, {
        scope: PHOTOS,
        capability: "ocr",
        now: T0,
      })
    ).toThrow(/CHECK constraint failed/u);
    db.close();
  });

  test("only the vault scope may carry an empty ref, and it must", () => {
    const db = openVaultDb();
    expect(() =>
      putEnrichPolicyRule(db.vault, {
        scope: { type: "vault", ref: "photos" },
        capability: "ocr",
        enabled: true,
        now: T0,
      })
    ).toThrow(/CHECK constraint failed/u);
    expect(() =>
      putEnrichPolicyRule(db.vault, {
        scope: { type: "collection", ref: "" },
        capability: "ocr",
        enabled: true,
        now: T0,
      })
    ).toThrow(/CHECK constraint failed/u);
    db.close();
  });

  test("a chain reads least-specific first whatever order it is asked in", () => {
    const db = openVaultDb();
    for (const scope of [ALBUM, VAULT_SCOPE, PHOTOS]) {
      putEnrichPolicyRule(db.vault, {
        scope,
        capability: "ocr",
        enabled: true,
        now: T0,
      });
    }
    const chain = readEnrichPolicyRuleChain(
      db.vault,
      [ALBUM, { type: "item", ref: "asset-1" }, PHOTOS, VAULT_SCOPE],
      "ocr"
    );
    expect(chain.map((rule) => rule.scope.type)).toStrictEqual([
      "vault",
      "domain",
      "collection",
    ]);
    db.close();
  });

  test("deleting a rule makes its scope stop deciding", () => {
    const db = openVaultDb();
    putEnrichPolicyRule(db.vault, {
      scope: ALBUM,
      capability: "faces",
      enabled: false,
      now: T0,
    });
    deleteEnrichPolicyRule(db.vault, ALBUM, "faces");
    expect(readEnrichPolicyRule(db.vault, ALBUM, "faces")).toBeNull();
    expect(listEnrichPolicyRules(db.vault, "faces")).toStrictEqual([]);
    db.close();
  });

  test("a trigger outside the vocabulary can never be stored", () => {
    const db = openVaultDb();
    expect(() =>
      db.vault
        .prepare(
          `INSERT INTO enrich_policy_rule
             (rule_id, scope_type, scope_ref, capability, trigger_on, updated_at)
           VALUES ('r1', 'vault', '', 'ocr', 'whenever', ?)`
        )
        .run(T0)
    ).toThrow(/CHECK constraint failed/u);
    db.close();
  });
});
