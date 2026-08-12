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
import type {
  InlineAppModule,
  InlineFrame,
} from "@centraid/blueprints/apps/inline-types";
import { toBlueprintCss } from "@centraid/design";

import type { AppearancePrefs } from "../../../app-shell-context.js";
import { acquireReplicaShellSession } from "../../../replica/shell-session.js";
import type { ReplicaScopeLease } from "../../../replica/shell-session.js";
import {
  addInlineScope,
  installInlineCentraid,
} from "../../blueprints/centraid-inline.js";
import { installInlineBlobImages } from "../../blueprints/inline-blob-images.js";
import { installInlineAsk } from "../../blueprints/kit-ask-inline.js";
import { seat } from "../../host-platform.js";
import { useShellActions } from "../actions.js";
import ErrorBoundary from "../ErrorBoundary.js";
import { iconSvg } from "../iconSvg.js";
import type { ShellNav } from "../ShellApp.js";
import ShellFrame from "../ShellFrame.js";
import { useAsyncData } from "../useAsyncData.js";
import { useGatewayStatus } from "../useGatewayRuntime.js";
import AppSettingsController from "./AppSettingsController.js";
import { fetchAppKnobValues, pushKnobToInlineRoot } from "./appSettingsData.js";
import { deleteInlineApp, renameInlineApp } from "./inlineAppFlows.js";
import { useInlineAppFrame } from "./inlineAppFrame.js";
import { isDisabledOnSeat } from "./inlineAppSeats.js";
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
  renderStem: (nav: ShellNav) => ReactNode;
  /** The frame's one status line — full-bleed hosts mount their own frame,
   *  so they are handed the same node rather than inheriting it. */
  statusLine?: ReactNode;
  prefs: AppearancePrefs;
  /** The compact form factor — the stem is the bottom band, and a first-party
   *  route may claim it (Photos v4, CHANGELOG F). Layout only. */
  compact?: boolean;
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
  /** The frame's contribution channel — app bar, status line, compact band. */
  frame: InlineFrame;
  onRootReady: (el: HTMLElement | null, descriptor: InlineAppModule) => void;
  onOpenApprovals: () => void;
}

function InlineAppMount({
  appId,
  cacheKey: _cacheKey,
  descriptorPromise,
  scopes,
  frame,
  onRootReady,
  onOpenApprovals,
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
      pendingProjection: descriptor.pendingProjection,
      scopes: [{ scope: primary.scope, session: lease.session }],
      onOpenApprovals,
      onInstalled: (published) => {
        client = published;
      },
    });
    return { client, teardown };
  });
  void setInstallation;
  const installed = installation.client;

  useEffect(() => {
    return () => {
      installation.teardown();
      lease.release();
    };
  }, [installation, lease]);

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
  // The ref MUST be stable. An inline arrow here is a new function every render,
  // and React answers an identity change by detaching (`ref(null)`) and
  // reattaching the SAME element — which ran the mount callback's teardown, and
  // with it revoked every live blob: object URL, on every re-render of the app.
  // Photos re-renders on each slot paint, so its grid went blank mid-load.
  const rootRef = useCallback(
    (el: HTMLElement | null) => onRootReady(el, descriptor),
    [descriptor, onRootReady]
  );
  return <Root rootRef={rootRef} frame={frame} />;
}

