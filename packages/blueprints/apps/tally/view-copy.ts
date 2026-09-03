export const BALANCES_STATUS =
  "Every figure is derived at read time · no balance is stored and none is transmitted";

export const ALL_SETTLED =
  "Everyone is level · the ledger keeps every expense that got you here";

export const DAY_ONE = "Nothing is split yet.";
export const DAY_ONE_SUB =
  "The first real move is one expense with one person; a group can wait for three of you.";
export const DAY_ONE_ACT = "Add an expense";

export function balancesHeroSub(
  owedTo: string,
  owe: string,
  expenses: number,
  settlements: number
): string {
  return `Owed to you ${owedTo} · you owe ${owe}. Derived from ${expenses} expenses and ${settlements} settlements — no balance is stored, and none is ever sent.`;
}

export const HERO_OWE = "you owe, on balance";
export const HERO_OWED = "owed to you, on balance";
export const HERO_LEVEL = "nothing outstanding, with anyone";
export const HERO_SETTLED_SUB =
  "Every group and every friend is level, and the ledger keeps all of it.";

export const GROUP_HERO_OWE = "you owe in this group";
export const GROUP_HERO_OWED = "owed to you in this group";
export const GROUP_HERO_LEVEL = "this group is level";
export const GROUP_HERO_SUB =
  "Every member computes this figure themselves, from the same facts.";

export function friendHeroOwe(name: string): string {
  return `you owe ${name}`;
}
export function friendHeroOwed(name: string): string {
  return `${name} owes you`;
}
export const FRIEND_HERO_LEVEL = "level, with nothing outstanding";
export const FRIEND_HERO_SUB =
  "Every part of it is a fact, and each one opens.";

export const SECTIONS = {
  people: "People",
  groups: "Groups",
  members: "Members",
  ledger: "Ledger",
  together: "Together",
  parts: "Where it comes from",
  byCategory: "This month, by category",
  paidAndOwed: "Paid, and owed",
  trash: "Trash",
  results: "Results",
  archived: "Archived",
  simplification: "To zero everything out",
} as const;

export const SECTION_META = {
  people: "every group, plus what is outside one",
  groups: "the shared circles you split with",
  members: "the owner is always a member",
  ledger: "newest first",
  parts: "every part is a fact you can open",
  paidAndOwed: "the two figures a splitting tool keeps apart",
  trash: "restorable in full for 30 days",
  results: "descriptions only",
  archived: "out of the lists, and nothing lost",
  simplification: "a proposal · nothing is written by turning it on",
} as const;

export const VERBS = {
  unarchive: "Bring back",
  remind: "Remind",
  approve: "Approve",
  decline: "Decline",
  simplify: "Simplify",
  addFriend: "Add a friend",
  newGroup: "New group",
  addSomeone: "Add someone",
  addExpense: "Add expense",
  settleUp: "Settle up",
  itemise: "Itemise",
  edit: "Edit",
  remove: "Remove",
  trash: "Trash",
  rename: "Rename",
  deleteGroup: "Delete group",
  leave: "Leave",
  archive: "Archive",
  restore: "Restore",
  showMore: "Show more",
  refresh: "Refresh",
  review: "Review",
  waiting: "Waiting",
  compare: "Compare",
  export: "Export",
  openGroup: "Open",
  close: "Close",
} as const;

export const EMPTY = {
  people: "No friends yet.",
  groups: "No groups yet.",
  ledger: "No expenses in this group yet.",
  together: "No shared expenses yet.",
  trash: "Nothing in the trash.",
  spending: "Nothing spent this month.",
  archived: "No groups are archived.",
} as const;

export function removeRefused(name: string): string {
  return `${name} appears on this ledger, so removing them would make its arithmetic unreadable. Members who leave are marked departed instead.`;
}
export function removeTitle(name: string): string {
  return `${name} cannot be removed`;
}
export function removeAsk(name: string): string {
  return `Remove ${name} from this group?`;
}
export const REMOVE_BODY =
  "They hold no rows here, so the ledger reads the same without them.";

export const LEAVE_TITLE = "Leave this group?";
export const LEAVE_BODY =
  "Your rows stay on the ledger, marked departed, and your balance with the group stays visible.";
export const LEAVE_BODY_2 = "Settle first.";

export const ARCHIVE_TITLE = "Archive this group?";
export const ARCHIVE_BODY = "It leaves the lists and keeps everything.";
export const ARCHIVE_BODY_2 =
  "Archiving is not deleting, and it does not need a settled balance.";

export const UNARCHIVE_TITLE = "Bring this group back?";
export const UNARCHIVE_BODY =
  "It returns to the lists with everything it kept.";

export function pendingNotice(count: number): string {
  const writes = count === 1 ? "write is" : "writes are";
  return `${count} ${writes} on this device · they settle when the gateway answers.`;
}

export const OFFLINE_NOTICE =
  "Offline · everything here still records. Only a recurring occurrence needs the gateway.";

export function staleNotice(at: string): string {
  return `This replica last matched the vault at ${at} · the figures are that old.`;
}

export const PARKED_NOTICE =
  "A steward-only act is waiting on you · nothing is applied until you answer.";

export const CONFLICT_NOTICE =
  "Two edits to one expense · keep one, or keep both as separate expenses.";

export const PENDING_ROW = "on this device, not in the vault yet";

export function windowEnd(shown: number, total: number): string {
  return `${shown} of ${total} · this is a window on the ledger, not all of it`;
}

export const DENIED_TITLE = "Tally cannot read this vault";
export const DENIED_BODY =
  "Your expenses, groups and receipts are untouched, and nothing was deleted.";
