// Fleet overview load + suggestion adopt — extracted from AutomationsRoute so
// the route's useCallback wrappers stay identity-stable (desktop e2e 8.2) and
// the fetch/derive path is unit-testable for diff-coverage.
import type { TemplateEntry } from "../../../app-shell-context.js";
import {
  getBlocking,
  listAgents,
  listOutboxGrants,
  listTemplates,
} from "../../../gateway-client.js";
import type { AuOverviewData } from "../../screen-contracts.js";
import type { ShellActions } from "../actions.js";
import { openWebhookReveal } from "../webhookReveal.js";
import { buildOverviewData, collectAutomationRuns } from "./automationsData.js";
import { filterConsentForAutomation } from "./automationThreadData.js";
import {
  cloneAutomationTemplate,
  surfaceMintedWebhook,
} from "./templatesData.js";

/** Fetch rows, run feed, consent lists → overview DTO with attention badges. */
export async function loadAutomationsOverviewData(): Promise<AuOverviewData> {
  // One wave, five requests. `collectAutomationRuns` hands back the automation
  // rows it already had to fetch, so the list is not pulled twice per visit.
  const [{ rows, entries }, blocking, grants, agents] = await Promise.all([
    collectAutomationRuns(),
    getBlocking(),
    listOutboxGrants(),
    listAgents(),
  ]);
  const attentionByRef = new Map<string, number>(
    rows.map((row) => {
      const consent = filterConsentForAutomation(
        agents.find((agent) => agent.enrollmentKey === row.ownerApp)?.agentId,
        blocking,
        grants
      );
      return [row.ref, consent.parked.length + consent.outbox.length];
    })
  );
  return buildOverviewData(rows, entries, attentionByRef);
}

async function revealWebhooksInOrder(
  webhooks: readonly { url: string; secret: string }[],
  index = 0
): Promise<void> {
  const webhook = webhooks[index];
  if (!webhook) return;
  surfaceMintedWebhook(webhook);
  await openWebhookReveal(webhook);
  return revealWebhooksInOrder(webhooks, index + 1);
}

/** Adopt an empty-state suggestion template into a new automation. */
export async function adoptOverviewSuggestion(
  templateId: string,
  actions: Pick<ShellActions, "navigate" | "showToast">
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
    // Reveals are intentionally serialized: each may claim the shared
    // clipboard/toast surface, so concurrent presentation can lose a secret.
    await revealWebhooksInOrder(webhooks);
    if (ref) navigate({ kind: "automation-view", automationId: ref });
    else navigate({ kind: "automations" });
  } catch (error: unknown) {
    showToast(
      `Could not adopt template: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
