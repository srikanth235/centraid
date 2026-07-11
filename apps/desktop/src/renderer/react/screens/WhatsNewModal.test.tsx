import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CentraidChangelogResult } from '../../centraid-api.js';
import WhatsNewModal from './WhatsNewModal.js';

let root: Root | null = null;
let host: HTMLElement | null = null;

function mockChangelog(impl: () => Promise<CentraidChangelogResult>): void {
  (globalThis as unknown as { CentraidApi: unknown }).CentraidApi = { getChangelog: impl };
}

async function mount(onClose = (): void => {}): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<WhatsNewModal onClose={onClose} />);
  });
  // Let the mount-effect fetch resolve.
  await act(async () => {
    await Promise.resolve();
  });
}

const text = (): string => host?.textContent ?? '';

beforeEach(() => {
  (globalThis as unknown as { CentraidApi: unknown }).CentraidApi = {};
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

const result = (releases: CentraidChangelogResult['releases']): CentraidChangelogResult => ({
  currentVersion: '0.2.0',
  releases,
});

describe('WhatsNewModal', () => {
  it('renders releases with title, version chip, and markdown notes', async () => {
    mockChangelog(() =>
      Promise.resolve(
        result([
          {
            version: 'v0.2.0',
            title: 'Sharper sync',
            notes: '### Fixed\n- a real bug',
            publishedAt: '2026-07-09T10:00:00Z',
            url: 'https://github.com/x/y/releases/tag/v0.2.0',
            prerelease: false,
          },
        ]),
      ),
    );
    await mount();
    expect(text()).toContain('Sharper sync');
    expect(text()).toContain('v0.2.0');
    expect(text()).toContain('a real bug');
    // Section label + list came from the md-lite renderer.
    expect(host?.querySelector('h4')?.textContent).toBe('Fixed');
    expect(host?.querySelector('li')?.textContent).toBe('a real bug');
  });

  it('tags the release matching the running version as Installed', async () => {
    mockChangelog(() =>
      Promise.resolve(
        result([
          { version: 'v0.2.0', title: 'Now', notes: '', publishedAt: null, url: '', prerelease: false },
          { version: 'v0.1.0', title: 'Old', notes: '', publishedAt: null, url: '', prerelease: false },
        ]),
      ),
    );
    await mount();
    expect(text()).toContain('Installed');
    // Only the current one is tagged.
    expect(host?.querySelectorAll('*')).toBeTruthy();
    expect(text().match(/Installed/g)?.length).toBe(1);
  });

  it('shows an empty state when there are no releases', async () => {
    mockChangelog(() => Promise.resolve(result([])));
    await mount();
    expect(text()).toContain('No releases published yet');
  });

  it('shows an error state with the message when the fetch rejects', async () => {
    mockChangelog(() => Promise.reject(new Error('offline')));
    await mount();
    expect(text()).toContain('Couldn');
    expect(text()).toContain('offline');
  });

  it('closes on the close button and on Escape', async () => {
    const onClose = vi.fn();
    mockChangelog(() => Promise.resolve(result([])));
    await mount(onClose);
    const closeBtn = host?.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
    await act(async () => closeBtn.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