export function revokedAt(at: string): string {
  return `The grant was revoked at ${at}.`;
}
export const REVOKED_UNKNOWN =
  "The grant is gone, and the time it went with it.";
export const DENIED_REGRANT =
  "Re-grant tally.read and tally.write to see them again.";
export const DENIED_SCOPE = "tally.read · tally.write";
export const DENIED_MEMBERS =
  "Members still hold their own copies of the facts";
export const DENIED_FACT_LABELS = {
  receipt: "Receipt",
  scope: "Scope",
  members: "Members",
} as const;

export const SETTLEMENT_NOT_YOURS =
  "neither party is you · no ledger entry, balances only";

export function partSubLabel(netMinor: number): string {
  if (Math.abs(netMinor) < 1) return "";
  return netMinor < 0 ? "you owe" : "owes you";
}

export const IOU_TITLE = "An IOU recorded in People";
export const IOU_META =
  "a standing obligation · Tally reads it and never writes it";
export const OUTSIDE_ANY_GROUP = "Outside any group";

export const PURGE_UNKNOWN = "purges 30 days after it was trashed";
export function purgesOn(day: string): string {
  return `purges on ${day}`;
}
export function trashedOn(day: string): string {
  return `trashed ${day}`;
}

export const SEARCH_PLACEHOLDER = "Search expense descriptions";
export const SEARCH_SCOPE = "expense descriptions in this vault";
export const SEARCH_COPY = {
  resting: {
    eyebrow: "Search",
    title: "Descriptions only",
    body: "An expense is found by what it was called — amounts and people are not searched.",
  },
  searching: {
    lead: "Searching descriptions.",
    trail: () => "so far",
  },
  miss: {
    eyebrow: "No match",
    title: (query: string) => `Nothing matches “${query}”.`,
    body: "Amounts and people are not searched.",
    clear: "Clear",
  },
  unreachable: {
    eyebrow: "Not searched",
    title: "The index did not answer",
    body: "Nothing was checked, so nothing can be reported as missing.",
    facts: [{ label: "Scope", value: "expense descriptions" }],
    retry: "Try again",
  },
} as const;

export const MATCHED_DESCRIPTION = "matched the description";

export const OUTCOMES = {
  restored: "Restored · back on the ledger with its history",
  trashed: "Trashed · restorable for 30 days",
  removed: "Removed · the group reads the same without them",
  friendIsAPerson: "A friend is a person in People · adding one writes there",
  groupNeedsAName: "A group needs a name, an icon and a colour",
  refreshed: "Refreshed · the vault answered",
} as const;

export const REFUSED = "Refused · the vault would not take it";

export const PARKED_OUTCOME =
  "Parked · nothing is applied until the steward answers";

export const ROUTE_STATUS = {
  balances: BALANCES_STATUS,
  activity: "One line per fact, from your point of view",
  groups:
    "A group is a shared circle · members co-contribute from their own vaults",
  group:
    "Shared for co-contribution · receipts, deletion and templates stay with you as steward",
  groupOwn: "Yours alone · sharing it makes every member a writer",
  friend:
    "Groups, group-less expenses and People's obligations, added up here and nowhere else",
  expense: "Every edit is a revision · undo is one shot, in the window here",
  add: "Six ways to divide it · the method is recorded with the shares",
  receipt:
    "Photograph and OCR happen on the phone · the allocation is what Tally owns",
  settle:
    "Recording a payment is the model · there is no payment rail in this product",
  recurring:
    "A schedule is a sentence · where it cannot be, there is no preview at all",
  contrib:
    "Every contribution says whose it is, where it is, and what it is waiting on",
  insight: "A settling tool with a read view · not an analytics product",
  trash: "Restorable in full · purge happens on the date, never on a button",
  search: "Descriptions only · a shelf, reachable from anywhere",
  export: "Local-first makes leaving possible · that is the point of it",
  denied: "Tally has no grant on this vault",
} as const;

export const MORE_FOOT = "Lenses and acts · the four places are in the band";
export const MORE_TITLE = "Tally";
export const MORE_META = {
  recurring: "templates, and what is due",
  insight: "by category, this month",
  search: "expense descriptions",
  trash: "30 days, restorable",
  export: "a group ledger, as a file",
} as const;

export const RAIL_HEADS = {
  ledger: "The ledger",
  groups: "Groups",
  people: "People",
} as const;

export const SPENDING_META = {
  paid: "what left your account",
  share: "what the splits make yours",
  difference: "carried in balances, not a saving",
} as const;

export const SPEND_ROWS = {
  paid: "You paid",
  share: "Your share",
  difference: "The difference",
} as const;

export const ARCHIVED_META = "archived · out of the lists, everything kept";
export const DEPARTED_META =
  "departed · kept on the ledger with the balance they left";
export const ON_THE_LEDGER = "on the ledger · cannot be removed";
export const CO_CONTRIBUTES = "co-contributes from their own vault";

export function owedFor(days: number): string {
  return `owed ${days} ${days === 1 ? "day" : "days"}`;
}

export const NUDGE_PARKED =
  "Prepared, awaiting your confirmation · nothing is sent from here";

export function memberCount(count: number): string {
  return `${count} ${count === 1 ? "member" : "members"}`;
}
export function expenseCount(count: number): string {
  return `${count} ${count === 1 ? "expense" : "expenses"}`;
}
export function sharedExpenseCount(count: number): string {
  return `${count} shared ${count === 1 ? "expense" : "expenses"}`;
}

export const FRIEND_PARTS_NOTE =
  "The net above is these parts added up · each one is derived from the same facts";

export function paidBy(name: string, isMe: boolean): string {
  return isMe ? "you paid" : `${name} paid`;
}
