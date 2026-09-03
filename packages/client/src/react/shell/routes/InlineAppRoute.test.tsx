import { act, useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  InlineAppModule,
  InlineAppProps,
} from "@centraid/blueprints/apps/inline-types";
import { forEachSequentially } from "@centraid/test-kit/sequential";

import type * as TypeImport_nod2nz from "../../../gateway-client-core.js";
import type * as TypeImport_1gl5zx7 from "../../../gateway-client.js";
import type { ReplicaShellSession } from "../../../replica/shell-session.js";
import type * as TypeImport_ntzl9 from "../../../replica/shell-session.js";
import type { ShellActions } from "../actions.js";
import type * as TypeImport_g611bp from "../prompt.js";
import type { ShellNav } from "../ShellApp.js";
import type * as TypeImport_1483gth from "./appSettingsData.js";
import InlineAppRoute from "./InlineAppRoute.js";
import type * as TypeImport_13kqdum from "./templatesData.js";

const { doFetch } = vi.hoisted(() => ({
  doFetch: vi.fn<typeof TypeImport_nod2nz.doFetch>(),
}));

vi.mock(import("../../../gateway-client.js") as Promise<unknown>, () => ({
  deleteApp: vi.fn<typeof TypeImport_1gl5zx7.deleteApp>(),
  updateAppMeta: vi.fn<typeof TypeImport_1gl5zx7.updateAppMeta>(),
  streamTurn: vi.fn<typeof TypeImport_1gl5zx7.streamTurn>(),
  createConversation: vi.fn<typeof TypeImport_1gl5zx7.createConversation>(),
  vaultParked: vi.fn<typeof TypeImport_1gl5zx7.vaultParked>(async () => []),
  confirmVaultParked: vi.fn<typeof TypeImport_1gl5zx7.confirmVaultParked>(),
}));
vi.mock(import("../../../gateway-client-core.js") as Promise<unknown>, () => ({
  auth: vi.fn<typeof TypeImport_nod2nz.auth>(async () => ({
    baseUrl: "https://gw.test",
    token: "tok",
  })),
  authHeaders: () => ({}),
  doFetch,
  readJson: vi.fn<typeof TypeImport_nod2nz.readJson>(),
}));
vi.mock(import("../ShellFrame.js") as Promise<unknown>, () => ({
  default: ({
    children,
    titlebarRight,
  }: {
    children: ReactNode;
    titlebarRight?: ReactNode;
  }) => (
    <div data-testid="shell-frame">
      <div data-testid="shell-actions">{titlebarRight}</div>
      {children}
    </div>
  ),
}));
vi.mock(import("./AppSettingsController.js") as Promise<unknown>, () => ({
  default: () => null,
}));
vi.mock(import("./templatesData.js") as Promise<unknown>, () => ({
  loadAppTemplates: vi.fn<typeof TypeImport_13kqdum.loadAppTemplates>(
    async () => []
  ),
}));
vi.mock(import("./appSettingsData.js") as Promise<unknown>, () => ({
  fetchAppKnobValues: vi.fn<typeof TypeImport_1483gth.fetchAppKnobValues>(
    async () => ({})
  ),
  pushKnobToInlineRoot: vi.fn<typeof TypeImport_1483gth.pushKnobToInlineRoot>(),
}));
vi.mock(import("../actions.js") as Promise<unknown>, () => ({
  useShellActions: () => ({
    confirm: vi.fn<ShellActions["confirm"]>(async () => true),
    showToast: vi.fn<ShellActions["showToast"]>(),
  }),
}));
vi.mock(import("../iconSvg.js") as Promise<unknown>, () => ({
  iconSvg: () => "<svg></svg>",
}));
vi.mock(import("../prompt.js") as Promise<unknown>, () => ({
  openPrompt: vi.fn<typeof TypeImport_g611bp.openPrompt>(async () => ""),
}));

