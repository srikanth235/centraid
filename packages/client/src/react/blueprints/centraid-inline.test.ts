import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InlineAppModule } from "@centraid/blueprints/apps/inline-types";
import { lockerPendingProjection } from "@centraid/blueprints/apps/locker/pending-projection";
import { ROUTES } from "@centraid/core/protocol";

import type * as TypeImport_oycips from "../../gateway-client-core.js";
import { OnlineOnlyError } from "../../replica/errors.js";
import type { ReplicaInvalidation } from "../../replica/types.js";
import {
  installInlineCentraid,
  settledPartyIdFromOutcome,
} from "./centraid-inline.js";
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
  VAULT_HEADER: "x-centraid-vault",
}));

type Session = NonNullable<InstallInlineCentraidOptions["session"]>;

/**
 * A page door for the share sheet's walks, keyed by the handler NAME each
 * statement carries — which is what a page is addressed by since #996 W5.
 * Anything unnamed answers empty, exactly as a seat without those tables does.
 */
function sharePages(
  byName: Record<string, Array<Record<string, unknown>>>
): Session["page"] {
  return (async (query: { name: string }) => ({
    rows: byName[query.name] ?? [],
  })) as Session["page"];
}

function fakeSession(overrides?: Partial<Session>): Session & {
  writes: unknown[];
  subscribers: Array<(inv: readonly ReplicaInvalidation[]) => void>;
} {
  const writes: unknown[] = [];
  const subscribers: Array<(inv: readonly ReplicaInvalidation[]) => void> = [];
  return {
    writes,
    subscribers,
    // The app read path (#996 wave 4). A seat holding the file answers here;
    // the seat with no file refuses ONLINE_ONLY, which is a case below.
    page: (async () => ({ rows: [] })) as Session["page"],
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

describe(settledPartyIdFromOutcome, () => {
  it("accepts only an executed intent carrying a real party id", () => {
    expect(
      settledPartyIdFromOutcome({
        status: "executed",
        output: { party_id: "party-cara" },
      })
    ).toBe("party-cara");
  });

  it("refuses an intent still waiting on a steward", () => {
    for (const status of ["queued", "parked", "denied", "cancelled"])
      expect(() =>
        settledPartyIdFromOutcome({
          status,
          output: { party_id: "party-cara" },
        })
      ).toThrow(/did not complete/u);
  });

  it("never hands back the offline overlay's placeholder id", () => {
    expect(() =>
      settledPartyIdFromOutcome({
        status: "executed",
        output: { party_id: "" },
      })
    ).toThrow(/settled identity/u);
  });

  it("refuses an executed intent that returned no identity at all", () => {
    expect(() => settledPartyIdFromOutcome({ status: "executed" })).toThrow(
      /settled identity/u
    );
  });
});

describe(installInlineCentraid, () => {
  beforeEach(() => {
    doFetch.mockReset();
    readJson.mockReset();
  });

  it("reads text bytes through the authenticated blob door in the mounted scope", async () => {
    const session = fakeSession();
    const target: { centraid?: unknown } = {};
    installInlineCentraid({
      appId: "docs",
      session,
      queries: noQueries,
      target,
      scopes: [
        {
          scope: { id: "docs-vault", label: "Docs owner", canWrite: true },
          session,
        },
      ],
    });
    doFetch.mockResolvedValue({
      ok: true,
      text: async () => "The exact document body",
    } as Response);

    const body = await (target.centraid as InlineCentraidClient).blobText(
      "/centraid/_vault/blobs/body-sha"
    );
    expect(body).toBe("The exact document body");
    expect(doFetch.mock.calls).toStrictEqual([
      [
        "https://gw.test",
        "/centraid/_vault/blobs/body-sha",
        {
          headers: {
            Authorization: "Bearer tok",
            "x-centraid-vault": "docs-vault",
          },
        },
      ],
    ]);
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
      page: sharePages({
        "share.targets.parties": [
          { party_id: "owner", display_name: "Priya" },
          { party_id: "asha", display_name: "Asha" },
        ],
        "share.targets.vault": [{ self_party_id: "owner" }],
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
      (target.centraid as InlineCentraidClient).shareTargets()
    ).resolves.toStrictEqual([{ partyId: "asha", label: "Asha" }]);
  });

  it("lists only deliberate Tally-backed named circles with their roster", async () => {
    const session = fakeSession({
      page: sharePages({
        "share.circles.vault": [{ self_party_id: "owner" }],
        "share.circles": [
          { circle_id: "trip", name: "Goa trip", owner_party_id: "owner" },
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
        ],
        // NO `capability` COLUMN, because `social_circle_member` has none —
        // the old declarative fixture invented one out of a shape's column
        // list, and the roster answered with a capability the vault never
        // stored. A circle offered as a destination shares read; the grant
        // raises a member to write.
        "share.circle-members": [
          { member_id: "m0", circle_id: "trip", party_id: "owner" },
          { member_id: "m1", circle_id: "trip", party_id: "asha" },
          { member_id: "m2", circle_id: "trip", party_id: "ben" },
          {
            member_id: "m3",
            circle_id: "incomplete",
            party_id: "missing-directory-party",
          },
        ],
        "share.tally-groups": [
          { group_id: "g1", circle_id: "trip" },
          { group_id: "g2", circle_id: "foreign" },
          { group_id: "g3", circle_id: "incomplete" },
        ],
        "share.targets.parties": [
          { party_id: "owner", display_name: "Priya" },
          { party_id: "asha", display_name: "Asha" },
          { party_id: "ben", display_name: "Ben" },
        ],
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
          { partyId: "ben", capability: "read" },
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

  it("answers ctx.vault.page from the seat's own file, with no network", async () => {
    // The positive half of the pair below: the binding an app's reads use now
    // carries `page`, so a seat holding the vault answers the handler locally.
    const page = vi.fn<
      () => Promise<{
        rows: { task_id: string }[];
        next: { sortKey: string; pk: string };
      }>
    >(async () => ({
      rows: [{ task_id: "t-2" }, { task_id: "t-1" }],
      next: { sortKey: "t-1", pk: "t-1" },
    }));
    const session = fakeSession({ page: page as unknown as Session["page"] });
    const queries: InlineAppModule["queries"] = {
      board: {
        default: async ({ ctx }) =>
          (await (
            ctx as {
              vault: {
                page: (request: unknown) => Promise<{ rows: unknown[] }>;
              };
            }
          ).vault.page({
            query: {
              name: "tasks.board",
              select: "task_id",
              from: "schedule_task",
              order: {
                sortColumn: "task_id",
                pkColumn: "task_id",
                descending: true,
              },
            },
            limit: 20,
          })) as unknown,
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
    const res = await client(target).read<{
      rows: { task_id: string }[];
      next?: { pk: string };
    }>({ query: "board" });
    expect(res.rows.map((row) => row.task_id)).toStrictEqual(["t-2", "t-1"]);
    expect(res.next).toStrictEqual({ sortKey: "t-1", pk: "t-1" });
    expect(page).toHaveBeenCalledOnce();
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("falls back even when the handler catches its own vault failure", async () => {
    // EVERY BLUEPRINT HANDLER CATCHES. The board's own `catch` turns a vault
    // failure into `{ vaultDenied }` — a "cannot read this vault" screen — so a
    // seat refusal that only rejects inside the handler is swallowed there and
    // the query never falls back. The guard is what carries it past that catch.
    doFetch.mockResolvedValue(new Response("{}"));
    readJson.mockResolvedValue({ open: ["from-the-door"] });
    const session = fakeSession({
      page: (() =>
        Promise.reject(
          new OnlineOnlyError("this seat holds no copy of the vault")
        )) as Session["page"],
    });
    const queries: InlineAppModule["queries"] = {
      board: {
        default: async ({ ctx }) => {
          try {
            return (await (
              ctx as {
                vault: {
                  page: (request: unknown) => Promise<{ rows: unknown[] }>;
                };
              }
            ).vault.page({
              query: {
                name: "tasks.board",
                select: "task_id",
                from: "schedule_task",
                order: {
                  sortColumn: "task_id",
                  pkColumn: "task_id",
                  descending: true,
                },
              },
              limit: 20,
            })) as unknown;
          } catch {
            return { open: [], vaultDenied: { message: "swallowed" } };
          }
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
    expect(res.open).toStrictEqual(["from-the-door"]);
  });

  it("re-runs the whole query on the gateway when the seat holds no file", async () => {
    // W4-D2 AND R9. `ctx.vault.page` on a seat with no copy of the vault is not
    // an error the app has to handle and not a second read vocabulary: the
    // handler runs on the gateway instead, through the paged door, which serves
    // the SAME statement. The fallback re-runs the QUERY rather than the one
    // page — a page answered on the seat and the next answered on the gateway
    // would be two walks of two orderings.
    doFetch.mockResolvedValue(new Response("{}"));
    readJson.mockResolvedValue({ open: ["from-the-door"] });
    const session = fakeSession({
      page: (() =>
        Promise.reject(
          new OnlineOnlyError("this seat holds no copy of the vault")
        )) as Session["page"],
    });
    const queries: InlineAppModule["queries"] = {
      board: {
        default: async ({ ctx }) =>
          (await (
            ctx as {
              vault: {
                page: (request: unknown) => Promise<{ rows: unknown[] }>;
              };
            }
          ).vault.page({
            query: {
              name: "tasks.board",
              select: "task_id",
              from: "schedule_task",
              order: {
                sortColumn: "task_id",
                pkColumn: "task_id",
                descending: true,
              },
            },
            limit: 20,
          })) as unknown,
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
    expect(res.open).toStrictEqual(["from-the-door"]);
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
      itemType: "media.asset",
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
          itemType: "media.asset",
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
      itemType: "media.asset",
      itemId: "asset-1",
      sourceVaultId: "vault-a",
      targetVaultId: "vault-b",
      status: "executed",
      accessReceiptId: "receipt-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
  });

  it("mints a quick-add person under the People app's identity from an embedding app", async () => {
    const session = fakeSession({
      write: vi.fn<Session["write"]>(async (_appId, input) => ({
        intentId: (input as { intentId?: string }).intentId ?? "gen-1",
        status: "executed",
        output: { party_id: "party-cara" },
      })),
    });
    const target: { centraid?: unknown } = {};
    installInlineCentraid({
      appId: "docs",
      session,
      queries: noQueries,
      target,
      isOnline: () => true,
    });

    await expect(
      (target.centraid as InlineCentraidClient).quickAddPerson({
        name: "  Cara  ",
      })
    ).resolves.toStrictEqual({ partyId: "party-cara", label: "Cara" });
    expect(session.write).toHaveBeenCalledWith(
      "people",
      expect.objectContaining({
        action: "add-person",
        input: { display_name: "Cara", cadence_days: 30 },
      })
    );
  });

  it("refuses a quick-add offline rather than queueing an identity nobody can share to", async () => {
    const session = fakeSession();
    const target: { centraid?: unknown } = {};
    installInlineCentraid({
      appId: "docs",
      session,
      queries: noQueries,
      target,
      isOnline: () => false,
    });

    await expect(
      (target.centraid as InlineCentraidClient).quickAddPerson({ name: "Cara" })
    ).rejects.toThrow(/needs a gateway connection/u);
    expect(session.write).not.toHaveBeenCalled();
  });

  it("refuses a blank quick-add name with a typed refusal", async () => {
    const session = fakeSession();
    const target: { centraid?: unknown } = {};
    installInlineCentraid({
      appId: "docs",
      session,
      queries: noQueries,
      target,
      isOnline: () => true,
    });

    await expect(
      (target.centraid as InlineCentraidClient).quickAddPerson({ name: "   " })
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(session.write).not.toHaveBeenCalled();
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

  it("does not restore a remounted client's predecessor after the live mount tears down", () => {
    const session = fakeSession();
    const target: { centraid?: unknown } = {};
    const first = installInlineCentraid({
      appId: "tasks",
      session,
      queries: noQueries,
      target,
    });
    const firstClient = target.centraid;
    const second = installInlineCentraid({
      appId: "tasks",
      session,
      queries: noQueries,
      target,
    });
    const secondClient = target.centraid;
    expect(secondClient).not.toBe(firstClient);
    first();
    expect(target.centraid).toBe(secondClient);
    second();
    expect(target.centraid).toBeUndefined();
  });

  it("clears window.centraid when only the live mount tears down", () => {
    // Discarded useState initializers publish a client whose teardown never
    // arms. Restoring that predecessor is the goHome hang: Home paints,
    // `window.centraid` stays set.
    const session = fakeSession();
    const target: { centraid?: unknown } = {};
    installInlineCentraid({
      appId: "tasks",
      session,
      queries: noQueries,
      target,
    });
    const live = installInlineCentraid({
      appId: "tasks",
      session,
      queries: noQueries,
      target,
    });
    live();
    expect(target.centraid).toBeUndefined();
  });

  it("answers the grant plane through the host bridge", async () => {
    const session = fakeSession();
    const target: { centraid?: unknown } = {};
    installInlineCentraid({
      appId: "docs",
      session,
      queries: noQueries,
      target,
    });
    doFetch.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ subjects: [] }),
    } as Response);

    await expect(
      (target.centraid as InlineCentraidClient).grants.subjects()
    ).resolves.toStrictEqual({ subjects: [] });
    expect(doFetch.mock.calls[0]?.[1]).toBe(ROUTES.vaultGrantSubjects);
  });
});
