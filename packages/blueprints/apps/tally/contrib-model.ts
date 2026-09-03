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

export type ContribVerb =
  | "cancel"
  | "retry"
  | "discard"
  | "approvals"
  | "approve"
  | "decline";

export type ContribSection = "waiting" | "inFlight" | "ended";

export interface ContribRow {
  intentId: string;
  section: ContribSection;
  who: string;
  mine: boolean;
  title: string;
  reason: string;
  status: string;
  tone: "none" | "seam" | "net";
  pending: boolean;
  verbs: ContribVerb[];
}

export function commandLabel(command: string): string {
  if (typeof command !== "string" || command === "") return "A change";
  const tail = command.includes(".")
    ? command.slice(command.lastIndexOf(".") + 1)
    : command;
  const words = tail.replaceAll("_", " ").trim();
  if (words === "") return "A change";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function intentTitle(intent: Intent): string {
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
  if (intent.status === "parked" && !mine && doors.decide)
    out.push("approve", "decline");
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

export interface ContribDoors {
  cancel: boolean;
  retry: boolean;
  discard: boolean;
  approvals: boolean;
  decide: boolean;
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
  total: number;
}

export function contribSections(input: {
  intents: readonly Intent[];
  me: string | null;
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
