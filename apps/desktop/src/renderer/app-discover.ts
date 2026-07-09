// Discover route — the unified template gallery (app + automation templates,
// filtered by a kind segmented control) and the Starred placeholder. Extracted
// from app.ts. Template previews / context menus live in app-cards.ts and
// app-automations.ts; discover reaches them lazily through `ctx.shell.*`.
import { requireReactBridge } from './react/bridge.js';
import type { ShellContext } from './app-shell-context.js';

export interface DiscoverModule {
  renderDiscover(): void;
  renderStarred(): void;
}

export function createDiscoverModule(ctx: ShellContext): DiscoverModule {
  const {
    el,
    clear,
    teardownCurrent,
    recordRoute,
    registerCleanup,
    mountShellPage,
    pageScroll,
    renderSimpleEmpty,
    getRenderSeq,
    getPrefs,
    loadAvailableTemplates,
    loadAutomationTemplates,
  } = ctx;

  function renderDiscover(): void {
    void renderDiscoverAsync();
  }
  async function renderDiscoverAsync(): Promise<void> {
    recordRoute({ kind: 'discover' });
    // Keep the current view on screen while the templates IPC is in flight;
    // clear() here would blank the window until it resolves (flicker). The
    // built shell is swapped in atomically by mountShellPage below.
    teardownCurrent();
    const seq = getRenderSeq();
    // Discover lists BOTH app and automation templates so the kind segmented
    // filter (All / Apps / Automations) is meaningful. The two loaders split
    // the one catalog on `kind`.
    const [appTemplates, automationTemplates] = await Promise.all([
      loadAvailableTemplates(),
      loadAutomationTemplates(),
    ]);

    // Delegate the screen body to the React DiscoverScreen via the bridge.
    // Routing/teardown stay here (the vanilla shell owns them); the React
    // root's disposer is registered as the page cleanup.
    const host = el('div', { class: 'has-wall' });
    const unmount = requireReactBridge().mountDiscover(host, {
      appTemplates,
      automationTemplates,
      onOpenAutomationTemplate: (t) => ctx.shell.openAutomationTemplatePreview(t),
      onOpenTemplate: (t) => ctx.shell.openTemplatePreview(t),
      onTemplateContext: (t, anchor) => ctx.shell.openTemplateContextMenu(t, anchor),
      tileVariant: getPrefs().tileVariant,
    });
    registerCleanup(unmount);
    mountShellPage('discover', host, seq);
  }

  function renderStarred(): void {
    recordRoute({ kind: 'starred' });
    clear();
    const { main, scroll } = pageScroll('Starred', 'Apps you star show up here for quick access.');
    scroll.append(renderSimpleEmpty('Nothing starred yet. Hover an app tile and tap the star.'));
    mountShellPage('starred', main);
  }

  return { renderDiscover, renderStarred };
}
