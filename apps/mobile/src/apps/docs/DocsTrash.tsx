// Trash (handoff Part 2 §Trash; spec §4.3, §14). Soft delete, and each
// document carries its OWN purge date — the row's state slot prints it
// (`purged in N days`), never one global countdown. Restoring one puts its
// folder and its star back exactly as they were.
//
// EMPTY TRASH IS LIVE (#1015, D1). The shelf used to carry an ask — "Delete
// forever and Empty trash, not available yet" — while Photos shipped both;
// `core.empty_document_trash` closed that. The control is outlined, never
// filled, and it does NOT destroy: it opens the confirm, and only the
// confirm writes. The confirm is an `OptionSheet`, not an `Alert` — a choice
// belongs in a sheet (D4), and the destructive choice carries the noun and
// the count so a member reads what goes.

import { useNavigation } from "@react-navigation/native";
import React, { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";

import { EMPTY_TRASH_COPY } from "@centraid/blueprints/apps/docs/drive-copy";
import { TRASH } from "@centraid/blueprints/apps/docs/shelves";
import { captionFor } from "@centraid/blueprints/apps/docs/view-copy";

import Button from "../../kit/components/Button";
import { Text } from "../../kit/components/NativeText";
import { postStatus } from "../../kit/components/status-line";
import PushedPage from "../../kit/rooms/PushedPage";
import SheetRoom from "../../kit/rooms/SheetRoom";
import { pageMargin, t, useTheme } from "../../kit/theme";
import type { DocsShellNavigation } from "../../navigation";
import { trashStatus } from "./docs-copy";
import { useDocsRoom } from "./docs-room";
import DriveList from "./DriveList";
import { useDocs, useDocsWrite } from "./useDocs";

export default function DocsTrash(): React.JSX.Element {
  const room = useDocsRoom("more");
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(), []);
  const navigation = useNavigation<DocsShellNavigation>();
  const write = useDocsWrite(navigation);
  const drive = useDocs();
  const [confirming, setConfirming] = useState(false);
  const docs = useMemo(
    () => drive.documents.filter((doc) => doc.trashed),
    [drive.documents]
  );
  const count = docs.length;
  const runEmptyTrash = (): void => {
    setConfirming(false);
    void write("empty-trash", {}).then(async (result) => {
      if (!result) return;
      postStatus(EMPTY_TRASH_COPY.done(count));
      await drive.refresh();
    });
  };
  return (
    <PushedPage
      backTo={room.backTo}
      band={room.band}
      chrome={room.chrome}
      onBack={room.handleBack}
      overlay={room.overlay}
      title={room.title}
    >
      <DriveList
        shelf={TRASH}
        docs={docs}
        folders={drive.folders}
        loading={drive.loading}
        connection={drive.connection}
        {...(drive.error ? { error: drive.error } : {})}
        {...(drive.unavailableReason
          ? { unavailableReason: drive.unavailableReason }
          : {})}
        offline={drive.offline}
        refresh={drive.refresh}
        caption={captionFor(TRASH, { offline: drive.offline })}
        status={trashStatus(count)}
      />
      {count === 0 ? null : (
        <View style={styles.foot}>
          {/* Outlined `--net`, never filled: the one irreversible verb in Docs
              must not look louder than Upload. Press opens the sheet. */}
          <Button
            label={EMPTY_TRASH_COPY.label(count)}
            variant="destructive"
            accessibilityHint={EMPTY_TRASH_COPY.detail(count)}
            onPress={() => setConfirming(true)}
          />
        </View>
      )}
      {/* THE ROOM, NOT `OptionSheet` (#1015, S7). `OptionSheet` lowers to
          `ActionSheetIOS` on this seat, which draws system rows and can carry
          neither an outlined `--net` verb nor a hosted status line. The one
          confirm is `SheetRoom`; this one spells its own question because the
          copy is the SHARED table's, word for word, and "forever" belongs in
          the question rather than in the body. */}
      <SheetRoom
        cancelLabel={EMPTY_TRASH_COPY.cancel}
        onClose={() => setConfirming(false)}
        primary={{
          dangerous: true,
          label: EMPTY_TRASH_COPY.confirm(count),
          onPress: runEmptyTrash,
        }}
        title={EMPTY_TRASH_COPY.question(count)}
        visible={confirming}
      >
        <Text style={[t("body"), { color: colors.textSoft }]}>
          {EMPTY_TRASH_COPY.detail(count)}
        </Text>
      </SheetRoom>
    </PushedPage>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    // `pageMargin` is the gutter every Docs shelf uses — never a hand-typed 18.
    foot: { marginHorizontal: pageMargin, marginVertical: 8 },
  });
