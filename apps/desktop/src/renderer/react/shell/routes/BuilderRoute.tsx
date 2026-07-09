import { type JSX, type ReactNode } from 'react';
import type { AppearancePrefs, ShellRoute } from '../../../app-shell-context.js';
import { useShellActions } from '../actions.js';
import type { ShellNav } from '../ShellApp.js';
import BuilderShell from './builder/BuilderShell.js';

// React-owned builder route — the full-bleed conversational app/automation
// builder (issue #325, R5-B). Replaces the vanilla `window.openBuilder`
// subsystem: BuilderShell renders inside the shell's ShellFrame (chrome +
// sidebar) and owns the SSE turn stream, the right-pane tabs (preview / code /
// cloud, or automation config / flow / runs / code), and version history — all
// real React. This route just maps the shell route + userApps into the
// builder's inputs (home-pin + meta-change callbacks). Handles both `builder`
// and `automation-builder`.
export interface BuilderRouteProps {
  route: Extract<ShellRoute, { kind: 'builder' } | { kind: 'automation-builder' }>;
  nav: ShellNav;
  userApps: readonly UserAppMeta[];
  setUserApps: (next: UserAppMeta[]) => void;
  renderSidebar: (nav: ShellNav) => ReactNode;
  prefs: AppearancePrefs;
  onToggleSidebar: () => void;
}

export default function BuilderRoute({
  route,
  nav,
  userApps,
  setUserApps,
  renderSidebar,
  prefs,
  onToggleSidebar,
}: BuilderRouteProps): JSX.Element {
  const { showToast } = useShellActions();

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

  return (
    <BuilderShell
      key={automation ? `auto:${route.automationId}` : `app:${route.appContext?.id ?? 'new'}`}
      nav={nav}
      renderSidebar={renderSidebar}
      prefs={prefs}
      onToggleSidebar={onToggleSidebar}
      appKind={automation ? 'automation' : 'app'}
      showToast={showToast}
      onAddToHome={onAddToHome}
      onMetaChange={onMetaChange}
      {...(automation
        ? { initialAppId: route.automationId }
        : {
            ...(route.appContext ? { appContext: route.appContext } : {}),
            ...(route.initialPrompt ? { initialPrompt: route.initialPrompt } : {}),
          })}
    />
  );
}
