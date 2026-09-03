import { isAutomationTemplate } from "../../../app-format.js";
import type { TemplateEntry } from "../../../app-shell-context.js";
import {
  cloneTemplate as gwCloneTemplate,
  listAutomations,
  listTemplates,
} from "../../../gateway-client.js";

export async function loadAppTemplates(): Promise<TemplateEntry[]> {
  try {
    return ((await listTemplates()) as TemplateEntry[]).filter(
      (t) => !isAutomationTemplate(t)
    );
  } catch {
    return [];
  }
}

export const V0_AUTOMATION_TEMPLATE_IDS = [
  "google-gmail-pull",
  "google-calendar-pull",
  "google-contacts-pull",
  "google-drive-pull",
  "obligation-extractor",
  "renewal-reminders",
] as const;

const V0_AUTOMATION_TEMPLATE_ID_SET = new Set<string>(
  V0_AUTOMATION_TEMPLATE_IDS
);

export async function loadAutomationTemplates(): Promise<TemplateEntry[]> {
  try {
    return ((await listTemplates()) as TemplateEntry[]).filter(
      (template) =>
        isAutomationTemplate(template) &&
        V0_AUTOMATION_TEMPLATE_ID_SET.has(template.id)
    );
  } catch {
    return [];
  }
}

const OVERVIEW_SUGGESTION_IDS = [
  "obligation-extractor",
  "google-gmail-pull",
  "renewal-reminders",
] as const;

export async function loadOverviewSuggestions(
  cap = 3
): Promise<
  Array<{ id: string; name: string; desc: string; triggerLabel?: string }>
> {
  const all = await loadAutomationTemplates();
  if (all.length === 0) return [];
  const byId = new Map(all.map((t) => [t.id, t]));
  const preferred = OVERVIEW_SUGGESTION_IDS.map((id) => byId.get(id)).filter(
    (t): t is TemplateEntry => t !== undefined
  );
  const picks = preferred.length > 0 ? preferred : all;
  return picks.slice(0, cap).map((t) => ({
    id: t.id,
    name: t.name,
    desc: t.desc,
    ...(t.triggerLabel ? { triggerLabel: t.triggerLabel } : {}),
  }));
}

export async function cloneAutomationTemplate(tmpl: TemplateEntry): Promise<{
  automationId: string;
  ref: string | null;
  webhooks: ReadonlyArray<{ url: string; secret: string }>;
}> {
  const result = await gwCloneTemplate({ templateId: tmpl.id });
  let ref: string | null = null;
  try {
    ref =
      (await listAutomations()).find((r) => r.id === result.app.id)?.ref ??
      null;
  } catch {
    ref = null;
  }
  return { automationId: result.app.id, ref, webhooks: result.webhooks ?? [] };
}

export function surfaceMintedWebhook(w: { url: string; secret: string }): void {
  void w;
}
