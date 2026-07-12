import { type JSX, type KeyboardEvent, useEffect, useReducer, useRef } from 'react';
import type { IconName } from '@centraid/design-tokens';
import { tileFinish } from '@centraid/design-tokens';
import Icon from '../../ui/Icon.js';
import { cx } from '../../ui/cx.js';
import buttonCss from '../../ui/Button.module.css';
import controlsCss from '../../styles/controls.module.css';
import { PROFILE_COLORS } from './SpaceModal.js';
import HandshakeLadder, { reportSummaryText } from './HandshakeLadder.js';
import { GatewayDetailsStep, SshDetailsStep } from './ConnectFlowDetailsStep.js';
import { VaultStep } from './ConnectFlowVaultStep.js';
import { commitConnectFlow, loadLocalVaults, runConnectivityTest } from './connectFlowIO.js';
import {
  buildTestInput,
  connectFlowReducer,
  createInitialConnectFlowState,
  type ConnectFlowResult,
  type ConnectMethod,
  type VaultChoice,
} from './connectFlow-core.js';
import styles from './ConnectFlow.module.css';

// The shared connect wizard (issue #382) — three top-level methods (This
// Mac / Existing gateway / Over SSH), a connectivity-test "handshake ladder"
// (HandshakeLadder.tsx), then a vault pick/create step, then commit. Used
// embedded in onboarding step 2 AND wrapped in a modal for the switcher's
// "Add gateway" action (see ConnectFlowModal.tsx). All the state transitions
// live in the pure `connectFlow-core.ts`; this component only dispatches
// events and runs the IO (`connectFlowIO.ts`) the transitions ask for.

export interface ConnectFlowProps {
  /**
   * 'onboarding': choosing "This Mac" with 0-or-1 existing local vault
   * completes immediately (no extra click) — the design doc's "'This Mac'
   * completes immediately (existing default vault)" requirement, since a
   * fresh install always has exactly one. 'switcher': the vault step always
   * shows, since a returning user may have several local spaces to choose
   * from or want to explicitly create one.
   */
  context: 'onboarding' | 'switcher';
  /** Method cards to offer. Defaults to all three; the switcher's "Add
   *  gateway" passes `['gateway', 'ssh']` — 'local' is always already
   *  registered there, so re-offering it wouldn't add a connection. */
  methods?: readonly ConnectMethod[];
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
    desc: 'Everything stays here — nothing to configure.',
    icon: 'Monitor',
    method: 'local',
    title: 'This Mac',
  },
  {
    color: PROFILE_COLORS[3]!,
    desc: 'Paste a pairing ticket, or connect by URL.',
    icon: 'Wifi',
    method: 'gateway',
    title: 'Existing gateway',
  },
  {
    color: PROFILE_COLORS[7]!,
    desc: 'Drive a centraid-gateway host over SSH.',
    icon: 'Command',
    method: 'ssh',
    title: 'Over SSH',
  },
];

function radioKeyNav(e: KeyboardEvent<HTMLElement>): void {
  if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return;
  const group = (e.currentTarget.closest('[role="radiogroup"]') ??
    e.currentTarget.parentElement) as HTMLElement | null;
  const items = Array.from(group?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? []);
  const idx = items.indexOf(e.currentTarget as HTMLButtonElement);
  if (idx < 0 || items.length === 0) return;
  e.preventDefault();
  const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
  items[(idx + dir + items.length) % items.length]?.focus();
}

