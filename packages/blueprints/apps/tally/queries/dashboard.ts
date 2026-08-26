// governance: allow-repo-hygiene file-size-limit (#630) — the bounded dashboard
// projection and balance derivation intentionally stay together so every
// monetary view uses the same fixed-point source rows and allocation rules.
/**
 * The dashboard, and the shared balance engine every Tally query reads through.
 * Balances are DERIVED here, never stored: loadTally() pulls the ground facts
 * (the owner, friends, groups, members, expenses with their splits, and
 * settlements) in a handful of bounded reads, and pairwise()/groupNet() fold
 * them into net positions in minor units. The owner is the vault's
 * owner_party_id — the implicit `me`; everyone else is a canonical core.party
 * carried by a tally_friend row. All money is INTEGER minor units; the app
 * formats it. A consent denial is a first-class outcome the UI renders as the
 * access state.
 */

import { BRAND, identityColor, identityInitials } from "@centraid/design";

import { tallyGroupNet } from "../../../src/tally-balance.ts";
import {
  PENDING_OVERLAY_FIELDS,
  pendingOverlayCopy,
  readPendingOverlay,
} from "../../_shared/pending-overlay.ts";

/** A resolved person (owner or friend) the ledgers decorate rows with. */
export interface ServerPerson {
  party_id: string;
  name: string;
  color: string;
  initials: string;
  is_me: boolean;
}

interface FriendRow {
  party_id: string;
  [k: string]: unknown;
}
interface GroupRow {
  group_id: string;
  circle_id: string;
  icon?: string;
  color?: string;
  [k: string]: unknown;
}
type DecoratedGroup = GroupRow & { name: string };
interface ExpenseRowRaw {
  expense_id: string;
  group_id: string;
  paid_by: string;
  amount_minor: number;
  description?: string;
  category?: string;
  spent_on?: string;
  original_amount_minor?: number | null;
  original_currency?: string | null;
  settlement_currency?: string | null;
  rate_scaled?: number | null;
  rate_scale?: number | null;
  rate_source?: string | null;
  rate_date?: string | null;
  recurring_template_id?: string | null;
  [k: string]: unknown;
}

interface RecurringRow {
  template_id: string;
  group_id: string;
  description: string;
  original_amount_minor: number;
  original_currency: string;
  settlement_currency: string;
  rate_source?: string | null;
  rate_date?: string | null;
  rrule: string;
  anchor_start: string;
  time_zone: string;
  status: "active" | "paused" | "ended";
}
type ExpenseFact = ExpenseRowRaw & { splits: Record<string, number> };
interface ReceiptLineFact {
  line_item_id: string;
  kind: "item" | "tax" | "tip";
  description: string;
  amount_minor: number;
  sort_order: number;
  allocations: Record<string, number>;
}
interface ReceiptFact {
  receipt_id: string;
  content_id: string;
  content_uri?: string;
  media_type?: string;
  lines: ReceiptLineFact[];
}
type ExpenseWithReceipt = ExpenseFact & { receipt?: ReceiptFact };
interface SettlementRow {
  from_party: string;
  to_party: string;
  amount_minor: number;
  group_id?: string;
  [k: string]: unknown;
}
interface ObligationRow {
  obligation_id: string;
  from_party: string;
  to_party: string;
  amount_minor: number;
  currency: string;
  settled_at?: string | null;
  [k: string]: unknown;
}

/** The folded ground facts every Tally query computes against. */
export interface TallyData {
  me: string | null;
  currency: string;
  people: Map<string, ServerPerson>;
  friends: FriendRow[];
  groups: DecoratedGroup[];
  membersByGroup: Map<string, string[]>;
  expenses: ExpenseWithReceipt[];
  settlements: SettlementRow[];
  obligations: ObligationRow[];
}

