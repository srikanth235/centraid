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
  itemTitle: string;
  fieldLabel: string;
  busy: boolean;
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
  label: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

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
