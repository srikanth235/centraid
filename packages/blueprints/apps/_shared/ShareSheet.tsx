/** Ceremony-free commons ShareSheet: pick people, choose capability, share. */
import { useEffect, useRef, useState } from "react";

import type { InlineScope } from "../inline-types.ts";
import { commonsInviteMessage, encodeCommonsInvite } from "./commons-invite.ts";
import { manualShareSelection } from "./named-circle-selection.ts";
import type { PlaceableItemType } from "./placement-registry.ts";
import {
  loadShareDestinations,
  loadShareCircles,
  nearNameMatches,
  quickAddedDestination,
  selectionsForCircle,
  selectedShareMembers,
  shareBlockedReason,
  withQuickAddedPerson,
} from "./share-kit.ts";
import type { ShareCircle, ShareDestination } from "./share-kit.ts";
import { SHARE_FAILED, sharedWithOutcome } from "./shared-copy.ts";

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
  /**
   * The label of a named circle (`ShareCircle.label`) to preselect the
   * moment circles finish loading — for a container that reuses its OWN
   * named circle, i.e. a group sharing itself (issue #731 M3). A container
   * like that is bound to that circle's exact stored roster + capabilities
   * server-side regardless of what this sheet submits, so leaving the
   * picker on "choose people individually" (every new pick defaulting to
   * `read+write`) refuses with the commons layer's exact-roster message the
   * moment a submitted capability drifts from what's stored. Preselecting
   * the matching circle sources each person's capability from its OWN
   * stored roster (`selectionsForCircle`), so the default path submits
   * exactly what the commons layer already expects.
   */
  preferredCircleLabel?: string;
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
  const [quickAddName, setQuickAddName] = useState("");
  const [quickAddBusy, setQuickAddBusy] = useState(false);
  // Non-empty only while an ambiguous name waits for a second, explicit press
  // (#630): nothing is minted until the person confirms these are not them.
  const [quickAddMatches, setQuickAddMatches] = useState<ShareDestination[]>(
    []
  );
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
      setQuickAddName("");
      setQuickAddBusy(false);
      setQuickAddMatches([]);
      try {
        const [rows, namedCircles] = await Promise.all([
          loadShareDestinations(props.sourceScopeId, props.scopes),
          loadShareCircles(),
        ]);
        if (!active) return;
        setDestinations(rows);
        setCircles(namedCircles);
        // Auto-reuse the item's own named circle when there is one (see
        // `preferredCircleLabel` above) — sourcing selections from the
        // circle's stored roster, not a blank slate defaulting new picks to
        // `read+write`.
        const preferredCircle = props.preferredCircleLabel
          ? namedCircles.find(
              (circle) => circle.label === props.preferredCircleLabel
            )
          : undefined;
        if (preferredCircle) {
          setSelectedCircleId(preferredCircle.circleId);
          setSelections(selectionsForCircle(rows, preferredCircle));
        } else {
          setSelections({});
        }
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
  }, [
    props.open,
    props.scopes,
    props.sourceScopeId,
    props.preferredCircleLabel,
  ]);

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
  const preferredCircle = props.preferredCircleLabel
    ? circles.find((circle) => circle.label === props.preferredCircleLabel)
    : undefined;
  const isPreferredCircleSelected =
    Boolean(preferredCircle) && selectedCircleId === preferredCircle?.circleId;
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

  // The host mints People identities only where it can settle a real party id;
  // where it cannot, the sheet offers no affordance at all.
  const canQuickAdd = typeof window.centraid?.quickAddPerson === "function";

  const submitQuickAdd = async (): Promise<void> => {
    const name = quickAddName.trim();
    if (!name || quickAddBusy) return;
    const listed = destinations ?? [];
    if (!quickAddMatches.length) {
      const matches = nearNameMatches(listed, name);
      if (matches.length) {
        // First press on an ambiguous name only asks; the write waits.
        setQuickAddMatches(matches);
        return;
      }
    }
    setQuickAddBusy(true);
    try {
      const person = await window.centraid.quickAddPerson!({ name });
      const added = quickAddedDestination(person.partyId, person.label);
      setDestinations(withQuickAddedPerson(listed, added));
      // A person added by hand is an individual roster edit, so the share
      // detaches from any named circle exactly as a checkbox edit does.
      setSelections((previous) => ({ ...previous, [added.id]: "read" }));
      setSelectedCircleId("");
      setQuickAddName("");
      setQuickAddMatches([]);
      setErrorMessage(null);
    } catch (error) {
      // The typed name survives a refusal — nothing typed is lost.
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "That person could not be added."
      );
    } finally {
      setQuickAddBusy(false);
    }
  };

  const quickAdd = canQuickAdd ? (
    <div className={styles.quickAdd}>
      <label className={styles.quickAddField}>
        Add someone by name
        <input
          value={quickAddName}
          placeholder="Name"
          onChange={(event) => {
            setQuickAddName(event.target.value);
            // A changed name re-arms the confirmation gate.
            setQuickAddMatches([]);
          }}
        />
      </label>
      {quickAddMatches.length ? (
        <p className={styles.quickAddHint}>
          Already on your list:{" "}
          {quickAddMatches.map((match) => match.label).join(", ")}. That may
          already be this person.
        </p>
      ) : null}
      <button
        type="button"
        className="kit-btn"
        disabled={!quickAddName.trim() || quickAddBusy}
        onClick={() => void submitQuickAdd()}
      >
        {quickAddBusy
          ? "Adding…"
          : quickAddMatches.length
            ? "Add anyway"
            : "Add person"}
      </button>
    </div>
  ) : null;

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
        message: sharedWithOutcome(selected.length, invited),
      });
      if (handoffs.length) {
        setInviteHandoffs(handoffs);
        setBusy(false);
      } else props.onClose();
    } catch (error) {
      setBusy(false);
      setErrorMessage(error instanceof Error ? error.message : SHARE_FAILED);
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
          Each person who joins stores a full copy in their vault and backup.
        </p>
        {destinations === null ? (
          <p className={styles.note}>Finding people…</p>
        ) : blocked ? (
          <>
            <p className={styles.note}>{blocked}</p>
            {quickAdd}
          </>
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
            {isPreferredCircleSelected ? (
              <p className={styles.preselected}>
                Sharing with {preferredCircle?.label}&apos;s existing members,
                each kept at their current access.
              </p>
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
              {quickAdd}
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
              One per person — each is redeemed once, in the receiver's own
              vault.
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
