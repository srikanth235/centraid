// governance: allow-repo-hygiene file-size-limit cohesive founding/onboarding ceremony — connection scan, create/restore peers, mandatory kit share + reselect proof, and terminal state share one state machine
import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import Svg, { Circle, Defs, Ellipse, G, Path, RadialGradient, Rect, Stop } from 'react-native-svg';

import { family } from '../kit/theme';
import { BRAND_TEAL, setOnboarded, setProfileColor, setProfileName } from '../lib/profile';
import { isTunnelAvailable, pair, parsePairingInput } from '../lib/phone-link';
import { pickRecoveryKit, shareRecoveryKit } from '../lib/recovery-kit-files';
import {
  initializeMobileVault,
  prepareMobileFounding,
  rememberInitializedVault,
  rememberRestoredVaults,
  restoreMobileVaults,
  verifyMobileFoundingKit,
  type MobileFoundingSession,
  type MobileInitializeResult,
} from '../lib/vault-founding';

// First-run onboarding — a self-contained, always-dark flow rendered ahead of
// the tab shell (App.tsx gates on `profile.onboarded`). It captures a display
// name only after a real device enrollment exists. Ordinary pairing completes
// directly. A zero-vault SSH ticket unlocks Create / Restore peer paths and no
// route to Home exists until the server ceremony completes.

