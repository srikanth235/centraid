import type { ChangeEvent, Dispatch, JSX, RefObject } from "react";

import { cx } from "../../ui/cx.js";
import { buildTestInput } from "./connectFlow-core.js";
import type { ConnectFlowEvent, ConnectFlowState } from "./connectFlow-core.js";

import controlsCss from "../../styles/controls.module.css";
import buttonCss from "../../ui/Button.module.css";
import styles from "./ConnectFlow.module.css";

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
          placeholder="centraid-gateway pair --vault <name>"
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
      {/* No "Keep an offline copy" question here any more. It defaulted off,
          was asked of someone who had not yet seen the product, and its answer
          decided whether the app worked offline. It is ON by default
          (`connectFlow-core.ts`) and reversible in Settings → This device. */}
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
