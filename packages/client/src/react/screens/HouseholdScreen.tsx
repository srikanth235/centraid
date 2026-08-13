import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";

import type {
  CentraidGatewayDevice,
  GatewayDeviceTicket,
  GatewayDeviceTicketInput,
  GatewayLink,
  PendingEdge,
} from "../../gateway-client.js";
import type { OwnerScope } from "../shell/ownerScope.js";
import { startVisibilityTicker } from "../shell/routes/visibility-ticker.js";
import {
  clearRouteSignals,
  publishRouteSignals,
  publishRouteVerbs,
} from "../shell/routeVitals.js";
import { PageSkeleton } from "../shell/status.js";
import Button from "../ui/Button.js";
import EmptyBlock from "../ui/EmptyBlock.js";
import NoteBlock from "../ui/NoteBlock.js";
import PanelBlock from "../ui/PanelBlock.js";
import RowsBlock from "../ui/RowsBlock.js";
import type { RowDef } from "../ui/RowsBlock.js";
import SectionBlock from "../ui/SectionBlock.js";
import { dateLabel } from "./DeviceRow.js";
import DevicesCard, { useDeviceRoster } from "./DevicesCard.js";
import type { DeviceRosterWiring } from "./DevicesCard.js";
import SharingCard from "./SharingCard.js";
import type { SharingCardProps } from "./SharingCard.js";

import styles from "./HouseholdScreen.module.css";

// Devices (issues #599, #726; v9 shape #765) — the page that answers "which
// machines hold a copy of this vault, and whose are they".
//
// The v9 body is a sequence of section-headed row blocks, and the page's
// identity — title, count line, the two verbs, the health sentence — is the
// frame's app bar and status line, published from here as the roster resolves
// (`routeVitals.ts`). Nothing on this page draws its own header.
//
// Sections the product actually wires, in the order the questions get asked:
//
//   Yours / Other people — the roster, split by whose hardware it is.
//   Vaults you own       — the owner's scope registry, which is also what
//                          every "which vault?" picker resolves against, so
//                          the page and the pickers can never disagree.
//   Sharing              — the links/edges/shared-space surface, still in its
//                          pre-v9 card while it awaits its own pass. The v9
//                          brief's "Other gateways" and its "two of three
//                          people you nominate" recovery are NOT drawn: this
//                          product has vault-to-vault links (locality is
//                          routing, not semantics — #726 D3) and shared-space
//                          steward recovery, neither of which is the thing
//                          those sections describe.

/** A host with no device plane still renders the page — it simply has no
 *  roster to show. Module-level so the hook's inputs stay referentially
 *  stable across renders. */
const NO_DEVICES = async (): Promise<CentraidGatewayDevice[]> => [];
const NO_REVOKE = async (): Promise<{ removed: boolean }> => ({
  removed: false,
});
const NO_LINKS = async (): Promise<GatewayLink[]> => [];
const NO_PENDING = async (): Promise<PendingEdge[]> => [];

/** How often the page re-reads what is waiting on somebody's decision. */
const PENDING_POLL_MS = 30_000;

export interface HouseholdScreenProps {
  /** Live clock (route ticks it) — drives the roster's humanized ages. */
  now: number;
  /** Vaults the calling owner owns, own vault first. */
  vaults: OwnerScope[];
  /** The shell's default/active scope pointer — marks one row "Default". */
  defaultScopeId: string;
  /** True until the scope registry's first fetch settles. */
  vaultsLoading?: boolean;
  /** Local disk footprint + limits (Gateway → Storage). */
  onOpenStorage: () => void;
  /** Open the "new vault" sheet. Omitted (a gateway this client can't create
   *  vaults on) hides the affordance rather than offering a failing button. */
  onNewVault?: () => void;
  /** Settings → Vault. Only offered for the default vault: that settings page
   *  edits whichever vault the client currently resolves to, so pointing it at
   *  another row's vault would quietly edit the wrong one. */
  onOpenVaultSettings?: () => void;
  /** Roster wiring. Optional so a host that can't list devices (or a test)
   *  renders the page without the roster rather than crashing. */
  loadDevices?: DeviceRosterWiring["loadDevices"];
  onRevokeDevice?: DeviceRosterWiring["onRevokeDevice"];
  onRenameDevice?: DeviceRosterWiring["onRenameDevice"];
  onCurrentDeviceRevoked?: DeviceRosterWiring["onCurrentDeviceRevoked"];
  loadOwners?: DeviceRosterWiring["loadOwners"];
  onCreateDeviceTicket?: (
    input?: GatewayDeviceTicketInput
  ) => Promise<GatewayDeviceTicket>;
  onUpdateDeviceCompute?: DeviceRosterWiring["onUpdateCompute"];
  loadDeviceWorkStatus?: DeviceRosterWiring["loadWorkStatus"];
  /** Sharing wiring (#726 P6). Optional so a gateway with no edge/link plane
   *  (or a test) renders the page without it. */
  sharing?: SharingCardProps;
}

