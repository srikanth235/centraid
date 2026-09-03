import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";

import { parseLociBody } from "../../access-lens.js";
import { DEVICES_EMPTY_BODY, DEVICES_EMPTY_TITLE } from "../../devices-copy.js";
import type {
  CentraidGatewayDevice,
  GatewayDeviceTicket,
  GatewayDeviceTicketInput,
  GatewayLink,
} from "../../gateway-client.js";
import type { OpsState } from "../shell/opsBar.js";
import type { OwnerScope } from "../shell/ownerScope.js";
import { accessRegistryReader } from "../shell/routes/settingsAccessData.js";
import { startVisibilityTicker } from "../shell/routes/visibility-ticker.js";
import {
  clearRouteSignals,
  publishRouteSignals,
  publishRouteVerbs,
} from "../shell/routeVitals.js";
import type { RouteHealth } from "../shell/routeVitals.js";
import { PageSkeleton } from "../shell/status.js";
import Button from "../ui/Button.js";
import EmptyBlock from "../ui/EmptyBlock.js";
import NoteBlock from "../ui/NoteBlock.js";
import PanelBlock from "../ui/PanelBlock.js";
import RowsBlock from "../ui/RowsBlock.js";
import type { RowDef } from "../ui/RowsBlock.js";
import SectionBlock from "../ui/SectionBlock.js";
import type { OwnerGroup } from "./device-groups.js";
import { dateLabel } from "./DeviceRow.js";
import DevicesCard, { useDeviceRoster } from "./DevicesCard.js";
import type { DeviceRosterWiring } from "./DevicesCard.js";
import SharingCard from "./SharingCard.js";
import type { SharingCardProps } from "./SharingCard.js";
import { custodyCounts, custodyLine } from "./vault-custody.js";

import styles from "./HouseholdScreen.module.css";

const NO_DEVICES = async (): Promise<CentraidGatewayDevice[]> => [];
const NO_REVOKE = async (): Promise<{ removed: boolean }> => ({
  removed: false,
});
const NO_LINKS = async (): Promise<GatewayLink[]> => [];

const PENDING_POLL_MS = 30_000;

export interface HouseholdScreenProps {
  now: number;
  vaults: OwnerScope[];
  defaultScopeId: string;
  vaultsLoading?: boolean;
  onOpenStorage: () => void;
  onNewVault?: () => void;
  onOpenVaultSettings?: () => void;
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
  sharing?: SharingCardProps;
  embedded?: boolean;
  records?: number | null;
  onReport?: (report: HouseholdReport) => void;
  collapsed?: boolean;
  onToggle?: () => void;
}

export interface HouseholdReport {
  state: OpsState;
  custody: string;
  deviceCount: number;
  personCount: number;
  pendingCount: number;
  health: RouteHealth;
  openPairing: () => void;
  reviewPending: () => void;
}

interface PendingRequest {
  id: string;
  sentence: string;
}

function otherSide(
  link: GatewayLink,
  ownVaultIds: readonly string[]
): { label: string; mineApproved: boolean } {
  const mineIsA = ownVaultIds.includes(link.vaultA);
  return {
    label:
      (mineIsA ? link.labelB : link.labelA) ?? "Someone you are linked with",
    mineApproved: mineIsA ? link.approvedByA : link.approvedByB,
  };
}

function pendingRequests(
  links: readonly GatewayLink[],
  ownVaultIds: readonly string[]
): PendingRequest[] {
  return links
    .filter((link) => !link.revoked && !link.approved)
    .map((link) => ({ link, side: otherSide(link, ownVaultIds) }))
    .filter(({ side }) => !side.mineApproved)
    .map(({ link, side }) => ({
      id: `link:${link.linkId}`,
      sentence: `${side.label} asked to connect on ${dateLabel(link.createdAt)}.`,
    }));
}

function usePendingRequests(
  sharing: SharingCardProps | undefined,
  ownVaultIds: readonly string[]
): PendingRequest[] {
  const loadLinks = sharing?.loadLinks ?? NO_LINKS;
  const [links, setLinks] = useState<GatewayLink[]>([]);
  const ownKey = ownVaultIds.join("\0");
  useEffect(() => {
    let live = true;
    const read = (): void => {
      void loadLinks()
        .then((rows) => {
          if (live) setLinks(rows);
        })
        .catch(() => undefined);
    };
    read();
    const stop = startVisibilityTicker(read, PENDING_POLL_MS);
    return () => {
      live = false;
      stop();
    };
  }, [loadLinks]);
  return useMemo(
    () => pendingRequests(links, ownKey ? ownKey.split("\0") : []),
    [links, ownKey]
  );
}

function VaultRows({
  vaults,
  defaultScopeId,
  onOpenVaultSettings,
}: {
  vaults: readonly OwnerScope[];
  defaultScopeId: string;
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
                {/* Only where it cannot mis-target. */}
                {isDefault && onOpenVaultSettings ? (
                  <Button
                    commit={false}
                    label="Vault settings"
                    onClick={() => onOpenVaultSettings()}
                    size="sm"
                    variant="secondary"
                  />
                ) : (
                  <span className={styles.detailAsk}>
                    Settings edit the vault this device resolves to.
                  </span>
                )}
              </div>
            ),
          }
        : {}),
    };
  });
  return <RowsBlock rows={rows} />;
}

