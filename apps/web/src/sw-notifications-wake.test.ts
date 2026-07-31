import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, test, vi } from "vitest";

describe("closed PWA Notifications wake", () => {
  test("pulls canonical rows over worker-owned Iroh and deduplicates delivery", async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const shown: Array<{ title: string; options: NotificationOptions }> = [];
    const stored = new Map<string, Response>();
    const cache = {
      add: async () => undefined,
      addAll: async () => undefined,
      match: async (key: string) => stored.get(key)?.clone(),
      put: async (key: string, response: Response) => {
        stored.set(key, response.clone());
      },
    };
    const caches = {
      delete: async () => true,
      keys: async () => [],
      open: async () => cache,
    };
    type WakeResponse = {
      status: number;
      take_body: () => ReadableStream<Uint8Array>;
    };
    type WakeRequest = (
      ticket: string,
      method: string,
      target: string,
      headersJson: string
    ) => Promise<WakeResponse>;
    const request = vi.fn<WakeRequest>(
      async (
        ticket: string,
        method: string,
        target: string,
        headersJson: string
      ) => {
        expect(ticket).toBe("ticket-1");
        expect(method).toBe("GET");
        expect(JSON.parse(headersJson)).toMatchObject({
          origin: "https://centraid.example",
          "x-centraid-vault": "vault-1",
        });
        const body =
          target === "/centraid/_vault/notifications"
            ? {
                decisions: {
                  outbox: [
                    {
                      itemId: "item-1",
                      target: "ravi@example.com",
                      artifact: { subject: "Dinner plans" },
                      stagedAt: "2026-07-30T10:00:00.000Z",
                    },
                  ],
                  needsAuth: [],
                  parked: [],
                  scopeRequests: [],
                },
                notices: [],
              }
            : target === "/centraid/_reminders/due"
              ? { reminders: [] }
              : undefined;
        if (!body) throw new Error(`unexpected Iroh target ${target}`);
        return {
          status: 200,
          take_body: () => Response.json(body).body!,
        };
      }
    );
    const fetch = vi.fn<() => Promise<Response>>(async () => {
      throw new Error("static web origin cannot reach the sovereign gateway");
    });
    const close = vi.fn<() => void>(() => undefined);
    const self = {
      location: { origin: "https://centraid.example" },
      registration: {
        navigationPreload: undefined,
        showNotification: vi.fn<
          (title: string, options: NotificationOptions) => Promise<void>
        >(async (title: string, options: NotificationOptions) => {
          shown.push({ title, options });
        }),
      },
      clients: {
        claim: async () => undefined,
        get: () => undefined,
        matchAll: async () => [],
        openWindow: () => undefined,
      },
      addEventListener: (
        name: string,
        listener: (event: unknown) => void
      ): void => {
        listeners.set(name, listener);
      },
      skipWaiting: () => undefined,
      CentraidIrohWorkerBindings: undefined as
        | {
            BrowserEndpoint: {
              spawn: (
                key: Uint8Array
              ) => Promise<{ request: typeof request; close: () => void }>;
            };
            initWasm: () => Promise<void>;
          }
        | undefined,
    };
    const importScripts = vi.fn<(url: string) => void>(() => {
      self.CentraidIrohWorkerBindings = {
        BrowserEndpoint: {
          spawn: async (key: Uint8Array) => {
            expect([...key]).toStrictEqual([1, 2, 3]);
            return { request, close };
          },
        },
        initWasm: async () => undefined,
      };
    });
    const swPath = path.join(import.meta.dirname, "../public/sw.js");
    const source = readFileSync(swPath, "utf8");
    vm.runInNewContext(
      source,
      {
        self,
        caches,
        fetch,
        importScripts,
        atob,
        Response,
        Uint8Array,
        URL,
        Set,
        Map,
        Promise,
        JSON,
        encodeURIComponent,
        decodeURIComponent,
        setTimeout,
        clearTimeout,
      },
      // Naming the script makes v8 attribute this run to public/sw.js, so the
      // wake path counts toward the service worker's coverage (issue #656 1F).
      { filename: swPath }
    );

    const configure = listeners.get("message");
    expect(configure).toBeDefined();
    let configured: Promise<unknown> | undefined;
    configure?.({
      data: {
        type: "centraid:configure-iroh-wake",
        configuration: {
          deviceKey: "AQID",
          endpointTicket: "ticket-1",
          vaultId: "vault-1",
        },
      },
      waitUntil: (promise: Promise<unknown>) => {
        configured = promise;
      },
    });
    await configured;

    const push = listeners.get("push");
    expect(push).toBeDefined();
    const deliver = async (): Promise<void> => {
      let completion: Promise<unknown> | undefined;
      push?.({
        data: { json: () => ({ centraid: "replica-wake" }) },
        waitUntil: (promise: Promise<unknown>) => {
          completion = promise;
        },
      });
      await completion;
    };

    await deliver();
    expect(shown).toHaveLength(1);
    expect(shown[0]?.title).toBe("Dinner plans");
    expect(shown[0]?.options).toMatchObject({
      body: "External write needs your approval",
      data: { url: "/?notifications=1" },
      tag: "outbox:item-1:2026-07-30T10:00:00.000Z",
    });
    expect(importScripts).toHaveBeenCalledWith(
      "/centraid-worker-iroh.js?v=v13"
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();

    await deliver();
    expect(shown).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(4);
    expect(close).toHaveBeenCalledTimes(2);
  });
});
