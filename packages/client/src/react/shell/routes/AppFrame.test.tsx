import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appLiveUrl = vi.fn();
const tunnelFetch = vi.fn();
vi.mock('../../../gateway-client.js', () => ({ appLiveUrl: (a: unknown) => appLiveUrl(a) }));

let AppFrame: typeof import('./AppFrame.js').default;
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(async () => {
  appLiveUrl.mockReset();
  tunnelFetch.mockReset();
  localStorage.clear();
  const nonce = document.createElement('meta');
  nonce.name = 'centraid-csp-nonce';
  nonce.content = 'shell-test-nonce';
  document.head.append(nonce);
  tunnelFetch.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/_web/session')) {
      return {
        ok: true,
        status: 200,
        url: `${window.location.origin}/__centraid_iroh__/d-device/centraid/todos/`,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () =>
          '<!doctype html><html><head><script type="module" src="_bundle.js"></script></head><body>todos</body></html>',
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      url,
      headers: new Headers({ 'content-type': 'text/javascript' }),
      text: async () => 'window.__appBooted=true;',
    } as Response;
  });
  vi.stubGlobal('fetch', tunnelFetch);
  (window as unknown as { CentraidApi: unknown }).CentraidApi = {
    getGatewayAuth: async () => ({
      baseUrl: window.location.origin,
      gatewayId: 'gateway-a',
      vaultId: 'vault-a',
      rememberDevice: true,
    }),
  };
  ({ default: AppFrame } = await import('./AppFrame.js'));
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.querySelectorAll('meta[name="centraid-csp-nonce"]').forEach((meta) => meta.remove());
  vi.unstubAllGlobals();
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
  it('uses the natural cross-origin boundary and loads the resolved live URL with theme', async () => {
    appLiveUrl.mockResolvedValue({ url: 'https://gw.local/app/todos' });
    const el = await render();
    const frame = el.querySelector('iframe')!;
    // A gateway origin distinct from the shell is already a separate browser
    // principal, so nested native viewers do not inherit sandbox flags.
    expect(frame.hasAttribute('sandbox')).toBe(false);
    expect(frame.dataset.centraidApp).toBe('1');
    expect(appLiveUrl).toHaveBeenCalledWith({ id: 'todos' });
    expect(frame.getAttribute('src')).toMatch(
      /^https:\/\/gw\.local\/app\/todos\?theme=dark&bgL=5#theme=dark&bgL=5&bridge=.+$/,
    );
  });

  it('appends the theme with & when the URL already has a query', async () => {
    appLiveUrl.mockResolvedValue({ url: 'https://gw.local/app/todos?v=2' });
    const el = await render();
    expect(el.querySelector('iframe')!.getAttribute('src')).toContain('?v=2&theme=dark');
  });

  it('reopens a remembered tunneled app from its cached launch URL while offline', async () => {
    const launch = `${window.location.origin}/__centraid_iroh__/d-device/centraid/_web/session?code=one`;
    appLiveUrl.mockResolvedValueOnce({ url: launch });
    let el = await render();
    await vi.waitFor(() => expect(el.querySelector('iframe')?.src).toMatch(/^data:text\/html/));
    expect(el.querySelector('iframe')!.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(el.querySelector('iframe')!.getAttribute('sandbox')).toContain('allow-scripts');

    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    appLiveUrl.mockRejectedValueOnce(new Error('offline'));

    el = await render();
    await vi.waitFor(() => expect(el.querySelector('iframe')?.src).toMatch(/^data:text\/html/));
    expect(el.querySelector('.viewFrame')?.textContent).not.toContain('Could not reach');
    expect(appLiveUrl).toHaveBeenCalledTimes(2);
    expect(tunnelFetch).toHaveBeenCalledWith(
      expect.stringContaining('/_web/session?code=one&theme=dark&bgL=5'),
      expect.objectContaining({ redirect: 'follow' }),
    );
  });

  it('does not persist or replay an app URL without remember-device consent', async () => {
    (window as unknown as { CentraidApi: unknown }).CentraidApi = {
      getGatewayAuth: async () => ({
        baseUrl: window.location.origin,
        gatewayId: 'gateway-a',
        vaultId: 'vault-a',
        rememberDevice: false,
      }),
    };
    localStorage.setItem(
      'centraid.client.v1.app-frame-urls',
      JSON.stringify({
        scope: 'gateway-a\u0000vault-a',
        urls: {
          todos: `${window.location.origin}/__centraid_iroh__/d-old/centraid/app/todos`,
        },
      }),
    );
    appLiveUrl.mockRejectedValue(new Error('offline'));
    const el = await render();
    expect(el.querySelector('.viewFrame')?.textContent).toContain('Could not reach the gateway');
    expect(localStorage.getItem('centraid.client.v1.app-frame-urls')).toBeNull();
  });

  it('shows an error message when the gateway is unreachable', async () => {
    appLiveUrl.mockRejectedValue(new Error('offline'));
    const el = await render();
    expect(el.querySelector('.viewFrame')?.textContent).toContain('Could not reach the gateway');
  });
});
