import React from "react";
import { Pressable, View } from "react-native";

import {
  capabilityLabel,
  grantStandingLabel,
  REVOKE_CONFIRM_ACTION,
} from "@centraid/blueprints/apps/_shared/grant-copy";
import type {
  GrantAudienceOption,
  GrantRecord,
  GrantSubject,
} from "@centraid/blueprints/apps/_shared/grant-plane";
import { subjectNoun } from "@centraid/blueprints/apps/_shared/grant-plane";

import { Text } from "../components/NativeText";
import { audienceLabelFor } from "./grant-sheet-labels";
import { styles } from "./GrantSheet.styles";

export function GrantSheetStanding({
  audiences,
  busy,
  colors,
  emptyLine,
  onRevoke,
  rows,
  showStanding,
  standing,
  subject,
}: {
  audiences: readonly GrantAudienceOption[];
  busy: boolean;
  colors: {
    line: string;
    net: string;
    seam: string;
    text: string;
    textSoft: string;
  };
  emptyLine: string;
  onRevoke: (grant: GrantRecord) => void;
  rows: readonly GrantRecord[];
  showStanding: boolean;
  standing: readonly GrantRecord[] | null;
  subject?: GrantSubject;
}): React.JSX.Element {
  return (
    <View style={styles.section}>
      <Text style={[styles.eyebrow, { color: colors.textSoft }]}>
        Already shared
      </Text>
      {standing === null ? (
        <Text style={[styles.note, { color: colors.textSoft }]}>
          Reading shares…
        </Text>
      ) : showStanding ? (
        rows.map((grant) => (
          <View
            key={grant.grantId}
            style={[styles.row, { borderColor: colors.line }]}
          >
            <View style={styles.rowCopy}>
              <Text style={{ color: colors.text }}>
                {subject
                  ? audienceLabelFor(grant, audiences)
                  : subjectNoun(grant.subjectType)}
              </Text>
              {/* The vault's own phrase and its own reason, both verbatim
                  (ruling V-phrases). Still on its way is the seam rung. */}
              <Text
                style={[
                  styles.note,
                  {
                    color:
                      grant.phrase === "on its way"
                        ? colors.seam
                        : colors.textSoft,
                  },
                ]}
              >
                {capabilityLabel(grant.capability)}
                {grantStandingLabel(grant)
                  ? ` · ${grantStandingLabel(grant)}`
                  : ""}
              </Text>
              {grant.reason ? (
                <Text style={[styles.note, { color: colors.textSoft }]}>
                  {grant.reason}
                </Text>
              ) : null}
            </View>
            <Pressable
              accessibilityLabel={`Revoke ${subjectNoun(grant.subjectType)}`}
              accessibilityRole="button"
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              onPress={() => onRevoke(grant)}
              style={[styles.pill, { borderColor: colors.net }]}
            >
              <Text style={{ color: colors.net }}>{REVOKE_CONFIRM_ACTION}</Text>
            </Pressable>
          </View>
        ))
      ) : (
        <Text style={[styles.note, { color: colors.textSoft }]}>
          {emptyLine}
        </Text>
      )}
    </View>
  );
}
