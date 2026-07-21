// governance: allow-repo-hygiene file-size-limit cohesive design-port onboarding flow (welcome/identity/recover/pair/done steps in one file); split into per-step components in a follow-up (#498)
import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import Svg, { Circle, Defs, Ellipse, G, Path, RadialGradient, Rect, Stop } from 'react-native-svg';

import { family } from '../kit/theme';
import { BRAND_TEAL, setOnboarded, setProfileColor, setProfileName } from '../lib/profile';
import { isTunnelAvailable, pair } from '../lib/phone-link';

// First-run onboarding — a self-contained, always-dark flow rendered ahead of
// the tab shell (App.tsx gates on `profile.onboarded`). It captures a display
// name and optionally pairs to the desktop over the iroh tunnel; both "start
// fresh" and "recover" converge on pairing, since the phone is a client of a
// desktop-hosted vault. See the "Centraid Mobile" design (onboarding frames).

type Step = 'welcome' | 'identity' | 'recover' | 'pair' | 'done';

// Always-dark onboarding palette (independent of the OS theme).
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
  const [step, setStep] = useState<Step>('welcome');
  const [name, setName] = useState('');

  const enter = (): void => {
    setProfileName(name);
    setProfileColor(BRAND_TEAL);
    setOnboarded(true);
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
          {step !== 'done' ? (
            <Pressable hitSlop={8} onPress={enter} accessibilityLabel="Skip onboarding">
              <Text style={styles.skip}>Skip</Text>
            </Pressable>
          ) : null}
        </View>

        <View style={styles.hero}>
          <OrbitArt />
        </View>

        {step === 'welcome' ? (
          <Welcome onFresh={() => setStep('identity')} onRecover={() => setStep('recover')} />
        ) : step === 'identity' ? (
          <Identity name={name} onName={setName} onContinue={() => setStep('pair')} />
        ) : step === 'recover' ? (
          <Recover onContinue={() => setStep('pair')} onBack={() => setStep('welcome')} />
        ) : step === 'pair' ? (
          <PairStep onPaired={() => setStep('done')} onSkip={() => setStep('done')} />
        ) : (
          <Done name={name} onEnter={enter} />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Welcome({
  onFresh,
  onRecover,
}: {
  onFresh: () => void;
  onRecover: () => void;
}): React.JSX.Element {
  return (
    <View>
      <Text style={styles.h1}>
        Welcome to <Text style={styles.h1Accent}>Centraid</Text>.
      </Text>
      <Text style={styles.lede}>Starting fresh, or bringing a vault back from a backup?</Text>
      <ChoiceCard
        title="Start fresh"
        sub="Set up a brand-new vault for this phone."
        onPress={onFresh}
      />
      <ChoiceCard
        title="Recover my vault"
        sub="Bring everything back from your recovery kit."
        onPress={onRecover}
      />
    </View>
  );
}

function Identity({
  name,
  onName,
  onContinue,
}: {
  name: string;
  onName: (v: string) => void;
  onContinue: () => void;
}): React.JSX.Element {
  return (
    <View>
      <Text style={[styles.h1, styles.center]}>
        Make yourself <Text style={styles.h1Accent}>at home</Text>.
      </Text>
      <Text style={[styles.lede, styles.center]}>
        A name for your profile — change it any time.
      </Text>
      <Text style={styles.fieldLabel}>YOUR NAME</Text>
      <TextInput
        value={name}
        onChangeText={onName}
        placeholder="What should we call you?"
        placeholderTextColor={C.ink4}
        maxLength={60}
        style={styles.input}
        returnKeyType="done"
        autoCapitalize="words"
        autoCorrect={false}
        onSubmitEditing={onContinue}
      />
      <PrimaryButton label="Continue" arrow onPress={onContinue} />
    </View>
  );
}

function Recover({
  onContinue,
  onBack,
}: {
  onContinue: () => void;
  onBack: () => void;
}): React.JSX.Element {
  const [phrase, setPhrase] = useState('');
  return (
    <View>
      <Text style={styles.h1}>
        Recover your <Text style={styles.h1Accent}>vault</Text>.
      </Text>
      <Text style={styles.lede}>
        Your vault lives on your desktop. Connect it next to bring everything back — apps, data and
        history. Have your recovery phrase handy.
      </Text>
      <TextInput
        value={phrase}
        onChangeText={setPhrase}
        placeholder="abandon ability able about above absent…"
        placeholderTextColor={C.ink4}
        multiline
        textAlignVertical="top"
        style={styles.phrase}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <PrimaryButton label="Continue to connect" onPress={onContinue} />
      <Pressable onPress={onBack} style={styles.textBtn}>
        <Text style={styles.textBtnLabel}>Back</Text>
      </Pressable>
    </View>
  );
}

function PairStep({
  onPaired,
  onSkip,
}: {
  onPaired: () => void;
  onSkip: () => void;
}): React.JSX.Element {
  const available = isTunnelAvailable();
  const [scanning, setScanning] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [permission, requestPermission] = useCameraPermissions();
  const scannedRef = useRef(false);

  useEffect(() => {
    if (scanning && permission && !permission.granted && permission.canAskAgain) {
      void requestPermission();
    }
  }, [scanning, permission, requestPermission]);

  const onScanned = (payload: string): void => {
    if (scannedRef.current) return;
    scannedRef.current = true;
    setScanning(false);
    setPairing(true);
    setError(undefined);
    pair(payload, defaultDeviceName())
      .then(() => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        onPaired();
      })
      .catch((err: unknown) => {
        scannedRef.current = false;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setPairing(false));
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
            onBarcodeScanned={({ data }) => onScanned(data)}
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
        Connect your <Text style={styles.h1Accent}>computer</Text>.
      </Text>
      <Text style={styles.lede}>
        Open Centraid on your computer, choose <Text style={styles.ledeStrong}>Connect phone</Text>,
        and point your camera at the code.
      </Text>

      <Pressable
        onPress={() => (available ? setScanning(true) : undefined)}
        style={styles.qrPlaceholder}
        accessibilityLabel="Open camera to scan"
      >
        <QrCorners />
        <View style={styles.qrGlyph}>
          <Svg width={72} height={72} viewBox="0 0 24 24" fill="none">
            <Path
              d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z"
              stroke={C.ink3}
              strokeWidth={1.4}
              strokeLinejoin="round"
            />
            <Rect x={15} y={15} width={2} height={2} fill={C.ink3} />
            <Rect x={18} y={18} width={2} height={2} fill={C.ink3} />
          </Svg>
        </View>
      </Pressable>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {!available ? (
        <Text style={styles.note}>
          Pairing needs a development build — the tunnel isn't available in Expo Go. You can pair
          later from Settings.
        </Text>
      ) : null}

      {available ? (
        <PrimaryButton
          label={pairing ? 'Pairing…' : 'Scan pairing code'}
          onPress={() => (pairing ? undefined : setScanning(true))}
        />
      ) : null}
      <Pressable onPress={onSkip} style={styles.textBtn}>
        <Text style={styles.textBtnLabel}>{available ? 'Set up later' : 'Continue'}</Text>
      </Pressable>
    </View>
  );
}

function Done({ name, onEnter }: { name: string; onEnter: () => void }): React.JSX.Element {
  const greet = name.trim().split(/\s+/).find(Boolean) ?? 'friend';
  return (
    <View style={styles.center}>
      <View style={styles.doneBadge}>
        <Svg width={36} height={36} viewBox="0 0 24 24" fill="none">
          <Path
            d="M4 12l5 5 11-11"
            stroke="#fff"
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      </View>
      <Text style={[styles.h1, styles.center]}>
        You&apos;re all set, <Text style={styles.h1Accent}>{greet}</Text>.
      </Text>
      <Text style={[styles.lede, styles.center]}>
        Your vault is ready. Everything you build lands on your home screen — yours, on this phone.
      </Text>
      <PrimaryButton label="Enter Centraid" onPress={onEnter} />
    </View>
  );
}

// --- shared pieces ---

function ChoiceCard({
  title,
  sub,
  onPress,
}: {
  title: string;
  sub: string;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.choice, pressed && styles.pressed]}
    >
      <View style={styles.choiceHead}>
        <Text style={styles.choiceTitle}>{title}</Text>
        <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
          <Path
            d="M9 6l6 6-6 6"
            stroke={C.ink4}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      </View>
      <Text style={styles.choiceSub}>{sub}</Text>
    </Pressable>
  );
}

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
      {arrow ? (
        <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
          <Path
            d="M5 12h14M13 6l6 6-6 6"
            stroke="#fff"
            strokeWidth={2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      ) : null}
    </Pressable>
  );
}

