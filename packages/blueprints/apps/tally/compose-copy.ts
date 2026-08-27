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
// NO GAP TAG SURVIVES HERE. Every capability these surfaces name is now
// backed by a command or a query the app actually calls, so the field notes
// carry the RULE rather than the register: what the vault checks, what a
// method means, where a write lands. A tag left standing over a wired control
// would be the same lie in the other direction.

// ------------------------------------------------------- the §6 verbatim six

/**
 * Add expense → Currency. There is no rate provider anywhere in this path.
 *
 * HELD AS TWO LITERALS, rendered one after the other: the §6 note is two
 * claims — where the rate came from, and that nothing supplies one — and the
 * copy rule this repo enforces is that a string carries a single thought. What
 * a member reads is the handoff's sentence pair, unaltered.
 */
export const CURRENCY_NOTE =
  "The rate is supplied at entry, with its source and date.";
export const CURRENCY_NOTE_2 =
  "There is no rate provider, and the vault works with none.";

/** Add expense → Currency, beside a pair this vault has already been told a
 *  rate for. ADDITIVE: the manual flow is the primary path and stands alone. */
export const RATE_SUGGESTION_NOTE =
  "A rate this vault was already given for the same pair · press to fill it in";
export function rateSuggestionChip(
  rate: string,
  source: string,
  date: string
): string {
  return `${rate} · ${source} · ${date}`;
}

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
  payers: "Who put money down",
  lines: "The lines",
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
  line: "Two flat whites",
} as const;

export const FIELD_NOTES = {
  paidBy: "A payer must be a member of the group, re-validated by the vault.",
  group:
    "No group is a friend-to-friend expense · participants are checked against the friend roster instead of a circle.",
  category: "Nine, closed — Spending reads this and nothing else.",
  when: "Today, unless it was not today.",
  settlementCurrency: "The settlement currency of the group.",
  divided:
    "The method is recorded beside the shares, so an edit re-opens the way it was entered.",
  alloc: "Who it is divided between",
  payers:
    "Several payers each put down their part, and the parts sum to the total.",
  lines: "Type the lines, then press whoever was on each of them.",
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

/** The typed-lines table's own verbs and marks. */
export const LINE_VERBS = {
  add: "Add a line",
  remove: "Remove",
  paidItAll: "paid all of it",
  whoWasOn: "Who was on",
} as const;

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
    "Several people can front one expense · each is owed back the part they put down.",
  divided: "The recorded method, with the numbers that produced these shares.",
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

/** The mark on a split row belonging to somebody who fronted part of it. */
export const PAID_IT = "paid it";

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
export const SIMPLIFY_OFF =
  "Off for this group · debts read as they were incurred";
export const SIMPLIFY_ON = "On for this group · the proposal is below";
export const SIMPLIFY_STOP = "Turn it off";
/** What it CHANGED, in the group's own figures. The §6 sentence states the
 *  shape; this states the instance, because a proposal that did not say what
 *  it rewired would be exactly the silent re-wiring the ruling forbids. */
export function simplifyChanged(before: number, after: number): string {
  const debts = `${before} ${before === 1 ? "debt becomes" : "debts become"}`;
  const payments = `${after} ${after === 1 ? "payment" : "payments"}`;
  return `${debts} ${payments}`;
}
export const SIMPLIFY_NONE = "Nothing to rewire · this group is already level";
export function transferLine(from: string, to: string, amount: string): string {
  return `${from} pays ${to} ${amount}`;
}

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
  approve: "Approve",
  decline: "Decline",
} as const;
export const CONTRIB_NO_DOOR =
  "This host holds no approval inbox, so the act waits where it is";
/** Reminders the owner PREPARED. Nothing here was ever sent — Tally has no
 *  delivery path, and the record is the intention. */
export function nudgeTitle(name: string): string {
  return `Remind ${name}?`;
}
export const NUDGE_BODY =
  "The reminder is recorded as your intention, and it waits for you to confirm it.";
export const NUDGE_COMMIT = "Prepare it";
export const NUDGE_SECTION = "Reminders prepared";
export const NUDGE_META = "prepared, and never sent";
export const NUDGE_EMPTY = "No reminders prepared.";
export function nudgePrepared(name: string, at: string): string {
  return `${name} · prepared ${at}`;
}

// ------------------------------------------------------------------ export

export const EXPORT_HEAD = "Export a ledger";
export const EXPORT_LEDE =
  "Every expense, split, settlement and revision in the group, as a file on this device.";
export const EXPORT_NOTE =
  "The file carries splits and revisions, not balances — balances are arithmetic, and arithmetic travels in the rows.";
export const EXPORT_COMMIT = "Export";
export const EXPORT_NO_GROUP = "A group · a ledger is a group's";
export function exportWindow(
  expenses: number,
  settlements: number,
  truncated: boolean
): string {
  const rows = `${expenses} expenses and ${settlements} settlements`;
  return truncated
    ? `${rows} · more than the window holds, so the file carries the window`
    : `${rows} · the whole of them`;
}
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
  reallocated: "Re-allocated · a revision, and the amount is unchanged",
  simplifyOn: "On · the proposal says what it rewired",
  simplifyOff: "Off · debts read as they were incurred again",
  left: "Left · your rows stay, marked departed",
  archived: "Archived · out of the lists, everything kept",
  unarchived: "Back · in the lists again, with everything it kept",
  approved: "Approved · it runs on the signed rail",
  declined: "Declined · settled with your reason, and never applied",
  decidedAlready: "Already settled · your answer arrived after it did",
  exported: "Exported · the file is on this device now",
} as const;

export const OFFLINE_MATERIALISE =
  "Offline · this one needs the gateway, and nothing else here does";
