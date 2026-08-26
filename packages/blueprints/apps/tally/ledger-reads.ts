// THE ROOM'S DATA PLANE: the five reads, the one write door, and the three
// facts a screen is allowed to state about how fresh it is.
//
// Lifted out of `app-root.tsx` because it is one concern with one law, and the
// law is easier to hold in a file that does nothing else: THE DASHBOARD IS THE
// SPINE and every route reads it, while a route that needs a second payload —
// a group's ledger, a friend's, the feed — asks for exactly that one and no
// other. A refresh does both together, so a change event can never land the
// spine and the route's own rows a render apart.
//
// NOTHING HERE FOLDS A FIGURE. Every net, share and total arrives derived from
// `queries/dashboard.ts`'s one balance engine; this module moves payloads and
// records when they landed.
import { useCallback, useState } from "react";

import { publishOutcome } from "../_shared/app-frame.tsx";
import type { InlineFrame } from "../inline-types.ts";
import {
  ACTIVITY,
  ADD,
  EXPENSE,
  EXPORT,
  FRIEND,
  GROUP,
  RECEIPT,
  SETTLE,
  SPENDING,
} from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";
import type {
  ActivityData,
  DashboardData,
  FriendData,
  GroupData,
} from "./types.ts";
import { PARKED_OUTCOME, REFUSED } from "./view-copy.ts";
import type { TallyWrite } from "./writes.ts";

/** The vault entities this app's queries read — the shell's
 *  change-subscription filter, unchanged by the interface's removal. */
export const CHANGE_TABLES = [
  "tally.expense",
  "tally.expense_split",
  "tally.expense_receipt",
  "tally.expense_line_item",
  "tally.expense_line_allocation",
  "tally.recurring_expense",
  "schedule.recurrence_exception",
  "core.content_item",
  "tally.settlement",
  "tally.friend",
  "tally.group",
  "social.circle",
  "social.circle_member",
  "core.party",
  "core.vault",
  "tally",
];

/**
 * Which routes need ONE GROUP'S OWN READ standing behind them.
 *
 * The group ledger obviously does. So do the four composing routes, and for a
 * reason worth stating: the dashboard carries a group's name and its member
 * COUNT, never its member ids — and Add expense cannot draw a payer chip set,
 * an allocation table or a re-validated splits map out of a count. The same
 * read answers all five, so choosing a group on the editor asks for exactly
 * one more payload and no other.
 */
const GROUP_BACKED: ReadonlySet<string> = new Set([
  String(GROUP),
  String(ADD),
  String(SETTLE),
  String(EXPENSE),
  String(RECEIPT),
  String(EXPORT),
]);

function needsGroup(shelf: ShelfId): boolean {
  return GROUP_BACKED.has(String(shelf));
}

const EMPTY_DASHBOARD: DashboardData = {
  me: null,
  currency: "USD",
  friends: [],
  groups: [],
  trash: [],
  recurring: [],
  owe_total_minor: 0,
  owed_total_minor: 0,
};

export interface LedgerReads {
  dashboard: DashboardData;
  group: GroupData | null;
  friend: FriendData | null;
  activity: ActivityData | null;
  /** A read has LANDED. False covers both "still in flight" and "every read so
   *  far failed": in neither case may a view claim a set is empty. */
  loaded: boolean;
  /** A denied read, as the query reported it. Denial is DATA. */
  consent: { message: string } | null;
  /** A read that actually came back failed — evidence, not a guess. */
  readFailed: boolean;
  /** The clock the whole room reads, so a day heading and the rows under it
   *  cannot straddle midnight and disagree about what "today" is. */
  now: string;
  /** When the last read that ACTUALLY LANDED did. */
  matchedAt: string | null;
  /** How many of this member's own writes have not settled, and whether one is
   *  parked on a steward. Read from the durable intent overlay the host holds
   *  — never counted off rows, which would miss the writes whose rows this
   *  route did not load. */
  queued: number;
  parked: boolean;
  refresh: () => Promise<void>;
  /** Resolves `true` when the write actually landed, so a caller can close the
   *  surface it was composed on — and leave it standing, with the vault's own
   *  reason on the status line, when it did not. */
  write: (
    write: TallyWrite,
    extra?: { outcome?: string; undo?: () => void }
  ) => Promise<boolean>;
  /** Put a sentence on the frame's ONE status line, for the acts that do not
   *  go through `write` — the outbox's own doors, and a verb that only tells
   *  the member something. */
  say: (text: string) => void;
  /** Drop a cached payload the member is navigating away from, so the next
   *  group's ledger never paints under the previous group's name. */
  forget: (which: "group" | "friend") => void;
}

/** Everything one landed read leaves behind, as ONE value.
 *
 * A single state object rather than the ref bag the rest of the room uses: the
 * whole point of the bag is that a dozen independent mutations must not cost a
 * dozen renders, and a read is not a dozen mutations — it is one moment, and
 * every field below is decided in that one moment. Setting it once per read
 * means the dashboard and the route's own payload can never be a render apart.
 */
interface Snapshot {
  dashboard: DashboardData;
  group: GroupData | null;
  friend: FriendData | null;
  activity: ActivityData | null;
  loaded: boolean;
  consent: { message: string } | null;
  readFailed: boolean;
  now: string;
  matchedAt: string | null;
  queued: number;
  parked: boolean;
}

