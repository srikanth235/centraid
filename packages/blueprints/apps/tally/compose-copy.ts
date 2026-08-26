// Every member-facing string on the routes that COMPOSE — Add expense, the
// expense, the receipt, Settle up, Recurring, Waiting and Export — plus the
// five small surfaces that mint a friend, a group or a member.
//
// A SECOND COPY FILE, not a bigger one. `view-copy.ts` is the ledger's
// vocabulary and it is already the longest file in this app; the composing
// surfaces have a vocabulary of their own (a field key, a reconcile line, a
// foot that says where a write lands) and they arrive WITH the surfaces that
// render them. A string nothing can show is a string nobody can check.
//
// THE SIX §6 STRINGS THIS WAVE OWNS ARE VERBATIM: the currency note, the
// unsummarisable schedule, the due occurrence, the simplification proposal,
// the trash confirm and the export foot. Wave 1 deliberately left them out
// because their surfaces did not exist yet; they are back, unaltered, beside
// the surfaces that carry them.
//
// A GAP TAG IS ON THE SURFACE, not only in the register. A reviewer reading
// this app should be able to see the scope without opening `GAPS.md`, which is
// why `[backend-needed]` and `[open-question]` are written into the field notes
// rather than kept as a comment.

// ------------------------------------------------------- the §6 verbatim six

/** Add expense → Currency. There is no rate provider anywhere in this path. */
export const CURRENCY_NOTE =
  "The rate is supplied at entry, with its source and date; there is no rate provider.";

/** Recurring → a rule the summariser cannot phrase. No preview at all, and it
 *  says why — raw rule syntax on a member-facing surface is banned outright. */
export const UNSUMMARISABLE =
  "This one’s schedule cannot be put in a sentence, so there is no preview.";

/** Recurring → Due next. The one write in Tally with no optimistic copy. */
export const DUE_OCCURRENCE =
  "materialises on the gateway · the one write with no optimistic copy";

/** Settle up → the proposal below the fields. Opt-in per group, off by
 *  default, and it always states what it changed. */
export const SIMPLIFICATION =
  "Five debts become three payments. Simplification rewires who owes whom, so it is off unless a group turns it on, and it says what it changed.";

/** The expense's life row → Trash. */
export const TRASH_BODY =
  "Trashed for 30 days, restorable whole with its splits, revisions and receipt — and every member sees it leave.";

/** Export → the foot, in the `--net` register: it leaves the device. */
export const EXPORT_FOOT = "The file leaves the vault the moment you save it";

// --------------------------------------------------------------- Add expense

export const ADD_HEAD = "Add an expense";
export const EDIT_HEAD = "Edit this expense";
export const ADD_LEDE =
  "Description and amount are typed — everything else is a chip, because it is a choice from a set.";

export const FIELD_KEYS = {
  what: "What was it",
  amount: "How much",
  paidBy: "Paid by",
  group: "Group",
  category: "Category",
  when: "When",
  currency: "Currency",
  divided: "Divided",
  yourShare: "Your share",
  memo: "Memo",
  receipt: "Receipt",
  bankLine: "Bank line",
  history: "Revisions",
  from: "From",
  to: "To",
  range: "Range",
  format: "Format",
  rate: "Rate",
  source: "Source",
  entered: "Entered in",
  schedule: "Schedule",
  timeZone: "Time zone",
  status: "Status",
  name: "Name",
  icon: "Icon",
  colour: "Colour",
  members: "Members",
} as const;

export const PLACEHOLDERS = {
  description: "Dinner at the Ship",
  amount: "0.00",
  currency: "EUR",
  rate: "1.1636",
  rateSource: "read off the receipt",
  friend: "Their name",
  group: "14 Sitwell Road",
} as const;

export const FIELD_NOTES = {
  paidBy: "A payer must be a member of the group, re-validated by the vault.",
  group:
    "No group is a friend-to-friend expense. Settlements already work without one; expenses are [open-question] — the command requires a group.",
  category: "Nine, closed — Spending reads this and nothing else.",
  when: "Today, unless it was not today.",
  settlementCurrency: "The settlement currency of the group.",
  divided:
    "Three of these six exist in the vault today — the other three are engineering asks.",
  alloc: "Who it is divided between",
} as const;

export const CURRENCY_CHIPS = {
  home: "This currency",
  other: "Another currency",
} as const;

export const WHEN_CHIPS = {
  today: "Today",
  yesterday: "Yesterday",
  pick: "Pick a date",
} as const;

export const NO_GROUP_LABEL = "No group";

/** Where the write lands, said BEFORE the commit rather than after it. */
export function addFoot(groupName: string | null): string {
  const where = groupName ?? NO_GROUP_LABEL;
  return `Lands in ${where} · queued on this device until the gateway answers`;
}

export const ADD_COMMIT = "Add expense";
export const EDIT_COMMIT = "Save edit";
export const CANCEL = "Cancel";

// ------------------------------------------------------------- the expense

