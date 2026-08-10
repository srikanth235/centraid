/** Ceremony-free commons ShareSheet: pick people, choose capability, share. */
import { useEffect, useRef, useState } from "react";

import type { InlineScope } from "../inline-types.ts";
import { commonsInviteMessage, encodeCommonsInvite } from "./commons-invite.ts";
import { manualShareSelection } from "./named-circle-selection.ts";
import type { PlaceableItemType } from "./placement-registry.ts";
import {
  loadShareDestinations,
  loadShareCircles,
  selectionsForCircle,
  selectedShareMembers,
  shareBlockedReason,
} from "./share-kit.ts";
import type { ShareCircle, ShareDestination } from "./share-kit.ts";

import styles from "./ShareSheet.module.css";

export type ShareVerb = "share";

interface InviteHandoff {
  partyId: string;
  label: string;
  uri: string;
}

export interface ShareSheetProps {
  open: boolean;
  onClose: () => void;
  sourceScopeId: string;
  scopes: readonly InlineScope[];
  itemType?: PlaceableItemType;
  itemIds?: readonly string[];
  appLabel?: string;
  onDone: (outcome: { verb: ShareVerb; ok: boolean; message: string }) => void;
}

export function ShareSheet(props: ShareSheetProps) {
  const [destinations, setDestinations] = useState<ShareDestination[] | null>(
    null
  );
  const [selections, setSelections] = useState<
    Record<string, "read" | "read+write">
  >({});
  const [circles, setCircles] = useState<ShareCircle[]>([]);
  const [selectedCircleId, setSelectedCircleId] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [inviteHandoffs, setInviteHandoffs] = useState<InviteHandoff[]>([]);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!props.open) return;
    let active = true;
    void Promise.resolve().then(async () => {
      if (!active) return;
      setBusy(false);
      setErrorMessage(null);
      setDestinations(null);
      setSelectedCircleId("");
      setInviteHandoffs([]);
      try {
        const [rows, namedCircles] = await Promise.all([
          loadShareDestinations(props.sourceScopeId, props.scopes),
          loadShareCircles(),
        ]);
        if (!active) return;
        setDestinations(rows);
        setCircles(namedCircles);
        setSelections({});
      } catch (error) {
        if (!active) return;
        setDestinations([]);
        setErrorMessage(
          error instanceof Error ? error.message : "People could not be loaded."
        );
      }
    });
    return () => {
      active = false;
    };
  }, [props.open, props.scopes, props.sourceScopeId]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !props.open) return;
    dialog.showModal?.();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [props.open]);

  if (!props.open) return null;
  const blocked = destinations ? shareBlockedReason(destinations) : null;
  const selected = (destinations ?? []).flatMap((destination) => {
    const capability = selections[destination.id];
    return capability ? [{ destination, capability }] : [];
  });
  const members = selectedShareMembers(destinations ?? [], selections);

  const toggle = (destination: ShareDestination): void => {
    const next = manualShareSelection(
      selections,
      destination.id,
      selections[destination.id] ? undefined : "read+write"
    );
    setSelectedCircleId(next.circleId);
    setSelections(next.selections);
  };

  const run = async (): Promise<void> => {
    if (!selected.length || !props.itemType || !props.itemIds?.length) return;
    setBusy(true);
    try {
      const results = await Promise.all(
        props.itemIds.map((containerId) =>
          window.centraid.share!({
            sourceVaultId: props.sourceScopeId,
            containerType: props.itemType!,
            containerId,
            members,
            ...(selectedCircleId ? { circleId: selectedCircleId } : {}),
          })
        )
      );
      const handoffs = results.flatMap((result) =>
        (result.claims ?? []).map((claim) => {
          const destination = selected.find(
            ({ destination: candidate }) => candidate.partyId === claim.partyId
          )?.destination;
          return {
            partyId: claim.partyId,
            label: destination?.label ?? "Invited person",
            uri: encodeCommonsInvite({
              stewardVaultId: props.sourceScopeId,
              claimToken: claim.claimToken,
            }),
          };
        })
      );
      const invited = selected.filter(
        ({ destination }) => !destination.vaultId
      ).length;
      props.onDone({
        verb: "share",
        ok: true,
        message: invited
          ? `Shared with ${selected.length} people; ${invited} ${invited === 1 ? "is" : "are"} invited and will join after creating a vault.`
          : `Shared with ${selected.length} ${selected.length === 1 ? "person" : "people"}.`,
      });
      if (handoffs.length) {
        setInviteHandoffs(handoffs);
        setBusy(false);
      } else props.onClose();
    } catch (error) {
      setBusy(false);
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Could not share with the selected people."
      );
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="kit-modal-back"
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
    >
      <button
        type="button"
        className="kit-modal-scrim"
        aria-label="Close"
        onClick={props.onClose}
      />
      <div className="kit-modal" style={{ maxWidth: "420px" }}>
        <h2>Share</h2>
        <p className={styles.note}>
          Pick people. Each person who joins stores a full copy in their vault
          and backup.
        </p>
        {destinations === null ? (
          <p className={styles.note}>Finding people…</p>
        ) : blocked ? (
          <p className={styles.note}>{blocked}</p>
        ) : (
          <>
            {circles.length ? (
              <label className={styles.circleChoice}>
                Reuse a named circle (optional)
                <select
                  value={selectedCircleId}
                  onChange={(event) => {
                    const circleId = event.target.value;
                    setSelectedCircleId(circleId);
                    const circle = circles.find(
                      (candidate) => candidate.circleId === circleId
                    );
                    setSelections(
                      circle ? selectionsForCircle(destinations, circle) : {}
                    );
                  }}
                >
                  <option value="">Choose people individually</option>
                  {circles.map((circle) => (
                    <option key={circle.circleId} value={circle.circleId}>
                      Named group · {circle.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <fieldset className={styles.destList} aria-label="People">
              {destinations.map((destination) => {
                const capability = selections[destination.id];
                return (
                  <div className={styles.destItem} key={destination.id}>
                    <label className={styles.personChoice}>
                      <input
                        type="checkbox"
                        checked={Boolean(capability)}
                        onChange={() => toggle(destination)}
                      />
                      <span>
                        {destination.label}
                        {destination.vaultId ? null : (
                          <small className={styles.invited}>
                            Invited — waiting for a vault
                          </small>
                        )}
                      </span>
                    </label>
                    {capability ? (
                      <select
                        aria-label={`${destination.label} capability`}
                        value={capability}
                        onChange={(event) => {
                          const next = manualShareSelection(
                            selections,
                            destination.id,
                            event.target.value as "read" | "read+write"
                          );
                          setSelectedCircleId(next.circleId);
                          setSelections(next.selections);
                        }}
                      >
                        <option value="read+write">Can edit</option>
                        <option value="read">Can view</option>
                      </select>
                    ) : null}
                  </div>
                );
              })}
            </fieldset>
          </>
        )}
        <p className={styles.note}>
          Someone without a vault remains invited until they install, create a
          vault, and accept.
        </p>
        {errorMessage ? <p className={styles.error}>{errorMessage}</p> : null}
        {inviteHandoffs.length ? (
          <section className={styles.handoffs} aria-label="Share invitations">
            <h3>Send these one-time invitations</h3>
            <p className={styles.note}>
              Each person installs Centraid, creates a vault, connects to you if
              remote, redeems this invitation, then accepts its size.
            </p>
            {inviteHandoffs.map((handoff, index) => {
              const message = commonsInviteMessage(handoff.uri);
              return (
                <div
                  className={styles.handoff}
                  key={`${handoff.partyId}:${index}`}
                >
                  <strong>{handoff.label}</strong>
                  <div>
                    <button
                      type="button"
                      className="kit-btn"
                      onClick={() =>
                        void navigator.clipboard
                          .writeText(message)
                          .catch(() =>
                            setErrorMessage("Invitation could not be copied.")
                          )
                      }
                    >
                      Copy invite
                    </button>{" "}
                    <button
                      type="button"
                      className="kit-btn"
                      onClick={() =>
                        void (
                          navigator.share
                            ? navigator.share({
                                title: `Centraid invitation for ${handoff.label}`,
                                text: message,
                              })
                            : navigator.clipboard.writeText(message)
                        ).catch(() =>
                          setErrorMessage("Invitation could not be shared.")
                        )
                      }
                    >
                      Share invite
                    </button>
                  </div>
                </div>
              );
            })}
          </section>
        ) : null}
        <div className="kit-modal-foot">
          {inviteHandoffs.length ? (
            <button
              type="button"
              className="kit-btn primary"
              onClick={() => {
                setInviteHandoffs([]);
                props.onClose();
              }}
            >
              Done
            </button>
          ) : (
            <>
              <button type="button" className="kit-btn" onClick={props.onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="kit-btn primary"
                disabled={selected.length === 0 || busy}
                onClick={() => void run()}
              >
                {busy ? "Sharing…" : "Share"}
              </button>
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}
