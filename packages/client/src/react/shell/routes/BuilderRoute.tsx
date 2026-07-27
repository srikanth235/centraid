import { type JSX, type ReactNode, useState } from 'react';
import type { AppearancePrefs, ShellRoute } from '../../../app-shell-context.js';
import { useShellActions } from '../actions.js';
import type { ShellNav } from '../ShellApp.js';
import BuilderShell from './builder/BuilderShell.js';
import BuilderTargetGate from './BuilderTargetGate.js';
import { useMemberScopes } from '../useMemberScopes.js';

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
  // Where a NEW app lands (issue #599, Decision 14). The builder creates its
  // app on mount, so the target is chosen on a gate BEFORE the builder mounts —
  // and only when there is genuinely a choice to make.
  const memberScopes = useMemberScopes();
  const [chosenScope, setChosenScope] = useState<string | undefined>(undefined);

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
              ...(input.name === undefined ? {} : { name: input.name }),
              ...(input.description === undefined
                ? {}
                : { desc: input.description || 'Built with Centraid.' }),
            }
          : a,
      ),
    );
  };

  const automation = route.kind === 'automation-builder';
  // A fresh from-a-prompt build is the only flow that creates an app; editing
  // an existing one already knows where it lives.
  const isNewBuild = !automation && !route.appContext && Boolean(route.initialPrompt);
  const writableScopes = memberScopes.scopes.filter((s) => s.canWrite);
  const targetScopeId = chosenScope ?? memberScopes.primary?.id;
  if (isNewBuild && !chosenScope && writableScopes.length > 1) {
    return (
      <BuilderTargetGate
        scopes={memberScopes.scopes}
        defaultScopeId={memberScopes.primary?.id}
        onConfirm={setChosenScope}
        onCancel={() => nav.replace({ kind: 'home' })}
      />
    );
  }

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
      {...(isNewBuild && targetScopeId ? { targetScopeId } : {})}
      {...(automation
        ? {
            initialAppId: route.automationId,
            // Editor→builder "compile" handoff (receipts/issue-387-automations-ui-revamp.md): a
            // seeded first turn posts automatically once useBuilder's
            // bootstrap effect sees `initialPrompt` on an automation route
            // (useBuilder.ts:562's `if (initialPrompt) sendUserPrompt(...)`),
            // mirroring how `builder`'s own `initialPrompt` seeds a
            // from-Home prompt below.
            ...(route.seedMessage ? { initialPrompt: route.seedMessage } : {}),
          }
        : {
            // Editing an installed/published app: thread its existing id
            // through as initialAppId so useBuilder resolves isUpdateMode
            // and BuilderPreview gets a real appId to build a draft preview
            // src from. Without this, appId stays undefined and the preview
            // pane is stuck on the "Building…" skeleton forever — appContext
            // alone (name/color/icon) isn't enough.
            ...(route.appContext
              ? { appContext: route.appContext, initialAppId: route.appContext.id }
              : {}),
            ...(route.initialPrompt ? { initialPrompt: route.initialPrompt } : {}),
          })}
    />
  );
}
