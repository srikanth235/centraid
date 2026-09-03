import React, { useState } from "react";
import { Alert, Modal, Pressable, TextInput, View } from "react-native";

import Button from "../../kit/components/Button";
import { Text } from "../../kit/components/NativeText";
import OptionSheet from "../../kit/components/OptionSheet";
import { useTheme } from "../../kit/theme";
import type { DeviceRow } from "../../lib/devices";
import { strandedVaultName } from "./devices-model";
import { makeStyles } from "./Devices.styles";

export interface DeviceActionsProps {
  device: DeviceRow;
  busy: boolean;
  onClose: () => void;
  onRename: (deviceId: string, label: string) => Promise<boolean>;
  onRevoke: (
    deviceId: string,
    confirmVaultName?: string
  ) => Promise<"done" | "stranded" | "failed">;
}

type Mode = "menu" | "rename" | "stranded";

export default function DeviceActions({
  device,
  busy,
  onClose,
  onRename,
  onRevoke,
}: DeviceActionsProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const [mode, setMode] = useState<Mode>("menu");
  const [name, setName] = useState(device.label);
  const [confirmName, setConfirmName] = useState("");

  const deviceId = device.deviceId;
  const vaultName = strandedVaultName(device);

  const close = (): void => {
    setMode("menu");
    onClose();
  };

  const revoke = (confirmVaultName?: string): void => {
    void onRevoke(deviceId, confirmVaultName).then((outcome) => {
      if (outcome === "stranded") {
        setMode("stranded");
        return;
      }
      close();
    });
  };

  const askRevoke = (): void => {
    Alert.alert(
      device.current === true ? "Sign out this device?" : "Revoke this device?",
      `${device.label} stops answering for this vault. The person keeps their access and their other devices, and past writes still resolve to it.`,
      [
        { onPress: close, style: "cancel", text: "Cancel" },
        {
          onPress: () => revoke(),
          style: "destructive",
          text: device.current === true ? "Sign out" : "Revoke",
        },
      ]
    );
  };

  const save = (): void => {
    const label = name.trim();
    if (!label) return;
    void onRename(deviceId, label).then((ok) => {
      if (ok) close();
    });
  };

  if (mode === "menu") {
    return (
      <OptionSheet
        onClose={close}
        onSelect={(id) => (id === "rename" ? setMode("rename") : askRevoke())}
        options={[
          { id: "rename", label: "Rename" },
          {
            id: "revoke",
            label: device.current === true ? "Sign out" : "Revoke",
          },
        ]}
        title={device.label}
        visible
      />
    );
  }

  return (
    <Modal animationType="fade" onRequestClose={close} transparent visible>
      <Pressable
        accessibilityLabel="Close"
        accessibilityRole="button"
        onPress={close}
        style={styles.backdrop}
      />
      <View accessibilityViewIsModal style={styles.dialog}>
        {mode === "rename" ? (
          <>
            <Text style={styles.dialogTitle}>Rename device</Text>
            <Text style={styles.dialogAsk}>
              The label is your word for this machine, not the one its operating
              system chose.
            </Text>
            <TextInput
              accessibilityLabel="Device name"
              autoFocus
              onChangeText={setName}
              style={styles.input}
              value={name}
            />
            <View style={styles.dialogActions}>
              <Button label="Cancel" onPress={close} variant="secondary" />
              <Button
                disabled={busy || name.trim().length === 0}
                label="Save"
                onPress={save}
                variant="primary"
              />
            </View>
          </>
        ) : (
          <>
            <Text style={styles.dialogTitle}>This is the last device</Text>
            <Text style={styles.dialogAsk}>
              {`Revoking it leaves ${vaultName} reachable only from its home machine. Type ${vaultName} to confirm.`}
            </Text>
            <TextInput
              accessibilityLabel="Vault name"
              autoFocus
              onChangeText={setConfirmName}
              style={styles.input}
              value={confirmName}
            />
            <View style={styles.dialogActions}>
              <Button label="Cancel" onPress={close} variant="secondary" />
              <Button
                disabled={busy || confirmName.trim() !== vaultName}
                label="Revoke anyway"
                onPress={() => revoke(vaultName)}
                variant="destructive"
              />
            </View>
          </>
        )}
      </View>
    </Modal>
  );
}
