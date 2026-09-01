// DEVICES — machines holding a copy (#765, spec §7). Deliberately absent, for
// want of a wire: inbound gateway links, shared recovery nominations,
// per-device compute writes. Pairing from this phone lives in Settings.

import * as Clipboard from "expo-clipboard";
import React, { useMemo, useState } from "react";
import { ScrollView, View } from "react-native";

import {
  DEVICES_EMPTY_BODY,
  DEVICES_EMPTY_TITLE,
} from "@centraid/client/devices-copy";
import { SKELETON_NOTE } from "@centraid/client/surface-copy";

import EmptyBlock from "../../kit/components/EmptyBlock";
import { healthLineFor } from "../../kit/components/health-line";
import HealthLine from "../../kit/components/HealthLine";
import HomeKey from "../../kit/components/HomeKey";
import { Text } from "../../kit/components/NativeText";
import NoteBlock from "../../kit/components/NoteBlock";
import PanelBlock from "../../kit/components/PanelBlock";
import PlaceHeader from "../../kit/components/PlaceHeader";
import RowsBlock from "../../kit/components/RowsBlock";
import type { RowsBlockRow } from "../../kit/components/RowsBlock";
import SectionBlock from "../../kit/components/SectionBlock";
import SkeletonRows from "../../kit/components/SkeletonRows";
import { postStatus } from "../../kit/components/status-line";
import TopSafeArea from "../../kit/components/TopSafeArea";
import { useTheme } from "../../kit/theme";
import type { DeviceRow } from "../../lib/devices";
import type { DevicesScreenProps } from "../../navigation";
import DeviceActions from "./DeviceActions";
import {
  devicesHealthCopy,
  devicesState,
  hasOtherPeople,
  rosterGroups,
  ticketFacts,
  vaultRowCopy,
} from "./devices-model";
import { makeStyles } from "./Devices.styles";
import { useDeviceBoundaryPromise } from "./useDeviceBoundaryPromise";
import { useDevices } from "./useDevices";

const OTHER_PEOPLE_NOTE =
  "Another person reaches only what you placed in a shared space.";

const LOADING_NOTE = SKELETON_NOTE;

const EMPTY_TITLE = DEVICES_EMPTY_TITLE;
const EMPTY_BODY = DEVICES_EMPTY_BODY;

const ERROR_TITLE = "Cannot reach your vault's home machine";
const ERROR_BODY =
  "Served from a cached copy — pairing and revocation need your vault's home machine.";
/** The `no-gateway` degrade: same visual, truer sentence. */
const UNPAIRED_BODY =
  "Pair this phone from Settings to see the devices sharing that vault.";

const PAIR_VERB = "Pair a device";

