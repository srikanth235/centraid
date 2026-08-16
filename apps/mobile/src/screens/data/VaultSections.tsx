import React, { useCallback, useEffect, useMemo, useState } from "react";

import EmptyBlock from "../../kit/components/EmptyBlock";
import NoteBlock from "../../kit/components/NoteBlock";
import PanelBlock from "../../kit/components/PanelBlock";
import RowsBlock from "../../kit/components/RowsBlock";
import type { RowsBlockRow } from "../../kit/components/RowsBlock";
import SectionBlock from "../../kit/components/SectionBlock";
import SkeletonRows from "../../kit/components/SkeletonRows";
import { memberFacingError } from "../../kit/member-error";
import { VAULT_SECTION_ORDER } from "../../kit/origin-seat-layout";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import type { PendingEdge } from "../../lib/replica/edges-transport";
import {
  answerPendingEdge,
  listPendingEdges,
} from "../../lib/replica/edges-transport";
import type { GatewayLink } from "../../lib/replica/links-transport";
import { listLinks } from "../../lib/replica/links-transport";
import {
  devicesState,
  hasOtherPeople,
  rosterGroups,
} from "../devices/devices-model";
import { useDevices } from "../devices/useDevices";

interface VaultSectionsProps {
  openCopies: () => void;
  openSharing: () => void;
}

export function VaultCopiesSection({
  openCopies,
}: Pick<VaultSectionsProps, "openCopies">): React.JSX.Element {
  const devices = useDevices();
  const state = devicesState(devices);
  const groups = rosterGroups(devices.devices);
  const rows = useMemo<RowsBlockRow[]>(
    () =>
      groups.flatMap((group) =>
        group.rows.map((row) => ({
          ...row,
          action: row.off
            ? undefined
            : { label: "Manage", onPress: openCopies },
        }))
      ),
    [groups, openCopies]
  );

  return (
    <>
      <SectionBlock
        label={VAULT_SECTION_ORDER[1]}
        meta={state === "loading" ? undefined : String(devices.devices.length)}
      />
      {state === "loading" ? (
        <SkeletonRows accessibilityLabel="Reading the devices with a copy" />
      ) : state === "error" ? (
        <PanelBlock
          action={{ label: "Try again", onPress: () => void devices.refresh() }}
          action2={{ label: "Open Copies", onPress: openCopies }}
          body={
            devices.noGateway
              ? "Link this phone to a vault from Settings to see its copies."
              : "The saved roster may be stale until your vault's home machine answers."
          }
          {...(devices.message
            ? {
                facts: [{ key: "the connection said", value: devices.message }],
              }
            : {})}
          title="Copies are unavailable"
          tone="net"
        />
      ) : rows.length === 0 ? (
        <EmptyBlock
          action={{ label: "Pair a device", onPress: openCopies }}
          body="Pair a phone or laptop to keep another copy within reach."
          routine
          title="Only this device is enrolled"
        />
      ) : (
        <>
          <RowsBlock accessibilityLabel="Devices holding a copy" rows={rows} />
          {hasOtherPeople(groups) ? (
            <NoteBlock text="Another person reaches only what you placed in a shared space." />
          ) : null}
          <PanelBlock
            action={{ label: "Pair or manage", onPress: openCopies }}
            body="Rename, pair, or revoke a device from the full Copies view."
          />
        </>
      )}
    </>
  );
}

interface SharingRead {
  links: GatewayLink[];
  pending: PendingEdge[];
  state: "loading" | "ready" | "error";
  error?: string;
}

const SHARING_START: SharingRead = { links: [], pending: [], state: "loading" };

function linkedPersonLabel(
  link: GatewayLink,
  vaultId: string | undefined
): string {
  if (vaultId === link.vaultA) return link.labelB ?? "Linked person";
  if (vaultId === link.vaultB) return link.labelA ?? "Linked person";
  return link.labelA ?? link.labelB ?? "Linked person";
}

export function VaultSharingSection({
  openSharing,
}: Pick<VaultSectionsProps, "openSharing">): React.JSX.Element {
  const replica = useReplica();
  const [read, setRead] = useState<SharingRead>(SHARING_START);
  const refresh = useCallback((): void => {
    if (!replica.gatewayBase) return;
    void Promise.all([
      listLinks(replica.gatewayBase),
      listPendingEdges(replica.gatewayBase),
    ])
      .then(([links, pending]) => setRead({ links, pending, state: "ready" }))
      .catch((error: unknown) =>
        setRead({
          error: memberFacingError(
            error instanceof Error ? error.message : String(error)
          ),
          links: [],
          pending: [],
          state: "error",
        })
      );
  }, [replica.gatewayBase]);

  useEffect(refresh, [refresh]);

  const visibleRead: SharingRead = replica.gatewayBase
    ? read
    : { links: [], pending: [], state: "ready" };

  const answer = (row: PendingEdge, decision: "accept" | "refuse"): void => {
    if (!replica.gatewayBase) return;
    void answerPendingEdge(replica.gatewayBase, row.edgeId, decision)
      .then(refresh)
      .catch((error: unknown) =>
        setRead({
          error: memberFacingError(
            error instanceof Error ? error.message : String(error)
          ),
          links: visibleRead.links,
          pending: visibleRead.pending,
          state: "error",
        })
      );
  };

  return (
    <>
      <SectionBlock
        label={VAULT_SECTION_ORDER[2]}
        meta={
          visibleRead.state === "ready"
            ? String(visibleRead.links.length)
            : undefined
        }
      />
      {visibleRead.state === "loading" ? (
        <SkeletonRows accessibilityLabel="Reading sharing" />
      ) : visibleRead.state === "error" ? (
        <PanelBlock
          action={{ label: "Try again", onPress: refresh }}
          action2={{ label: "Open Sharing", onPress: openSharing }}
          body="Sharing could not be read."
          {...(visibleRead.error
            ? {
                facts: [
                  { key: "the connection said", value: visibleRead.error },
                ],
              }
            : {})}
          title="Sharing is unavailable"
          tone="net"
        />
      ) : (
        <>
          {visibleRead.pending.map((row) => (
            <PanelBlock
              action={{
                label: "Accept",
                onPress: () => answer(row, "accept"),
              }}
              action2={{
                label: "Refuse",
                onPress: () => answer(row, "refuse"),
              }}
              body={`${row.itemCount} ${row.itemType} · nothing is written until you accept.`}
              eyebrow="Waiting for your decision"
              key={row.edgeId}
              title="A shared copy is waiting"
            />
          ))}
          <RowsBlock
            accessibilityLabel="People linked to this vault"
            rows={visibleRead.links.map((link) => ({
              action: { label: "Open", onPress: openSharing },
              key: link.linkId,
              sub: link.revoked
                ? "Link ended"
                : link.approved
                  ? "Linked"
                  : "Waiting for approval",
              title: linkedPersonLabel(link, replica.vaultId),
            }))}
          />
          {visibleRead.links.length === 0 &&
          visibleRead.pending.length === 0 ? (
            <EmptyBlock
              action={{ label: "Link with someone", onPress: openSharing }}
              body="Shared spaces and direct copies appear here."
              routine
              title="Nothing shared yet"
            />
          ) : null}
          {visibleRead.links.length > 0 || visibleRead.pending.length > 0 ? (
            <PanelBlock
              action={{ label: "Manage sharing", onPress: openSharing }}
              body="Link people, review invitations, and manage shared spaces."
            />
          ) : null}
        </>
      )}
    </>
  );
}