export const EXPENSE_NOTES = {
  paidBy:
    "One payer per expense today. Two people splitting the bill at the till is [backend-needed].",
  divided:
    "Equally, exact amounts and percentages are the three the vault validates. Shares, adjustments and typed line items are [backend-needed].",
  yourShare: "Derived here from this expense alone; no share is stored.",
  group:
    "A group is a shared circle of the superapp — the same circle Photos and Docs share to.",
  memo: "A running annotation, yours alone. Writing one is assistant-only today; this row is where it belongs.",
  receipt:
    "A reference to bytes that live once, in the content spine — Docs shows the same file.",
  bankLine:
    "Bind, never duplicate. Currently an assistant-only command; this row is where it belongs.",
  history:
    "Every edit is durable and inspectable, and undo is one shot inside the window the vault keeps.",
} as const;

export const EXPENSE_ROWS = {
  splitHead: "How it divides",
  revisions: "Revisions",
  noMemo: "No memo.",
  noBankLine: "Not bound to a transaction",
  noRevisions: "No revisions yet.",
} as const;

/** How an expense divided, said WITHOUT claiming a method. The vault stores
 *  the shares, not the rule that produced them, so the row states the shares
 *  and points at the table rather than inventing "equally". */
export function dividedValue(count: number): string {
  return `${count} ${count === 1 ? "share" : "shares"} · listed below`;
}

/** The pending strip's sentence on the expense that carries the held write. */
export const PENDING_STRIP =
  "On this device · queued for the vault, and for the other members";
export const PENDING_VIEW = "View";

export function splitFoot(total: string, count: number): string {
  return `The ${count} shares sum to ${total}. They are computed here, from this expense — nothing on this screen was read from a stored figure.`;
}

export function revisionCount(count: number): string {
  return `${count} ${count === 1 ? "revision" : "revisions"} · newest first`;
}

export function revisionLine(operation: string, at: string): string {
  return `${operation} · ${at}`;
}

/** Two edits to one expense reached the replica: BOTH sides are shown, and
 *  neither is picked for the member. */
export const CONFLICT_BOTH =
  "Two revisions of this expense · keep one, or keep both as separate expenses";

export const UNDO_VERB = "Undo";
export const UNDO_SPENT = "already undone";

export const LIFE_ACTS = {
  edit: "Edit",
  itemise: "Itemise",
  trash: "Trash",
} as const;

export const TRASH_TITLE = "Trash this expense?";

// -------------------------------------------------------------- the receipt

export const RECEIPT_HEAD = "The lines, allocated";
export const RECEIPT_LEDE_ORIGIN =
  "Photographed at the table, and reviewed in the capture flow — what happens here is who had what.";
export const RECEIPT_LEDE_OTHER =
  "Photographing a receipt is the phone's job. On this seat the lines are here to allocate; the capture itself says so.";
export const RECEIPT_SHOT_ALT = "The receipt";
export const RECEIPT_SHOT_ABSENT = "the photograph · a document in the vault";
export const RECEIPT_COMMIT = "Save allocation";
export const RECEIPT_UNBUILT =
  "Re-allocating a receipt already in the vault is an engineering ask [backend-needed]";
export const RECEIPT_NONE =
  "This expense has no receipt — capture belongs to the phone.";
export function unallocatedLines(count: number): string {
  return `${count} ${count === 1 ? "line has" : "lines have"} nobody on them`;
}

// -------------------------------------------------------------- settle up

export const SETTLE_HEAD = "Settle up";
export const SETTLE_LEDE =
  "A settlement records a payment that happened. Nothing moves money; there is no payment rail in this product.";
/** The bank-line row's value: the act it WOULD offer, named so the row is not
 *  a note with nothing above it. */
export const BANK_LINE_VALUE = "Bind to an imported transaction";
export const SETTLE_NOTES = {
  from: "Anyone to anyone, including two friends with you as neither party.",
  group:
    "A settlement can sit outside every group, and a partial payment is a smaller amount.",
  bankLine: "Bind, never duplicate · assistant-only today.",
} as const;
export const SETTLE_COMMIT = "Record it";
export const SETTLE_FOOT_YOURS =
  "A payment where you are a party also lands in the finance ledger, as a core transaction";
export const SETTLE_FOOT_THEIRS =
  "neither party is you · no ledger entry, balances only";
export const SIMPLIFY_HEAD = "To zero everything out";
export const SIMPLIFY_COMMIT = "Turn it on";
export const SIMPLIFY_UNBUILT =
  "A minimal-transfer engine is an engineering ask [backend-needed]";
export const SIMPLIFY_OFF =
  "Off for this group · debts read as they were incurred";

// --------------------------------------------------------------- recurring

export const RECURRING_SECTIONS = {
  templates: "Templates",
  due: "Due next",
} as const;
export const RECURRING_META = {
  templates: "a schedule, a time zone and a status",
  due: "they become ordinary expenses",
} as const;
export const RECURRING_EMPTY = {
  templates: "No templates yet.",
  due: "Nothing is due.",
} as const;
export const RECURRING_VERBS = {
  pause: "Pause",
  resume: "Resume",
  skip: "Skip next",
  materialise: "Materialise",
  edit: "Edit",
} as const;
export const NO_PREVIEW = "no preview";
export const TEMPLATE_UNSAVEABLE =
  "This template is missing fields the save command requires, so its acts are withheld";
