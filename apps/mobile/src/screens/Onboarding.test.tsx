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

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const element = (
    tag: string,
    props: Record<string, unknown> & { children?: React.ReactNode } = {},
  ): React.JSX.Element => {
    const { children, style: _style, ...rest } = props;
    return ReactModule.createElement(tag, rest, children);
  };
  return {
    Platform: { OS: 'ios' },
    Pressable: ({
      accessibilityLabel,
      accessibilityRole,
      accessibilityState,
      children,
      disabled,
      onPress,
      style,
    }: {
      accessibilityLabel?: string;
      accessibilityRole?: string;
      accessibilityState?: { checked?: boolean };
      children?: React.ReactNode;
      disabled?: boolean;
      onPress?: () => void;
      style?: unknown;
    }) =>
      element('button', {
        'aria-checked': accessibilityState?.checked,
        'aria-label': accessibilityLabel,
        children,
        disabled,
        onClick: onPress,
        role: accessibilityRole,
        style: typeof style === 'function' ? undefined : style,
        type: 'button',
      }),
    ScrollView: ({ children }: { children?: React.ReactNode }) => element('main', { children }),
    StyleSheet: {
      absoluteFill: {},
      create: <T,>(styles: T): T => styles,
      hairlineWidth: 1,
    },
    Text: ({ children }: { children?: React.ReactNode }) => element('span', { children }),
    TextInput: ({
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
      }),
    View: ({ children }: { children?: React.ReactNode }) => element('div', { children }),
  };
});

vi.mock('react-native-safe-area-context', async () => {
  const ReactModule = await import('react');
  return {
    SafeAreaView: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement('section', null, children),
  };
});

vi.mock('react-native-svg', async () => {
  const ReactModule = await import('react');
  const component = (tag: string) => {
    const SvgMock = ({ children }: { children?: React.ReactNode }): React.JSX.Element =>
      ReactModule.createElement(tag, null, children);
    SvgMock.displayName = `SvgMock(${tag})`;
    return SvgMock;
  };
  return {
    default: component('svg'),
    Circle: component('circle'),
    Defs: component('defs'),
    Ellipse: component('ellipse'),
    G: component('g'),
    Path: component('path'),
    RadialGradient: component('radialGradient'),
    Rect: component('rect'),
    Stop: component('stop'),
  };
});

vi.mock('expo-camera', async () => {
  const ReactModule = await import('react');
  return {
    CameraView: ({ onBarcodeScanned }: { onBarcodeScanned: (event: { data: string }) => void }) =>
      ReactModule.createElement(
        'button',
        {
          'data-testid': 'camera',
          onClick: () => onBarcodeScanned({ data: 'ordinary-from-camera' }),
          type: 'button',
        },
        'camera',
      ),
    useCameraPermissions: () =>
      [{ canAskAgain: true, granted: true }, mocks.requestPermission] as const,
  };
});

vi.mock('expo-haptics', () => ({
  NotificationFeedbackType: { Success: 'success' },
  notificationAsync: mocks.notificationAsync,
}));

vi.mock('../kit/theme', () => ({
  family: {
    displayBold: 'display',
    monoMedium: 'mono-medium',
    monoRegular: 'mono',
    sansBold: 'sans-bold',
    sansRegular: 'sans',
  },
}));

vi.mock('../lib/profile', () => ({
  BRAND_TEAL: '#22a78f',
  setOnboarded: mocks.setOnboarded,
  setProfileColor: mocks.setProfileColor,
  setProfileName: mocks.setProfileName,
}));

vi.mock('../lib/phone-link', () => ({
  isTunnelAvailable: () => true,
  pair: mocks.pair,
  parsePairingInput: (payload: string) =>
    payload.startsWith('founding') ? { kind: 'centraid-gw-found' } : { kind: 'centraid-gw-pair' },
}));

vi.mock('../lib/recovery-kit-files', () => ({
  pickRecoveryKit: mocks.pickRecoveryKit,
  shareRecoveryKit: mocks.shareRecoveryKit,
}));

vi.mock('../lib/vault-founding', () => ({
  initializeMobileVault: mocks.initializeMobileVault,
  prepareMobileFounding: mocks.prepareMobileFounding,
  rememberInitializedVault: mocks.rememberInitializedVault,
  rememberRestoredVaults: mocks.rememberRestoredVaults,
  restoreMobileVaults: mocks.restoreMobileVaults,
  verifyMobileFoundingKit: mocks.verifyMobileFoundingKit,
}));

let root: Root | undefined;
let container: HTMLDivElement | undefined;

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
  it('exposes Skip for now only when __DEV__ is true', () => {
    const prev = (globalThis as { __DEV__?: boolean }).__DEV__;
    try {
      (globalThis as { __DEV__?: boolean }).__DEV__ = true;
      act(() => {
        root!.render(React.createElement(Onboarding, { onDone: mocks.onDone }));
      });
      const skip = Array.from(document.querySelectorAll('button')).find((node) =>
        (node.textContent ?? '').includes('Skip for now'),
      );
      expect(skip).toBeTruthy();
      click(skip!);
      expect(mocks.setOnboarded).toHaveBeenCalledWith(true);
      expect(mocks.onDone).toHaveBeenCalledOnce();

      mocks.setOnboarded.mockClear();
      mocks.onDone.mockClear();
      (globalThis as { __DEV__?: boolean }).__DEV__ = false;
      act(() => {
        root!.render(React.createElement(Onboarding, { onDone: mocks.onDone }));
      });
      expect(document.body.textContent).not.toContain('Skip for now');
    } finally {
      if (prev === undefined) delete (globalThis as { __DEV__?: boolean }).__DEV__;
      else (globalThis as { __DEV__?: boolean }).__DEV__ = prev;
    }
  });

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
    expect(mocks.rememberInitializedVault).toHaveBeenCalled();
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
    expect(mocks.rememberRestoredVaults).toHaveBeenCalled();
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
