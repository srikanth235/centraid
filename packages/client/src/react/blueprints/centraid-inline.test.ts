// governance: allow-repo-hygiene file-size-limit (#731) one inline host contract suite covers share/claim/resident transports and the replica-backed bridge; splitting it would hide cross-surface identity assertions.
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InlineAppModule } from "@centraid/blueprints/apps/inline-types";
import { lockerPendingProjection } from "@centraid/blueprints/apps/locker/pending-projection";

import type * as TypeImport_oycips from "../../gateway-client-core.js";
import type { ReplicaInvalidation } from "../../replica/types.js";
import { installInlineCentraid } from "./centraid-inline.js";
import type {
  InlineCentraidClient,
  InstallInlineCentraidOptions,
} from "./centraid-inline.js";

const { doFetch, readJson } = vi.hoisted(() => ({
  doFetch: vi.fn<typeof TypeImport_oycips.doFetch>(),
  readJson:
    vi.fn<(response: Response, operation: string) => Promise<unknown>>(),
}));
// vitest hoists vi.mock above imports at run time, so declaration order here is
// only for the linter's import-first rule.
vi.mock(import("../../gateway-client-core.js") as Promise<unknown>, () => ({
  auth: vi.fn<typeof TypeImport_oycips.auth>(async () => ({
    baseUrl: "https://gw.test",
    token: "tok",
  })),
  authHeaders: (token: string | undefined, ct?: string) => ({
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(ct ? { "Content-Type": ct } : {}),
  }),
  doFetch,
  readJson,
}));

type Session = NonNullable<InstallInlineCentraidOptions["session"]>;

function fakeSession(overrides?: Partial<Session>): Session & {
  writes: unknown[];
  subscribers: Array<(inv: readonly ReplicaInvalidation[]) => void>;
} {
  const writes: unknown[] = [];
  const subscribers: Array<(inv: readonly ReplicaInvalidation[]) => void> = [];
  return {
    writes,
    subscribers,
    read: vi.fn<Session["read"]>(async () => ({
      rows: [],
      cursor: { epoch: "e", seq: 1 },
      dependency: { shapeId: "s", entity: "x" },
    })),
    search: vi.fn<Session["search"]>(async () => ({
      rows: [],
      cursor: { epoch: "e", seq: 1 },
      dependency: { shapeId: "s", entity: "x" },
    })),
    write: vi.fn<Session["write"]>(async (_appId, input) => {
      writes.push(input);
      return {
        intentId: (input as { intentId?: string }).intentId ?? "gen-1",
        status: "executed",
        output: { task_id: "t1" },
      };
    }),
    subscribe: vi.fn<Session["subscribe"]>((_appId, _deps, listener) => {
      subscribers.push(listener);
      return () => {
        const i = subscribers.indexOf(listener);
        if (i >= 0) subscribers.splice(i, 1);
      };
    }),
    ...overrides,
  } as Session & {
    writes: unknown[];
    subscribers: Array<(inv: readonly ReplicaInvalidation[]) => void>;
  };
}

function client(target: { centraid?: unknown }): {
  read: <T>(o: {
    query: string;
    input?: Record<string, unknown>;
  }) => Promise<T>;
  write: <T>(o: {
    action: string;
    input?: Record<string, unknown>;
    intentId?: string;
    onlineOnly?: boolean;
  }) => Promise<T>;
  onChange: (cb: (d: { tables?: string[] }) => void) => () => void;
} {
  return target.centraid as never;
}

const noQueries: InlineAppModule["queries"] = {};