/** Pull every ground fact Tally needs and shape it for the compute helpers. */
export async function loadTally(
  ctx: HandlerCtx,
  purpose: string
): Promise<TallyData> {
  // A group decorates a social.circle (#310): the circle carries
  // the name and the membership, tally.group the icon + colour.
  const [
    vaultRes,
    friendsRes,
    groupsRes,
    circlesRes,
    membersRes,
    expensesRes,
    splitsRes,
    settlesRes,
    obligationsRes,
    receiptsRes,
    receiptLinesRes,
    receiptAllocationsRes,
  ] = await Promise.all([
    ctx.vault.read({ entity: "core.vault", purpose }),
    ctx.vault.read({ entity: "tally.friend", purpose }),
    ctx.vault.read({ entity: "tally.group", purpose }),
    ctx.vault.read({ entity: "social.circle", purpose }),
    ctx.vault.read({ entity: "social.circle_member", purpose }),
    ctx.vault.read({
      entity: "tally.expense",
      // Trashed expenses (#441) drop out of every balance and ledger —
      // their splits are read below but never consumed once the expense is gone.
      where: [{ column: "deleted_at", op: "is-null" }],
      orderBy: { column: "spent_on", dir: "desc" },
      limit: 2000,
      purpose,
    }),
    ctx.vault.read({ entity: "tally.expense_split", limit: 8000, purpose }),
    ctx.vault.read({
      entity: "tally.settlement",
      where: [{ column: "deleted_at", op: "is-null" }],
      limit: 2000,
      purpose,
    }),
    ctx.vault.read({
      entity: "tally.obligation",
      where: [
        { column: "settled_at", op: "is-null" },
        { column: "deleted_at", op: "is-null" },
      ],
      limit: 2000,
      purpose,
    }),
    ctx.vault.read({
      entity: "tally.expense_receipt",
      limit: 2_000,
      purpose,
    }),
    ctx.vault.read({
      entity: "tally.expense_line_item",
      limit: 8_000,
      purpose,
    }),
    ctx.vault.read({
      entity: "tally.expense_line_allocation",
      limit: 32_000,
      purpose,
    }),
  ]);

  const vaultRow = (vaultRes.rows ?? [])[0] ?? {};
  const me = (vaultRow.owner_party_id as string | undefined) ?? null;
  const currency = (vaultRow.base_currency as string | undefined) ?? "USD";

  const friends = (friendsRes.rows ?? []) as unknown as FriendRow[];
  const friendPartyIds = friends.map((f) => f.party_id);
  // Circle membership is current state, while the ledger is durable history.
  // A member who has left the circle must therefore remain nameable anywhere
  // an expense or settlement still refers to them. Query every ledger party,
  // not only today's friend/member roster, so group() can label that durable
  // participant honestly instead of collapsing them to "Someone".
  const activeExpenseIds = new Set(
    ((expensesRes.rows ?? []) as unknown as ExpenseRowRaw[]).map(
      (expense) => expense.expense_id
    )
  );
  const ledgerPartyIds = [
    ...((membersRes.rows ?? []) as unknown as Array<{ party_id: string }>).map(
      (member) => member.party_id
    ),
    ...((expensesRes.rows ?? []) as unknown as ExpenseRowRaw[]).map(
      (expense) => expense.paid_by
    ),
    ...(
      (splitsRes.rows ?? []) as unknown as Array<{
        expense_id: string;
        party_id: string;
      }>
    )
      .filter((split) => activeExpenseIds.has(split.expense_id))
      .map((split) => split.party_id),
    ...((settlesRes.rows ?? []) as unknown as SettlementRow[]).flatMap(
      (settlement) => [settlement.from_party, settlement.to_party]
    ),
  ];
  const partyIds = [
    ...new Set([me, ...friendPartyIds, ...ledgerPartyIds].filter(Boolean)),
  ] as string[];
  const partiesRes =
    partyIds.length > 0
      ? await ctx.vault.read({
          entity: "core.party",
          where: [{ column: "party_id", op: "in", value: partyIds }],
          purpose,
        })
      : { rows: [] as Record<string, unknown>[] };
  const partyRows = (partiesRes.rows ?? []) as unknown as Array<{
    party_id: string;
    display_name?: string;
  }>;
  const nameById = new Map(partyRows.map((p) => [p.party_id, p.display_name]));
  const colorByParty = new Map(
    friends.map((f) => [f.party_id, identityColor(f.party_id)])
  );

  const people = new Map<string, ServerPerson>();
  if (me)
    people.set(me, {
      party_id: me,
      name: "You",
      color: BRAND,
      initials: identityInitials("You"),
      is_me: true,
    });
  for (const f of friends) {
    const name = nameById.get(f.party_id) || "Friend";
    people.set(f.party_id, {
      party_id: f.party_id,
      name,
      color: colorByParty.get(f.party_id) || identityColor(f.party_id),
      initials: identityInitials(name),
      is_me: false,
    });
  }
  for (const partyId of partyIds) {
    if (people.has(partyId)) continue;
    const name = nameById.get(partyId) || "Someone";
    people.set(partyId, {
      party_id: partyId,
      name,
      color: identityColor(partyId),
      initials: identityInitials(name),
      is_me: false,
    });
  }

  const circleRows = (circlesRes.rows ?? []) as unknown as Array<{
    circle_id: string;
    name: string;
  }>;
  const circleName = new Map(circleRows.map((c) => [c.circle_id, c.name]));
  const groups: DecoratedGroup[] = (
    (groupsRes.rows ?? []) as unknown as GroupRow[]
  ).map((g) => ({
    ...g,
    name: circleName.get(g.circle_id) ?? "Group",
  }));

  const membersByCircle = new Map<string, string[]>();
  for (const m of (membersRes.rows ?? []) as unknown as Array<{
    circle_id: string;
    party_id: string;
  }>) {
    if (!membersByCircle.has(m.circle_id)) membersByCircle.set(m.circle_id, []);
    membersByCircle.get(m.circle_id)!.push(m.party_id);
  }
  const membersByGroup = new Map<string, string[]>();
  for (const g of groups)
    membersByGroup.set(g.group_id, membersByCircle.get(g.circle_id) ?? []);

  const splitsByExpense = new Map<string, Record<string, number>>();
  for (const s of (splitsRes.rows ?? []) as unknown as Array<{
    expense_id: string;
    party_id: string;
    share_minor: number;
  }>) {
    if (!splitsByExpense.has(s.expense_id))
      splitsByExpense.set(s.expense_id, {});
    splitsByExpense.get(s.expense_id)![s.party_id] = s.share_minor;
  }
  const receiptRows = (receiptsRes.rows ?? []) as unknown as Array<{
    receipt_id: string;
    expense_id: string;
    content_id: string;
  }>;
  const receiptContentIds = [
    ...new Set(receiptRows.map((row) => row.content_id)),
  ];
  const receiptContents =
    receiptContentIds.length > 0
      ? await ctx.vault.read({
          entity: "core.content_item",
          where: [{ column: "content_id", op: "in", value: receiptContentIds }],
          purpose,
        })
      : { rows: [] as Record<string, unknown>[] };
  const contentsById = new Map(
    (
      (receiptContents.rows ?? []) as unknown as Array<{
        content_id: string;
        content_uri?: string;
        media_type?: string;
      }>
    ).map((row) => [row.content_id, row] as const)
  );
  const allocationsByLine = new Map<string, Record<string, number>>();
  for (const allocation of (receiptAllocationsRes.rows ??
    []) as unknown as Array<{
    line_item_id: string;
    party_id: string;
    share_minor: number;
  }>) {
    if (!allocationsByLine.has(allocation.line_item_id))
      allocationsByLine.set(allocation.line_item_id, {});
    allocationsByLine.get(allocation.line_item_id)![allocation.party_id] =
      allocation.share_minor;
  }
  const linesByReceipt = new Map<string, ReceiptLineFact[]>();
  for (const line of (receiptLinesRes.rows ?? []) as unknown as Array<{
    line_item_id: string;
    receipt_id: string;
    kind: "item" | "tax" | "tip";
    description: string;
    amount_minor: number;
    sort_order: number;
  }>) {
    if (!linesByReceipt.has(line.receipt_id))
      linesByReceipt.set(line.receipt_id, []);
    linesByReceipt.get(line.receipt_id)!.push({
      line_item_id: line.line_item_id,
      kind: line.kind,
      description: line.description,
      amount_minor: line.amount_minor,
      sort_order: line.sort_order,
      allocations: allocationsByLine.get(line.line_item_id) ?? {},
    });
  }
  for (const lines of linesByReceipt.values())
    lines.sort((a, b) => a.sort_order - b.sort_order);
  const receiptByExpense = new Map<string, ReceiptFact>();
  for (const receipt of receiptRows) {
    const content = contentsById.get(receipt.content_id);
    receiptByExpense.set(receipt.expense_id, {
      receipt_id: receipt.receipt_id,
      content_id: receipt.content_id,
      ...(content?.content_uri
        ? {
            content_uri: content.content_uri.startsWith("blob:")
              ? `/centraid/_vault/blobs/${receipt.content_id}`
              : content.content_uri,
          }
        : {}),
      ...(content?.media_type ? { media_type: content.media_type } : {}),
      lines: linesByReceipt.get(receipt.receipt_id) ?? [],
    });
  }
  const expenses: ExpenseWithReceipt[] = (
    (expensesRes.rows ?? []) as unknown as ExpenseRowRaw[]
  ).map((e) => ({
    ...e,
    splits: splitsByExpense.get(e.expense_id) ?? {},
    ...(receiptByExpense.has(e.expense_id)
      ? { receipt: receiptByExpense.get(e.expense_id)! }
      : {}),
  }));

  return {
    me,
    currency,
    people,
    friends,
    groups,
    membersByGroup,
    expenses,
    settlements: (settlesRes.rows ?? []) as unknown as SettlementRow[],
    obligations: (obligationsRes.rows ?? []) as unknown as ObligationRow[],
  };
}

