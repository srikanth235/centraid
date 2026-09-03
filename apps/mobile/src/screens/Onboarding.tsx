import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import React, { useRef, useState } from "react";
import type { LayoutChangeEvent } from "react-native";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Text, TextInput } from "../kit/components/NativeText";
import TopSafeArea from "../kit/components/TopSafeArea";
import { TEST_IDS } from "../kit/test-ids";
import { readSelfMemberName } from "../lib/gateway";
import { isTunnelAvailable, pair } from "../lib/phone-link";
import {
  BRAND,
  PROFILE_COLORS,
  initialsOf,
  setOnboarded,
  setProfileColor,
  setProfileName,
} from "../lib/profile";
import {
  BrandMark,
  DoneCheck,
  ForwardArrow,
  ScanTargetMark,
} from "./onboarding-art";
import { HOME_ART, HomeArt } from "./onboarding-home-art";
import {
  C,
  HERO_GAP,
  PAD_BOTTOM,
  PAD_H,
  PAD_TOP,
  styles,
} from "./onboarding-styles";

type Step = "connect" | "profile" | "done";

function defaultDeviceName(): string {
  return Platform.OS === "ios" ? "iPhone" : "Android phone";
}

const HERO_NATURAL = HOME_ART.height;
const HERO_MIN = 96;

export default function Onboarding({
  onDone,
}: {
  onDone: () => void;
}): React.JSX.Element {
  const [step, setStep] = useState<Step>("connect");
  const [deviceName, setDeviceName] = useState(defaultDeviceName());
  const [displayName, setDisplayName] = useState("");

  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [chromeHeight, setChromeHeight] = useState(0);
  const [stepHeight, setStepHeight] = useState(0);
  const measure = (set: (height: number) => void) => {
    return (event: LayoutChangeEvent): void =>
      set(event.nativeEvent.layout.height);
  };

  const spare =
    windowHeight -
    insets.top -
    insets.bottom -
    PAD_TOP -
    PAD_BOTTOM -
    chromeHeight -
    stepHeight -
    HERO_GAP * 2;
  const heroHeight = Math.min(HERO_NATURAL, spare);
  const showHero = heroHeight >= HERO_MIN;

  const saveProfile = (name: string, color: string): void => {
    setProfileName(name);
    setProfileColor(color);
    setOnboarded(true);
    setDisplayName(name);
    setStep("done");
  };

  const afterPaired = (memberName: string | undefined): void => {
    const known = (memberName ?? "").trim();
    if (!known) return setStep("profile");
    setProfileName(known);
    setOnboarded(true);
    setDisplayName(known);
    setStep("done");
  };

  const enter = (): void => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onDone();
  };

  return (
    <TopSafeArea style={styles.safe} edges={["top", "bottom"]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.topRow} onLayout={measure(setChromeHeight)}>
          <View style={styles.wordmark}>
            <BrandMark size={22} />
            <Text style={styles.wordmarkText}>CENTRAID</Text>
          </View>
        </View>

        {showHero ? (
          <View style={styles.hero}>
            <HomeArt width={windowWidth - PAD_H * 2} height={heroHeight} />
          </View>
        ) : null}

        <View onLayout={measure(setStepHeight)}>
          {step === "connect" ? (
            <ConnectionStep
              deviceName={deviceName}
              onDeviceName={setDeviceName}
              onPaired={afterPaired}
            />
          ) : step === "profile" ? (
            <ProfileStep onSave={saveProfile} />
          ) : (
            <Done name={displayName} onEnter={enter} />
          )}
        </View>
      </ScrollView>
    </TopSafeArea>
  );
}

