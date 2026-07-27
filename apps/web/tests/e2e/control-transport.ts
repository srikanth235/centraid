import type { Page } from '@playwright/test';

/**
 * The web E2E harness owns a loopback gateway but does not start an iroh relay.
 * Keep the product connection shape honest (EndpointId + endpoint ticket) and
 * adapt only the transport boundary to the harness's cookie-authenticated
 * control proxy. The init script intercepts main.ts's transport installation,
 * so the adapter survives the reload that applies the persisted connection.
 */
export async function installHarnessControlTransport(page: Page, apiUrl: string): Promise<void> {
  await page.addInitScript(
    ({ gatewayUrl }) => {
      const transport = {
        fetch: async (pathname: string, init: RequestInit = {}) =>
          fetch(`${gatewayUrl}/centraid/_web/control?path=${encodeURIComponent(pathname)}`, {
            ...init,
            credentials: 'include',
          }),
        url: async (pathname: string) => new URL(pathname, `${gatewayUrl}/`).toString(),
      };

      Object.defineProperty(window, 'CentraidIroh', {
        configurable: true,
        get: () => transport,
        // main.ts installs the production WASM transport on every navigation.
        // The harness adapter deliberately owns this one page instead.
        set: () => undefined,
      });
    },
    { gatewayUrl: apiUrl },
  );
}
