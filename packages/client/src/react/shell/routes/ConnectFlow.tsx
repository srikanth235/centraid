import type { IconName } from "@centraid/design-tokens";
import { tileFinish } from "@centraid/design-tokens";
import { type JSX, useEffect, useReducer, useRef } from "react";

import { cx } from "../../ui/cx.js";
import Icon from "../../ui/Icon.js";
import {
  buildTestInput,
  connectFlowReducer,
  createInitialConnectFlowState,
  type ConnectFlowResult,
  type ConnectMethod,
} from "./connectFlow-core.js";
import { GatewayDetailsStep } from "./ConnectFlowDetailsStep.js";
import {
  commitConnectFlow,
  loadLocalVaults,
  runConnectivityTest,
} from "./connectFlowIO.js";
import { VaultStep } from "./ConnectFlowVaultStep.js";
import HandshakeLadder, { reportSummaryText } from "./HandshakeLadder.js";
import { PROFILE_COLORS } from "./SpaceModal.js";

import a11y from "../../styles/a11y.module.css";
import controlsCss from "../../styles/controls.module.css";
import buttonCss from "../../ui/Button.module.css";
import styles from "./ConnectFlow.module.css";

// The shared connect wizard (issue #382) — two top-level methods (This Mac /
// Existing gateway), a connectivity-test "handshake ladder"
// (HandshakeLadder.tsx), then a vault pick/create step, then commit. Used
// embedded in onboarding's ticket path AND wrapped in a modal for the
// switcher's "Add gateway" action (see ConnectFlowModal.tsx). All the state
// transitions live in the pure `connectFlow-core.ts`; this component only
// dispatches events and runs the IO (`connectFlowIO.ts`) the transitions ask
// for.

export interface ConnectFlowProps {
  /** Only the commit button's copy ("Enter Centraid" vs "Connect") — the
   *  steps themselves are identical. First run no longer auto-commits a local
   *  connect (issue #603): a fresh gateway founds two vaults, so "which one"
   *  is a real question and the desktop chooser answers it before we get
   *  here. */
  context: "onboarding" | "switcher";
  /** Method cards to offer. Defaults to both; the switcher's "Add gateway"
   *  passes `['gateway']` — 'local' is always already registered there, so
   *  re-offering it wouldn't add a connection. */
  methods?: readonly ConnectMethod[];
  /** Skip the method grid and open straight into this method's first step —
   *  for hosts that already made the choice (issue #603 first run). */
  initialMethod?: ConnectMethod;
  onDone: (result: ConnectFlowResult) => void;
  /** Omit to hide the "Start over" affordance (the onboarding host renders
   *  its own back-to-identity step instead). */
  onCancel?: () => void;
}

const METHOD_CARDS: ReadonlyArray<{
  method: ConnectMethod;
  icon: IconName;
  title: string;
  desc: string;
  color: string;
}> = [
  {
    color: PROFILE_COLORS[0]!,
    desc: "Everything stays here — nothing to configure.",
    icon: "Monitor",
    method: "local",
    title: "This Mac",
  },
  {
    color: PROFILE_COLORS[3]!,
    desc: "Paste or scan a pair ticket.",
    icon: "Wifi",
    method: "gateway",
    title: "Existing gateway",
  },
];

const DEFAULT_METHODS: readonly ConnectMethod[] = ["local", "gateway"];

