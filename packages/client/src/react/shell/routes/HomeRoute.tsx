import { useState, type JSX } from 'react';
import type { AppearancePrefs } from '../../../app-shell-context.js';
import {
  deleteApp,
  deleteAutomation,
  listAutomations,
  renameInstalledApp,
  runAutomationNow,
  updateAppMeta,
} from '../../../gateway-client.js';
import type { HomeMenuAnchor } from '../../screen-contracts.js';
import HomeScreen from '../../screens/HomeScreen.js';
import { useShellActions } from '../actions.js';
import { openMenu } from '../contextMenu.js';
import { openPrompt } from '../prompt.js';
import type { ShellMenuAnchor } from '../Sidebar.js';
import PageScroll from '../PageScroll.js';
import { PageLoading } from '../status.js';
import { useAsyncData } from '../useAsyncData.js';
import AppInfoModal from './AppInfoModal.js';
import { collectAutomationRuns } from './automationsData.js';
import { loadAppTemplates } from './templatesData.js';
import {
  attentionCount,
  buildHomeAppItems,
  buildHomeAutoItems,
  heroDateLabel,
  HERO_SUGGESTIONS,
} from './homeData.js';

export interface HomeRouteProps {
  userApps: readonly UserAppMeta[];
  drafts: readonly DraftAppMeta[];
  tileVariant: AppearancePrefs['tileVariant'];
  isStarred: (id: string) => boolean;
  toggleStar: (id: string) => void;
  refreshApps: () => Promise<void>;
}

