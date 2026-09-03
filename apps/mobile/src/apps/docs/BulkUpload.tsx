import * as DocumentPicker from "expo-document-picker";
import React, { useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import Button from "../../kit/components/Button";
import { Text } from "../../kit/components/NativeText";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { borders, radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { backupDocument } from "../../lib/upload/media-producer";
import type { DocsScreenProps } from "../../navigation";
import { bulkStatus } from "./docs-copy";
import DocsScreen from "./DocsScreen";
import DocsShelfHeader from "./DocsShelfHeader";

interface PickedFile {
  key: string;
  uri: string;
  name: string;
  mediaType: string;
  size: number;
  state: "waiting" | "uploading" | "landed" | "failed";
  error?: string;
}

export default function BulkUpload(
  _props: DocsScreenProps<"DocsUpload">
): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { session, gatewayBase, vaultId } = useReplica();
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [running, setRunning] = useState(false);

  const patch = (key: string, next: Partial<PickedFile>): void => {
    setFiles((current) =>
      current.map((file) => (file.key === key ? { ...file, ...next } : file))
    );
  };

  const pick = async (): Promise<void> => {
    const picked = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: true,
    });
    if (picked.canceled) return;
    const additions = picked.assets.map(
      (asset, index): PickedFile => ({
        key: `${Date.now()}-${index}-${asset.name}`,
        uri: asset.uri,
        name: asset.name,
        mediaType: asset.mimeType ?? "application/octet-stream",
        size: asset.size ?? 0,
        state: "waiting",
      })
    );
    setFiles((current) => [...current, ...additions]);
  };

  const runOne = async (file: PickedFile): Promise<void> => {
    if (!session || !gatewayBase) return;
    patch(file.key, { state: "uploading" });
    try {
      await backupDocument(session, gatewayBase, {
        localUri: file.uri,
        ...(vaultId ? { targetVaultId: vaultId } : {}),
        title: file.name,
        mediaType: file.mediaType,
        plaintextSize: file.size,
        deleteSourceAfterSettle: true,
      });
      patch(file.key, { state: "landed" });
    } catch (error) {
      patch(file.key, {
        state: "failed",
        error:
          error instanceof Error ? error.message : "the transfer did not land",
      });
    }
  };

  const runAll = async (): Promise<void> => {
    if (running) return;
    setRunning(true);
    try {
      const queue = files.filter(
        (file) => file.state === "waiting" || file.state === "failed"
      );
      for (const file of queue) {
        // oxlint-disable-next-line no-await-in-loop -- serial by contract, per the drain lock above
        await runOne(file);
      }
    } finally {
      setRunning(false);
    }
  };

  const landed = files.filter((file) => file.state === "landed").length;
  const failed = files.filter((file) => file.state === "failed").length;
  const pending = files.some(
    (file) => file.state === "waiting" || file.state === "uploading"
  );
  const offline = !session || !gatewayBase;

  return (
    <DocsScreen current="more">
      <DocsShelfHeader title="Uploading" backTo="All" />
      <ReplicaStatusBar />
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.controls}>
          <Button label="Choose files" onPress={() => void pick()} />
          <Button
            label={running ? "Uploading…" : "Upload"}
            variant="primary"
            disabled={
              running ||
              offline ||
              !files.some(
                (file) => file.state === "waiting" || file.state === "failed"
              )
            }
            onPress={() => void runAll()}
          />
        </View>
        {offline ? (
          <Text style={styles.caption}>
            The gateway is out of reach, so nothing can start; the picked files
            stay right here.
          </Text>
        ) : null}

        {files.length > 0 ? (
          <View style={styles.panel}>
            {files.map((file, index) => (
              <View
                key={file.key}
                style={[styles.row, index === 0 ? undefined : styles.rowRule]}
              >
                <View style={styles.rowMain}>
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.rowName,
                      file.state === "failed"
                        ? { color: colors.net }
                        : undefined,
                    ]}
                  >
                    {file.name}
                  </Text>
                  {file.state === "failed" && file.error ? (
                    <Text numberOfLines={2} style={styles.rowError}>
                      {file.error}
                    </Text>
                  ) : null}
                </View>
                <Text
                  style={[
                    styles.rowState,
                    file.state === "failed" ? { color: colors.net } : undefined,
                  ]}
                >
                  {file.state === "waiting"
                    ? "waiting"
                    : file.state === "uploading"
                      ? "uploading…"
                      : file.state === "landed"
                        ? "landed"
                        : "did not land"}
                </Text>
                {file.state === "failed" && !running ? (
                  <Button
                    label="Retry"
                    onPress={() => void runOne(file)}
                    accessibilityHint={`Retry ${file.name}`}
                  />
                ) : null}
              </View>
            ))}
          </View>
        ) : (
          <Text style={styles.caption}>
            Nothing picked yet. Files upload through the product's one durable
            queue and survive the app closing mid-transfer.
          </Text>
        )}

        {files.length > 0 && !pending ? (
          <Text style={styles.status}>
            {bulkStatus(landed, failed, files.length)}
          </Text>
        ) : files.length > 0 ? (
          <Text style={styles.status}>
            {`${landed} of ${files.length} landed`}
          </Text>
        ) : null}
      </ScrollView>
    </DocsScreen>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    caption: { ...t("small"), color: colors.textFaint, paddingTop: 8 },
    controls: { flexDirection: "row", gap: 10 },
    panel: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: borders.hairline,
      marginTop: 12,
      overflow: "hidden",
    },
    row: {
      alignItems: "center",
      flexDirection: "row",
      gap: 10,
      minHeight: 44,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    rowError: { ...t("small"), color: colors.net },
    rowMain: { flex: 1, gap: 1, minWidth: 0 },
    rowName: { ...t("body"), color: colors.text },
    rowRule: {
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
    },
    rowState: { ...t("small"), color: colors.textFaint },
    scroll: { paddingBottom: 32, paddingHorizontal: 18, paddingTop: 8 },
    status: { ...t("mono"), color: colors.textFaint, paddingTop: 8 },
  });
