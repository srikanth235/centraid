// The link-ticket offer under the reach line (#929 S6), native seat.
//
// It is an OFFER, never a grant: #903's rule that a share needs a live binding
// is untouched, the sheet's submit still refuses, and nothing is sent on the
// member's behalf. What this draws is the one act that would change the answer
// — the same one-time ticket `SharingLinkRow` mints, offered where the refusal
// is said instead of as a sentence pointing at another screen.

import * as Clipboard from "expo-clipboard";
import React from "react";
import { View } from "react-native";

import {
  LINK_TICKET_ACTION,
  LINK_TICKET_BUSY,
  LINK_TICKET_COPIED,
  LINK_TICKET_COPY_ACTION,
  LINK_TICKET_NOTE,
} from "@centraid/blueprints/apps/_shared/grant-copy";
import type { LinkTicketPanel } from "@centraid/blueprints/apps/_shared/link-ticket-panel";

import { Text } from "../components/NativeText";
import Tappable from "../components/Tappable";
import type { ThemeColors } from "../theme";
import { styles } from "./GrantSheet.styles";

export function GrantSheetTicket(props: {
  panel: LinkTicketPanel;
  colors: ThemeColors;
}): React.JSX.Element {
  const { colors, panel } = props;
  const minted = panel.ticket;
  return (
    <View style={styles.ticket}>
      {minted ? (
        <>
          <Text
            style={[
              styles.ticketCode,
              { backgroundColor: colors.bgSunken, color: colors.text },
            ]}
          >
            {minted.ticket}
          </Text>
          <Tappable
            accessibilityRole="button"
            accessibilityLabel={LINK_TICKET_COPY_ACTION}
            onPress={() => {
              void Clipboard.setStringAsync(minted.ticket).then(
                panel.noteCopied
              );
            }}
          >
            <Text style={[styles.reachState, { color: colors.accentText }]}>
              {panel.copied ? LINK_TICKET_COPIED : LINK_TICKET_COPY_ACTION}
            </Text>
          </Tappable>
          <Text style={[styles.note, { color: colors.textSoft }]}>
            {panel.expiry}
          </Text>
        </>
      ) : (
        <Tappable
          accessibilityRole="button"
          accessibilityLabel={LINK_TICKET_ACTION}
          disabled={panel.busy}
          onPress={() => void panel.make()}
        >
          <Text style={[styles.reachState, { color: colors.accentText }]}>
            {panel.busy ? LINK_TICKET_BUSY : LINK_TICKET_ACTION}
          </Text>
        </Tappable>
      )}
      {panel.refusal ? (
        <Text style={[styles.note, { color: colors.net }]}>
          {panel.refusal}
        </Text>
      ) : null}
      <Text style={[styles.note, { color: colors.textSoft }]}>
        {LINK_TICKET_NOTE}
      </Text>
    </View>
  );
}