export function personOf(data: TallyData, pid: string): ServerPerson {
  return (
    data.people.get(pid) || {
      party_id: pid,
      name: "Someone",
      color: identityColor(pid),
      initials: identityInitials("Someone"),
      is_me: false,
    }
  );
}

/** Net per friend vs the owner, in minor units. Positive = they owe me. */
export function pairwise(data: TallyData): Map<string, number> {
  const me = data.me;
  const b = new Map<string, number>();
  for (const f of data.friends) b.set(f.party_id, 0);
  for (const e of data.expenses) {
    const payer = e.paid_by;
    for (const [pid, share] of Object.entries(e.splits)) {
      if (pid === payer) continue;
      if (payer === me && pid !== me) b.set(pid, (b.get(pid) || 0) + share);
      else if (pid === me && payer !== me)
        b.set(payer, (b.get(payer) || 0) - share);
    }
  }
  for (const s of data.settlements) {
    if (s.from_party === me && s.to_party !== me)
      b.set(s.to_party, (b.get(s.to_party) || 0) + s.amount_minor);
    else if (s.to_party === me && s.from_party !== me)
      b.set(s.from_party, (b.get(s.from_party) || 0) - s.amount_minor);
  }
  for (const obligation of data.obligations) {
    if (obligation.from_party === me && obligation.to_party !== me) {
      b.set(
        obligation.to_party,
        (b.get(obligation.to_party) || 0) - obligation.amount_minor
      );
    } else if (obligation.to_party === me && obligation.from_party !== me) {
      b.set(
        obligation.from_party,
        (b.get(obligation.from_party) || 0) + obligation.amount_minor
      );
    }
  }
  return b;
}

