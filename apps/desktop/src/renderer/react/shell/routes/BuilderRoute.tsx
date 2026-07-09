import { type JSX, useEffect, useRef } from 'react';
import type { ShellRoute } from '../../../app-shell-context.js';
import { useShellActions } from '../actions.js';
import { el } from '../el.js';
import type { ShellNav } from '../ShellApp.js';

// React-owned builder route — the full-bleed conversational app/automation
// builder. The builder (window.openBuilder) is a large vanilla subsystem (SSE
// chat + code editor + preview iframe + cloud tab); React delegates to it by
// handing it a host div as its `root` (it builds its own .cd-window inside),
// wiring back-nav + the home-pin callbacks. Handles both `builder` and
// `automation-builder` routes. The builder's own React conversion is future
// work; this makes it reachable once React owns #root.
export interface BuilderRouteProps {
  route: Extract<ShellRoute, { kind: 'builder' } | { kind: 'automation-builder' }>;
  nav: ShellNav;
  userApps: readonly UserAppMeta[];
  setUserApps: (next: UserAppMeta[]) => void;
  drafts: readonly DraftAppMeta[];
}

export default function BuilderRoute({
  route,
  nav,
  userApps,
  setUserApps,
  drafts,
}: BuilderRouteProps): JSX.Element {
  const { showToast } = useShellActions();
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof window.openBuilder !== 'function') return;

    const onAddToHome = (input: {
      prompt?: string;
      appId: string;
      name?: string;
      versionId?: string;
    }): void => {
      const now = new Date().toISOString();
      const desc = input.prompt && input.prompt.length <= 60 ? input.prompt : 'Built with Centraid.';
      const existing = userApps.find((a) => a.id === input.appId);
      if (existing) {
        setUserApps(
          userApps.map((a) =>
            a.id === input.appId
              ? { ...a, name: input.name || a.name, centraidAppId: input.appId, updatedAt: now }
              : a,
          ),
        );
        showToast(`Updated "${input.name || existing.name}"`);
        return;
      }
      const meta = {
        color: '#7C5BD9',
        colorKey: 'violet',
        createdAt: now,
        desc,
        iconKey: 'Sparkle',
        id: input.appId,
        centraidAppId: input.appId,
        name: input.name || 'New app',
        updatedAt: now,
      } as unknown as UserAppMeta;
      setUserApps([meta, ...userApps]);
    };

    const onMetaChange = (input: { appId: string; name?: string; description?: string }): void => {
      setUserApps(
        userApps.map((a) =>
          a.centraidAppId === input.appId || a.id === input.appId
            ? {
                ...a,
                ...(input.name !== undefined ? { name: input.name } : {}),
                ...(input.description !== undefined
                  ? { desc: input.description || 'Built with Centraid.' }
                  : {}),
              }
            : a,
        ),
      );
    };

    const automation = route.kind === 'automation-builder';
    const dispose = window.openBuilder({
      root: host,
      el,
      onExit: () => nav.navigate({ kind: 'home' }),
      canGoBack: nav.canGoBack,
      canGoForward: nav.canGoForward,
      onBack: nav.back,
      onForward: nav.forward,
      drafts: drafts.map((d) => ({
        id: d.id,
        name: d.name,
        iconKey: d.iconKey,
        color: d.color,
        status: 'draft' as const,
      })),
      onAddToHome,
      onMetaChange,
      ...(automation
        ? { appId: route.automationId, appKind: 'automation' as const }
        : {
            ...(route.appContext ? { appContext: route.appContext } : {}),
            ...(route.initialPrompt ? { initialPrompt: route.initialPrompt } : {}),
          }),
    });
    return () => dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={hostRef} className="builder-host" style={{ display: 'contents' }} />;
}
