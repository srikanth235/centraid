/// <reference lib="dom" />
// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Onboarding from './Onboarding';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  initializeMobileVault: vi.fn(),
  notificationAsync: vi.fn(),
  onDone: vi.fn(),
  pair: vi.fn(),
  pickRecoveryKit: vi.fn(),
  prepareMobileFounding: vi.fn(),
  rememberInitializedVault: vi.fn(),
  rememberRestoredVaults: vi.fn(),
  requestPermission: vi.fn(),
  restoreMobileVaults: vi.fn(),
  setOnboarded: vi.fn(),
  setProfileColor: vi.fn(),
  setProfileName: vi.fn(),
  shareRecoveryKit: vi.fn(),
  verifyMobileFoundingKit: vi.fn(),
}));

vi.mock(import('react-native'), async () => {
  const ReactModule = await import('react');
  const element = (
    tag: string,
    props: Record<string, unknown> & { children?: React.ReactNode } = {},
  ): React.JSX.Element => {
    const { children, style: _style, ...rest } = props;
    return ReactModule.createElement(tag, rest, children);
  };
  return {
    // react-native's real `Platform`/`Pressable`/etc. types (per-platform
    // statics, `ForwardRefExoticComponent`s with native-view members) are
    // impractical to replicate in a DOM stand-in — this whole mock renders
    // plain DOM elements instead, so each export below is asserted to its
    // real type rather than the module being widened.
    Platform: { OS: 'ios' } as unknown as typeof import('react-native').Platform,
    Pressable: (({
      accessibilityRole,
      accessibilityState,
      children,
      disabled,
      onPress,
      style,
    }: {
      accessibilityRole?: string;
      accessibilityState?: { checked?: boolean };
      children?: React.ReactNode;
      disabled?: boolean;
      onPress?: () => void;
      style?: unknown;
    }) =>
      element('button', {
        'aria-checked': accessibilityState?.checked,
        children,
        disabled,
        onClick: onPress,
        role: accessibilityRole,
        style: typeof style === 'function' ? undefined : style,
        type: 'button',
      })) as unknown as typeof import('react-native').Pressable,
    ScrollView: (({ children }: { children?: React.ReactNode }) =>
      element('main', { children })) as unknown as typeof import('react-native').ScrollView,
    StyleSheet: {
      absoluteFill: {},
      create: <T,>(styles: T): T => styles,
      hairlineWidth: 1,
    } as unknown as typeof import('react-native').StyleSheet,
    Text: (({ children }: { children?: React.ReactNode }) =>
      element('span', { children })) as unknown as typeof import('react-native').Text,
    TextInput: (({
      autoCapitalize: _autoCapitalize,
      autoCorrect: _autoCorrect,
      multiline,
      onChangeText,
      placeholderTextColor: _placeholderTextColor,
      secureTextEntry,
      textAlignVertical: _textAlignVertical,
      ...props
    }: {
      multiline?: boolean;
      onChangeText?: (value: string) => void;
      secureTextEntry?: boolean;
      [key: string]: unknown;
    }) =>
      element(multiline ? 'textarea' : 'input', {
        ...props,
        onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
          onChangeText?.((event.target as HTMLInputElement | HTMLTextAreaElement).value),
        type: !multiline && secureTextEntry ? 'password' : undefined,
      })) as unknown as typeof import('react-native').TextInput,
    View: (({ children }: { children?: React.ReactNode }) =>
      element('div', { children })) as unknown as typeof import('react-native').View,
  };
});

