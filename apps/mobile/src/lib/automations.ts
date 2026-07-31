// Mobile automations client (issue #263 family). The space's automations are
// long-lived agent conversations that fire on a trigger; this module lists
// them, fires one now, and toggles a row's enabled flag — all over the same
// gateway base (paired tunnel or manual dev URL) the rest of the app uses.
//
// Mobile does not depend on `@centraid/automation` (a Node package), so the
// wire shapes are mirrored here as lean local interfaces, exactly as
// `lib/gateway.ts` mirrors the apps listing with its own `AppRegistryRow`.
// The gateway routes are in packages/gateway/src/routes/automations-routes.ts
// (list, turn-now) and lifecycle-automation-routes.ts (set-enabled).

// Every call here goes out with `apiHeaders()` — auth *and* `x-centraid-vault`
// (issue #289 addressing). Sending only the bearer let the gateway fall back to
// its implied default vault, so an Inbox notice raised by an automation in a
// non-active Space opened the wrong vault's thread and "Run now" fired there.
// The Inbox itself is fetched with `apiHeaders()`, so the active Space is the
// only vault whose automations mobile can be looking at; these calls must
// follow the same axis.
import { apiHeaders, fetchJson, requireGatewayBase } from "./gateway";

// One trigger entry from a manifest's `triggers[]`, narrowed to the fields the
// schedule summary reads. Mirrors `@centraid/automation`'s `Trigger` union
// (CronTrigger.expr is the 5-field schedule; webhook/condition/data fire off
// events rather than the clock). Unknown kinds fall through to a generic label.
type WireTrigger =
  | { kind: "cron"; expr: string; tz?: string }
  | { kind: "webhook"; id?: string; pending?: true }
  | { kind: "condition"; entity: string }
  | { kind: "data"; entities: readonly string[] }
  | { kind: string };

/** One row of `GET /centraid/_automations` — `automation.Row` on the wire. */
interface WireRow {
  id: string;
  name: string;
  ref: string;
  enabled: boolean;
  ownerApp: string;
  triggers?: readonly WireTrigger[];
  manifest?: { description?: string };
}

/** The list envelope: `{ rows, errors }` (per-app parse failures land in `errors`). */
interface ListResult {
  rows: WireRow[];
}

/**
 * The lean UI shape one automation card renders from. `ref` (`<ownerApp>/<id>`)
 * is the handle every op (turn-now, set-enabled) addresses the automation by.
 */
export interface AutomationRow {
  id: string;
  name: string;
  ref: string;
  enabled: boolean;
  /** Human-readable trigger summary, e.g. "Daily 9:00" or "On data change". */
  scheduleLabel: string;
  /** Manifest description, or empty when none is set. */
  description: string;
}

export interface AutomationTemplate {
  id: string;
  name: string;
  desc: string;
  triggerLabel?: string;
}

export interface AutomationTurnRow {
  turnId: string;
  triggerKind: string;
  startedAt: number;
  endedAt?: number;
  ok: boolean;
  error?: string;
  summary?: string;
  stepCount?: number;
  toolCount?: number;
}

const V0_TEMPLATE_IDS = new Set([
  "google-gmail-pull",
  "google-calendar-pull",
  "google-contacts-pull",
  "google-drive-pull",
  "obligation-extractor",
  "renewal-reminders",
  "screenshot-extractor",
  "photo-captioner",
]);

/**
 * Friendly text for one cron expression. This is deliberately NOT a full cron
 * humanizer — it names the common shapes the automation templates emit and
 * falls back to the raw expression for anything exotic, so an unusual schedule
 * is shown honestly rather than mislabeled.
 */
function describeCron(expr: string): string {
  const fields = expr.trim().split(/\s+/u);
  if (fields.length !== 5) return `Cron ${expr}`;
  const [min, hour, dom, mon, dow] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const everyDay = dom === "*" && mon === "*" && dow === "*";

  // Every N minutes / every minute.
  const minStep = /^\*\/(?<step>\d+)$/u.exec(min);
  if (minStep && hour === "*" && everyDay)
    return `Every ${minStep.groups?.step} minutes`;
  if (min === "*" && hour === "*" && everyDay) return "Every minute";

  // Top-of-hour cadences.
  if (min === "0" && hour === "*" && everyDay) return "Hourly";
  const hourStep = /^\*\/(?<step>\d+)$/u.exec(hour);
  if (min === "0" && hourStep && everyDay)
    return `Every ${hourStep.groups?.step} hours`;

  // A specific time of day (optionally on a specific weekday).
  const minNum = Number(min);
  const hourNum = Number(hour);
  if (
    Number.isInteger(minNum) &&
    Number.isInteger(hourNum) &&
    dom === "*" &&
    mon === "*"
  ) {
    const at = `${hourNum}:${String(minNum).padStart(2, "0")}`;
    const days = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];
    const dowNum = Number(dow);
    if (dow === "*") return `Daily ${at}`;
    if (Number.isInteger(dowNum) && dowNum >= 0 && dowNum <= 6)
      return `${days[dowNum]} ${at}`;
  }
  return `Cron ${expr}`;
}

