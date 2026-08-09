// `lendWireFromEdge`'s `searchReach` threading (issue #726 P4 D10, job 1's
// client-wire leg): the gateway's `POST /_gateway/edges` response for a live
// edge has carried `searchReach` since `edges-routes.ts`'s `edgeWire` grew it
// — this file used to fold every OTHER field of that response back into
// `InlineLendResult` and silently drop this one, so a masked lend's warning
// (`share-kit.ts`'s `searchReachWarning`) had nothing to read on the client
// side no matter what the gateway sent. Pins that it now survives the trip,
// and that a malformed/absent field degrades to "nothing to report" rather
// than a bad shape reaching a caller as typed data.
import { describe, expect, it, vi } from "vitest";

import type * as TypeImport_gatewayClientCore from "../../gateway-client-core.js";
import { lendWireFromEdge } from "./lend-wire.js";

// `lendWireFromEdge` itself does no gateway I/O (it only shapes a response
// object already in hand), but this module also exports `performLend`/
// `loadLinkDestinations`, which import `gateway-client-core.js` — and that
// module touches `window.CentraidApi` at load time (same footgun
// `kit-inline.test.ts` stubs around). Mock it so importing THIS file for the
// one pure function under test does not require an Electron-injected global.
// vitest hoists `vi.mock` above the imports above at run time.
vi.mock(import("../../gateway-client-core.js") as Promise<unknown>, () => ({
  auth: vi.fn<typeof TypeImport_gatewayClientCore.auth>(async () => ({
    baseUrl: "https://gw.test",
    token: "tok",
  })),
  authHeaders: () => ({}),
  doFetch: vi.fn<typeof TypeImport_gatewayClientCore.doFetch>(),
  readJson: vi.fn<typeof TypeImport_gatewayClientCore.readJson>(),
}));

const OPTS = {
  linkToken: "tok-1",
  itemType: "media.media_asset",
  sourceVaultId: "vault-origin",
  targetVaultId: "vault-audience",
};

describe("lendWireFromEdge's searchReach", () => {
  it("threads a well-shaped searchReach through untouched", () => {
    const result = lendWireFromEdge(
      {
        status: "established",
        searchReach: [
          {
            schema: "media",
            table: "media_asset",
            masksSearchableColumns: true,
          },
          {
            schema: "core",
            table: "content_item",
            masksSearchableColumns: false,
          },
        ],
      },
      OPTS
    );
    expect(result.searchReach).toStrictEqual([
      { schema: "media", table: "media_asset", masksSearchableColumns: true },
      { schema: "core", table: "content_item", masksSearchableColumns: false },
    ]);
  });

  it("omits the field when the gateway sent none — the pre-D10 edge shape", () => {
    const result = lendWireFromEdge({ status: "established" }, OPTS);
    expect(result.searchReach).toBeUndefined();
  });

  it("omits the field rather than pass through a malformed value", () => {
    const result = lendWireFromEdge(
      { status: "established", searchReach: [{ schema: "media" }] },
      OPTS
    );
    expect(result.searchReach).toBeUndefined();
  });

  it("passes an empty array through as-is — well-shaped, just empty", () => {
    const result = lendWireFromEdge(
      { status: "established", searchReach: [] },
      OPTS
    );
    expect(result.searchReach).toStrictEqual([]);
  });

  it("still carries every other field unchanged alongside searchReach", () => {
    const result = lendWireFromEdge(
      {
        status: "executed",
        reason: "ignored on a settled status",
        accessReceiptId: "receipt-1",
        searchReach: [
          { schema: "core", table: "document", masksSearchableColumns: false },
        ],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      OPTS
    );
    expect(result).toMatchObject({
      linkToken: OPTS.linkToken,
      itemType: OPTS.itemType,
      sourceVaultId: OPTS.sourceVaultId,
      targetVaultId: OPTS.targetVaultId,
      status: "executed",
      accessReceiptId: "receipt-1",
      searchReach: [
        { schema: "core", table: "document", masksSearchableColumns: false },
      ],
    });
  });
});
