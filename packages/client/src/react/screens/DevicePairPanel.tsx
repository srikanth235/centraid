import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import type {
  GatewayDeviceTicket,
  GatewayDeviceTicketInput,
} from "../../gateway-client.js";
import { formatClock, formatDuration } from "../shell/routes/gatewayData.js";
import { cx } from "../ui/cx.js";
import Icon from "../ui/Icon.js";
import { pairErrorMessage } from "./device-errors.js";

import controlsCss from "../styles/controls.module.css";
import buttonCss from "../ui/Button.module.css";
import styles from "./DevicePairPanel.module.css";
import cardCss from "./DevicesCard.module.css";

export interface DevicePairPanelProps {
  now: number;
  onCreateTicket: (
    input?: GatewayDeviceTicketInput
  ) => Promise<GatewayDeviceTicket>;
  onClose: () => void;
  /**
   * Mint a vault for a NEW person instead of self-pairing (#726 P1 "Add
   * someone"). Adds the name field the mint needs and the hosting-posture
   * sentences the minted ticket carries; everything else — TTL, the QR/ticket
   * surface, copy — is the same self-pair panel unchanged.
   */
  forPerson?: boolean;
}

const TTL_PRESETS: readonly { label: string; minutes: number }[] = [
  { label: "15 min", minutes: 15 },
  { label: "1 hour", minutes: 60 },
  { label: "24 hours", minutes: 1440 },
];

/*
 * Pairing has exactly two shapes (#726, #726 P1) and this one panel renders
 * both, switched on `forPerson`:
 *
 *   self-pair (default) — pair another device for YOURSELF. Access is
 *     ownership: the only ticket a device may mint for itself lands on its
 *     own owner, reaching exactly the vaults it already owns. Nothing to
 *     name, nothing to choose beyond how long the ticket stays good for.
 *   Add someone (`forPerson`) — mint a NEW person a vault of their own,
 *     hosted on this machine. The one extra input is their name; the ticket
 *     that comes back is exactly the same QR/paste surface, plus two
 *     sentences stating what hosting someone else's vault does and doesn't
 *     confer (verbatim — also in SECURITY.md).
 */
export default function DevicePairPanel({
  now,
  onCreateTicket,
  onClose,
  forPerson = false,
}: DevicePairPanelProps): JSX.Element {
  const [minutes, setMinutes] = useState(15);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticket, setTicket] = useState<GatewayDeviceTicket | null>(null);
  const [copied, setCopied] = useState(false);
  // The rendered QR is stored WITH the ticket it encodes, so "no ticket" and
  // "a newer ticket than the last render" both read as "no QR yet" during
  // render — no effect has to blank it out.
  const [qr, setQr] = useState<{
    ticket: GatewayDeviceTicket;
    svg: string;
  } | null>(null);
  const qrSvg =
    qr !== null && ticket !== null && qr.ticket === ticket ? qr.svg : null;

  useEffect(() => {
    if (!ticket) return;
    let live = true;
    void QRCode.toString(ticket.ticket, {
      type: "svg",
      width: 176,
      margin: 1,
    }).then(
      (svg) => {
        if (live) setQr({ svg, ticket });
      },
      (caughtError: unknown) => {
        if (live)
          setError(
            caughtError instanceof Error
              ? caughtError.message
              : String(caughtError)
          );
      }
    );
    return () => {
      live = false;
    };
  }, [ticket]);

  // The mint's idempotency key (#750): minted once per INTENDED operation and
  // reused on retry after a failure, so "press Generate again" can never mint
  // a second owner/vault. A success clears it — "New ticket" is a new intent.
  const operationRef = useRef<string | null>(null);

  const generate = async (): Promise<void> => {
    if (forPerson && name.trim().length === 0) return;
    setBusy(true);
    setError(null);
    if (forPerson) operationRef.current ??= crypto.randomUUID();
    const operationId = operationRef.current;
    try {
      setTicket(
        await onCreateTicket({
          ttlMinutes: minutes,
          ...(forPerson && operationId !== null
            ? { forPerson: { label: name.trim() }, operationId }
            : {}),
        })
      );
      operationRef.current = null;
    } catch (caughtError) {
      setError(pairErrorMessage(caughtError));
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
        setError(
          "Couldn’t copy to the clipboard — select and copy the ticket manually."
        )
      );
  };

  if (ticket) {
    const expMs = Date.parse(ticket.expiresAt);
    return (
      <div className={styles.pair} data-testid="pair-panel">
        <div className={styles.pairLead}>
          One-time ticket for <strong>{ticket.ownerLabel}</strong>. Scan it in
          Centraid Companion, or paste it into the other device’s pairing
          dialog. It burns on first use.
        </div>
        {forPerson ? (
          <div className={styles.postureNote} data-testid="hosting-posture">
            <p>
              This vault lives on this machine: whoever owns the machine can
              read what it holds while it is hosted here.
            </p>
            <p>
              While hosted here, this machine also signs for the vault when its
              owner is away — moving the vault elsewhere ends both.
            </p>
          </div>
        ) : null}
        <div className={styles.grantSummary}>
          {ticket.vaults.map((vault) => (
            <span key={vault.vaultId}>{vault.vaultName ?? vault.vaultId}</span>
          ))}
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
              <Icon name={copied ? "Check" : "Copy"} size={13} />
              <span>{copied ? "Copied" : "Copy"}</span>
            </button>
          </div>
        </div>
        <div className={styles.pairFoot}>
          <span className={styles.pairExpiry}>
            {Number.isNaN(expMs)
              ? ""
              : expMs <= now
                ? "Expired"
                : `Expires ${formatClock(expMs)} · in ${formatDuration(expMs - now)}`}
          </span>
          <div className={styles.pairActions}>
            <button
              type="button"
              className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
              onClick={() => {
                // Dropping the ticket drops its QR too — `qrSvg` is derived
                // from the pair, so there is nothing else to clear.
                setTicket(null);
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

  const nameMissing = forPerson && name.trim().length === 0;

  return (
    <div className={styles.pair} data-testid="pair-panel">
      <p className={styles.roleHint}>
        {forPerson
          ? "This mints them a vault of their own, hosted on this machine — not a grant into any vault you already own."
          : "The new device joins as you, with your current access."}
      </p>
      <div className={styles.pairForm}>
        {forPerson ? (
          <label className={styles.nameField}>
            <span className={styles.nameFieldLabel}>Name</span>
            <input
              type="text"
              className={styles.nameInput}
              placeholder="Their name"
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
              data-testid="add-someone-name"
            />
          </label>
        ) : null}
        <fieldset className={styles.ttlGroup} aria-label="Ticket lifetime">
          {TTL_PRESETS.map((preset) => (
            <button
              key={preset.minutes}
              type="button"
              className={cx(
                styles.ttlPreset,
                preset.minutes === minutes && styles.ttlPresetOn
              )}
              aria-pressed={preset.minutes === minutes}
              disabled={busy}
              onClick={() => setMinutes(preset.minutes)}
            >
              {preset.label}
            </button>
          ))}
        </fieldset>
        <div className={styles.pairActions}>
          <button
            type="button"
            className={cx(buttonCss.btn, buttonCss.sm, styles.generateBtn)}
            disabled={busy || nameMissing}
            onClick={() => void generate()}
          >
            {busy ? (
              <span className={cardCss.spin}>
                <Icon name="Loader" size={13} />
              </span>
            ) : (
              "Generate ticket"
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
      {error ? <div className={cardCss.rowError}>{error}</div> : null}
    </div>
  );
}
