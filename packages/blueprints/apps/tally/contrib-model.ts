// WAITING — the multi-writer surface, as three sections and the verbs each
// state actually permits (Tally spec §1, FLOWS.md "Group co-contribution").
//
// NOT A QUEUE WIDGET. Every row here is an INTENT from somebody's own vault
// with an honest outcome — queued, parked, expired, refused — and the row says
// whose it is, where it is, and what it is waiting on. A number on a badge
// would say none of that, which is why the band carries no count and this
// surface carries the sentences.
//
// THE VERB GRAMMAR IS THE OUTBOX'S, NOT THIS APP'S. `_shared/pending-overlay.ts`
// already decides that a denied write may be retried and an expired one may
// only be discarded; the door those verbs go through is `window.centraid`'s
// (`retryPendingWrite`, `discardPendingWrite`, `cancelCommonsIntent`,
// `openApprovals`). This module maps one to the other and NOTHING else — in
// particular it never invents an Accept or a Decline, because no per-intent
// approval door exists on the app client: a steward answers in the shell's own
// Approvals inbox, and the row says so and hands over.
//
// EMPTY IS THE HEALTHY STATE. Three empty sections are the ordinary Tuesday,
// so each says so in its own words rather than the screen collapsing to one
// generic nothing.

/** One intent, as `window.centraid.commonsIntents()` answers with it. Restated
 *  structurally rather than imported: `CentraidCommonsIntent` is an ambient
 *  global, and a pure model should be testable without the DOM lib. */
export interface Intent {
  intentId: string;
  actorPartyId: string;
  command: string;
  input: Readonly<Record<string, unknown>>;
  status: string;
  reason?: string;
  stewardLabel?: string;
  createdAt: string;
}

/** What a row offers. Each maps to exactly one door on `window.centraid`; a
 *  verb whose door the host does not provide is not drawn at all. */
export type ContribVerb = "cancel" | "retry" | "discard" | "approvals";

export type ContribSection = "waiting" | "inFlight" | "ended";

export interface ContribRow {
  intentId: string;
  section: ContribSection;
  /** Whose write this is, in the words the row uses. */
  who: string;
  /** Is it this member's own? Their own writes read as "you". */
  mine: boolean;
  title: string;
  /** Why it stopped where it stopped. */
  reason: string;
  /** The status chip's word, upper-cased by the leaf, not here. */
  status: string;
  /** `seam` is "not yet, and not wrong"; `net` is ended. */
  tone: "none" | "seam" | "net";
  /** Does the row take the 2px leading rule of an unsettled write? */
  pending: boolean;
  verbs: ContribVerb[];
}

/** The command, as a sentence fragment. The stored name is `tally.add_expense`
 *  and a member should never read that: the vault's own vocabulary is not the
 *  product's. */
export function commandLabel(command: string): string {
  if (typeof command !== "string" || command === "") return "A change";
  const tail = command.includes(".")
    ? command.slice(command.lastIndexOf(".") + 1)
    : command;
  const words = tail.replaceAll("_", " ").trim();
  if (words === "") return "A change";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What the intent is ABOUT, where its input says so. A description or a name
 *  is the subject a member recognises; everything else falls back to the act. */
export function intentTitle(intent: Intent): string {
  // The overlay is the HOST'S payload, not this app's: a row that arrives
  // without its input is still a row, and a title is still owed for it.
  const input = intent.input ?? {};
  const description = input.description;
  if (typeof description === "string" && description !== "")
    return `${commandLabel(intent.command)} · ${description}`;
  const name = input.name;
  if (typeof name === "string" && name !== "")
    return `${commandLabel(intent.command)} · ${name}`;
  return commandLabel(intent.command);
}

const REASON: Readonly<Record<string, string>> = {
  queued:
    "on a device, not in the vault yet · it lands when the gateway answers",
  parked:
    "steward-only, so it waits for an answer · nothing is applied until then",
  denied: "the vault refused it, and said why",
  expired: "it expired before it reached a gateway",
  cancelled: "cancelled before it was applied",
};

function reasonOf(intent: Intent): string {
  if (typeof intent.reason === "string" && intent.reason !== "")
    return intent.reason;
  return REASON[intent.status] ?? "not applied";
}

function verbsFor(
  intent: Intent,
  mine: boolean,
  doors: ContribDoors
): ContribVerb[] {
  const out: ContribVerb[] = [];
  if (intent.status === "parked" && !mine && doors.approvals)
    out.push("approvals");
  if (
    (intent.status === "queued" || intent.status === "parked") &&
    mine &&
    doors.cancel
  )
    out.push("cancel");
  if (intent.status === "denied" && doors.retry) out.push("retry");
  if (
    (intent.status === "denied" ||
      intent.status === "expired" ||
      intent.status === "cancelled") &&
    doors.discard
  )
    out.push("discard");
  return out;
}

/** Which doors this host actually provides. An absent door draws no control —
 *  a button that cannot fire teaches a member something false. */
export interface ContribDoors {
  cancel: boolean;
  retry: boolean;
  discard: boolean;
  approvals: boolean;
}

function sectionOf(intent: Intent, mine: boolean): ContribSection | null {
  if (intent.status === "executed") return null;
  if (intent.status === "parked") return mine ? "inFlight" : "waiting";
  if (intent.status === "queued" || intent.status === "sending")
    return "inFlight";
  return "ended";
}

export interface ContribSections {
  waiting: ContribRow[];
  inFlight: ContribRow[];
  ended: ContribRow[];
  /** How many rows there are in all — the count the surface states while the
   *  member is standing in it, and never on the band. */
  total: number;
}

/**
 * The three sections, in the order the surface draws them. An executed intent
 * is GONE rather than shown as done: it settled, and the ledger below is where
 * it now lives.
 */
export function contribSections(input: {
  intents: readonly Intent[];
  me: string | null;
  /** Party id → the name this vault knows them by. */
  names: ReadonlyMap<string, string>;
  doors: ContribDoors;
}): ContribSections {
  const rows: ContribRow[] = [];
  for (const intent of input.intents) {
    const mine = input.me !== null && intent.actorPartyId === input.me;
    const section = sectionOf(intent, mine);
    if (section === null) continue;
    rows.push({
      intentId: intent.intentId,
      section,
      who: mine
        ? "you"
        : (input.names.get(intent.actorPartyId) ?? "another member"),
      mine,
      title: intentTitle(intent),
      reason: reasonOf(intent),
      status: intent.status,
      tone:
        intent.status === "parked"
          ? "seam"
          : intent.status === "expired" || intent.status === "denied"
            ? "net"
            : "none",
      pending: intent.status === "queued" || intent.status === "parked",
      verbs: verbsFor(intent, mine, input.doors),
    });
  }
  return {
    waiting: rows.filter((row) => row.section === "waiting"),
    inFlight: rows.filter((row) => row.section === "inFlight"),
    ended: rows.filter((row) => row.section === "ended"),
    total: rows.length,
  };
}
