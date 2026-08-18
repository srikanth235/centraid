// The recipes every People screen is built out of, as components.
//
// ONE ROW AND ONE SECTION FOR THE WHOLE APP. The roster, Search, Touch's three
// lists, Trash and Merge all draw the SAME row; the person screen and Touch
// draw the SAME section head. That is the point of this file: a screen picks
// recipes, it does not describe a row. Geometry lives beside it in
// `shared.module.css`, declared exactly once.
//
// Every member-supplied string — a name, a role, a note, a channel value —
// goes through `displayText` on its way in (`_shared/untrusted.ts`). React
// escapes text nodes; `displayText` additionally strips the invisible control
// characters that can make one label impersonate another.
import type { CSSProperties, ReactNode } from "react";

import { identityHueKey } from "@centraid/design";

import { Avatar } from "../../_shared/Avatar.tsx";
import { displayText } from "../../_shared/untrusted.ts";
import { LABELS } from "../people-copy.ts";

import styles from "./shared.module.css";

/** The star mark: 17px on a 24 grid, stroke 1.5, filled while it is on. */
const STAR_PATH =
  "M12 3.8l2.6 5.2 5.7.9-4.1 4 1 5.7-5.2-2.8-5.2 2.8 1-5.7-4.1-4 5.7-.9z";

/** The minimum an avatar needs: identity for the hue, a name for the monogram. */
export interface AvatarSubject {
  party_id: string;
  name: string;
  avatar_color?: string | null;
}

/**
 * A person's disc.
 *
 * The size is a CSS custom property the ROW owns (`--pe-avatar-size`), not a
 * number this component branches on: the handoff draws 34px on touch and 30 on
 * a pointer surface, and a JS branch for that would be a second breakpoint
 * nobody could see from the stylesheet.
 *
 * A stored `avatar_color` is honoured verbatim — it is the member's own choice
 * — and a person who has never been given one takes their place on the shared
 * identity wheel, keyed by `party_id` so a rename never moves them.
 */
export function PersonAvatar({ person }: { person: AvatarSubject }): ReactNode {
  const fill =
    person.avatar_color ?? `var(--c-${identityHueKey(person.party_id)})`;
  return (
    <Avatar
      name={displayText(person.name)}
      color={fill}
      size="var(--pe-avatar-size)"
    />
  );
}

/** The star, as its own 44×44 control. It stops propagation, so pressing it
 *  never opens the person underneath it. */
