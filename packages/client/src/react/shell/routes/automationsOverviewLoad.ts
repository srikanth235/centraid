// Fleet overview load + suggestion adopt — extracted from AutomationsRoute so
// the route's useCallback wrappers stay identity-stable (desktop e2e 8.2) and
// the fetch/derive path is unit-testable for diff-coverage.
import type { TemplateEntry } from '../../../app-shell-context.js';
import {
  getBlocking,
  listAgents,
  listAutomations,
  listOutboxGrants,
  listTemplates,
} from '../../../gateway-client.js';
import type { AuOverviewData } from '../../screen-contracts.js';
import type { ShellActions } from '../actions.js';
import { openWebhookReveal } from '../webhookReveal.js';
import { filterConsentForAutomation } from './automationThreadData.js';
import { buildOverviewData, collectAutomationRuns } from './automationsData.js';
import { cloneAutomationTemplate, surfaceMintedWebhook } from './templatesData.js';

/** Fetch rows, run feed, consent lists → overview DTO with attention badges. */
export async function loadAutomationsOverviewData(): Promise<AuOverviewData> {
  const [rows, entries, blocking, grants, agents] = await Promise.all([
    listAutomations(),
    collectAutomationRuns(),
    getBlocking(),
    listOutboxGrants(),
    listAgents(),
  ]);
  const attentionByRef = new Map<string, number>(
    rows.map((row) => {
      const consent = filterConsentForAutomation(
        agents.find((agent) => agent.hostKey === row.ownerApp)?.agentId,
        blocking,
        grants,
      );
      return [row.ref, consent.parked.length + consent.outbox.length];
    }),
  );
  return buildOverviewData(rows, entries, attentionByRef);
}

/** Adopt an empty-state suggestion template into a new automation. */
export async function adoptOverviewSuggestion(
  templateId: string,
  actions: Pick<ShellActions, 'navigate' | 'showToast'>,
): Promise<void> {
  const { navigate, showToast } = actions;
  try {
    const all = (await listTemplates()) as TemplateEntry[];
    const tmpl = all.find((t) => t.id === templateId);
    if (!tmpl) {
      showToast(`Template “${templateId}” is no longer available.`);
      return;
    }
    const { ref, webhooks } = await cloneAutomationTemplate(tmpl);
    for (const w of webhooks) {
      surfaceMintedWebhook(w);
      await openWebhookReveal(w);
    }
    if (ref) navigate({ kind: 'automation-view', automationId: ref });
    else navigate({ kind: 'automations' });
  } catch (err: unknown) {
    showToast(`Could not adopt template: ${err instanceof Error ? err.message : String(err)}`);
  }
}
