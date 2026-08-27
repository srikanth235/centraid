// THE READ PLANE, EXERCISED.
//
// Four claims a plausible refactor could undo silently:
//
//  1. NOTHING IS EMPTY UNTIL A READ HAS LANDED. `loaded` is false before the
//     first answer and stays false when the answer was a failure, so no view
//     can call the ledger empty on the strength of an outage.
//  2. A DENIED READ IS DATA. It becomes a screen, not an error, and the
//     denial is carried whichever query reported it — the grant is on the app.
//  3. A SLOWER ANSWER TO AN OLDER QUERY NEVER OVERWRITES A NEWER ONE, and a
//     cleared field drops the previous results rather than leaving them
//     standing under a query nobody typed.
//  4. FORGETTING IS REAL. Navigating away drops the payload, so the next
//     group's ledger cannot paint under the previous group's name.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DashboardData,
  GroupData,
  SearchData,
} from "@centraid/blueprints/apps/tally/types";

type Answer = () => Promise<unknown>;

const answers = {
  activity: vi.fn<Answer>(),
  dashboard: vi.fn<Answer>(),
  export: vi.fn<(groupId: string) => Promise<unknown>>(),
  friend: vi.fn<(partyId: string) => Promise<unknown>>(),
  group: vi.fn<(groupId: string) => Promise<unknown>>(),
  history: vi.fn<(expenseId: string) => Promise<unknown>>(),
  search: vi.fn<(term: string) => Promise<unknown>>(),
};

// The gateway door, replaced wholesale. The cast is the mock's: every handler
// answers `unknown` here because each test supplies the shape it needs, and a
// factory typed to the real payloads would make every fixture a full payload.
vi.mock(
  import("./tally-gateway"),
  () =>
    ({
      EXPORT_WINDOW: 2000,
      tallyActivity: () => answers.activity(),
      tallyDashboard: () => answers.dashboard(),
      tallyExport: (groupId: string) => answers.export(groupId),
      tallyFriend: (partyId: string) => answers.friend(partyId),
      tallyGroup: (groupId: string) => answers.group(groupId),
      tallyHistory: (expenseId: string) => answers.history(expenseId),
      tallySearch: (term: string) => answers.search(term),
    }) as unknown as typeof import("./tally-gateway")
);

const {
  forgetTally,
  loadTallyGroup,
  openTally,
  readTallyVault,
  resetTallyVault,
  searchTally,
  showMoreTallyActivity,
} = await import("./tally-store");

const DASHBOARD: DashboardData = {
  currency: "GBP",
  friends: [],
  groups: [],
  me: "owner",
  owe_total_minor: 10_960,
  owed_total_minor: 8100,
  recurring: [],
  trash: [],
};

function groupPayload(name: string): GroupData {
  return {
    currency: "GBP",
    group: { group_id: name, name },
    ledger: [],
    me: "owner",
    members: [],
  };
}

function searchPayload(term: string): SearchData {
  return {
    currency: "GBP",
    me: "owner",
    results: [{ expense_id: term } as never],
  };
}

describe("the Tally read plane", () => {
  beforeEach(() => {
    resetTallyVault();
    for (const answer of Object.values(answers)) answer.mockReset();
  });

  afterEach(() => {
    resetTallyVault();
  });

  describe("the spine", () => {
    it("is not loaded before the first answer", () => {
      expect(readTallyVault().loaded).toBe(false);
    });

    it("stays not-loaded when the read failed — an outage is not an empty vault", async () => {
      answers.dashboard.mockRejectedValue(new Error("gateway unreachable"));
      await openTally();
      const state = readTallyVault();
      expect(state.loaded).toBe(false);
      expect(state.readError).toContain("gateway unreachable");
      expect(state.dashboard.friends).toStrictEqual([]);
    });

    it("lands the payload and stamps when it matched", async () => {
      answers.dashboard.mockResolvedValue(DASHBOARD);
      await openTally();
      const state = readTallyVault();
      expect(state.loaded).toBe(true);
      expect(state.stale).toBe(false);
      expect(state.lastReadAt).not.toBeNull();
      expect(state.dashboard.owed_total_minor).toBe(8100);
    });

    it("turns a refusal into data rather than an error", async () => {
      answers.dashboard.mockResolvedValue({
        ...DASHBOARD,
        vaultDenied: { code: "denied", revoked_at: "2026-08-26T09:02:00.000Z" },
      });
      await openTally();
      expect(readTallyVault().denied?.revoked_at).toBe(
        "2026-08-26T09:02:00.000Z"
      );
      expect(readTallyVault().loaded).toBe(true);
    });
  });

  describe("a route's own payload", () => {
    it("is dropped when the member navigates away", async () => {
      answers.group.mockResolvedValue(groupPayload("Sitwell Road"));
      await loadTallyGroup("Sitwell Road");
      expect(readTallyVault().group?.group?.name).toBe("Sitwell Road");
      forgetTally("group");
      expect(readTallyVault().group).toBeNull();
    });

    it("asks for nothing when there is no group to ask about", async () => {
      await loadTallyGroup("");
      expect(answers.group).not.toHaveBeenCalled();
    });
  });

  describe("search", () => {
    it("drops the previous answer the moment the field is cleared", async () => {
      answers.search.mockResolvedValue(searchPayload("ferry"));
      await searchTally("ferry");
      expect(readTallyVault().search.data?.results).toHaveLength(1);
      await searchTally("   ");
      expect(readTallyVault().search.data).toBeNull();
      expect(readTallyVault().search.searching).toBe(false);
    });

    it("never lets a slower older answer overwrite a newer query", async () => {
      let releaseSlow = (): void => undefined;
      answers.search.mockImplementation((term: string) =>
        term === "slow"
          ? new Promise((resolve) => {
              releaseSlow = () => resolve(searchPayload("slow"));
            })
          : Promise.resolve(searchPayload(term))
      );
      const slow = searchTally("slow");
      await searchTally("fast");
      releaseSlow();
      await slow;
      expect(readTallyVault().search.term).toBe("fast");
      expect(readTallyVault().search.data?.results[0]?.expense_id).toBe("fast");
    });
  });

  describe("the feed's window", () => {
    it("opens one page further, and never shrinks", () => {
      const before = readTallyVault().window;
      showMoreTallyActivity();
      expect(readTallyVault().window).toBeGreaterThan(before);
    });
  });
});
