// Version history on the phone (#882) — the app's headline feature, which
// this seat had no surface for at all.
//
// RESTORING APPENDS. The control on an older row asks the vault to put that
// body back at the HEAD of the chain; nothing between is rewritten or dropped,
// and the status line above the list says so in the blueprint's own words.

import React from "react";
import { Pressable, ScrollView, View } from "react-native";

import type { VaultRow } from "@centraid/blueprints/apps/notes/filing";
import { ageLabel } from "@centraid/blueprints/apps/notes/format";
import {
  HISTORY_UNREADABLE,
  VERSION_TEXT_ELSEWHERE,
  historyStatus,
} from "@centraid/blueprints/apps/notes/view-copy";

import { Text } from "../../kit/components/NativeText";
import { useTheme } from "../../kit/theme";
import type { NativeNote } from "./notes-model";
import { styles } from "./NotesHome.styles";
import { useNoteVersions } from "./useNoteVersions";

export interface NotesHistoryProps {
  note: NativeNote;
  chainRows: {
    links: readonly VaultRow[];
    concepts: readonly VaultRow[];
    schemes: readonly VaultRow[];
  };
  /** The edge read failed: the chain is UNKNOWN, not empty. */
  unreadable: boolean;
  onRestore: (contentId: string) => void;
}

export default function NotesHistory({
  note,
  chainRows,
  unreadable,
  onRestore,
}: NotesHistoryProps): React.JSX.Element {
  const { colors } = useTheme();
  const versions = useNoteVersions({
    headContentId: note.bodyContentId,
    createdAt: note.createdAt,
    ...chainRows,
  });

  if (unreadable) {
    return (
      <View style={styles.empty}>
        <Text style={[styles.emptyTitle, { color: colors.text }]}>
          {HISTORY_UNREADABLE}
        </Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.list}>
      <Text style={[styles.rowMeta, { color: colors.textSoft }]}>
        {historyStatus(versions.length)}
      </Text>
      {versions.map((version) => (
        <View
          key={version.content_id}
          style={[styles.row, { borderBottomColor: colors.line }]}
        >
          <View style={styles.rowOpen}>
            <Text style={[styles.rowName, { color: colors.text }]}>
              {ageLabel(version.asserted_at) || version.asserted_at}
            </Text>
            <Text
              numberOfLines={2}
              style={[styles.rowMeta, { color: colors.textFaint }]}
            >
              {version.body || VERSION_TEXT_ELSEWHERE}
            </Text>
          </View>
          {version.current ? (
            <Text style={[styles.count, { color: colors.textFaint }]}>
              current
            </Text>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Restore the version from ${ageLabel(version.asserted_at)}`}
              onPress={() => onRestore(version.content_id)}
              style={[styles.chip, { borderColor: colors.line }]}
            >
              <Text style={[styles.chipText, { color: colors.textSoft }]}>
                Restore
              </Text>
            </Pressable>
          )}
        </View>
      ))}
    </ScrollView>
  );
}
