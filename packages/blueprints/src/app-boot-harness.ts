// governance: allow-repo-hygiene file-size-limit cohesive jsdom boot harness; the fetch/module shims, .module.css-as-JS rewrite, and per-app boot assertions must move together to mirror the shell bundle path
/* oxlint-disable typescript-eslint/ban-ts-comment -- the package tsconfig has
   no DOM lib (this "src" is node-side); this harness drives the browser apps
   under jsdom, so DOM globals are runtime-real but invisible to tsc. */
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

// Boots a blueprint app the way the v0 client does: its query-free `Root`,
// the real kit, the workspace React runtime, and a mocked `window.centraid`
// vault. No served adapter and no vendored React copy is part of this path.
//
// Typechecking and root lint cover these modules, but neither executes their
// browser startup. Without this behavioral harness, a rendering crash reaches
// a human first.
//
// THREE constraints, each verified empirically. Break one and the gate passes
// while the app is broken:
//
//  1. Errors MUST be trapped on `process`, not `window`. Boot calls `refresh()`
//     without awaiting, so a throw inside becomes a NODE unhandled rejection:
//     jsdom never fires window 'unhandledrejection' for it, and vitest prints
//     it WITHOUT failing the test. (Proven by injecting a throw into refresh.)
//  2. ONE app per process, and ONE module import per process. Apps install
//     resize/interval timers that outlive a test and would then observe another
//     app's DOM; and locker/people call `customElements.define()` at module
//     scope, so a second import of any app.js in the same process throws
//     "already defined". Hence one `<app>.test.ts` file each — vitest's default
//     forks pool isolates per FILE, not per test.
//  3. The apps' consent paths are driven by re-reading, not re-importing. Every
//     app re-runs `refresh()` on window 'focus', so flipping the mock and
//     dispatching focus walks granted → denied → granted on a single instance.
//
// Agenda and Photos boot populated replica fixtures and are the apps held to
// the live-read journey (`expectLive`). Agenda's pending-chip assertions
// consume the production intent-invalidation derivation, so the harness cannot
// invent a terminal browser signal that the real coordinator would never
// publish.

// Resolved from this module's own path, not process.cwd(): cwd differs
// between a root-run vitest (repo root) and a package-run vitest (this
// package's dir), but the file's own location never does.
const PKG = path.resolve(import.meta.dirname, "..");

// The harness compiles the same TS/TSX source the client bundles, using the
// normal React automatic runtime. The esbuild CLI is used because its JS API
// refuses to load under the jsdom environment (realm-split Uint8Array trips
// its TextEncoder startup invariant).
const ESBUILD_BIN = path.resolve(PKG, "../..", "node_modules/.bin/esbuild");

// The intent-invalidation derivation is the client's (packages/client/src/
// replica/intent-invalidations.ts). It is loaded BY PATH rather than as
// `@centraid/client/replica/intent-invalidations` because `@centraid/client`
// already depends on `@centraid/blueprints`: declaring the reverse edge — even
// as a devDependency — would make Turbo's topological `^build` graph cyclic.
const { replicaIntentInvalidations } = await import(
  pathToFileURL(
    path.resolve(PKG, "../client/src/replica/intent-invalidations.ts")
  ).href
);

// Loader by extension for the client-bundled source graph.
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
      // A `*.module.css` import resolves to JS: a style-injecting module that
      // default-exports the class map. Vite/Vitest, however, owns the
      // `.module.css` extension and would run its own CSS-modules transform
      // over the harness's compiled JS (see compileModuleCss) — garbage-parsing
      // it and handing the app a bogus class map with none of the `<style
      // data-centraid-css-module>` injection. So the harness serves that JS
      // from a sibling `*.module.css.js` file (written in beforeAll) and
      // rewrites every relative `*.module.css` import specifier to match — the
      // `.js` tail is what keeps Vite from hijacking it. Behaviour matches the
      // shell bundle; only the scratch filename differs from the app source.
      .replace(
        /(?<quote>["'])(?<spec>(?:\.\.?\/)[^"']*\.module\.css)\k<quote>/gu,
        (_m, quote: string, spec: string) => `${quote}${spec}.js${quote}`
      )
  );
}

