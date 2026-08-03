import React, { useMemo, useState } from "react";
import { Alert, Modal, Pressable, StyleSheet, View } from "react-native";

import type { ReplicaValue } from "@centraid/client/replica/native";

import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import { postStatus } from "../../kit/components/status-line";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import { family, useTheme } from "../../kit/theme";
import type { NativeOptimisticMutation } from "../../lib/replica/native-session";
import {
  optimisticRowId,
  optimisticValues,
} from "../../lib/replica/optimistic";
import type { NativeFolder } from "./docs-model";
import type { DriveItem } from "./DocsLibraryItems";

type Mode = "menu" | "rename" | "move";

export interface DocsItemActionsProps {
  item?: DriveItem;
  folders: NativeFolder[];
  rootFolderId?: string;
  onClose: () => void;
  onParked: () => void;
  onChanged: () => Promise<void>;
}

export default function DocsItemActions({
  item,
  folders,
  rootFolderId,
  onClose,
  onParked,
  onChanged,
}: DocsItemActionsProps): React.JSX.Element | null {
  const { colors } = useTheme();
  const { session } = useReplica();
  const [mode, setMode] = useState<Mode>("menu");
  const [name, setName] = useState(() =>
    item?.kind === "folder"
      ? item.folder.name
      : item?.kind === "document"
        ? item.document.title
        : ""
  );
  const sourceVaultId =
    item?.kind === "folder"
      ? item.folder.sourceVaultId
      : item?.document.sourceVaultId;
  const writable =
    item?.kind === "folder"
      ? item.folder.canWrite === true
      : item?.document.canWrite === true;
  const destinations = useMemo(
    () =>
      folders.filter(
        (folder) =>
          folder.sourceVaultId === sourceVaultId &&
          folder.canWrite === true &&
          (item?.kind !== "document" || folder.id !== item.document.folderId)
      ),
    [folders, item, sourceVaultId]
  );
  if (!item) return null;

  const write = async (
    action: string,
    input: Record<string, unknown>,
    optimistic: NativeOptimisticMutation[] = []
  ): Promise<void> => {
    if (!session || !sourceVaultId || !writable) {
      postStatus(
        "Read-only item — choose the writable copy in its source vault."
      );
      return;
    }
    try {
      const result = await session.writeTo(sourceVaultId, "docs", {
        action,
        input: input as ReplicaValue,
        optimistic,
      });
      if (
        !surfaceWriteOutcome(result, {
          onParked: () => {
            onClose();
            onParked();
          },
          queuedMessage:
            "This change will sync automatically after reconnecting.",
          failureTitle: "Not applied",
        })
      )
        return;
      onClose();
      await onChanged();
    } catch (error) {
      surfaceWriteFailure(error, "Action failed");
    }
  };

  const rename = async (): Promise<void> => {
    const title = name.trim();
    if (!title) return;
    const now = new Date().toISOString();
    if (item.kind === "folder") {
      await write(
        "rename-folder",
        { folder_id: item.folder.rawId ?? item.folder.id, name: title },
        item.folder.raw
          ? [
              {
                op: "upsert",
                entity: "core.concept",
                rowId: item.folder.rawId ?? item.folder.id,
                values: optimisticValues(item.folder.raw, {
                  pref_label: title,
                }),
              },
            ]
          : []
      );
      return;
    }
    await write(
      "rename",
      { document_id: item.document.rawId ?? item.document.id, title },
      item.document.raw
        ? [
            {
              op: "upsert",
              entity: "core.document",
              rowId: item.document.rawId ?? item.document.id,
              values: optimisticValues(item.document.raw, {
                title,
                updated_at: now,
              }),
            },
          ]
        : []
    );
  };

  const move = async (folder?: NativeFolder): Promise<void> => {
    if (item.kind !== "document") return;
    const documentId = item.document.rawId ?? item.document.id;
    const conceptId = folder?.rawId ?? rootFolderId;
    const tagId =
      item.document.folderTag?.tag_id === undefined
        ? optimisticRowId("folder-tag")
        : String(item.document.folderTag.tag_id);
    await write(
      "move",
      {
        document_id: documentId,
        ...(folder ? { folder_id: folder.rawId ?? folder.id } : {}),
      },
      conceptId
        ? [
            {
              op: "upsert",
              entity: "core.tag",
              rowId: tagId,
              values: {
                tag_id: tagId,
                target_type: "core.document",
                target_id: documentId,
                concept_id: conceptId,
                tagged_by_party_id: null,
                confidence: null,
                tagged_at: new Date().toISOString(),
              },
            },
          ]
        : []
    );
  };

  const documentLifecycle = async (
    action: "trash" | "restore"
  ): Promise<void> => {
    if (item.kind !== "document") return;
    const now = new Date().toISOString();
    await write(
      action,
      { document_id: item.document.rawId ?? item.document.id },
      item.document.raw
        ? [
            {
              op: "upsert",
              entity: "core.document",
              rowId: item.document.rawId ?? item.document.id,
              values: optimisticValues(item.document.raw, {
                deleted_at: action === "trash" ? now : null,
                updated_at: now,
              }),
            },
          ]
        : []
    );
  };

  const deleteFolder = (): void => {
    if (item.kind !== "folder") return;
    Alert.alert(
      `Delete “${item.folder.name}”?`,
      "Only an empty folder can be deleted. Documents, trashed items, and subfolders are never removed with it.",
      [
        { text: "Cancel" },
        {
          text: "Delete empty folder",
          style: "destructive",
          onPress: () =>
            void write(
              "delete-folder",
              { folder_id: item.folder.rawId ?? item.folder.id },
              item.folder.raw
                ? [
                    {
                      op: "delete",
                      entity: "core.concept",
                      rowId: item.folder.rawId ?? item.folder.id,
                    },
                  ]
                : []
            ),
        },
      ]
    );
  };

  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View
        accessibilityViewIsModal
        style={[styles.sheet, { backgroundColor: colors.bgElev }]}
      >
        <Text style={[styles.title, { color: colors.text }]}>
          {item.kind === "folder" ? item.folder.name : item.document.title}
        </Text>
        {mode === "rename" ? (
          <>
            <TextInput
              accessibilityLabel={
                item.kind === "folder" ? "Folder name" : "Document name"
              }
              autoFocus
              value={name}
              onChangeText={setName}
              style={[
                styles.input,
                { borderColor: colors.lineStrong, color: colors.text },
              ]}
            />
            <ActionRow
              icon="check"
              label="Save name"
              disabled={!name.trim()}
              onPress={() => void rename()}
            />
          </>
        ) : mode === "move" && item.kind === "document" ? (
          <>
            {item.document.folderId ? (
              <ActionRow
                icon="home"
                label="Top level"
                onPress={() => void move()}
              />
            ) : null}
            {destinations.map((folder) => (
              <ActionRow
                key={folder.id}
                icon="folder"
                label={folder.name}
                onPress={() => void move(folder)}
              />
            ))}
            {destinations.length === 0 && !item.document.folderId ? (
              <Text style={[styles.empty, { color: colors.textSoft }]}>
                No other folders are available.
              </Text>
            ) : null}
          </>
        ) : (
          <>
            <ActionRow
              icon="edit-2"
              label="Rename"
              disabled={!writable}
              onPress={() => setMode("rename")}
            />
            {item.kind === "folder" ? (
              <ActionRow
                icon="trash-2"
                label="Delete empty folder"
                danger
                disabled={!writable}
                onPress={deleteFolder}
              />
            ) : item.document.trashed ? (
              <ActionRow
                icon="rotate-ccw"
                label="Restore from trash"
                disabled={!writable}
                onPress={() => void documentLifecycle("restore")}
              />
            ) : (
              <>
                <ActionRow
                  icon="folder"
                  label="Move to folder"
                  disabled={!writable}
                  onPress={() => setMode("move")}
                />
                <ActionRow
                  icon="trash-2"
                  label="Move to trash"
                  danger
                  disabled={!writable}
                  onPress={() =>
                    Alert.alert(
                      `Move “${item.document.title}” to trash?`,
                      "The document and all versions remain restorable until vault purge.",
                      [
                        { text: "Cancel" },
                        {
                          text: "Move to trash",
                          style: "destructive",
                          onPress: () => void documentLifecycle("trash"),
                        },
                      ]
                    )
                  }
                />
              </>
            )}
          </>
        )}
      </View>
    </Modal>
  );
}

