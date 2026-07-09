import { type JSX } from 'react';
import type { AppearancePrefs, TemplateEntry } from '../../../app-shell-context.js';
import type { DiscoverTemplate } from '../../bridge.js';
import DiscoverScreen from '../../screens/DiscoverScreen.js';
import { useShellActions } from '../actions.js';
import { openAutomationTemplatePreview } from '../automationTemplatePreview.js';
import { openMenu } from '../contextMenu.js';
import PageScroll from '../PageScroll.js';
import { PageEmpty, PageLoading } from '../status.js';
import { openTemplatePreview } from '../templatePreview.js';
import { useAsyncData } from '../useAsyncData.js';
import {
  cloneAutomationTemplate,
  cloneTemplateToDraft,
  loadAppTemplates,
  loadAutomationTemplates,
} from './templatesData.js';

// React-owned Discover — the unified template gallery. Replaces the vanilla
// renderDiscover (app-discover.ts). Loads both template slices, then wires the
// preview modals + context menu + clone actions through the ported overlays +
// ShellActions. tileVariant reads the Store appearance cache (kept current by
// setPrefs), so the route needn't thread prefs.
export default function DiscoverRoute(): JSX.Element {
  const { navigate, enterBuilder, showToast } = useShellActions();
  const state = useAsyncData(async () => {
    const [appTemplates, automationTemplates] = await Promise.all([
      loadAppTemplates(),
      loadAutomationTemplates(),
    ]);
    return { appTemplates, automationTemplates };
  });
  const tileVariant =
    Store.get<Partial<AppearancePrefs>>('appearance', {}).tileVariant ?? 'gradient';

  // Clone an app template → open the builder on the fresh draft.
  const applyAppTemplate = (t: TemplateEntry): void => {
    void cloneTemplateToDraft(t)
      .then((draft) => enterBuilder({ appContext: draft }))
      .catch((err: unknown) =>
        showToast(`Clone failed: ${err instanceof Error ? err.message : String(err)}`),
      );
  };
  // Clone an automation template → surface once-only webhook secrets → open the
  // automation builder.
  const applyAutoTemplate = (t: TemplateEntry): void => {
    void cloneAutomationTemplate(t)
      .then(({ automationId, webhooks }) => {
        for (const w of webhooks) showToast(`Webhook URL: ${w.url} (secret shown once in console)`);
        navigate({ kind: 'automation-builder', automationId });
      })
      .catch((err: unknown) =>
        showToast(`Could not adopt template: ${err instanceof Error ? err.message : String(err)}`),
      );
  };

  const asEntry = (t: DiscoverTemplate): TemplateEntry => t as unknown as TemplateEntry;

  return (
    <PageScroll>
      {state.status === 'loading' ? (
        <PageLoading label="Loading templates…" />
      ) : state.status === 'error' ? (
        <PageEmpty message={`Couldn’t load templates: ${state.error}`} />
      ) : (
        <DiscoverScreen
          appTemplates={state.data.appTemplates as unknown as DiscoverTemplate[]}
          automationTemplates={state.data.automationTemplates as unknown as DiscoverTemplate[]}
          tileVariant={tileVariant}
          onOpenTemplate={(t) => openTemplatePreview(asEntry(t), applyAppTemplate)}
          onOpenAutomationTemplate={(t) => openAutomationTemplatePreview(asEntry(t), applyAutoTemplate)}
          onTemplateContext={(t, anchor) =>
            openMenu(
              [
                { id: 'use', label: 'Use this template', icon: 'Sparkle' },
                { id: 'preview', label: 'Preview', icon: 'Eye' },
              ],
              anchor,
              (id) =>
                id === 'use'
                  ? applyAppTemplate(asEntry(t))
                  : openTemplatePreview(asEntry(t), applyAppTemplate),
            )
          }
        />
      )}
    </PageScroll>
  );
}
