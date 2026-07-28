import QRCode from "qrcode";
import { useEffect, useState, type JSX } from "react";

import type {
  GatewayDeviceTicket,
  GatewayDeviceTicketInput,
  GatewayMember,
} from "../../gateway-client.js";
import { formatClock, formatDuration } from "../shell/routes/gatewayData.js";
import { cx } from "../ui/cx.js";
import Icon from "../ui/Icon.js";
import { pairErrorMessage, roleLabel } from "./device-roles.js";
import DevicePairTarget, {
  type PairGrant,
  type PairSpace,
  type PairTarget,
} from "./DevicePairTarget.js";

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
  /** Everyone the caller shares a space with — the picker's list (#599). */
  members?: readonly GatewayMember[];
  /** The caller's own member id, so "Myself" is distinguishable from a peer. */
  currentMemberId?: string;
  /** Spaces the caller may grant, with resolved names. */
  spaces?: readonly PairSpace[];
}

const NO_MEMBERS: readonly GatewayMember[] = [];
const NO_SPACES: readonly PairSpace[] = [];

const TTL_PRESETS: readonly { label: string; minutes: number }[] = [
  { label: "15 min", minutes: 15 },
  { label: "1 hour", minutes: 60 },
  { label: "24 hours", minutes: 1440 },
];

/*
 * "Pair a device for <person>" — a device is always somebody's (#599 L2), so
 * the first question is who, not what role. Self-pair is the landing state:
 * pairing your own second phone must not require asking another person for a
 * QR code, and it grants exactly the access you already hold (the gateway
 * derives it — this panel sends no member and no grants for that case).
 */
export default function DevicePairPanel({
  now,
  onCreateTicket,
  onClose,
  members = NO_MEMBERS,
  currentMemberId,
  spaces = NO_SPACES,
}: DevicePairPanelProps): JSX.Element {
  const [minutes, setMinutes] = useState(15);
  const [target, setTarget] = useState<PairTarget>({ kind: "self" });
  const [grants, setGrants] = useState<PairGrant[]>([]);
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
      (err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      }
    );
    return () => {
      live = false;
    };
  }, [ticket]);

  const generate = async (): Promise<void> => {
    if (target.kind === "new" && target.label.trim().length === 0) {
      setError("Give the new person a name.");
      return;
    }
    if (target.kind !== "self" && grants.length === 0) {
      setError("Choose at least one space this device may reach.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Self-pair sends NEITHER member nor grants: the gateway resolves the
      // caller's own member and clamps to the roles they already hold.
      const input: GatewayDeviceTicketInput = { ttlMinutes: minutes };
      if (target.kind === "member") {
        input.memberId = target.memberId;
        input.grants = grants;
      } else if (target.kind === "new") {
        input.newMemberLabel = target.label.trim();
        input.grants = grants;
      }
      setTicket(await onCreateTicket(input));
    } catch (err) {
      setError(pairErrorMessage(err));
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
    const granted = ticket.grants ?? [];
    return (
      <div className={styles.pair} data-testid="pair-panel">
        <div className={styles.pairLead}>
          One-time ticket for <strong>{ticket.memberLabel}</strong>. Scan it in
          Centraid Companion, or paste it into the other device’s pairing
          dialog. It burns on first use.
        </div>
        <div className={styles.grantSummary}>
          {(granted.length > 0
            ? granted
            : [
                {
                  vaultId: ticket.vaultId,
                  vaultName: ticket.vaultName,
                  role: ticket.role,
                },
              ]
          ).map((grant) => (
            <span key={grant.vaultId}>
              {grant.vaultName ?? grant.vaultId} · {roleLabel(grant.role)}
            </span>
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

  return (
    <div className={styles.pair} data-testid="pair-panel">
      <DevicePairTarget
        target={target}
        onTargetChange={(next) => {
          setTarget(next);
          setError(null);
        }}
        members={members}
        {...(currentMemberId === undefined ? {} : { currentMemberId })}
        spaces={spaces}
        grants={grants}
        onGrantsChange={setGrants}
        disabled={busy}
      />
      <div className={styles.pairForm}>
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
            disabled={busy}
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
