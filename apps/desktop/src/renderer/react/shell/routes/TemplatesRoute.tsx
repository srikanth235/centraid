import { type JSX } from 'react';
import type { TemplateEntry } from '../../../app-shell-context.js';
import type { DiscoverTemplate } from '../../screen-contracts.js';
import AutomationTemplatesScreen from '../../screens/AutomationTemplatesScreen.js';
import { useShellActions } from '../actions.js';
import { openAutomationTemplatePreview } from '../automationTemplatePreview.js';
import PageScroll from '../PageScroll.js';
import { PageEmpty, PageLoading } from '../status.js';
import { useAsyncData } from '../useAsyncData.js';
import { scaffoldAutomationDraft } from './automationsData.js';
import {
  cloneAutomationTemplate,
  loadAutomationTemplates,
  surfaceMintedWebhook,
} from './templatesData.js';

// React-owned automation templates gallery — replaces the vanilla
// renderAutomationTemplates (app-automations-templates.ts). Loads the automation
// template slice, wires the preview drawer + adopt (clone → webhook secrets →
// automation builder), and "Start from scratch" (scaffold a draft → builder).
export default function TemplatesRoute(): JSX.Element {
  const { navigate, showToast } = useShellActions();
  const state = useAsyncData(() => loadAutomationTemplates());

  const useAutoTemplate = (t: TemplateEntry): void => {
    void cloneAutomationTemplate(t)
      .then(({ automationId, webhooks }) => {
        for (const w of webhooks) surfaceMintedWebhook(w, showToast);
        navigate({ kind: 'automation-builder', automationId });
      })
      .catch((err: unknown) =>
        showToast(`Could not adopt template: ${err instanceof Error ? err.message : String(err)}`),
      );
  };

  const onStartFromScratch = (): void => {
    void scaffoldAutomationDraft()
      .then((id) => navigate({ kind: 'automation-builder', automationId: id }))
      .catch((err: unknown) =>
        showToast(`Could not start: ${err instanceof Error ? err.message : String(err)}`),
      );
  };

  return (
    <PageScroll
      title="Templates"
      subtitle="Proven automations, pre-wired with triggers and integrations. Adopt one and tune it to your workflow."
    >
      {state.status === 'loading' ? (
        <PageLoading label="Loading templates…" />
      ) : state.status === 'error' ? (
        <PageEmpty message={`Couldn’t load templates: ${state.error}`} />
      ) : (
        <AutomationTemplatesScreen
          templates={state.data as unknown as DiscoverTemplate[]}
          onPreview={(t) => openAutomationTemplatePreview(t as unknown as TemplateEntry, useAutoTemplate)}
          onStartFromScratch={onStartFromScratch}
        />
      )}
    </PageScroll>
  );
}