/** Summarize one trigger entry for the card's schedule line. */
function describeTrigger(trigger: WireTrigger): string {
  switch (trigger.kind) {
    case "cron":
      return describeCron((trigger as { expr: string }).expr);
    case "webhook":
      return "On webhook";
    case "condition":
      return "On data condition";
    case "data":
      return "On data change";
    default:
      return `On ${trigger.kind}`;
  }
}

/**
 * Derive the card's schedule label from the whole trigger list. An empty list
 * means the automation only ever fires via an explicit "Run now".
 */
function scheduleLabelOf(triggers: readonly WireTrigger[] | undefined): string {
  if (!triggers || triggers.length === 0) return "Manual only";
  return triggers.map(describeTrigger).join(" · ");
}

function toRow(wire: WireRow): AutomationRow {
  return {
    id: wire.id,
    name: wire.name,
    ref: wire.ref,
    enabled: wire.enabled,
    scheduleLabel: scheduleLabelOf(wire.triggers),
    description: wire.manifest?.description ?? "",
  };
}

/** Every automation the space knows, mapped to the lean card shape. */
export async function listAutomations(): Promise<AutomationRow[]> {
  const base = await requireGatewayBase();
  const body = await fetchJson<ListResult>(`${base}/centraid/_automations`, {
    headers: apiHeaders(),
    method: "GET",
  });
  return (body.rows ?? []).map(toRow);
}

/** Curated automation starters from the same gateway catalog as desktop. */
export async function listAutomationTemplates(): Promise<AutomationTemplate[]> {
  const base = await requireGatewayBase();
  const templates = await fetchJson<
    Array<AutomationTemplate & { kind?: "app" | "automation" }>
  >(`${base}/centraid/_templates`, {
    headers: apiHeaders(),
    method: "GET",
  });
  return templates.filter(
    (template) =>
      template.kind === "automation" && V0_TEMPLATE_IDS.has(template.id)
  );
}

/** Publish an automation starter into the current vault. */
export async function cloneAutomationTemplate(
  templateId: string
): Promise<void> {
  const base = await requireGatewayBase();
  await fetchJson<unknown>(`${base}/centraid/_apps/_clone`, {
    body: JSON.stringify({ templateId, publish: true }),
    headers: apiHeaders({ "content-type": "application/json" }),
    method: "POST",
  });
}

/** Fire an automation now (fire-and-forget). Returns the minted native turn id. */
export async function runAutomation(ref: string): Promise<string> {
  const base = await requireGatewayBase();
  const body = await fetchJson<{ turnId: string }>(
    `${base}/centraid/_automations/turn-now?ref=${encodeURIComponent(ref)}`,
    { headers: apiHeaders(), method: "POST" }
  );
  return body.turnId;
}

/** Native automation conversation turns, newest first. */
export async function listAutomationTurns(
  ref: string,
  limit = 50
): Promise<AutomationTurnRow[]> {
  const base = await requireGatewayBase();
  const body = await fetchJson<{ turns?: AutomationTurnRow[] }>(
    `${base}/centraid/_automations/turns?ref=${encodeURIComponent(ref)}&limit=${limit}`,
    { headers: apiHeaders(), method: "GET" }
  );
  return body.turns ?? [];
}

/**
 * Toggle an automation's `enabled` flag. `publish: true` lands the change on
 * `main` and reconciles the scheduler — without it the toggle only stages in a
 * throwaway session and never takes effect, which is not what a phone tap means.
 */
export async function setAutomationEnabled(
  ref: string,
  enabled: boolean
): Promise<void> {
  const base = await requireGatewayBase();
  await fetchJson<{ ok: boolean }>(
    `${base}/centraid/_automations/set-enabled?ref=${encodeURIComponent(ref)}`,
    {
      body: JSON.stringify({ enabled, publish: true }),
      headers: apiHeaders({ "content-type": "application/json" }),
      method: "POST",
    }
  );
}