export const TEMPLATE_HEAD = "Edit this template";
export const TEMPLATE_LEDE =
  "A template splits by weight, so a share can be two parts to one without a percentage.";
export const TEMPLATE_WEIGHTS = "Weights";
export const TEMPLATE_COMMIT = "Save template";
export function weightLine(parts: readonly string[]): string {
  return `${parts.join(" : ")} · weights, not amounts`;
}

// ----------------------------------------------------------------- waiting

export const CONTRIB_SECTIONS = {
  waiting: "Waiting on you",
  inFlight: "On a device",
  ended: "Ended",
} as const;
export const CONTRIB_META = {
  waiting: "steward-only acts stop here",
  inFlight: "not lost, not applied — in flight",
  ended: "expired, refused or cancelled, with the reason",
} as const;
export const CONTRIB_EMPTY = {
  waiting: "Nothing is waiting on you.",
  inFlight: "Nothing in flight.",
  ended: "Nothing ended.",
} as const;
export const CONTRIB_VERBS = {
  cancel: "Cancel",
  retry: "Retry",
  discard: "Discard",
  approvals: "Review",
} as const;
/** Accept and Decline are the steward's answer, and the app client has no
 *  per-intent door for either — the shell's Approvals inbox does. The row says
 *  where the answer is given rather than drawing two buttons that cannot. */
export const CONTRIB_APPROVALS_NOTE =
  "Accept and Decline are given in Approvals · no per-intent door reaches this app [backend-needed]";
export const CONTRIB_NO_DOOR =
  "This host holds no approval inbox, so the act waits where it is";

// ------------------------------------------------------------------ export

export const EXPORT_HEAD = "Export a ledger";
export const EXPORT_LEDE =
  "Every expense, split, settlement and revision in the group, as a file on this device.";
export const EXPORT_NOTE =
  "The file carries splits and revisions, not balances — balances are arithmetic, and arithmetic travels in the rows.";
export const EXPORT_COMMIT = "Export";
export const EXPORT_UNBUILT = "Export is an engineering ask [backend-needed]";
export const EXPORT_RANGES: readonly (readonly [string, string])[] = [
  ["all", "Everything"],
  ["year", "This year"],
  ["month", "This month"],
];
export const EXPORT_FORMATS: readonly (readonly [string, string])[] = [
  ["csv", "CSV"],
  ["json", "JSON"],
];

// ------------------------------------------------- friends, groups, members

export const FRIEND_HEAD = "Add a friend";
export const FRIEND_BODY =
  "A friend is a person in People — adding one writes there, and every app knows the same person.";
export const FRIEND_COMMIT = "Add";

export const GROUP_HEAD = "New group";
export const GROUP_BODY =
  "A group needs a name, an icon and a colour, and you are a member from the start.";
export const GROUP_COMMIT = "Create";
export const RENAME_HEAD = "Rename this group";
export const RENAME_COMMIT = "Rename";
export const MEMBER_HEAD = "Add someone";
export const MEMBER_BODY =
  "Only a person in People can join a group; add them as a friend first.";
export const MEMBER_COMMIT = "Add";
export const MEMBER_NONE = "Everyone you know is already in this group.";
export const DELETE_GROUP_HEAD = "Delete this group?";
export const DELETE_GROUP_BODY =
  "A group with expenses on it cannot be deleted — an empty one goes for good.";
export const DELETE_GROUP_COMMIT = "Delete";

export const GROUP_ICONS: readonly (readonly [string, string])[] = [
  ["home", "Home"],
  ["users", "People"],
  ["map", "Travel"],
  ["coin", "Money"],
];
export const GROUP_COLOURS: readonly (readonly [string, string])[] = [
  ["indigo", "Indigo"],
  ["teal", "Teal"],
  ["ochre", "Ochre"],
  ["rose", "Rose"],
];

// ---------------------------------------------------------------- outcomes

/** What the one status line says after each of this wave's writes. */
export const COMPOSE_OUTCOMES = {
  added:
    "Queued on this device · it reaches the others when the gateway answers",
  edited: "Saved · the edit is a revision, and both sides are kept",
  undone: "Undone · the expense is back as it was",
  trashed: "Trashed · restorable for 30 days",
  settled: "Recorded · a payment that happened, not one that will",
  friendAdded: "Added · a person in People, known to every app",
  groupCreated: "Created · you are a member of it from the start",
  groupRenamed: "Renamed · the ledger is untouched",
  memberAdded: "Added · they can co-contribute from their own vault",
  groupDeleted: "Deleted · it held no expenses",
  paused: "Paused · nothing materialises until it resumes",
  resumed: "Resumed · the next occurrence is back on",
  skipped: "Skipped · this occurrence only, the series is untouched",
  materialised: "Materialised · an ordinary expense now",
  templateSaved: "Saved · the schedule is a sentence again",
  cancelled: "Cancelled · it was never applied",
  discarded: "Discarded · the row is gone",
  retried: "Retried · a fresh attempt at the same write",
} as const;

export const OFFLINE_MATERIALISE =
  "Offline · this one needs the gateway, and nothing else here does";
