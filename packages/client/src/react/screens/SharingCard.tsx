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
  GatewayEdge,
  GatewayLink,
  PendingEdge,
  ReceiveSetting,
} from "../../gateway-client.js";
import { startVisibilityTicker } from "../shell/routes/visibility-ticker.js";
import { cx } from "../ui/cx.js";
import Icon from "../ui/Icon.js";
import StatusPill from "../ui/StatusPill.js";
import LinkRow, { LinkTicketPanel } from "./LinkRow.js";

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

function vaultLabel(vaultId: string, links: readonly GatewayLink[]): string {
  for (const link of links) {
    if (link.vaultA === vaultId) return link.labelA ?? "Linked person";
    if (link.vaultB === vaultId) return link.labelB ?? "Linked person";
  }
  return "Linked person";
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
  loadReceiveSetting: (linkId: string) => Promise<ReceiveSetting>;
  onSetReceiveSetting: (
    linkId: string,
    setting: ReceiveSetting
  ) => Promise<ReceiveSetting>;
  loadEdges: () => Promise<GatewayEdge[]>;
  loadPending: () => Promise<PendingEdge[]>;
  onAnswerPending: (
    edgeId: string,
    decision: "accept" | "refuse"
  ) => Promise<unknown>;
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
  ) => Promise<unknown>;
  onMintLinkTicket?: typeof mintGatewayLinkTicket;
  onRedeemLinkTicket?: typeof redeemGatewayLinkTicket;
}

const POLL_MS = 20_000;
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
    loadPending,
    onAnswerPending,
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
  const [pending, setPending] = useState<PendingEdge[]>([]);
  const [commonsInvitations, setCommonsInvitations] = useState<
    CommonsInvitation[]
  >([]);
  const [commonsRecovery, setCommonsRecovery] = useState<
    CommonsRecoveryGrant[]
  >([]);
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
      loadPending(),
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
          nextPending,
          nextCommonsInvitations,
          nextCommonsRecovery,
        ]) => {
          if (!mountedRef.current) return;
          setLinks(nextLinks);
          setEdges(nextEdges);
          setPending(nextPending);
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
    loadPending,
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
  const recoveryConcerns = commonsRecovery.filter(
    (entry) =>
      entry.steward.presence === "degraded" ||
      entry.steward.presence === "absent" ||
      entry.steward.presence === "link-down" ||
      entry.steward.presence === "parked"
  );

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

        {recoveryConcerns.length ? (
          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>Shared-space recovery</h3>
            <div className={deviceStyles.list}>
              {recoveryConcerns.map((entry) => {
                const key = `recover:${entry.actorVaultId}:${entry.grantId}`;
                return (
                  <div key={key} className={deviceStyles.row}>
                    <Icon name="AlertTriangle" size={15} />
                    <div className={deviceStyles.main}>
                      <div className={deviceStyles.name}>
                        Steward {entry.steward.presence}
                      </div>
                      <div className={deviceStyles.meta}>
                        {entry.containerType}
                        {entry.steward.silentForMs
                          ? ` · unreachable for ${Math.floor(entry.steward.silentForMs / 86_400_000)} days`
                          : ""}
                        {entry.steward.fault ? ` · ${entry.steward.fault}` : ""}
                      </div>
                    </div>
                    {onRecoverCommons && entry.steward.presence !== "parked" ? (
                      <button
                        type="button"
                        className={cx(
                          buttonCss.btn,
                          buttonCss.sm,
                          controlsCss.soft
                        )}
                        disabled={busyRow === key}
                        onClick={() =>
                          void act(key, () =>
                            onRecoverCommons(entry.actorVaultId, entry.grantId)
                          )
                        }
                      >
                        Recover from my copy
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {pending.length ? (
          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>Waiting for your decision</h3>
            <div className={deviceStyles.list}>
              {pending.map((row) => (
                <div key={row.edgeId} className={deviceStyles.row}>
                  <Icon name="Share" size={15} />
                  <div className={deviceStyles.main}>
                    <div className={deviceStyles.name}>
                      {vaultLabel(row.peerVaultId, links)} shared{" "}
                      {row.itemCount} {row.itemType}
                    </div>
                    <div className={deviceStyles.meta}>
                      Nothing is written until you accept.
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
                      disabled={busyRow === row.edgeId}
                      onClick={() =>
                        void act(row.edgeId, () =>
                          onAnswerPending(row.edgeId, "accept")
                        )
                      }
                    >
                      Accept
                    </button>{" "}
                    <button
                      type="button"
                      className={cx(buttonCss.btn, buttonCss.sm)}
                      disabled={busyRow === row.edgeId}
                      onClick={() =>
                        void act(row.edgeId, () =>
                          onAnswerPending(row.edgeId, "refuse")
                        )
                      }
                    >
                      Refuse
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Redeem a shared-space invite</h3>
          <p className={deviceStyles.meta}>
            Create your vault first. If the sharer is remote, connect with them,
            then paste the one-time invitation here.
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
                  setErrorMessage("That shared-space invitation is invalid.");
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
          <h3 className={styles.sectionTitle}>Recent direct copies</h3>
          {completed.length ? (
            <div className={deviceStyles.list}>
              {completed.map((edge) => (
                <div key={edge.edgeId} className={deviceStyles.row}>
                  <Icon name="Share" size={15} />
                  <div className={deviceStyles.main}>
                    <div className={deviceStyles.nameLine}>
                      <span className={deviceStyles.name}>
                        {edge.audienceLabel ||
                          vaultLabel(edge.audienceVaultId, links)}
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
            <div className={gwStyles.panelEmpty}>No direct copies yet.</div>
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
                    loadReceiveSetting={props.loadReceiveSetting}
                    onSetReceiveSetting={props.onSetReceiveSetting}
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