const EMPTY_SNAPSHOT: Snapshot = {
  dashboard: EMPTY_DASHBOARD,
  group: null,
  friend: null,
  activity: null,
  loaded: false,
  consent: null,
  readFailed: false,
  now: "",
  matchedAt: null,
  queued: 0,
  parked: false,
};

/** How many of this member's writes are in flight, and whether one is parked
 *  on a steward. Absent on a host that holds no intent overlay, and then the
 *  notices simply have nothing to declare. */
async function readIntents(): Promise<{ queued: number; parked: boolean }> {
  try {
    const intents = (await window.centraid.commonsIntents?.()) ?? [];
    return {
      queued: intents.filter((intent) => intent.status === "queued").length,
      parked: intents.some((intent) => intent.status === "parked"),
    };
  } catch {
    return { queued: 0, parked: false };
  }
}

export function useLedgerReads(args: {
  shelf: ShelfId;
  openGroupId: string | null;
  openFriendId: string | null;
  frame: InlineFrame;
}): LedgerReads {
  const { shelf, openGroupId, openFriendId, frame } = args;
  const [snapshot, setSnapshot] = useState<Snapshot>(() => ({
    ...EMPTY_SNAPSHOT,
    now: new Date().toISOString(),
  }));

  /** The route's own payload, beside the dashboard spine. A route that needs
   *  no second read asks for none, and gets `null` for the two it did not. */
  const readRoute = useCallback(async (): Promise<
    Pick<Snapshot, "group" | "friend" | "activity">
  > => {
    if (shelf === ACTIVITY || shelf === SPENDING) {
      return {
        group: null,
        friend: null,
        activity: await window.centraid.read<ActivityData>({
          query: "activity",
        }),
      };
    }
    if (needsGroup(shelf) && openGroupId) {
      return {
        group: await window.centraid.read<GroupData>({
          query: "group",
          input: { group_id: openGroupId },
        }),
        friend: null,
        activity: null,
      };
    }
    if (shelf === FRIEND && openFriendId) {
      return {
        group: null,
        friend: await window.centraid.read<FriendData>({
          query: "friend",
          input: { party_id: openFriendId },
        }),
        activity: null,
      };
    }
    return { group: null, friend: null, activity: null };
  }, [shelf, openGroupId, openFriendId]);

  const refresh = useCallback(async (): Promise<void> => {
    let next: DashboardData;
    let route: Pick<Snapshot, "group" | "friend" | "activity">;
    try {
      next = await window.centraid.read<DashboardData>({ query: "dashboard" });
      route = await readRoute();
    } catch {
      setSnapshot((prior) => ({ ...prior, readFailed: true, loaded: true }));
      return;
    }
    const denied = next.vaultDenied;
    const stamp = new Date().toISOString();
    if (denied) {
      // A DENIED READ RENDERS NOTHING, never an empty set: the previous
      // payload is dropped so no figure outlives the grant that produced it.
      setSnapshot({
        ...EMPTY_SNAPSHOT,
        loaded: true,
        consent: { message: denied.message ?? "" },
        now: stamp,
        matchedAt: stamp,
      });
      return;
    }
    const intents = await readIntents();
    setSnapshot({
      ...route,
      dashboard: next,
      loaded: true,
      consent: null,
      readFailed: false,
      now: stamp,
      matchedAt: stamp,
      ...intents,
    });
  }, [readRoute]);

  /**
   * Every write goes through ONE door, so every outcome lands on the ONE
   * status line and nothing is swallowed.
   *
   * A REFUSAL IS AN OUTCOME, NOT AN EXCEPTION. `actions/*.ts` catch the vault's
   * own error and answer `{status:'denied', reason}` with a 200, so a door that
   * only watched for a throw would report a refused delete as done. Every
   * non-landing status is narrated in the VAULT'S OWN WORDS — the group that
   * still holds expenses says so itself, and this app does not paraphrase it.
   */
  const write = useCallback(
    async (
      command: TallyWrite,
      extra?: { outcome?: string; undo?: () => void }
    ): Promise<boolean> => {
      let outcome: VaultOutcome | undefined;
      try {
        outcome = await window.centraid.write(command);
      } catch (error) {
        publishOutcome(frame, {
          text: String((error as { message?: string })?.message ?? error),
        });
        return false;
      }
      const status = outcome?.status;
      if (status === "denied" || status === "failed") {
        publishOutcome(frame, {
          text: outcome?.reason ?? outcome?.message ?? REFUSED,
        });
        await refresh();
        return false;
      }
      if (status === "parked") {
        publishOutcome(frame, { text: PARKED_OUTCOME });
        await refresh();
        return true;
      }
      if (extra?.outcome) {
        publishOutcome(frame, {
          text: extra.outcome,
          ...(extra.undo ? { undo: extra.undo } : {}),
        });
      }
      await refresh();
      return true;
    },
    [frame, refresh]
  );

  const say = useCallback(
    (text: string) => publishOutcome(frame, { text }),
    [frame]
  );

  const forget = useCallback((which: "group" | "friend") => {
    setSnapshot((prior) => ({ ...prior, [which]: null }));
  }, []);

  // NO MOUNT EFFECT HERE. The first read, the change subscription and the
  // focus recovery are driven by the COMPONENT (`app-root.tsx`), where they
  // are one effect over `refresh` and `CHANGE_TABLES` — the same shape every
  // other room in this product uses. Owning them here would bury the room's
  // one subscription inside a data module, where nobody looking for "when does
  // this app re-read" would think to look.

  return { ...snapshot, refresh, write, say, forget };
}
