import type { CSSProperties, ReactNode } from "react";

import { partyHueKey, partyHueValue } from "@centraid/design";

import { Avatar } from "../../_shared/Avatar.tsx";
import { KitModal } from "../../_shared/KitModal.tsx";
import { displayText } from "../../_shared/untrusted.ts";
import { virtualItemAria } from "../../_shared/virtual-window.ts";
import { virtualBlockProps } from "../../_shared/VirtualWindow.tsx";
import { LABELS } from "../people-copy.ts";

import styles from "./shared.module.css";

const STAR_PATH =
  "M12 3.8l2.6 5.2 5.7.9-4.1 4 1 5.7-5.2-2.8-5.2 2.8 1-5.7-4.1-4 5.7-.9z";

export interface AvatarSubject {
  party_id: string;
  name: string;
  avatar_color?: string | null;
}

export type LinkState = "linked" | "unlinked" | "unknown";

export function PersonAvatar({
  person,
  link = "unknown",
}: {
  person: AvatarSubject;
  link?: LinkState;
}): ReactNode {
  const hueKey = partyHueKey(person.party_id, person.avatar_color);
  const fill = hueKey ? partyHueValue(hueKey) : (person.avatar_color ?? "");
  return (
    <span className={styles.avatarRing} data-link={link}>
      <Avatar
        name={displayText(person.name)}
        color={fill}
        size="var(--pe-avatar-size)"
      />
    </span>
  );
}

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
  avatar?: AvatarSubject;
  avatarLink?: LinkState;
  name: string;
  strong?: boolean;
  sub?: string;
  subNumeric?: boolean;
  meta?: string;
  metaNet?: boolean;
  onOpen?: () => void;
  trailing?: ReactNode;
  star?: ReactNode;
  position?: { index: number; setSize: number };
}

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
  const position = props.position;
  const Box = position ? "li" : "div";
  return (
    <Box
      className={styles.row}
      {...(position
        ? {
            ...virtualBlockProps(position.index),
            ...virtualItemAria(position.index, position.setSize),
          }
        : {})}
    >
      {props.avatar ? (
        <PersonAvatar
          person={props.avatar}
          link={props.avatarLink ?? "unknown"}
        />
      ) : null}
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
    </Box>
  );
}

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
  count?: number;
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
  add?: ReactNode;
  ruled?: boolean;
  children: ReactNode;
}

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

export function ChipRow({
  options,
  active,
  onSelect,
  label,
}: {
  options: readonly ChipOption[];
  active: string;
  onSelect: (id: string) => void;
  label: string;
}): ReactNode {
  return (
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
  net?: boolean;
}

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
      {/* The kit modal in its INLINE layer: the app's own scrim, not the
          platform's top layer. */}
      <KitModal
        layer="inline"
        className={styles.confirmPanel}
        ariaModal
        label={displayText(title)}
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
      </KitModal>
    </div>
  );
}

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

export function Caption({ text }: { text: string }): ReactNode {
  return <p className={styles.caption}>{displayText(text)}</p>;
}

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

export function SkeletonBlock({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  return <div className={styles.skeleton}>{children}</div>;
}