function ActionRow({
  icon,
  label,
  danger = false,
  disabled = false,
  onPress,
}: {
  icon: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.action, { borderBottomColor: colors.line }]}
    >
      <Icon
        name={icon}
        size={18}
        color={
          disabled ? colors.textFaint : danger ? colors.danger : colors.accent
        }
      />
      <Text
        style={[
          styles.actionText,
          {
            color: disabled
              ? colors.textFaint
              : danger
                ? colors.danger
                : colors.text,
          },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  action: {
    alignItems: "center",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 12,
    minHeight: 50,
  },
  actionText: { fontFamily: family.sansMedium, fontSize: 14 },
  backdrop: { backgroundColor: "rgba(0,0,0,.42)", flex: 1 },
  empty: {
    fontFamily: family.sansRegular,
    fontSize: 13,
    paddingVertical: 18,
  },
  input: {
    borderRadius: 10,
    borderWidth: 1,
    fontFamily: family.sansRegular,
    fontSize: 15,
    marginVertical: 14,
    padding: 12,
  },
  sheet: {
    borderRadius: 18,
    bottom: 24,
    left: 16,
    maxHeight: "70%",
    padding: 20,
    position: "absolute",
    right: 16,
  },
  title: { fontFamily: family.sansMedium, fontSize: 19, marginBottom: 4 },
});
