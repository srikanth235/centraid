import React from "react";
import { StyleSheet, View } from "react-native";

import Button from "../../kit/components/Button";
import { Text } from "../../kit/components/NativeText";
import { postStatus } from "../../kit/components/status-line";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { spacing, t, useTheme } from "../../kit/theme";
import type { MobileDriveDoc } from "./docs-projection";
import { useDocumentOfflinePin } from "./offline-pin";

const styles = StyleSheet.create({
  reason: { ...t("small"), marginTop: spacing[1] },
  wrap: { marginTop: spacing[3] },
});

export default function OfflinePinButton({
  doc,
}: {
  doc: MobileDriveDoc | undefined;
}): React.JSX.Element | null {
  const { colors } = useTheme();
  const { gatewayBase, vaultId, online } = useReplica();
  const pin = useDocumentOfflinePin({
    doc,
    gatewayBase,
    vaultId,
    online,
    onStatus: postStatus,
  });
  const handleToggle = pin.toggle;
  if (!doc) return null;
  return (
    <View style={styles.wrap}>
      <Button
        disabled={!pin.available || pin.busy}
        icon={pin.pinned ? "Check" : "Download"}
        label={pin.busy ? "Keeping this on your phone…" : pin.label}
        onPress={handleToggle}
      />
      {pin.reason ? (
        <Text style={[styles.reason, { color: colors.textSoft }]}>
          {pin.reason}
        </Text>
      ) : null}
    </View>
  );
}
