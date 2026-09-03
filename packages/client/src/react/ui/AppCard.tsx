import type { JSX } from "react";

import type { AppMetaResolved, TileVariant } from "@centraid/design";

import AppMark from "./AppMark.js";
import { cx } from "./cx.js";
import KindBadge from "./KindBadge.js";
import StatusPill from "./StatusPill.js";

import styles from "./AppCard.module.css";

export type AppCardTone = "new" | "draft" | null;

export interface AppCardProps {
  app: AppMetaResolved;
  variant?: TileVariant;
  tone?: AppCardTone;
  stamp?: string;
  small?: boolean;
  onOpen?: () => void;
}

export default function AppCard({
  app,
  variant = "solid",
  tone = null,
  stamp,
  small = false,
  onOpen,
}: AppCardProps): JSX.Element {
  void variant;
  return (
    <button
      type="button"
      className={cx(styles.card, small && styles.small)}
      data-testid="app-tile"
      data-kind="app"
      onClick={onOpen}
    >
      <div className={styles.head}>
        <div className={styles.icon}>
          <AppMark colorKey={app.colorKey} iconKey={app.iconKey} size={40} />
          {tone ? <span className={styles.iconDot} data-tone={tone} /> : null}
        </div>
        <div className={styles.headText}>
          <div className={styles.nameRow}>
            <div className={styles.name}>{app.name}</div>
            {tone ? <StatusPill tone={tone}>{tone}</StatusPill> : null}
          </div>
          <div className={styles.desc}>{app.desc || "No description yet."}</div>
        </div>
      </div>
      <div className={styles.foot}>
        <KindBadge kind="app">
          <span>App</span>
        </KindBadge>
        {stamp ? <span className={styles.footTime}>{stamp}</span> : null}
      </div>
    </button>
  );
}