function BrandMark({ size = 22 }: { size?: number }): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x={0} y={0} width={24} height={24} rx={7} fill={C.brand} />
      <Circle cx={12} cy={12} r={7} stroke="#fff" strokeWidth={2} />
      <Circle cx={12} cy={12} r={2.2} fill="#fff" />
    </Svg>
  );
}

function QrCorners(): React.JSX.Element {
  const base = { position: 'absolute' as const, width: 34, height: 34 };
  const b = 3;
  return (
    <>
      <View
        style={[
          base,
          {
            left: 14,
            top: 14,
            borderLeftWidth: b,
            borderTopWidth: b,
            borderColor: C.brand,
            borderTopLeftRadius: 8,
          },
        ]}
      />
      <View
        style={[
          base,
          {
            right: 14,
            top: 14,
            borderRightWidth: b,
            borderTopWidth: b,
            borderColor: C.brand,
            borderTopRightRadius: 8,
          },
        ]}
      />
      <View
        style={[
          base,
          {
            left: 14,
            bottom: 14,
            borderLeftWidth: b,
            borderBottomWidth: b,
            borderColor: C.brand,
            borderBottomLeftRadius: 8,
          },
        ]}
      />
      <View
        style={[
          base,
          {
            right: 14,
            bottom: 14,
            borderRightWidth: b,
            borderBottomWidth: b,
            borderColor: C.brand,
            borderBottomRightRadius: 8,
          },
        ]}
      />
    </>
  );
}

