/* oxlint-disable import/first -- vi.mock is hoisted; subject imports intentionally follow */
/**
 * Vault Atlas client (#765) — the four reads behind the Data place. The
 * gateway HTTP core is mocked so vitest never loads react-native; what is under
 * test is the URL each read addresses (including query building) and the two
 * places a payload is unwrapped.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(import("./gateway") as Promise<unknown>, () => ({
  apiHeaders: (extra?: Record<string, string>) => ({ auth: "1", ...extra }),
  fetchJson: vi.fn<typeof GatewayModule.fetchJson>(),
  requireGatewayBase: vi.fn<typeof GatewayModule.requireGatewayBase>(
    async () => "http://127.0.0.1:9"
  ),
}));

import {
  fetchAtlasCensus,
  fetchAtlasGraph,
  fetchBrowseRows,
  fetchBrowseTables,
} from "./atlas";
import type * as GatewayModule from "./gateway";
import { fetchJson } from "./gateway";

const json = vi.mocked(fetchJson);

describe("mobile Vault Atlas client", () => {
  beforeEach(() => {
    json.mockReset();
  });

  describe(fetchAtlasCensus, () => {
    it("reads the census verbatim off /atlas/stats", async () => {
      const census = {
        fileBytesTotal: 10,
        generatedAt: "2026-01-01T00:00:00.000Z",
        method: "dbstat",
        packs: [],
        totals: { bytes: 10, kinds: 0, populatedKinds: 0, rows: 0 },
      };
      json.mockResolvedValue(census);
      await expect(fetchAtlasCensus()).resolves.toBe(census);
      expect(json).toHaveBeenCalledWith(
        "http://127.0.0.1:9/centraid/_vault/atlas/stats",
        { headers: { auth: "1" }, method: "GET" }
      );
    });
  });

  describe(fetchAtlasGraph, () => {
    it("reads the relations off /atlas/graph", async () => {
      json.mockResolvedValue({
        authoredLinks: [],
        edgeCount: 0,
        fkEdges: [],
        generatedAt: "2026-01-01T00:00:00.000Z",
        nodes: [],
      });
      await fetchAtlasGraph();
      expect(json).toHaveBeenCalledWith(
        "http://127.0.0.1:9/centraid/_vault/atlas/graph",
        { headers: { auth: "1" }, method: "GET" }
      );
    });
  });

  describe(fetchBrowseTables, () => {
    it("unwraps the picker, and reads an absent list as none", async () => {
      json.mockResolvedValue({ tables: [{ logical: "core.party" }] });
      await expect(fetchBrowseTables()).resolves.toStrictEqual([
        { logical: "core.party" },
      ]);
      json.mockResolvedValue({});
      await expect(fetchBrowseTables()).resolves.toStrictEqual([]);
    });
  });

  describe(fetchBrowseRows, () => {
    it("sends only the parameters it was given", async () => {
      json.mockResolvedValue({ columns: [], rows: [] });
      await fetchBrowseRows({ table: "core.party" });
      expect(json).toHaveBeenCalledWith(
        "http://127.0.0.1:9/centraid/_vault/atlas/browse/rows?table=core.party",
        { headers: { auth: "1" }, method: "GET" }
      );
    });

    it("builds the keyset query when paging", async () => {
      json.mockResolvedValue({ columns: [], rows: [] });
      await fetchBrowseRows({
        after: "cursor 1",
        dir: "desc",
        limit: 25,
        orderBy: "created_at",
        table: "core.party",
      });
      const href = String(json.mock.calls[0]?.[0]);
      const params = new URL(href).searchParams;
      expect(params.get("table")).toBe("core.party");
      expect(params.get("limit")).toBe("25");
      expect(params.get("after")).toBe("cursor 1");
      expect(params.get("orderBy")).toBe("created_at");
      expect(params.get("dir")).toBe("desc");
    });
  });
});