/** One thing waiting on this owner's decision, said as a sentence. */
interface PendingRequest {
  id: string;
  sentence: string;
}

/** Whose vault the other end of a link is, by that side's own label. */
function otherSide(
  link: GatewayLink,
  ownVaultIds: readonly string[]
): { label: string; mineApproved: boolean } {
  const mineIsA = ownVaultIds.includes(link.vaultA);
  return {
    label:
      (mineIsA ? link.labelB : link.labelA) ??
      // A link proposed before labels were recorded still has to name
      // somebody; it names the relationship instead of a wire id.
      "Someone you are linked with",
    mineApproved: mineIsA ? link.approvedByA : link.approvedByB,
  };
}

/**
 * What is waiting on a decision: a link the other side proposed and this owner
 * has not answered, and a parked share nobody has accepted yet. Both are
 * "somebody asked" — the page counts them together and the status line reads
 * the first one out loud.
 */
function pendingRequests(
  links: readonly GatewayLink[],
  pending: readonly PendingEdge[],
  ownVaultIds: readonly string[]
): PendingRequest[] {
  const fromLinks = links
    .filter((link) => !link.revoked && !link.approved)
    .map((link) => ({ link, side: otherSide(link, ownVaultIds) }))
    .filter(({ side }) => !side.mineApproved)
    .map(({ link, side }) => ({
      id: `link:${link.linkId}`,
      sentence: `${side.label} asked to connect on ${dateLabel(link.createdAt)}.`,
    }));
  const fromEdges = pending.map((edge) => ({
    id: `edge:${edge.edgeId}`,
    sentence: `Somebody asked to send you ${edge.itemCount} ${edge.itemType} on ${dateLabel(edge.createdAt)}.`,
  }));
  return [...fromLinks, ...fromEdges];
}

/** The pending half of the page's health, polled beside the roster. */
function usePendingRequests(
  sharing: SharingCardProps | undefined,
  ownVaultIds: readonly string[]
): PendingRequest[] {
  const loadLinks = sharing?.loadLinks ?? NO_LINKS;
  const loadPending = sharing?.loadPending ?? NO_PENDING;
  const [links, setLinks] = useState<GatewayLink[]>([]);
  const [pending, setPending] = useState<PendingEdge[]>([]);
  const ownKey = ownVaultIds.join("\0");
  useEffect(() => {
    let live = true;
    const read = (): void => {
      void loadLinks()
        .then((rows) => {
          if (live) setLinks(rows);
        })
        // A gateway that won't answer about links has already said so through
        // the roster's own error; the health line just stays quiet.
        .catch(() => undefined);
      void loadPending()
        .then((rows) => {
          if (live) setPending(rows);
        })
        .catch(() => undefined);
    };
    read();
    const stop = startVisibilityTicker(read, PENDING_POLL_MS);
    return () => {
      live = false;
      stop();
    };
  }, [loadLinks, loadPending]);
  return useMemo(
    () => pendingRequests(links, pending, ownKey ? ownKey.split("\0") : []),
    [links, ownKey, pending]
  );
}

/** The vaults block — one row per vault, its two settings doors in the row's
 *  own detail so the block keeps one action per row. */