describe(installInlineCentraid, () => {
  beforeEach(() => {
    doFetch.mockReset();
    readJson.mockReset();
  });

  it("forwards a caller intentId verbatim into session.write", async () => {
    const session = fakeSession();
    const target: { centraid?: unknown } = {};
    installInlineCentraid({
      appId: "tasks",
      session,
      queries: noQueries,
      target,
    });
    const outcome = await client(target).write<{
      status: string;
      invocationId: string;
    }>({
      action: "set-status",
      input: { task_id: "t1" },
      intentId: "intent-xyz",
    });
    expect(session.writes).toStrictEqual([
      {
        action: "set-status",
        input: { task_id: "t1" },
        intentId: "intent-xyz",
      },
    ]);
    expect(outcome.status).toBe("executed");
    expect(outcome.invocationId).toBe("intent-xyz");
  });

  it("never presents an online-only Locker secret to the replica session", async () => {
    const session = fakeSession();
    const target: { centraid?: unknown } = {};
    installInlineCentraid({
      appId: "locker",
      session,
      queries: noQueries,
      target,
      pendingProjection: lockerPendingProjection,
    });
    const secretInput = {
      type: "login",
      title: "Bank",
      password: "do-not-persist",
    };
    const offline = new TypeError("gateway unreachable");
    doFetch.mockRejectedValue(offline);

    await expect(
      client(target).write({
        action: "add-item",
        input: secretInput,
        onlineOnly: true,
      })
    ).rejects.toBe(offline);

    expect(session.write).not.toHaveBeenCalled();
    expect(session.writes).toStrictEqual([]);
    expect(doFetch).toHaveBeenCalledWith(
      "https://gw.test",
      "/centraid/locker/actions/add-item",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ input: secretInput }),
      })
    );
  });

  it("exposes vault-resident Commons intents as a durable app overlay", async () => {
    const session = fakeSession();
    const target: { centraid?: unknown } = {};
    installInlineCentraid({
      appId: "tally",
      queries: noQueries,
      target,
      scopes: [
        {
          scope: { id: "member-vault", label: "Asha", canWrite: true },
          session,
        },
      ],
    });
    doFetch.mockResolvedValue(new Response("{}"));
    readJson.mockResolvedValue({
      intents: [
        {
          intentId: "intent-1",
          grantId: "grant-1",
          actorPartyId: "party-member",
          command: "tally.add-expense",
          inputJson: JSON.stringify({
            group_id: "group-1",
            description: "Dinner",
          }),
          status: "parked",
          reason: null,
          stewardLabel: "Priya's device",
          createdAt: "2026-08-10T00:00:00.000Z",
          settledAt: null,
        },
      ],
    });

    const intents = await (
      target.centraid as InlineCentraidClient
    ).commonsIntents();

    expect(doFetch).toHaveBeenCalledWith(
      "https://gw.test",
      "/centraid/_gateway/commons/intents?actorVaultId=member-vault",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      })
    );
    expect(intents).toStrictEqual([
      {
        intentId: "intent-1",
        grantId: "grant-1",
        actorPartyId: "party-member",
        command: "tally.add-expense",
        input: { group_id: "group-1", description: "Dinner" },
        status: "parked",
        reason: "Waiting for Priya's device.",
        stewardLabel: "Priya's device",
        createdAt: "2026-08-10T00:00:00.000Z",
      },
    ]);
  });

  it("carries the linked peer party identity into Commons creation", async () => {
    const session = fakeSession();
    const target: { centraid?: unknown } = {};
    installInlineCentraid({
      appId: "tally",
      queries: noQueries,
      target,
      scopes: [
        {
          scope: { id: "owner-vault", label: "Priya", canWrite: true },
          session,
        },
      ],
    });
    doFetch.mockResolvedValue(new Response("{}"));
    readJson.mockResolvedValue({ grant: { grantId: "grant-1" } });

    await (target.centraid as InlineCentraidClient).share({
      sourceVaultId: "owner-vault",
      containerType: "tally.group",
      containerId: "group-1",
      members: [
        {
          partyId: "party-peer",
          vaultId: "remote-vault",
          capability: "read+write",
        },
      ],
    });

    expect(doFetch).toHaveBeenCalledWith(
      "https://gw.test",
      "/centraid/_gateway/commons",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          originVaultId: "owner-vault",
          containerType: "tally.group",
          containerId: "group-1",
          members: [
            {
              partyId: "party-peer",
              vaultId: "remote-vault",
              capability: "read+write",
            },
          ],
        }),
      })
    );
  });

  it("lists People identities and preserves an invited person without a vault", async () => {
    const session = fakeSession({
      read: vi.fn<Session["read"]>(async (_appId, request) => ({
        rows:
          request.entity === "core.party"
            ? [
                {
                  rowId: "owner",
                  values: { party_id: "owner", display_name: "Priya" },
                  oversizedFields: [],
                  hasUnavailableFields: false,
                },
                {
                  rowId: "asha",
                  values: { party_id: "asha", display_name: "Asha" },
                  oversizedFields: [],
                  hasUnavailableFields: false,
                },
              ]
            : [
                {
                  rowId: "vault",
                  values: { owner_party_id: "owner" },
                  oversizedFields: [],
                  hasUnavailableFields: false,
                },
              ],
        cursor: { epoch: "e", seq: 1 },
        dependency: { shapeId: "people", entity: request.entity },
      })),
    });
    const target: { centraid?: unknown } = {};
    installInlineCentraid({
      appId: "docs",
      session,
      queries: noQueries,
      target,
    });
    doFetch.mockResolvedValue(new Response("{}"));
    readJson.mockResolvedValue({ links: [] });

    await expect(
      (target.centraid as InlineCentraidClient).shareTargets()
    ).resolves.toStrictEqual([{ partyId: "asha", label: "Asha" }]);
  });

  it("lists only deliberate Tally-backed named circles with their roster", async () => {
    const session = fakeSession({
      read: vi.fn<Session["read"]>(async (appId, request) => {
        const values =
          appId === "people" && request.entity === "core.party"
            ? [
                { party_id: "owner", display_name: "Priya" },
                { party_id: "asha", display_name: "Asha" },
                { party_id: "ben", display_name: "Ben" },
              ]
            : appId === "people" && request.entity === "core.vault"
              ? [{ owner_party_id: "owner" }]
              : request.entity === "social.circle"
                ? [
                    {
                      circle_id: "trip",
                      name: "Goa trip",
                      owner_party_id: "owner",
                    },
                    {
                      circle_id: "implicit",
                      name: "Shared photo",
                      owner_party_id: "owner",
                    },
                    {
                      circle_id: "foreign",
                      name: "Asha's group",
                      owner_party_id: "asha",
                    },
                    {
                      circle_id: "incomplete",
                      name: "Old group",
                      owner_party_id: "owner",
                    },
                  ]
                : request.entity === "social.circle_member"
                  ? [
                      {
                        member_id: "m0",
                        circle_id: "trip",
                        party_id: "owner",
                        capability: "read+write",
                      },
                      {
                        member_id: "m1",
                        circle_id: "trip",
                        party_id: "asha",
                        capability: "read",
                      },
                      {
                        member_id: "m2",
                        circle_id: "trip",
                        party_id: "ben",
                        capability: "read+write",
                      },
                      {
                        member_id: "m3",
                        circle_id: "incomplete",
                        party_id: "missing-directory-party",
                        capability: "read",
                      },
                    ]
                  : request.entity === "tally.group"
                    ? [
                        { group_id: "g1", circle_id: "trip" },
                        { group_id: "g2", circle_id: "foreign" },
                        { group_id: "g3", circle_id: "incomplete" },
                      ]
                    : [];
        return {
          rows: values.map((row, index) => ({
            rowId: String(index),
            values: row,
            oversizedFields: [],
            hasUnavailableFields: false,
          })),
          cursor: { epoch: "e", seq: 1 },
          dependency: { shapeId: appId, entity: request.entity },
        };
      }),
    });
    const target: { centraid?: unknown } = {};
    installInlineCentraid({
      appId: "docs",
      session,
      queries: noQueries,
      target,
    });
    doFetch.mockResolvedValue(new Response("{}"));
    readJson.mockResolvedValue({ links: [] });

    await expect(
      (target.centraid as InlineCentraidClient).shareCircles()
    ).resolves.toStrictEqual([
      {
        circleId: "trip",
        label: "Goa trip",
        members: [
          { partyId: "asha", capability: "read" },
          { partyId: "ben", capability: "read+write" },
        ],
      },
    ]);
  });

  it("sends a party-only invitation without inventing a vault", async () => {
    const session = fakeSession();
    const target: { centraid?: unknown } = {};
    installInlineCentraid({
      appId: "docs",
      session,
      queries: noQueries,
      target,
      scopes: [
        {
          scope: { id: "owner-vault", label: "Priya", canWrite: true },
          session,
        },
      ],
    });
    doFetch.mockResolvedValue(new Response("{}"));
    readJson.mockResolvedValue({ grant: { grantId: "grant-1" } });

    await (target.centraid as InlineCentraidClient).share({
      sourceVaultId: "owner-vault",
      containerType: "core.document",
      containerId: "doc-1",
      members: [{ partyId: "asha", capability: "read" }],
      circleId: "trip-circle",
    });

    expect(doFetch).toHaveBeenCalledWith(
      "https://gw.test",
      "/centraid/_gateway/commons",
      expect.objectContaining({
        body: JSON.stringify({
          originVaultId: "owner-vault",
          containerType: "core.document",
          containerId: "doc-1",
          members: [{ partyId: "asha", capability: "read" }],
          circleId: "trip-circle",
        }),
      })
    );
  });

  it("detects and retains an exact receiver-resident Commons row", async () => {
    const session = fakeSession();
    const target: { centraid?: unknown } = {};
    installInlineCentraid({
      appId: "docs",
      session,
      queries: noQueries,
      target,
      scopes: [
        {
          scope: { id: "member-vault", label: "Mine", canWrite: true },
          session,
        },
      ],
    });
    doFetch.mockResolvedValue(new Response("{}"));
    readJson
      .mockResolvedValueOnce({
        items: [
          {
            grantId: "grant-1",
            itemType: "core.document",
            itemId: "doc-1",
            originItemId: "origin-doc",
          },
        ],
      })
      .mockResolvedValueOnce({ retained: true, grantIds: ["grant-1"] });

    const residentClient = target.centraid as InlineCentraidClient;
    await expect(
      residentClient.commonsResidents("member-vault")
    ).resolves.toMatchObject([{ itemType: "core.document", itemId: "doc-1" }]);
    await expect(
      residentClient.retainCommonsItem({
        actorVaultId: "member-vault",
        itemType: "core.document",
        itemId: "doc-1",
      })
    ).resolves.toMatchObject({ retained: true });
    expect(doFetch).toHaveBeenNthCalledWith(
      1,
      "https://gw.test",
      "/centraid/_gateway/commons/resident?actorVaultId=member-vault",
      expect.any(Object)
    );
    expect(doFetch).toHaveBeenNthCalledWith(
      2,
      "https://gw.test",
      "/centraid/_gateway/commons/retain",
      expect.objectContaining({
        body: JSON.stringify({
          actorVaultId: "member-vault",
          itemType: "core.document",
          itemId: "doc-1",
        }),
      })
    );
  });

  it("runs the local query module for a read", async () => {
    const session = fakeSession();
    const queries: InlineAppModule["queries"] = {
      board: {
        default: async ({ input }) => ({
          open: [{ task_id: "a" }],
          limit: input?.limit,
        }),
      },
    };
    const target: { centraid?: unknown } = {};
    installInlineCentraid({
      appId: "tasks",
      session,
      queries,
      target,
      isOnline: () => true,
    });
    const res = await client(target).read<{ open: unknown[]; limit: unknown }>({
      query: "board",
      input: { limit: 5 },
    });
    expect(res.open).toHaveLength(1);
    expect(res.limit).toBe(5);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("falls back to the gateway query route only on ONLINE_ONLY", async () => {
    doFetch.mockResolvedValue(new Response("{}"));
    readJson.mockResolvedValue({ open: ["from-gateway"] });
    const session = fakeSession();
    const onlineOnly = Object.assign(new Error("needs online"), {
      code: "ONLINE_ONLY",
    });
    const queries: InlineAppModule["queries"] = {
      board: {
        default: () => {
          throw onlineOnly;
        },
      },
    };
    const target: { centraid?: unknown } = {};
    installInlineCentraid({
      appId: "tasks",
      session,
      queries,
      target,
      isOnline: () => true,
    });
    const res = await client(target).read<{ open: unknown[] }>({
      query: "board",
    });
    expect(res.open).toStrictEqual(["from-gateway"]);
    expect(doFetch).toHaveBeenCalledWith(
      "https://gw.test",
      "/centraid/tasks/queries/board",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("does NOT fall back for a non-fallback error", async () => {
    const session = fakeSession();
    const queries: InlineAppModule["queries"] = {
      board: {
        default: () => {
          throw new Error("plain boom");
        },
      },
    };
    const target: { centraid?: unknown } = {};
    installInlineCentraid({ appId: "tasks", session, queries, target });
    await expect(client(target).read({ query: "board" })).rejects.toThrow(
      "plain boom"
    );
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("maps replica invalidations to the kit change-feed shape via onChange", () => {
    const session = fakeSession();
    const target: { centraid?: unknown } = {};
    installInlineCentraid({
      appId: "tasks",
      session,
      queries: noQueries,
      target,
    });
    const seen: Array<{ tables?: string[] }> = [];
    client(target).onChange((detail) => seen.push(detail));
    session.subscribers[0]?.([
      {
        shapeId: "s",
        entity: "schedule.task",
        source: "canonical",
      } as ReplicaInvalidation,
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.tables).toStrictEqual(["schedule.task"]);
  });

  it("place() posts to the edges route with a single-item scope and folds the reply back into the old placement wire shape", async () => {
    const session = fakeSession();
    const target: { centraid?: unknown } = {};
    installInlineCentraid({
      appId: "photos",
      queries: noQueries,
      target,
      scopes: [
        {
          scope: { id: "vault-a", label: "Personal", canWrite: true },
          session,
        },
        { scope: { id: "vault-b", label: "Family", canWrite: true }, session },
      ],
    });
    doFetch.mockResolvedValue(new Response("{}"));
    readJson.mockResolvedValue({
      edgeId: "link-1",
      status: "completed",
      itemIds: ["asset-1"],
      accessReceiptId: "receipt-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });

    const inlineClient = target.centraid as InlineCentraidClient;
    const result = await inlineClient.place({
      linkToken: "link-1",
      kind: "add",
      itemType: "media.media_asset",
      itemId: "asset-1",
      sourceVaultId: "vault-a",
      targetVaultId: "vault-b",
    });

    expect(doFetch).toHaveBeenCalledWith(
      "https://gw.test",
      "/centraid/_gateway/edges",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          edgeId: "link-1",
          originVaultId: "vault-a",
          audienceVaultId: "vault-b",
          mode: "snapshot",
          kind: "add",
          itemType: "media.media_asset",
          itemIds: ["asset-1"],
          verbs: "read",
        }),
      })
    );
    // The signature and result shape every caller (photos' copyToVault,
    // AudiencePlacement, the mobile outbox) reads are unchanged: one item in,
    // one item out, and the edge's terminal 'completed' reads as 'executed'.
    expect(result).toStrictEqual({
      linkToken: "link-1",
      kind: "add",
      itemType: "media.media_asset",
      itemId: "asset-1",
      sourceVaultId: "vault-a",
      targetVaultId: "vault-b",
      status: "executed",
      accessReceiptId: "receipt-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
  });

  it("restores the previous window.centraid on teardown", () => {
    const session = fakeSession();
    const target: { centraid?: unknown } = { centraid: "prior" };
    const teardown = installInlineCentraid({
      appId: "tasks",
      session,
      queries: noQueries,
      target,
    });
    expect(target.centraid).not.toBe("prior");
    teardown();
    expect(target.centraid).toBe("prior");
  });
});
