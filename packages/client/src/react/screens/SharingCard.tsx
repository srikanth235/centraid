// THE PEOPLE PANEL — who this household is linked to, and the ceremony that
// adds one more.
//
// Reaching another person is ONE mechanism: an approved vault link. What a
// link produces is what every share sheet offers as an audience, so this panel
// has exactly two parts.

import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import {
  mintGatewayLinkTicket,
  redeemGatewayLinkTicket,
} from "../../gateway-client-links.js";
import type { GatewayLink } from "../../gateway-client.js";
import { startVisibilityTicker } from "../shell/routes/visibility-ticker.js";
import { cx } from "../ui/cx.js";
import Icon from "../ui/Icon.js";
import LinkRow, { LinkTicketPanel } from "./LinkRow.js";

import controlsCss from "../styles/controls.module.css";
import buttonCss from "../ui/Button.module.css";
import deviceStyles from "./DevicesCard.module.css";
import gwStyles from "./GatewayScreen.module.css";
import styles from "./SharingCard.module.css";

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

function vaultLabel(vaultId: string, links: readonly GatewayLink[]): string {
  for (const link of links) {
    if (link.vaultA === vaultId) return link.labelA ?? shortId(vaultId);
    if (link.vaultB === vaultId) return link.labelB ?? shortId(vaultId);
  }
  return shortId(vaultId);
}

export interface SharingCardProps {
  now: number;
  ownVaultIds: readonly string[];
  loadLinks: () => Promise<GatewayLink[]>;
  onProposeLink: (
    vaultId: string,
    otherVaultId: string
  ) => Promise<GatewayLink>;
  onApproveLink: (linkId: string) => Promise<GatewayLink>;
  onMintLinkTicket?: typeof mintGatewayLinkTicket;
  onRedeemLinkTicket?: typeof redeemGatewayLinkTicket;
}

const POLL_MS = 20_000;

export default function SharingCard(props: SharingCardProps): JSX.Element {
  const {
    ownVaultIds,
    loadLinks,
    onProposeLink,
    onApproveLink,
    onMintLinkTicket = mintGatewayLinkTicket,
    onRedeemLinkTicket = redeemGatewayLinkTicket,
  } = props;
  const [links, setLinks] = useState<GatewayLink[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // A CHOICE, not a mirror: `ownVaultIds` arrives async, so seeded state keeps
  // `""` while the select paints its first option and the propose posts empty.
  const [pickedVault, setPickedVault] = useState("");
  const [proposeTarget, setProposeTarget] = useState("");
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const proposeVault = ownVaultIds.includes(pickedVault)
    ? pickedVault
    : (ownVaultIds[0] ?? "");

  const refresh = useCallback((): void => {
    void loadLinks()
      .then((nextLinks) => {
        if (!mountedRef.current) return;
        setLinks(nextLinks);
        setErrorMessage(null);
      })
      .catch((error: unknown) => {
        if (mountedRef.current)
          setErrorMessage(
            error instanceof Error ? error.message : String(error)
          );
      });
  }, [loadLinks]);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    const stop = startVisibilityTicker(refresh, POLL_MS);
    return () => {
      mountedRef.current = false;
      stop();
    };
  }, [refresh]);

  const act = async (
    id: string,
    action: () => Promise<unknown>
  ): Promise<void> => {
    setBusyRow(id);
    try {
      await action();
      refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current) setBusyRow(null);
    }
  };

  return (
    <section className={cx(gwStyles.panel, deviceStyles.card)}>
      <div className={gwStyles.panelHead}>
        <h2>People &amp; circles</h2>
        <span className={gwStyles.panelMeta}>
          {links.length} {links.length === 1 ? "person" : "people"}
        </span>
      </div>
      <div className={deviceStyles.body}>
        {errorMessage ? (
          <div className={deviceStyles.loadError}>{errorMessage}</div>
        ) : null}

        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Link with someone</h3>
          <LinkTicketPanel
            ownVaultIds={ownVaultIds}
            onMintTicket={onMintLinkTicket}
            onRedeemTicket={onRedeemLinkTicket}
            onLinked={refresh}
          />
        </div>

        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>People</h3>
          <div className={styles.proposeForm}>
            <select
              aria-label="From vault"
              className={styles.receiveSelect}
              value={proposeVault}
              onChange={(event) => setPickedVault(event.target.value)}
            >
              {ownVaultIds.map((id) => (
                <option key={id} value={id}>
                  {shortId(id)}
                </option>
              ))}
            </select>
            <input
              className={styles.proposeInput}
              placeholder="Other vault id"
              value={proposeTarget}
              onChange={(event) => setProposeTarget(event.target.value)}
            />
            <button
              type="button"
              className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
              disabled={
                !proposeVault || !proposeTarget.trim() || busyRow === "propose"
              }
              onClick={() =>
                void act("propose", async () => {
                  await onProposeLink(proposeVault, proposeTarget.trim());
                  setProposeTarget("");
                })
              }
            >
              <Icon name="Plus" size={12} />
              Link
            </button>
          </div>
          {links.length ? (
            <div className={deviceStyles.list}>
              {links.map((link) => {
                const other =
                  link.vaultA === proposeVault ? link.vaultB : link.vaultA;
                const mineApproved =
                  link.vaultA === proposeVault
                    ? link.approvedByA
                    : link.approvedByB;
                return (
                  <LinkRow
                    key={link.linkId}
                    link={link}
                    otherLabel={vaultLabel(other, links)}
                    mineApproved={mineApproved}
                    busy={busyRow === link.linkId}
                    onApprove={() =>
                      void act(link.linkId, () => onApproveLink(link.linkId))
                    }
                  />
                );
              })}
            </div>
          ) : (
            <div className={gwStyles.panelEmpty}>No people linked yet.</div>
          )}
        </div>
      </div>
    </section>
  );
}
