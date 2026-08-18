import type { JSX, ReactNode } from "react";

import Button from "../ui/Button.js";

import styles from "./SettingsPickRow.module.css";

// THE PICK ROW — the settings block for "one subject, N picks, maybe a verb"
// (binding layer v11, Settings · Agents and Enrichment).
//
// Settings → Agents and Settings → Enrichment had drawn the same object twice:
// a name with a caption under it, one or more selects at the trailing edge, and
// an optional verb after them. The Agents console drew it as a bordered
// `routeRow` grid with an accent dot; Enrichment drew it as a chip strip inside
// a capability row. Neither was wrong on its own, and the two read as different
// products on adjacent pages of one modal.
//
// It is a ROW WITH A HAIRLINE ABOVE IT, not a card: these stack under one
// section head, and a container per subject would put a border around each
// line of what is really one list. `first` drops the hairline on the leading
// row, because a rule under a head is a second head.
//
// The DETAIL slot is the row's own expansion — the failover ladder under the
// Automations lane, the model and level under an enrichment engine. It sits
// inside the row's block so the disclosure and what it discloses share one
// hairline; a peer block below would read as the next subject.

export interface PickRowAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** What distinguishes this instance of a repeated verb; lowered to `title`. */
  hint?: string;
}

export interface PickRowProps {
  label: string;
  /**
   * The subject's own mark, before its name — a harness's identity tile. Rows
   * whose subject has no artwork simply omit it; the text column does not
   * indent to a glyph column that is empty on every row.
   */
  lead?: ReactNode;
  /**
   * A third line under the caption, for facts the row states rather than sets —
   * which lanes land on this agent, what its probe reported. Not a slot for
   * controls: a control belongs in `picks`, where the eye already goes.
   */
  chips?: ReactNode;
  /** The second line: what this row is for, or what it currently inherits. */
  caption?: string;
  /**
   * The caption is about something that failed to reach the outside — an agent
   * this gateway cannot see. `--net` is the system's one chromatic ink and this
   * is the meaning it carries; it tints the caption, never the name.
   */
  captionNet?: boolean;
  /** Leading row of its list: no hairline, because the head is already one. */
  first?: boolean;
  /** The picks themselves — selects, or a stated fact where a pick would be. */
  children?: ReactNode;
  action?: PickRowAction;
  /** Expanded content under the row, inside its block and above its hairline. */
  detail?: ReactNode;
}

/** One subject, its picks, and at most one verb. */
export default function PickRow({
  label,
  lead,
  chips,
  caption,
  captionNet,
  first,
  children,
  action,
  detail,
}: PickRowProps): JSX.Element {
  return (
    <div className={styles.shell} data-first={first ? "true" : undefined}>
      <div className={styles.row}>
        {lead}
        <div className={styles.text}>
          <span className={styles.label}>{label}</span>
          {caption ? (
            <span
              className={styles.caption}
              data-net={captionNet ? "true" : undefined}
            >
              {caption}
            </span>
          ) : null}
          {chips}
        </div>
        {children ? <div className={styles.picks}>{children}</div> : null}
        {action ? (
          <Button
            className={styles.action}
            commit={false}
            disabled={action.disabled}
            label={action.label}
            onClick={() => action.onClick()}
            size="sm"
            title={action.hint}
            variant="secondary"
          />
        ) : null}
      </div>
      {detail ? <div className={styles.detail}>{detail}</div> : null}
    </div>
  );
}
