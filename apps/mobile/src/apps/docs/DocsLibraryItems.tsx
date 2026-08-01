import { Feather } from "@expo/vector-icons";
import React from "react";
import { Pressable, Text, View } from "react-native";

import type { useTheme } from "../../kit/theme";
import type { DocsScreenProps } from "../../navigation";
import type { NativeDocument, NativeFolder } from "./docs-model";
import { styles } from "./DocsHome.styles";

export type DriveItem =
  | { kind: "folder"; folder: NativeFolder }
  | { kind: "document"; document: NativeDocument; location?: string };

type ItemProps = {
  item: DriveItem;
  navigation: DocsScreenProps<"DocsHome">["navigation"];
  colors: ReturnType<typeof useTheme>["colors"];
  onMenu: (item: DriveItem) => void;
};

export function ListItem({
  item,
  navigation,
  colors,
  onMenu,
}: ItemProps): React.JSX.Element {
  if (item.kind === "folder") {
    return (
      <Pressable
        style={[styles.row, { borderBottomColor: colors.line }]}
        onPress={() =>
          navigation.push("DocsHome", { folderId: item.folder.id })
        }
      >
        <View style={[styles.icon, { backgroundColor: colors.bgSunken }]}>
          <Feather name="folder" size={20} color={colors.accent} />
        </View>
        <View style={styles.copy}>
          <Text style={[styles.rowTitle, { color: colors.text }]}>
            {item.folder.name}
          </Text>
          <Text style={[styles.meta, { color: colors.textSoft }]}>Folder</Text>
        </View>
        <Feather name="chevron-right" size={18} color={colors.textFaint} />
        <Pressable
          accessibilityLabel={`Actions for ${item.folder.name}`}
          hitSlop={10}
          onPress={() => onMenu(item)}
        >
          <Feather name="more-vertical" size={19} color={colors.textSoft} />
        </Pressable>
      </Pressable>
    );
  }
  return (
    <Pressable
      style={[styles.row, { borderBottomColor: colors.line }]}
      onPress={() =>
        navigation.navigate("DocumentViewer", { documentId: item.document.id })
      }
    >
      <View style={[styles.icon, { backgroundColor: colors.bgSunken }]}>
        <Feather
          name={iconFor(item.document.mediaType)}
          size={20}
          color={colors.accent}
        />
      </View>
      <View style={styles.copy}>
        <Text
          numberOfLines={1}
          style={[styles.rowTitle, { color: colors.text }]}
        >
          {item.document.title}
        </Text>
        <Text style={[styles.meta, { color: colors.textSoft }]}>
          {item.location ? `${item.location} · ` : ""}
          {formatType(item.document.mediaType)} ·{" "}
          {formatBytes(item.document.byteSize)} ·{" "}
          {item.document.custody ?? "local"} ·{" "}
          {item.document.scopeLabels?.join(" + ") ?? "Vault"}
        </Text>
      </View>
      {item.document.starred ? (
        <Feather name="star" size={16} color="#d99b18" />
      ) : null}
      <Pressable
        accessibilityLabel={`Actions for ${item.document.title}`}
        hitSlop={10}
        onPress={() => onMenu(item)}
      >
        <Feather name="more-vertical" size={19} color={colors.textSoft} />
      </Pressable>
    </Pressable>
  );
}

export function GridItem({
  item,
  navigation,
  colors,
  onMenu,
}: ItemProps): React.JSX.Element {
  const document = item.kind === "document" ? item.document : undefined;
  return (
    <Pressable
      style={[
        styles.gridCard,
        { backgroundColor: colors.bgElev, borderColor: colors.line },
      ]}
      onPress={() =>
        item.kind === "folder"
          ? navigation.push("DocsHome", { folderId: item.folder.id })
          : navigation.navigate("DocumentViewer", {
              documentId: item.document.id,
            })
      }
      onLongPress={() => onMenu(item)}
    >
      <Pressable
        accessibilityLabel={`Actions for ${
          item.kind === "folder" ? item.folder.name : item.document.title
        }`}
        hitSlop={10}
        onPress={() => onMenu(item)}
        style={styles.gridMenu}
      >
        <Feather name="more-vertical" size={18} color={colors.textSoft} />
      </Pressable>
      <View style={[styles.gridPreview, { backgroundColor: colors.bgSunken }]}>
        <Feather
          name={
            item.kind === "folder" ? "folder" : iconFor(item.document.mediaType)
          }
          size={30}
          color={colors.accent}
        />
      </View>
      <Text
        numberOfLines={2}
        style={[styles.gridTitle, { color: colors.text }]}
      >
        {item.kind === "folder" ? item.folder.name : item.document.title}
      </Text>
      <Text style={[styles.meta, { color: colors.textSoft }]}>
        {document
          ? `${item.kind === "document" && item.location ? `${item.location} · ` : ""}${formatType(document.mediaType)} · ${formatBytes(document.byteSize)} · ${document.scopeLabels?.join(" + ") ?? "Vault"}`
          : "Folder"}
      </Text>
    </Pressable>
  );
}

const iconFor = (mime: string): React.ComponentProps<typeof Feather>["name"] =>
  mime.includes("pdf")
    ? "file-text"
    : mime.startsWith("image/")
      ? "image"
      : mime.startsWith("video/")
        ? "video"
        : mime.startsWith("audio/")
          ? "headphones"
          : "file";

const formatType = (mime: string): string =>
  mime.split("/")[1]?.toUpperCase() || "FILE";
const formatBytes = (bytes: number): string =>
  bytes < 1024 ** 2
    ? `${Math.ceil(bytes / 1024)} KB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
