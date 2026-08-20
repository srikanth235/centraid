import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { formatBytes } from "../../format.js";
import {
  mintGatewayLinkTicket,
  redeemGatewayLinkTicket,
} from "../../gateway-client-links.js";
import type {
  CommonsInvitation,
  CommonsRecoveryGrant,
  CommonsRecoveryOutcome,
  GatewayEdge,
  GatewayLink,
} from "../../gateway-client.js";
import { SHARING_INVALID_INVITE } from "../../sharing-copy.js";
import { startVisibilityTicker } from "../shell/routes/visibility-ticker.js";
import { cx } from "../ui/cx.js";
import Icon from "../ui/Icon.js";
import StatusPill from "../ui/StatusPill.js";
import LinkRow, { LinkTicketPanel } from "./LinkRow.js";
import SharingRecoveryRows, {
  recoveryBusyKey,
  recoveryConcerns,
  recoveryOutcomeSummary,
} from "./SharingRecoveryRows.js";

import controlsCss from "../styles/controls.module.css";
import buttonCss from "../ui/Button.module.css";
import deviceStyles from "./DevicesCard.module.css";
import gwStyles from "./GatewayScreen.module.css";
import styles from "./SharingCard.module.css";

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

interface CommonsInviteClaim {
  stewardVaultId: string;
  claimToken: string;
}

/** Keep the shell's redeem field self-contained: importing the shared blueprint
 * codec here would pull the app-only commons-invite chunk onto the cold shell
 * path. This deliberately mirrors the blueprint codec's v1 wire checks. */
function parseCommonsInvite(value: string): CommonsInviteClaim | null {
  try {
    const invite = new URL(value.trim());
    const stewardVaultId = invite.searchParams.get("stewardVaultId") ?? "";
    const claimToken = invite.searchParams.get("claimToken") ?? "";
    if (
      invite.protocol !== "centraid:" ||
      invite.host !== "commons-invite" ||
      invite.searchParams.get("v") !== "1" ||
      !stewardVaultId ||
      !claimToken
    )
      return null;
    return { stewardVaultId, claimToken };
  } catch {
    return null;
  }
}

/** Which of the caller's OWN vaults a placement landed in. Cross-owner gives
 *  retired (#825, ruling G-copy), so the other end of an edge is never another
 *  person — labelling it "Linked person" said something that cannot be true. */
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
  loadEdges: () => Promise<GatewayEdge[]>;
  loadCommonsInvitations: (
    actorVaultId: string
  ) => Promise<CommonsInvitation[]>;
  onClaimCommonsInvitation: (
    actorVaultId: string,
    stewardVaultId: string,
    claimToken: string
  ) => Promise<unknown>;
  onAnswerCommonsInvitation: (
    invitationId: string,
    memberVaultId: string,
    answer: "accept" | "refuse"
  ) => Promise<unknown>;
  loadCommonsRecovery?: (
    actorVaultId: string
  ) => Promise<CommonsRecoveryGrant[]>;
  onRecoverCommons?: (
    actorVaultId: string,
    grantId: string
  ) => Promise<CommonsRecoveryOutcome>;
  onMintLinkTicket?: typeof mintGatewayLinkTicket;
  onRedeemLinkTicket?: typeof redeemGatewayLinkTicket;
}

const POLL_MS = 20_000;

/** A host that cannot read steward presence yet shows no absence rather than
 *  an error — the rest of the People panel must keep working without it. */
const noCommonsRecovery: NonNullable<
  SharingCardProps["loadCommonsRecovery"]
> = async () => [];

