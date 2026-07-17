import { palette } from '@centraid/design-tokens';
import { isAutomationTemplate } from '../../../app-format.js';
import {
  cloneTemplate as gwCloneTemplate,
  installTemplate as gwInstallTemplate,
  listAutomations,
  listTemplates,
} from '../../../gateway-client.js';
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
    ref = (await listAutomations()).find((r) => r.id === result.app.id)?.ref ?? null;
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
  console.info(
    `[centraid] Webhook minted: ${w.url}\n  Bearer secret (shown once, only its hash is stored): ${w.secret}`,
  );
}

/** Install a bundled app template in place and pin it straight to Home
 *  (issue #434): install = registration + consent grants, no code copy, no
 *  git. The app keeps the blueprint's own id and serves from the shipped
 *  package, so it upgrades with every release. Install is idempotent — the
 *  pin is built the same whether this was a fresh install or an already-
 *  installed no-op. Unlike automations (which still clone into the code
 *  store), app templates never fork. Throws on failure. */
export async function installAppTemplate(tmpl: TemplateEntry): Promise<UserAppMeta> {
  const pal = palette as unknown as Record<string, string>;
  const result = await gwInstallTemplate({ templateId: tmpl.id });
  const app = result.app;
  const colorKey = (app.colorKey ?? tmpl.colorKey) as UserAppMeta['colorKey'];
  const color = (pal[colorKey] ?? pal[tmpl.colorKey] ?? '#5847e0') as UserAppMeta['color'];
  const now = new Date().toISOString();
  const id = app.id;
  return {
    centraidAppId: id,
    color,
    colorKey,
    createdAt: now,
    desc: app.description || tmpl.desc,
    iconKey: (app.iconKey ?? tmpl.iconKey) as UserAppMeta['iconKey'],
    id,
    name: app.name ?? tmpl.name,
    updatedAt: now,
  } as UserAppMeta;
}