function VaultRows({
  vaults,
  defaultScopeId,
  onOpenStorage,
  onOpenVaultSettings,
}: {
  vaults: readonly OwnerScope[];
  defaultScopeId: string;
  onOpenStorage: () => void;
  onOpenVaultSettings?: () => void;
}): JSX.Element {
  const [openId, setOpenId] = useState<string | null>(null);
  const rows: RowDef[] = vaults.map((vault) => {
    const isDefault = vault.id === defaultScopeId;
    const open = openId === vault.id;
    return {
      action: {
        label: open ? "Close" : "Manage",
        onClick: () =>
          setOpenId((current) => (current === vault.id ? null : vault.id)),
      },
      id: vault.id,
      sub: "You own this vault.",
      title: vault.label,
      ...(isDefault ? { meta: "Default" } : {}),
      ...(open
        ? {
            children: (
              <div className={styles.detailActions}>
                <Button
                  commit={false}
                  label="Storage & backups"
                  onClick={() => onOpenStorage()}
                  size="sm"
                  variant="secondary"
                />
                {/* Settings → Vault edits whichever vault the client resolves
                    to, so it is offered only where it cannot mis-target. */}
                {isDefault && onOpenVaultSettings ? (
                  <Button
                    commit={false}
                    label="Vault settings"
                    onClick={() => onOpenVaultSettings()}
                    size="sm"
                    variant="secondary"
                  />
                ) : null}
              </div>
            ),
          }
        : {}),
    };
  });
  return <RowsBlock rows={rows} />;
}

