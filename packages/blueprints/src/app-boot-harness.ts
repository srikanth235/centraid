// governance: allow-repo-hygiene file-size-limit cohesive jsdom boot harness; the fetch/module shims, .module.css-as-JS rewrite, and per-app boot assertions must move together to mirror the shell bundle path
/* oxlint-disable typescript-eslint/ban-ts-comment -- no DOM lib in this
   node-side tsconfig, but jsdom makes DOM globals runtime-real here. */
// @ts-nocheck
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root as ReactRoot } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  decoratePendingMutation,
  definePendingProjection,
  pendingPatch,
  projectPendingWrite,
} from "@centraid/blueprints/apps/_shared/pending-overlay";

// Boots a blueprint app the way the v0 client does. THREE constraints; break
// one and the gate passes while the app is broken:
//
//  1. Errors trap on `process`, not `window`: boot's un-awaited `refresh()`
//     throws a NODE rejection, which vitest prints WITHOUT failing.
//  2. ONE app and ONE module import per process — timers outlive tests and
//     `customElements.define()` runs at module scope. Hence one
//     `<app>.test.ts` each; the forks pool isolates per FILE.
//  3. Consent paths re-read, never re-import: flip the mock, dispatch 'focus'.

// From this module's own path, not process.cwd().
const PKG = path.resolve(import.meta.dirname, "..");

// The CLI, not esbuild's JS API: the API refuses to load under jsdom.
const ESBUILD_BIN = path.resolve(PKG, "../..", "node_modules/.bin/esbuild");

// BY PATH, not by specifier: `@centraid/client` already depends on this
// package, so the reverse edge would make Turbo's `^build` graph cyclic.
const { replicaIntentInvalidations } = await import(
  pathToFileURL(
    path.resolve(PKG, "../client/src/replica/intent-invalidations.ts")
  ).href
);

function loaderForExt(rel: string): "jsx" | "tsx" | "ts" {
  if (rel.endsWith(".tsx")) return "tsx";
  if (rel.endsWith(".ts")) return "ts";
  return "jsx";
}

