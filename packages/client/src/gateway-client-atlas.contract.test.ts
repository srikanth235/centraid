// Client↔gateway seam laws for the Vault Atlas (#441 Part B): the three
// read-only census surfaces and the Browse editor's read/write split, which had
// no test file (#656 Layer 1B). The load-bearing law here is the write path's
// deliberate inversion of the client's usual error handling — an expected
// refusal comes back as DATA (`ok:false`), never as a thrown error, because the
// Browse UI renders it inline. Shared harness in gateway-client-seam-fixtures.ts.

import { describe, expect, it } from "vitest";

import {
  atlas,
  installSeamContractHarness,
  json,
  respond,
  sent,
  sentJson,
  wireLog,
} from "./gateway-client-seam-fixtures.js";

installSeamContractHarness();

describe("atlas census seam", () => {
  it("law: each census view has exactly one bearer GET route", async () => {
    await expect(atlas.vaultAtlasStats()).resolves.toMatchObject({
      method: "dbstat",
    });
    await expect(atlas.vaultAtlasGraph()).resolves.toMatchObject({
      center: "core_party",
    });
    await expect(atlas.vaultAtlasPulse()).resolves.toMatchObject({
      live: true,
    });

    expect(wireLog()).toStrictEqual([
      "GET /centraid/_vault/atlas/stats",
      "GET /centraid/_vault/atlas/graph",
      "GET /centraid/_vault/atlas/pulse",
    ]);
    expect(
      sent("GET /centraid/_vault/atlas/stats").headers.get("authorization")
    ).toBe("Bearer token-1");
  });

  it("law: a census read is scoped to the addressed vault", async () => {
    await atlas.vaultAtlasGraph();

    expect(
      sent("GET /centraid/_vault/atlas/graph").headers.get("x-centraid-vault")
    ).toBe("vault-1");
  });

  it("law: a gateway failure surfaces as a typed client error, not a partial census", async () => {
    respond(
      "GET /centraid/_vault/atlas/stats",
      () => new Response("boom", { status: 500 })
    );

    await expect(atlas.vaultAtlasStats()).rejects.toMatchObject({
      code: "gateway_error",
    });
  });

  it("law: an HTML body from something that is not the gateway never parses as a census", async () => {
    respond(
      "GET /centraid/_vault/atlas/pulse",
      () =>
        new Response("<!doctype html><title>captive portal</title>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })
    );

    await expect(atlas.vaultAtlasPulse()).rejects.toMatchObject({
      code: "gateway_error",
    });
  });
});

describe("atlas browse read seam", () => {
  it("law: every read names its table in the query string, percent-encoded", async () => {
    await expect(atlas.browseTables()).resolves.toStrictEqual([
      { logical: "core.party", rows: 3 },
    ]);
    await atlas.browseColumns("core.party");
    await atlas.browseRow("core.party", "p/1");
    await expect(
      atlas.browseRefSearch("core.party", "ada lovelace")
    ).resolves.toStrictEqual([{ id: "p1", display: "Ada" }]);
    await atlas.browseDependents("core.party", "p1");

    expect(
      sent("GET /centraid/_vault/atlas/browse/columns").query.get("table")
    ).toBe("core.party");
    const row = sent("GET /centraid/_vault/atlas/browse/row").query;
    expect(row.get("id")).toBe("p/1");
    expect(
      sent("GET /centraid/_vault/atlas/browse/ref-search").query.get("query")
    ).toBe("ada lovelace");
    expect(
      sent("GET /centraid/_vault/atlas/browse/dependents").query.get("id")
    ).toBe("p1");
  });

  it("law: keyset paging sends only the parameters the caller set", async () => {
    await atlas.browseRows({ table: "core.party" });

    expect([
      ...sent("GET /centraid/_vault/atlas/browse/rows").query.keys(),
    ]).toStrictEqual(["table"]);
  });

  it("law: every paging parameter the caller sets reaches the wire", async () => {
    await atlas.browseRows({
      table: "core.party",
      limit: 50,
      after: "cursor-1",
      orderBy: "created_at",
      dir: "desc",
    });

    const query = sent("GET /centraid/_vault/atlas/browse/rows").query;
    expect(Object.fromEntries(query)).toStrictEqual({
      table: "core.party",
      limit: "50",
      after: "cursor-1",
      orderBy: "created_at",
      dir: "desc",
    });
  });
});

describe("atlas browse write seam", () => {
  it("law: a write is a JSON POST on the verb's own route", async () => {
    await atlas.browseInsertRow({
      table: "core.party",
      values: { display_name: "Ada" },
    });
    await atlas.browseUpdateRow({
      table: "core.party",
      id: "p1",
      set: { display_name: "Ada L" },
    });
    await atlas.browseDeleteRow({ table: "core.party", id: "p1" });

    expect(wireLog()).toStrictEqual([
      "POST /centraid/_vault/atlas/browse/insert",
      "POST /centraid/_vault/atlas/browse/update",
      "POST /centraid/_vault/atlas/browse/delete",
    ]);
    expect(sentJson("POST /centraid/_vault/atlas/browse/insert")).toStrictEqual(
      {
        table: "core.party",
        values: { display_name: "Ada" },
      }
    );
  });

  it("law: unlocking machinery is an explicit flag on the write, never a default", async () => {
    await atlas.browseUpdateRow({
      table: "app_registry",
      id: "daily",
      set: { label: "Daily" },
      unlockMachinery: true,
    });

    expect(sentJson("POST /centraid/_vault/atlas/browse/update")).toMatchObject(
      {
        unlockMachinery: true,
      }
    );
  });

  it("law: an expected refusal is data the editor renders, not an exception", async () => {
    respond("POST /centraid/_vault/atlas/browse/insert", () =>
      json({ ok: false, error: "NOT NULL constraint failed" }, 422)
    );

    await expect(
      atlas.browseInsertRow({ table: "core.party", values: {} })
    ).resolves.toStrictEqual({
      ok: false,
      error: "NOT NULL constraint failed",
    });
  });

  it("law: a dependent-blocked delete returns the blockers so the UI can name them", async () => {
    respond("POST /centraid/_vault/atlas/browse/delete", () =>
      json(
        {
          ok: false,
          error: "row has dependents",
          dependents: [
            {
              table: "business_invoice",
              via: "party_id",
              count: 2,
              mechanism: "fk",
            },
          ],
          totalRows: 2,
        },
        409
      )
    );

    await expect(
      atlas.browseDeleteRow({ table: "core.party", id: "p1" })
    ).resolves.toStrictEqual({
      ok: false,
      error: "row has dependents",
      dependents: [
        {
          table: "business_invoice",
          via: "party_id",
          count: 2,
          mechanism: "fk",
        },
      ],
      totalRows: 2,
    });
  });

  it("law: a 200 whose body says ok:false is still a refusal", async () => {
    respond("POST /centraid/_vault/atlas/browse/update", () =>
      json({ ok: false, error: "column is sealed" })
    );

    await expect(
      atlas.browseUpdateRow({
        table: "core.party",
        id: "p1",
        set: { ssn: "x" },
      })
    ).resolves.toMatchObject({ ok: false, error: "column is sealed" });
  });

  it("law: only a non-JSON body escapes the write path as an exception", async () => {
    respond(
      "POST /centraid/_vault/atlas/browse/insert",
      () => new Response("<html>proxy error</html>", { status: 502 })
    );

    await expect(
      atlas.browseInsertRow({ table: "core.party", values: {} })
    ).rejects.toMatchObject({ code: "gateway_error" });
  });
});

describe("demo purge seam", () => {
  it("law: purging one app names it in the path; purging all omits it", async () => {
    await expect(atlas.vaultDemoPurge("daily")).resolves.toStrictEqual({
      purged: 1,
      blocked: [],
    });
    await expect(atlas.vaultDemoPurge()).resolves.toStrictEqual({
      purged: 3,
      blocked: [],
    });

    expect(wireLog()).toStrictEqual([
      "DELETE /centraid/_vault/demo/daily",
      "DELETE /centraid/_vault/demo",
    ]);
  });
});