function PeopleRows({
  people,
}: {
  people: readonly OwnerGroup[];
}): JSX.Element {
  const rows: RowDef[] = people.map((person) => ({
    id: person.ownerId,
    sub: [
      `${person.devices.length} device${person.devices.length === 1 ? "" : "s"}`,
      `${person.vaults.length} vault${person.vaults.length === 1 ? "" : "s"}`,
    ].join(" · "),
    title: person.isSelf ? `${person.label} · you` : person.label,
  }));
  return <RowsBlock ariaLabel="People" rows={rows} stacked />;
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

  const [boundaryPromise, setBoundaryPromise] = useState<string>("");
  useEffect(() => {
    if (!hasRoster) return undefined;
    let cancelled = false;
    void accessRegistryReader()
      .then((registry) => registry.subjects())
      .then((body) => {
        if (!cancelled) setBoundaryPromise(parseLociBody(body).boundary ?? "");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [hasRoster]);

  const ownVaultIds = useMemo(() => vaults.map((vault) => vault.id), [vaults]);
  const requests = usePendingRequests(sharing, ownVaultIds);

  const onlyThisDevice =
    roster.deviceCount === 0 ||
    (roster.deviceCount === 1 && roster.self?.devices[0]?.current === true);
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

  const everyDevice = useMemo(
    () => [
      ...(roster.self?.devices ?? []),
      ...roster.others.flatMap((group) => group.devices),
    ],
    [roster.others, roster.self]
  );
  const custody = useMemo(
    () => custodyLine(custodyCounts(everyDevice), props.records ?? null),
    [everyDevice, props.records]
  );

  const { embedded = false, onReport } = props;
  useEffect(() => {
    if (embedded) return;
    publishRouteSignals("household", {
      count,
      health,
      state,
      ...(requests.length > 0 ? { tone: "seam" as const } : {}),
    });
  }, [count, embedded, health, requests.length, state]);
  useEffect(() => {
    if (embedded) return undefined;
    return () => clearRouteSignals("household");
  }, [embedded]);
  useEffect(() => {
    if (embedded) return;
    publishRouteVerbs("household", {
      onCommit: openPairing,
      ...(hasSharing ? { onSecondary: reviewPending } : {}),
    });
  }, [embedded, hasSharing, openPairing, reviewPending]);

  const report = useMemo<HouseholdReport>(
    () => ({
      custody,
      deviceCount: roster.deviceCount,
      health,
      openPairing,
      pendingCount: requests.length,
      personCount: roster.personCount,
      reviewPending,
      state,
    }),
    [
      custody,
      health,
      openPairing,
      requests.length,
      reviewPending,
      roster.deviceCount,
      roster.personCount,
      state,
    ]
  );
  useEffect(() => {
    onReport?.(report);
  }, [onReport, report]);

  const everyone = [...(roster.self ? [roster.self] : []), ...roster.others];

  const vaultDoors: RowDef[] = [
    ...(props.onNewVault
      ? [
          {
            action: { label: "Create", onClick: () => props.onNewVault?.() },
            id: "new-vault",
            sub: "A name, an icon and a colour.",
            title: "Create a vault",
          } satisfies RowDef,
        ]
      : []),
    {
      action: { label: "Open", onClick: props.onOpenStorage },
      id: "storage",
      meta: "System",
      sub: "Capacity, disk use and backups, where the bytes physically sit.",
      title: "Storage on this gateway",
    },
  ];

  const body = (
    <>
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
          body="Pairing and revocation need the vault host — this page is a cached copy."
          eyebrow="Where it lives"
          title="Cannot reach the vault host"
          tone="net"
          wide
        />
      ) : hasRoster ? (
        state === "empty" ? (
          <EmptyBlock
            action={{ label: "Pair a device", onClick: openPairing }}
            body={DEVICES_EMPTY_BODY}
            routine
            title={DEVICES_EMPTY_TITLE}
          />
        ) : null
      ) : (
        <EmptyBlock
          body="Pairing and revocation both live on the vault host, so neither is offered here."
          routine
          title="This connection doesn’t report a roster"
        />
      )}

      {/* The question narrows: containers, machines, people, wires. */}
      {state === "loading" ? null : (
        <>
          <SectionBlock label="Vaults you own" meta={String(vaults.length)} />
          {vaults.length > 0 ? (
            <VaultRows
              defaultScopeId={defaultScopeId}
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
          <RowsBlock ariaLabel="Vault doors" rows={vaultDoors} />
        </>
      )}

      {hasRoster && state !== "loading" && state !== "error" ? (
        <DevicesCard
          now={now}
          {...(boundaryPromise ? { boundaryPromise } : {})}
          onPairingChange={setPairing}
          pairing={pairing}
          roster={roster}
          {...(props.onCreateDeviceTicket
            ? { onCreateTicket: props.onCreateDeviceTicket }
            : {})}
        />
      ) : null}

      {state === "loading" || everyone.length === 0 ? null : (
        <>
          <SectionBlock label="People" meta={String(everyone.length)} />
          <PeopleRows people={everyone} />
        </>
      )}

      {state === "loading" || !sharing ? null : (
        <div className={styles.sharing} ref={sharingRef}>
          {/* "Other gateways" would state a local/remote distinction this
              product refuses. */}
          <SharingCard {...sharing} />
        </div>
      )}
    </>
  );

  if (embedded)
    return (
      <>
        <SectionBlock
          collapsed={props.collapsed ?? false}
          label="Where it lives"
          meta={custody}
          {...(props.onToggle ? { onToggle: props.onToggle } : {})}
        />
        {props.collapsed ? null : body}
      </>
    );

  return <div className={styles.page}>{body}</div>;
}
