import { useCallback, useMemo, useState } from "react";

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

export const CHANGE_TABLES = [
  "tally.expense",
  "tally.expense_split",
  "core.attachment",
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
  loaded: boolean;
  consent: { message: string; revokedAt: string | null } | null;
  readFailed: boolean;
  now: string;
  matchedAt: string | null;
  queued: number;
  parked: boolean;
  refresh: () => Promise<void>;
  write: (
    write: TallyWrite,
    extra?: { outcome?: string; undo?: () => void }
  ) => Promise<boolean>;
  say: (text: string) => void;
  forget: (which: "group" | "friend") => void;
}

interface Snapshot {
  dashboard: DashboardData;
  group: GroupData | null;
  friend: FriendData | null;
  activity: ActivityData | null;
  loaded: boolean;
  consent: { message: string; revokedAt: string | null } | null;
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
      setSnapshot({
        ...EMPTY_SNAPSHOT,
        loaded: true,
        consent: {
          message: denied.message ?? "",
          revokedAt: denied.revoked_at ?? null,
        },
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

  return useMemo(
    () => ({ ...snapshot, refresh, write, say, forget }),
    [snapshot, refresh, write, say, forget]
  );
}