export default function ConnectFlow({
  context,
  methods = ['local', 'gateway', 'ssh'],
  onDone,
  onCancel,
}: ConnectFlowProps): JSX.Element {
  const [state, dispatch] = useReducer(connectFlowReducer, null, createInitialConnectFlowState);
  const ticketRef = useRef<HTMLTextAreaElement>(null);
  const sshRef = useRef<HTMLInputElement>(null);

  // Run the connectivity test whenever `startTest` puts us in `testing`.
  useEffect(() => {
    if (state.step !== 'test' || !state.testing) return;
    let alive = true;
    const input = buildTestInput(state);
    if (!input) {
      dispatch({ report: { error: 'invalid_input', ok: false, stages: [] }, type: 'testSettled' });
      return;
    }
    void runConnectivityTest(input).then((report) => {
      if (alive) dispatch({ report, type: 'testSettled' });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#382) re-run keyed on entering `testing`, `state` read at effect time is current
  }, [state.step, state.testing]);

  // "This Mac" has no test step — load its existing vaults straight into
  // the same `report.vaults` shape the vault step already knows how to
  // render (method-agnostic rendering, one code path).
  useEffect(() => {
    if (state.method !== 'local' || state.step !== 'vault' || state.report) return;
    let alive = true;
    void loadLocalVaults().then((vaults) => {
      if (alive) dispatch({ type: 'localVaultsLoaded', vaults: vaults ?? [] });
    });
    return () => {
      alive = false;
    };
  }, [state.method, state.step, state.report]);

  // Onboarding's "completes immediately" contract: a fresh install has
  // exactly one (or zero) local vault, so once it's loaded, pick it (or
  // "create default") and commit without waiting for a click.
  useEffect(() => {
    if (context !== 'onboarding' || state.method !== 'local' || state.step !== 'vault') return;
    if (!state.report || state.vaultChoice) return;
    const vaults = state.report.vaults ?? [];
    if (vaults.length > 1) return;
    const choice: VaultChoice =
      vaults.length === 1 ? { kind: 'existing', vaultId: vaults[0]!.vaultId } : { kind: 'create' };
    dispatch({ choice, type: 'selectVault' });
    dispatch({ type: 'commit' });
  }, [context, state.method, state.step, state.report, state.vaultChoice]);

  // Run the commit whenever a `commit` dispatch lands us in `committing`.
  useEffect(() => {
    if (state.step !== 'committing') return;
    let alive = true;
    void commitConnectFlow(state).then(
      (result) => {
        if (alive) dispatch({ result, type: 'commitSettled' });
      },
      (err: unknown) => {
        if (alive)
          dispatch({
            error: err instanceof Error ? err.message : String(err),
            type: 'commitFailed',
          });
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#382) re-run keyed on entering `committing`, `state` read at effect time is current
  }, [state.step]);

  useEffect(() => {
    if (state.step === 'done' && state.result) onDone(state.result);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#382) fire once per successful commit
  }, [state.step, state.result]);

  useEffect(() => {
    if (state.step === 'details' && state.method === 'gateway') {
      const id = requestAnimationFrame(() => ticketRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
    if (state.step === 'details' && state.method === 'ssh') {
      const id = requestAnimationFrame(() => sshRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [state.step, state.method]);

  return (
    <div className={styles.flow} data-step={state.step}>
      {state.step === 'method' ? (
        <div
          className={styles.methodGrid}
          role="radiogroup"
          aria-label="Where does your data live?"
        >
          {METHOD_CARDS.filter((c) => methods.includes(c.method)).map((card) => {
            const finish = tileFinish(card.color, 'gradient');
            return (
              <button
                key={card.method}
                type="button"
                role="radio"
                aria-checked={state.method === card.method}
                className={styles.methodCard}
                onClick={() => dispatch({ method: card.method, type: 'selectMethod' })}
                onKeyDown={radioKeyNav}
              >
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
              </button>
            );
          })}
        </div>
      ) : null}

      {state.step === 'details' && state.method === 'gateway' ? (
        <GatewayDetailsStep state={state} dispatch={dispatch} ticketRef={ticketRef} />
      ) : null}

      {state.step === 'details' && state.method === 'ssh' ? (
        <SshDetailsStep state={state} dispatch={dispatch} sshRef={sshRef} />
      ) : null}

      {state.step === 'test' ? (
        <div className={styles.panel}>
          <HandshakeLadder stages={state.report?.stages ?? []} pending={state.testing} />
          {state.report ? (
            <div className={styles.testSummary} data-ok={state.report.ok}>
              {reportSummaryText(state.report)}
            </div>
          ) : null}
          <div className={styles.foot}>
            <button
              type="button"
              className={controlsCss.chip}
              onClick={() => dispatch({ type: 'back' })}
            >
              Back
            </button>
            <span className={styles.spacer} />
            {state.report && !state.report.ok ? (
              <button
                type="button"
                className={cx(buttonCss.btn, buttonCss.primary, buttonCss.sm)}
                onClick={() => dispatch({ type: 'startTest' })}
              >
                Retry
              </button>
            ) : (
              <button
                type="button"
                className={cx(buttonCss.btn, buttonCss.primary, buttonCss.sm)}
                disabled={!state.report || state.testing}
                onClick={() => dispatch({ type: 'continueToVault' })}
              >
                Continue
              </button>
            )}
          </div>
        </div>
      ) : null}

      {state.step === 'vault' ? (
        <VaultStep state={state} dispatch={dispatch} context={context} />
      ) : null}

      {state.step === 'committing' ? (
        <div className={styles.panel} data-align="center">
          <span className={styles.spinner} data-spin="true">
            <Icon name="Loader" size={22} strokeWidth={2} />
          </span>
          <p className={styles.centerText}>Connecting…</p>
        </div>
      ) : null}

      {state.step === 'error' ? (
        <div className={styles.panel} data-align="center">
          <div className={styles.errorBanner} role="alert">
            {state.commitError}
          </div>
          <div className={styles.foot}>
            <button
              type="button"
              className={controlsCss.chip}
              onClick={() => dispatch({ type: 'back' })}
            >
              Back
            </button>
            <span className={styles.spacer} />
            <button
              type="button"
              className={cx(buttonCss.btn, buttonCss.primary, buttonCss.sm)}
              onClick={() => dispatch({ type: 'commit' })}
            >
              Retry
            </button>
          </div>
        </div>
      ) : null}

      {onCancel && state.step !== 'committing' && state.step !== 'done' ? (
        <button type="button" className={styles.startOver} onClick={onCancel}>
          Start over
        </button>
      ) : null}
    </div>
  );
}
