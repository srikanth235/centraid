import { palette } from '@centraid/design-tokens';
import { isAutomationTemplate } from '../../../app-format.js';
import { cloneTemplate as gwCloneTemplate, listTemplates } from '../../../gateway-client.js';
import type { TemplateEntry } from '../../../app-shell-context.js';

// Template catalog data layer — ports the vanilla loadAvailableTemplates
// (app-cards.ts) + loadAutomationTemplates (app-automations-templates.ts) +
// cloneTemplate (app-cards.ts). The one gateway catalog splits on kind: Discover
// + the Home templates tab surface app templates; the automation gallery its
// own richer slice.

/** App templates only (the automation slice has its own surface). */
export async function loadAppTemplates(): Promise<TemplateEntry[]> {
  try {
    return ((await listTemplates()) as TemplateEntry[]).filter((t) => !isAutomationTemplate(t));
  } catch {
    return [];
  }
}

/** Automation templates only. */
export async function loadAutomationTemplates(): Promise<TemplateEntry[]> {
  try {
    return ((await listTemplates()) as TemplateEntry[]).filter(isAutomationTemplate);
  } catch {
    return [];
  }
}

/** Clone an automation template on the gateway, returning the new automation id
 *  + any once-only webhook secrets for the caller to surface and to open in the
 *  automation builder (vanilla adoptTemplate, minus the navigation). Throws. */
export async function cloneAutomationTemplate(
  tmpl: TemplateEntry,
): Promise<{ automationId: string; webhooks: ReadonlyArray<{ url: string; secret: string }> }> {
  const result = await gwCloneTemplate({ templateId: tmpl.id });
  return { automationId: result.app.id, webhooks: result.webhooks ?? [] };
}

/** Surface a freshly-minted webhook credential. Only the SHA-256 hash is
 *  persisted, so this is the one and only chance anyone has to read the
 *  plaintext secret — the toast points at the console, so the console line
 *  must actually exist. */
export function surfaceMintedWebhook(
  w: { url: string; secret: string },
  showToast: (msg: string) => void,
): void {
  console.info(
    `[centraid] Webhook minted: ${w.url}\n  Bearer secret (shown once, only its hash is stored): ${w.secret}`,
  );
  showToast(`Webhook URL: ${w.url} (secret shown once in console)`);
}

/** Clone an app template on the gateway and pin it straight to Home as an
 *  installed app — owner decision: "Use template" for an app installs it
 *  directly (the gateway's `_clone` already runs with `publish: true`, so the
 *  clone lands on `main` as a real app); no draft stage, no builder detour.
 *  Ported from the old cloneTemplateToDraft, reshaped from a `DraftAppMeta`
 *  (builder appContext) to a `UserAppMeta` pin — the install path only needs
 *  the fields the Home grid renders. Throws on failure. */
export async function installAppTemplate(tmpl: TemplateEntry): Promise<UserAppMeta> {
  const pal = palette as unknown as Record<string, string>;
  const color = (pal[tmpl.colorKey] ?? '#5847e0') as UserAppMeta['color'];
  const result = await gwCloneTemplate({ templateId: tmpl.id });
  const now = new Date().toISOString();
  const id = result.app.id;
  return {
    centraidAppId: id,
    color,
    colorKey: tmpl.colorKey as UserAppMeta['colorKey'],
    createdAt: now,
    desc: result.app.description || tmpl.desc,
    iconKey: tmpl.iconKey as UserAppMeta['iconKey'],
    id,
    name: result.app.name ?? result.template.name,
    updatedAt: now,
  } as UserAppMeta;
}