vi.mock(import('react-native-safe-area-context'), async () => {
  const ReactModule = await import('react');
  return {
    // Real `SafeAreaView` is a `ForwardRefExoticComponent`; this DOM stand-in
    // is a plain function component, so it's asserted to the real type.
    SafeAreaView: (({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement(
        'section',
        null,
        children,
      )) as unknown as typeof import('react-native-safe-area-context').SafeAreaView,
  };
});

vi.mock(import('react-native-svg'), async () => {
  const ReactModule = await import('react');
  const component = (tag: string) => {
    const SvgMock = ({ children }: { children?: React.ReactNode }): React.JSX.Element =>
      ReactModule.createElement(tag, null, children);
    SvgMock.displayName = `SvgMock(${tag})`;
    return SvgMock;
  };
  return {
    // react-native-svg's real components are class components with static
    // members (e.g. `defaultProps`) this DOM stand-in doesn't implement, so
    // every element mock below is asserted to its real type.
    default: component('svg') as unknown as typeof import('react-native-svg').default,
    Circle: component('circle') as unknown as typeof import('react-native-svg').Circle,
    Defs: component('defs') as unknown as typeof import('react-native-svg').Defs,
    Ellipse: component('ellipse') as unknown as typeof import('react-native-svg').Ellipse,
    G: component('g') as unknown as typeof import('react-native-svg').G,
    Path: component('path') as unknown as typeof import('react-native-svg').Path,
    RadialGradient: component(
      'radialGradient',
    ) as unknown as typeof import('react-native-svg').RadialGradient,
    Rect: component('rect') as unknown as typeof import('react-native-svg').Rect,
    Stop: component('stop') as unknown as typeof import('react-native-svg').Stop,
  };
});

vi.mock(import('expo-camera'), async () => {
  const ReactModule = await import('react');
  return {
    // Real `CameraView` is a native-backed `ForwardRefExoticComponent`; this
    // DOM stand-in only fires `onBarcodeScanned` on click.
    CameraView: (({ onBarcodeScanned }: { onBarcodeScanned: (event: { data: string }) => void }) =>
      ReactModule.createElement(
        'button',
        {
          'data-testid': 'camera',
          onClick: () => onBarcodeScanned({ data: 'ordinary-from-camera' }),
          type: 'button',
        },
        'camera',
      )) as unknown as typeof import('expo-camera').CameraView,
    // Onboarding.tsx only destructures `[permission, requestPermission]` and
    // reads `permission.granted`/`.canAskAgain` — the real hook returns a
    // 3-tuple with a full `PermissionResponse` (status, expires, …) in slot
    // 0, none of which this test needs, so the return is asserted rather
    // than fabricating unused fields/slots.
    useCameraPermissions: (): ReturnType<typeof import('expo-camera').useCameraPermissions> =>
      [{ canAskAgain: true, granted: true }, mocks.requestPermission] as unknown as ReturnType<
        typeof import('expo-camera').useCameraPermissions
      >,
  };
});

vi.mock(import('expo-haptics'), () => ({
  // Real string-enum members are a distinct literal type per member — a
  // plain string like `'success'` is never assignable to an enum-typed
  // property without going through the actual enum.
  NotificationFeedbackType: {
    Success: 'success',
  } as unknown as typeof import('expo-haptics').NotificationFeedbackType,
  notificationAsync: mocks.notificationAsync,
}));

vi.mock(import('../kit/theme'), () => ({
  // The real export's values are string-literal-typed consts, and this
  // object needs every member (Partial is shallow) — restated verbatim
  // (not behavior, just font-family name constants) with `as const` so the
  // literal types match instead of widening to `string`.
  family: {
    displayBold: 'SpaceGrotesk_600SemiBold',
    displayMedium: 'SpaceGrotesk_500Medium',
    monoBold: 'JetBrainsMono_600SemiBold',
    monoMedium: 'JetBrainsMono_500Medium',
    monoRegular: 'JetBrainsMono_400Regular',
    sansBold: 'Geist_600SemiBold',
    sansMedium: 'Geist_500Medium',
    sansRegular: 'Geist_400Regular',
    serif: 'PlayfairDisplay_600SemiBold',
    serifItalic: 'PlayfairDisplay_600SemiBold_Italic',
  } as const,
}));

vi.mock(import('../lib/profile'), () => ({
  // Deliberately a different literal than the real `'#128A78'` const (see
  // the `toHaveBeenCalledWith('#22a78f')` assertion below) — this test
  // checks the value flows through unmodified, not the real brand color —
  // so it's asserted to the real (disjoint-literal) type rather than
  // changed to match production or the assertion weakened.
  BRAND_TEAL: '#22a78f' as unknown as typeof import('../lib/profile').BRAND_TEAL,
  setOnboarded: mocks.setOnboarded,
  setProfileColor: mocks.setProfileColor,
  setProfileName: mocks.setProfileName,
}));

vi.mock(import('../lib/phone-link'), () => ({
  isTunnelAvailable: () => true,
  pair: mocks.pair,
  // The real `PairingInput` discriminated-union members carry required
  // fields (`gw`/`t`/`s`/`exp`, …) this test doesn't need — only the `kind`
  // discriminant drives the behavior under test — so the return type is
  // asserted rather than fabricating unused payload fields.
  parsePairingInput: (payload: string) =>
    (payload.startsWith('founding')
      ? { kind: 'centraid-gw-found' }
      : { kind: 'centraid-gw-pair' }) as ReturnType<
      typeof import('../lib/phone-link').parsePairingInput
    >,
}));

vi.mock(import('../lib/recovery-kit-files'), () => ({
  pickRecoveryKit: mocks.pickRecoveryKit,
  shareRecoveryKit: mocks.shareRecoveryKit,
}));

vi.mock(import('../lib/vault-founding'), () => ({
  initializeMobileVault: mocks.initializeMobileVault,
  prepareMobileFounding: mocks.prepareMobileFounding,
  rememberInitializedVault: mocks.rememberInitializedVault,
  rememberRestoredVaults: mocks.rememberRestoredVaults,
  restoreMobileVaults: mocks.restoreMobileVaults,
  verifyMobileFoundingKit: mocks.verifyMobileFoundingKit,
}));

let root: Root | undefined;
let container: HTMLDivElement | undefined;

describe('screens/Onboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.initializeMobileVault.mockResolvedValue({
      fingerprint: 'fingerprint',
      kit: { wrapped: true },
      vault: { name: 'Family', vaultId: 'vault-1' },
    });
    mocks.notificationAsync.mockResolvedValue(undefined);
    mocks.pair.mockResolvedValue(undefined);
    mocks.pickRecoveryKit.mockResolvedValue({ wrapped: true });
    mocks.prepareMobileFounding.mockResolvedValue({
      endpointId: 'gateway-1',
      endpointTicket: 'endpoint-ticket',
      foundingTicket: 'founding-ticket',
    });
    mocks.rememberInitializedVault.mockResolvedValue(undefined);
    mocks.rememberRestoredVaults.mockResolvedValue(undefined);
    mocks.restoreMobileVaults.mockResolvedValue({
      enrollments: [],
      reports: [{ vaultId: 'restored-1' }],
    });
    mocks.shareRecoveryKit.mockResolvedValue(undefined);
    mocks.verifyMobileFoundingKit.mockResolvedValue(undefined);
    container = document.createElement('div');
    document.body.appendChild(container);
    const handleDone = mocks.onDone;
    act(() => {
      root = createRoot(container!);
      root.render(<Onboarding onDone={handleDone} />);
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  function button(label: string): HTMLButtonElement {
    const match = Array.from(container!.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes(label),
    );
    if (!match) throw new Error(`button not found: ${label}`);
    return match;
  }

  function click(target: Element): void {
    void act(() => target.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  }

  function typeValue(target: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const prototype =
      target instanceof HTMLTextAreaElement
        ? globalThis.HTMLTextAreaElement.prototype
        : globalThis.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    act(() => {
      setter?.call(target, value);
      target.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function flush(times = 4): Promise<void> {
    for (let i = 0; i < times; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  async function openFoundingChoice(): Promise<void> {
    typeValue(container!.querySelector('textarea')!, 'founding-ticket');
    click(button('Continue with pasted code'));
    await flush();
    expect(container!.textContent).toContain('Starting fresh');
  }

  describe('mobile founding onboarding', () => {
    it('completes ordinary pasted pairing and persists the first-device profile', async () => {
      typeValue(container!.querySelector('input')!, 'Ada Phone');
      typeValue(container!.querySelector('textarea')!, 'ordinary-ticket');
      click(button('Continue with pasted code'));
      await flush();

      expect(mocks.pair).toHaveBeenCalledWith('ordinary-ticket', 'Ada Phone');
      expect(container!.textContent).toContain("You're all set");
      click(button('Enter Centraid'));

      expect(mocks.setProfileName).toHaveBeenCalledWith('Ada Phone');
      expect(mocks.setProfileColor).toHaveBeenCalledWith('#22a78f');
      expect(mocks.setOnboarded).toHaveBeenCalledWith(true);
      expect(mocks.notificationAsync).toHaveBeenCalledWith('success');
      expect(mocks.onDone).toHaveBeenCalledOnce();
    });

    it('scans an ordinary ticket through the camera path', async () => {
      click(button('Scan QR instead'));
      expect(container!.textContent).toContain('Point at the code');
      click(container!.querySelector('[data-testid="camera"]')!);
      await flush();

      expect(mocks.pair).toHaveBeenCalledWith('ordinary-from-camera', 'iPhone');
      expect(container!.textContent).toContain("You're all set");
    });

    it('creates a vault, shares and reselects its kit, verifies it, and enters', async () => {
      await openFoundingChoice();
      click(button('Create vault'));
      expect(container!.textContent).toContain('Choose a password');

      click(button('Create and share wrapped kit'));
      expect(mocks.initializeMobileVault).not.toHaveBeenCalled();

      const inputs = Array.from(container!.querySelectorAll('input'));
      typeValue(inputs[0]!, 'Family');
      typeValue(inputs[1]!, 'correct horse battery staple');
      click(button('Create and share wrapped kit'));
      await flush();

      expect(mocks.initializeMobileVault).toHaveBeenCalledWith(
        expect.objectContaining({ foundingTicket: 'founding-ticket' }),
        {
          deviceName: 'iPhone',
          name: 'Family',
          password: 'correct horse battery staple',
        },
      );
      expect(mocks.shareRecoveryKit).toHaveBeenCalledWith({ wrapped: true });
      expect(container!.textContent).toContain('Re-select the exact file');

      click(button('Select saved recovery kit'));
      await flush();
      click(container!.querySelector('[role="checkbox"]')!);
      click(button('Verify and enter'));
      await flush();

      expect(mocks.verifyMobileFoundingKit).toHaveBeenCalledWith(
        expect.objectContaining({ foundingTicket: 'founding-ticket' }),
        {
          kit: { wrapped: true },
          lossConsent: true,
          password: 'correct horse battery staple',
        },
      );
      expect(mocks.rememberInitializedVault).toHaveBeenCalledWith(
        {
          endpointId: 'gateway-1',
          endpointTicket: 'endpoint-ticket',
          foundingTicket: 'founding-ticket',
        },
        {
          fingerprint: 'fingerprint',
          kit: { wrapped: true },
          vault: { name: 'Family', vaultId: 'vault-1' },
        },
      );
      expect(container!.textContent).toContain("You're all set");
    });

    it('surfaces a restore failure, retries, and remembers every restored vault', async () => {
      mocks.restoreMobileVaults
        .mockRejectedValueOnce(new Error('provider unavailable'))
        .mockResolvedValueOnce({ enrollments: [], reports: [{ vaultId: 'restored-1' }] });
      await openFoundingChoice();
      click(button('Restore vault'));
      expect(container!.textContent).toContain('storage-provider key');

      click(button('Select recovery kit'));
      await flush();
      const inputs = Array.from(container!.querySelectorAll('input'));
      typeValue(inputs[0]!, 'kit password');
      typeValue(inputs[1]!, 'provider key');
      click(button('Restore vault'));
      await flush();
      expect(container!.textContent).toContain('provider unavailable');

      click(button('Restore vault'));
      await flush();
      expect(mocks.restoreMobileVaults).toHaveBeenLastCalledWith(
        expect.objectContaining({ foundingTicket: 'founding-ticket' }),
        {
          apiKey: 'provider key',
          deviceName: 'iPhone',
          kit: { wrapped: true },
          password: 'kit password',
        },
      );
      expect(mocks.rememberRestoredVaults).toHaveBeenCalledWith(
        {
          endpointId: 'gateway-1',
          endpointTicket: 'endpoint-ticket',
          foundingTicket: 'founding-ticket',
        },
        {
          enrollments: [],
          reports: [{ vaultId: 'restored-1' }],
        },
      );
      expect(container!.textContent).toContain("You're all set");
    });

    it('can abandon a founding ticket and reports pairing errors for retry', async () => {
      await openFoundingChoice();
      click(button('Use another code'));
      expect(container!.textContent).toContain('PAIRING OR FOUNDING CODE');

      mocks.pair.mockRejectedValueOnce('pairing failed');
      typeValue(container!.querySelector('textarea')!, 'ordinary-ticket');
      click(button('Continue with pasted code'));
      await flush();
      expect(container!.textContent).toContain('pairing failed');

      click(button('Continue with pasted code'));
      await flush();
      expect(container!.textContent).toContain("You're all set");
    });
  });
});
