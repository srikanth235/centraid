import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';

import { BrandMark, DoneCheck, ForwardArrow, OrbitArt } from './onboarding-art';
import { family } from '../kit/theme';
import {
  BRAND_TEAL,
  PROFILE_COLORS,
  initialsOf,
  setOnboarded,
  setProfileColor,
  setProfileName,
} from '../lib/profile';
import { isTunnelAvailable, pair } from '../lib/phone-link';

// First-run onboarding — a self-contained, always-dark flow rendered ahead of
// the tab shell (App.tsx gates on `profile.onboarded`).
//
// There is exactly one way in: a pair ticket (issue #603). A gateway founds
// itself when it first starts, so the phone never creates or restores vaults —
// it enrolls as a device and lands in the gateway's Shared vault by default.
// Once the enrollment is real we collect the person's display name and accent
// colour (the same fields Settings → You edits), then hand off to the shell.

type Step = 'connect' | 'profile' | 'done';

// Always-dark onboarding palette (independent of the OS theme). Settings'
// ColorSwatchRow resolves against the OS scheme, so onboarding renders its own
// swatch row here over the shared PROFILE_COLORS set.
const C = {
  bg: '#0b0e13',
  panel: 'rgba(255,255,255,.055)',
  panelLine: 'rgba(255,255,255,.12)',
  fieldBg: 'rgba(255,255,255,.06)',
  fieldLine: 'rgba(255,255,255,.14)',
  ink: '#ffffff',
  ink2: 'rgba(255,255,255,.8)',
  ink3: 'rgba(255,255,255,.55)',
  ink4: 'rgba(255,255,255,.4)',
  brand: BRAND_TEAL,
};

function defaultDeviceName(): string {
  return Platform.OS === 'ios' ? 'iPhone' : 'Android phone';
}

export default function Onboarding({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [step, setStep] = useState<Step>('connect');
  const [deviceName, setDeviceName] = useState(defaultDeviceName());
  const [displayName, setDisplayName] = useState('');

  const saveProfile = (name: string, color: string): void => {
    setProfileName(name);
    setProfileColor(color);
    setOnboarded(true);
    setDisplayName(name);
    setStep('done');
  };

  const enter = (): void => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onDone();
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.topRow}>
          <View style={styles.wordmark}>
            <BrandMark size={22} />
            <Text style={styles.wordmarkText}>CENTRAID</Text>
          </View>
        </View>

        <View style={styles.hero}>
          <OrbitArt />
        </View>

        {step === 'connect' ? (
          <ConnectionStep
            deviceName={deviceName}
            onDeviceName={setDeviceName}
            onPaired={() => setStep('profile')}
          />
        ) : step === 'profile' ? (
          <ProfileStep onSave={saveProfile} />
        ) : (
          <Done name={displayName} onEnter={enter} />
        )}
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
  onPaired: () => void;
}): React.JSX.Element {
  const available = isTunnelAvailable();
  const [scanning, setScanning] = useState(false);
  const [code, setCode] = useState('');
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [permission, requestPermission] = useCameraPermissions();
  const scannedRef = useRef(false);

  useEffect(() => {
    if (scanning && permission && !permission.granted && permission.canAskAgain) {
      void requestPermission();
    }
  }, [scanning, permission, requestPermission]);

  const submit = (payload: string): void => {
    if (scannedRef.current || !payload.trim()) return;
    scannedRef.current = true;
    setScanning(false);
    setPairing(true);
    setError(undefined);
    const run = async (): Promise<void> => {
      try {
        await pair(payload, deviceName);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        onPaired();
      } catch (err) {
        scannedRef.current = false;
        setError(err instanceof Error ? err.message : String(err));
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
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
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
        Scan the QR from your desktop&apos;s Connect phone screen, or paste the ticket printed by{' '}
        <Text style={styles.ledeStrong}>centraid-gateway pair</Text>.
      </Text>
      <Text style={styles.fieldLabel}>DEVICE NAME</Text>
      <TextInput
        value={deviceName}
        onChangeText={onDeviceName}
        style={styles.input}
        maxLength={60}
      />
      <Text style={[styles.fieldLabel, styles.fieldGap]}>PAIRING CODE</Text>
      <TextInput
        value={code}
        onChangeText={setCode}
        placeholder="Paste the one-line ticket"
        placeholderTextColor={C.ink4}
        multiline
        textAlignVertical="top"
        style={styles.phrase}
        autoCapitalize="none"
        autoCorrect={false}
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {available ? null : (
        <Text style={styles.note}>
          Pairing needs a development build — the tunnel isn&apos;t available in Expo Go. You can
          pair later from Settings.
        </Text>
      )}

      {available ? (
        <>
          <PrimaryButton
            label={pairing ? 'Connecting…' : 'Continue with pasted code'}
            onPress={() => (pairing ? undefined : submit(code))}
          />
          <Pressable
            onPress={() => (pairing ? undefined : setScanning(true))}
            style={styles.textBtn}
          >
            <Text style={styles.textBtnLabel}>Scan QR instead</Text>
          </Pressable>
        </>
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
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(BRAND_TEAL);
  const [error, setError] = useState<string>();

  const save = (): void => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Enter a name so the people you share with know who you are.');
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
        Your name and colour show on your avatar here and to anyone you share a space with. You can
        change both later in Settings.
      </Text>

      <View style={styles.identity}>
        <View style={[styles.avatar, { backgroundColor: color }]}>
          <Text style={styles.avatarInitial}>{initialsOf(name)}</Text>
        </View>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Your name"
          placeholderTextColor={C.ink4}
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
                { backgroundColor: hex, borderColor: active ? C.ink : 'transparent' },
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.swatchMark}>{active ? '✓' : ''}</Text>
            </Pressable>
          );
        })}
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      <PrimaryButton label="Continue" onPress={save} arrow />
    </View>
  );
}