export default function SharingCard(props: SharingCardProps): JSX.Element {
  const {
    ownVaultIds,
    loadLinks,
    onProposeLink,
    onApproveLink,
    loadEdges,
    loadCommonsInvitations,
    onClaimCommonsInvitation,
    onAnswerCommonsInvitation,
    loadCommonsRecovery = noCommonsRecovery,
    onRecoverCommons,
    onMintLinkTicket = mintGatewayLinkTicket,
    onRedeemLinkTicket = redeemGatewayLinkTicket,
  } = props;
  const [links, setLinks] = useState<GatewayLink[]>([]);
  const [edges, setEdges] = useState<GatewayEdge[]>([]);
  const [commonsInvitations, setCommonsInvitations] = useState<
    CommonsInvitation[]
  >([]);
  const [commonsRecovery, setCommonsRecovery] = useState<
    CommonsRecoveryGrant[]
  >([]);
  const [recoveryOutcome, setRecoveryOutcome] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [proposeVault, setProposeVault] = useState(ownVaultIds[0] ?? "");
  const [proposeTarget, setProposeTarget] = useState("");
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [commonsInviteCode, setCommonsInviteCode] = useState("");
  const mountedRef = useRef(true);
  const ownVaultKey = ownVaultIds.join("\0");

  const refresh = useCallback((): void => {
    void Promise.all([
      loadLinks(),
      loadEdges(),
      Promise.all(
        (ownVaultKey ? ownVaultKey.split("\0") : []).map(loadCommonsInvitations)
      ).then((rows) => rows.flat()),
      Promise.all(
        (ownVaultKey ? ownVaultKey.split("\0") : []).map(loadCommonsRecovery)
      ).then((rows) => rows.flat()),
    ])
      .then(
        ([
          nextLinks,
          nextEdges,
          nextCommonsInvitations,
          nextCommonsRecovery,
        ]) => {
          if (!mountedRef.current) return;
          setLinks(nextLinks);
          setEdges(nextEdges);
          setCommonsInvitations(nextCommonsInvitations);
          setCommonsRecovery(nextCommonsRecovery);
          setErrorMessage(null);
        }
      )
      .catch((error: unknown) => {
        if (mountedRef.current)
          setErrorMessage(
            error instanceof Error ? error.message : String(error)
          );
      });
  }, [
    loadCommonsInvitations,
    loadCommonsRecovery,
    loadEdges,
    loadLinks,
    ownVaultKey,
  ]);

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

  const completed = edges.filter((edge) => edge.mode === "snapshot");
  const concerns = recoveryConcerns(commonsRecovery);

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

        {concerns.length ? (
          <SharingRecoveryRows
            concerns={concerns}
            busyRow={busyRow}
            outcome={recoveryOutcome}
            {...(onRecoverCommons
              ? {
                  onRecover: (entry) =>
                    void act(recoveryBusyKey(entry), async () => {
                      setRecoveryOutcome(
                        recoveryOutcomeSummary(
                          await onRecoverCommons(
                            entry.actorVaultId,
                            entry.grantId
                          )
                        )
                      );
                    }),
                }
              : {})}
          />
        ) : null}

        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Redeem a shared-space invite</h3>
          <p className={deviceStyles.meta}>
            Create your vault first, then paste the one-time invitation here.
          </p>
          <div className={styles.proposeForm}>
            <select
              aria-label="Vault for shared space"
              className={styles.receiveSelect}
              value={proposeVault}
              onChange={(event) => setProposeVault(event.target.value)}
            >
              {ownVaultIds.map((id) => (
                <option key={id} value={id}>
                  {shortId(id)}
                </option>
              ))}
            </select>
            <input
              aria-label="Shared-space invitation"
              className={styles.proposeInput}
              placeholder="centraid://commons-invite…"
              value={commonsInviteCode}
              onChange={(event) => setCommonsInviteCode(event.target.value)}
            />
            <button
              type="button"
              className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
              disabled={!proposeVault || !commonsInviteCode.trim()}
              onClick={() => {
                const claim = parseCommonsInvite(commonsInviteCode);
                if (!claim) {
                  setErrorMessage(SHARING_INVALID_INVITE);
                  return;
                }
                // The one-time secret leaves component state as soon as it is
                // handed to the authenticated claim request.
                setCommonsInviteCode("");
                void act("commons:claim", () =>
                  onClaimCommonsInvitation(
                    proposeVault,
                    claim.stewardVaultId,
                    claim.claimToken
                  )
                );
              }}
            >
              Redeem
            </button>
          </div>
        </div>

        {commonsInvitations.some((row) => row.status === "pending") ? (
          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>
              Shared spaces offered to you
            </h3>
            <div className={deviceStyles.list}>
              {commonsInvitations
                .filter((row) => row.status === "pending")
                .map((row) => {
                  const busyKey = `commons:${row.invitationId}`;
                  return (
                    <div key={row.invitationId} className={deviceStyles.row}>
                      <Icon name="Share" size={15} />
                      <div className={deviceStyles.main}>
                        <div className={deviceStyles.name}>
                          Ongoing shared space from{" "}
                          {shortId(row.stewardVaultId)}
                        </div>
                        <div className={deviceStyles.meta}>
                          {formatBytes(row.currentSizeBytes)} now · nothing is
                          written until you accept.
                        </div>
                      </div>
                      <div className={deviceStyles.rowAction}>
                        <button
                          type="button"
                          className={cx(
                            buttonCss.btn,
                            buttonCss.sm,
                            controlsCss.soft
                          )}
                          disabled={busyRow === busyKey}
                          onClick={() =>
                            void act(busyKey, () =>
                              onAnswerCommonsInvitation(
                                row.invitationId,
                                row.memberVaultId,
                                "accept"
                              )
                            )
                          }
                        >
                          Accept
                        </button>{" "}
                        <button
                          type="button"
                          className={cx(buttonCss.btn, buttonCss.sm)}
                          disabled={busyRow === busyKey}
                          onClick={() =>
                            void act(busyKey, () =>
                              onAnswerCommonsInvitation(
                                row.invitationId,
                                row.memberVaultId,
                                "refuse"
                              )
                            )
                          }
                        >
                          Refuse
                        </button>
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        ) : null}

        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>
            Recent copies between your vaults
          </h3>
          {completed.length ? (
            <div className={deviceStyles.list}>
              {completed.map((edge) => (
                <div key={edge.edgeId} className={deviceStyles.row}>
                  <Icon name="Share" size={15} />
                  <div className={deviceStyles.main}>
                    <div className={deviceStyles.nameLine}>
                      <span className={deviceStyles.name}>
                        {vaultLabel(edge.audienceVaultId, links)}
                      </span>
                      <StatusPill
                        tone={edge.status === "completed" ? "live" : "draft"}
                        tight
                      >
                        {edge.status}
                      </StatusPill>
                    </div>
                    <div className={deviceStyles.meta}>{edge.itemType}</div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className={gwStyles.panelEmpty}>
              No copies between your vaults yet.
            </div>
          )}
        </div>

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
              onChange={(event) => setProposeVault(event.target.value)}
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
              disabled={!proposeTarget.trim() || busyRow === "propose"}
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
