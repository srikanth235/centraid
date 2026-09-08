/*
 * THE SHARED SURFACES, AGAINST A REAL VAULT (#929).
 *
 * `apps/docs/queries/shares.test.ts` and its siblings drive the handlers with
 * a hand-written `ctx` — they hold the QUERY PLAN, and a plan can name a table
 * the vault does not have and still pass. This suite runs the same shipped
 * handlers over the golden pair's own vaults, through the gateway that clamps
 * to the shipped manifest's scopes, after a subscription has actually been
 * delivered. A scope the manifest forgot, a column that moved, an entity that
 * was deleted: all three fail here and only here.
 */

import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import {
  createShareGrant,
  nowIso,
  startShareSubscription,
  uuidv7,
} from "@centraid/vault";

import { link, makeSide } from "./peer-give.test-fixtures.js";
import type { Side } from "./peer-give.test-fixtures.js";
import {
  addAudienceParty,
  addLocalParty,
  appQueryCtx,
  seedEverySubject,
  wireGoldenPair,
} from "./share-subscription-peer.test-fixtures.js";
import { sweepShareSubscriptions } from "./share-subscription-sweep.js";

// Two real vaults, a real closure and a real delivery: cold setup under the
// concurrent gate can exceed the small unit default.
vi.setConfig({ testTimeout: 60_000 });

type BlueprintQuery = (args: never) => Promise<unknown>;

/**
 * Loaded through a COMPUTED specifier. A blueprint handler is written against
 * blueprints' own ambient `HandlerCtx`, which this package's tsconfig cannot
 * see, so a literal import would make tsc typecheck a module it has no types
 * for. Node resolves this at run time, which is the resolution the test needs.
 */
async function blueprintQuery(specifier: string): Promise<BlueprintQuery> {
  const loaded = (await import(specifier)) as { default: BlueprintQuery };
  return loaded.default;
}

let driveQuery: BlueprintQuery;
let searchQuery: BlueprintQuery;
let personQuery: BlueprintQuery;

interface DriveDoc {
  document_id: string;
  shared_with: Array<{
    grant_id: string;
    circle_id: string | null;
    audience: string;
    label: string;
    via: string;
    member_count: number;
    pending_count: number;
    members: Array<{ party_id: string; status: string; capability: string }>;
  }> | null;
  shared_from: { vault_id: string; name: string | null; at: number } | null;
}

interface DrivePayload {
  documents: DriveDoc[];
  shared_from_known: boolean;
}

const runDrive = async (side: Side): Promise<DrivePayload> =>
  (await driveQuery({
    input: {},
    ...appQueryCtx(side, "docs"),
  } as never)) as unknown as DrivePayload;

interface DeliveredPair {
  origin: Side;
  audience: Side;
  audienceParty: string;
  documentId: string;
}

/**
 * ONE pair for the whole suite. Two real vaults with a photo, an album, a
 * document, a folder and a Tally sub-graph each cost real bytes in the CAS,
 * and building one per assertion is how a shared runner runs out of disk.
 */
async function deliveredPair(): Promise<DeliveredPair> {
  const origin = makeSide("surf-origin");
  const audience = makeSide("surf-audience");
  await link(origin, audience);
  const audienceParty = addAudienceParty(origin, audience);
  const subjects = seedEverySubject(origin, addLocalParty(origin, "Ledger"));
  const document = subjects.find((s) => s.subjectType === "core.document")!;
  const granted = createShareGrant(origin.vault.vault, {
    audience: { kind: "party", id: audienceParty },
    subjectType: "core.document",
    subjectId: document.subjectId,
    capability: "view",
    grantedAt: nowIso(),
    grantedBy: origin.ownerPartyId,
  });
  // The commit-path pass queues the delivery and names the route; the sweep
  // below is what dials.
  startShareSubscription({
    origin: origin.vault,
    originVaultId: origin.vaultId,
    grantId: granted.grantId,
    transportFor: () => ({
      route: "peer",
      deliver: () => ({ outcome: "unreachable", detail: "queued" }),
      remove: () => ({ outcome: "unreachable", detail: "queued" }),
    }),
    now: nowIso(),
  });
  // People projects a PROFILE, not a bare party: without one the person query
  // answers `null` and the link section is never reached.
  origin.vault.vault
    .prepare(
      `INSERT INTO people_profile
         (profile_id, party_id, role, nickname, avatar_color, cadence_days,
          last_contacted_at, met, created_at)
       VALUES (?, ?, NULL, NULL, NULL, 0, NULL, NULL, ?)`
    )
    .run(uuidv7(), audienceParty, nowIso());
  const { toAudience } = wireGoldenPair(origin, audience);
  const swept = await sweepShareSubscriptions({
    origin: origin.vault,
    originVaultId: origin.vaultId,
    dial: toAudience,
    routeTo: () => ({
      endpointId: audience.endpointId,
      relayHints: [],
      assertedAt: Date.now(),
    }),
    now: nowIso,
  });
  expect(
    swept.map((step) => step.result.outcome),
    JSON.stringify(swept.map((step) => step.result))
  ).toStrictEqual(["delivered"]);
  return { origin, audience, audienceParty, documentId: document.subjectId };
}