// Compile a `*.module.css` to the style-injecting, class-map-exporting JS
// module each shell's bundler produces for it. Mirrored minimally via the
// esbuild CLI — esbuild's JS API refuses to load under jsdom (see the note
// above transformInlineSource), but the CLI is a subprocess and is unaffected.
// The CLI emits the JS class-map module and the compiled CSS as two files into
// a temp outdir; we compose the module body from both.
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

/**
 * The one action this journey drives, declared the way the app declares it
 * (apps/agenda/pending-projection.ts) rather than re-derived: the harness must
 * project a cancel exactly as production does, or the chip it asserts on is a
 * chip nothing in the product would ever paint.
 */
const AGENDA_PENDING_PROJECTION = definePendingProjection({
  appId: "agenda",
  actions: {
    "cancel-event": ({ input }) =>
      pendingPatch("core.event", input.event_id, input),
  },
});

/** Populated, clone-safe rows shaped exactly like each app's local query. */
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

// Handler dirs are node-side modules dispatched by the gateway, never imported
// by the page — don't copy them into the boot scratch tree. `queries` stays
// out too: the boot entry is app-root.tsx (the query-free Root), so the graph
// never reaches a query module. Only the app-inline descriptor imports queries.
const NON_UI_DIRS = new Set(["queries", "actions", "automations"]);

/** All browser-source files of an app, as relative posix paths: `.js`/`.jsx`
 * and their TS counterparts `.ts`/`.tsx`, plus `*.module.css` (a CSS module is
 * imported by the page as JS — see compileModuleCss). */
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

/** Lets a test settle an app's un-awaited `refresh()` and its timers. Use this
 * only where the assertion needs a QUIET window (proving something did NOT
 * happen, or did not happen twice); for "X must appear", use waitFor. */
const settle = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 80);
  });

/**
 * Polls until `predicate` holds, then returns; throws naming `what` on timeout.
 *
 * Boot calls `refresh()` without awaiting and the apps paint through React's
 * async scheduler, so the DOM that a fixed sleep observes is a guess. Measured:
 * a shelf rendered from the local replica lands 4 event-loop turns (~4ms) after
 * its module import resolves locally — 20× inside the old fixed 80ms settle —
 * yet the loaded CI runner still queried a null node and failed the `check`
 * job. Dropping settle
 * to 1ms reproduces that exact failure locally, confirming a race rather than a
 * budget. So poll for the precondition instead of guessing at it.
 *
 * 4s ceiling: an order of magnitude above any observed individual wait and
 * comfortably inside the per-test budget, so a genuine regression still fails
 * with THIS message rather than vitest's opaque test timeout.
 */
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

// The single boot journey runs the app's real esbuild transform + jsdom render
// plus the remaining fixed settle windows; the slowest app lands ~1.5s locally
// now that the appear-assertions poll (waitFor) instead of sleeping.
// The affected-package gate runs every package at once; Photos has crossed 8s
// under that CPU contention even though it remains sub-3s alone. Keep a
// bounded 20s journey budget rather than turning scheduler load into a false
// failure or blanketing every importer with a package-wide timeout.
const BOOT_TEST_TIMEOUT_MS = 60_000;

// The inline chrome (Chrome.tsx) mounts its consent notice — a `.kit-banner`
// carrying `id="consentBanner"` — when the vault denies a read, and unmounts it
// when the vault grants again. (The inline tree mounts and unmounts rather
// than keeping a persistent element and toggling `hidden`, so "shown" is
// "present and not hidden".)
function consentBannerShown(): boolean {
  const banner = document.querySelector<HTMLElement>("#consentBanner");
  return banner !== null && banner.hidden === false;
}

