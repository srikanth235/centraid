import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import {
  mintGatewayLinkTicket,
  redeemGatewayLinkTicket,
} from "../../gateway-client-links.js";
import type {
  AppScopeEntry,
  AppScopeBorrowed,
} from "../../gateway-client-vault.js";
import type {
  BorrowBudget,
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

// Household → Sharing (#726 P6) — the People panel: per-person shares in and
// out, link propose/approve, the D9 ask surface, the D9 receive setting, and
// "Shared with me". Same card idiom as DevicesCard (`gwStyles.panel`, the
// same row/glyph/meta shell), because a share IS a fact about a person, same
// as a paired device is — this card sits right beside it in Household.
//
// WORDING IS LOAD-BEARING (D7). Stopping a lend reads "Stop lending" —
// NEVER "take back": what the audience already read cannot be un-seen, only
// the WINDOW can close. A give is warned irrevocable before it fires, in the
// share sheet itself (packages/blueprints' `_shared/ShareSheet.tsx`) — this
// card only narrates what already happened, so it never repeats that prompt.
//
// HONEST STATES, not failures: a parked ask waits, never errors; a borrowed
// scope's `reachState` renders as a state (offered/established/parked), never
// collapses to "shared" or vanishes when unreachable.

const reachTone: Record<AppScopeBorrowed["reachState"], string> = {
  established: "live",
  offered: "draft",
  parked: "down",
};

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

/** The link's own record of who `vaultId` is (#726 P6 gap 3) — `labelA`/
 *  `labelB` name `vaultA`/`vaultB` symmetrically, regardless of which side is
 *  "mine". `null` when a link genuinely never recorded one (an old link, or
 *  a peer that never sent a label over the wire). */
function labelFromLinks(
  vaultId: string,
  links: readonly GatewayLink[]
): string | null {
  for (const link of links) {
    if (link.vaultA === vaultId) return link.labelA;
    if (link.vaultB === vaultId) return link.labelB;
  }
  return null;
}

/** Best label for a raw vault id: the link's own record, else a borrowed
 *  row's holder label, else an HONEST "unknown" — never a raw id standing in
 *  for a name (#726 P6 gap 3). */
function vaultLabel(
  vaultId: string,
  borrowed: readonly AppScopeEntry[],
  links: readonly GatewayLink[]
): string {
  return (
    labelFromLinks(vaultId, links) ??
    borrowed.find((entry) => entry.vaultId === vaultId)?.borrowed
      ?.holderLabel ??
    "Unknown vault"
  );
}

export interface SharingCardProps {
  /** Live clock (parent ticks it) — matches DevicesCard's humanized-age discipline. */
  now: number;
  ownVaultIds: readonly string[];
  loadBorrowed: () => Promise<AppScopeEntry[]>;
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
  /** Stop a lend at its origin — `DELETE /centraid/_gateway/edges/:edgeId`
   *  (#726 P6 gap 1). Optional only for a test double with nothing wired;
   *  every real gateway build answers this route. */
  onStopLending?: (edgeId: string) => Promise<unknown>;
  /** Drop an edge borrowed FROM someone else — the SAME route, the
   *  audience's own local decision. Needs no peer contact to take effect. */
  onStopBorrowing?: (edgeId: string) => Promise<unknown>;
  /** The caller's own per-link borrow-storage budget (#726 P6 gap 2). */
  loadBorrowBudget: (linkId: string) => Promise<BorrowBudget>;
  onSetBorrowBudget: (
    linkId: string,
    budgetBytes: number
  ) => Promise<BorrowBudget>;
  /**
   * The remote link ceremony's owner-facing door (#726 audit finding 1).
   * Optional so an existing caller with nothing wired keeps compiling; both
   * default to the real gateway-client calls, so the feature works even
   * before anything upstream of this card threads its own handler through.
   */
  onMintLinkTicket?: (
    vaultId: string
  ) => Promise<{ vaultId: string; ticket: string; expiresAt: string }>;
  onRedeemLinkTicket?: (
    vaultId: string,
    ticket: string
  ) => ReturnType<typeof redeemGatewayLinkTicket>;
}

const POLL_MS = 20_000;

export default function SharingCard(props: SharingCardProps): JSX.Element {
  const {
    now: _now,
    ownVaultIds,
    loadBorrowed,
    loadLinks,
    onProposeLink,
    onApproveLink,
    loadEdges,
    loadPending,
    onAnswerPending,
    onStopLending,
    onStopBorrowing,
    onMintLinkTicket = mintGatewayLinkTicket,
    onRedeemLinkTicket = redeemGatewayLinkTicket,
  } = props;

  const [borrowed, setBorrowed] = useState<AppScopeEntry[]>([]);
  const [links, setLinks] = useState<GatewayLink[]>([]);
  const [edges, setEdges] = useState<GatewayEdge[]>([]);
  const [pending, setPending] = useState<PendingEdge[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [proposeVault, setProposeVault] = useState(ownVaultIds[0] ?? "");
  const [proposeTarget, setProposeTarget] = useState("");
  const [proposeBusy, setProposeBusy] = useState(false);
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback((): void => {
    Promise.all([loadBorrowed(), loadLinks(), loadEdges(), loadPending()])
      .then(([b, l, e, p]) => {
        if (!mountedRef.current) return;
        setBorrowed(b);
        setLinks(l);
        setEdges(e);
        setPending(p);
        setErrorMessage(null);
      })
      .catch((error: unknown) => {
        if (mountedRef.current)
          setErrorMessage(
            error instanceof Error ? error.message : String(error)
          );
      });
  }, [loadBorrowed, loadLinks, loadEdges, loadPending]);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    const stop = startVisibilityTicker(refresh, POLL_MS);
    return () => {
      mountedRef.current = false;
      stop();
    };
  }, [refresh]);

  const answer = async (edgeId: string, decision: "accept" | "refuse") => {
    setBusyRow(edgeId);
    try {
      await onAnswerPending(edgeId, decision);
      refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current) setBusyRow(null);
    }
  };

  const propose = async () => {
    if (!proposeVault || !proposeTarget.trim()) return;
    setProposeBusy(true);
    try {
      await onProposeLink(proposeVault, proposeTarget.trim());
      setProposeTarget("");
      refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current) setProposeBusy(false);
    }
  };

  const approve = async (linkId: string) => {
    setBusyRow(linkId);
    try {
      await onApproveLink(linkId);
      refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current) setBusyRow(null);
    }
  };

  const stopLending = async (edgeId: string) => {
    if (!onStopLending) return;
    setBusyRow(edgeId);
    try {
      await onStopLending(edgeId);
      refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current) setBusyRow(null);
    }
  };

  const stopBorrowing = async (edgeId: string) => {
    if (!onStopBorrowing) return;
    setBusyRow(edgeId);
    try {
      await onStopBorrowing(edgeId);
      refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current) setBusyRow(null);
    }
  };

  const liveOut = edges.filter((edge) => edge.mode === "live");

  return (
    <section className={cx(gwStyles.panel, deviceStyles.card)}>
      <div className={gwStyles.panelHead}>
        <h2>Sharing</h2>
        <span className={gwStyles.panelMeta}>
          {links.length} {links.length === 1 ? "link" : "links"} ·{" "}
          {borrowed.length} shared with you
        </span>
      </div>

      <div className={deviceStyles.body}>
        {errorMessage ? (
          <div className={deviceStyles.loadError}>{errorMessage}</div>
        ) : null}

        {pending.length > 0 ? (
          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>Waiting for your decision</h3>
            <div className={deviceStyles.list}>
              {pending.map((row) => (
                <div key={row.edgeId} className={deviceStyles.row}>
                  <span className={deviceStyles.glyph} aria-hidden="true">
                    <Icon name="Share" size={15} />
                  </span>
                  <div className={deviceStyles.main}>
                    <div className={deviceStyles.nameLine}>
                      <span className={deviceStyles.name}>
                        {vaultLabel(row.peerVaultId, borrowed, links)} wants to
                        share {row.itemCount} {row.itemType}
                      </span>
                    </div>
                    <div className={deviceStyles.meta}>
                      <span>Parked — nothing has been written yet.</span>
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
                      onClick={() => void answer(row.edgeId, "accept")}
                    >
                      Accept
                    </button>{" "}
                    <button
                      type="button"
                      className={cx(buttonCss.btn, buttonCss.sm)}
                      disabled={busyRow === row.edgeId}
                      onClick={() => void answer(row.edgeId, "refuse")}
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
          <h3 className={styles.sectionTitle}>Shared with me</h3>
          {borrowed.length === 0 ? (
            <div className={gwStyles.panelEmpty}>
              Nobody is lending you anything yet.
            </div>
          ) : (
            <div className={deviceStyles.list}>
              {borrowed.map((entry) => {
                const info = entry.borrowed!;
                return (
                  <div key={info.edgeId} className={deviceStyles.row}>
                    <span className={deviceStyles.glyph} aria-hidden="true">
                      <Icon name="Users" size={15} />
                    </span>
                    <div className={deviceStyles.main}>
                      <div className={deviceStyles.nameLine}>
                        <span className={deviceStyles.name}>
                          {info.holderLabel}
                        </span>
                        <StatusPill tone={reachTone[info.reachState]} tight>
                          {info.reachState}
                        </StatusPill>
                      </div>
                      <div className={deviceStyles.meta}>
                        <span>{info.itemType}</span>
                        {info.mounted ? null : (
                          <span>not holding a device slot right now</span>
                        )}
                      </div>
                      {info.reachState === "parked" && info.reason ? (
                        <div className={styles.reason}>
                          At {info.holderLabel}’s vault — {info.reason}
                        </div>
                      ) : null}
                    </div>
                    <div className={deviceStyles.rowAction}>
                      <button
                        type="button"
                        className={cx(
                          buttonCss.btn,
                          buttonCss.sm,
                          controlsCss.soft
                        )}
                        disabled={!onStopBorrowing || busyRow === info.edgeId}
                        title={
                          onStopBorrowing
                            ? "Drop this window locally. No peer contact needed."
                            : "Stopping a borrow from here isn’t wired to this gateway build yet."
                        }
                        onClick={() => void stopBorrowing(info.edgeId)}
                      >
                        Stop borrowing
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>What you’re lending</h3>
          {liveOut.length === 0 ? (
            <div className={gwStyles.panelEmpty}>
              You aren’t lending any scope right now.
            </div>
          ) : (
            <div className={deviceStyles.list}>
              {liveOut.map((edge) => (
                <div key={edge.edgeId} className={deviceStyles.row}>
                  <span className={deviceStyles.glyph} aria-hidden="true">
                    <Icon name="Share" size={15} />
                  </span>
                  <div className={deviceStyles.main}>
                    <div className={deviceStyles.nameLine}>
                      <span className={deviceStyles.name}>
                        {vaultLabel(edge.audienceVaultId, borrowed, links)}
                      </span>
                      <span className={styles.verbBadge} data-verb="lend">
                        lend
                      </span>
                      <StatusPill
                        tone={
                          edge.status === "established"
                            ? "live"
                            : edge.status === "parked"
                              ? "down"
                              : "draft"
                        }
                        tight
                      >
                        {edge.status}
                      </StatusPill>
                    </div>
                    <div className={deviceStyles.meta}>
                      <span>{edge.itemType}</span>
                    </div>
                    {edge.reason ? (
                      <div className={styles.reason}>{edge.reason}</div>
                    ) : null}
                  </div>
                  <div className={deviceStyles.rowAction}>
                    <button
                      type="button"
                      className={cx(
                        buttonCss.btn,
                        buttonCss.sm,
                        controlsCss.soft
                      )}
                      disabled={!onStopLending || busyRow === edge.edgeId}
                      title={
                        onStopLending
                          ? "Close this window. What was already read stays read."
                          : "Stopping a lend from here isn’t wired to this gateway build yet."
                      }
                      onClick={() => void stopLending(edge.edgeId)}
                    >
                      Stop lending
                    </button>
                  </div>
                </div>
              ))}
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
          <h3 className={styles.sectionTitle}>Links</h3>
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
              type="text"
              className={styles.proposeInput}
              placeholder="Other vault id"
              value={proposeTarget}
              onChange={(event) => setProposeTarget(event.target.value)}
            />
            <button
              type="button"
              className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
              disabled={proposeBusy || !proposeTarget.trim()}
              onClick={() => void propose()}
            >
              <Icon name="Plus" size={12} />
              <span>Propose link</span>
            </button>
          </div>
          {links.length === 0 ? (
            <div className={gwStyles.panelEmpty}>No links yet.</div>
          ) : (
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
                    otherLabel={vaultLabel(other, borrowed, links)}
                    mineApproved={mineApproved}
                    busy={busyRow === link.linkId}
                    onApprove={() => void approve(link.linkId)}
                    loadReceiveSetting={props.loadReceiveSetting}
                    onSetReceiveSetting={props.onSetReceiveSetting}
                    loadBorrowBudget={props.loadBorrowBudget}
                    onSetBorrowBudget={props.onSetBorrowBudget}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
