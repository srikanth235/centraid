import type { ReactNode } from "react";

import {
  readPendingOverlay,
  pendingOverlayCopy,
} from "../../_shared/pending-overlay.ts";
import { displayText } from "../../_shared/untrusted.ts";
import { virtualItemAria } from "../../_shared/virtual-window.ts";
import { virtualBlockProps } from "../../_shared/VirtualWindow.tsx";
import { metaSentence, typeChip, verdictOf } from "../format.ts";
import type { LockerRow } from "../types.ts";
import type { RowPosition } from "./Windowed.tsx";

import styles from "./Rows.module.css";

export interface RowVerb {
  label: string;
  run: () => void;
}

export interface ItemRowProps {
  row: LockerRow;
  onOpen?: (itemId: string) => void;
  verb?: RowVerb;
  meta?: string;
  status?: { label: string; tone: "net" | "seam" } | null;
  position?: RowPosition;
}

export function ItemRow(props: ItemRowProps): ReactNode {
  const { position, row } = props;
  const pending = readPendingOverlay(row as unknown as Record<string, unknown>);
  const verdict = props.status === undefined ? verdictOf(row) : props.status;
  const meta = [metaSentence(row), props.meta].filter(Boolean).join("  ·  ");
  const body = (
    <>
      <span className={styles.title}>{displayText(row.title)}</span>
      <span className={styles.meta}>{meta}</span>
    </>
  );
  const Box = position ? "li" : "div";
  return (
    <Box
      className={styles.rowWrap}
      data-item-id={row.item_id}
      {...(pending ? { "data-pending": "true" } : {})}
      {...(position
        ? {
            ...virtualBlockProps(position.index),
            ...virtualItemAria(position.index, position.setSize),
          }
        : {})}
    >
      <div className={styles.row}>
        <span className={styles.chip} aria-hidden="true">
          {typeChip(row.type)}
        </span>
        {props.onOpen ? (
          <button
            type="button"
            className={styles.open}
            onClick={() => props.onOpen?.(row.item_id)}
          >
            {body}
          </button>
        ) : (
          <span className={styles.open}>{body}</span>
        )}
        {row.favorite ? (
          <>
            <span className={styles.star} aria-hidden="true">
              ★
            </span>
            <span className="kit-sr-only">Starred</span>
          </>
        ) : null}
        {verdict ? (
          <span className={styles.status} data-tone={verdict.tone}>
            {verdict.label}
          </span>
        ) : null}
        {props.verb ? (
          <button
            type="button"
            className="kit-btn quiet"
            onClick={() => props.verb?.run()}
          >
            {props.verb.label}
          </button>
        ) : null}
      </div>
      {pending ? (
        <p className={`${styles.meta} ${styles.num}`}>
          {pendingOverlayCopy(pending)}
        </p>
      ) : null}
    </Box>
  );
}

export interface SectionProps {
  label: string;
  meta?: string;
  verb?: RowVerb;
  empty?: ReactNode;
  children?: ReactNode;
  loaded?: boolean;
  count: number;
}

export function Section(props: SectionProps): ReactNode {
  const showsEmpty = props.loaded !== false && props.count === 0;
  return (
    <section className={styles.section}>
      <header className={styles.sectionHead}>
        <span className={styles.sectionLabel}>{props.label}</span>
        {props.meta ? (
          <span className={`${styles.sectionMeta} ${styles.num}`}>
            {props.meta}
          </span>
        ) : null}
        {props.verb ? (
          <button
            type="button"
            className="kit-plain-btn kit-small"
            onClick={() => props.verb?.run()}
          >
            {props.verb.label}
          </button>
        ) : null}
      </header>
      {showsEmpty ? props.empty : props.children}
    </section>
  );
}
