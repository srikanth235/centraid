// The library card family — one app card, one automation card, and the grid
// they sit in.
//
// Home is the springboard now (issue #708): a grid of CONTENT tiles, not a
// shelf of icons. The card that answers "which things do I own" outlived that
// shelf — Starred lays out the starred subset and the automations overview
// lays out every automation — so the cards live here, on their own, rather
// than inside a screen that no longer renders them. Two surfaces drawing the
// same card from the same module is what keeps a starred tile identical to the
// tile it was starred from.
import type { JSX } from "react";

import type { IconName } from "@centraid/design";

import { INTEGRATION_HUES } from "../format.js";
import type {
  AuStatusKind,
  HomeAppItemDTO,
  HomeAutoItemDTO,
  HomeMenuAnchor,
} from "../screen-contracts.js";
import AppMark from "../ui/AppMark.js";
import { cx } from "../ui/cx.js";
import { Icon, KindBadge, StatusPill } from "../ui/index.js";

import au from "../styles/automation.module.css";
import cardCss from "../ui/AppCard.module.css";
import styles from "./LibraryCards.module.css";

const STATUS_ICON: Record<AuStatusKind, IconName> = {
  active: "Power",
  paused: "Pause",
  draft: "Pencil",
  running: "Loader",
  success: "CheckCircle",
  failed: "AlertTriangle",
};

function rectAnchor(e: { currentTarget: HTMLElement }): HomeMenuAnchor {
  const r = e.currentTarget.getBoundingClientRect();
  return {
    kind: "rect",
    rect: {
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      left: r.left,
      width: r.width,
      height: r.height,
    },
  };
}

function MoreButton({
  onOpen,
}: {
  onOpen: (a: HomeMenuAnchor) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={cardCss.act}
      aria-label="More actions"
      aria-haspopup="menu"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpen(rectAnchor(e));
      }}
    >
      <Icon name="MoreHoriz" size={16} />
    </button>
  );
}

export function AppCard({
  a,
  onOpen,
  onEnterDraft,
  onContext,
}: {
  a: HomeAppItemDTO;
  onOpen: (id: string) => void;
  onEnterDraft: (id: string) => void;
  onContext: (id: string, anchor: HomeMenuAnchor) => void;
}): JSX.Element {
  return (
    <div
      className={cardCss.wrap}
      data-app-id={a.id}
      data-starred={String(a.starred)}
    >
      <button
        type="button"
        className={cx(cardCss.card, cardCss.small)}
        // The tile's name sits four levels down, past the icon plate, so the
        // control had no name a static reader could find. Point at the name
        // node rather than retyping it into an aria-label — the accessible
        // name then always matches what the tile shows.
        aria-labelledby={`app-tile-name-${a.id}`}
        data-testid="app-tile"
        data-kind="app"
        onClick={() => (a.draft ? onEnterDraft(a.id) : onOpen(a.id))}
        onContextMenu={(e) => {
          e.preventDefault();
          onContext(a.id, { kind: "point", x: e.clientX, y: e.clientY });
        }}
      >
        <div className={cardCss.head}>
          <div className={cardCss.icon}>
            <AppMark
              colorKey={a.colorKey ?? "violet"}
              iconKey={a.iconKey as IconName}
              size={40}
            />
            {a.tone ? (
              <span className={cardCss.iconDot} data-tone={a.tone} />
            ) : null}
          </div>
          <div className={cardCss.headText}>
            <div className={cardCss.nameRow}>
              <div className={cardCss.name} id={`app-tile-name-${a.id}`}>
                {a.name}
              </div>
              {a.tone ? <StatusPill tone={a.tone}>{a.tone}</StatusPill> : null}
            </div>
            <div className={cardCss.desc}>
              {a.desc || "No description yet."}
            </div>
          </div>
        </div>
        <div className={cardCss.foot}>
          <KindBadge kind="app">
            <span>App</span>
          </KindBadge>
          <span className={cardCss.footTime}>{a.stamp}</span>
        </div>
      </button>
      <div className={cardCss.actions}>
        <MoreButton onOpen={(anchor) => onContext(a.id, anchor)} />
      </div>
      {a.starred ? (
        <span className={cardCss.starFlag} aria-hidden="true">
          <Icon name="Star" size={14} />
        </span>
      ) : null}
    </div>
  );
}

export function AutoCard({
  r,
  onOpen,
  onMenu,
}: {
  r: HomeAutoItemDTO;
  onOpen: (ref: string) => void;
  onMenu: (ref: string, anchor: HomeMenuAnchor) => void;
}): JSX.Element {
  return (
    <div className={cardCss.wrap} data-starred={String(r.starred)}>
      <button
        type="button"
        className={cx(cardCss.card, cardCss.small)}
        data-kind="automation"
        onClick={() => onOpen(r.ref)}
      >
        <div className={cardCss.head}>
          <span
            className={au.auGlyph}
            data-hue={r.hue}
            style={{ width: 52, height: 52 }}
          >
            <Icon name={r.glyphIcon as IconName} size={24} />
          </span>
          <div className={cardCss.headText}>
            <div className={cardCss.nameRow}>
              <div className={cardCss.name}>{r.name}</div>
            </div>
            <div className={cardCss.desc}>{r.blurb}</div>
          </div>
        </div>
        <div className={styles.appCardMeta}>
          <output className={au.auStatus} data-tone={r.statusKind}>
            <span className={au.auStatusIc} aria-hidden="true">
              <Icon name={STATUS_ICON[r.statusKind]} size={12} />
            </span>
            <span>{r.statusLabel}</span>
          </output>
          <span className={styles.appCardTrig}>
            <span aria-hidden="true">
              <Icon name={r.triggerIcon as IconName} size={12} />
            </span>
            <span>{r.triggerLabel}</span>
          </span>
          {r.integrations.length > 0 ? (
            <div className={au.auOvDots}>
              {r.integrations.slice(0, 4).map((name) => (
                <i
                  key={name}
                  className={au.auOvDot}
                  title={name}
                  style={{
                    background: `var(--c-${INTEGRATION_HUES[name] ?? "slate"})`,
                  }}
                />
              ))}
            </div>
          ) : null}
        </div>
        <div className={cardCss.foot}>
          <KindBadge kind="automation">
            <span>Automation</span>
          </KindBadge>
          <span
            className={cardCss.footTime}
            data-ok={r.footOk ? "true" : undefined}
          >
            {r.footOk ? (
              <span aria-hidden="true">
                <Icon name="CheckCircle" size={13} />
              </span>
            ) : null}
            <span>{r.footTimeLabel}</span>
          </span>
        </div>
      </button>
      <div className={cardCss.actions}>
        <MoreButton onOpen={(anchor) => onMenu(r.ref, anchor)} />
      </div>
      {r.starred ? (
        <span className={cardCss.starFlag} aria-hidden="true">
          <Icon name="Star" size={14} />
        </span>
      ) : null}
    </div>
  );
}
