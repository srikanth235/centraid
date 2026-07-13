import { type JSX } from 'react';
import type { AppearancePrefs } from '../../../app-shell-context.js';
import { listAutomations } from '../../../gateway-client.js';
import type { HomeMenuAnchor } from '../../screen-contracts.js';
import StarredScreen from '../../screens/StarredScreen.js';
import { useShellActions } from '../actions.js';
import { openMenu } from '../contextMenu.js';
import type { ShellMenuAnchor } from '../Sidebar.js';
import PageScroll from '../PageScroll.js';
import { PageEmpty } from '../status.js';
import { useAsyncData } from '../useAsyncData.js';
import { collectAutomationRuns } from './automationsData.js';
import { buildHomeAppItems, buildHomeAutoItems } from './homeData.js';

export interface StarredRouteProps {
  userApps: readonly UserAppMeta[];
  drafts: readonly DraftAppMeta[];
  tileVariant: AppearancePrefs['tileVariant'];
  isStarred: (id: string) => boolean;
  toggleStar: (id: string) => void;
}

// Starred page — the Home library filtered to starred items (replaces the
// migration-era empty-state stub). Reuses the Home DTO builders so cards stay
// pixel-identical; the context menu here is deliberately narrow (Open/Unstar —
// rename/delete/share stay on Home, the library of record). Unstarring drops
// the card immediately because star state lives in the App root.
export default function StarredRoute(props: StarredRouteProps): JSX.Element {
  const { navigate, enterBuilder } = useShellActions();
  const { userApps, drafts, tileVariant, isStarred, toggleStar } = props;

  const feed = useAsyncData(async () => {
    const [rows, entries] = await Promise.all([
      listAutomations().catch(() => [] as CentraidAutomationRow[]),
      collectAutomationRuns().catch(() => []),
    ]);
    return { rows, entries };
  });

  const apps: AppMetaResolvedType[] = [...userApps, ...drafts];
  const rows = feed.status === 'ready' ? feed.data.rows : [];
  const entries = feed.status === 'ready' ? feed.data.entries : [];
  const appItems = buildHomeAppItems(apps, { userApps, isStarred, tileVariant }).filter(
    (a) => a.starred,
  );
  const automationItems = buildHomeAutoItems(rows, entries, isStarred).filter((r) => r.starred);

  const toAnchor = (a: HomeMenuAnchor): ShellMenuAnchor =>
    a.kind === 'point'
      ? { kind: 'point', x: a.x ?? 0, y: a.y ?? 0 }
      : { kind: 'rect', rect: a.rect as unknown as DOMRect };

  const appMenu = (id: string, anchor: HomeMenuAnchor): void => {
    const app = apps.find((a) => a.id === id);
    if (!app) return;
    const draft = (app as DraftAppMeta).__draft === true;
    const items = [
      draft
        ? { id: 'update', label: 'Continue editing', icon: 'Sparkle' }
        : { id: 'open', label: 'Open', icon: 'Eye' },
      { id: 'star', label: 'Unstar', icon: 'Star' },
    ];
    openMenu(items, toAnchor(anchor), (pick) => {
      if (pick === 'open') navigate({ kind: 'app', id });
      else if (pick === 'update') enterBuilder({ appContext: app });
      else if (pick === 'star') toggleStar(id);
    });
  };

  const automationMenu = (ref: string, anchor: HomeMenuAnchor): void => {
    openMenu(
      [
        { id: 'open', label: 'Open', icon: 'Eye' },
        { id: 'star', label: 'Unstar', icon: 'Star' },
      ],
      toAnchor(anchor),
      (pick) => {
        if (pick === 'open') navigate({ kind: 'automation-view', automationId: ref });
        else if (pick === 'star') toggleStar(ref);
      },
    );
  };

  return (
    <PageScroll title="Starred" subtitle="Apps you star show up here for quick access.">
      {appItems.length + automationItems.length === 0 ? (
        <PageEmpty message="Nothing starred yet. Hover an app tile and tap the star." />
      ) : (
        <StarredScreen
          appItems={appItems}
          automationItems={automationItems}
          onOpenApp={(id) => navigate({ kind: 'app', id })}
          onEnterDraft={(id) => {
            const a = apps.find((x) => x.id === id);
            if (a) enterBuilder({ appContext: a });
          }}
          onAppContext={appMenu}
          onOpenAutomation={(ref) => navigate({ kind: 'automation-view', automationId: ref })}
          onAutomationMenu={automationMenu}
        />
      )}
    </PageScroll>
  );
}