/** Net per member within a group, in minor units. Positive = gets money back. */
export const groupNet = tallyGroupNet;

/** A ledger row: the expense decorated with the owner's lent/borrowed stance. */
export function ledgerRow(data: TallyData, e: ExpenseWithReceipt) {
  const pending = readPendingOverlay(e);
  const me = data.me;
  const myShare = me == null ? undefined : e.splits[me];
  const yourShare = myShare ?? 0;
  const involved = myShare != null;
  let your_role: "lent" | "borrowed" | "none";
  let your_amount_minor: number;
  if (e.paid_by === me) {
    your_role = "lent";
    your_amount_minor = e.amount_minor - yourShare;
  } else if (involved) {
    your_role = "borrowed";
    your_amount_minor = yourShare;
  } else {
    your_role = "none";
    your_amount_minor = e.amount_minor;
  }
  return {
    expense_id: e.expense_id,
    group_id: e.group_id,
    description: e.description,
    amount_minor: e.amount_minor,
    original_amount_minor: e.original_amount_minor ?? e.amount_minor,
    original_currency: e.original_currency ?? data.currency,
    settlement_currency: e.settlement_currency ?? data.currency,
    rate_scaled: e.rate_scaled ?? 1_000_000,
    rate_scale: e.rate_scale ?? 6,
    rate_source: e.rate_source ?? "identity",
    rate_date: e.rate_date ?? e.spent_on,
    recurring_template_id: e.recurring_template_id ?? null,
    category: e.category,
    spent_on: e.spent_on,
    paid_by: e.paid_by,
    paid_by_name: personOf(data, e.paid_by).name,
    your_role,
    your_amount_minor,
    splits: Object.entries(e.splits).map(([pid, share]) => {
      const p = personOf(data, pid);
      return {
        party_id: pid,
        name: p.name,
        color: p.color,
        initials: p.initials,
        share_minor: share,
      };
    }),
    ...(pending
      ? {
          ...Object.fromEntries(
            Object.values(PENDING_OVERLAY_FIELDS).flatMap((field) =>
              field in e ? [[field, e[field]]] : []
            )
          ),
          pending: true,
          parked: pending.status === "parked",
          intentStatus: pending.status,
          commonsIntentId: pending.key,
          pendingReason: pendingOverlayCopy(pending),
          stewardLabel: pending.stewardLabel,
        }
      : {}),
    ...(e.receipt
      ? {
          receipt: {
            ...e.receipt,
            lines: e.receipt.lines.map((line) => ({
              ...line,
              allocations: Object.entries(line.allocations).map(
                ([pid, share]) => {
                  const person = personOf(data, pid);
                  return {
                    party_id: pid,
                    name: person.name,
                    share_minor: share,
                  };
                }
              ),
            })),
          },
        }
      : {}),
  };
}