export default function ConnectFlow({
  context,
  methods = DEFAULT_METHODS,
  initialMethod,
  onDone,
  onCancel,
}: ConnectFlowProps): JSX.Element {
  const [state, dispatch] = useReducer(
    connectFlowReducer,
    initialMethod ?? null,
    createInitialConnectFlowState
  );
  const ticketRef = useRef<HTMLTextAreaElement>(null);

  // Run the connectivity test whenever `startTest` puts us in `testing`.
  useEffect(() => {
    if (state.step !== "test" || !state.testing) return;
    let alive = true;
    const input = buildTestInput(state);
    if (!input) {
      dispatch({
        report: { error: "invalid_input", ok: false, stages: [] },
        type: "testSettled",
      });
      return;
    }
    void runConnectivityTest(input).then((report) => {
      if (alive) dispatch({ report, type: "testSettled" });
    });
    return () => {
      alive = false;
    };
  }, [state.step, state.testing]);

  // "This Mac" has no test step — load its existing vaults straight into
  // the same `report.vaults` shape the vault step already knows how to
  // render (method-agnostic rendering, one code path).
  useEffect(() => {
    if (state.method !== "local" || state.step !== "vault" || state.report)
      return;
    let alive = true;
    void loadLocalVaults().then((result) => {
      if (alive) dispatch({ type: "localVaultsLoaded", result });
    });
    return () => {
      alive = false;
    };
  }, [state.method, state.step, state.report]);

  // Run the commit whenever a `commit` dispatch lands us in `committing`.
  useEffect(() => {
    if (state.step !== "committing") return;
    let alive = true;
    void commitConnectFlow(state).then(
      (result) => {
        if (alive) dispatch({ result, type: "commitSettled" });
      },
      (err: unknown) => {
        if (alive)
          dispatch({
            error: err instanceof Error ? err.message : String(err),
            type: "commitFailed",
          });
      }
    );
    return () => {
      alive = false;
    };
  }, [state.step]);

  useEffect(() => {
    if (state.step === "done" && state.result) onDone(state.result);
  }, [state.step, state.result]);

  useEffect(() => {
    if (state.step === "details" && state.method === "gateway") {
      const id = requestAnimationFrame(() => ticketRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [state.step, state.method]);

  return (
    <div className={styles.flow} data-step={state.step}>
      {state.step === "method" ? (
        <div
          className={styles.methodGrid}
          role="radiogroup"
          aria-label="Where does your data live?"
        >
          {METHOD_CARDS.filter((c) => methods.includes(c.method)).map(
            (card) => {
              const finish = tileFinish(card.color, "gradient");
              return (
                <label key={card.method} className={styles.methodCard}>
                  <input
                    type="radio"
                    className={a11y.srControl}
                    name="connect-flow-method"
                    checked={state.method === card.method}
                    onChange={() =>
                      dispatch({ method: card.method, type: "selectMethod" })
                    }
                  />
                  <span
                    className={styles.methodIcon}
                    style={{
                      background: finish.background,
                      boxShadow: finish.boxShadow,
                      color: finish.glyphColor,
                    }}
                  >
                    <Icon name={card.icon} size={20} strokeWidth={1.8} />
                  </span>
                  <span className={styles.methodTitle}>{card.title}</span>
                  <span className={styles.methodDesc}>{card.desc}</span>
                </label>
              );
            }
          )}
        </div>
      ) : null}

      {state.step === "details" && state.method === "gateway" ? (
        <GatewayDetailsStep
          state={state}
          dispatch={dispatch}
          ticketRef={ticketRef}
        />
      ) : null}

      {state.step === "test" ? (
        <div className={styles.panel}>
          <HandshakeLadder
            stages={state.report?.stages ?? []}
            pending={state.testing}
          />
          {state.report ? (
            <div className={styles.testSummary} data-ok={state.report.ok}>
              {reportSummaryText(state.report)}
            </div>
          ) : null}
          <div className={styles.foot}>
            <button
              type="button"
              className={controlsCss.chip}
              onClick={() => dispatch({ type: "back" })}
            >
              Back
            </button>
            <span className={styles.spacer} />
            {state.report && !state.report.ok ? (
              <button
                type="button"
                className={cx(buttonCss.btn, buttonCss.primary, buttonCss.sm)}
                onClick={() => dispatch({ type: "startTest" })}
              >
                Retry
              </button>
            ) : (
              <button
                type="button"
                className={cx(buttonCss.btn, buttonCss.primary, buttonCss.sm)}
                disabled={!state.report || state.testing}
                onClick={() => dispatch({ type: "continueToVault" })}
              >
                Continue
              </button>
            )}
          </div>
        </div>
      ) : null}

      {state.step === "vault" ? (
        <VaultStep state={state} dispatch={dispatch} context={context} />
      ) : null}

      {state.step === "committing" ? (
        <div className={styles.panel} data-align="center">
          <span className={styles.spinner} data-spin="true">
            <Icon name="Loader" size={22} strokeWidth={2} />
          </span>
          <p className={styles.centerText}>Connecting…</p>
        </div>
      ) : null}

      {state.step === "error" ? (
        <div className={styles.panel} data-align="center">
          <div className={styles.errorBanner} role="alert">
            {state.commitError}
          </div>
          <div className={styles.foot}>
            <button
              type="button"
              className={controlsCss.chip}
              onClick={() => dispatch({ type: "back" })}
            >
              Back
            </button>
            <span className={styles.spacer} />
            <button
              type="button"
              className={cx(buttonCss.btn, buttonCss.primary, buttonCss.sm)}
              onClick={() => dispatch({ type: "commit" })}
            >
              Retry
            </button>
          </div>
        </div>
      ) : null}

      {onCancel && state.step !== "committing" && state.step !== "done" ? (
        <button type="button" className={styles.startOver} onClick={onCancel}>
          Start over
        </button>
      ) : null}
    </div>
  );
}
