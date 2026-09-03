// oxlint-disable-next-line typescript-eslint/ban-ts-comment -- browser-DOM fixture is intentionally checked by jsdom, while the blueprint TS config excludes DOM globals (#406)
// @ts-nocheck
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// oxlint-disable-next-line vitest/prefer-import-in-mock -- the typed `import()` form pulls `apps/` into this program's `rootDir: ./src` and fails typecheck (TS6059); apps are typechecked by tsconfig.apps.json.
vi.mock("../apps/photos/components/Import.js", () => ({
  tallyDedupes: () => ({ deduped: 0, restored: 0 }),
}));

const importFixture = (relativePath: string) => import(relativePath);

const live = new Map<string, Set<unknown>>();
let nativeAdd: typeof window.addEventListener;
let nativeRemove: typeof window.removeEventListener;

function liveCount(): number {
  let total = 0;
  for (const set of live.values()) total += set.size;
  return total;
}

describe("Photos leaves nothing running when it closes", () => {
  beforeEach(() => {
    vi.resetModules();
    live.clear();
    document.body.innerHTML = `
      <button id="emptyUpload" type="button"></button>
      <input id="fileInput" type="file" />
      <div id="dropOverlay" hidden></div>
    `;
    nativeAdd = window.addEventListener.bind(window);
    nativeRemove = window.removeEventListener.bind(window);
    window.addEventListener = (type, fn, options) => {
      const set = live.get(type) ?? new Set();
      set.add(fn);
      live.set(type, set);
      nativeAdd(type, fn, options);
    };
    window.removeEventListener = (type, fn, options) => {
      live.get(type)?.delete(fn);
      nativeRemove(type, fn, options);
    };
  });

  afterEach(() => {
    window.addEventListener = nativeAdd;
    window.removeEventListener = nativeRemove;
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  test("the import doors unwind every window listener they installed", async () => {
    const { wireUpload } = await importFixture("../apps/photos/upload.js");
    const before = liveCount();

    // A leak is a RESIDUE PER CYCLE.
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const stop = wireUpload({
        uploadFiles: async () => undefined,
        isAlbumSelected: () => false,
        openPicker: () => undefined,
      });
      expect(liveCount()).toBe(before + 5);
      stop();
      expect(liveCount()).toBe(before);
    }
  });

  test("the media lookahead holds two observers at most, and none after a close", async () => {
    const disconnected: object[] = [];
    const observing = new Set<object>();
    const counting = () =>
      function CountingObserver(this: object) {
        this.observe = () => observing.add(this);
        this.unobserve = () => undefined;
        this.disconnect = () => {
          observing.delete(this);
          disconnected.push(this);
        };
      };
    vi.stubGlobal("IntersectionObserver", counting());
    vi.stubGlobal("MutationObserver", counting());

    const { observeNextScreen, stopMediaObservation } = await importFixture(
      "../apps/photos/media-observer.js"
    );

    const pane = document.createElement("div");
    pane.dataset.mediaRoot = "";
    document.body.append(pane);
    // Two whatever the tile count: the pane's, and one document watcher.
    for (let index = 0; index < 40; index += 1) {
      const img = document.createElement("img");
      pane.append(img);
      observeNextScreen(img, `data:image/png;base64,AA==#${index}`);
    }
    expect(observing.size).toBe(2);

    stopMediaObservation();
    expect(observing.size).toBe(0);
    expect(disconnected).toHaveLength(2);
  });

  test("Save-Data stages the bytes instead of pulling all of them at once", async () => {
    const created: Array<{ rootMargin: string }> = [];
    const inert = function inert(this: object) {
      this.observe = () => undefined;
      this.unobserve = () => undefined;
      this.disconnect = () => undefined;
    };
    vi.stubGlobal(
      "IntersectionObserver",
      function RecordingObserver(
        this: object,
        _callback: unknown,
        options: { rootMargin: string }
      ) {
        created.push(options);
        this.observe = () => undefined;
        this.unobserve = () => undefined;
        this.disconnect = () => undefined;
      }
    );
    vi.stubGlobal("MutationObserver", inert);
    vi.stubGlobal("navigator", { connection: { saveData: true } });

    const { observeNextScreen } = await importFixture(
      "../apps/photos/media-observer.js"
    );
    const img = document.createElement("img");
    document.body.append(img);
    observeNextScreen(img, "data:image/png;base64,AA==");

    expect(img.getAttribute("src")).toBeNull();
    expect(img.dataset.prefetchSrc).toBe("data:image/png;base64,AA==");
    expect(created[0]?.rootMargin).toBe("0px");
  });
});
// @vitest-environment jsdom
