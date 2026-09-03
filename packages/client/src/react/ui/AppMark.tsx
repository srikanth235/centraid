import type { CSSProperties, JSX } from "react";

import { APP_MARK_SMALL_STROKE, APP_MARK_STROKE } from "@centraid/design";
import type { ColorKey, IconName } from "@centraid/design";

import Icon from "./Icon.js";

import styles from "./AppMark.module.css";

export interface AppMarkProps {
  iconKey: IconName;
  colorKey: ColorKey;
  size?: number;
  className?: string;
}

export default function AppMark({
  iconKey,
  colorKey,
  size = 30,
  className,
}: AppMarkProps): JSX.Element {
  const style = {
    background:
      "color-mix(in oklab, var(--app-mark-hue) var(--app-mark-tint), var(--bg-elev))",
    blockSize: `${size}px`,
    borderRadius: `${Math.round(size * 0.26)}px`,
    color: "var(--app-mark-ink)",
    inlineSize: `${size}px`,
    "--app-mark-size": `${size}px`,
    "--app-mark-hue": `var(--c-${colorKey})`,
    "--app-mark-ink": `var(--c-${colorKey}-text)`,
  } as CSSProperties;
  const classNames = [styles.mark, className].filter(Boolean).join(" ");

  return (
    <span
      className={classNames}
      data-app-mark="single-tone"
      style={style}
      aria-hidden="true"
    >
      <Icon
        name={iconKey}
        size={Math.round(size * 0.56)}
        strokeWidth={size < 16 ? APP_MARK_SMALL_STROKE : APP_MARK_STROKE}
      />
    </span>
  );
}
