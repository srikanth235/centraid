import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import React, { useRef, useState } from "react";
import type { LayoutChangeEvent } from "react-native";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";

import { readSelfMemberName } from "../lib/gateway";
import { isTunnelAvailable, pair } from "../lib/phone-link";
import {
  BRAND_TEAL,
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

// First-run onboarding — a self-contained, always-dark flow rendered ahead of
// the tab shell (App.tsx gates on `profile.onboarded`).
//
// There is exactly one way in: a pair ticket (issue #603). A gateway founds
// itself when it first starts, so the phone never creates or restores vaults —
// it enrolls as a device and focuses the first vault grant by default. A
// single ticket may make additional vaults available in the switcher.
// Once the enrollment is real we collect the person's display name and accent
// colour (the same fields Settings → You edits), then hand off to the shell.

type Step = "connect" | "profile" | "done";

function defaultDeviceName(): string {
  return Platform.OS === "ios" ? "iPhone" : "Android phone";
}

// Every step must fit the device it runs on: the primary action is the whole
// point of the screen, so it may never sit below the fold. A step's own content
// is whatever its fields and buttons need, which leaves the decorative hero as
// the one element that can give — so it does. Measure the two blocks around the
// art and hand it whatever is left over, up to its natural size; on a short
// phone it shrinks, and past HERO_MIN it stops earning its space and goes away
// entirely. That re-runs whenever a step grows — revealing the pairing-code box
// is the case that matters — so the art yields to real content on the spot. The
// ScrollView stays as the last resort for what no shrinking fits (landscape,
// huge type).
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

  // Hero sizing. Both measured blocks are siblings of the art, so their heights
  // never depend on it — the fit converges in one pass instead of oscillating.
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

  /**
   * The profile step is CONDITIONAL: it exists to learn a name nobody has
   * given yet. When the gateway's roster already names this person — the
   * self-pair case, adding your own second device — asking again would be a
   * second chance to disagree with yourself, so the flow adopts the roster's
   * name and goes straight to Done.
   */
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
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
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
    </SafeAreaView>
  );
}

function ConnectionStep({
  deviceName,
  onDeviceName,
  onPaired,
}: {
  deviceName: string;
  onDeviceName: (value: string) => void;
  /** The roster's name for this person, when it already has one. */
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

  /**
   * Open the scanner, asking for the camera if we may. Resolving permission
   * here rather than in an effect keeps the whole decision in the one place
   * the person actually initiated it, and means a refusal has somewhere to go:
   * when access is off for good, scanning can never succeed, so hand over the
   * paste fallback with the reason instead of leaving a primary button that
   * silently does nothing.
   */
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
        "Camera access is off for Centraid. Turn it on in Settings, or paste a code below."
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
        // Pairing a second device for someone the roster already knows must
        // not ask them who they are again — read the name the enrollment came
        // back with and let the caller skip the profile step. Undefined (no
        // device plane, unreachable) means "ask", never "assume".
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
            value={code}
            onChangeText={setCode}
            placeholder="Paste the one-line ticket"
            placeholderTextColor={C.textGhost}
            multiline
            textAlignVertical="top"
            style={styles.phrase}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {available ? null : (
        <Text style={styles.note}>
          Pairing needs a development build — the tunnel isn&apos;t available in
          Expo Go. You can pair later from Settings.
        </Text>
      )}

      {/* Exactly one path is primary at a time, and scanning is the default
          one. Pasting a ticket stays a keystroke away behind the quiet link,
          but it does not get to occupy the screen until it is asked for — a
          permanent 120pt code box outweighs any button label and makes typing
          look like the job. */}
      {available ? (
        showPaste ? (
          <>
            <PrimaryButton
              // testID so Maestro taps the Pressable, not the child TextView
              // (run 30708832841: ^Connect$ matched clickable=false Text and
              // never fired submit — ticket stayed on screen for the full wait).
              testID="onboarding-connect"
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

/**
 * Unified profile step (issue #603 D2) — the single place a new member says who
 * they are. Same two fields, same palette, as Settings → You, so nothing has to
 * be re-entered after onboarding.
 */
function ProfileStep({
  onSave,
}: {
  onSave: (name: string, color: string) => void;
}): React.JSX.Element {
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(BRAND_TEAL);
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
        Your name and colour show on your avatar here and to anyone you share a
        vault with. You can change both later in Settings.
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
        Your vault is ready. Everything you build lands on your home screen —
        yours, on this phone.
      </Text>
      <PrimaryButton label="Enter Centraid" onPress={onEnter} />
    </View>
  );
}

// --- shared pieces ---

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