// Simplified "Centraid orbit" hero — a glowing core with orbiting app tiles.
function OrbitArt(): React.JSX.Element {
  return (
    <Svg width={280} height={200} viewBox="0 0 200 150" fill="none">
      <Defs>
        <RadialGradient id="core" cx="38%" cy="28%" r="80%">
          <Stop offset="0%" stopColor="#63E2C6" />
          <Stop offset="55%" stopColor="#22A78F" />
          <Stop offset="100%" stopColor="#0E7B6C" />
        </RadialGradient>
        <RadialGradient id="glow" cx="50%" cy="50%" r="50%">
          <Stop offset="0%" stopColor="#33B8A1" stopOpacity={0.45} />
          <Stop offset="100%" stopColor="#33B8A1" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Ellipse cx={100} cy={76} rx={74} ry={62} fill="url(#glow)" />
      <G transform="rotate(-16 100 76)">
        <Ellipse
          cx={100}
          cy={76}
          rx={46}
          ry={30}
          fill="none"
          stroke="rgba(51,184,161,.45)"
          strokeWidth={1.3}
        />
        <Ellipse
          cx={100}
          cy={76}
          rx={72}
          ry={47}
          fill="none"
          stroke="rgba(51,184,161,.26)"
          strokeWidth={1.3}
        />
      </G>
      <G transform="rotate(-10 46 52)">
        <Rect x={39.5} y={45.5} width={13} height={13} rx={4} fill="#4E68DD" />
      </G>
      <G transform="rotate(9 150 46)">
        <Rect x={143.5} y={39.5} width={13} height={13} rx={4} fill="#E55772" />
      </G>
      <G transform="rotate(-8 160 96)">
        <Rect x={153.5} y={89.5} width={13} height={13} rx={4} fill="#E89A3C" />
      </G>
      <G transform="rotate(10 52 104)">
        <Rect x={45.5} y={97.5} width={13} height={13} rx={4} fill="#5C8A4E" />
      </G>
      <Circle cx={100} cy={76} r={21} fill="url(#core)" />
      <Circle cx={100} cy={76} r={7.6} stroke="#fff" strokeWidth={1.8} fill="none" />
      <Circle cx={100} cy={76} r={2.4} fill="#fff" />
    </Svg>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center' },
  choice: {
    backgroundColor: C.panel,
    borderColor: C.panelLine,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: 12,
    padding: 17,
  },
  choiceHead: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  choiceSub: {
    color: C.ink3,
    fontFamily: family.sansRegular,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 5,
  },
  choiceTitle: { color: C.ink, fontFamily: family.sansBold, fontSize: 16 },
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
  qrGlyph: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  qrPlaceholder: {
    alignSelf: 'center',
    backgroundColor: '#05070b',
    borderRadius: 22,
    height: 236,
    marginTop: 8,
    overflow: 'hidden',
    width: 236,
  },
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
  skip: { color: C.ink4, fontFamily: family.sansRegular, fontSize: 13, padding: 6 },
  textBtn: { alignItems: 'center', height: 48, justifyContent: 'center', marginTop: 10 },
  textBtnLabel: { color: C.ink3, fontFamily: family.sansMedium, fontSize: 15 },
  topRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  wordmark: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  wordmarkText: { color: C.ink3, fontFamily: family.monoMedium, fontSize: 11, letterSpacing: 2 },
});
