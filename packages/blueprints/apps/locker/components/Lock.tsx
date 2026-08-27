// THE TWO GATES (README-Locker §1, §6; FLOWS.md "First run", "Unlock").
//
// ONE FIELD, ONE VERB, AND A SENTENCE ABOUT WHAT A SESSION IS. Both screens
// are the same shape because they are the same question asked at two moments,
// and both state the boundary in words rather than implying it with a lock
// icon (§7: never a lock icon standing in for a sentence).
//
// FIRST RUN says the twelve-character rule and the fact that this passphrase
// cannot be revoked — before the field, not after a refusal. LOCK says what
// ends a session, and carries the facts table underneath, because "why did it
// close on me" is a question a member asks once and should never have to ask
// twice.
//
// NOTHING IS BROWSABLE BEHIND EITHER. `shelves.suppressesNavigation` withdraws
// the rail, the band and every list; this screen is what stands in their place.
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
  /** First run, or a lock over a passphrase that already exists. */
  mode: "setup" | "lock";
  /** An authentication request is in flight — the commit says so by being
   *  unavailable, never by a spinner. */
  busy: boolean;
  /** The host's refusal, in its own words. Includes the backoff sentence. */
  error: string;
  onSubmit: (secret: string) => void;
}

export function Lock(props: LockProps): ReactNode {
  const setup = props.mode === "setup";
  const [secret, setSecret] = useState("");
  // The twelve-character rule is enforced HERE, in front of the member, rather
  // than by a round trip that comes back refused: the rule is stated above the
  // field, so the field may as well hold to it.
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
