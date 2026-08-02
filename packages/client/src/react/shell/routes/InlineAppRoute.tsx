import {
  Suspense,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { JSX, ReactNode } from "react";

// The kit's :global(.kit-*) vocabulary (buttons, segmented chips, search,
// banners, ask panel) that blueprint component modules reference. Loaded once,
// globally, by the route host — same as the served path's <link rel=kit.css>.
import "@centraid/design/kit/kit.css";
import type { InlineAppModule } from "@centraid/blueprints/apps/inline-types";
import { toBlueprintCss } from "@centraid/design";

import type { AppearancePrefs } from "../../../app-shell-context.js";
import { deleteApp, updateAppMeta } from "../../../gateway-client.js";
import { acquireReplicaShellSession } from "../../../replica/shell-session.js";
import type { ReplicaScopeLease } from "../../../replica/shell-session.js";
import {
  addInlineScope,
  installInlineCentraid,
} from "../../blueprints/centraid-inline.js";
import { installInlineBlobImages } from "../../blueprints/inline-blob-images.js";
import { installInlineAsk } from "../../blueprints/kit-ask-inline.js";
import { useShellActions } from "../actions.js";
import ErrorBoundary from "../ErrorBoundary.js";
import { iconSvg } from "../iconSvg.js";
import { openPrompt } from "../prompt.js";
import type { ShellNav } from "../ShellApp.js";
import ShellFrame from "../ShellFrame.js";
import { useAsyncData } from "../useAsyncData.js";
import AppSettingsController from "./AppSettingsController.js";
import { fetchAppKnobValues, pushKnobToInlineRoot } from "./appSettingsData.js";
import { loadAppTemplates } from "./templatesData.js";
import { scopeSetKey, useAppScopes } from "./useAppScopes.js";
import type { ResolvedAppScope } from "./useAppScopes.js";

import chrome from "../chrome.module.css";
import styles from "./InlineAppRoute.module.css";

export interface InlineAppRouteProps {
  app: AppMetaResolvedType;
  appId: string;
  loader: () => Promise<{ default: InlineAppModule }>;
  nav: ShellNav;
  renderSidebar: (nav: ShellNav) => ReactNode;
  prefs: AppearancePrefs;
  onToggleSidebar: () => void;
}

const INLINE_SCOPE_CLASS = "centraid-inline-scope";
const PRODUCT_ACCENT_ROLES = [
  "--accent",
  "--accent-deep",
  "--accent-fill",
  "--accent-deep-hover",
  "--accent-light",
  "--accent-soft",
  "--accent-text",
  "--bg-sel",
  "--line-sel",
  "--focus-ring-color",
] as const;

function syncInlineProductAccent(root: HTMLElement): void {
  const source = getComputedStyle(document.documentElement);
  for (const role of PRODUCT_ACCENT_ROLES) {
    const value = source.getPropertyValue(role).trim();
    if (value) root.style.setProperty(role, value);
  }
}

// The blueprint token layer (--font-mono/--bg-elev/--accent/--ease/type scale …),
// rescoped from `:root` to the inline app subtree so it never restyles the
// shell chrome. Injected once; the shell's own `data-theme` on <html> still
// drives the dark block. Kept synchronous so inline theming needs no paint gap.
let inlineTokensInjected = false;
function ensureInlineScopeTokens(): void {
  if (inlineTokensInjected || typeof document === "undefined") return;
  inlineTokensInjected = true;
  const scoped = toBlueprintCss()
    .replace(
      /:root\[data-theme='dark'\]/gu,
      `:root[data-theme='dark'] .${INLINE_SCOPE_CLASS}`
    )
    .replace(
      /:root:not\(\[data-theme\]\)/gu,
      `:root:not([data-theme]) .${INLINE_SCOPE_CLASS}`
    )
    .replace(
      /(?<lineStart>^|\n):root\s*\{/gu,
      `$<lineStart>.${INLINE_SCOPE_CLASS} {`
    );
  const style = document.createElement("style");
  style.dataset.centraidInlineTokens = "true";
  style.textContent = scoped;
  document.head.appendChild(style);
}

// One cached descriptor promise per (appId, attempt) so React `use()` reads a
// stable promise across renders. A rejection is cached too — otherwise the
// Suspense remount would re-run the loader forever on a persistent chunk
// failure instead of surfacing the error boundary. Retry bumps `attempt` to a
// fresh key (and drops the old one) to re-import.
const descriptorCache = new Map<
  string,
  Promise<{ default: InlineAppModule }>
>();
function loadDescriptor(
  key: string,
  loader: () => Promise<{ default: InlineAppModule }>
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
  descriptorPromise: Promise<{ default: InlineAppModule }>;
  /** Mounted scopes, primary first (issue #599). */
  scopes: readonly ResolvedAppScope[];
  onDescriptor: (descriptor: InlineAppModule) => void;
  onRootReady: (el: HTMLElement | null, descriptor: InlineAppModule) => void;
}

function InlineAppMount({
  appId,
  cacheKey: _cacheKey,
  descriptorPromise,
  scopes,
  onDescriptor,
  onRootReady,
}: InlineAppMountProps): JSX.Element {
  // ONLY the primary scope blocks first paint (issue #599). Every audience is
  // hydrated after the app is on screen, so a household with several shared
  // scopes still paints as fast as a single-scope one.
  const primary = scopes[0]!;
  const primaryIdentity = primary.identity;
  const primaryLease = useMemo(
    () => acquireReplicaShellSession(primaryIdentity),
    [primaryIdentity]
  );
  const descriptor = use(descriptorPromise).default;
  const lease = use(primaryLease);

  // The bridge must exist before the Root mounts: its first effect reads it.
  // This initializer runs once for the parent's keyed resource mount.
  const [installation, setInstallation] = useState(() => {
    // Capture what actually got published so secondary hydration extends THAT
    // client, not whatever a later mount replaced it with.
    let client: unknown;
    const teardown = installInlineCentraid({
      appId,
      queries: descriptor.queries,
      scopes: [{ scope: primary.scope, session: lease.session }],
      onInstalled: (published) => {
        client = published;
      },
    });
    return { client, teardown };
  });
  void setInstallation;
  const installed = installation.client;

  useEffect(() => {
    onDescriptor(descriptor);
    return () => {
      installation.teardown();
      lease.release();
    };
  }, [descriptor, installation, lease, onDescriptor]);

  // Secondary scopes stream in. Each is an independent replica session, so one
  // slow or failing audience never holds up the others — or the app.
  useEffect(() => {
    if (!descriptor.multiScope) return undefined;
    let alive = true;
    const leases: ReplicaScopeLease[] = [];
    for (const entry of scopes.slice(1)) {
      void acquireReplicaShellSession(entry.identity)
        .then((secondary) => {
          if (!alive) {
            secondary.release();
            return;
          }
          leases.push(secondary);
          addInlineScope(installed, {
            scope: entry.scope,
            session: secondary.session,
          });
        })
        .catch(() => {
          // An audience that cannot be opened is simply not offered. The app
          // keeps every scope that did mount.
        });
    }
    return () => {
      alive = false;
      for (const held of leases) held.release();
    };
  }, [descriptor.multiScope, installed, scopes]);
  const Root = descriptor.Root;
  return (
    <Root rootRef={(el: HTMLElement | null) => onRootReady(el, descriptor)} />
  );
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
  const { confirm, enterBuilder, openNewAppSheet, showToast, builderEnabled } =
    useShellActions();
  // Opening the settings panel snapshots the mounted inline root at click
  // time — an event handler may read the ref, render may not.
  const [settings, setSettings] = useState<{
    inlineRoot: HTMLElement | null;
  } | null>(null);
  const settingsOpen = settings !== null;
  const [attempt, setAttempt] = useState(0);
  const appRootRef = useRef<HTMLElement | null>(null);
  const askTeardown = useRef<(() => void) | null>(null);
  const blobTeardown = useRef<(() => void) | null>(null);
  const knobValues = useRef<Record<string, string>>({});

  ensureInlineScopeTokens();

  const bundledState = useAsyncData(() => loadAppTemplates(), []);
  const bundled =
    bundledState.status === "ready" &&
    bundledState.data.some((t) => t.id === app.id);

  // Best-effort, non-blocking knob fetch — never gates first paint.
  useEffect(() => {
    let alive = true;
    void fetchAppKnobValues(appId).then((values) => {
      if (!alive) return;
      knobValues.current = values;
      const el = appRootRef.current;
      if (el)
        for (const [k, v] of Object.entries(values))
          pushKnobToInlineRoot(el, k, v);
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
      syncInlineProductAccent(el);
      for (const [k, v] of Object.entries(knobValues.current))
        pushKnobToInlineRoot(el, k, v);
      // Authorize blob-backed <img>/background-image refs (grids, lightbox,
      // covers) through the gateway — every inline app, not just photos (#505).
      blobTeardown.current = installInlineBlobImages(el);
      // Lazy, best-effort, no network on this path (kit-ask-inline mounts DOM
      // only; gateway calls happen on user interaction).
      if (descriptor.kitAsk) {
        try {
          askTeardown.current = installInlineAsk({
            appRoot: el,
            appId,
            config: descriptor.kitAsk,
          });
        } catch {
          /* ask is non-essential — never block the app on it */
        }
      }
    },
    [appId]
  );

  useEffect(() => {
    const root = appRootRef.current;
    if (root) syncInlineProductAccent(root);
  }, [prefs]);

  useEffect(
    () => () => {
      askTeardown.current?.();
      askTeardown.current = null;
      blobTeardown.current?.();
      blobTeardown.current = null;
    },
    []
  );

  const renameFlow = async (): Promise<void> => {
    const next = await openPrompt({
      title: "Rename app",
      initial: app.name,
      placeholder: "App name",
      confirmLabel: "Rename",
    });
    if (!next) return;
    try {
      await updateAppMeta({ id: app.id, name: next });
      showToast(`Renamed to "${next}"`);
    } catch (error) {
      showToast(
        `Could not rename: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const deleteFlow = async (): Promise<void> => {
    const ok = bundled
      ? await confirm({
          confirmLabel: "Uninstall",
          danger: true,
          title: `Uninstall ${app.name}?`,
          message: `Removes "${app.name}" and revokes its access. Your data stays in your vault.`,
        })
      : await confirm({
          confirmLabel: "Delete",
          danger: true,
          title: "Delete app?",
          message: `Delete "${app.name}"? This removes it from the gateway and wipes its local app files.`,
        });
    if (!ok) return;
    try {
      await deleteApp({ id: app.id });
      showToast(`${bundled ? "Uninstalled" : "Deleted"} "${app.name}"`);
      nav.navigate({ kind: "home" });
    } catch (error) {
      const verb = bundled ? "uninstall" : "delete";
      showToast(
        `Could not ${verb}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const finish = window.CentraidTokens.tileFinish(app.color, "gradient");
  const brandChip = (
    <span>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          font: "var(--t-body-strong, 600 0.85rem/1.4 system-ui)",
        }}
      >
        <span
          style={{
            width: 20,
            height: 20,
            borderRadius: 6,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            background: finish.background,
            color: finish.glyphColor,
            boxShadow: finish.boxShadow || undefined,
          }}
          // oxlint-disable-next-line react/no-danger -- #639 the complete HTML source is a reviewed local SVG/icon catalog value.
          dangerouslySetInnerHTML={{ __html: iconSvg(app.iconKey, 11, 1.9) }}
        />
        {app.name}
      </span>
    </span>
  );

  const titlebarRight = (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
      {builderEnabled ? (
        <button
          className={chrome.tbBtn}
          type="button"
          aria-label="Build"
          title="Build"
          onClick={() => enterBuilder({ appContext: app })}
          // oxlint-disable-next-line react/no-danger -- #639 the complete HTML source is a reviewed local SVG/icon catalog value.
          dangerouslySetInnerHTML={{ __html: iconSvg("Sparkle", 14) }}
        />
      ) : null}
      <span className={chrome.tbBtnWrap}>
        <button
          className={chrome.tbBtn}
          type="button"
          aria-label="App settings"
          aria-haspopup="dialog"
          data-open={settingsOpen ? "true" : undefined}
          onClick={() =>
            setSettings(
              settingsOpen ? null : { inlineRoot: appRootRef.current }
            )
          }
          // oxlint-disable-next-line react/no-danger -- #639 the complete HTML source is a reviewed local SVG/icon catalog value.
          dangerouslySetInnerHTML={{ __html: iconSvg("Settings", 15) }}
        />
        <span className={chrome.tooltip}>App settings</span>
      </span>
    </span>
  );

  const cacheKey = `${appId}:${attempt}`;
  // Kick the descriptor chunk import off NOW, so it downloads in parallel with
  // the scopes fetch below — InlineAppMount receives this same promise, and
  // first paint pays max(chunk, scopes) instead of their sum.
  const descriptorPromise = useMemo(
    () => loadDescriptor(cacheKey, loader),
    [cacheKey, loader]
  );
  // The mount key gains a SCOPE-SET axis (issue #599, docs/client-keying.md):
  // the same app over a different set of scopes is a different mount, because
  // `window.centraid` and every replica lease it holds are per scope set.
  const scopesState = useAppScopes(appId);
  const scopes = scopesState.status === "ready" ? scopesState.data : null;
  const scopeKey = scopes ? scopeSetKey(scopes) : "";

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
            <Suspense
              fallback={
                <div className={styles.fallback}>Loading {app.name}…</div>
              }
            >
              {scopes ? (
                <InlineAppMount
                  key={`${appId}\0${cacheKey}\0${scopeKey}`}
                  appId={appId}
                  cacheKey={cacheKey}
                  descriptorPromise={descriptorPromise}
                  scopes={scopes}
                  onDescriptor={() => {}}
                  onRootReady={onRootReady}
                />
              ) : (
                <div className={styles.fallback}>Loading {app.name}…</div>
              )}
            </Suspense>
          </ErrorBoundary>
        </div>
        {settings === null ? null : (
          <AppSettingsController
            app={app}
            appId={appId}
            inlineRoot={settings.inlineRoot}
            {...(bundled ? { bundled: true } : {})}
            onClose={() => setSettings(null)}
            onOpenAutomations={() => {
              setSettings(null);
              nav.navigate({ kind: "automations" });
            }}
            onOpenOrder={(ref) => {
              setSettings(null);
              nav.navigate({ kind: "automation-view", automationId: ref });
            }}
            onRename={() => {
              setSettings(null);
              void renameFlow();
            }}
            onShare={() => showToast("Sharing isn’t available yet.")}
            onReveal={() =>
              void window.CentraidApi.openAppFolder({ id: app.id })
            }
            onDelete={() => {
              setSettings(null);
              void deleteFlow();
            }}
            showToast={showToast}
          />
        )}
      </div>
    </ShellFrame>
  );
}