export default function HouseholdScreen(
  props: HouseholdScreenProps
): JSX.Element {
  const { defaultScopeId, now, sharing, vaults, vaultsLoading } = props;
  const [pairing, setPairing] = useState(false);
  const sharingRef = useRef<HTMLDivElement | null>(null);
  const hasRoster = Boolean(props.loadDevices && props.onRevokeDevice);
  const roster = useDeviceRoster({
    loadDevices: props.loadDevices ?? NO_DEVICES,
    onRevokeDevice: props.onRevokeDevice ?? NO_REVOKE,
    ...(props.loadOwners ? { loadOwners: props.loadOwners } : {}),
    ...(props.loadDeviceWorkStatus
      ? { loadWorkStatus: props.loadDeviceWorkStatus }
      : {}),
    ...(props.onCurrentDeviceRevoked
      ? { onCurrentDeviceRevoked: props.onCurrentDeviceRevoked }
      : {}),
    ...(props.onRenameDevice ? { onRenameDevice: props.onRenameDevice } : {}),
    ...(props.onUpdateDeviceCompute
      ? { onUpdateCompute: props.onUpdateDeviceCompute }
      : {}),
  });
  const ownVaultIds = useMemo(() => vaults.map((vault) => vault.id), [vaults]);
  const requests = usePendingRequests(sharing, ownVaultIds);

  // Only this device is enrolled — the healthy first state of a consent
  // surface, not a failure. A gateway with no device plane at all is a
  // different sentence, said below.
  const onlyThisDevice =
    roster.deviceCount === 0 ||
    (roster.deviceCount === 1 && roster.self?.devices[0]?.current === true);
  // The page's five states are the ROSTER's: devices are what this page is
  // about. The vault block says its own "still reading" line rather than
  // holding the whole page in a skeleton for a second loader.
  const state =
    roster.status === "loading"
      ? "loading"
      : roster.status === "error"
        ? "error"
        : onlyThisDevice
          ? "empty"
          : "ready";

  const hasSharing = sharing !== undefined;
  const reviewPending = useCallback(() => {
    sharingRef.current?.scrollIntoView({ block: "start" });
  }, []);
  const openPairing = useCallback(() => setPairing(true), []);

  // The count line and the status line come from one publish, so the bar can
  // never read "4 devices" over a status line still reading "Reading from the
  // gateway". Both are cleared on unmount.
  const devices = `${roster.deviceCount} device${roster.deviceCount === 1 ? "" : "s"}`;
  const people = `${roster.personCount} ${roster.personCount === 1 ? "person" : "people"}`;
  const health = useMemo(
    () =>
      requests[0]
        ? {
            action: { label: "Review it", run: reviewPending },
            detail: requests[0].sentence,
            label: `${requests.length} request${requests.length === 1 ? " is" : "s are"} pending`,
          }
        : {
            detail: "Every device that can reach this vault is one you paired.",
            label: "No requests are pending",
          },
    [requests, reviewPending]
  );
  const count =
    state === "empty"
      ? "This device only"
      : `${devices} · ${people} · ${requests.length} pending`;
  useEffect(() => {
    publishRouteSignals("household", {
      count,
      health,
      state,
      ...(requests.length > 0 ? { tone: "seam" as const } : {}),
    });
    // `health` is rebuilt every render; its CONTENT is what matters, and the
    // channel itself drops a republish that says the same thing.
  }, [count, health, requests.length, state]);
  useEffect(() => () => clearRouteSignals("household"), []);
  useEffect(() => {
    // The commit opens this page's own pairing panel rather than the shell's
    // modal: pairing here refreshes the roster it just changed.
    publishRouteVerbs("household", {
      onCommit: openPairing,
      // "Recovery" is honest only where there is a recovery surface to open:
      // this product's is the shared-space steward ceremony inside the sharing
      // card, so the verb scrolls to it and is withheld when it is absent.
      ...(hasSharing ? { onSecondary: reviewPending } : {}),
    });
    // `hasSharing`, not the props object: the route rebuilds that every clock
    // tick, and republishing the verbs once a second would wake the frame for
    // nothing.
  }, [hasSharing, openPairing, reviewPending]);

  return (
    <div className={styles.page}>
      {state === "loading" ? (
        <>
          <PageSkeleton rows={6} label="Reading the roster" />
          <NoteBlock>
            A row knows its shape before its content arrives, so nothing reflows
            when it does.
          </NoteBlock>
        </>
      ) : state === "error" ? (
        <PanelBlock
          action={{ label: "Try again", onClick: roster.refresh }}
          body="This page is being served from a cached copy. Device pairing and revocation both need the gateway, so both are unavailable until it answers."
          eyebrow="Devices"
          title="Cannot reach the gateway"
          tone="net"
          wide
        />
      ) : hasRoster ? (
        state === "empty" ? (
          <EmptyBlock
            action={{ label: "Pair a device", onClick: openPairing }}
            body="Pair a phone or a laptop to reach this vault from it. Everything stays on your own machines."
            routine
            title="Only this device is enrolled"
          />
        ) : null
      ) : (
        <EmptyBlock
          body="Pairing and revocation both live on the gateway, so neither is offered here."
          routine
          title="This connection doesn’t report a roster"
        />
      )}

      {hasRoster && state !== "loading" && state !== "error" ? (
        <DevicesCard
          now={now}
          onPairingChange={setPairing}
          pairing={pairing}
          roster={roster}
          {...(props.onCreateDeviceTicket
            ? { onCreateTicket: props.onCreateDeviceTicket }
            : {})}
        />
      ) : null}

      {state === "loading" ? null : (
        <>
          <SectionBlock label="Vaults you own" meta={String(vaults.length)} />
          {vaults.length > 0 ? (
            <VaultRows
              defaultScopeId={defaultScopeId}
              onOpenStorage={props.onOpenStorage}
              vaults={vaults}
              {...(props.onOpenVaultSettings
                ? { onOpenVaultSettings: props.onOpenVaultSettings }
                : {})}
            />
          ) : (
            <NoteBlock>
              {vaultsLoading
                ? "Loading vaults…"
                : "No vaults are reachable from this device."}
            </NoteBlock>
          )}
          {props.onNewVault ? (
            <p className={styles.asideAction}>
              <Button
                commit={false}
                label="New vault"
                onClick={() => props.onNewVault?.()}
                size="sm"
                variant="secondary"
              />
            </p>
          ) : null}

          {sharing ? (
            <div className={styles.sharing} ref={sharingRef}>
              {/* Links, parked shares and the shared-space steward ceremony
                  still render in their pre-v9 card: they are the sharing
                  surface's own vocabulary, and rebuilding them as "other
                  gateways" would state a local/remote distinction this product
                  refuses (#726 D3). */}
              <SharingCard {...sharing} />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
