import type { JSX } from 'react';
import type { HomeAppItemDTO, HomeAutoItemDTO, HomeMenuAnchor } from '../screen-contracts.js';
import { AppCard, AutoCard } from './HomeScreen.js';
import styles from './HomeScreen.module.css';
import { cx } from '../ui/cx.js';

export interface StarredScreenProps {
  appItems: readonly HomeAppItemDTO[];
  automationItems: readonly HomeAutoItemDTO[];
  onOpenApp: (id: string) => void;
  onEnterDraft: (id: string) => void;
  onAppContext: (id: string, anchor: HomeMenuAnchor) => void;
  onOpenAutomation: (ref: string) => void;
  onAutomationMenu: (ref: string, anchor: HomeMenuAnchor) => void;
}

/**
 * Starred library — Home's card grid narrowed to starred apps + automations.
 * The route filters the DTOs; this just lays them out with the shared cards,
 * so a starred tile looks identical here and on Home.
 */
export default function StarredScreen({
  appItems,
  automationItems,
  onOpenApp,
  onEnterDraft,
  onAppContext,
  onOpenAutomation,
  onAutomationMenu,
}: StarredScreenProps): JSX.Element {
  return (
    <div className={cx(styles.appsGrid, styles.appsGridSmall)} data-layout="tiles">
      {appItems.map((a) => (
        <AppCard
          key={a.id}
          a={a}
          onOpen={onOpenApp}
          onEnterDraft={onEnterDraft}
          onContext={onAppContext}
        />
      ))}
      {automationItems.map((r) => (
        <AutoCard key={r.ref} r={r} onOpen={onOpenAutomation} onMenu={onAutomationMenu} />
      ))}
    </div>
  );
}
