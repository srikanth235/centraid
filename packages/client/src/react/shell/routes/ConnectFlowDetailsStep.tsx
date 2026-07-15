import type { ChangeEvent, Dispatch, JSX, RefObject } from 'react';
import { cx } from '../../ui/cx.js';
import buttonCss from '../../ui/Button.module.css';
import controlsCss from '../../styles/controls.module.css';
import {
  buildTestInput,
  isTokenMode,
  type ConnectFlowEvent,
  type ConnectFlowState,
} from './connectFlow-core.js';
import styles from './ConnectFlow.module.css';

// The 'details' step's two per-method panels — split out of ConnectFlow.tsx
// (issue #382) purely to keep that file under the repo's file-size cap; both
// panels are pure presentation over `connectFlow-core.ts`'s state/reducer,
// no logic lives here that isn't also in ConnectFlow.tsx's effects.

type Field = 'ticket' | 'label' | 'url' | 'token' | 'sshDestination' | 'sshDataDir';

function fieldSetter(
  dispatch: Dispatch<ConnectFlowEvent>,
  field: Field,
): (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void {
  return (e) => dispatch({ field, type: 'setField', value: e.target.value });
}

export function GatewayDetailsStep({
  state,
  dispatch,
  ticketRef,
}: {
  state: ConnectFlowState;
  dispatch: Dispatch<ConnectFlowEvent>;
  ticketRef: RefObject<HTMLTextAreaElement | null>;
}): JSX.Element {
  const setField = (field: Field) => fieldSetter(dispatch, field);
  return (
    <div className={styles.panel}>
      {!isTokenMode(state) ? (
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Pairing ticket</span>
          <textarea
            ref={ticketRef}
            className={styles.textarea}
            placeholder="Paste the code from centraid-gateway pair --vault <name>"
            rows={3}
            spellCheck={false}
            value={state.ticket}
            onChange={setField('ticket')}
          />
        </label>
      ) : null}
      <label className={styles.field}>
        <span className={styles.fieldLabel}>
          Label<span className={styles.fieldOptional}>optional</span>
        </span>
        <input
          className={styles.input}
          type="text"
          placeholder="e.g. Home server"
          value={state.label}
          onChange={setField('label')}
        />
      </label>
      <details
        className={styles.advanced}
        open={state.advancedOpen}
        onToggle={(e) =>
          dispatch({ open: (e.target as HTMLDetailsElement).open, type: 'setAdvancedOpen' })
        }
      >
        <summary className={styles.advancedSummary}>Connect by URL</summary>
        <div className={styles.advancedBody}>
          <div className={styles.hint}>
            For landlord/admin setups reachable by a direct URL (Tailscale, a reverse proxy, …)
            instead of the default iroh discovery.
          </div>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Gateway URL</span>
            <input
              className={styles.input}
              type="text"
              placeholder="https://gateway.example.com"
              autoComplete="off"
              value={state.url}
              onChange={setField('url')}
            />
          </label>
          <div className={styles.modeToggle} role="radiogroup" aria-label="Credential">
            <button
              type="button"
              className={cx(controlsCss.chip, styles.modeBtn)}
              role="radio"
              aria-checked={state.credMode === 'ticket'}
              data-selected={state.credMode === 'ticket'}
              onClick={() => dispatch({ mode: 'ticket', type: 'setCredMode' })}
            >
              Pairing ticket
            </button>
            <button
              type="button"
              className={cx(controlsCss.chip, styles.modeBtn)}
              role="radio"
              aria-checked={state.credMode === 'token'}
              data-selected={state.credMode === 'token'}
              onClick={() => dispatch({ mode: 'token', type: 'setCredMode' })}
            >
              Bearer token
            </button>
          </div>
          {isTokenMode(state) ? (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Bearer token</span>
              <input
                className={styles.input}
                type="password"
                autoComplete="off"
                placeholder="Admin-issued token"
                value={state.token}
                onChange={setField('token')}
              />
            </label>
          ) : null}
        </div>
      </details>
      {!isTokenMode(state) ? (
        <label className={styles.rememberRow}>
          <input
            type="checkbox"
            aria-label="Remember this device"
            checked={state.rememberDevice}
            onChange={(event) =>
              dispatch({ type: 'setRememberDevice', value: event.target.checked })
            }
          />
          <span>
            <strong>Remember this device</strong>
            <small>Keep an encrypted offline replica, queued changes, and cached previews.</small>
          </span>
        </label>
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
        <button
          type="button"
          className={cx(buttonCss.btn, buttonCss.primary, buttonCss.sm)}
          disabled={!buildTestInput(state)}
          onClick={() => dispatch({ type: 'startTest' })}
        >
          Continue
        </button>
      </div>
    </div>
  );
}

export function SshDetailsStep({
  state,
  dispatch,
  sshRef,
}: {
  state: ConnectFlowState;
  dispatch: Dispatch<ConnectFlowEvent>;
  sshRef: RefObject<HTMLInputElement | null>;
}): JSX.Element {
  const setField = (field: Field) => fieldSetter(dispatch, field);
  return (
    <div className={styles.panel}>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Destination</span>
        <input
          ref={sshRef}
          className={styles.input}
          type="text"
          placeholder="user@host"
          autoComplete="off"
          spellCheck={false}
          value={state.sshDestination}
          onChange={setField('sshDestination')}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>
          Remote data directory<span className={styles.fieldOptional}>optional</span>
        </span>
        <input
          className={styles.input}
          type="text"
          placeholder="Defaults to the host's own config"
          autoComplete="off"
          spellCheck={false}
          value={state.sshDataDir}
          onChange={setField('sshDataDir')}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>
          Label<span className={styles.fieldOptional}>optional</span>
        </span>
        <input
          className={styles.input}
          type="text"
          placeholder="e.g. Home server"
          value={state.label}
          onChange={setField('label')}
        />
      </label>
      <div className={styles.hint}>
        The desktop drives the <code>centraid-gateway</code> CLI on that host over{' '}
        <code>ssh -o BatchMode=yes</code> — make sure key-based auth is already set up.
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
          disabled={!buildTestInput(state)}
          onClick={() => dispatch({ type: 'startTest' })}
        >
          Continue
        </button>
      </div>
    </div>
  );
}
