import type { ChangeEvent, Dispatch, JSX, RefObject } from "react";

import { cx } from "../../ui/cx.js";
import { buildTestInput } from "./connectFlow-core.js";
import type { ConnectFlowEvent, ConnectFlowState } from "./connectFlow-core.js";

import controlsCss from "../../styles/controls.module.css";
import buttonCss from "../../ui/Button.module.css";
import styles from "./ConnectFlow.module.css";

// The 'details' step's panel — split out of ConnectFlow.tsx (issue #382)
// purely to keep that file under the repo's file-size cap; it is pure
// presentation over `connectFlow-core.ts`'s state/reducer, no logic lives
// here that isn't also in ConnectFlow.tsx's effects. Its SSH sibling was
// deleted with the SSH method (issue #603).

type Field = "ticket" | "label";

function fieldSetter(
  dispatch: Dispatch<ConnectFlowEvent>,
  field: Field
): (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void {
  return (e) => dispatch({ field, type: "setField", value: e.target.value });
}

export function GatewayDetailsStep({
  state,
  dispatch,
  ticketRef,
  canGoBack = true,
}: {
  state: ConnectFlowState;
  dispatch: Dispatch<ConnectFlowEvent>;
  ticketRef: RefObject<HTMLTextAreaElement | null>;
  /** False when the caller forced a single method: "back" would land on a
   *  chooser with one option, which is where onboarding's first screen sits.
   *  The host's own escape (`onCancel` → "Start over") is the way out. */
  canGoBack?: boolean;
}): JSX.Element {
  const setField = (field: Field) => fieldSetter(dispatch, field);
  return (
    <div className={styles.panel}>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Pairing ticket</span>
        <textarea
          ref={ticketRef}
          className={styles.textarea}
          placeholder="Paste the code from centraid-gateway pair --vault <name>"
          rows={3}
          spellCheck={false}
          value={state.ticket}
          onChange={setField("ticket")}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>
          Device name<span className={styles.fieldOptional}>optional</span>
        </span>
        <input
          className={styles.input}
          type="text"
          placeholder="e.g. Chrome on the work laptop"
          value={state.label}
          onChange={setField("label")}
        />
      </label>
      <label className={styles.rememberRow}>
        <input
          type="checkbox"
          aria-label="Keep an offline copy"
          checked={state.rememberDevice}
          onChange={(event) =>
            dispatch({ type: "setRememberDevice", value: event.target.checked })
          }
        />
        <span>
          <strong>Keep an offline copy</strong>
          <small>
            An encrypted replica, queued changes, and cached previews stay on
            this device. Either way it stays paired until you forget it.
          </small>
        </span>
      </label>
      <div className={styles.foot}>
        {canGoBack ? (
          <button
            type="button"
            className={controlsCss.chip}
            onClick={() => dispatch({ type: "back" })}
          >
            Back
          </button>
        ) : null}
        <span className={styles.spacer} />
        <button
          type="button"
          className={cx(buttonCss.btn, buttonCss.primary, buttonCss.sm)}
          disabled={!buildTestInput(state)}
          onClick={() => dispatch({ type: "startTest" })}
        >
          Continue
        </button>
      </div>
    </div>
  );
}
