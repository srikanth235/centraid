import React from "react";
import { Pressable, View } from "react-native";

import { formatBytes } from "@centraid/design";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { t } from "../../kit/theme";
import type { useTheme } from "../../kit/theme";
import type { DocsScreenProps } from "../../navigation";
import {
  DOCS_CUSTODY_ICON,
  DOCS_CUSTODY_LABEL,
  marksLocalOnly,
} from "./docs-custody";
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
          <Icon name="folder" size={20} color={colors.accent} />
        </View>
        <View style={styles.copy}>
          <Text style={[styles.rowTitle, { color: colors.text }]}>
            {item.folder.name}
          </Text>
          <Text style={[styles.meta, { color: colors.textSoft }]}>Folder</Text>
        </View>
        <Icon name="chevron-right" size={18} color={colors.textFaint} />
        <Pressable
          accessibilityLabel={`Actions for ${item.folder.name}`}
          hitSlop={10}
          onPress={() => onMenu(item)}
        >
          <Icon name="more-vertical" size={19} color={colors.textSoft} />
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
        <Icon
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
        <View style={styles.metaRow}>
          <Text
            style={[styles.meta, { color: colors.textSoft, flexShrink: 1 }]}
          >
            {item.location ? `${item.location} · ` : ""}
            {formatType(item.document.mediaType)} ·{" "}
            <Text style={[t("mono"), { color: colors.textSoft }]}>
              {formatBytes(item.document.byteSize)}
            </Text>{" "}
            · {item.document.scopeLabels?.join(" + ") ?? "Vault"}
          </Text>
          {/* The custody EXCEPTION only, as a mark — never a sentence
              (docs/blueprint-seats.md "Byte custody vocabulary"). The two
              normal states (`backed up`, `on the gateway`) say nothing here;
              their full story is DocumentViewer's, on demand. */}
          {marksLocalOnly(item.document.custody) ? (
            <View
              accessibilityLabel={DOCS_CUSTODY_LABEL}
              accessibilityRole="image"
              style={styles.custodyMark}
            >
              <Icon
                name={DOCS_CUSTODY_ICON}
                size={12}
                color={colors.textSoft}
              />
            </View>
          ) : null}
        </View>
      </View>
      {item.document.starred ? (
        <Icon name="star" size={16} color="#d99b18" />
      ) : null}
      <Pressable
        accessibilityLabel={`Actions for ${item.document.title}`}
        hitSlop={10}
        onPress={() => onMenu(item)}
      >
        <Icon name="more-vertical" size={19} color={colors.textSoft} />
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
        <Icon name="more-vertical" size={18} color={colors.textSoft} />
      </Pressable>
      <View style={[styles.gridPreview, { backgroundColor: colors.bgSunken }]}>
        <Icon
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
      <View style={styles.metaRow}>
        <Text style={[styles.meta, { color: colors.textSoft, flexShrink: 1 }]}>
          {document ? (
            <>
              {item.kind === "document" && item.location
                ? `${item.location} · `
                : ""}
              {formatType(document.mediaType)} ·{" "}
              <Text style={[t("mono"), { color: colors.textSoft }]}>
                {formatBytes(document.byteSize)}
              </Text>{" "}
              · {document.scopeLabels?.join(" + ") ?? "Vault"}
            </>
          ) : (
            "Folder"
          )}
        </Text>
        {/* Same row-scale exception mark as ListItem — see there for why. */}
        {document && marksLocalOnly(document.custody) ? (
          <View
            accessibilityLabel={DOCS_CUSTODY_LABEL}
            accessibilityRole="image"
            style={styles.custodyMark}
          >
            <Icon name={DOCS_CUSTODY_ICON} size={12} color={colors.textSoft} />
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const iconFor = (mime: string): string =>
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
