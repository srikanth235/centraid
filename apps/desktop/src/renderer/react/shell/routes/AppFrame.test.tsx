import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appLiveUrl = vi.fn();
vi.mock('../../../gateway-client.js', () => ({ appLiveUrl: (a: unknown) => appLiveUrl(a) }));

let AppFrame: typeof import('./AppFrame.js').default;
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(async () => {
  appLiveUrl.mockReset();
  ({ default: AppFrame } = await import('./AppFrame.js'));
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function render(): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<AppFrame appId="todos" accentColor="#123" theme="dark" bgL={5} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return host;
}

describe('AppFrame', () => {
  it('renders a sandboxed, tagged iframe and loads the resolved live URL with theme', async () => {
    appLiveUrl.mockResolvedValue({ url: 'https://gw.local/app/todos' });
    const el = await render();
    const frame = el.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toContain('allow-scripts');
    expect(frame.dataset.centraidApp).toBe('1');
    expect(appLiveUrl).toHaveBeenCalledWith({ id: 'todos' });
    expect(frame.getAttribute('src')).toBe(
      'https://gw.local/app/todos?theme=dark&bgL=5#theme=dark&bgL=5',
    );
  });

  it('appends the theme with & when the URL already has a query', async () => {
    appLiveUrl.mockResolvedValue({ url: 'https://gw.local/app/todos?v=2' });
    const el = await render();
    expect(el.querySelector('iframe')!.getAttribute('src')).toContain('?v=2&theme=dark');
  });

  it('shows an error message when the gateway is unreachable', async () => {
    appLiveUrl.mockRejectedValue(new Error('offline'));
    const el = await render();
    expect(el.querySelector('.viewFrame')?.textContent).toContain('Could not reach the gateway');
  });
});
