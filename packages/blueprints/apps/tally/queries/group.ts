/**
 * One group: its meta, members with derived net balances, and its expense
 * ledger newest-first — each row decorated with the owner's lent/borrowed
 * stance and its per-person splits (so the detail popover needs no second
 * read). All balances come from the shared engine in dashboard.ts.
 */

import { tallySimplification } from "../../../src/tally-simplify.ts";
import {
  deniedPayload,
  groupNet,
  ledgerRow,
  loadTally,
  personOf,
} from "./dashboard.ts";

export default async function groupHandler({ input, ctx }: HandlerArgs) {
  const purpose = "dpv:ServiceProvision";
  const groupId = String(input?.group_id ?? "");
  try {
    const data = await loadTally(ctx, purpose);
    const g = data.groups.find((x) => x.group_id === groupId);
    if (!g)
      return {
        me: data.me,
        currency: data.currency,
        group: null,
        members: [],
        ledger: [],
        simplification: {
          opted_in: false,
          transfers: [],
          debts_before: 0,
          payments_after: 0,
        },
      };
    const net = groupNet(data, groupId);
    const currentMemberIds = data.membersByGroup.get(groupId) ?? [];
    const currentMembers = new Set(currentMemberIds);
    const participantIds = [
      ...currentMemberIds,
      ...[...net.keys()].filter((partyId) => !currentMembers.has(partyId)),
    ];
    const members = participantIds.map((pid) => {
      const p = personOf(data, pid);
      return {
        party_id: pid,
        name: p.name,
        color: p.color,
        initials: p.initials,
        is_me: p.is_me,
        net_minor: net.get(pid) || 0,
        ...(currentMembers.has(pid) ? {} : { departed: true }),
      };
    });
    const ledger = data.expenses
      .filter((e) => e.group_id === groupId)
      .map((e) => ledgerRow(data, e));
    return {
      me: data.me,
      currency: data.currency,
      group: {
        group_id: g.group_id,
        name: g.name,
        icon: g.icon,
        color: g.color,
        simplify_opt_in: g.simplify_opt_in === 1,
        archived_at: g.archived_at ?? null,
      },
      members,
      ledger,
      // Derived, never stored: the minimal payment set this group's ledger
      // implies, plus the counts that say what it rewired. Empty rows until
      // the group opts in, because simplification changes who owes whom.
      simplification: tallySimplification(
        data,
        groupId,
        g.simplify_opt_in === 1
      ),
    };
  } catch (error) {
    return {
      me: null,
      currency: "USD",
      group: null,
      members: [],
      ledger: [],
      simplification: {
        opted_in: false,
        transfers: [],
        debts_before: 0,
        payments_after: 0,
      },
      vaultDenied: deniedPayload(error),
    };
  }
}