function transformInlineSource(source: string, rel = "app.tsx"): string {
  const code = execFileSync(
    ESBUILD_BIN,
    [`--loader=${loaderForExt(rel)}`, "--jsx=automatic"],
    {
      input: source,
      encoding: "utf8",
    }
  );
  return (
    code
      // The `.js` tail stops Vitest re-transforming compiled CSS-module JS.
      .replace(
        /(?<quote>["'])(?<spec>(?:\.\.?\/)[^"']*\.module\.css)\k<quote>/gu,
        (_m, quote: string, spec: string) => `${quote}${spec}.js${quote}`
      )
  );
}

function compileModuleCss(
  absFile: string,
  appRoot: string,
  scratch: string
): string {
  const work = path.join(
    scratch,
    `.cssmod-${path.basename(absFile)}-${Date.now()}`
  );
  mkdirSync(work, { recursive: true });
  const entry = path.join(work, "entry.js");
  writeFileSync(
    entry,
    `import m from ${JSON.stringify(absFile)};\nexport default m;\n`
  );
  execFileSync(
    ESBUILD_BIN,
    [
      entry,
      "--bundle",
      "--format=esm",
      "--platform=browser",
      "--loader:.module.css=local-css",
      `--outdir=${path.join(work, "out")}`,
    ],
    { encoding: "utf8", cwd: appRoot }
  );
  const outDir = path.join(work, "out");
  let js = "";
  let css = "";
  for (const name of readdirSync(outDir)) {
    const body = readFileSync(path.join(outDir, name), "utf8");
    if (name.endsWith(".css")) css = body;
    else js = body;
  }
  const key = path.relative(appRoot, absFile).split(path.sep).join("/");
  return (
    `(() => {\n` +
    `  if (typeof document === 'undefined') return;\n` +
    `  const k = ${JSON.stringify(key)};\n` +
    `  if (document.querySelector('style[data-centraid-css-module=' + JSON.stringify(k) + ']')) return;\n` +
    `  const el = document.createElement('style');\n` +
    `  el.setAttribute('data-centraid-css-module', k);\n` +
    `  el.textContent = ${JSON.stringify(css)};\n` +
    `  document.head.appendChild(el);\n` +
    `})();\n` +
    js
  );
}

const DENIED = { vaultDenied: { message: "Grant revoked." } };

const PHOTO_ASSET_ID = "asset-airplane";
const PHOTO_TITLE = "Airplane-mode photo";

const AGENDA_EVENT_ID = "event-airplane";
const AGENDA_INTENT_ID = "intent-airplane-cancel";
const AGENDA_TITLE = "Airplane-mode planning";

// The app's own declaration, never re-derived: a hand-rolled projection
// asserts on a chip nothing in the product would paint.
const AGENDA_PENDING_PROJECTION = definePendingProjection({
  appId: "agenda",
  actions: {
    "cancel-event": ({ input }) =>
      pendingPatch("core.event", input.event_id, input),
  },
});

function replicaFixture(app: string): unknown {
  if (app === "agenda") {
    return {
      events: [
        {
          event_id: AGENDA_EVENT_ID,
          calendar_id: "calendar-local",
          summary: AGENDA_TITLE,
          description: "Already present in the local replica.",
          dtstart: "2099-01-15T09:00:00.000Z",
          dtend: "2099-01-15T10:00:00.000Z",
          status: "confirmed",
          attendees: [],
          attachments: [],
        },
      ],
      calendars: [{ calendar_id: "calendar-local", name: "Local calendar" }],
    };
  }
  if (app === "photos") {
    return {
      assets: [
        {
          asset_id: PHOTO_ASSET_ID,
          content_id: "content-airplane",
          title: PHOTO_TITLE,
          media_type: "image/gif",
          content_uri:
            "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
          thumb_uri: null,
          preview_uri: null,
          width: 320,
          height: 240,
          taken_at: "2026-07-15T08:00:00.000Z",
          favorite: 0,
          album_ids: ["album-airplane"],
          album_titles: ["Offline picks"],
          tags: [],
          place: null,
          custody_state: "available",
        },
      ],
      albums: [{ album_id: "album-airplane", title: "Offline picks" }],
      places: [],
      trash: [],
      truncated: false,
      window: 500,
    };
  }
  return {};
}

// Node-side modules the page never imports; the boot entry is app-root.tsx.
const NON_UI_DIRS = new Set(["queries", "actions", "automations"]);

function collectSources(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!NON_UI_DIRS.has(e.name)) out.push(...collectSources(root, r));
    } else if (
      r.endsWith(".js") ||
      r.endsWith(".jsx") ||
      r.endsWith(".ts") ||
      r.endsWith(".tsx") ||
      r.endsWith(".module.css")
    ) {
      out.push(r);
    }
  }
  return out;
}

/** Only for assertions needing a QUIET window; for "X appears", use waitFor. */
const settle = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 80);
  });

// Poll, never sleep: a fixed settle is a guess a loaded CI runner loses.
async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 4_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const waitNext = async (): Promise<void> => {
    if (predicate()) return;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
    return waitNext();
  };
  return waitNext();
}

// Per-journey, not package-wide: CPU contention triples the slowest app.
const BOOT_TEST_TIMEOUT_MS = 60_000;

// Chrome.tsx mounts and unmounts the notice rather than toggling `hidden`.
function consentBannerShown(): boolean {
  const banner = document.querySelector<HTMLElement>("#consentBanner");
  return banner !== null && banner.hidden === false;
}