function Done({ name, onEnter }: { name: string; onEnter: () => void }): React.JSX.Element {
  const greet = name.trim().split(/\s+/u).find(Boolean) ?? 'friend';
  return (
    <View style={styles.center}>
      <View style={styles.doneBadge}>
        <DoneCheck />
      </View>
      <Text style={[styles.h1, styles.center]}>
        You&apos;re all set, <Text style={styles.h1Accent}>{greet}</Text>.
      </Text>
      <Text style={[styles.lede, styles.center]}>
        Your space is ready. Everything you build lands on your home screen — yours, on this phone.
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
}: {
  label: string;
  onPress: () => void;
  arrow?: boolean;
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
    >
      <Text style={styles.primaryLabel}>{label}</Text>
      {arrow ? <ForwardArrow /> : null}
    </Pressable>
  );
}

const AVATAR = 52;
const SWATCH = 34;

const styles = StyleSheet.create({
  avatar: {
    alignItems: 'center',
    borderRadius: AVATAR / 2,
    height: AVATAR,
    justifyContent: 'center',
    width: AVATAR,
  },
  avatarInitial: { color: '#fff', fontFamily: family.sansBold, fontSize: 19 },
  center: { alignItems: 'center' },
  doneBadge: {
    alignItems: 'center',
    backgroundColor: C.brand,
    borderRadius: 38,
    height: 76,
    justifyContent: 'center',
    marginBottom: 22,
    width: 76,
  },
  error: { color: '#E88', fontFamily: family.sansRegular, fontSize: 13, marginTop: 14 },
  fieldLabel: {
    color: C.ink4,
    fontFamily: family.monoMedium,
    fontSize: 11,
    letterSpacing: 1,
    marginBottom: 9,
  },
  fieldGap: { marginTop: 20 },
  h1: {
    color: C.ink,
    fontFamily: family.displayBold,
    fontSize: 31,
    letterSpacing: -0.8,
    lineHeight: 37,
    marginBottom: 12,
  },
  h1Accent: { color: C.brand },
  hero: { alignItems: 'center', justifyContent: 'center', paddingVertical: 18 },
  identity: { alignItems: 'center', flexDirection: 'row', gap: 13 },
  identityInput: { flex: 1 },
  input: {
    backgroundColor: C.fieldBg,
    borderColor: C.fieldLine,
    borderRadius: 13,
    borderWidth: StyleSheet.hairlineWidth,
    color: C.ink,
    fontFamily: family.sansRegular,
    fontSize: 16,
    height: 52,
    paddingHorizontal: 16,
  },
  lede: {
    color: C.ink3,
    fontFamily: family.sansRegular,
    fontSize: 15,
    lineHeight: 23,
    marginBottom: 24,
  },
  ledeStrong: { color: C.ink2 },
  note: {
    color: C.ink3,
    fontFamily: family.sansRegular,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 14,
  },
  phrase: {
    backgroundColor: C.fieldBg,
    borderColor: C.fieldLine,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    color: C.ink,
    fontFamily: family.monoRegular,
    fontSize: 15,
    lineHeight: 26,
    minHeight: 120,
    padding: 15,
  },
  pressed: { opacity: 0.82 },
  primary: {
    alignItems: 'center',
    backgroundColor: C.brand,
    borderRadius: 14,
    flexDirection: 'row',
    gap: 8,
    height: 52,
    justifyContent: 'center',
    marginTop: 28,
  },
  primaryLabel: { color: '#fff', fontFamily: family.sansBold, fontSize: 16 },
  safe: { backgroundColor: C.bg, flex: 1 },
  scanFrame: {
    aspectRatio: 1,
    backgroundColor: '#000',
    borderRadius: 22,
    marginTop: 8,
    overflow: 'hidden',
    width: '100%',
  },
  scroll: { flexGrow: 1, paddingHorizontal: 26, paddingTop: 20, paddingBottom: 34 },
  swatch: {
    alignItems: 'center',
    borderRadius: SWATCH / 2,
    borderWidth: 2,
    height: SWATCH,
    justifyContent: 'center',
    width: SWATCH,
  },
  swatchMark: { color: '#fff', fontFamily: family.sansBold, fontSize: 14 },
  swatchRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  textBtn: { alignItems: 'center', height: 48, justifyContent: 'center', marginTop: 10 },
  textBtnLabel: { color: C.ink3, fontFamily: family.sansMedium, fontSize: 15 },
  topRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  wordmark: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  wordmarkText: { color: C.ink3, fontFamily: family.monoMedium, fontSize: 11, letterSpacing: 2 },
});
