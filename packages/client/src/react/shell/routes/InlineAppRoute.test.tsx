import { act, useEffect, useState } from "react";
import type { JSX } from "react";
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

// Heavy shell + gateway deps stubbed to their inline-relevant surface.
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
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="shell-frame">{children}</div>
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
    enterBuilder: vi.fn<ShellActions["enterBuilder"]>(),
    openNewAppSheet: vi.fn<ShellActions["openNewAppSheet"]>(),
    showToast: vi.fn<ShellActions["showToast"]>(),
    builderEnabled: false,
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
// This route only touches the explicit read/search/write/subscription boundary.
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
// The scope set is resolved over HTTP (issue #599); this route's suite is about
// mounting, so it gets one ready scope rather than a gateway round-trip.
vi.mock(import("./useAppScopes.js") as Promise<unknown>, () => ({
  useAppScopes: () => ({
    status: "ready",
    data: [
      {
        scope: { id: "vault-own", label: "Library", canWrite: true },
        identity: { gatewayId: "gw", vaultId: "vault-own" },
      },
    ],
  }),
  scopeSetKey: (scopes: { identity: { vaultId: string } }[]) =>
    scopes.map((entry) => entry.identity.vaultId).join(","),
}));

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
  route: { kind: "app", id: "tasks" },
};
const prefs = { sidebarOpen: true, theme: "dark" } as never;

// A distinct appId per test — InlineAppRoute keys its module-level descriptor
// cache on (appId, attempt), so reusing an id would serve a prior test's chunk.
function routeEl(
  loader: () => Promise<{ default: InlineAppModule }>,
  appId: string
): JSX.Element {
  return (
    <InlineAppRoute
      app={app}
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
  // let the lazy descriptor + session promises settle through Suspense
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

  /** A Root that reads the board through window.centraid on mount. */
  function makeApp(RootImpl: InlineAppModule["Root"]): InlineAppModule {
    return {
      appId: "tasks",
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
      // Offline first paint: no gateway tool route touched.
      expect(doFetch).not.toHaveBeenCalled();
      // window.centraid is installed for the app.
      expect((window as { centraid?: unknown }).centraid).toBeDefined();
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

    it("catches a failed chunk load and Retry re-imports + remounts", async () => {
      function Root({ rootRef }: InlineAppProps): JSX.Element {
        return (
          <div ref={rootRef} data-testid="tasks-root">
            recovered
          </div>
        );
      }
      // The lazy chunk fails to load the first time; Retry must re-import it.
      let calls = 0;
      const loader = vi.fn<() => Promise<{ default: InlineAppModule }>>(
        async () => {
          if (calls++ === 0) throw new Error("chunk load failed");
          return { default: makeApp(Root) };
        }
      );
      await mount(routeEl(loader, "tasks-retry"));
      await flush();
      // Error boundary fallback is showing its Try again control.
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
      // The retry re-imported the descriptor (fresh chunk load path).
      expect(loader.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
