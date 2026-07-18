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

const YOU_COLOR = '#0FA678';

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
  [k: string]: unknown;
}
type ExpenseFact = ExpenseRowRaw & { splits: Record<string, number> };
interface SettlementRow {
  from_party: string;
  to_party: string;
  amount_minor: number;
  group_id?: string;
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
  expenses: ExpenseFact[];
  settlements: SettlementRow[];
}

// A friend's avatar hue is no longer stored on the tally_friend row (issue
// #441 A3 — one hue per party). Derive a stable one from the party id so the
// same person always renders the same colour. (Kept in step with format.ts's
// FRIEND_COLORS; inlined here to keep this server query free of the client
// kit imports format.ts pulls in.)
const FRIEND_COLORS = [
  '#7C5BD9',
  '#4E68DD',
  '#E0567A',
  '#E8923C',
  '#2EA098',
  '#3AA6B9',
  '#57A55A',
  '#D9536F',
];
function friendColor(partyId: string): string {
  const id = String(partyId || '');
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return FRIEND_COLORS[h % FRIEND_COLORS.length]!;
}

function initials(name: string | undefined): string {
  if (!name) return '?';
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

/** Pull every ground fact Tally needs and shape it for the compute helpers. */
export async function loadTally(ctx: HandlerCtx, purpose: string): Promise<TallyData> {
  // A group decorates a social.circle (issue #310 S4): the circle carries
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
  ] = await Promise.all([
    ctx.vault.read({ entity: 'core.vault', purpose }),
    ctx.vault.read({ entity: 'tally.friend', purpose }),
    ctx.vault.read({ entity: 'tally.group', purpose }),
    ctx.vault.read({ entity: 'social.circle', purpose }),
    ctx.vault.read({ entity: 'social.circle_member', purpose }),
    ctx.vault.read({
      entity: 'tally.expense',
      // Trashed expenses (issue #441 A4) drop out of every balance and ledger —
      // their splits are read below but never consumed once the expense is gone.
      where: [{ column: 'deleted_at', op: 'is-null' }],
      orderBy: { column: 'spent_on', dir: 'desc' },
      limit: 2000,
      purpose,
    }),
    ctx.vault.read({ entity: 'tally.expense_split', limit: 8000, purpose }),
    ctx.vault.read({
      entity: 'tally.settlement',
      where: [{ column: 'deleted_at', op: 'is-null' }],
      limit: 2000,
      purpose,
    }),
  ]);

  const vaultRow = (vaultRes.rows ?? [])[0] ?? {};
  const me = (vaultRow.owner_party_id as string | undefined) ?? null;
  const currency = (vaultRow.base_currency as string | undefined) ?? 'USD';

  const friends = (friendsRes.rows ?? []) as unknown as FriendRow[];
  const friendPartyIds = friends.map((f) => f.party_id);
  const partyIds = [...new Set([me, ...friendPartyIds].filter(Boolean))] as string[];
  const partiesRes =
    partyIds.length > 0
      ? await ctx.vault.read({
          entity: 'core.party',
          where: [{ column: 'party_id', op: 'in', value: partyIds }],
          purpose,
        })
      : { rows: [] as Record<string, unknown>[] };
  const partyRows = (partiesRes.rows ?? []) as unknown as Array<{
    party_id: string;
    display_name?: string;
  }>;
  const nameById = new Map(partyRows.map((p) => [p.party_id, p.display_name]));
  const colorByParty = new Map(friends.map((f) => [f.party_id, friendColor(f.party_id)]));

  const people = new Map<string, ServerPerson>();
  if (me)
    people.set(me, { party_id: me, name: 'You', color: YOU_COLOR, initials: 'You', is_me: true });
  for (const f of friends) {
    const name = nameById.get(f.party_id) || 'Friend';
    people.set(f.party_id, {
      party_id: f.party_id,
      name,
      color: colorByParty.get(f.party_id) || '#5C677D',
      initials: initials(name),
      is_me: false,
    });
  }

  const circleRows = (circlesRes.rows ?? []) as unknown as Array<{
    circle_id: string;
    name: string;
  }>;
  const circleName = new Map(circleRows.map((c) => [c.circle_id, c.name]));
  const groups: DecoratedGroup[] = ((groupsRes.rows ?? []) as unknown as GroupRow[]).map((g) => ({
    ...g,
    name: circleName.get(g.circle_id) ?? 'Group',
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
  for (const g of groups) membersByGroup.set(g.group_id, membersByCircle.get(g.circle_id) ?? []);

  const splitsByExpense = new Map<string, Record<string, number>>();
  for (const s of (splitsRes.rows ?? []) as unknown as Array<{
    expense_id: string;
    party_id: string;
    share_minor: number;
  }>) {
    if (!splitsByExpense.has(s.expense_id)) splitsByExpense.set(s.expense_id, {});
    splitsByExpense.get(s.expense_id)![s.party_id] = s.share_minor;
  }
  const expenses: ExpenseFact[] = ((expensesRes.rows ?? []) as unknown as ExpenseRowRaw[]).map(
    (e) => ({
      ...e,
      splits: splitsByExpense.get(e.expense_id) ?? {},
    }),
  );

  return {
    me,
    currency,
    people,
    friends,
    groups,
    membersByGroup,
    expenses,
    settlements: (settlesRes.rows ?? []) as unknown as SettlementRow[],
  };
}

export function personOf(data: TallyData, pid: string): ServerPerson {
  return (
    data.people.get(pid) || {
      party_id: pid,
      name: 'Someone',
      color: '#5C677D',
      initials: '?',
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
      else if (pid === me && payer !== me) b.set(payer, (b.get(payer) || 0) - share);
    }
  }
  for (const s of data.settlements) {
    if (s.from_party === me && s.to_party !== me)
      b.set(s.to_party, (b.get(s.to_party) || 0) + s.amount_minor);
    else if (s.to_party === me && s.from_party !== me)
      b.set(s.from_party, (b.get(s.from_party) || 0) - s.amount_minor);
  }
  return b;
}

/** Net per member within a group, in minor units. Positive = gets money back. */
export function groupNet(data: TallyData, gid: string): Map<string, number> {
  const net = new Map<string, number>();
  for (const pid of data.membersByGroup.get(gid) ?? []) net.set(pid, 0);
  for (const e of data.expenses) {
    if (e.group_id !== gid) continue;
    net.set(e.paid_by, (net.get(e.paid_by) || 0) + e.amount_minor);
    for (const [pid, share] of Object.entries(e.splits)) net.set(pid, (net.get(pid) || 0) - share);
  }
  for (const s of data.settlements) {
    if (s.group_id !== gid) continue;
    net.set(s.from_party, (net.get(s.from_party) || 0) + s.amount_minor);
    net.set(s.to_party, (net.get(s.to_party) || 0) - s.amount_minor);
  }
  return net;
}

/** A ledger row: the expense decorated with the owner's lent/borrowed stance. */
export function ledgerRow(data: TallyData, e: ExpenseFact) {
  const me = data.me;
  const myShare = me != null ? e.splits[me] : undefined;
  const yourShare = myShare ?? 0;
  const involved = myShare != null;
  let your_role: 'lent' | 'borrowed' | 'none';
  let your_amount_minor: number;
  if (e.paid_by === me) {
    your_role = 'lent';
    your_amount_minor = e.amount_minor - yourShare;
  } else if (involved) {
    your_role = 'borrowed';
    your_amount_minor = yourShare;
  } else {
    your_role = 'none';
    your_amount_minor = e.amount_minor;
  }
  return {
    expense_id: e.expense_id,
    group_id: e.group_id,
    description: e.description,
    amount_minor: e.amount_minor,
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
  };
}

export default async ({ ctx }: HandlerArgs) => {
  const purpose = 'dpv:ServiceProvision';
  try {
    const data = await loadTally(ctx, purpose);
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
    return {
      me: data.me,
      currency: data.currency,
      friends,
      groups,
      owe_total_minor: owe,
      owed_total_minor: owed,
    };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return {
      me: null,
      currency: 'USD',
      friends: [],
      groups: [],
      owe_total_minor: 0,
      owed_total_minor: 0,
      vaultDenied: { code: e.code, message: e.message },
    };
  }
};
