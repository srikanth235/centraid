// THE SEVEN READS, AND THEY RUN HERE (#922 E7).
//
// ONE BALANCE ENGINE, AND IT IS `queries/dashboard.ts`'s. Every net, share and
// total in Tally is derived at read time by that one engine (spec §2), and no
// seat recomputes one. This seat used to reach it by RPC — seven calls to the
// gateway, a ten-minute stale clock over the answers, and a ledger that could
// not be read at all on a plane. The engine is a `queries/*.ts` module and
// Metro loads it, so the phone now runs THE SAME MODULE the web seat runs,
// against its own mounted replica (`inline-query-ctx.native.ts`). There is
// still exactly one derivation of "who owes whom"; it simply no longer needs a
// network to reach it.
//
// WRITES ARE THE OTHER DIRECTION AND TAKE THE OTHER DOOR. `tally-writes.ts`
// issues every act through `session.write`, which projects an optimistic copy
// and keeps the intent in the durable outbox until the gateway answers
// (`apps/tally/pending-projection.ts`). Recording never needed the gateway;
// now reading a derived figure does not either.
//
// The functions are thin on purpose. They name the query, they name what comes
// back, and they leave every decision about what a payload MEANS to
// `tally-store.ts` and to the pure blueprint modules it composes.

import activityQuery from "@centraid/blueprints/apps/tally/queries/activity";
import dashboardQuery from "@centraid/blueprints/apps/tally/queries/dashboard";
import exportQuery from "@centraid/blueprints/apps/tally/queries/export";
import friendQuery from "@centraid/blueprints/apps/tally/queries/friend";
import groupQuery from "@centraid/blueprints/apps/tally/queries/group";
import historyQuery from "@centraid/blueprints/apps/tally/queries/history";
import searchQuery from "@centraid/blueprints/apps/tally/queries/search";
import type {
  ActivityData,
  DashboardData,
  ExportData,
  FriendData,
  GroupData,
  HistoryData,
  SearchData,
} from "@centraid/blueprints/apps/tally/types";
import type { InlineQueryRunnable } from "@centraid/client/replica/native";

import type { NativeInlineQuerySession } from "../../lib/replica/inline-query-ctx.native";
import { runNativeInlineQuery } from "../../lib/replica/inline-query-ctx.native";

const APP = "tally";

/** The window Export asks for. The query's own default; its ceiling is its
 *  own business, and `truncated` is how the payload says it was reached. */
export const EXPORT_WINDOW = 2000;

/**
 * The mounted read plane, handed over by the frame.
 *
 * Module-level for the same reason `tally-store.ts` is: the plane is process
 * memory shared by fifteen routes, and threading it through every screen would
 * make a remount able to hand a subtree a session the member has navigated
 * away from. `TallyScreen.tsx` attaches it on mount and detaches on unmount.
 */
let plane: NativeInlineQuerySession | undefined;

export function attachTallyReadPlane(
  session: NativeInlineQuerySession | undefined
): void {
  plane = session;
}

/**
 * There is no replica on this device yet — a first open before the bootstrap
 * lands, or a member with no vault linked. A sentence, not a crash: the store
 * renders `readError` and the member is told what is missing rather than shown
 * an empty ledger that looks settled.
 */
export class TallyReadPlaneUnavailableError extends Error {
  constructor() {
    super("This device has not finished mounting the vault yet.");
    this.name = "TallyReadPlaneUnavailableError";
  }
}

/**
 * `queries/*.ts` export the handler as the module's default; the runner takes
 * the MODULE, exactly as the web seat's `app-inline.tsx` hands it one. The
 * wrapper is that shape, rebuilt around the imported function.
 */
function runQuery<T>(
  handler: unknown,
  input: Record<string, unknown>
): Promise<T> {
  if (!plane) return Promise.reject(new TallyReadPlaneUnavailableError());
  return runNativeInlineQuery({ default: handler } as InlineQueryRunnable, {
    session: plane,
    appId: APP,
    input,
  }) as Promise<T>;
}

/** The spine. Every route reads it, and a route that needs a second payload
 *  asks for exactly that one (`apps/tally/ledger-reads.ts`'s own law). */
export function tallyDashboard(): Promise<DashboardData> {
  return runQuery<DashboardData>(dashboardQuery, {});
}

/** One group's members, their nets, its ledger and its simplification. */
export function tallyGroup(groupId: string): Promise<GroupData> {
  return runQuery<GroupData>(groupQuery, { group_id: groupId });
}

/** Every part of one net — groups, group-less, and People's obligations. */
export function tallyFriend(partyId: string): Promise<FriendData> {
  return runQuery<FriendData>(friendQuery, { party_id: partyId });
}

/** Expenses and settlements interleaved, newest first. */
export function tallyActivity(): Promise<ActivityData> {
  return runQuery<ActivityData>(activityQuery, {});
}

/** Descriptions only. The query matches nothing else, and the surface says so. */
export function tallySearch(term: string): Promise<SearchData> {
  return runQuery<SearchData>(searchQuery, { term });
}

/** One expense's durable revisions, with the undo window on each. */
export function tallyHistory(expenseId: string): Promise<HistoryData> {
  return runQuery<HistoryData>(historyQuery, { expense_id: expenseId });
}

/**
 * One group's ledger as a file's worth of rows.
 *
 * READ HERE, WRITTEN NOWHERE FROM THIS SEAT. Export is `custodian` in
 * SURFACES.md's seat column — the file is saved beside the gateway — so this
 * phone reads the payload only to state honestly how much WOULD leave, and
 * says where the act happens (`tally-seat-copy.ts`).
 */
export function tallyExport(groupId: string): Promise<ExportData> {
  return runQuery<ExportData>(exportQuery, {
    group_id: groupId,
    limit: EXPORT_WINDOW,
  });
}
