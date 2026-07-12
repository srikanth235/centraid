import { useEffect, useRef, useState, type JSX } from 'react';
import Icon from '../../ui/Icon.js';
import { cx } from '../../ui/cx.js';
import buttonCss from '../../ui/Button.module.css';
import controlsCss from '../../styles/controls.module.css';
import styles from './GatewayPairingForm.module.css';
import { connectGateway, type GatewayConnectSuccess } from './gatewayModals.js';

// The ticket-paste form for issue #376's "Add gateway" flow — shared by the
// Settings → Connections modal (GatewayModal.tsx) and the onboarding gateway
// step (OnboardingScreen.tsx). Presentation + the connecting/error lifecycle
// live here; the actual IPC calls are `connectGateway` (gatewayModals.ts) so
// this stays the one place that lifecycle is written. Callers only decide
// what happens AFTER a successful connect (close+toast+refresh in Settings,
// finish onboarding on the welcome screen).

export interface GatewayPairingFormProps {
  /** Fired once, after `connectGateway` resolves `ok:true`. */
  onConnected: (result: GatewayConnectSuccess) => void;
  /** Omit to hide the Cancel button (the onboarding step has its own
   *  "keep it local" toggle instead of a Cancel). */
  onCancel?: () => void;
  cancelLabel?: string;
  connectLabel?: string;
  autoFocus?: boolean;
}

type AdvancedMode = 'ticket' | 'token';

export default function GatewayPairingForm({
  onConnected,
  onCancel,
  cancelLabel = 'Cancel',
  connectLabel = 'Connect',
  autoFocus = true,
}: GatewayPairingFormProps): JSX.Element {
  const [ticket, setTicket] = useState('');
  const [label, setLabel] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedMode, setAdvancedMode] = useState<AdvancedMode>('ticket');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ticketRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!autoFocus) return;
    const id = requestAnimationFrame(() => ticketRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [autoFocus]);

  const usingToken = advancedOpen && advancedMode === 'token';
  const ready = usingToken
    ? url.trim().length > 0 && token.trim().length > 0
    : ticket.trim().length > 0 && (!advancedOpen || url.trim().length > 0);

  const submit = (): void => {
    if (!ready || pending) return;
    setPending(true);
    setError(null);
    const trimmedLabel = label.trim();
    const input = usingToken
      ? {
          kind: 'token' as const,
          label: trimmedLabel || url.trim(),
          token: token.trim(),
          url: url.trim(),
        }
      : advancedOpen
        ? {
            kind: 'ticket-url' as const,
            label: trimmedLabel || undefined,
            ticket: ticket.trim(),
            url: url.trim(),
          }
        : { kind: 'ticket' as const, label: trimmedLabel || undefined, ticket: ticket.trim() };
    void connectGateway(input).then((result) => {
      setPending(false);
      if (result.ok) {
        onConnected(result);
        return;
      }
      setError(result.message);
    });
  };

  return (
    <div className={styles.form}>
      {!usingToken ? (
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Pairing ticket</span>
          <textarea
            ref={ticketRef}
            className={styles.textarea}
            placeholder="Paste the code from centraid-gateway pair --vault <name>"
            rows={3}
            spellCheck={false}
            disabled={pending}
            value={ticket}
            onChange={(e) => setTicket(e.target.value)}
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
          disabled={pending}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>

      <details
        className={styles.advanced}
        open={advancedOpen}
        onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}
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
              disabled={pending}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <div className={styles.modeToggle} role="radiogroup" aria-label="Credential">
            <button
              type="button"
              className={cx(controlsCss.chip, styles.modeBtn)}
              role="radio"
              aria-checked={advancedMode === 'ticket'}
              data-selected={advancedMode === 'ticket'}
              disabled={pending}
              onClick={() => setAdvancedMode('ticket')}
            >
              Pairing ticket
            </button>
            <button
              type="button"
              className={cx(controlsCss.chip, styles.modeBtn)}
              role="radio"
              aria-checked={advancedMode === 'token'}
              data-selected={advancedMode === 'token'}
              disabled={pending}
              onClick={() => setAdvancedMode('token')}
            >
              Bearer token
            </button>
          </div>
          {usingToken ? (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Bearer token</span>
              <input
                className={styles.input}
                type="password"
                autoComplete="off"
                placeholder="Admin-issued token"
                disabled={pending}
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
          ) : null}
        </div>
      </details>

      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : null}

      <div className={styles.foot}>
        {onCancel ? (
          <button type="button" className={controlsCss.chip} disabled={pending} onClick={onCancel}>
            {cancelLabel}
          </button>
        ) : null}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className={cx(buttonCss.btn, buttonCss.primary, buttonCss.sm)}
          disabled={!ready || pending}
          onClick={submit}
        >
          <span className={styles.connectIcon} data-spin={pending || undefined}>
            <Icon name={pending ? 'Loader' : 'Plug'} size={13} />
          </span>
          <span>{pending ? 'Connecting…' : connectLabel}</span>
        </button>
      </div>
    </div>
  );
}
