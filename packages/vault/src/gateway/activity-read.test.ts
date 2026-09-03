// Per-entity activity read (#352 phase 3/4): the audit band already
// records a provenance row for every command write (writeProvenance,
// evidence.ts) keyed by (entity_type, entity_id); this is the app-plane read
// path over it — plain `gw.read({ entity: 'access.provenance', ... })`, held
// to two extra rules (provenanceScopeFailure in gateway.ts) so a table-level
// grant on `access.provenance` cannot become a browse-everything key.

import { beforeEach, describe, expect, test } from "vitest";

import { bootstrappedVault } from "@centraid/test-kit/vault";

import { bootstrapVault, createGrant, enrollApp } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { registerDocumentCommands } from "../commands/documents.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import type { Gateway } from "./gateway.js";
import { createGateway } from "./gateway.js";
import type { Credential } from "./types.js";

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

const TEXT = "data:text/plain;charset=utf-8,hello";

describe("activity-read", () => {
  beforeEach(() => {
    ({ db, boot } = bootstrappedVault(
      { openVaultDb, bootstrapVault },
      { ownerName: "Priya" }
    ));
    gw = createGateway(db);
    registerDocumentCommands(gw);
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
  });

  function grantApp(
    name: string,
    scopes: {
      schema: string;
      table?: string;
      verbs: "read" | "read+act" | "act";
    }[]
  ): Credential {
    const app = enrollApp(db, { name });
    createGrant(db, {
      appId: app.appId,
      purposeConceptId: boot.concepts["dpv:ServiceProvision"] as string,
      grantedByPartyId: boot.ownerPartyId,
      scopes,
    });
    return { kind: "app", appId: app.appId, signingKey: app.signingKey };
  }

  function addDocument(): string {
    const outcome = gw.invoke(owner, {
      command: "core.add_document",
      input: { data_uri: TEXT, title: "Lease" },
      purpose: "dpv:ServiceProvision",
    });
    expect(outcome.status).toBe("executed");
    return (outcome as { output: { document_id: string } }).output.document_id;
  }

  describe("activity read over access.provenance", () => {
    test("an app holding both scopes reads the specific entity's activity", () => {
      const documentId = addDocument();
      const cred = grantApp("docs-app", [
        { schema: "core", table: "document", verbs: "read" },
        { schema: "access", table: "provenance", verbs: "read" },
      ]);
      const result = gw.read(cred, {
        entity: "access.provenance",
        where: [
          { column: "entity_type", op: "eq", value: "core.document" },
          { column: "entity_id", op: "eq", value: documentId },
        ],
        purpose: "dpv:ServiceProvision",
      });
      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.rows[0]).toMatchObject({
        entity_type: "core.document",
        entity_id: documentId,
        prov_activity: "command.core.add_document",
      });
    });

    test("unscoped reads (no entity_type/entity_id) are denied even with a table grant", () => {
      addDocument();
      const cred = grantApp("docs-app-2", [
        { schema: "core", table: "document", verbs: "read" },
        { schema: "access", table: "provenance", verbs: "read" },
      ]);
      expect(() =>
        gw.read(cred, {
          entity: "access.provenance",
          purpose: "dpv:ServiceProvision",
        })
      ).toThrow(/scope to exactly one/u);
    });

    test("holding the provenance grant alone cannot browse a domain the app cannot read", () => {
      const documentId = addDocument();
      // Grants read on access.provenance but NOT on core.document — a health
      // app fishing for another domain's activity must not see it.
      const cred = grantApp("health-app", [
        { schema: "knowledge", verbs: "read" },
        { schema: "access", table: "provenance", verbs: "read" },
      ]);
      expect(() =>
        gw.read(cred, {
          entity: "access.provenance",
          where: [
            { column: "entity_type", op: "eq", value: "core.document" },
            { column: "entity_id", op: "eq", value: documentId },
          ],
          purpose: "dpv:ServiceProvision",
        })
      ).toThrow(/no read consent for core\.document/u);
    });

    test("an unrecognized entity_type is denied, never resolved to SQL", () => {
      const cred = grantApp("docs-app-3", [
        { schema: "core", table: "document", verbs: "read" },
        { schema: "access", table: "provenance", verbs: "read" },
      ]);
      expect(() =>
        gw.read(cred, {
          entity: "access.provenance",
          where: [
            { column: "entity_type", op: "eq", value: "not.a.real.entity" },
            { column: "entity_id", op: "eq", value: "x" },
          ],
          purpose: "dpv:ServiceProvision",
        })
      ).toThrow(/unknown entity/u);
    });

    test("the owner bypasses the extra guard — no entity_type/entity_id required", () => {
      addDocument();
      const result = gw.read(owner, {
        entity: "access.provenance",
        purpose: "owner-assistant",
      });
      expect(result.rows.length).toBeGreaterThan(0);
    });
  });
});