export default function DevicesScreen({
  navigation,
}: DevicesScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const devices = useDevices();
  /* What revoking a device can promise is derived in the vault from the
     principal kind and printed verbatim; unread, it is not said (#883). */
  const boundaryPromise = useDeviceBoundaryPromise();
  // The row whose trailing verb is open — the sheet is modal, one at a time.
  const [acting, setActing] = useState<DeviceRow | undefined>(undefined);

  const state = devicesState(devices);
  const groups = rosterGroups(devices.devices);
  const health = healthLineFor(
    state,
    devicesHealthCopy({
      devices: devices.devices,
      pendingTickets: devices.ticket ? 1 : 0,
    })
  );

  const rowsFor = (group: (typeof groups)[number]): readonly RowsBlockRow[] =>
    group.rows.map((row, index) => {
      const device = group.devices[index];
      // A tombstone answers to nothing; kept so past writes resolve.
      if (!device || row.off) return row;
      return {
        ...row,
        action: {
          hint: `Manage ${row.title}`,
          label: "Manage",
          onPress: () => setActing(device),
        },
      };
    });

  const ticket = devices.ticket;
  const handleRename = devices.rename;
  const handleRevoke = devices.revoke;
  const handleCloseActions = (): void => setActing(undefined);

  return (
    <TopSafeArea
      edges={["top"]}
      style={[styles.safe, { backgroundColor: colors.bg }]}
    >
      <View style={styles.page}>
        <PlaceHeader
          title="Copies"
          // Pair verb hidden while loading or errored — minting needs the
          // gateway that is not answering.
          {...(state === "loading" || state === "error"
            ? {}
            : {
                primary: {
                  label: PAIR_VERB,
                  onPress: () => void devices.mint(),
                },
              })}
        />
        <ScrollView
          contentContainerStyle={styles.body}
          style={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          {ticket ? (
            <>
              <PanelBlock
                eyebrow="Waiting to be used"
                title="Pairing ticket"
                body="Paste this on the other device, in Settings → Desktop link. It works once, and only until it expires."
                facts={ticketFacts(ticket)}
                tone="seam"
                action={{
                  label: "Copy the ticket",
                  onPress: () => {
                    void Clipboard.setStringAsync(ticket.ticket).then(() =>
                      postStatus("Pairing ticket copied.")
                    );
                  },
                }}
                action2={{ label: "Done", onPress: devices.dismissTicket }}
              />
              {/* The token itself, selectable — readable across machines even
                  with a locked-down clipboard. */}
              <Text selectable style={styles.ticket}>
                {ticket.ticket}
              </Text>
            </>
          ) : null}

          {state === "loading" ? (
            <>
              <SkeletonRows accessibilityLabel="Reading the paired devices" />
              <NoteBlock text={LOADING_NOTE} />
            </>
          ) : state === "error" ? (
            <PanelBlock
              tone="net"
              title={ERROR_TITLE}
              body={devices.noGateway ? UNPAIRED_BODY : ERROR_BODY}
              {...(devices.message
                ? {
                    facts: [
                      {
                        key: "the connection said",
                        net: true,
                        value: devices.message,
                      },
                    ],
                  }
                : {})}
              action={{
                label: "Try again",
                onPress: () => void devices.refresh(),
              }}
            />
          ) : state === "empty" ? (
            <EmptyBlock
              title={EMPTY_TITLE}
              body={EMPTY_BODY}
              routine
              action={{ label: PAIR_VERB, onPress: () => void devices.mint() }}
            />
          ) : (
            <>
              {groups.map((group) => (
                <React.Fragment key={group.key}>
                  <SectionBlock label={group.label} meta={group.meta} />
                  <RowsBlock rows={rowsFor(group)} />
                </React.Fragment>
              ))}
              {hasOtherPeople(groups) ? (
                <NoteBlock text={OTHER_PEOPLE_NOTE} />
              ) : null}
              {boundaryPromise ? <NoteBlock text={boundaryPromise} /> : null}
              {/* Omitted on gateways mounting no vault plane: `undefined` is
                  "no such plane", not "you own none". */}
              {devices.vaults ? (
                <>
                  <SectionBlock
                    label="Vaults you own"
                    meta={String(devices.vaults.length)}
                  />
                  <RowsBlock rows={devices.vaults.map(vaultRowCopy)} />
                </>
              ) : null}
            </>
          )}
        </ScrollView>
      </View>
      {/* Docked above the bottom edge, with the floating home key's clearance. */}
      <View style={styles.dock}>
        <HealthLine
          text={health.text}
          tone="seam"
          {...(health.action
            ? { action: health.action, onAction: () => void devices.refresh() }
            : {})}
        />
      </View>
      {acting ? (
        <DeviceActions
          busy={devices.busy}
          device={acting}
          // Keyed on the row: each device's sheet keeps its own state.
          key={acting.deviceId}
          onClose={handleCloseActions}
          onRename={handleRename}
          onRevoke={handleRevoke}
        />
      ) : null}
      <HomeKey onPress={() => navigation.goBack()} variant="floating" />
    </TopSafeArea>
  );
}
