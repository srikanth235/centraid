import { Store } from '../store.js';
import { type JSX } from 'react';
import type { AppearancePrefs, TemplateEntry } from '../../../app-shell-context.js';
import type { DiscoverTemplate } from '../../screen-contracts.js';
import DiscoverScreen from '../../screens/DiscoverScreen.js';
import { useShellActions } from '../actions.js';
import { openAutomationTemplatePreview } from '../automationTemplatePreview.js';
import { openMenu } from '../contextMenu.js';
import PageScroll from '../PageScroll.js';
import { PageEmpty, PageLoading } from '../status.js';
import { openTemplatePreview } from '../templatePreview.js';
import { useAsyncData } from '../useAsyncData.js';
import { openWebhookReveal } from '../webhookReveal.js';
import {
  cloneAutomationTemplate,
  installAppTemplate,
  loadAppTemplates,
  loadAutomationTemplates,
  surfaceMintedWebhook,
} from './templatesData.js';

export interface DiscoverRouteProps {
  userApps: readonly UserAppMeta[];
  setUserApps: (next: UserAppMeta[]) => void;
  refreshApps: () => Promise<void>;
}

// React-owned Discover — the unified template gallery. Replaces the vanilla
// renderDiscover (app-discover.ts). Loads both template slices, then wires the
// preview modals + context menu + clone actions through the ported overlays +
// ShellActions. tileVariant reads the Store appearance cache (kept current by
// setPrefs), so the route needn't thread prefs.
export default function DiscoverRoute({
  userApps,
  setUserApps,
  refreshApps,
}: DiscoverRouteProps): JSX.Element {
  const { navigate, showToast } = useShellActions();
  const state = useAsyncData(async () => {
    const [appTemplates, automationTemplates] = await Promise.all([
      loadAppTemplates(),
      loadAutomationTemplates(),
    ]);
    return { appTemplates, automationTemplates };
  });
  const tileVariant =
    Store.get<Partial<AppearancePrefs>>('appearance', {}).tileVariant ?? 'gradient';

  // Clone an app template → install it directly as a published app (owner
  // decision: no draft stage, no builder detour) → pin it to Home so the
  // user lands where they can see it, then reconcile the shelf against the
  // gateway's listing (the freshly published clone) the same way other
  // mutating flows do (see HomeRoute's renameAppFlow/deleteAppFlow).
  const applyAppTemplate = (t: TemplateEntry): void => {
    void installAppTemplate(t)
      .then((pin) => {
        setUserApps([pin, ...userApps]);
        void refreshApps();
        showToast(`Installed "${pin.name}"`);
        navigate({ kind: 'home' });
      })
      .catch((err: unknown) =>
        showToast(`Clone failed: ${err instanceof Error ? err.message : String(err)}`),
      );
  };
  // Clone an automation template → surface once-only webhook secrets → open
  // the automation's thread (adopt lands on the conversation, same as the
  // Templates gallery — receipts/issue-387-automations-ui-revamp.md).
  const applyAutoTemplate = (t: TemplateEntry): void => {
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

  const asEntry = (t: DiscoverTemplate): TemplateEntry => t as unknown as TemplateEntry;

  return (
    <PageScroll flush>
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
          onOpenAutomationTemplate={(t) =>
            openAutomationTemplatePreview(asEntry(t), applyAutoTemplate)
          }
          onTemplateContext={(t, anchor) => {
            const auto = t.kind === 'automation';
            openMenu(
              [
                { id: 'use', label: 'Use this template', icon: 'Sparkle' },
                { id: 'preview', label: 'Preview', icon: 'Eye' },
              ],
              anchor,
              (id) => {
                if (auto) {
                  if (id === 'use') {
                    applyAutoTemplate(asEntry(t));
                  } else {
                    openAutomationTemplatePreview(asEntry(t), applyAutoTemplate);
                  }
                } else {
                  if (id === 'use') {
                    applyAppTemplate(asEntry(t));
                  } else {
                    openTemplatePreview(asEntry(t), applyAppTemplate);
                  }
                }
              },
            );
          }}
        />
      )}
    </PageScroll>
  );
}
