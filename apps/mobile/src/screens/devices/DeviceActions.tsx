// What one device row's trailing verb opens (issue #765).
//
// The row block gives a row exactly ONE trailing control, and a device answers
// to two verbs, so the control is `Manage` and it opens the app's existing
// single-choice surface (`kit/components/OptionSheet` — the system action
// sheet on iOS, a bottom sheet on Android). This screen adds no new menu
// grammar; it reuses the one the app already has.
//
// Rename is a name the member types, so it is a dialog with a field — the
// idiom `apps/docs/DocsItemActions.tsx` and `apps/photos/AlbumDetail.tsx`
// already use.
//
// Revoke asks twice, and the second ask is the load-bearing one. The gateway
// refuses (409) to revoke the LAST live device of a vault unless the vault's
// own name is echoed back, because losing it strands that vault behind
// filesystem-only recovery. Mobile's HTTP core never surfaces a response body,
// so the screen cannot learn the vault name from the refusal — it takes it
// from the device row and asks the member to TYPE it. Prefilling that field
// would confirm nothing.

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
  /** The row whose verb was pressed. The screen mounts this component KEYED on
   *  that row, so opening a second device starts at its own menu with its own
   *  label rather than inheriting the previous one's half-typed state — which
   *  is what a reset effect would have had to do by hand. */
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
              {`Revoking it leaves ${vaultName} reachable only from the gateway machine and its command line. Type ${vaultName} to confirm.`}
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
