import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import FoundingScreen, { type FoundingScreenProps } from './FoundingScreen.js';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

describe('screens/FoundingScreen', () => {
  beforeEach(() => {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn<typeof URL.createObjectURL>().mockReturnValue('blob:kit'),
      revokeObjectURL: vi.fn<typeof URL.revokeObjectURL>(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockReturnValue(undefined);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function props(over: Partial<FoundingScreenProps> = {}): FoundingScreenProps {
    return {
      mode: 'create',
      initialize: vi.fn<FoundingScreenProps['initialize']>().mockResolvedValue({
        vault: { vaultId: 'vault-1', name: 'Personal' },
        kit: { format: 'centraid-recovery-kit/2', wrapped: 'ciphertext' },
        fingerprint: 'fp',
        recoveryScope: 'future-backed-vaults',
      }),
      verify: vi
        .fn<FoundingScreenProps['verify']>()
        .mockResolvedValue({ ok: true, vaultId: 'vault-1', fingerprint: 'fp' }),
      restore: vi.fn<FoundingScreenProps['restore']>().mockResolvedValue({
        ok: true,
        report: { vaultId: 'vault-1' },
        reports: [],
      }),
      onComplete: vi.fn<FoundingScreenProps['onComplete']>(),
      onBack: vi.fn<FoundingScreenProps['onBack']>(),
      ...over,
    };
  }

  async function mount(input: FoundingScreenProps): Promise<HTMLDivElement> {
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      root.render(<FoundingScreen {...input} />);
    });
    return container;
  }

  function inputFor(labelText: string): HTMLInputElement | HTMLTextAreaElement {
    const label = [...(container?.querySelectorAll('label') ?? [])].find((candidate) =>
      candidate.textContent?.includes(labelText),
    );
    const input = label?.querySelector('input,textarea');
    if (!(input instanceof HTMLInputElement) && !(input instanceof HTMLTextAreaElement)) {
      throw new Error(`Missing input for ${labelText}`);
    }
    return input;
  }

  function setValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function click(text: string): void {
    const button = [...(container?.querySelectorAll('button') ?? [])].find((candidate) =>
      candidate.textContent?.includes(text),
    );
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }

  describe('FoundingScreen ceremony', () => {
    it('cannot complete create until the downloaded kit is reselected and loss is acknowledged', async () => {
      const bridge = props();
      const el = await mount(bridge);
      const timeout = vi.spyOn(globalThis, 'setTimeout');
      await act(async () => {
        setValue(inputFor('Recovery-kit password'), 'correct horse');
        click('Create vault and download kit');
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(bridge.initialize).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Personal', password: 'correct horse' }),
      );
      expect(timeout).toHaveBeenCalledWith(expect.any(Function), 1_000);
      expect(el.textContent).toContain('Re-select that exact file');
      const verifyButton = [...el.querySelectorAll('button')].find((candidate) =>
        candidate.textContent?.includes('Verify and enter'),
      ) as HTMLButtonElement;
      expect(verifyButton.disabled).toBe(true);
      expect(bridge.onComplete).not.toHaveBeenCalled();

      const fileInput = el.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(
        [
          JSON.stringify({
            format: 'centraid-recovery-kit/2',
            wrapped: 'ciphertext',
          }),
        ],
        'centraid-recovery-kit.json',
        { type: 'application/json' },
      );
      Object.defineProperty(file, 'text', {
        value: async () =>
          JSON.stringify({
            format: 'centraid-recovery-kit/2',
            wrapped: 'ciphertext',
          }),
      });
      await act(async () => {
        Object.defineProperty(fileInput, 'files', {
          configurable: true,
          value: [file],
        });
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(verifyButton.disabled).toBe(true);

      const consent = el.querySelector('input[type="checkbox"]') as HTMLInputElement;
      await act(async () => {
        consent.click();
        click('Verify and enter');
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(bridge.verify).toHaveBeenCalledWith({
        kit: { format: 'centraid-recovery-kit/2', wrapped: 'ciphertext' },
        password: 'correct horse',
        lossConsent: true,
      });
      expect(bridge.onComplete).toHaveBeenCalledOnce();
    });

    it('uses the same founding peer for restore with a scanned ticket', async () => {
      const bridge = props({ mode: 'restore' });
      const el = await mount(bridge);
      const fileInput = el.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File([JSON.stringify({ wrapped: 'ciphertext' })], 'kit.json');
      Object.defineProperty(file, 'text', {
        value: async () => JSON.stringify({ wrapped: 'ciphertext' }),
      });
      await act(async () => {
        Object.defineProperty(fileInput, 'files', {
          configurable: true,
          value: [file],
        });
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        setValue(inputFor('Recovery-kit password'), 'correct horse');
        setValue(inputFor('Storage-provider key'), 'provider-key');
        setValue(inputFor('Founding ticket'), 'scanned-ticket');
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        click('Restore vault');
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(bridge.restore).toHaveBeenCalledWith({
        kit: { wrapped: 'ciphertext' },
        password: 'correct horse',
        apiKey: 'provider-key',
        ticket: 'scanned-ticket',
        deviceName: 'Centraid device',
        platform: 'desktop',
      });
      expect(bridge.onComplete).toHaveBeenCalledOnce();
    });
  });
});
