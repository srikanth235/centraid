import {
  type JSX,
  type ReactNode,
  Suspense,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { toBlueprintCss } from '@centraid/design-tokens';
// The kit's :global(.kit-*) vocabulary (buttons, segmented chips, search,
// banners, ask panel) that blueprint component modules reference. Loaded once,
// globally, by the route host — same as the served path's <link rel=kit.css>.
import '@centraid/blueprints/kit/kit.css';
import type { AppearancePrefs } from '../../../app-shell-context.js';
import { deleteApp, updateAppMeta } from '../../../gateway-client.js';
import type { InlineAppModule } from '@centraid/blueprints/apps/inline-types';
import {
  getReplicaShellSession,
  type ReplicaShellSession,
} from '../../../replica/shell-session.js';
import { installInlineCentraid } from '../../blueprints/centraid-inline.js';
import { installInlineAsk } from '../../blueprints/kit-ask-inline.js';
import { installInlineBlobImages } from '../../blueprints/inline-blob-images.js';
import { useShellActions } from '../actions.js';
import ErrorBoundary from '../ErrorBoundary.js';
import { iconSvg } from '../iconSvg.js';
import { openPrompt } from '../prompt.js';
import type { ShellNav } from '../ShellApp.js';
import ShellFrame from '../ShellFrame.js';
import { useAsyncData } from '../useAsyncData.js';
import AppSettingsController from './AppSettingsController.js';
import { fetchAppKnobValues, pushKnobToInlineRoot } from './appSettingsData.js';
import { loadAppTemplates } from './templatesData.js';
import styles from './InlineAppRoute.module.css';
import chrome from '../chrome.module.css';

export interface InlineAppRouteProps {
  app: AppMetaResolvedType;
  appId: string;
  loader: () => Promise<{ default: InlineAppModule }>;
  nav: ShellNav;
  renderSidebar: (nav: ShellNav) => ReactNode;
  prefs: AppearancePrefs;
  onToggleSidebar: () => void;
}

const INLINE_SCOPE_CLASS = 'centraid-inline-scope';

// The blueprint token layer (--mono/--surface/--_accent/--ease/type scale …),
// rescoped from `:root` to the inline app subtree so it never restyles the
// shell chrome. Injected once; the shell's own `data-theme` on <html> still
// drives the dark block. Kept synchronous so inline theming needs no paint gap.
let inlineTokensInjected = false;
function ensureInlineScopeTokens(): void {
  if (inlineTokensInjected || typeof document === 'undefined') return;
  inlineTokensInjected = true;
  const scoped = toBlueprintCss()
    .replace(/:root\[data-theme='dark'\]/g, `:root[data-theme='dark'] .${INLINE_SCOPE_CLASS}`)
    .replace(/:root:not\(\[data-theme\]\)/g, `:root:not([data-theme]) .${INLINE_SCOPE_CLASS}`)
    .replace(/(^|\n):root\s*\{/g, `$1.${INLINE_SCOPE_CLASS} {`);
  const style = document.createElement('style');
  style.dataset.centraidInlineTokens = 'true';
  style.textContent = scoped;
  document.head.appendChild(style);
}

// One cached descriptor promise per (appId, attempt) so React `use()` reads a
// stable promise across renders. A rejection is cached too — otherwise the
// Suspense remount would re-run the loader forever on a persistent chunk
// failure instead of surfacing the error boundary. Retry bumps `attempt` to a
// fresh key (and drops the old one) to re-import.
const descriptorCache = new Map<string, Promise<{ default: InlineAppModule }>>();
function loadDescriptor(
  key: string,
  loader: () => Promise<{ default: InlineAppModule }>,
): Promise<{ default: InlineAppModule }> {
  let promise = descriptorCache.get(key);
  if (!promise) {
    promise = loader();
    descriptorCache.set(key, promise);
  }
  return promise;
}

interface InlineAppMountProps {
  appId: string;
  cacheKey: string;
  loader: () => Promise<{ default: InlineAppModule }>;
  onDescriptor: (descriptor: InlineAppModule) => void;
  onRootReady: (el: HTMLElement | null, descriptor: InlineAppModule) => void;
}

function InlineAppMount({
  appId,
  cacheKey,
  loader,
  onDescriptor,
  onRootReady,
}: InlineAppMountProps): JSX.Element {
  const descriptorPromise = useMemo(() => loadDescriptor(cacheKey, loader), [cacheKey, loader]);
  const sessionPromise = useMemo<Promise<ReplicaShellSession>>(
    () => getReplicaShellSession(),
    // A new mount (appId change) re-resolves the live singleton session.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed intentionally on appId (#505)
    [appId],
  );
  const descriptor = use(descriptorPromise).default;
  const session = use(sessionPromise);

  // Install window.centraid BEFORE the app's Root renders/effects run (its first
  // refresh() reads window.centraid). Render-phase install is the createRoot-
  // style resource pattern; guarded so it runs once per (appId, session).
  const install = useRef<{ key?: string; teardown?: () => void }>({});
  const key = `${appId}\0${cacheKey}`;
  if (install.current.key !== key) {
    install.current.teardown?.();
    install.current.teardown = installInlineCentraid({
      appId,
      session,
      queries: descriptor.queries,
    });
    install.current.key = key;
  }
  useEffect(() => {
    onDescriptor(descriptor);
    const inst = install.current; // stable ref object; reads the latest teardown
    return () => {
      inst.teardown?.();
      inst.key = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- teardown-on-unmount only (#505)
  }, []);

  const Root = descriptor.Root;
  return <Root rootRef={(el) => onRootReady(el, descriptor)} />;
}

export default function InlineAppRoute({
  app,
  appId,
  loader,
  nav,
  renderSidebar,
  prefs,
  onToggleSidebar,
}: InlineAppRouteProps): JSX.Element {
  const { confirm, enterBuilder, openNewAppSheet, showToast, builderEnabled } = useShellActions();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const appRootRef = useRef<HTMLElement | null>(null);
  const askTeardown = useRef<(() => void) | null>(null);
  const blobTeardown = useRef<(() => void) | null>(null);
  const knobValues = useRef<Record<string, string>>({});

  ensureInlineScopeTokens();

  const bundledState = useAsyncData(() => loadAppTemplates(), []);
  const bundled = bundledState.status === 'ready' && bundledState.data.some((t) => t.id === app.id);

  // Best-effort, non-blocking knob fetch — never gates first paint.
  useEffect(() => {
    let alive = true;
    void fetchAppKnobValues(appId).then((values) => {
      if (!alive) return;
      knobValues.current = values;
      const el = appRootRef.current;
      if (el) for (const [k, v] of Object.entries(values)) pushKnobToInlineRoot(el, k, v);
    });
    return () => {
      alive = false;
    };
  }, [appId]);

  const onRootReady = useCallback(
    (el: HTMLElement | null, descriptor: InlineAppModule) => {
      if (askTeardown.current) {
        askTeardown.current();
        askTeardown.current = null;
      }
      if (blobTeardown.current) {
        blobTeardown.current();
        blobTeardown.current = null;
      }
      appRootRef.current = el;
      if (!el) return;
      el.classList.add(INLINE_SCOPE_CLASS);
      el.style.setProperty('--accent', 'var(--c-teal)');
      for (const [k, v] of Object.entries(knobValues.current)) pushKnobToInlineRoot(el, k, v);
      // Authorize blob-backed <img>/background-image refs (grids, lightbox,
      // covers) through the gateway — every inline app, not just photos (#505).
      blobTeardown.current = installInlineBlobImages(el);
      // Lazy, best-effort, no network on this path (kit-ask-inline mounts DOM
      // only; gateway calls happen on user interaction).
      if (descriptor.kitAsk) {
        try {
          askTeardown.current = installInlineAsk({ appRoot: el, appId, config: descriptor.kitAsk });
        } catch {
          /* ask is non-essential — never block the app on it */
        }
      }
    },
    [appId],
  );

  useEffect(
    () => () => {
      askTeardown.current?.();
      askTeardown.current = null;
      blobTeardown.current?.();
      blobTeardown.current = null;
    },
    [],
  );

  const renameFlow = async (): Promise<void> => {
    const next = await openPrompt({
      title: 'Rename app',
      initial: app.name,
      placeholder: 'App name',
      confirmLabel: 'Rename',
    });
    if (!next) return;
    try {
      await updateAppMeta({ id: app.id, name: next });
      showToast(`Renamed to "${next}"`);
    } catch (err) {
      showToast(`Could not rename: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const deleteFlow = async (): Promise<void> => {
    const ok = bundled
      ? await confirm({
          confirmLabel: 'Uninstall',
          danger: true,
          title: `Uninstall ${app.name}?`,
          message: `Removes "${app.name}" and revokes its access. Your data stays in your vault.`,
        })
      : await confirm({
          confirmLabel: 'Delete',
          danger: true,
          title: 'Delete app?',
          message: `Delete "${app.name}"? This removes it from the gateway and wipes its local app files.`,
        });
    if (!ok) return;
    try {
      await deleteApp({ id: app.id });
      showToast(`${bundled ? 'Uninstalled' : 'Deleted'} "${app.name}"`);
      nav.navigate({ kind: 'home' });
    } catch (err) {
      const verb = bundled ? 'uninstall' : 'delete';
      showToast(`Could not ${verb}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const finish = window.CentraidTokens.tileFinish(app.color, 'gradient');
  const brandChip = (
    <span>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          font: 'var(--t-body-strong, 600 0.85rem/1.4 system-ui)',
        }}
      >
        <span
          style={{
            width: 20,
            height: 20,
            borderRadius: 6,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: finish.background,
            color: finish.glyphColor,
            boxShadow: finish.boxShadow || undefined,
          }}
          dangerouslySetInnerHTML={{ __html: iconSvg(app.iconKey, 11, 1.9) }}
        />
        {app.name}
      </span>
    </span>
  );

  const titlebarRight = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
      {builderEnabled ? (
        <button
          className={chrome.tbBtn}
          type="button"
          aria-label="Build"
          title="Build"
          onClick={() => enterBuilder({ appContext: app })}
          dangerouslySetInnerHTML={{ __html: iconSvg('Sparkle', 14) }}
        />
      ) : null}
      <span className={chrome.tbBtnWrap}>
        <button
          className={chrome.tbBtn}
          type="button"
          aria-label="App settings"
          aria-haspopup="dialog"
          data-open={settingsOpen ? 'true' : undefined}
          onClick={() => setSettingsOpen((open) => !open)}
          dangerouslySetInnerHTML={{ __html: iconSvg('Settings', 15) }}
        />
        <span className={chrome.tooltip}>App settings</span>
      </span>
    </span>
  );

  const cacheKey = `${appId}:${attempt}`;

  return (
    <ShellFrame
      sidebarOpen={prefs.sidebarOpen}
      onToggleSidebar={onToggleSidebar}
      sidebar={renderSidebar(nav)}
      canGoBack={nav.canGoBack}
      canGoForward={nav.canGoForward}
      onBack={() => nav.back()}
      onForward={() => nav.forward()}
      showNewChat={builderEnabled}
      onNewChat={openNewAppSheet}
      titlebarLead={brandChip}
      titlebarRight={titlebarRight}
    >
      <div className={styles.view} data-testid="inline-app-view">
        <div className={styles.body}>
          <ErrorBoundary
            key={attempt}
            title={`${app.name} hit a problem`}
            onReset={() => {
              descriptorCache.delete(cacheKey);
              setAttempt((a) => a + 1);
            }}
          >
            <Suspense fallback={<div className={styles.fallback}>Loading {app.name}…</div>}>
              <InlineAppMount
                appId={appId}
                cacheKey={cacheKey}
                loader={loader}
                onDescriptor={() => {}}
                onRootReady={onRootReady}
              />
            </Suspense>
          </ErrorBoundary>
        </div>
        {settingsOpen ? (
          <AppSettingsController
            app={app}
            appId={appId}
            inlineRoot={appRootRef.current}
            {...(bundled ? { bundled: true } : {})}
            onClose={() => setSettingsOpen(false)}
            onOpenAutomations={() => {
              setSettingsOpen(false);
              nav.navigate({ kind: 'automations' });
            }}
            onOpenOrder={(ref) => {
              setSettingsOpen(false);
              nav.navigate({ kind: 'automation-view', automationId: ref });
            }}
            onRename={() => {
              setSettingsOpen(false);
              void renameFlow();
            }}
            onShare={() => showToast('Sharing isn’t available yet.')}
            onReveal={() => void window.CentraidApi.openAppFolder({ id: app.id })}
            onDelete={() => {
              setSettingsOpen(false);
              void deleteFlow();
            }}
            showToast={showToast}
          />
        ) : null}
      </div>
    </ShellFrame>
  );
}