export default async function dashboardHandler({ ctx }: HandlerArgs) {
  const purpose = "dpv:ServiceProvision";
  try {
    const data = await loadTally(ctx, purpose);
    const [trashRes, recurringRes, exceptionRes] = await Promise.all([
      ctx.vault.read({
        entity: "tally.expense",
        where: [{ column: "deleted_at", op: "not-null" }],
        orderBy: { column: "deleted_at", dir: "desc" },
        limit: 100,
        purpose,
      }),
      ctx.vault.read({
        entity: "tally.recurring_expense",
        orderBy: { column: "updated_at", dir: "desc" },
        limit: 500,
        purpose,
      }),
      ctx.vault.read({
        entity: "schedule.recurrence_exception",
        where: [
          {
            column: "target_type",
            op: "eq",
            value: "tally.recurring_expense",
          },
        ],
        limit: 2000,
        purpose,
      }),
    ]);
    const bal = pairwise(data);
    const friends = data.friends.map((f) => {
      const p = personOf(data, f.party_id);
      return {
        party_id: f.party_id,
        name: p.name,
        color: p.color,
        initials: p.initials,
        net_minor: bal.get(f.party_id) || 0,
      };
    });
    let owe = 0;
    let owed = 0;
    for (const v of bal.values()) {
      if (v > 0) owed += v;
      else if (v < 0) owe += -v;
    }
    const groups = data.groups.map((g) => {
      const net = groupNet(data, g.group_id);
      return {
        group_id: g.group_id,
        name: g.name,
        icon: g.icon,
        color: g.color,
        member_count: (data.membersByGroup.get(g.group_id) ?? []).length,
        owner_net_minor: net.get(data.me as string) || 0,
      };
    });
    const groupName = new Map(
      data.groups.map((group) => [group.group_id, group.name])
    );
    const trash = (trashRes.rows ?? []).map((row) => ({
      expense_id: String(row.expense_id),
      description: String(row.description ?? "Expense"),
      amount_minor: Number(row.amount_minor ?? 0),
      group_name: groupName.get(String(row.group_id)) ?? "Group",
      deleted_at: String(row.deleted_at),
      purge_at: row.purge_at == null ? null : String(row.purge_at),
    }));
    const now = new Date();
    const rangeFrom = now.toISOString();
    const rangeTo = new Date(now.getTime() + 180 * 86_400_000).toISOString();
    const exceptionRows = exceptionRes.rows ?? [];
    const recurring = (
      (recurringRes.rows ?? []) as unknown as RecurringRow[]
    ).map((template) => {
      const instances = ctx.time.expandRecurrence({
        rrule: template.rrule,
        start: template.anchor_start,
        rangeFrom,
        rangeTo,
        timeZone: template.time_zone,
        maxInstances: 8,
      });
      const exceptions = exceptionRows
        .filter((row) => row.target_id === template.template_id)
        .map((row) => ({
          originalStart: String(row.original_start),
          action: String(row.action) as "skip" | "override",
          scope: String(row.scope) as "occurrence" | "future",
          ...(row.override_json
            ? {
                start: String(
                  (
                    JSON.parse(String(row.override_json)) as {
                      start?: string;
                    }
                  ).start ?? ""
                ),
              }
            : {}),
        }));
      const next = ctx.time.applyRecurrenceExceptions(instances, exceptions)[0];
      return {
        ...template,
        // A rule the summariser cannot phrase drops its preview entirely.
        // Falling back to `template.rrule` would put RRULE syntax on a
        // member-facing surface, which the house rule bans outright.
        preview: ctx.time.describeRecurrence(template.rrule),
        next_start: next?.originalStart ?? null,
      };
    });
    return {
      me: data.me,
      currency: data.currency,
      friends,
      groups,
      trash,
      recurring,
      owe_total_minor: owe,
      owed_total_minor: owed,
    };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return {
      me: null,
      currency: "USD",
      friends: [],
      groups: [],
      trash: [],
      recurring: [],
      owe_total_minor: 0,
      owed_total_minor: 0,
      vaultDenied: { code: e.code, message: e.message },
    };
  }
}
