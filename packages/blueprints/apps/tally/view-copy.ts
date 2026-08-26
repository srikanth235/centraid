// Every member-facing string in Tally, in one file.
//
// THE SPEC'S §6 TABLE IS VERBATIM. Where a sentence in the handoff carries a
// value the prototype had and this app derives — the friend's name in the
// removal guard, the query in the search miss, the revocation's own receipt —
// the string is a function of that value rather than a copy of the prototype's
// example. Two strings in that table also carried data no query returns (a
// count of expenses and settlements behind the Balances sub-line; a wall clock
// on the denied gate); those clauses are DROPPED rather than invented, which
// is the same rule the rest of the room follows about figures.
//
// THE REGISTER (§7). Nine categories, closed. The words are *expense,
// settlement, group, member, departed, steward, contribution, ledger, share,
// memo* — never *transaction*, never *friend request*, never *simplify debts*
// as a noun. A number lives in a sentence, a figure is a fact and never a
// verdict, and nothing in here celebrates a settled balance.

/** The one sentence Balances stands under: what a figure on this screen IS. */
export const BALANCES_STATUS =
  "Every figure is derived at read time · no balance is stored and none is transmitted";

/** Every balance level. Stated, never celebrated — no tick, no colour, no
 *  congratulation, because the ledger is the point and not the score. */
export const ALL_SETTLED =
  "Everyone is level · the ledger keeps every expense that got you here";

export const DAY_ONE = "Nothing is split yet.";
export const DAY_ONE_SUB =
  "The first real move is one expense with one person; a group can wait for three of you.";
export const DAY_ONE_ACT = "Add an expense";

/** The invariant under the hero, with the two totals the dashboard derived. */
export function balancesHeroSub(owedTo: string, owe: string): string {
  return `Owed to you ${owedTo} · you owe ${owe}. No balance is stored, and none is ever sent.`;
}

export const HERO_OWE = "you owe, on balance";
export const HERO_OWED = "owed to you, on balance";
export const HERO_LEVEL = "nothing outstanding, with anyone";
export const HERO_SETTLED_SUB =
  "Every group and every friend is level, and the ledger keeps all of it.";

/** The group hero's label and the sentence that says where its figure came
 *  from — every member computes it themselves, from the same facts. */
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

// ---------------------------------------------------------------- sections

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
} as const;

export const VERBS = {
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

// ------------------------------------------------------------ empty lines

export const EMPTY = {
  people: "No friends yet.",
  groups: "No groups yet.",
  ledger: "No expenses in this group yet.",
  together: "No shared expenses yet.",
  trash: "Nothing in the trash.",
  spending: "Nothing spent this month.",
} as const;

// ------------------------------------------------------------- the guards

/**
 * The removal guard, refusing. The prototype's sentence named one member by
 * pronoun; the real one names the member, because the guard is about THIS
 * person's rows and a pronoun would be a guess about them.
 */
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
  "Your rows stay on the ledger, marked departed, with your balance still visible — settle first.";

export const ARCHIVE_TITLE = "Archive this group?";
export const ARCHIVE_BODY =
  "It leaves the lists and keeps everything, and needs no settled balance.";

/** Why the two group acts cannot fire yet. A confirm that fired anyway would
 *  be the lie; a control that vanished would teach nothing. */
export const LEAVE_UNBUILT = "Leaving a group is an engineering ask";
export const ARCHIVE_UNBUILT = "Archiving a group is an engineering ask";

// ------------------------------------------------------------- the notices

export function pendingNotice(count: number): string {
  const writes = count === 1 ? "write is" : "writes are";
  return `${count} ${writes} on this device · they settle when the gateway answers.`;
}

/** Tally records fully offline. The ONE exception is named, rather than left
 *  for a member to discover at a commit. */
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

// -------------------------------------------------------------- the window

export function windowEnd(shown: number, total: number): string {
  return `${shown} of ${total} · this is a window on the ledger, not all of it`;
}

// --------------------------------------------------------------- the gate

export const DENIED_TITLE = "Tally cannot read this vault";
export const DENIED_BODY =
  "Your expenses, groups and receipts are untouched, and nothing was deleted.";
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

// -------------------------------------------------------------- the lenses

/* The spec's §6 table also carries the currency note, the unsummarisable
   schedule, the due occurrence, the simplification proposal, the trash confirm
   and the export foot. They belong to the routes Wave 2 draws — Add expense,
   Recurring, Settle up, Expense and Export — and they arrive WITH those
   surfaces rather than sitting here unrendered: a string nothing can show is a
   string nobody can check. */

export const SETTLEMENT_NOT_YOURS =
  "neither party is you · no ledger entry, balances only";

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

// -------------------------------------------------------------- the search

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

// ----------------------------------------------------------- the outcomes

/** What the one status line says after a write. Every act resolves out loud;
 *  Undo appears only beside a write whose reverse is a real write. */
export const OUTCOMES = {
  restored: "Restored · back on the ledger with its history",
  trashed: "Trashed · restorable for 30 days",
  removed: "Removed · the group reads the same without them",
  friendIsAPerson: "A friend is a person in People · adding one writes there",
  groupNeedsAName: "A group needs a name, an icon and a colour",
  refreshed: "Refreshed · the vault answered",
} as const;

/** A refusal the vault gave no words for. It never paraphrases the vault's own
 *  reason — this is only what stands in when there is none. */
export const REFUSED = "Refused · the vault would not take it";

/** A write that stopped at the steward. Not applied, and not lost. */
export const PARKED_OUTCOME =
  "Parked · nothing is applied until the steward answers";

// ------------------------------------------------------- the status lines

/** The ambient sentence each route stands under, before any write speaks. */
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
  add: "Three split methods are backed today · three are engineering asks",
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

/** The More sheet's own foot: what sits behind it, and what does not. */
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

export const DEPARTED_META =
  "departed · kept on the ledger with the balance they left";
export const ON_THE_LEDGER = "on the ledger · cannot be removed";
export const CO_CONTRIBUTES = "co-contributes from their own vault";

export function memberCount(count: number): string {
  return `${count} ${count === 1 ? "member" : "members"}`;
}
export function expenseCount(count: number): string {
  return `${count} ${count === 1 ? "expense" : "expenses"}`;
}
export function sharedExpenseCount(count: number): string {
  return `${count} shared ${count === 1 ? "expense" : "expenses"}`;
}

/** The one part of a friend's net Tally cannot yet open: the query returns the
 *  net whole, so a per-part figure would have to be re-derived here. */
export const FRIEND_PARTS_NOTE =
  "The net above is the sum of these parts · a figure per part is an engineering ask";

export function paidBy(name: string, isMe: boolean): string {
  return isMe ? "you paid" : `${name} paid`;
}
