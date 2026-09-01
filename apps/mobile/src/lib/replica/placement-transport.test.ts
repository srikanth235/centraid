/* oxlint-disable import/first -- vi.mock is hoisted; subject imports intentionally follow */
// Gateway fetch helpers are mocked so vitest never loads react-native
// (same pattern as lib/insights.test.ts).
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock(import("../gateway") as Promise<unknown>, () => ({
  authHeader: () => ({}),
}));

import { ROUTES } from "@centraid/core/protocol";

import type { PlacementIntent } from "./multi-vault-reader";
import {
  listCommonsResidents,
  postCommons,
  postPlacement,
  PlacementSubmissionError,
  retainCommonsItem,
} from "./placement-transport";

const BASE_URL = "http://gateway.local";

const INTENT: PlacementIntent = {
  linkToken: "edge-token-1",
  kind: "add",
  itemType: "media.asset",
  itemId: "asset-1",
  sourceVaultId: "vault-a",
  targetVaultId: "vault-b",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe(postPlacement, () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("posts to the edges route with a single-item scope, translating the outbox's PlacementIntent shape", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        capturedUrl = url.toString();
        capturedBody = JSON.parse(init?.body as string);
        return jsonResponse(200, {
          edgeId: "edge-token-1",
          status: "completed",
          itemIds: ["asset-1"],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        });
      })
    );

    const record = await postPlacement(BASE_URL, INTENT);

    expect(capturedUrl).toBe(new URL(ROUTES.gatewayEdges, BASE_URL).toString());
    expect(capturedBody).toStrictEqual({
      edgeId: "edge-token-1",
      originVaultId: "vault-a",
      audienceVaultId: "vault-b",
      mode: "snapshot",
      kind: "add",
      itemType: "media.asset",
      itemIds: ["asset-1"],
      verbs: "read",
    });
    // The outbox's PlacementRecord shape is unchanged: one item, and the
    // edge's terminal 'completed' translates back to the old 'executed'.
    expect(record).toStrictEqual({
      ...INTENT,
      status: "executed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
  });

  test("a parked edge translates straight through — no terminal-status rename needed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(202, {
          edgeId: "edge-token-1",
          status: "parked",
          reason: "simulated failure",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        })
      )
    );

    const record = await postPlacement(BASE_URL, INTENT);
    expect(record.status).toBe("parked");
    expect(record.reason).toBe("simulated failure");
  });

  test("a 404 (not_found, topology hiding) raises a typed 'failed' submission error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(404, { error: "not_found" }))
    );

    await expect(postPlacement(BASE_URL, INTENT)).rejects.toMatchObject({
      placementStatus: "failed",
    });
  });

  test("a 403 raises a typed 'denied' submission error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(403, { message: "device_identity_required" })
      )
    );

    const rejection = await postPlacement(BASE_URL, INTENT).catch(
      (error: unknown) => error
    );
    expect(rejection).toBeInstanceOf(PlacementSubmissionError);
    expect((rejection as PlacementSubmissionError).placementStatus).toBe(
      "denied"
    );
  });

  test("a 5xx raises a plain (non-typed) unavailability error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(500, { error: "internal_error" }))
    );

    await expect(postPlacement(BASE_URL, INTENT)).rejects.toThrow(
      "Placement gateway unavailable (500)"
    );
  });
});

describe("Save resident Commons item", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("detects exact resident lineage and sends only its actor/item identity", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        if (url.pathname.endsWith("/resident"))
          return jsonResponse(200, {
            items: [
              {
                grantId: "grant-1",
                itemType: "core.document",
                itemId: "doc-1",
                originItemId: "origin-doc",
              },
            ],
          });
        bodies.push(JSON.parse(String(init?.body)));
        return jsonResponse(200, { retained: true, grantIds: ["grant-1"] });
      })
    );

    await expect(
      listCommonsResidents(BASE_URL, "vault-b")
    ).resolves.toMatchObject([{ itemType: "core.document", itemId: "doc-1" }]);
    await expect(
      retainCommonsItem(BASE_URL, {
        actorVaultId: "vault-b",
        itemType: "core.document",
        itemId: "doc-1",
      })
    ).resolves.toMatchObject({ retained: true });
    expect(bodies).toStrictEqual([
      {
        actorVaultId: "vault-b",
        itemType: "core.document",
        itemId: "doc-1",
      },
    ]);
  });
});

describe(postCommons, () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("compiles a container on the registry's commons route", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        capturedUrl = url.toString();
        capturedBody = JSON.parse(String(init?.body));
        return jsonResponse(201, {
          grantId: "grant-1",
          circleId: "circle-1",
          state: "invited",
          currentSizeBytes: 0,
          claims: [{ partyId: "party-ana", claimToken: "token-1" }],
        });
      })
    );

    await expect(
      postCommons(BASE_URL, {
        containerType: "tally.group",
        containerId: "group-1",
        sourceVaultId: "vault-a",
        members: [{ partyId: "party-ana", capability: "read+write" }],
        circleId: "circle-1",
      })
    ).resolves.toMatchObject({ grantId: "grant-1", state: "invited" });
    expect(capturedUrl).toBe(
      new URL(ROUTES.gatewayCommons, BASE_URL).toString()
    );
    expect(capturedBody).toStrictEqual({
      originVaultId: "vault-a",
      containerType: "tally.group",
      containerId: "group-1",
      members: [{ partyId: "party-ana", capability: "read+write" }],
      circleId: "circle-1",
    });
  });

  test("a 403 raises a typed 'denied' share error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(403, { message: "not the steward" }))
    );
    await expect(
      postCommons(BASE_URL, {
        containerType: "tally.group",
        containerId: "group-1",
        sourceVaultId: "vault-a",
        members: [],
      })
    ).rejects.toThrow(PlacementSubmissionError);
  });
});