const fakeSession = {
  read: vi.fn<ReplicaShellSession["read"]>(),
  search: vi.fn<ReplicaShellSession["search"]>(),
  write: vi.fn<ReplicaShellSession["write"]>(),
  subscribe: vi.fn<ReplicaShellSession["subscribe"]>(() => () => undefined),
} satisfies Pick<
  ReplicaShellSession,
  "read" | "search" | "write" | "subscribe"
>;
const fakeShellSession = fakeSession as unknown as ReplicaShellSession;
vi.mock(
  import("../../../replica/shell-session.js") as Promise<unknown>,
  () => ({
    getReplicaShellSession: vi.fn<
      typeof TypeImport_ntzl9.getReplicaShellSession
    >(async () => fakeShellSession),
    acquireReplicaShellSession: vi.fn<
      typeof TypeImport_ntzl9.acquireReplicaShellSession
    >(async () => ({
      session: fakeShellSession,
      release: () => undefined,
    })),
  })
);
vi.mock(import("./useAppScopes.js") as Promise<unknown>, () => {
  const ready = {
    status: "ready",
    data: {
      scopes: [
        {
          scope: {
            id: "vault-own",
            label: "Library",
            personal: true,
            canWrite: true,
          },
          identity: { gatewayId: "gw", vaultId: "vault-own" },
        },
      ],
    },
  };
  return {
    useAppScopes: () => ready,
    scopeSetKey: (scopes: { identity: { vaultId: string } }[]) =>
      scopes.map((entry) => entry.identity.vaultId).join(","),
  };
});

const app = {
  id: "tasks",
  name: "Tasks",
  iconKey: "Todo",
  color: "#123",
} as unknown as AppMetaResolvedType;
const nav: ShellNav = {
  navigate: vi.fn<ShellNav["navigate"]>(),
  replace: vi.fn<ShellNav["replace"]>(),
  back: vi.fn<ShellNav["back"]>(),
  forward: vi.fn<ShellNav["forward"]>(),
  canGoBack: false,
  canGoForward: false,
  stemOpen: true,
  toggleStem: vi.fn<ShellNav["toggleStem"]>(),
  route: { kind: "app", id: "tasks" },
};
const prefs = { sidebarOpen: true, theme: "dark" } as never;

function routeEl(
  loader: () => Promise<{ default: InlineAppModule }>,
  appId: string,
  routeApp: AppMetaResolvedType = app
): JSX.Element {
  return (
    <InlineAppRoute
      app={routeApp}
      appId={appId}
      loader={loader}
      nav={nav}
      renderStem={() => null}
      prefs={prefs}
    />
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(el: JSX.Element): Promise<void> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(el);
  });
  await flush();
}

