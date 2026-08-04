import { isAutomationTemplate } from "../../../app-format.js";
import type { TemplateEntry } from "../../../app-shell-context.js";
import {
  cloneTemplate as gwCloneTemplate,
  listAutomations,
  listTemplates,
} from "../../../gateway-client.js";

// Template catalog data layer — ports the vanilla loadAvailableTemplates
// (app-cards.ts) + loadAutomationTemplates (app-automations-templates.ts) +
// cloneTemplate (app-cards.ts). The one gateway catalog splits on kind: the app
// slice is now read-only (it says which ids are BUNDLED, which is how an app
// route tells a first-party fixture from a code-store app), while the automation
// gallery keeps its own richer slice and its clone verb.

/** App templates only (the automation slice has its own surface). */
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
  "screenshot-extractor",
  "photo-captioner",
] as const;

const V0_AUTOMATION_TEMPLATE_ID_SET = new Set<string>(
  V0_AUTOMATION_TEMPLATE_IDS
);

/** Automation templates intentionally listed in the v0 gallery. */
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

/** Preferred empty-state starters on the Automations overview (curated for
 *  signal, not catalog order). Missing ids are skipped; if none match, the
 *  first `cap` catalog rows fill the strip. */
const OVERVIEW_SUGGESTION_IDS = [
  "obligation-extractor",
  "google-gmail-pull",
  "renewal-reminders",
  "screenshot-extractor",
] as const;

/** Curated 3–4 automation templates for the fleet empty state. */
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

/** Clone an automation template on the gateway, returning the new automation id
 *  + any once-only webhook secrets for the caller to surface (vanilla
 *  adoptTemplate, minus the navigation). Throws on clone failure. */
export async function cloneAutomationTemplate(tmpl: TemplateEntry): Promise<{
  automationId: string;
  /** The `<ownerApp>/<id>` handle the automation-view (thread) and editor
   *  routes key on — resolved by re-listing after the clone publishes, since
   *  `_clone` only returns the raw app id. `null` when the freshly-cloned
   *  row can't be found (callers fall back to the overview). */
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

/** Log a freshly-minted webhook credential to the console — a dev-only
 *  fallback kept alongside the in-app one-time reveal modal
 *  (`openWebhookReveal`, driven by the call site, which owns ShellActions).
 *  Only the SHA-256 hash is persisted server-side, so between the two this
 *  is the one and only chance anyone has to read the plaintext secret. */
export function surfaceMintedWebhook(w: { url: string; secret: string }): void {
  // The reveal UI is the one-time delivery surface. Desktop forwards console
  // output to persistent stdout logs, so neither capability belongs here.
  void w;
}

/* `installAppTemplate` left with Discover (issue #708). Installing a first-party
   app one at a time was the catalogue's whole verb, and there is no catalogue:
   every bundled app is installed at vault mount by the gateway, so the client
   has nothing left to ask for. The wire call it wrapped (`installTemplate`)
   stays — it is still the gateway's own install seam, used when an app follows
   a member into an audience vault they were added to. */
