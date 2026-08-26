// The sharing plane People projects per person (#821): linked/unlinked
// on the roster, the vaults / pending invitations / shared containers on the
// profile, and the linked / to_link headline counts.
//
// The load-bearing case is the SECOND one in each pair. People's `share.*`
// scopes are newer than the app, and on an existing vault newly declared
// scopes wait for the owner rather than being auto-granted — so a denial of
// those reads must leave the link fields absent (null) while the roster, the
// profile and the four original counts answer in full. A regression here does
// not read as a bug; it reads as "nobody is linked", which is worse.
import { describe, expect, it, vi } from "vitest";

import dashboardHandler from "./dashboard.ts";
import peopleHandler from "./people.ts";
import personHandler from "./person.ts";

const SHARE_ENTITIES = new Set([
  "share.party_vault_binding",
  "share.circle_grant",
  "share.commons_member_state",
  "share.commons_invitation",
  "social.circle_member",
]);

const ROWS: Record<string, Array<Record<string, unknown>>> = {
  "people.profile": [
    {
      party_id: "party-linked",
      created_at: "2026-01-01T00:00:00Z",
      cadence_days: 30,
      last_contacted_at: "2026-01-02T00:00:00Z",
    },
    {
      party_id: "party-alone",
      created_at: "2026-01-01T00:00:00Z",
      cadence_days: 0,
    },
  ],
  "core.party": [
    { party_id: "party-linked", display_name: "Priya" },
    { party_id: "party-alone", display_name: "Sam" },
  ],
  "core.vault": [{ owner_party_id: "party-owner" }],
  "share.party_vault_binding": [
    {
      binding_id: "binding-1",
      party_id: "party-linked",
      vault_id: "vault-priya",
      linked_at: "2026-02-01T00:00:00Z",
    },
  ],
  "social.circle_member": [
    {
      circle_id: "circle-family",
      party_id: "party-linked",
      capability: "read+write",
    },
  ],
  "share.circle_grant": [
    {
      grant_id: "grant-trip",
      circle_id: "circle-family",
      container_type: "media.album",
      container_id: "album-trip",
      created_at: "2026-03-01T00:00:00Z",
    },
  ],
  "share.commons_member_state": [
    {
      grant_id: "grant-trip",
      party_id: "party-linked",
      status: "current",
      accepted_at: "2026-03-02T00:00:00Z",
    },
  ],
  "share.commons_invitation": [
    {
      invitation_id: "invite-trip",
      grant_id: "grant-trip",
      container_label: "Kerala trip",
      capability: "read+write",
      status: "accepted",
      created_at: "2026-03-01T00:00:00Z",
    },
    {
      invitation_id: "invite-recipes",
      grant_id: "grant-recipes",
      container_label: "Recipes",
      capability: "read",
      status: "pending",
      created_at: "2026-04-01T00:00:00Z",
    },
  ],
};

/** A ctx whose share/social reads either answer from ROWS or throw a denial. */
function ctxOf(shareDenied: boolean) {
  const read = vi.fn<
    (request: { entity: string }) => Promise<{
      rows: Array<Record<string, unknown>>;
    }>
  >(async ({ entity }) => {
    if (shareDenied && SHARE_ENTITIES.has(entity))
      throw Object.assign(new Error("scope awaiting owner approval"), {
        code: "VAULT_CONSENT",
      });
    return { rows: ROWS[entity] ?? [] };
  });
  return { ctx: { vault: { read } } as unknown as HandlerArgs["ctx"], read };
}

describe("People roster link chips (#821)", () => {
  it("marks who is linked to a vault of their own", async () => {
    const result = await peopleHandler({
      input: {},
      ...ctxOf(false),
    } as unknown as HandlerArgs);

    expect(result.links_available).toBe(true);
    expect(
      result.people.map((p: Record<string, unknown>) => [
        p.party_id,
        p.linked,
        p.vault_count,
      ])
    ).toStrictEqual([
      ["party-linked", true, 1],
      ["party-alone", false, 0],
    ]);
  });

  it("keeps the roster whole and the chips absent when share reads deny", async () => {
    const result = await peopleHandler({
      input: {},
      ...ctxOf(true),
    } as unknown as HandlerArgs);

    expect(result.vaultDenied).toBeUndefined();
    expect(result.links_available).toBe(false);
    expect(result.people).toHaveLength(2);
    for (const person of result.people) expect(person.linked).toBeNull();
  });
});

describe("People profile sharing standing (#821)", () => {
  it("reports vaults and pending invitations", async () => {
    const result = await personHandler({
      input: { party_id: "party-linked" },
      ...ctxOf(false),
    } as unknown as HandlerArgs);
    const { person } = result;
    if (person === null) throw new Error("expected a person");

    expect(person.vaults).toStrictEqual([
      {
        binding_id: "binding-1",
        vault_id: "vault-priya",
        linked_at: "2026-02-01T00:00:00Z",
      },
    ]);
    // Only the unanswered invitation — the accepted one is already a share.
    expect(person.pending_invites).toStrictEqual([
      {
        invitation_id: "invite-recipes",
        container_label: "Recipes",
        capability: "read",
        created_at: "2026-04-01T00:00:00Z",
      },
    ]);
    // WHAT IS SHARED WITH THEM IS NOT THIS QUERY'S ANSWER (#825): standing
    // grants come from the grant plane, read live by the person screen.
    expect(person).not.toHaveProperty("shared_with_them");
  });

  it("keeps the profile whole and the sharing fields null when share reads deny", async () => {
    const result = await personHandler({
      input: { party_id: "party-linked" },
      ...ctxOf(true),
    } as unknown as HandlerArgs);

    const { person } = result;
    if (person === null) throw new Error("expected a person");

    expect(result.vaultDenied).toBeUndefined();
    expect(person.name).toBe("Priya");
    expect(person.vaults).toBeNull();
    expect(person.pending_invites).toBeNull();
  });
});

describe("People dashboard counts (#821)", () => {
  it("counts linked / to_link and never calls a cadence-less person overdue", async () => {
    const result = await dashboardHandler({
      input: {},
      ...ctxOf(false),
    } as unknown as HandlerArgs);

    expect(result.counts).toMatchObject({ all: 2, linked: 1, to_link: 1 });
    expect(
      result.reconnect.map((row: Record<string, unknown>) => row.party_id)
    ).not.toContain("party-alone");
  });

  it("nulls the link counts on denial and keeps the original four", async () => {
    const result = await dashboardHandler({
      input: {},
      ...ctxOf(true),
    } as unknown as HandlerArgs);

    expect(result.vaultDenied).toBeUndefined();
    expect(result.counts).toStrictEqual({
      all: 2,
      reconnect: 1,
      upcoming: 0,
      starred: 0,
      linked: null,
      to_link: null,
    });
  });
});
