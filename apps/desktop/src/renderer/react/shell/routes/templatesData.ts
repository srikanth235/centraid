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

/** Clone a template into a fresh draft app on the gateway, returning the draft
 *  meta for the caller to open in the builder (vanilla cloneTemplate, minus the
 *  enterBuilder side-effect — the route owns navigation). Throws on failure. */
export async function cloneTemplateToDraft(tmpl: TemplateEntry): Promise<DraftAppMeta> {
  const pal = palette as unknown as Record<string, string>;
  const color = (pal[tmpl.colorKey] ?? '#5847e0') as DraftAppMeta['color'];
  const result = await gwCloneTemplate({ templateId: tmpl.id });
  return {
    __draft: true,
    color,
    colorKey: tmpl.colorKey as DraftAppMeta['colorKey'],
    desc: result.app.description || tmpl.desc,
    hasIndex: true,
    iconKey: tmpl.iconKey as DraftAppMeta['iconKey'],
    id: result.app.id,
    name: result.app.name ?? result.template.name,
  } as DraftAppMeta;
}
