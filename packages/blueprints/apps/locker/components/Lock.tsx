import { useState } from "react";
import type { FormEvent, ReactNode } from "react";

import {
  CREATE_PASSPHRASE,
  LOCK_BODY,
  LOCK_FACTS,
  LOCK_PLACEHOLDER,
  PASSPHRASE_MINIMUM,
  PASSPHRASE_TOO_SHORT,
  SETUP_BODY,
  SETUP_PLACEHOLDER,
  UNLOCK,
} from "../view-copy.ts";

import styles from "./Rows.module.css";

export interface LockProps {
  mode: "setup" | "lock";
  busy: boolean;
  error: string;
  onSubmit: (secret: string) => void;
}

export function Lock(props: LockProps): ReactNode {
  const setup = props.mode === "setup";
  const [secret, setSecret] = useState("");
  const tooShort =
    setup && secret.length > 0 && secret.length < PASSPHRASE_MINIMUM;
  const ready =
    !props.busy &&
    (setup ? secret.length >= PASSPHRASE_MINIMUM : secret.length > 0);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!ready) return;
    props.onSubmit(secret);
    setSecret("");
  };

  return (
    <form className={styles.gate} onSubmit={submit}>
      <p className={styles.gateTitle}>
        {setup ? "Choose a passphrase" : "Locked"}
      </p>
      <p className={styles.gateBody}>{setup ? SETUP_BODY : LOCK_BODY}</p>

      <div className={styles.gateField}>
        <input
          className={`kit-input ${styles.gateInput}`}
          type="password"
          autoComplete={setup ? "new-password" : "current-password"}
          placeholder={setup ? SETUP_PLACEHOLDER : LOCK_PLACEHOLDER}
          aria-label={setup ? SETUP_PLACEHOLDER : LOCK_PLACEHOLDER}
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
        />
      </div>

      {tooShort ? (
        <p className={styles.gateError}>{PASSPHRASE_TOO_SHORT}</p>
      ) : null}
      {props.error ? <p className={styles.gateError}>{props.error}</p> : null}

      <div className={styles.gateActs}>
        <button type="submit" className="kit-btn primary" disabled={!ready}>
          {setup ? CREATE_PASSPHRASE : UNLOCK}
        </button>
      </div>

      {setup ? null : (
        <dl className={styles.facts}>
          {LOCK_FACTS.map(([key, value]) => (
            <div key={key} className={styles.fact}>
              <dt className={styles.factKey}>{key}</dt>
              <dd className={styles.factValue}>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </form>
  );
}