type Step = 'connect' | 'choice' | 'create' | 'verify' | 'restore' | 'done';

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
  const [step, setStep] = useState<Step>('connect');
  const [name, setName] = useState(defaultDeviceName());
  const [session, setSession] = useState<MobileFoundingSession>();
  const [initialized, setInitialized] = useState<MobileInitializeResult>();
  const [foundingPassword, setFoundingPassword] = useState('');

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
        </View>

        <View style={styles.hero}>
          <OrbitArt />
        </View>

        {step === 'connect' ? (
          <ConnectionStep
            deviceName={name}
            onDeviceName={setName}
            onPaired={() => setStep('done')}
            onFounding={(next) => {
              setSession(next);
              setStep('choice');
            }}
            // Debug builds only: e2e + local simulators need a path onto the
            // springboard without a live pairing ticket (Settings → Advanced
            // still configures a tokenless loopback gateway). Release builds
            // keep the ceremony as the only route home. Guard the global so
            // Node/vitest (where Metro does not define `__DEV__`) does not
            // throw.
            onSkipDev={typeof __DEV__ !== 'undefined' && __DEV__ ? enter : undefined}
          />
        ) : step === 'choice' && session ? (
          <FoundingChoice
            onCreate={() => setStep('create')}
            onRestore={() => setStep('restore')}
            onBack={() => {
              setSession(undefined);
              setStep('connect');
            }}
          />
        ) : step === 'create' && session ? (
          <CreateVaultStep
            session={session}
            deviceName={name}
            onCreated={(result, password) => {
              setInitialized(result);
              setFoundingPassword(password);
              setStep('verify');
            }}
            onBack={() => setStep('choice')}
          />
        ) : step === 'verify' && session && initialized ? (
          <VerifyKitStep
            session={session}
            initialized={initialized}
            password={foundingPassword}
            onComplete={() => setStep('done')}
          />
        ) : step === 'restore' && session ? (
          <RestoreVaultStep
            session={session}
            deviceName={name}
            onComplete={() => setStep('done')}
            onBack={() => setStep('choice')}
          />
        ) : (
          <Done name={name} onEnter={enter} />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function FoundingChoice({
  onCreate,
  onRestore,
  onBack,
}: {
  onCreate: () => void;
  onRestore: () => void;
  onBack: () => void;
}): React.JSX.Element {
  return (
    <View>
      <Text style={styles.h1}>
        Found this <Text style={styles.h1Accent}>gateway</Text>.
      </Text>
      <Text style={styles.lede}>Starting fresh, or bringing a vault back from a backup?</Text>
      <ChoiceCard
        title="Create vault"
        sub="Found a brand-new local-only vault and save its wrapped recovery kit."
        onPress={onCreate}
      />
      <ChoiceCard
        title="Restore vault"
        sub="Restore backed-up vaults from a wrapped recovery kit."
        onPress={onRestore}
      />
      <Pressable onPress={onBack} style={styles.textBtn}>
        <Text style={styles.textBtnLabel}>Use another code</Text>
      </Pressable>
    </View>
  );
}

function ConnectionStep({
  deviceName,
  onDeviceName,
  onPaired,
  onFounding,
  onSkipDev,
}: {
  deviceName: string;
  onDeviceName: (value: string) => void;
  onPaired: () => void;
  onFounding: (session: MobileFoundingSession) => void;
  /** Present only when `__DEV__` — see call site. */
  onSkipDev?: () => void;
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
    const parsed = parsePairingInput(payload);
    const run = async (): Promise<void> => {
      try {
        if (parsed?.kind === 'centraid-gw-found') {
          onFounding(await prepareMobileFounding(payload));
        } else {
          await pair(payload, deviceName);
          onPaired();
        }
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
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
        Scan an ordinary pairing code, or the founding ticket printed by{' '}
        <Text style={styles.ledeStrong}>centraid-gateway init-ticket</Text> over SSH.
      </Text>
      {/* Above the fold on phone-sized screens: e2e taps this; burying it under
          the form fields made Maestro report COMPLETED while the press missed
          (run 30260560923). */}
      {onSkipDev ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Skip for now"
          disabled={pairing}
          onPress={onSkipDev}
          style={styles.textBtn}
        >
          <Text style={styles.textBtnLabel}>Skip for now</Text>
        </Pressable>
      ) : null}
      <Text style={styles.fieldLabel}>DEVICE NAME</Text>
      <TextInput
        value={deviceName}
        onChangeText={onDeviceName}
        style={styles.input}
        maxLength={60}
      />
      <Text style={[styles.fieldLabel, styles.fieldGap]}>PAIRING OR FOUNDING CODE</Text>
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
      {!available ? (
        <Text style={styles.note}>
          Pairing needs a development build — the tunnel isn't available in Expo Go. You can pair
          later from Settings.
        </Text>
      ) : null}

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

function CreateVaultStep({
  session,
  deviceName,
  onCreated,
  onBack,
}: {
  session: MobileFoundingSession;
  deviceName: string;
  onCreated: (result: MobileInitializeResult, password: string) => void;
  onBack: () => void;
}): React.JSX.Element {
  const [vaultName, setVaultName] = useState('Personal');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const create = async (): Promise<void> => {
    if (!password) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await initializeMobileVault(session, {
        name: vaultName.trim() || 'Personal',
        password,
        deviceName,
      });
      await shareRecoveryKit(result.kit);
      onCreated(result, password);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View>
      <Text style={styles.h1}>
        Create your <Text style={styles.h1Accent}>vault</Text>.
      </Text>
      <Text style={styles.lede}>
        Choose a password. The gateway will deliver a wrapped recovery kit through your system share
        sheet; keep it off this phone.
      </Text>
      <Text style={styles.fieldLabel}>VAULT NAME</Text>
      <TextInput value={vaultName} onChangeText={setVaultName} style={styles.input} />
      <Text style={[styles.fieldLabel, styles.fieldGap]}>RECOVERY-KIT PASSWORD</Text>
      <TextInput
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoCapitalize="none"
        style={styles.input}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <PrimaryButton
        label={busy ? 'Creating and sharing…' : 'Create and share wrapped kit'}
        onPress={() => void create()}
      />
      <Pressable disabled={busy} onPress={onBack} style={styles.textBtn}>
        <Text style={styles.textBtnLabel}>Back</Text>
      </Pressable>
    </View>
  );
}

function VerifyKitStep({
  session,
  initialized,
  password,
  onComplete,
}: {
  session: MobileFoundingSession;
  initialized: MobileInitializeResult;
  password: string;
  onComplete: () => void;
}): React.JSX.Element {
  const [kit, setKit] = useState<unknown>();
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const choose = async (): Promise<void> => {
    try {
      setKit(await pickRecoveryKit());
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const verify = async (): Promise<void> => {
    if (kit === undefined || !consent) return;
    setBusy(true);
    setError(undefined);
    try {
      await verifyMobileFoundingKit(session, { kit, password, lossConsent: true });
      await rememberInitializedVault(session, initialized);
      onComplete();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View>
      <Text style={styles.h1}>
        Verify the <Text style={styles.h1Accent}>saved kit</Text>.
      </Text>
      <Text style={styles.lede}>
        Re-select the exact file you just shared. The gateway checks its fingerprint and password
        before it lets you continue.
      </Text>
      <PrimaryButton
        label={kit === undefined ? 'Select saved recovery kit' : 'Recovery kit selected'}
        onPress={() => void choose()}
      />
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: consent }}
        onPress={() => setConsent((value) => !value)}
        style={styles.consent}
      >
        <View style={[styles.checkbox, consent && styles.checkboxChecked]}>
          <Text style={styles.checkboxMark}>{consent ? '✓' : ''}</Text>
        </View>
        <Text style={styles.consentText}>
          I understand that losing this file or password makes backed-up vaults unrecoverable.
        </Text>
      </Pressable>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <PrimaryButton
        label={busy ? 'Verifying…' : 'Verify and enter'}
        onPress={() => void verify()}
      />
    </View>
  );
}

function RestoreVaultStep({
  session,
  deviceName,
  onComplete,
  onBack,
}: {
  session: MobileFoundingSession;
  deviceName: string;
  onComplete: () => void;
  onBack: () => void;
}): React.JSX.Element {
  const [kit, setKit] = useState<unknown>();
  const [password, setPassword] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const restore = async (): Promise<void> => {
    if (kit === undefined || !password || !apiKey) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await restoreMobileVaults(session, {
        kit,
        password,
        apiKey,
        deviceName,
      });
      await rememberRestoredVaults(session, result);
      onComplete();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View>
      <Text style={styles.h1}>
        Restore your <Text style={styles.h1Accent}>vault</Text>.
      </Text>
      <Text style={styles.lede}>
        Select the wrapped kit and provide the password plus a storage-provider key. Provider
        credentials are not stored in the kit.
      </Text>
      <PrimaryButton
        label={kit === undefined ? 'Select recovery kit' : 'Recovery kit selected'}
        onPress={() =>
          void pickRecoveryKit()
            .then((selected) => setKit(selected))
            .catch((reason: unknown) =>
              setError(reason instanceof Error ? reason.message : String(reason)),
            )
        }
      />
      <Text style={[styles.fieldLabel, styles.fieldGap]}>RECOVERY-KIT PASSWORD</Text>
      <TextInput
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoCapitalize="none"
        style={styles.input}
      />
      <Text style={[styles.fieldLabel, styles.fieldGap]}>STORAGE-PROVIDER KEY</Text>
      <TextInput
        value={apiKey}
        onChangeText={setApiKey}
        secureTextEntry
        autoCapitalize="none"
        style={styles.input}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <PrimaryButton label={busy ? 'Restoring…' : 'Restore vault'} onPress={() => void restore()} />
      <Pressable disabled={busy} onPress={onBack} style={styles.textBtn}>
        <Text style={styles.textBtnLabel}>Back</Text>
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
  checkbox: {
    alignItems: 'center',
    borderColor: C.fieldLine,
    borderRadius: 5,
    borderWidth: 1,
    height: 22,
    justifyContent: 'center',
    width: 22,
  },
  checkboxChecked: { backgroundColor: C.brand, borderColor: C.brand },
  checkboxMark: { color: '#fff', fontFamily: family.sansBold, fontSize: 14 },
  consent: { alignItems: 'flex-start', flexDirection: 'row', gap: 11, marginTop: 22 },
  consentText: {
    color: C.ink2,
    flex: 1,
    fontFamily: family.sansRegular,
    fontSize: 13,
    lineHeight: 19,
  },
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
  textBtn: { alignItems: 'center', height: 48, justifyContent: 'center', marginTop: 10 },
  textBtnLabel: { color: C.ink3, fontFamily: family.sansMedium, fontSize: 15 },
  topRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  wordmark: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  wordmarkText: { color: C.ink3, fontFamily: family.monoMedium, fontSize: 11, letterSpacing: 2 },
});
