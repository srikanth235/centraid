/* oxlint-disable import/first -- vi.mock is hoisted; subject imports intentionally follow */
// Gateway fetch helpers are mocked so vitest never loads react-native
// (same pattern as lib/insights.test.ts).
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock(import("../gateway") as Promise<unknown>, () => ({
  authHeader: () => ({}),
}));

import { ROUTES } from "@centraid/protocol";

import type { PlacementIntent } from "./multi-vault-reader";
import {
  answerCommonsInvitation,
  claimCommonsInvitation,
  listCommonsResidents,
  listCommonsInvitations,
  postPlacement,
  PlacementSubmissionError,
  retainCommonsItem,
} from "./placement-transport";

const BASE_URL = "http://gateway.local";

const INTENT: PlacementIntent = {
  linkToken: "edge-token-1",
  kind: "add",
  itemType: "media.media_asset",
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
      itemType: "media.media_asset",
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

describe("Commons invitations", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("lists receiver-owned offers with their current byte size", async () => {
    let capturedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        capturedUrl = url.toString();
        return jsonResponse(200, {
          invitations: [
            {
              invitationId: "invite-1",
              grantId: "grant-1",
              stewardVaultId: "vault-a",
              memberVaultId: "vault-b",
              currentSizeBytes: 4096,
              status: "pending",
              createdAt: "2026-08-10T00:00:00.000Z",
            },
          ],
        });
      })
    );

    await expect(
      listCommonsInvitations(BASE_URL, "vault-b")
    ).resolves.toMatchObject([
      { invitationId: "invite-1", currentSizeBytes: 4096 },
    ]);
    expect(capturedUrl).toBe(
      new URL(
        `${ROUTES.gatewayCommons}/invitations?actorVaultId=vault-b`,
        BASE_URL
      ).toString()
    );
  });

  test("answers with an explicit accept or refuse decision", async () => {
    let capturedBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body));
        return jsonResponse(200, {
          invitation: {
            invitationId: "invite-1",
            status: "accepted",
          },
        });
      })
    );

    await answerCommonsInvitation(BASE_URL, "invite-1", "vault-b", "accept");
    expect(capturedBody).toStrictEqual({
      actorVaultId: "vault-b",
      answer: "accept",
    });
  });

  test("redeems the decoded claim into the selected receiver vault", async () => {
    let capturedUrl = "";
    let capturedBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        capturedUrl = url.toString();
        capturedBody = JSON.parse(String(init?.body));
        return jsonResponse(200, { claimed: true });
      })
    );

    await expect(
      claimCommonsInvitation(
        BASE_URL,
        "vault-receiver",
        "vault-steward",
        "one-time-secret"
      )
    ).resolves.toStrictEqual({ claimed: true });
    expect(capturedUrl).toBe(
      new URL(`${ROUTES.gatewayCommons}/invitations/claim`, BASE_URL).toString()
    );
    expect(capturedBody).toStrictEqual({
      actorVaultId: "vault-receiver",
      stewardVaultId: "vault-steward",
      claimToken: "one-time-secret",
    });
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
