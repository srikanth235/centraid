// THE PERMIT GATE — A FULL-STOP OVERLAY (the handoff's sanctioned divergence
// 1, registered for docs/design-divergences.md).
//
// Nothing else in this product blocks a screen to read one value. Two reasons
// it does here, and both are load-bearing:
//
//   1. The gate has to name the ITEM, the FIELD, the permit's LIFE and the
//      RECEIPT it writes — four lines a row cannot hold without becoming a
//      paragraph inside a list. Each of those lines is its own string in
//      `view-copy.ts`, drawn on its own row here, because the gate is a stack
//      of facts and not one sentence wearing four clauses.
//   2. A reveal is the one act in this product whose cost the member must
//      understand EVERY SINGLE TIME. There is no "trust this session" switch
//      here and there is not going to be one; a gate that could be dismissed
//      into the background would be that switch by another name.
//
// A REFUSAL IS RECEIPTED TOO, so the gate states the refusal rather than
// silently re-arming — and a rate limit says how long, because a member
// backing off with no number reads it as a broken app.
import { useState } from "react";
import type { FormEvent, ReactNode } from "react";

import { KitModal } from "../../_shared/KitModal.tsx";
import { displayText } from "../../_shared/untrusted.ts";
import {
  LOCK_PLACEHOLDER,
  PERMIT_CANCEL,
  PERMIT_CONFIRM,
  PERMIT_GATE_ASK,
  PERMIT_GATE_LIFE,
  PERMIT_GATE_RECEIPT,
  permitGateTitle,
} from "../view-copy.ts";

import styles from "./Rows.module.css";

export interface PermitGateProps {
  /** The item the permit would be minted against — named, so a member always
   *  knows which of their secrets they just paid for. */
  itemTitle: string;
  /** The field's own word — `Password`, `Security code`, `One-time code`. */
  fieldLabel: string;
  busy: boolean;
  /** The refusal, in the host's words, including the backoff sentence. */
  error: string;
  onConfirm: (secret: string) => void;
  onCancel: () => void;
}

export function PermitGate(props: PermitGateProps): ReactNode {
  const [secret, setSecret] = useState("");
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (props.busy || !secret) return;
    props.onConfirm(secret);
    setSecret("");
  };
  return (
    <div className={styles.overlay}>
      <form
        className={styles.panel}
        onSubmit={submit}
        aria-label={permitGateTitle(props.fieldLabel)}
      >
        <p className={styles.panelTitle}>{permitGateTitle(props.fieldLabel)}</p>
        <p className={styles.panelBody}>{displayText(props.itemTitle)}</p>
        <p className={styles.panelBody}>{PERMIT_GATE_ASK}</p>
        <p className={styles.panelBody}>{PERMIT_GATE_LIFE}</p>
        <p className={styles.panelBody}>{PERMIT_GATE_RECEIPT}</p>

        <input
          className={`kit-input ${styles.gateInput}`}
          type="password"
          autoComplete="current-password"
          placeholder={LOCK_PLACEHOLDER}
          aria-label={LOCK_PLACEHOLDER}
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
        />

        {props.error ? <p className={styles.gateError}>{props.error}</p> : null}

        <div className={styles.panelActs}>
          <button
            type="button"
            className="kit-btn quiet"
            onClick={props.onCancel}
          >
            {PERMIT_CANCEL}
          </button>
          <button
            type="submit"
            className="kit-btn primary"
            disabled={props.busy || secret.length === 0}
          >
            {PERMIT_CONFIRM}
          </button>
        </div>
      </form>
    </div>
  );
}

export interface ConfirmProps {
  title: string;
  body: string;
  /** The commit's word — `Trash`, `Ask the owner`. */
  label: string;
  /** Destructive is OUTLINED in `--net`, never filled. */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** The one confirm this wave draws: the trash, and the purge that parks. Same
 *  overlay geometry as the gate, because they interrupt for the same reason. */
export function Confirm(props: ConfirmProps): ReactNode {
  return (
    <div className={styles.overlay}>
      <KitModal layer="inline" className={styles.panel} label={props.title}>
        <p className={styles.panelTitle}>{props.title}</p>
        <p className={styles.panelBody}>{props.body}</p>
        <div className={styles.panelActs}>
          <button
            type="button"
            className="kit-btn quiet"
            onClick={props.onCancel}
          >
            {PERMIT_CANCEL}
          </button>
          <button
            type="button"
            className="kit-btn"
            {...(props.destructive ? { "data-net": "true" } : {})}
            onClick={props.onConfirm}
          >
            {props.label}
          </button>
        </div>
      </KitModal>
    </div>
  );
}
