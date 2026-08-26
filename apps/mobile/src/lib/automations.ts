// Mobile automations client (#263). Wire shapes are mirrored locally — mobile
// does not depend on `@centraid/server/automation`.
//
// Every call goes out with `apiHeaders()` — auth *and* `x-centraid-vault`
// (#289). Bearer-only let the gateway fall back to its implied default vault,
// so "Run now" fired in the wrong vault.
import { apiHeaders, fetchJson, requireGatewayBase } from "./gateway";

type WireTrigger =
  | { kind: "cron"; expr: string; tz?: string }
  | { kind: "webhook"; id?: string; pending?: true }
  | { kind: "condition"; entity: string }
  | { kind: "data"; entities: readonly string[] }
  | { kind: string };

interface WireRow {
  id: string;
  name: string;
  ref: string;
  enabled: boolean;
  ownerApp: string;
  triggers?: readonly WireTrigger[];
  manifest?: { description?: string };
}

interface ListResult {
  rows: WireRow[];
}

export interface AutomationRow {
  id: string;
  name: string;
  ref: string;
  enabled: boolean;
  scheduleLabel: string;
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
]);

/** Not a full cron humanizer — exotic schedules stay the raw expression. */
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

  const minStep = /^\*\/(?<step>\d+)$/u.exec(min);
  if (minStep && hour === "*" && everyDay)
    return `Every ${minStep.groups?.step} minutes`;
  if (min === "*" && hour === "*" && everyDay) return "Every minute";

  if (min === "0" && hour === "*" && everyDay) return "Hourly";
  const hourStep = /^\*\/(?<step>\d+)$/u.exec(hour);
  if (min === "0" && hourStep && everyDay)
    return `Every ${hourStep.groups?.step} hours`;

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

export async function listAutomations(): Promise<AutomationRow[]> {
  const base = await requireGatewayBase();
  const body = await fetchJson<ListResult>(`${base}/centraid/_automations`, {
    headers: apiHeaders(),
    method: "GET",
  });
  return (body.rows ?? []).map(toRow);
}

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

export async function runAutomation(ref: string): Promise<string> {
  const base = await requireGatewayBase();
  const body = await fetchJson<{ turnId: string }>(
    `${base}/centraid/_automations/turn-now?ref=${encodeURIComponent(ref)}`,
    { headers: apiHeaders(), method: "POST" }
  );
  return body.turnId;
}

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
 * `publish: true` lands on `main` and reconciles the scheduler — without it the
 * toggle only stages in a throwaway session.
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
