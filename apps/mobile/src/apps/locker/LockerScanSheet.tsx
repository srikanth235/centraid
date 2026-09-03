// THE ONE-TIME-CODE SCANNER — the origin seat's own capability.
//
// FLOWS.md: "The one-time code offers Scan only on the phone; elsewhere it
// says how to get the seed instead." This is that Scan. It follows the frame's
// established camera pattern (`screens/Onboarding.tsx`): `useCameraPermissions`
// for the grant, `CameraView` with `barcodeScannerSettings` restricted to
// `qr`, and one `onBarcodeScanned` handler.
//
// THE SEED IS READ AND HANDED STRAIGHT TO THE FORM. It is never written to
// this device: the field that receives it is `editSeed`, one of the enumerated
// secret-bearing values a lock wipes, and the write that carries it is
// online-only. Nothing here logs the code or keeps a frame.
//
// A SQUARE THAT IS NOT AN OTPAUTH CODE IS REFUSED BY NAME, not swallowed: a
// scanner that quietly ignored a wifi square would look broken.
import { CameraView, useCameraPermissions } from "expo-camera";
import React, { useState } from "react";
import { Modal, StyleSheet, View } from "react-native";

import Button from "../../kit/components/Button";
import { Text } from "../../kit/components/NativeText";
import { borders, radii, spacing, t, useTheme } from "../../kit/theme";
import {
  SCAN_CANCEL,
  SCAN_GRANT,
  SCAN_NOTE,
  SCAN_REFUSED,
  SCAN_TITLE,
  SCAN_UNREADABLE,
} from "./locker-seat-copy";
import { otpauthSeed } from "./otpauth";

export interface LockerScanSheetProps {
  visible: boolean;
  onSeed: (seed: string) => void;
  onClose: () => void;
}

export default function LockerScanSheet({
  visible,
  onSeed,
  onClose,
}: LockerScanSheetProps): React.JSX.Element {
  const { colors } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [refusal, setRefusal] = useState("");

  const read = (data: string): void => {
    const seed = otpauthSeed(data);
    if (!seed) {
      setRefusal(SCAN_UNREADABLE);
      return;
    }
    setRefusal("");
    onSeed(seed);
  };

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      visible={visible}
      transparent={false}
    >
      <View style={[styles.page, { backgroundColor: colors.bg }]}>
        <Text
          accessibilityRole="header"
          style={[styles.title, { color: colors.text }]}
        >
          {SCAN_TITLE}
        </Text>

        {permission?.granted === true ? (
          <View style={[styles.frame, { borderColor: colors.lineStrong }]}>
            <CameraView
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              facing="back"
              onBarcodeScanned={({ data }) => read(data)}
              style={StyleSheet.absoluteFill}
            />
          </View>
        ) : (
          <View style={styles.grant}>
            <Text style={[styles.note, { color: colors.textSoft }]}>
              {SCAN_REFUSED}
            </Text>
            <Button
              label={SCAN_GRANT}
              onPress={() => void requestPermission()}
              variant="primary"
            />
          </View>
        )}

        <Text style={[styles.note, { color: colors.textFaint }]}>
          {SCAN_NOTE}
        </Text>
        {refusal ? (
          <Text
            accessibilityRole="alert"
            style={[styles.note, { color: colors.net }]}
          >
            {refusal}
          </Text>
        ) : null}
        <Button label={SCAN_CANCEL} onPress={onClose} />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  frame: {
    aspectRatio: 1,
    borderRadius: radii.lg,
    borderWidth: borders.hairline,
    overflow: "hidden",
    width: "100%",
  },
  grant: { alignItems: "flex-start", gap: spacing[3] },
  note: { ...t("mono") },
  page: { flex: 1, gap: spacing[4], padding: spacing[4] },
  title: { ...t("title") },
});
