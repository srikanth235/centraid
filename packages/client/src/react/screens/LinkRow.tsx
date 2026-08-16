import QRCode from "qrcode";
import { useEffect, useState } from "react";
import type { JSX } from "react";

import type { RedeemLinkTicketOutcome } from "../../gateway-client-links.js";
import type { GatewayLink, ReceiveSetting } from "../../gateway-client.js";
import { SHARING_UNREACHABLE } from "../../sharing-copy.js";
import { cx } from "../ui/cx.js";
import Icon from "../ui/Icon.js";
import StatusPill from "../ui/StatusPill.js";

import controlsCss from "../styles/controls.module.css";
import buttonCss from "../ui/Button.module.css";
import deviceStyles from "./DevicesCard.module.css";
import styles from "./SharingCard.module.css";

/**
 * One link row, with its own receive-setting control.
 */
export default function LinkRow({
  link,
  otherLabel,
  mineApproved,
  busy,
  onApprove,
  loadReceiveSetting,
  onSetReceiveSetting,
}: {
  link: GatewayLink;
  otherLabel: string;
  mineApproved: boolean;
  busy: boolean;
  onApprove: () => void;
  loadReceiveSetting: (linkId: string) => Promise<ReceiveSetting>;
  onSetReceiveSetting: (
    linkId: string,
    setting: ReceiveSetting
  ) => Promise<ReceiveSetting>;
}): JSX.Element {
  const [setting, setSetting] = useState<ReceiveSetting | null>(null);
  useEffect(() => {
    let live = true;
    loadReceiveSetting(link.linkId)
      .then((value) => {
        if (live) setSetting(value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [link.linkId, loadReceiveSetting]);

  return (
    <div className={deviceStyles.row}>
      <span className={deviceStyles.glyph} aria-hidden="true">
        <Icon name="Users" size={15} />
      </span>
      <div className={deviceStyles.main}>
        <div className={deviceStyles.nameLine}>
          <span className={deviceStyles.name}>{otherLabel}</span>
          {link.revoked ? (
            <StatusPill tone="down" tight>
              revoked
            </StatusPill>
          ) : link.approved ? (
            <StatusPill tone="live" tight>
              linked
            </StatusPill>
          ) : (
            <StatusPill tone="draft" tight>
              pending approval
            </StatusPill>
          )}
        </div>
        <div className={deviceStyles.meta}>
          <span>Receive gives</span>
          <select
            aria-label={`Receive setting for ${otherLabel}`}
            className={styles.receiveSelect}
            value={setting ?? "accept"}
            disabled={setting === null || link.revoked}
            onChange={(event) => {
              const value = event.target.value as ReceiveSetting;
              setSetting(value);
              void onSetReceiveSetting(link.linkId, value);
            }}
          >
            <option value="accept">Accept</option>
            <option value="ask">Ask first</option>
            <option value="refuse">Refuse</option>
          </select>
        </div>
      </div>
      {!link.approved && !link.revoked ? (
        <div className={deviceStyles.rowAction}>
          <button
            type="button"
            className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
            disabled={mineApproved || busy}
            onClick={onApprove}
          >
            {mineApproved ? "Waiting on them" : "Approve"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

export interface LinkTicketPanelProps {
  /** Vaults the caller owns and may mint a ticket for or redeem one into. */
  ownVaultIds: readonly string[];
  onMintTicket: (
    vaultId: string
  ) => Promise<{ vaultId: string; ticket: string; expiresAt: string }>;
  onRedeemTicket: (
    vaultId: string,
    ticket: string
  ) => Promise<RedeemLinkTicketOutcome>;
  /** A link just landed — the parent's own list needs a fresh load. */
  onLinked: () => void;
}

/**
 * The remote link ceremony's owner-facing door (#726 audit finding 1): show
 * a one-time ticket (QR + pasteable text — the P1 pairing panel's own idiom,
 * `DevicePairPanel.tsx`), or paste/redeem one someone showed you. Split out
 * of `SharingCard.tsx` for the same file-size reason `LinkRow` itself was.
 */
export function LinkTicketPanel({
  ownVaultIds,
  onMintTicket,
  onRedeemTicket,
  onLinked,
}: LinkTicketPanelProps): JSX.Element {
  const [mode, setMode] = useState<"show" | "paste">("show");
  const [vaultId, setVaultId] = useState(ownVaultIds[0] ?? "");
  const [ticket, setTicket] = useState<{
    ticket: string;
    expiresAt: string;
  } | null>(null);
  const [qrSvg, setQrSvg] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!ticket) return;
    let live = true;
    void QRCode.toString(ticket.ticket, {
      type: "svg",
      width: 176,
      margin: 1,
    }).then(
      (svg) => {
        if (live) setQrSvg(svg);
      },
      () => {
        if (live) setQrSvg(null);
      }
    );
    return () => {
      live = false;
    };
  }, [ticket]);

  const mint = async (): Promise<void> => {
    if (!vaultId) return;
    setBusy(true);
    setErrorMessage(null);
    try {
      setTicket(await onMintTicket(vaultId));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
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
        setErrorMessage("Couldn’t copy — select and copy the ticket manually.")
      );
  };

  const redeem = async (): Promise<void> => {
    if (!vaultId || !pasted.trim()) return;
    setBusy(true);
    setErrorMessage(null);
    try {
      const outcome = await onRedeemTicket(vaultId, pasted.trim());
      if (outcome.state === "linked") {
        setPasted("");
        onLinked();
      } else {
        setErrorMessage(outcome.detail ?? SHARING_UNREACHABLE);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.linkTicketPanel}>
      <div className={styles.proposeForm}>
        <select
          aria-label="As vault"
          className={styles.receiveSelect}
          value={vaultId}
          onChange={(event) => setVaultId(event.target.value)}
        >
          {ownVaultIds.map((id) => (
            <option key={id} value={id}>
              {shortId(id)}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={cx(
            buttonCss.btn,
            buttonCss.sm,
            mode === "show" ? undefined : controlsCss.soft
          )}
          onClick={() => setMode("show")}
        >
          Show my ticket
        </button>
        <button
          type="button"
          className={cx(
            buttonCss.btn,
            buttonCss.sm,
            mode === "paste" ? undefined : controlsCss.soft
          )}
          onClick={() => setMode("paste")}
        >
          Paste theirs
        </button>
      </div>

      {mode === "show" ? (
        ticket ? (
          <div className={styles.linkTicketSurface}>
            {qrSvg ? (
              <img
                className={styles.linkTicketQr}
                src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg)}`}
                alt="One-time Centraid link ticket QR code"
              />
            ) : null}
            <div className={styles.ticketRow}>
              <code className={styles.ticket}>{ticket.ticket}</code>
              <button
                type="button"
                className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
                onClick={copy}
              >
                <Icon name={copied ? "Check" : "Copy"} size={13} />
                <span>{copied ? "Copied" : "Copy"}</span>
              </button>
            </div>
            <button
              type="button"
              className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
              onClick={() => {
                setTicket(null);
                setCopied(false);
              }}
            >
              New ticket
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
            disabled={busy || !vaultId}
            onClick={() => void mint()}
          >
            {busy ? "Generating…" : "Generate ticket"}
          </button>
        )
      ) : (
        <div className={styles.linkTicketSurface}>
          <textarea
            aria-label="Pasted link ticket"
            className={styles.linkTicketPaste}
            placeholder="Paste the ticket they showed you"
            value={pasted}
            disabled={busy}
            onChange={(event) => setPasted(event.target.value)}
          />
          <button
            type="button"
            className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
            disabled={busy || !vaultId || !pasted.trim()}
            onClick={() => void redeem()}
          >
            {busy ? "Linking…" : "Link"}
          </button>
        </div>
      )}
      {errorMessage ? (
        <div className={deviceStyles.rowError}>{errorMessage}</div>
      ) : null}
    </div>
  );
}