function ConnectionStep({
  deviceName,
  onDeviceName,
  onPaired,
}: {
  deviceName: string;
  onDeviceName: (value: string) => void;
  onPaired: (memberName: string | undefined) => void;
}): React.JSX.Element {
  const available = isTunnelAvailable();
  const [scanning, setScanning] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [code, setCode] = useState("");
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [permission, requestPermission] = useCameraPermissions();
  const scannedRef = useRef(false);

  const startScan = (): void => {
    if (pairing) return;
    if (permission?.granted) return setScanning(true);
    const run = async (): Promise<void> => {
      const next =
        permission?.canAskAgain === false
          ? permission
          : await requestPermission();
      if (next.granted) return setScanning(true);
      setShowPaste(true);
      setError(
        "Camera access is off — enable it in Settings, or paste a code below."
      );
    };
    void run();
  };

  const submit = (payload: string): void => {
    if (scannedRef.current || !payload.trim()) return;
    scannedRef.current = true;
    setScanning(false);
    setPairing(true);
    setError(undefined);
    const run = async (): Promise<void> => {
      try {
        await pair(payload, deviceName);
        void Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success
        );
        onPaired(await readSelfMemberName());
      } catch (caughtError) {
        scannedRef.current = false;
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : String(caughtError)
        );
      } finally {
        setPairing(false);
      }
    };
    void run();
  };

  if (scanning && permission?.granted) {
    return (
      <View>
        <Text style={styles.h1}>Point at the code.</Text>
        <View style={styles.scanFrame}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={({ data }) => submit(data)}
          />
        </View>
        <Pressable onPress={() => setScanning(false)} style={styles.textBtn}>
          <Text style={styles.textBtnLabel}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View>
      <Text style={styles.h1}>
        Connect your <Text style={styles.h1Accent}>gateway</Text>.
      </Text>
      <Text style={styles.lede}>
        {showPaste ? (
          <>
            Paste the one-line ticket printed by{" "}
            <Text style={styles.ledeStrong}>centraid-gateway pair</Text>.
          </>
        ) : (
          <>
            Your desktop is showing a QR code under{" "}
            <Text style={styles.ledeStrong}>Connect phone</Text>. Point this
            phone at it.
          </>
        )}
      </Text>
      <Text style={styles.fieldLabel}>DEVICE NAME</Text>
      <TextInput
        value={deviceName}
        onChangeText={onDeviceName}
        style={styles.input}
        maxLength={60}
      />
      {showPaste ? (
        <>
          <Text style={[styles.fieldLabel, styles.fieldGap]}>PAIRING CODE</Text>
          <TextInput
            testID={TEST_IDS.onboarding.ticketField}
            value={code}
            onChangeText={setCode}
            placeholder="Paste the one-line ticket"
            placeholderTextColor={C.textGhost}
            style={styles.phrase}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {available ? null : (
        <Text style={styles.note}>
          The tunnel isn&apos;t available in Expo Go — pair later from Settings,
          on a development build.
        </Text>
      )}

      {/* One primary path at a time; scanning defaults. Paste stays a
          keystroke away until asked for. */}
      {available ? (
        showPaste ? (
          <>
            <PrimaryButton
              testID={TEST_IDS.onboarding.connect}
              label={pairing ? "Connecting…" : "Connect"}
              onPress={() => (pairing ? undefined : submit(code))}
            />
            <Pressable
              onPress={() => (pairing ? undefined : setShowPaste(false))}
              style={styles.textBtn}
            >
              <Text style={styles.textBtnLabel}>Scan the QR code instead</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Pressable
              accessibilityLabel="Scan the QR code"
              accessibilityRole="button"
              onPress={startScan}
              style={({ pressed }) => [
                styles.scanBtn,
                pressed && styles.pressed,
              ]}
            >
              <ScanTargetMark />
              <Text style={styles.scanBtnLabel}>
                {pairing ? "Connecting…" : "Scan the QR code"}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setShowPaste(true)}
              style={styles.textBtn}
              testID={TEST_IDS.onboarding.paste}
            >
              <Text style={styles.textBtnLabel}>
                Can&apos;t scan? Paste a code instead
              </Text>
            </Pressable>
          </>
        )
      ) : null}
    </View>
  );
}

function ProfileStep({
  onSave,
}: {
  onSave: (name: string, color: string) => void;
}): React.JSX.Element {
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(BRAND);
  const [error, setError] = useState<string>();

  const save = (): void => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter a name so the people you share with know who you are.");
      return;
    }
    setError(undefined);
    onSave(trimmed, color);
  };

  return (
    <View>
      <Text style={styles.h1}>
        Who&apos;s using <Text style={styles.h1Accent}>this phone</Text>?
      </Text>
      <Text style={styles.lede}>
        Your name and colour show on your avatar, here and to anyone you share a
        vault with.
      </Text>

      <View style={styles.identity}>
        <View style={[styles.avatar, { backgroundColor: color }]}>
          <Text style={styles.avatarInitial}>{initialsOf(name)}</Text>
        </View>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Your name"
          placeholderTextColor={C.textGhost}
          style={[styles.input, styles.identityInput]}
          autoCapitalize="words"
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={save}
          maxLength={60}
        />
      </View>

      <Text style={[styles.fieldLabel, styles.fieldGap]}>COLOUR</Text>
      <View style={styles.swatchRow}>
        {PROFILE_COLORS.map((hex) => {
          const active = hex.toLowerCase() === color.toLowerCase();
          return (
            <Pressable
              key={hex}
              accessibilityRole="button"
              accessibilityLabel={`Colour ${hex}`}
              accessibilityState={{ selected: active }}
              onPress={() => setColor(hex)}
              style={({ pressed }) => [
                styles.swatch,
                {
                  backgroundColor: hex,
                  borderColor: active ? C.text : "transparent",
                },
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.swatchMark}>{active ? "✓" : ""}</Text>
            </Pressable>
          );
        })}
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      <PrimaryButton label="Continue" onPress={save} arrow />
    </View>
  );
}

function Done({
  name,
  onEnter,
}: {
  name: string;
  onEnter: () => void;
}): React.JSX.Element {
  const greet = name.trim().split(/\s+/u).find(Boolean) ?? "friend";
  return (
    <View style={styles.center}>
      <View style={styles.doneBadge}>
        <DoneCheck />
      </View>
      <Text style={[styles.h1, styles.center]}>
        You&apos;re all set, <Text style={styles.h1Accent}>{greet}</Text>.
      </Text>
      <Text style={[styles.lede, styles.center]}>
        Everything you build lands on your home screen — yours, on this phone.
      </Text>
      <PrimaryButton label="Enter Centraid" onPress={onEnter} />
    </View>
  );
}

function PrimaryButton({
  label,
  onPress,
  arrow,
  testID,
}: {
  label: string;
  onPress: () => void;
  arrow?: boolean;
  testID?: string;
}): React.JSX.Element {
  return (
    <Pressable
      testID={testID}
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
    >
      <Text style={styles.primaryLabel}>{label}</Text>
      {arrow ? <ForwardArrow /> : null}
    </Pressable>
  );
}
