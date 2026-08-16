// The semantic-search route (issue #721 E3) over a real vault plane and a real
// HTTP server. The assertions are deliberately about the WIRE — field names and
// status codes — because the mobile Photos surface is coded against exactly
// this shape and a rename here is a protocol break, not a refactor.

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";

import { afterEach, describe, expect, test } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { encodeVector, nowIso, uuidv7 } from "@centraid/vault";

import { companionRequestAllowed } from "../serve/companion-access.js";
import { openVaultPlane } from "../serve/vault-plane.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import {
  SEMANTIC_SEARCH_PATH,
  makeEnrichSearchRouteHandler,
} from "./enrich-search-routes.js";

/** What the fake advertises for `embed-image` — the index's key. */
const MODEL = "fake-clip@1";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const PIXELS = [
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
];

/** An embed-text automation whose encoder answers `[1, 0]`. */
function searchAutomation(text: () => unknown = () => ({ vector: [1, 0] })) {
  return async () => {
    const result = text() as Record<string, unknown>;
    return typeof result.error === "string"
      ? { outcome: { ok: false, error: result.error } }
      : { outcome: { ok: true, output: { model: MODEL, ...result } } };
  };
}

interface SearchResponse {
  status: string;
  model?: string;
  reason?: string;
  hits?: { assetId: string; contentId: string; score: number }[];
}

const cleanups: Array<() => Promise<void> | void> = [];

describe("enrich-search-routes", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });

  async function fixture(
    embedQuery?: ReturnType<typeof searchAutomation>
  ): Promise<{
    url: string;
    plane: VaultPlane;
    assetIds: string[];
  }> {
    const dir = await tempDir(`enrich-search-${crypto.randomUUID()}-`);
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const plane = openVaultPlane({
      bootstrap: true,
      dir,
      logger: silentLogger,
      ownerName: "Priya",
    });
    cleanups.push(() => plane.stop());

    const assetIds: string[] = [];
    await forEachSequentially([0, 1], async (index) => {
      const outcome = await plane.invoke(plane.ownerCredential, {
        command: "media.add_asset",
        input: { data_uri: PIXELS[index] },
        purpose: "dpv:ServiceProvision",
      });
      assetIds.push(
        (outcome as { status: "executed"; output: { asset_id: string } }).output
          .asset_id
      );
    });
    // Hand-planted vectors: [1,0] then [0,1], so a [1,0] query ranks the first
    // photograph at 1 and the second at 0.
    [
      [1, 0],
      [0, 1],
    ].forEach((vector, index) => {
      plane.db.vault
        .prepare(
          `INSERT INTO enrich_embedding
             (embedding_id, target_type, target_id, model, dim, vector, created_at)
           VALUES (?, 'media.asset', ?, ?, ?, ?, ?)`
        )
        .run(
          uuidv7(),
          assetIds[index]!,
          MODEL,
          vector.length,
          encodeVector(vector),
          nowIso()
        );
    });

    const handler = makeEnrichSearchRouteHandler(
      { current: () => plane },
      embedQuery ? { embedQuery } : {}
    );
    const server = http.createServer((req, res) => {
      void handler(req, res).then((handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    );
    const address = server.address() as { port: number };
    return {
      url: `http://127.0.0.1:${address.port}${SEMANTIC_SEARCH_PATH}`,
      plane,
      assetIds,
    };
  }

  const search = (url: string, body: unknown): Promise<Response> =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("a gateway without an embed-text automation answers unavailable", async () => {
    const { url } = await fixture();
    const res = await search(url, { query: "a dog on a beach" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchResponse;
    expect(body.status).toBe("unavailable");
    expect(body.reason).toContain("embed-text automation");
    expect(body.hits).toBeUndefined();
  });

  test("hits come back in the contracted shape, ordered by score", async () => {
    const { url, assetIds } = await fixture(searchAutomation());
    const res = await search(url, { query: "a dog on a beach" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchResponse;
    expect(body.status).toBe("ok");
    expect(body.model).toBe(MODEL);
    expect(body.hits!.map((hit) => hit.assetId)).toStrictEqual(assetIds);
    // The exact wire keys the mobile surface reads.
    expect(Object.keys(body.hits![0]!).toSorted()).toStrictEqual([
      "assetId",
      "contentId",
      "score",
    ]);
    expect(body.hits![0]!.score).toBeCloseTo(1, 5);
    expect(body.hits![1]!.score).toBeCloseTo(0, 5);
  });

  test("limit narrows the result set", async () => {
    const { url, assetIds } = await fixture(searchAutomation());
    const body = (await (
      await search(url, { query: "a dog on a beach", limit: 1 })
    ).json()) as SearchResponse;
    expect(body.hits!.map((hit) => hit.assetId)).toStrictEqual([assetIds[0]]);
  });

  test("a missing or oversized query is a 400, not an empty result", async () => {
    const { url } = await fixture(searchAutomation());
    expect((await search(url, {})).status).toBe(400);
    expect((await search(url, { query: "   " })).status).toBe(400);
    expect((await search(url, { query: "x".repeat(513) })).status).toBe(400);
    expect((await search(url, { query: "ok", limit: "many" })).status).toBe(
      400
    );
  });

  test("only POST reaches the search", async () => {
    const { url } = await fixture(searchAutomation());
    expect((await fetch(url)).status).toBe(405);
  });

  test("a configured service that fails is a 500, not a silent unavailable", async () => {
    const { url } = await fixture(
      searchAutomation(() => ({ error: "the model crashed" }))
    );
    const res = await search(url, { query: "a dog on a beach" });
    expect(res.status).toBe(500);
    await expect(res.text()).resolves.toContain("the model crashed");
  });

  test("a constrained companion device cannot reach semantic search", () => {
    expect(
      companionRequestAllowed(
        { method: "POST", url: SEMANTIC_SEARCH_PATH },
        ["photos", "docs"],
        "enrollment-1"
      )
    ).toBe(false);
  });
});
