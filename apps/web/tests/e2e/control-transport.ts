import type { Page } from "@playwright/test";

export async function installHarnessControlTransport(
  page: Page,
  apiUrl: string
): Promise<void> {
  await page.addInitScript(
    ({ gatewayUrl }) => {
      const onlineKey = "centraid.e2e.gateway.online";
      const gateway = {
        get online(): boolean {
          return localStorage.getItem(onlineKey) !== "false";
        },
        set online(next: boolean) {
          localStorage.setItem(onlineKey, String(next));
        },
      };
      const transport = {
        fetch: async (pathname: string, init: RequestInit = {}) => {
          if (!gateway.online)
            throw new TypeError("Harness gateway is unreachable");
          return fetch(
            `${gatewayUrl}/centraid/_web/control?path=${encodeURIComponent(pathname)}`,
            {
              ...init,
              credentials: "include",
            }
          );
        },
        url: async (pathname: string) =>
          new URL(pathname, `${gatewayUrl}/`).toString(),
      };

      Object.defineProperty(window, "CentraidIroh", {
        configurable: true,
        get: () => transport,
        set: () => undefined,
      });
      Object.defineProperty(window, "__centraidE2eGateway", {
        configurable: true,
        value: gateway,
      });
    },
    { gatewayUrl: apiUrl }
  );
}

export async function setHarnessControlOnline(
  page: Page,
  online: boolean
): Promise<void> {
  await page.evaluate((next) => {
    const gateway = (
      window as unknown as {
        __centraidE2eGateway: { online: boolean };
      }
    ).__centraidE2eGateway;
    gateway.online = next;
  }, online);
}
