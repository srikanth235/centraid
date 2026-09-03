import type { JSX } from "react";

import type { ActionData, EmptyCopy } from "@centraid/design/blocks";

import Button from "./Button.js";
import { cx } from "./cx.js";

import styles from "./EmptyBlock.module.css";

export interface EmptyAction extends ActionData {
  onClick: () => void;
}

export interface EmptyBlockProps extends EmptyCopy {
  action?: EmptyAction;
  action2?: EmptyAction;
  className?: string;
}

export default function EmptyBlock({
  title,
  body,
  action,
  action2,
  routine,
  className,
}: EmptyBlockProps): JSX.Element {
  return (
    <div
      className={cx(styles.empty, className)}
      data-routine={routine ? "true" : undefined}
    >
      <h2 className={styles.title}>{title}</h2>
      {body ? <p className={styles.body}>{body}</p> : null}
      {(action ?? action2) ? (
        <div className={styles.actions}>
          {action ? (
            <Button
              commit={!routine}
              label={action.label}
              onClick={() => action.onClick()}
              variant={routine ? "secondary" : "primary"}
            />
          ) : null}
          {action2 ? (
            <Button
              commit={false}
              label={action2.label}
              onClick={() => action2.onClick()}
              variant="quiet"
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
