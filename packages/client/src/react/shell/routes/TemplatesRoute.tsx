import { type JSX } from 'react';
import type { TemplateEntry } from '../../../app-shell-context.js';
import type { DiscoverTemplate } from '../../screen-contracts.js';
import AutomationTemplatesScreen from '../../screens/AutomationTemplatesScreen.js';
import { useShellActions } from '../actions.js';
import { openAutomationTemplatePreview } from '../automationTemplatePreview.js';
import PageScroll from '../PageScroll.js';
import { PageEmpty, PageLoading } from '../status.js';
import { useAsyncData } from '../useAsyncData.js';
import { openWebhookReveal } from '../webhookReveal.js';
import {
  cloneAutomationTemplate,
  loadAutomationTemplates,
  surfaceMintedWebhook,
} from './templatesData.js';

// React-owned automation templates gallery — replaces the vanilla
// renderAutomationTemplates (app-automations-templates.ts). Loads the automation
// template slice, wires the preview drawer + adopt (clone → webhook secrets →
// the automation's thread), and "Start from scratch" (straight to the
// instructions-first editor — no draft scaffold, no builder detour).
export default function TemplatesRoute(): JSX.Element {
  const { navigate, showToast } = useShellActions();
  const state = useAsyncData(() => loadAutomationTemplates());

  const useAutoTemplate = (t: TemplateEntry): void => {
    void cloneAutomationTemplate(t)
      .then(async ({ ref, webhooks }) => {
        // Show each minted secret once, in-app, before handing off to the
        // thread — the console line stays as a dev-only fallback.
        for (const w of webhooks) {
          surfaceMintedWebhook(w);
          await openWebhookReveal(w);
        }
        // The thread route keys on the row's `ref`; if the fresh clone can't
        // be resolved, land on the fleet instead of a not-found thread.
        if (ref) navigate({ kind: 'automation-view', automationId: ref });
        else navigate({ kind: 'automations' });
      })
      .catch((err: unknown) =>
        showToast(`Could not adopt template: ${err instanceof Error ? err.message : String(err)}`),
      );
  };

  const onStartFromScratch = (): void => {
    navigate({ kind: 'automation-editor' });
  };

  return (
    <PageScroll>
      {state.status === 'loading' ? (
        <PageLoading label="Loading templates…" />
      ) : state.status === 'error' ? (
        <PageEmpty message={`Couldn’t load templates: ${state.error}`} />
      ) : (
        <AutomationTemplatesScreen
          templates={state.data as unknown as DiscoverTemplate[]}
          subtitle="Proven automations, pre-wired with triggers and integrations. Adopt one and tune it to your workflow."
          onPreview={(t) =>
            openAutomationTemplatePreview(t as unknown as TemplateEntry, useAutoTemplate)
          }
          onStartFromScratch={onStartFromScratch}
        />
      )}
    </PageScroll>
  );
}
