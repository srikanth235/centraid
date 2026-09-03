import { beforeEach, describe, expect, test } from "vitest";

import { bootstrappedVault } from "@centraid/test-kit/vault";

import { bootstrapVault } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { buildAssistantContext } from "./assistant-context.js";

let db: VaultDb;

describe("assistant-context", () => {
  beforeEach(() => {
    ({ db } = bootstrappedVault(
      { openVaultDb, bootstrapVault },
      { ownerName: "Priya" }
    ));
  });

  describe(buildAssistantContext, () => {
    test("carries conventions, vocabulary, FTS surfaces, and live DDL", () => {
      const doc = buildAssistantContext(db);
      expect(doc).toContain(
        "core_link is the ONLY cross-entity relationship fabric"
      );
      expect(doc).toContain("vault_content_text(");
      expect(doc).toContain("## Link relations");
      expect(doc).toContain("fts_knowledge_note");
      expect(doc).toContain("CREATE TABLE core_party");
      expect(doc).toContain("CREATE TABLE core_link");
      expect(doc).not.toContain("fts_core_party_idx");
    });
  });
});
