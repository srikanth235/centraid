/// <reference lib="dom" />
// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Onboarding from './Onboarding';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  notificationAsync: vi.fn(),
  onDone: vi.fn(),
  pair: vi.fn(),
  requestPermission: vi.fn(),
  setOnboarded: vi.fn(),
  setProfileColor: vi.fn(),
  setProfileName: vi.fn(),
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
      accessibilityState?: { checked?: boolean; selected?: boolean };
      children?: React.ReactNode;
      disabled?: boolean;
      onPress?: () => void;
      style?: unknown;
    }) =>
      element('button', {
        'aria-checked': accessibilityState?.checked,
        'aria-label': accessibilityLabel,
        'aria-selected': accessibilityState?.selected,
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
      onSubmitEditing: _onSubmitEditing,
      placeholderTextColor: _placeholderTextColor,
      returnKeyType: _returnKeyType,
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
          onClick: () => onBarcodeScanned({ data: 'ticket-from-camera' }),
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
    sansMedium: 'sans-medium',
    sansRegular: 'sans',
  },
}));

vi.mock('../lib/profile', () => ({
  BRAND_TEAL: '#22a78f',
  PROFILE_COLORS: ['#22a78f', '#4e68dd', '#e55772'],
  initialsOf: (name: string) => (name.trim() ? name.trim().slice(0, 1).toUpperCase() : '·'),
  setOnboarded: mocks.setOnboarded,
  setProfileColor: mocks.setProfileColor,
  setProfileName: mocks.setProfileName,
}));

vi.mock('../lib/phone-link', () => ({
  isTunnelAvailable: () => true,
  pair: mocks.pair,
}));

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.notificationAsync.mockResolvedValue(undefined);
  mocks.pair.mockResolvedValue(undefined);
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

function swatch(hex: string): HTMLButtonElement {
  const match = container!.querySelector<HTMLButtonElement>(`button[aria-label="Colour ${hex}"]`);
  if (!match) throw new Error(`swatch not found: ${hex}`);
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

/** Paste a pair ticket and land on the profile step. */
async function pairWithPastedTicket(deviceName?: string): Promise<void> {
  if (deviceName !== undefined) typeValue(container!.querySelector('input')!, deviceName);
  typeValue(container!.querySelector('textarea')!, 'pair-ticket');
  click(button('Continue with pasted code'));
  await flush();
  expect(container!.textContent).toContain("Who's using");
}

describe('mobile ticket-only onboarding', () => {
  it('pairs from a pasted ticket, then persists the profile from the unified step', async () => {
    await pairWithPastedTicket('Ada Phone');
    expect(mocks.pair).toHaveBeenCalledWith('pair-ticket', 'Ada Phone');

    // Name is required — an empty profile cannot be saved.
    click(button('Continue'));
    expect(mocks.setProfileName).not.toHaveBeenCalled();
    expect(container!.textContent).toContain('Enter a name');

    typeValue(container!.querySelector('input')!, '  Ada Lovelace  ');
    click(swatch('#e55772'));
    click(button('Continue'));

    expect(mocks.setProfileName).toHaveBeenCalledWith('Ada Lovelace');
    expect(mocks.setProfileColor).toHaveBeenCalledWith('#e55772');
    expect(mocks.setOnboarded).toHaveBeenCalledWith(true);
    expect(container!.textContent).toContain("You're all set, Ada");

    click(button('Enter Centraid'));
    expect(mocks.notificationAsync).toHaveBeenCalledWith('success');
    expect(mocks.onDone).toHaveBeenCalledOnce();
  });

  it('defaults the profile colour to the brand teal when no swatch is tapped', async () => {
    await pairWithPastedTicket();
    typeValue(container!.querySelector('input')!, 'Grace');
    click(button('Continue'));

    expect(mocks.pair).toHaveBeenCalledWith('pair-ticket', 'iPhone');
    expect(mocks.setProfileColor).toHaveBeenCalledWith('#22a78f');
    expect(mocks.setProfileName).toHaveBeenCalledWith('Grace');
  });

  it('scans a pair ticket through the camera path', async () => {
    click(button('Scan QR instead'));
    expect(container!.textContent).toContain('Point at the code');
    click(container!.querySelector('[data-testid="camera"]')!);
    await flush();

    expect(mocks.pair).toHaveBeenCalledWith('ticket-from-camera', 'iPhone');
    expect(container!.textContent).toContain("Who's using");
  });

  it('reports a pairing failure honestly and allows a retry', async () => {
    mocks.pair.mockRejectedValueOnce(new Error('gateway refused the ticket'));
    typeValue(container!.querySelector('textarea')!, 'pair-ticket');
    click(button('Continue with pasted code'));
    await flush();

    expect(container!.textContent).toContain('gateway refused the ticket');
    expect(container!.textContent).toContain('PAIRING CODE');
    expect(mocks.setOnboarded).not.toHaveBeenCalled();

    click(button('Continue with pasted code'));
    await flush();
    expect(container!.textContent).toContain("Who's using");
  });
});