describe("the shipped shared surfaces, on the golden pair (#929)", () => {
  let pair: DeliveredPair;

  beforeAll(async () => {
    [driveQuery, searchQuery, personQuery] = await Promise.all([
      blueprintQuery("@centraid/blueprints/apps/docs/queries/drive"),
      blueprintQuery("@centraid/blueprints/apps/docs/queries/search"),
      blueprintQuery("@centraid/blueprints/apps/people/queries/person"),
    ]);
    pair = await deliveredPair();
  });

  afterAll(() => {
    pair.origin.vault.close();
    pair.audience.vault.close();
  });

  describe("the drive's shared surfaces read the subscription plane", () => {
    test("the origin names the person it answered for, and that it landed", async () => {
      const { origin, audience, audienceParty, documentId } = pair;
      {
        const { documents } = await runDrive(origin);
        const row = documents.find((d) => d.document_id === documentId);
        expect(
          row,
          JSON.stringify(documents.map((d) => d.document_id))
        ).toBeDefined();
        const shares = row!.shared_with;
        expect(shares).toHaveLength(1);
        expect(shares?.[0]).toMatchObject({
          audience: "person",
          // A one-person answer names no circle — there is no circle to name.
          circle_id: null,
          label: audience.label,
          via: "document",
          member_count: 1,
          // The sweep delivered it, so nothing is outstanding.
          pending_count: 0,
        });
        expect(shares?.[0]?.members[0]).toMatchObject({
          party_id: audienceParty,
          capability: "read",
          status: "current",
        });
        // The origin holds no subscription of its own for this shape.
        expect(row!.shared_from).toBeNull();
      }
    });

    test("the audience names the vault that placed the row, off shape lineage", async () => {
      const { origin, audience } = pair;
      {
        const { documents, shared_from_known } = await runDrive(audience);
        expect(shared_from_known).toBe(true);
        const placed = documents.filter((doc) => doc.shared_from !== null);
        expect(placed).toHaveLength(1);
        expect(placed[0]?.shared_from).toMatchObject({
          vault_id: origin.vaultId,
          // The AUDIENCE holds no binding naming the origin's party, so the
          // vault answers and the name does not — never an id worn as one.
          name: null,
        });
        // A moment, not a zero: the subscription dates the arrival.
        expect(placed[0]?.shared_from?.at).toBeGreaterThan(0);
        // Nothing was shared ONWARD from here.
        expect(placed[0]?.shared_with).toStrictEqual([]);
      }
    });

    test("a search hit carries the same answer a browsed row does", async () => {
      const { origin, documentId } = pair;
      {
        const found = (await searchQuery({
          input: { term: "Plan" },
          ...appQueryCtx(origin, "docs"),
        } as never)) as unknown as { documents: DriveDoc[] };
        const row = found.documents.find((d) => d.document_id === documentId);
        expect(row?.shared_with?.[0]).toMatchObject({
          audience: "person",
          via: "document",
        });
      }
    });
  });

  describe("People's link section reads the binding plane", () => {
    test("the linked vault answers, and no invitation list is claimed", async () => {
      const { origin, audience, audienceParty } = pair;
      {
        const answered = (await personQuery({
          input: { party_id: audienceParty },
          ...appQueryCtx(origin, "people"),
        } as never)) as unknown as {
          person: { vaults: Array<{ vault_id: string }> | null } | null;
        };
        expect(answered.person?.vaults).toStrictEqual([
          expect.objectContaining({ vault_id: audience.vaultId }),
        ]);
        // ABSENT, NOT EMPTY: the field is gone, not answered with `[]`.
        expect(answered.person).not.toHaveProperty("pending_invites");
      }
    });
  });
});