/**
 * Mirror one source tree into the boot scratch dir the way the client bundles
 * it: TypeScript stripped, CSS modules compiled to their class-map JS,
 * everything else copied verbatim.
 */
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

    /** Fails with the app's own error, not a downstream assertion. */
    const expectNoErrors = (phase: string) => {
      expect(
        errors,
        `${app} threw while ${phase}: ${errors.map(String).join(" | ")}`
      ).toEqual([]);
    };

    beforeAll(() => {
      originalFetch = globalThis.fetch;
      // Inside the package, not os.tmpdir(): vite resolves the dynamic import
      // below and refuses to load a module outside the project root.
      // Each app gets its own scratch ROOT, laid out like `apps/` itself:
      // `<root>/<app>` beside `<root>/_shared`. An app importing a cross-app
      // module by its real specifier (`../_shared/…`, issue #599) then resolves
      // exactly as it does in a shell bundle — and because the shared copy lives
      // inside the app's own root, two app-boot files running in parallel never
      // write the same path.
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

      // Apps set an every-second TOTP/clock interval; left running it keeps the
      // worker alive past the suite.
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
          // The Schedule view renders the populated fixture independent of the
          // machine's current month, which keeps this browser journey
          // deterministic. The knob is the app's own `appDefaultView`.
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
        /**
         * Re-project the queued cancel through the PRODUCTION projection and
         * push the decorated row down the live read, exactly as the replica
         * composition would. The row keeps its place on the agenda: a held
         * cancellation is a designed state, not a disappearance.
         */
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
            // Agenda asks a SECOND question on this screen (#834): the
            // `day-context` projection, which answers a different shape from
            // the calendar read this fixture stands for. Handing it the
            // calendar payload would be a fiction no gateway performs — a
            // query answering another query's rows — so it gets its own
            // shaped answer here. It is empty on purpose: what this journey
            // proves is that the grid still draws when nothing decorates it,
            // and the decorations themselves are pinned by behaviour in
            // apps/agenda/day-context.test.ts.
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

        // The frame's contribution channel (Photos v4 §3), recorded rather
        // than rendered. The client hands every inline app one of these, so
        // the harness must too — an app that contributes to a bar that isn't
        // there is exactly the crash this journey exists to catch.
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

        /**
         * The terminal owner decision, delivered the way the real coordinator
         * delivers it: the overlay row is re-decorated AND the client's own
         * intent-invalidation derivation names which shapes went stale. Using
         * the production derivation is the point — a hand-rolled doorbell
         * would prove the harness can invalidate, not that the app is wired to
         * the signal it will actually receive.
         */
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
            // waitFor lands the write; settle then holds a QUIET window so the
            // exactly-one assertion below proves no second dispatch came out
            // of the re-render, rather than merely not having arrived yet.
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

            // Reconnect admission PARKS the exact queued intent: the event
            // stays canonical and the chip stays until a terminal decision.
            Object.defineProperty(window.navigator, "onLine", {
              configurable: true,
              value: true,
            });
            emitAgendaIntentState("parked");
            await settle();
            expect(
              document.querySelector(".kit-pending-chip")?.textContent
            ).toBe("cancel asked");

            // A denial is durable attention state: the row and its explanation
            // stay until the member edits, retries, or discards it.
            emitAgendaIntentState("denied");
            await waitFor(
              () =>
                document.querySelector(".kit-pending-chip")?.textContent ===
                "denied",
              "Agenda's denied chip to persist on the exact outcome"
            );
            expect(document.body.textContent).toContain(AGENDA_TITLE);
            // The doorbell is trailing-debounced, so this is polled rather
            // than read on the frame the chip settled on.
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

            // Photos is a ROUTE INSIDE THE FRAME (v4 §3): it draws no app bar
            // of its own, it contributes one. A mount that painted a grid but
            // contributed nothing would leave the frame showing a bare bar,
            // which is the failure this asserts against.
            await waitFor(
              () => contributed.appBar !== null,
              "Photos to contribute the frame's app bar"
            );
            expect(contributed.appBar?.title).toBe("Photos");
            expect(String(contributed.appBar?.count)).toContain("1");
            // …and it claims the compact band with its own five destinations,
            // so the frame renders exactly one band (§3.1).
            const claimed = (contributed.band ?? {}).destinations as
              | { id: string }[]
              | undefined;
            expect(claimed?.map((d) => d.id)).toEqual([
              "library",
              "albums",
              "people",
              "search",
            ]);

            // The app draws no chrome of its own inside the pane: no
            // hamburger, no in-pane search field in a header, no zoom pair.
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

          // A replacement live read can fail before it registers any upstream
          // dependency. The app must release that dead subscription and let a
          // later compatibility doorbell retry it.
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

        // Revoke: every app clears its board and the inline Chrome renders its
        // consent notice in its place. Required, not optional — a guarded check
        // would silently skip the only assertion proving the denied read landed.
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

        // Re-grant: the consent banner unmounts and the board renders again.
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