export function StarButton({
  name,
  starred,
  onToggle,
}: {
  name: string;
  starred: boolean;
  onToggle: () => void;
}): ReactNode {
  const label = starred ? LABELS.unstar : LABELS.star;
  return (
    <button
      type="button"
      className={styles.star}
      data-on={starred ? "true" : "false"}
      aria-label={label(displayText(name))}
      aria-pressed={starred}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <svg
        aria-hidden="true"
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill={starred ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={STAR_PATH} />
      </svg>
    </button>
  );
}

export interface RowProps {
  /** Drawn when the row is about a person; omitted where it is not. */
  avatar?: AvatarSubject;
  name: string;
  /** The name in its strong rung — the same size, so nothing reflows. */
  strong?: boolean;
  /** The second line: a role, a cadence, a kind. */
  sub?: string;
  /** Is the sub-line a number, and therefore the numeric register? */
  subNumeric?: boolean;
  /** The one fact in the meta slot. */
  meta?: string;
  /** The meta slot's fact is a consequence (overdue, a duplicate). */
  metaNet?: boolean;
  /** Opens whatever the row is about. A row with no handler is not a button. */
  onOpen?: () => void;
  /** The trailing verbs, in the `small` recipe (`Verb` below). */
  trailing?: ReactNode;
  /** The star, where the row carries one. */
  star?: ReactNode;
}

/** THE ROW. Avatar · main · meta · verbs · star, in that order, everywhere. */
export function Row(props: RowProps): ReactNode {
  const name = displayText(props.name);
  const body = (
    <>
      <span
        className={styles.rowName}
        data-strong={String(props.strong ?? false)}
      >
        {name}
      </span>
      {props.sub ? (
        <span
          className={styles.rowSub}
          data-numeric={String(props.subNumeric ?? false)}
        >
          {displayText(props.sub)}
        </span>
      ) : null}
    </>
  );
  return (
    <div className={styles.row}>
      {props.avatar ? <PersonAvatar person={props.avatar} /> : null}
      {props.onOpen ? (
        <button
          type="button"
          className={styles.rowMain}
          aria-label={LABELS.openPerson(name)}
          onClick={props.onOpen}
        >
          {body}
        </button>
      ) : (
        <div className={styles.rowMain}>{body}</div>
      )}
      {props.meta ? (
        <span
          className={styles.rowMeta}
          data-net={String(props.metaNet ?? false)}
        >
          {displayText(props.meta)}
        </span>
      ) : null}
      {props.trailing}
      {props.star}
    </div>
  );
}

/** A trailing verb — the handoff's `small` recipe, or its `smallQuiet` twin
 *  where the verb is a removal that must not compete with the row's own name. */
export function Verb({
  label,
  quiet = false,
  disabled = false,
  ariaLabel,
  onClick,
}: {
  label: string;
  quiet?: boolean;
  disabled?: boolean;
  /** Supply where the visible word does not name its object ("✕"). */
  ariaLabel?: string;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      className={quiet ? `${styles.verb} ${styles.verbQuiet}` : styles.verb}
      disabled={disabled}
      {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {label}
    </button>
  );
}

export interface SectionProps {
  title: string;
  /** How many rows are inside. Omitted rather than shown as an invented zero. */
  count?: number;
  /** Collapsible sections carry `aria-expanded` on their head. */
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
  /** The head's own `Add`, where the section can be added to in place. */
  add?: ReactNode;
  /** A rule and air above, separating this section from the one before it. */
  ruled?: boolean;
  children: ReactNode;
}

/** THE SECTION. A head row with a title, a count, an optional collapse mark
 *  and an optional Add — then the rows, or the section's own one-sentence
 *  empty state. */
export function Section(props: SectionProps): ReactNode {
  const open = props.open ?? true;
  const head = (
    <>
      <span className={styles.sectionTitle}>{displayText(props.title)}</span>
      {props.count === undefined ? null : (
        <span className={styles.sectionMeta}>{props.count}</span>
      )}
      {props.collapsible ? (
        <span className={styles.caret} aria-hidden="true">
          {open ? "−" : "+"}
        </span>
      ) : null}
    </>
  );
  return (
    <section
      className={styles.section}
      data-ruled={String(props.ruled ?? false)}
    >
      <div className={styles.sectionHead}>
        {props.collapsible && props.onToggle ? (
          <button
            type="button"
            className={styles.sectionHeadBtn}
            aria-expanded={open}
            aria-label={LABELS.collapse(displayText(props.title))}
            onClick={props.onToggle}
          >
            {head}
          </button>
        ) : (
          head
        )}
        {props.add ? (
          <span className={styles.sectionAdd}>{props.add}</span>
        ) : null}
      </div>
      {open ? props.children : null}
    </section>
  );
}

export interface ChipOption {
  id: string;
  label: string;
}

/** A chip row. One chip is on; the weight moves and the leading is held, so
 *  the row cannot reflow when the choice changes. */
export function ChipRow({
  options,
  active,
  onSelect,
  label,
}: {
  options: readonly ChipOption[];
  active: string;
  onSelect: (id: string) => void;
  /** Names the group for a screen reader — "Filter", "Kind", "Colour". */
  label: string;
}): ReactNode {
  return (
    // A `<fieldset>` rather than a div carrying `role="group"`: the grouping is
    // native, so it survives a stylesheet and cannot drift from the markup.
    <fieldset className={styles.chipRow} aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={styles.chip}
          aria-pressed={option.id === active}
          onClick={() => onSelect(option.id)}
        >
          {displayText(option.label)}
        </button>
      ))}
    </fieldset>
  );
}

export interface CountTile {
  id: string;
  label: string;
  count: number;
  /** Paint the number in the consequence tone while it is above zero. */
  net?: boolean;
}

/** The count tiles: two-up on a phone, four-up on a pointer surface. Each is
 *  a button that filters or navigates — a tile that only displayed a number
 *  would be a badge, and this product has none. */
