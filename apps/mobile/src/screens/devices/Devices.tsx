// DEVICES — the machines holding a copy (issue #765, spec §7).
//
// Net-new on the phone: this app could pair ITSELF into a gateway (Settings'
// "Desktop link") but never showed the roster it joined, so a lost laptop had
// no phone-side answer. The page reads `GET /_gateway/devices` and offers the
// three gestures that wire serves — mint a ticket, rename, revoke.
//
// WHAT IS DELIBERATELY NOT HERE, and why the page is shorter than the
// reference's:
//
//  - "Other gateways" (someone else's gateway asking to connect). No route on
//    this wire serves inbound gateway links to a phone, so the section is
//    absent rather than empty.
//  - "Shared recovery" and its note about two of three nominated people. There
//    is no nomination plane at all — the only recovery this codebase has is
//    the Commons steward-absence door (`lib/replica/placement-transport.ts`),
//    which is a different object with different words. So the `Recovery` verb
//    the reference puts beside `Pair a device` is withheld too: a verb that
//    opens nothing is worse than a bar with one verb.
//  - Per-device compute editing. The roster READS `compute` (the sub line says
//    whether a device contributes) but the phone has no write for it, so no
//    control offers one.
//
// The one filled commit is `Pair a device`, and it is the ticket mint —
// pairing from the OTHER direction (this phone joining a gateway) already has
// its surface in Settings and is not rebuilt here.

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
import { useDevices } from "./useDevices";

/** The note under the roster — the reference's words, unchanged. */
const OTHER_PEOPLE_NOTE =
  "Another person reaches only what you placed in a shared space.";

/** What a skeleton promises, said out loud (spec §10). */
const LOADING_NOTE = SKELETON_NOTE;

const EMPTY_TITLE = DEVICES_EMPTY_TITLE;
const EMPTY_BODY = DEVICES_EMPTY_BODY;

const ERROR_TITLE = "Cannot reach your vault's home machine";
const ERROR_BODY =
  "This page is being served from a cached copy. Device pairing and revocation both need your vault's home machine, so both are unavailable until it answers.";
/** The `no-gateway` degrade is the SAME visual, with the sentence that is
 *  actually true of it: nothing is cached because nothing was ever linked. */
const UNPAIRED_BODY =
  "This phone is not linked to a vault yet. Pair it from Settings, and the devices sharing that vault appear here.";

const PAIR_VERB = "Pair a device";

export default function DevicesScreen({
  navigation,
}: DevicesScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const devices = useDevices();
  // The row whose trailing verb is open. One at a time: the sheet it opens is
  // modal, and two would be a stack the member cannot see the bottom of.
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
      // A tombstone answers to nothing: it is present so past writes still
      // resolve to the device that made them.
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
  // Named for the handler-name rule, and stable enough for the keyed sheet.
  const handleRename = devices.rename;
  const handleRevoke = devices.revoke;
  const handleCloseActions = (): void => setActing(undefined);

  return (
    <TopSafeArea edges={["top"]} style={{ backgroundColor: colors.bg }}>
      <View style={styles.page}>
        <PlaceHeader
          title="Copies"
          // The reference's gating: the filled commit is hidden while loading
          // AND while errored — minting a ticket needs the gateway that is not
          // answering. There is no quiet verb, because `Recovery` has nowhere
          // to go on this wire.
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
                // The one page whose standing state is about another machine
                // reaching this one takes the seam tone (spec §7).
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
              {/* The token itself, selectable — a member whose clipboard is
                  locked down can still read it across to the other machine. */}
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
              {/* Omitted entirely on a gateway that mounts no vault plane —
                  `undefined` is "no such plane", not "you own none". */}
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
      {/* Docked above the bottom edge, with the floating home key's own
          clearance under it — the line is standing chrome, not content. */}
      <View style={styles.dock}>
        <HealthLine
          text={health.text}
          // The one ops page whose standing state is about other machines
          // reaching this one (spec §7). It moves the dot, nothing else.
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
          // Keyed on the row: each device's sheet gets its own state rather
          // than an effect that resets the last one's.
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
