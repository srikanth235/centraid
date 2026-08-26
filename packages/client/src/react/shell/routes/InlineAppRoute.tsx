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

// The :global(.kit-*) classes are global strings, so exactly one loader may
// own them: the route host.
import "@centraid/design/kit.css";
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
import ErrorBoundary from "../ErrorBoundary.js";
import type { ShellNav } from "../ShellApp.js";
import ShellFrame from "../ShellFrame.js";
import { useAsyncData } from "../useAsyncData.js";
import { useGatewayStatus } from "../useGatewayRuntime.js";
import { fetchAppKnobValues, pushKnobToInlineRoot } from "./appSettingsData.js";
import { useInlineAppFrame } from "./inlineAppFrame.js";
import { isDisabledOnSeat } from "./inlineAppSeats.js";
import { loadAppTemplates } from "./templatesData.js";
import { scopeSetKey, useAppScopes } from "./useAppScopes.js";
import type { ResolvedAppScope } from "./useAppScopes.js";

import styles from "./InlineAppRoute.module.css";

export interface InlineAppRouteProps {
  app: AppMetaResolvedType;
  appId: string;
  loader: () => Promise<{ default: InlineAppModule }>;
  nav: ShellNav;
  renderStem: (nav: ShellNav) => ReactNode;
  statusLine?: ReactNode;
  prefs: AppearancePrefs;
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

// The blueprint token layer, rescoped from `:root` to the inline subtree so it
// never restyles shell chrome. Keep it synchronous.
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
      /(?<lineStart>^|\n)(?<indent>\s*):root\s*\{/gu,
      `$<lineStart>$<indent>.${INLINE_SCOPE_CLASS} {`
    );
  const style = document.createElement("style");
  style.dataset.centraidInlineTokens = "true";
  style.textContent = scoped;
  document.head.appendChild(style);
}

// One promise per (appId, attempt) so React `use()` sees a stable one. Cache
// REJECTIONS too, or a Suspense remount re-runs the loader forever.
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
  scopes: readonly ResolvedAppScope[];
  frame: InlineFrame;
  compact: boolean;
  onRootReady: (el: HTMLElement | null, descriptor: InlineAppModule) => void;
  onOpenApprovals: () => void;
  onOpenApp: (appId: string) => void;
}

function InlineAppMount({
  appId,
  cacheKey: _cacheKey,
  descriptorPromise,
  scopes,
  frame,
  compact,
  onRootReady,
  onOpenApprovals,
  onOpenApp,
}: InlineAppMountProps): JSX.Element {
  const primary = scopes[0]!;
  const primaryIdentity = primary.identity;
  const primaryLease = useMemo(
    () => acquireReplicaShellSession(primaryIdentity),
    [primaryIdentity]
  );
  const descriptor = use(descriptorPromise).default;
  const lease = use(primaryLease);

  const [installation, setInstallation] = useState(() => {
    let client: unknown;
    const teardown = installInlineCentraid({
      appId,
      queries: descriptor.queries,
      pendingProjection: descriptor.pendingProjection,
      scopes: [{ scope: primary.scope, session: lease.session }],
      onOpenApprovals,
      onOpenApp,
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

  // Independent sessions: a failing audience must not hold up the others.
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
          // An audience that cannot open is simply not offered.
        });
    }
    return () => {
      alive = false;
      for (const held of leases) held.release();
    };
  }, [descriptor.multiScope, installed, scopes]);
  const Root = descriptor.Root;
  // The ref MUST be stable: React answers an identity change by detaching and
  // reattaching the SAME element, which revokes live blob: URLs under
  // still-mounted <img>s.
  const rootRef = useCallback(
    (el: HTMLElement | null) => onRootReady(el, descriptor),
    [descriptor, onRootReady]
  );
  return <Root rootRef={rootRef} frame={frame} compact={compact} />;
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
  // The seat wall (docs/blueprint-seats.md S5): a MANIFEST-declared refusal,
  // never a hard-coded app id, and never a security boundary.
  const refused = isDisabledOnSeat(appId, seat());
  const [attempt, setAttempt] = useState(0);
  const appRootRef = useRef<HTMLElement | null>(null);
  const askTeardown = useRef<(() => void) | null>(null);
  const blobTeardown = useRef<(() => void) | null>(null);
  const knobValues = useRef<Record<string, string>>({});

  // Blueprints may not import the client package, so `data-gateway-status` on
  // the inline root IS the reachability contract.
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
      // Keyed to the ELEMENT, not this callback: most `null` detaches are not
      // unmounts. Only a DIFFERENT element replaces the install; the unmount
      // effect below revokes exactly once.
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
      blobTeardown.current = installInlineBlobImages(el);
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

  // THE FRAME CONTRIBUTES NOTHING TO THE BAR. `AppSettingsController.tsx` and
  // `inlineAppFlows.ts` stay unmounted until a door is designed.

  const cacheKey = `${appId}:${attempt}`;
  // Start the chunk import NOW so it runs beside the scopes fetch. A refused
  // seat never calls `loader()`.
  const descriptorPromise = useMemo(
    () => (refused ? undefined : loadDescriptor(cacheKey, loader)),
    [cacheKey, loader, refused]
  );
  // The mount key carries a SCOPE-SET axis (docs/client-keying.md):
  // `window.centraid` and its replica leases are per scope set.
  const scopesState = useAppScopes(appId);
  const mounted = scopesState.status === "ready" ? scopesState.data : null;
  const scopes = mounted?.scopes ?? null;
  const scopeKey = scopes ? scopeSetKey(scopes) : "";
  const mountKey = `${appId}\0${cacheKey}\0${scopeKey}`;

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
      {...(compact
        ? {}
        : { onToggleStem: nav.toggleStem, stemOpen: nav.stemOpen })}
      {...(contributed.band === undefined ? {} : { band: contributed.band })}
      statusLine={statusLine}
      canGoBack={nav.canGoBack}
      canGoForward={nav.canGoForward}
      onBack={() => nav.back()}
      onForward={() => nav.forward()}
      appMark={contributed.mark}
      appTitle={contributed.title}
      {...(contributed.count === undefined
        ? {}
        : { appCount: contributed.count })}
      titlebarRight={contributed.actions}
    >
      <div className={styles.view} data-testid="inline-app-view">
        <div className={styles.body}>
          {refused ? (
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
                    compact={Boolean(compact)}
                    onRootReady={onRootReady}
                    onOpenApprovals={() => nav.navigate({ kind: "approvals" })}
                    onOpenApp={(id) => nav.navigate({ kind: "app", id })}
                  />
                ) : (
                  <div className={styles.fallback}>Loading {app.name}…</div>
                )}
              </Suspense>
            </ErrorBoundary>
          )}
        </div>
      </div>
    </ShellFrame>
  );
}
