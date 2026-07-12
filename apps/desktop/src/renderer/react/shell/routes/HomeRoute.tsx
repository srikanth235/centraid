import { type JSX } from 'react';
import type { AppearancePrefs } from '../../../app-shell-context.js';
import {
  deleteApp,
  deleteAutomation,
  listAutomations,
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
import { collectAutomationRuns } from './automationsData.js';
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
  const { navigate, enterBuilder, showToast, confirm } = useShellActions();
  const { userApps, drafts, tileVariant, isStarred, toggleStar, refreshApps } = props;

  const feed = useAsyncData(async () => {
    const [rows, entries] = await Promise.all([
      listAutomations().catch(() => [] as CentraidAutomationRow[]),
      collectAutomationRuns().catch(() => []),
    ]);
    return { rows, entries };
  });

  const apps: AppMetaResolvedType[] = [...userApps, ...drafts];
  const findApp = (id: string): AppMetaResolvedType | undefined => apps.find((a) => a.id === id);

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
    const star = { id: 'star', label: isStarred(app.id) ? 'Unstar' : 'Star', icon: 'Star' };
    const items = draft
      ? [
          { id: 'update', label: 'Continue editing', icon: 'Sparkle' },
          { id: 'rename', label: 'Rename', icon: 'Pencil' },
          { id: 'reveal', label: 'Reveal in Finder', icon: 'Folder' },
          star,
          'sep' as const,
          { id: 'delete', label: 'Delete draft', icon: 'Trash', danger: true },
        ]
      : [
          { id: 'open', label: 'Open', icon: 'Eye' },
          { id: 'update', label: 'Edit with Centraid', icon: 'Sparkle' },
          { id: 'rename', label: 'Rename', icon: 'Pencil' },
          { id: 'share', label: 'Share', icon: 'Share' },
          { id: 'reveal', label: 'Reveal in Finder', icon: 'Folder' },
          star,
          'sep' as const,
          { id: 'delete', label: 'Delete', icon: 'Trash', danger: true },
        ];
    openMenu(items, toAnchor(anchor), (pick) => {
      if (pick === 'open') navigate({ kind: 'app', id: app.id });
      else if (pick === 'update') enterBuilder({ appContext: app });
      else if (pick === 'reveal') void window.CentraidApi.openAppFolder({ id: app.id });
      else if (pick === 'star') toggleStar(app.id);
      else if (pick === 'share') showToast('Sharing isn’t available yet.');
      else if (pick === 'rename') void renameAppFlow(app);
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

  const renameAppFlow = async (app: AppMetaResolvedType): Promise<void> => {
    const next = await openPrompt({
      title: 'Rename app',
      initial: app.name,
      placeholder: 'App name',
      confirmLabel: 'Rename',
    });
    if (!next) return; // cancelled, empty, or unchanged
    try {
      await updateAppMeta({ id: app.id, name: next });
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
    </PageScroll>
  );
}