export function CountTiles({
  tiles,
  narrow,
  onSelect,
}: {
  tiles: readonly CountTile[];
  narrow: boolean;
  onSelect: (id: string) => void;
}): ReactNode {
  return (
    <div className={styles.tiles} data-narrow={String(narrow)}>
      {tiles.map((tile) => (
        <button
          key={tile.id}
          type="button"
          className={styles.tile}
          onClick={() => onSelect(tile.id)}
        >
          <span
            className={styles.tileNumber}
            data-net={String(Boolean(tile.net) && tile.count > 0)}
          >
            {tile.count}
          </span>
          <span className={styles.tileLabel}>{displayText(tile.label)}</span>
        </button>
      ))}
    </div>
  );
}

/** A labelled input — the handoff's `field` recipe, at control height. */
export function Field({
  label,
  value,
  placeholder,
  inputRef,
  onChange,
  trailing,
}: {
  label: string;
  value: string;
  placeholder?: string;
  inputRef?: (el: HTMLInputElement | null) => void;
  onChange: (value: string) => void;
  /** A Save, a Clear — whatever completes the field. */
  trailing?: ReactNode;
}): ReactNode {
  return (
    <label className={styles.fieldLabel}>
      {displayText(label)}
      <span className={styles.fieldRow}>
        <input
          className={styles.field}
          value={value}
          aria-label={displayText(label)}
          {...(placeholder ? { placeholder: displayText(placeholder) } : {})}
          {...(inputRef ? { ref: inputRef } : {})}
          onChange={(event) => onChange(event.target.value)}
        />
        {trailing}
      </span>
    </label>
  );
}

/** THE MODAL CONFIRM — the two acts that cannot be undone by a reverse write.
 *  Everything else reports on the status line instead. */
export function ConfirmPanel({
  title,
  body,
  verb,
  onConfirm,
  onCancel,
  cancelLabel,
}: {
  title: string;
  body: string;
  verb: string;
  onConfirm: () => void;
  onCancel: () => void;
  cancelLabel: string;
}): ReactNode {
  return (
    <div className={styles.confirmScrim} role="presentation">
      <button
        type="button"
        className={styles.confirmDismiss}
        aria-label={cancelLabel}
        onClick={onCancel}
      />
      {/* A native `<dialog open>` rather than a div wearing `role="dialog"`:
          the semantics come with the element, and the panel is laid inside the
          app's own scrim rather than the top layer so it stays inside the
          route's pane. */}
      <dialog
        open
        className={styles.confirmPanel}
        aria-modal="true"
        aria-label={displayText(title)}
      >
        <h2 className={styles.confirmTitle}>{displayText(title)}</h2>
        <p className={styles.confirmBody}>{displayText(body)}</p>
        <div className={styles.confirmActions}>
          <button type="button" className="kit-btn quiet" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className="kit-btn destructive"
            onClick={onConfirm}
          >
            {verb}
          </button>
        </div>
      </dialog>
    </div>
  );
}

/** The cadence line under the hero, in the consequence tone while overdue. */
export function CadenceLine({
  text,
  net,
}: {
  text: string;
  net: boolean;
}): ReactNode {
  return (
    <div className={styles.cadenceLine} data-net={String(net)}>
      {displayText(text)}
    </div>
  );
}

/** A screen's closing sentence — the trash's purge line, a section's caption. */
export function Caption({ text }: { text: string }): ReactNode {
  return <p className={styles.caption}>{displayText(text)}</p>;
}

/** The commit row: one filled control, one quiet neighbour, both filling the
 *  row on a compact surface. */
export function Commits({
  narrow,
  children,
}: {
  narrow: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <div className={styles.commits} data-narrow={String(narrow)}>
      {children}
    </div>
  );
}

/** The shared column wrapper, so a screen's blocks stack at one rhythm. */
export function Stack({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}): ReactNode {
  return (
    <div className={styles.stack} {...(style ? { style } : {})}>
      {children}
    </div>
  );
}

/** The skeleton's own frame, so placeholder rows stand at the set's rhythm. */
export function SkeletonBlock({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  return <div className={styles.skeleton}>{children}</div>;
}