function mirrorSources(srcRoot: string, destRoot: string): void {
  mkdirSync(destRoot, { recursive: true });
  for (const rel of collectSources(srcRoot)) {
    const out = path.join(destRoot, rel);
    mkdirSync(path.dirname(out), { recursive: true });
    if (rel.endsWith(".jsx") || rel.endsWith(".tsx") || rel.endsWith(".ts")) {
      writeFileSync(
        out,
        transformInlineSource(
          readFileSync(path.join(srcRoot, rel), "utf8"),
          rel
        )
      );
    } else if (rel.endsWith(".module.css")) {
      writeFileSync(
        `${out}.js`,
        compileModuleCss(path.join(srcRoot, rel), srcRoot, destRoot)
      );
    } else {
      cpSync(path.join(srcRoot, rel), out);
    }
  }
}

export function describeAppBoot(
  app: string,
  options: { expectLive?: boolean } = {}
) {
  describe(`${app} boots`, () => {
    let dir: string;
    let bootRoot: string;
    let reactRoot: ReactRoot | undefined;
    let originalFetch: typeof fetch;
    const errors: unknown[] = [];
    const intervals: unknown[] = [];
    const push = (e: unknown) => errors.push(e);

    const expectNoErrors = (phase: string) => {
      expect(
        errors,
        `${app} threw while ${phase}: ${errors.map(String).join(" | ")}`
      ).toEqual([]);
    };

    beforeAll(() => {
      originalFetch = globalThis.fetch;
      // Inside the package, not os.tmpdir(): vite refuses a module outside the
      // project root. Laid out like `apps/` so `../_shared` resolves normally.
      bootRoot = path.join(PKG, ".app-boot", app);
      rmSync(bootRoot, { recursive: true, force: true });
      dir = path.join(bootRoot, app);
      mkdirSync(dir, { recursive: true });
      mirrorSources(path.join(PKG, "apps", app), dir);
      const sharedDir = path.join(PKG, "apps", "_shared");
      if (existsSync(sharedDir))
        mirrorSources(sharedDir, path.join(bootRoot, "_shared"));

      process.on("unhandledRejection", push);
      process.on("uncaughtException", push);

      // Apps set a per-second interval that would keep the worker alive.
      const realSetInterval = globalThis.setInterval;
      globalThis.setInterval = (...args: unknown[]) => {
        const id = realSetInterval(...args);
        intervals.push(id);
        return id;
      };

      // jsdom implements neither; apps read both at boot (theme, layout).
      window.matchMedia ??= () => ({
        matches: false,
        addEventListener() {},
        addListener() {},
      });
      window.scrollTo ??= () => {};
      window.addEventListener("error", (e) => push(e.error ?? e.message));
    });

    afterAll(() => {
      globalThis.fetch = originalFetch;
      reactRoot?.unmount();
      for (const id of intervals) clearInterval(id);
      process.off("unhandledRejection", push);
      process.off("uncaughtException", push);
      rmSync(bootRoot, { recursive: true, force: true });
    });

    it(
      "renders its replica while offline, survives revoke, and re-renders",
      { timeout: BOOT_TEST_TIMEOUT_MS },
      async () => {
        document.body.innerHTML = '<div id="appRoot"></div>';
        if (app === "agenda") {
          // Schedule renders the fixture regardless of the machine's month.
          document.documentElement.dataset.appDefaultView = "schedule";
        }
        const granted = options.expectLive ? replicaFixture(app) : {};
        let response: unknown = granted;
        let nextReadError: Error | undefined;
        let readCalls = 0;
        const networkCalls: unknown[] = [];
        const writeCalls: unknown[] = [];
        const live = new Set<(value: unknown) => void>();
        const changes = new Set<(detail: unknown) => void>();
        Object.defineProperty(window.navigator, "onLine", {
          configurable: true,
          value: false,
        });
        globalThis.fetch = async (...args: unknown[]) => {
          networkCalls.push(args[0]);
          throw new Error("synthetic airplane mode");
        };
        // The row keeps its place: a held cancellation is a designed state.
        const updateAgendaOverlay = (
          intentState: "queued" | "parked" | "denied"
        ): void => {
          if (app !== "agenda") return;
          const projected = projectPendingWrite(AGENDA_PENDING_PROJECTION, {
            appId: "agenda",
            action: "cancel-event",
            input: { event_id: AGENDA_EVENT_ID },
            intentId: AGENDA_INTENT_ID,
          });
          const mutation = projected.optimistic[0];
          if (!mutation || mutation.op !== "upsert") return;
          const decorated = decoratePendingMutation(mutation, {
            intentId: AGENDA_INTENT_ID,
            state: intentState,
            action: "cancel-event",
            ...(intentState === "parked"
              ? { reason: "Waiting for the owner to approve this change." }
              : intentState === "denied"
                ? { reason: "The owner denied this cancellation." }
                : {}),
          });
          const current = response as {
            events: Array<Record<string, unknown>>;
            calendars: Array<Record<string, unknown>>;
          };
          response = {
            ...current,
            events: current.events.map((event) =>
              event.event_id === mutation.rowId
                ? { ...event, ...decorated.values }
                : event
            ),
          };
          for (const listener of live) listener(response);
        };

        window.centraid = {
          appId: app,
          read: (request?: {
            query?: string;
            input?: Record<string, unknown>;
          }) => {
            readCalls += 1;
            // Agenda's second question (#834) answers a different shape, so it
            // gets its own answer; empty on purpose.
            if (app === "agenda" && request?.query === "day-context") {
              return Promise.resolve({
                birthdays: [],
                due: [],
                holidays: [],
              });
            }
            if (app === "locker" && request?.query === "auth") {
              return Promise.resolve({
                ok: true,
                configured: true,
                authenticated: true,
                sessionToken: "app-boot-user-present-session",
              });
            }
            const error = nextReadError;
            nextReadError = undefined;
            const result = error
              ? Promise.reject(new Error(error.message))
              : Promise.resolve(response);
            result.subscribe = (listener: (value: unknown) => void) => {
              live.add(listener);
              void result.then(listener, () => undefined);
              return () => live.delete(listener);
            };
            return result;
          },
          write: async (request: unknown) => {
            writeCalls.push(request);
            if (
              app === "agenda" &&
              (request as { action?: string }).action === "cancel-event"
            ) {
              updateAgendaOverlay("queued");
              return { status: "queued", intentId: AGENDA_INTENT_ID };
            }
            return {};
          },
          onChange: (listener: (detail: unknown) => void) => {
            changes.add(listener);
            return () => changes.delete(listener);
          },
        };

        // The client hands every inline app one of these, so the harness must.
        const contributed: {
          appBar: Record<string, unknown> | null;
          band: Record<string, unknown> | null;
          status: ({ text: string } | null)[];
        } = { appBar: null, band: null, status: [] };
        const frame = {
          setAppBar: (bar: Record<string, unknown> | null) => {
            contributed.appBar = bar;
          },
          setStatus: (text: string) => {
            contributed.status.push({ text });
          },
          clearStatus: () => {
            contributed.status.push(null);
          },
          claimBand: (claim: Record<string, unknown> | null) => {
            contributed.band = claim;
          },
        };

        // The real coordinator's delivery: a hand-rolled doorbell would prove
        // only that the harness can invalidate.
        const emitAgendaIntentState = (
          intentState: "parked" | "denied"
        ): void => {
          updateAgendaOverlay(intentState);
          const invalidations = replicaIntentInvalidations([
            {
              intentId: AGENDA_INTENT_ID,
              payloadHash: "harness-payload",
              appId: "agenda",
              action: "cancel-event",
              input: { event_id: AGENDA_EVENT_ID },
              state: intentState,
              createdOrder: 1,
              attempts: 1,
              optimistic: [],
              dependencies: [
                { shapeId: "shape-agenda-events", entity: "core.event" },
              ],
            },
          ]);
          for (const invalidation of invalidations)
            for (const listener of changes)
              listener({ ...invalidation, tables: [invalidation.entity] });
        };

        const module = await import(
          pathToFileURL(path.join(dir, "app-root.tsx")).href
        );
        reactRoot = createRoot(document.querySelector("#appRoot")!);
        reactRoot.render(
          createElement(module.Root, { rootRef: () => {}, frame })
        );
        await settle();
        expectNoErrors("rendering its granted replica in airplane mode");

        if (options.expectLive) {
          await waitFor(
            () => live.size > 0,
            `${app} to subscribe to its replica read`
          );
          const bootReads = readCalls;
          expect(
            bootReads,
            `${app} issued an unbounded initial read fanout`
          ).toBeLessThanOrEqual(2);
          expect(
            networkCalls,
            `${app} blocked local paint on the network`
          ).toEqual([]);
          expect(
            live.size,
            `${app} never subscribed to its replica read`
          ).toBeGreaterThan(0);

          if (app === "agenda") {
            const eventRow = (): Element | null =>
              document.querySelector(`[data-event-id="${AGENDA_EVENT_ID}"]`);
            const askToCancel = (): HTMLButtonElement | undefined =>
              Array.from(
                document.querySelectorAll<HTMLButtonElement>("button")
              ).find(
                (button) => button.textContent?.trim() === "Ask to cancel"
              );

            await waitFor(
              () => eventRow() !== null,
              "Agenda's schedule row to render from the local replica"
            );
            expect(eventRow()?.textContent).toContain(AGENDA_TITLE);
            (eventRow() as HTMLButtonElement | null)?.click();
            await waitFor(
              () => askToCancel() !== undefined,
              "the Agenda event's detail panel to open"
            );
            askToCancel()?.click();
            // settle holds a QUIET window: exactly-one, not not-yet-arrived.
            await waitFor(
              () => writeCalls.length > 0,
              "Agenda's cancel ask to reach the vault"
            );
            await settle();
            expect(writeCalls).toStrictEqual([
              {
                action: "cancel-event",
                input: { event_id: AGENDA_EVENT_ID },
              },
            ]);
            expect(
              readCalls,
              "offline interaction unexpectedly re-read the replica"
            ).toBe(bootReads);
            expect(
              networkCalls,
              "offline interaction attempted a network request"
            ).toStrictEqual([]);

            await waitFor(
              () => document.querySelector(".kit-pending-chip") !== null,
              "Agenda's held-write chip to paint for the queued cancel"
            );
            expect(
              document.querySelector(".kit-pending-chip")?.textContent
            ).toBe("cancel asked");
            expect(document.body.textContent).toContain(AGENDA_TITLE);

            // Reconnect PARKS the queued intent; the chip stays until terminal.
            Object.defineProperty(window.navigator, "onLine", {
              configurable: true,
              value: true,
            });
            emitAgendaIntentState("parked");
            await settle();
            expect(
              document.querySelector(".kit-pending-chip")?.textContent
            ).toBe("cancel asked");

            // A denial is durable attention state until the member acts on it.
            emitAgendaIntentState("denied");
            await waitFor(
              () =>
                document.querySelector(".kit-pending-chip")?.textContent ===
                "denied",
              "Agenda's denied chip to persist on the exact outcome"
            );
            expect(document.body.textContent).toContain(AGENDA_TITLE);
            // The doorbell is trailing-debounced, so poll rather than read.
            await waitFor(
              () => readCalls > bootReads,
              "the outbox state change to invalidate the composed replica read"
            );
            expect(
              readCalls,
              "outbox state changes did not invalidate the composed replica read"
            ).toBeGreaterThan(bootReads);
            expect(
              networkCalls,
              "outbox state invalidation attempted a network read"
            ).toStrictEqual([]);
          } else if (app === "photos") {
            await waitFor(
              () =>
                document.querySelector(
                  `[data-asset-id="${PHOTO_ASSET_ID}"]`
                ) !== null,
              "Photos' local asset tile to render from the local replica"
            );
            const tile = document.querySelector(
              `[data-asset-id="${PHOTO_ASSET_ID}"]`
            );
            expect(
              tile,
              "the populated local Photos row did not render"
            ).toBeTruthy();
            expect(tile?.querySelector("img")?.alt).toBe(PHOTO_TITLE);

            // Photos contributes an app bar rather than drawing one.
            await waitFor(
              () => contributed.appBar !== null,
              "Photos to contribute the frame's app bar"
            );
            expect(contributed.appBar?.title).toBe("Photos");
            expect(String(contributed.appBar?.count)).toContain("1");
            const claimed = (contributed.band ?? {}).destinations as
              | { id: string }[]
              | undefined;
            expect(claimed?.map((d) => d.id)).toEqual([
              "library",
              "albums",
              "people",
              "search",
            ]);

            expect(document.querySelector("#hamburgerBtn")).toBeNull();
            expect(document.querySelector("#zoomInBtn")).toBeNull();
            expect(document.querySelector("#sidebarMount")).toBeNull();
            expect(document.querySelector("#noticeBanner")).toBeNull();
          }

          response = DENIED;
          for (const listener of Array.from(live)) listener(response);
          await waitFor(
            consentBannerShown,
            `${app} to reveal its consent banner for a denied live replica value`
          );
          expectNoErrors("applying a denied live replica value");
          expect(
            consentBannerShown(),
            `${app} ignored a denied live replica value`
          ).toBe(true);

          response = granted;
          for (const listener of Array.from(live)) listener(response);
          await waitFor(
            () => !consentBannerShown(),
            `${app} to hide its consent banner for a re-granted live replica value`
          );
          expectNoErrors("applying a re-granted live replica value");
          expect(
            consentBannerShown(),
            `${app} ignored a re-granted live replica value`
          ).toBe(false);

          // A replacement read can fail before registering a dependency; the
          // app must release the dead subscription and retry.
          const beforeFailure = readCalls;
          nextReadError = new Error("synthetic initial replica read failure");
          if (app === "photos") {
            const realNow = Date.now;
            const afterStaleWindow = realNow() + 31_000;
            Date.now = () => afterStaleWindow;
            window.dispatchEvent(new Event("focus"));
            Date.now = realNow;
          } else {
            window.dispatchEvent(new Event("focus"));
          }
          await waitFor(
            () => readCalls > beforeFailure,
            `${app} to attempt the replacement live read`
          );
          expect(
            readCalls,
            `${app} did not attempt the replacement live read`
          ).toBeGreaterThan(beforeFailure);
          const afterFailure = readCalls;
          const table = app === "agenda" ? "core.event" : "core.content_item";
          for (const listener of changes) listener({ tables: [table] });
          await waitFor(
            () => readCalls > afterFailure && live.size > 0,
            `${app} to retry its rejected live read on the compatibility doorbell`
          );
          expect(
            readCalls,
            `${app} suppressed the compatibility retry after its live read rejected`
          ).toBeGreaterThan(afterFailure);
          expect(
            live.size,
            `${app} did not restore a managed live dependency`
          ).toBeGreaterThan(0);
          return;
        }

        // Never guard this: it is the only assertion proving the denial landed.
        response = DENIED;
        window.dispatchEvent(new Event("focus"));

        await waitFor(
          consentBannerShown,
          `${app} to reveal its consent banner after the grant was revoked`
        );
        expectNoErrors("clearing after the grant was revoked");
        expect(
          consentBannerShown(),
          `${app} hid its consent banner while denied`
        ).toBe(true);

        response = {};
        window.dispatchEvent(new Event("focus"));
        await waitFor(
          () => !consentBannerShown(),
          `${app} to hide its consent banner after the grant came back`
        );
        expectNoErrors("re-rendering after the grant came back");
        expect(
          consentBannerShown(),
          `${app} kept its consent banner after re-grant`
        ).toBe(false);
      }
    );
  });
}