async function flush(): Promise<void> {
  await forEachSequentially(Array.from({ length: 6 }), async () => {
    await act(async () => {
      await Promise.resolve();
    });
  });
}
describe("InlineAppRoute suite", () => {
  beforeEach(() => {
    doFetch.mockReset();
    fakeSession.read.mockReset();
    (globalThis as unknown as { CentraidTokens: unknown }).CentraidTokens = {
      tileFinish: () => ({
        background: "#111",
        boxShadow: "none",
        glyphColor: "#fff",
      }),
    };
    (globalThis as unknown as { CentraidApi: unknown }).CentraidApi = {
      openAppFolder: vi.fn<(appId: string) => Promise<void>>(),
    };
    delete (window as { centraid?: unknown }).centraid;
  });

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  function makeApp(RootImpl: InlineAppModule["Root"]): InlineAppModule {
    return {
      appId: "tasks",
      pendingProjection: { appId: "tasks", actions: {} },
      changeTables: ["schedule.task"],
      queries: {
        board: {
          default: async () => ({
            open: [{ task_id: "a", title: "Buy milk" }],
          }),
        },
      },
      Root: RootImpl,
    };
  }

  describe(InlineAppRoute, () => {
    it("renders the inline app and paints from the local replica with zero gateway fetches", async () => {
      function Root({ rootRef }: InlineAppProps): JSX.Element {
        const [label, setLabel] = useState("…");
        useEffect(() => {
          void (
            window as unknown as {
              centraid: {
                read: (
                  o: unknown
                ) => Promise<{ open: Array<{ title: string }> }>;
              };
            }
          ).centraid
            .read({ query: "board" })
            .then((res) => setLabel(res.open[0]?.title ?? "empty"));
        }, []);
        return (
          <div ref={rootRef} data-testid="tasks-root">
            {label}
          </div>
        );
      }
      await mount(
        routeEl(async () => ({ default: makeApp(Root) }), "tasks-render")
      );
      await flush();
      expect(
        host!.querySelector('[data-testid="tasks-root"]')?.textContent
      ).toBe("Buy milk");
      expect(host!.querySelector('[aria-label="App settings"]')).toBeNull();
      expect(doFetch).not.toHaveBeenCalled();
      expect((window as { centraid?: unknown }).centraid).toBeDefined();
      const tokenStyle = document.querySelector(
        "style[data-centraid-inline-tokens]"
      );
      expect(tokenStyle?.textContent).toMatch(
        /@media \(pointer: fine\) \{\s+\.centraid-inline-scope \{/u
      );
    });

    it("does not expose the generic app-settings sheet for Photos", async () => {
      const photos = { ...app, id: "photos", name: "Photos" };
      function Root({ rootRef }: InlineAppProps): JSX.Element {
        return (
          <div ref={rootRef} data-testid="photos-root">
            photos
          </div>
        );
      }
      await mount(
        routeEl(
          async () => ({ default: makeApp(Root) }),
          "photos-no-app-settings",
          photos
        )
      );
      expect(host!.querySelector('[data-testid="photos-root"]')).toBeTruthy();
      expect(host!.querySelector('[aria-label="App settings"]')).toBeNull();
    });

    it("tears down window.centraid on unmount", async () => {
      function Root({ rootRef }: InlineAppProps): JSX.Element {
        return <div ref={rootRef}>ok</div>;
      }
      await mount(
        routeEl(async () => ({ default: makeApp(Root) }), "tasks-teardown")
      );
      expect((window as { centraid?: unknown }).centraid).toBeDefined();
      act(() => root?.unmount());
      root = null;
      expect((window as { centraid?: unknown }).centraid).toBeUndefined();
    });

    it("keeps window.centraid installed across a shell re-render", async () => {
      function Root({ rootRef }: InlineAppProps): JSX.Element {
        return <div ref={rootRef}>ok</div>;
      }
      const loader = async () => ({ default: makeApp(Root) });
      await mount(routeEl(loader, "tasks-shell-rerender"));
      const installed = (window as { centraid?: unknown }).centraid;

      await act(async () => {
        root!.render(routeEl(loader, "tasks-shell-rerender"));
      });
      await flush();

      expect((window as { centraid?: unknown }).centraid).toBe(installed);
    });

    it("keeps a mounted image's blob: URL alive across a shell re-render, and revokes it on unmount", async () => {
      const createObjectURL = (
        URL as unknown as { createObjectURL?: (b: Blob) => string }
      ).createObjectURL;
      const revokeObjectURL = (
        URL as unknown as { revokeObjectURL?: (u: string) => void }
      ).revokeObjectURL;
      const revoked: string[] = [];
      let seq = 0;
      (
        URL as unknown as { createObjectURL: (b: Blob) => string }
      ).createObjectURL = () => `blob:mock/${++seq}`;
      (
        URL as unknown as { revokeObjectURL: (u: string) => void }
      ).revokeObjectURL = (u) => {
        revoked.push(u);
      };
      doFetch.mockImplementation(
        async () =>
          ({
            ok: true,
            status: 200,
            headers: new Headers(),
            blob: async () => new Blob(["bytes"], { type: "image/jpeg" }),
          }) as unknown as Response
      );
      const Root = ({ rootRef }: InlineAppProps): JSX.Element => (
        <div ref={rootRef} data-testid="tasks-root">
          <img data-testid="tile" src="/centraid/_vault/blobs/photo-1" alt="" />
        </div>
      );
      try {
        const loader = async (): Promise<{ default: InlineAppModule }> => ({
          default: makeApp(Root),
        });
        await mount(routeEl(loader, "tasks-blob-render"));
        await flush();
        const tile = host!.querySelector<HTMLImageElement>(
          '[data-testid="tile"]'
        )!;
        const authed = tile.getAttribute("src");
        expect(authed).toMatch(/^blob:mock\//u);

        await act(async () => {
          root!.render(routeEl(loader, "tasks-blob-render"));
        });
        await flush();

        expect(revoked).toStrictEqual([]);
        expect(tile.getAttribute("src")).toBe(authed);

        act(() => root?.unmount());
        root = null;
        expect(revoked).toStrictEqual([authed]);
      } finally {
        (
          URL as unknown as { createObjectURL?: (b: Blob) => string }
        ).createObjectURL = createObjectURL;
        (
          URL as unknown as { revokeObjectURL?: (u: string) => void }
        ).revokeObjectURL = revokeObjectURL;
      }
    });

    it("catches a failed chunk load and Retry re-imports + remounts", async () => {
      function Root({ rootRef }: InlineAppProps): JSX.Element {
        return (
          <div ref={rootRef} data-testid="tasks-root">
            recovered
          </div>
        );
      }
      let calls = 0;
      const loader = vi.fn<() => Promise<{ default: InlineAppModule }>>(
        async () => {
          if (calls++ === 0) throw new Error("chunk load failed");
          return { default: makeApp(Root) };
        }
      );
      await mount(routeEl(loader, "tasks-retry"));
      await flush();
      const retry = [...host!.querySelectorAll("button")].find((b) =>
        /try again/iu.test(b.textContent ?? "")
      );
      expect(retry).toBeTruthy();
      expect(host!.querySelector('[data-testid="tasks-root"]')).toBeNull();

      await act(async () => {
        retry!.click();
      });
      await flush();
      expect(
        host!.querySelector('[data-testid="tasks-root"]')?.textContent
      ).toBe("recovered");
      expect(loader.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("refuses to mount Locker on the viewer seat (docs/blueprint-seats.md S5)", async () => {
      (window as unknown as { CentraidIroh?: unknown }).CentraidIroh = {};
      const loader = vi.fn<() => Promise<{ default: InlineAppModule }>>(
        async () => ({ default: makeApp(() => <div>should not mount</div>) })
      );
      try {
        await mount(routeEl(loader, "locker"));
        const refusal = host!.querySelector(
          '[data-testid="inline-app-seat-refusal"]'
        );
        expect(refusal).toBeTruthy();
        expect(refusal?.textContent ?? "").toMatch(
          /does not open on a shared browser/iu
        );
        expect(refusal?.textContent ?? "").toMatch(/user-presence boundary/iu);
        expect(refusal?.textContent ?? "").toMatch(/desktop app|your phone/iu);
        expect(loader).not.toHaveBeenCalled();
      } finally {
        delete (window as unknown as { CentraidIroh?: unknown }).CentraidIroh;
      }
    });

    it("mounts Locker normally on the custodian seat (no viewer marker)", async () => {
      delete (window as unknown as { CentraidIroh?: unknown }).CentraidIroh;
      function Root({ rootRef }: InlineAppProps): JSX.Element {
        return <div ref={rootRef} data-testid="locker-root" />;
      }
      await mount(routeEl(async () => ({ default: makeApp(Root) }), "locker"));
      expect(
        host!.querySelector('[data-testid="inline-app-seat-refusal"]')
      ).toBeNull();
      expect(host!.querySelector('[data-testid="locker-root"]')).toBeTruthy();
    });
  });
});