// React-owned Home — the landing screen. Replaces the vanilla renderHomeAsync
// (app.ts). The app + draft list comes from the App root (props); automations +
// their run feed load here. Derives the card DTOs (homeData) and owns the app +
// automation context menus (the ported openMenu overlay) + all the card
// callbacks via ShellActions. Rename/Share are the two actions still stubbed
// (Share = the 116-line sheet; Rename reaches into card DOM in vanilla — both
// deferred, see notes).
export default function HomeRoute(props: HomeRouteProps): JSX.Element {
  const { navigate, enterBuilder, showToast, confirm, builderEnabled } = useShellActions();
  const { userApps, drafts, tileVariant, isStarred, toggleStar, refreshApps } = props;
  // The app whose "App info" sheet is open (its live grants + Uninstall).
  const [infoApp, setInfoApp] = useState<AppMetaResolvedType | null>(null);

  const feed = useAsyncData(async () => {
    const [rows, entries, appTemplates] = await Promise.all([
      listAutomations().catch(() => [] as CentraidAutomationRow[]),
      collectAutomationRuns().catch(() => []),
      // Bundled app-template ids are RESERVED (issue #434) and an installed
      // bundled app keeps its blueprint id — so an app whose id is in this set
      // is a bundled install (serves in place), which gets Uninstall + App
      // info; anything else is a code-store app (legacy clone) that keeps
      // Delete. Best-effort: an empty set degrades every app to code-store.
      loadAppTemplates().catch(() => []),
    ]);
    return { rows, entries, bundledIds: new Set(appTemplates.map((t) => t.id)) };
  });

  const bundledIds: ReadonlySet<string> =
    feed.status === 'ready' ? feed.data.bundledIds : new Set<string>();

  const apps: AppMetaResolvedType[] = [...userApps, ...drafts];
  const findApp = (id: string): AppMetaResolvedType | undefined => apps.find((a) => a.id === id);
  /** The gateway app id (a bundled install keeps its own id). */
  const gatewayAppId = (app: AppMetaResolvedType): string =>
    (app as UserAppMeta).centraidAppId ?? app.id;

  // The Home screen emits the contract's HomeMenuAnchor (loose optionals); the
  // context-menu overlay takes the shell's discriminated ShellMenuAnchor.
  const toAnchor = (a: HomeMenuAnchor): ShellMenuAnchor =>
    a.kind === 'point'
      ? { kind: 'point', x: a.x ?? 0, y: a.y ?? 0 }
      : { kind: 'rect', rect: a.rect as unknown as DOMRect };

  const appContextMenu = (id: string, anchor: HomeMenuAnchor): void => {
    const app = findApp(id);
    if (!app) return;
    const draft = (app as DraftAppMeta).__draft === true;
    // A bundled install serves in place (issue #434): it's an Uninstall (data
    // stays) + App info app, not a Delete (wipe files) one. Anything else
    // non-draft is a code-store app (legacy clone) that keeps Delete.
    const bundled = !draft && bundledIds.has(app.id);
    const star = { id: 'star', label: isStarred(app.id) ? 'Unstar' : 'Star', icon: 'Star' };
    // "Edit with Centraid" / "Continue editing" (and the whole draft menu) are
    // builder entry points (issue #434, Phase 3) — omitted when the builder is
    // hidden. Drafts never render in that case, so the draft branch is
    // effectively dead then; it stays guarded for symmetry. Share (stubbed) and
    // Reveal in Finder are dropped from the installed-app menu.
    const items = draft
      ? [
          ...(builderEnabled ? [{ id: 'update', label: 'Continue editing', icon: 'Sparkle' }] : []),
          { id: 'rename', label: 'Rename', icon: 'Pencil' },
          star,
          'sep' as const,
          { id: 'delete', label: 'Delete draft', icon: 'Trash', danger: true },
        ]
      : bundled
        ? [
            { id: 'open', label: 'Open', icon: 'Eye' },
            { id: 'info', label: 'App info', icon: 'Key' },
            { id: 'rename', label: 'Rename', icon: 'Pencil' },
            star,
            'sep' as const,
            { id: 'uninstall', label: 'Uninstall', icon: 'Trash', danger: true },
          ]
        : [
            { id: 'open', label: 'Open', icon: 'Eye' },
            ...(builderEnabled
              ? [{ id: 'update', label: 'Edit with Centraid', icon: 'Sparkle' }]
              : []),
            { id: 'rename', label: 'Rename', icon: 'Pencil' },
            star,
            'sep' as const,
            { id: 'delete', label: 'Delete', icon: 'Trash', danger: true },
          ];
    openMenu(items, toAnchor(anchor), (pick) => {
      if (pick === 'open') navigate({ kind: 'app', id: app.id });
      else if (pick === 'update') enterBuilder({ appContext: app });
      else if (pick === 'info') setInfoApp(app);
      else if (pick === 'star') toggleStar(app.id);
      else if (pick === 'rename') void renameAppFlow(app, bundled);
      else if (pick === 'uninstall') void uninstallAppFlow(app);
      else if (pick === 'delete') void deleteAppFlow(app);
    });
  };

  const deleteAppFlow = async (app: AppMetaResolvedType): Promise<void> => {
    const draft = (app as DraftAppMeta).__draft === true;
    const ok = await confirm({
      confirmLabel: 'Delete',
      danger: true,
      title: draft ? 'Delete draft?' : 'Delete app?',
      message: draft
        ? `Delete the draft "${app.name}"? Its app files will be removed from disk.`
        : `Delete "${app.name}"? This removes it from the gateway and wipes its local app files. Data published to the gateway cannot be recovered.`,
    });
    if (!ok) return;
    try {
      await deleteApp({ id: app.id });
      showToast(`Deleted ${draft ? 'draft ' : ''}"${app.name}"`);
    } catch (err) {
      showToast(`Could not delete: ${err instanceof Error ? err.message : String(err)}`);
    }
    void refreshApps();
  };

  // Uninstall a bundled app (issue #434): revokes its access; the user's data
  // rows are retained (uninstall is not a purge — that's a later explicit act).
  // Uses the same `deleteApp` wire, which for a bundled id deregisters + revokes
  // without a git delete (there's no code in the store).
  const uninstallAppFlow = async (app: AppMetaResolvedType): Promise<void> => {
    const ok = await confirm({
      confirmLabel: 'Uninstall',
      danger: true,
      title: `Uninstall ${app.name}?`,
      message: `Removes "${app.name}" and revokes its access. Your data stays in your vault.`,
    });
    if (!ok) return;
    try {
      await deleteApp({ id: app.id });
      showToast(`Uninstalled "${app.name}"`);
    } catch (err) {
      showToast(`Could not uninstall: ${err instanceof Error ? err.message : String(err)}`);
    }
    void refreshApps();
  };

  const renameAppFlow = async (app: AppMetaResolvedType, bundled: boolean): Promise<void> => {
    const next = await openPrompt({
      title: 'Rename app',
      initial: app.name,
      placeholder: 'App name',
      confirmLabel: 'Rename',
    });
    if (!next) return; // cancelled, empty, or unchanged
    try {
      // A bundled app's code is read-only — rename sets a per-vault label with
      // NO editing session (renameInstalledApp); code-store apps rewrite
      // app.json via updateAppMeta.
      if (bundled) await renameInstalledApp({ id: gatewayAppId(app), name: next });
      else await updateAppMeta({ id: app.id, name: next });
      showToast(`Renamed to "${next}"`);
    } catch (err) {
      showToast(`Could not rename: ${err instanceof Error ? err.message : String(err)}`);
    }
    void refreshApps();
  };

  const automationMenu = (ref: string, anchor: HomeMenuAnchor): void => {
    const rows = feed.status === 'ready' ? feed.data.rows : [];
    const row = rows.find((r) => r.ref === ref);
    if (!row) return;
    const items = [
      { id: 'open', label: 'Open', icon: 'Eye' },
      { id: 'run', label: 'Run now', icon: 'Play' },
      { id: 'edit', label: 'Edit', icon: 'Pencil' },
      { id: 'star', label: isStarred(ref) ? 'Unstar' : 'Star', icon: 'Star' },
      'sep' as const,
      { id: 'delete', label: 'Delete', icon: 'Trash', danger: true },
    ];
    openMenu(items, toAnchor(anchor), (pick) => {
      if (pick === 'open') navigate({ kind: 'automation-view', automationId: row.ref });
      else if (pick === 'run')
        void runAutomationNow({ automationId: row.ref })
          .then(({ runId }) => navigate({ kind: 'run-view', automationId: row.ref, runId }))
          .catch((err: unknown) =>
            showToast(`Run failed: ${err instanceof Error ? err.message : String(err)}`),
          );
      else if (pick === 'edit') navigate({ kind: 'automation-editor', automationId: row.ref });
      else if (pick === 'star') toggleStar(row.ref);
      else if (pick === 'delete')
        void confirm({
          confirmLabel: 'Delete',
          danger: true,
          title: 'Delete automation?',
          message: `Delete "${row.name}"? This removes it from the gateway and deletes its run history. This can't be undone.`,
        }).then((ok) => {
          if (!ok) return;
          void deleteAutomation({ automationId: row.ref })
            .then(() => showToast(`Deleted "${row.name}"`))
            .catch((err: unknown) =>
              showToast(`Could not delete: ${err instanceof Error ? err.message : String(err)}`),
            );
        });
    });
  };

  if (feed.status === 'loading') {
    return (
      <PageScroll flush>
        <PageLoading label="Loading…" />
      </PageScroll>
    );
  }
  const rows = feed.status === 'ready' ? feed.data.rows : [];
  const entries = feed.status === 'ready' ? feed.data.entries : [];
  const appItems = buildHomeAppItems(apps, { userApps, isStarred, tileVariant });
  const automationItems = buildHomeAutoItems(rows, entries, isStarred);

  return (
    <PageScroll flush>
      <HomeScreen
        builderEnabled={builderEnabled}
        suggestions={[...HERO_SUGGESTIONS]}
        dateLabel={heroDateLabel()}
        appItems={appItems}
        automationItems={automationItems}
        counts={{ all: apps.length + rows.length, apps: apps.length, automations: rows.length }}
        attention={attentionCount(rows, entries)}
        onBuild={(prompt) => enterBuilder({ initialPrompt: prompt })}
        onOpenApp={(id) => navigate({ kind: 'app', id })}
        onEnterDraft={(id) => {
          const a = findApp(id);
          if (a) enterBuilder({ appContext: a });
        }}
        onAppContext={appContextMenu}
        onOpenAutomation={(ref) => navigate({ kind: 'automation-view', automationId: ref })}
        onAutomationMenu={automationMenu}
        onBrowseTemplates={() => navigate({ kind: 'discover' })}
      />
      {infoApp ? (
        <AppInfoModal
          app={infoApp}
          appId={gatewayAppId(infoApp)}
          onClose={() => setInfoApp(null)}
          onUninstall={() => {
            const target = infoApp;
            setInfoApp(null);
            void uninstallAppFlow(target);
          }}
          showToast={showToast}
        />
      ) : null}
    </PageScroll>
  );
}
