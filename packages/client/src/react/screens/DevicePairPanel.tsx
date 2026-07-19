import { useEffect, useState, type JSX } from 'react';
import QRCode from 'qrcode';
import type { GatewayDeviceTicket } from '../../gateway-client.js';
import { formatClock, formatDuration } from '../shell/routes/gatewayData.js';
import Icon from '../ui/Icon.js';
import { cx } from '../ui/cx.js';
import buttonCss from '../ui/Button.module.css';
import controlsCss from '../styles/controls.module.css';
import styles from './DevicesCard.module.css';

export interface DevicePairPanelProps {
  now: number;
  onCreateTicket: (input?: { ttlMinutes?: number }) => Promise<GatewayDeviceTicket>;
  onClose: () => void;
}

const TTL_PRESETS: readonly { label: string; minutes: number }[] = [
  { label: '15 min', minutes: 15 },
  { label: '1 hour', minutes: 60 },
  { label: '24 hours', minutes: 1440 },
];

/** Owner-facing QR/paste material for one short-lived, single-use pairing ticket. */
export default function DevicePairPanel({
  now,
  onCreateTicket,
  onClose,
}: DevicePairPanelProps): JSX.Element {
  const [minutes, setMinutes] = useState(15);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticket, setTicket] = useState<GatewayDeviceTicket | null>(null);
  const [copied, setCopied] = useState(false);
  const [qrSvg, setQrSvg] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    if (!ticket) {
      setQrSvg(null);
      return () => {
        live = false;
      };
    }
    void QRCode.toString(ticket.ticket, { type: 'svg', width: 176, margin: 1 }).then(
      (svg) => {
        if (live) setQrSvg(svg);
      },
      (err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      live = false;
    };
  }, [ticket]);

  const generate = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setTicket(await onCreateTicket({ ttlMinutes: minutes }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const copy = (): void => {
    if (!ticket) return;
    void navigator.clipboard
      .writeText(ticket.ticket)
      .then(() => setCopied(true))
      .catch(() =>
        setError('Couldn’t copy to the clipboard — select and copy the ticket manually.'),
      );
  };

  if (ticket) {
    const expMs = Date.parse(ticket.expiresAt);
    return (
      <div className={styles.pair} data-testid="pair-panel">
        <div className={styles.pairLead}>
          One-time ticket for <strong>{ticket.vaultName ?? 'your vault'}</strong>. Scan it in
          Centraid Companion, or paste it into another device’s pairing dialog. It burns on first
          use.
        </div>
        <div className={styles.pairTicketSurface}>
          {qrSvg ? (
            <img
              className={styles.pairQr}
              src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg)}`}
              alt="One-time Centraid pairing QR code"
            />
          ) : null}
          <div className={styles.ticketRow}>
            <code className={styles.ticket}>{ticket.ticket}</code>
            <button
              type="button"
              className={cx(buttonCss.btn, buttonCss.sm, styles.copyBtn)}
              onClick={copy}
            >
              <Icon name={copied ? 'Check' : 'Copy'} size={13} />
              <span>{copied ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
        </div>
        <div className={styles.pairFoot}>
          <span className={styles.pairExpiry}>
            {Number.isNaN(expMs)
              ? ''
              : expMs <= now
                ? 'Expired'
                : `Expires ${formatClock(expMs)} · in ${formatDuration(expMs - now)}`}
          </span>
          <div className={styles.pairActions}>
            <button
              type="button"
              className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
              onClick={() => {
                setTicket(null);
                setQrSvg(null);
                setCopied(false);
              }}
            >
              New ticket
            </button>
            <button
              type="button"
              className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
              onClick={onClose}
            >
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.pair} data-testid="pair-panel">
      <div className={styles.pairLead}>
        Generate a one-time ticket, then scan it in Centraid Companion or paste it into another
        device’s pairing dialog. The device pairs into your active vault and appears here once it
        connects.
      </div>
      <div className={styles.pairForm}>
        <div className={styles.ttlGroup} role="group" aria-label="Ticket lifetime">
          {TTL_PRESETS.map((preset) => (
            <button
              key={preset.minutes}
              type="button"
              className={cx(styles.ttlPreset, preset.minutes === minutes && styles.ttlPresetOn)}
              aria-pressed={preset.minutes === minutes}
              disabled={busy}
              onClick={() => setMinutes(preset.minutes)}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <div className={styles.pairActions}>
          <button
            type="button"
            className={cx(buttonCss.btn, buttonCss.sm, styles.generateBtn)}
            disabled={busy}
            onClick={() => void generate()}
          >
            {busy ? (
              <span className={styles.spin}>
                <Icon name="Loader" size={13} />
              </span>
            ) : (
              'Generate ticket'
            )}
          </button>
          <button
            type="button"
            className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </div>
      {error ? <div className={styles.rowError}>{error}</div> : null}
    </div>
  );
}
