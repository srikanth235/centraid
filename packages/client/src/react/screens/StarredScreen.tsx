import type { JSX } from "react";

import type {
  HomeAppItemDTO,
  HomeAutoItemDTO,
  HomeMenuAnchor,
} from "../screen-contracts.js";
import { cx } from "../ui/cx.js";
import { AppCard, AutoCard } from "./LibraryCards.js";

import styles from "./LibraryCards.module.css";

export interface StarredScreenProps {
  appItems: readonly HomeAppItemDTO[];
  automationItems: readonly HomeAutoItemDTO[];
  onOpenApp: (id: string) => void;
  onAppContext: (id: string, anchor: HomeMenuAnchor) => void;
  onOpenAutomation: (ref: string) => void;
  onAutomationMenu: (ref: string, anchor: HomeMenuAnchor) => void;
}

export default function StarredScreen({
  appItems,
  automationItems,
  onOpenApp,
  onAppContext,
  onOpenAutomation,
  onAutomationMenu,
}: StarredScreenProps): JSX.Element {
  return (
    <div
      className={cx(styles.appsGrid, styles.appsGridSmall)}
      data-layout="tiles"
    >
      {appItems.map((a) => (
        <AppCard key={a.id} a={a} onOpen={onOpenApp} onContext={onAppContext} />
      ))}
      {automationItems.map((r) => (
        <AutoCard
          key={r.ref}
          r={r}
          onOpen={onOpenAutomation}
          onMenu={onAutomationMenu}
        />
      ))}
    </div>
  );
}