export default function InlineAppRoute({
  app,
  appId,
  loader,
  nav,
  renderStem,
  statusLine,
  prefs,
  compact,
}: InlineAppRouteProps): JSX.Element {
  const { confirm, enterBuilder, openNewAppSheet, showToast, builderEnabled } =
    useShellActions();
  // The seat wall (docs/blueprint-seats.md S5): a manifest-declared refusal,
  // not a hard-coded app id, so the next app that needs one (the doc's
  // open follow-up list already has candidates) gets it free. Locker is the
  // only app that trips this today (`INLINE_APP_DISABLED_SEATS`, mirrored
  // from `app.json#seats.disabledOn` and cross-checked by
  // inlineAppSeats.test.ts). `seat()` is presentation-only per
  // host-platform.ts's own caveat — this is a UI decision (what to render),
  // never a security boundary; nothing sensitive is denied twice here.
  const refused = isDisabledOnSeat(appId, seat());
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

  // The shell's gateway verdict, stamped onto the inline root as a dataset
  // knob — the same channel the knob values ride. Blueprints may not import
  // the client package, so this attribute IS the reachability contract: the
  // Photos offline banner (§14) reads `data-gateway-status` and only trusts
  // "up"/"down". A ref mirror covers the root that mounts AFTER the status
  // arrived, since `onRootReady` fires outside this effect's dependency world.
  const gatewayStatus = useGatewayStatus();
  const gatewayStatusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    gatewayStatusRef.current = gatewayStatus;
    const el = appRootRef.current;
    if (el && gatewayStatus) el.dataset.gatewayStatus = gatewayStatus;
  }, [gatewayStatus]);

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
      // The install is keyed to the ELEMENT, not to this callback. React hands
      // `null` on every detach, and most detaches are NOT an unmount: a ref
      // whose identity changed, or a Suspense boundary hiding and then
      // re-revealing the very same subtree. Reading those as teardown revoked
      // every live blob: object URL out from under still-mounted <img>s, which
      // is what rendered the photo grid blank (ERR_FILE_NOT_FOUND on a revoked
      // blob: URL). So a detach is ignored and only a DIFFERENT element
      // replaces the install; the route's unmount effect below is what
      // guarantees the URLs are still revoked exactly once.
      if (el === null || el === appRootRef.current) return;
      if (askTeardown.current) {
        askTeardown.current();
        askTeardown.current = null;
      }
      if (blobTeardown.current) {
        blobTeardown.current();
        blobTeardown.current = null;
      }
      appRootRef.current = el;
      el.classList.add(INLINE_SCOPE_CLASS);
      if (gatewayStatusRef.current)
        el.dataset.gatewayStatus = gatewayStatusRef.current;
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

  // The FRAME's affordances. They survive whatever the app contributes: they
  // stand ahead of the app's own actions, so the app's one filled ink control
  // is still the last thing in the bar.
  const frameActions = (
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
  // first paint pays max(chunk, scopes) instead of their sum. A refused seat
  // (S5 above) never calls `loader()` at all — the app's lazy chunk is not
  // even fetched, since the wall means "does not mount", not "mounts and
  // then hides".
  const descriptorPromise = useMemo(
    () => (refused ? undefined : loadDescriptor(cacheKey, loader)),
    [cacheKey, loader, refused]
  );
  // The mount key gains a SCOPE-SET axis (issue #599, docs/client-keying.md):
  // the same app over a different set of scopes is a different mount, because
  // `window.centraid` and every replica lease it holds are per scope set.
  const scopesState = useAppScopes(appId);
  const mounted = scopesState.status === "ready" ? scopesState.data : null;
  const scopes = mounted?.scopes ?? null;
  const scopeKey = scopes ? scopeSetKey(scopes) : "";
  const mountKey = `${appId}\0${cacheKey}\0${scopeKey}`;

  // What the app contributes to the frame (Photos v4, §3): the bar's lockup and
  // actions, the compact band, and the channel the app writes them through.
  // Only a BUNDLED app may claim the band — first-party until submission can
  // enforce the capsule.
  const contributed = useInlineAppFrame({
    app,
    compact: Boolean(compact),
    firstParty: bundled,
    mountKey,
    onHome: () => nav.navigate({ kind: "home" }),
  });

  return (
    <ShellFrame
      stem={renderStem(nav)}
      compact={compact}
      {...(contributed.band === undefined ? {} : { band: contributed.band })}
      statusLine={statusLine}
      canGoBack={nav.canGoBack}
      canGoForward={nav.canGoForward}
      onBack={() => nav.back()}
      onForward={() => nav.forward()}
      showNewChat={builderEnabled}
      onNewChat={openNewAppSheet}
      appMark={contributed.mark}
      appTitle={contributed.title}
      {...(contributed.count === undefined
        ? {}
        : { appCount: contributed.count })}
      titlebarRight={
        <>
          {frameActions}
          {contributed.actions}
        </>
      }
    >
      <div className={styles.view} data-testid="inline-app-view">
        <div className={styles.body}>
          {refused ? (
            // The seat wall (docs/blueprint-seats.md S5). Stated plainly,
            // per the repo's refusal grammar (docs/decisions.md S5, §14's
            // offline banner is the sibling case): a title and one sentence
            // of reason, no icon, no alarm colour, and no control — there is
            // nothing to retry, because the seat itself is what refuses.
            <output
              className={styles.refusal}
              data-testid="inline-app-seat-refusal"
            >
              <p className={styles.refusalTitle}>
                {app.name} isn’t available here
              </p>
              <p className={styles.refusalBody}>
                {app.name} opens on a paired device, not in a browser — for now.
              </p>
            </output>
          ) : (
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
                {scopes && descriptorPromise ? (
                  <InlineAppMount
                    key={mountKey}
                    appId={appId}
                    cacheKey={cacheKey}
                    descriptorPromise={descriptorPromise}
                    scopes={scopes}
                    frame={contributed.frame}
                    onRootReady={onRootReady}
                    onOpenApprovals={() => nav.navigate({ kind: "approvals" })}
                  />
                ) : (
                  <div className={styles.fallback}>Loading {app.name}…</div>
                )}
              </Suspense>
            </ErrorBoundary>
          )}
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
              void renameInlineApp({ app, say: showToast });
            }}
            onShare={() => showToast("Sharing isn’t available yet.")}
            onReveal={() =>
              void window.CentraidApi.openAppFolder({ id: app.id })
            }
            onDelete={() => {
              setSettings(null);
              void deleteInlineApp({
                app,
                confirm,
                say: showToast,
                onDeleted: () => nav.navigate({ kind: "home" }),
              });
            }}
            showToast={showToast}
          />
        )}
      </div>
    </ShellFrame>
  );
}
