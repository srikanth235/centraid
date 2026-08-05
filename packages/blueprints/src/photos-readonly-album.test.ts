// @vitest-environment jsdom
// eslint-disable-next-line typescript-eslint/ban-ts-comment -- issue #711: browser-DOM fixture is intentionally checked by jsdom, while the blueprint TS config excludes DOM globals (see photos-media.test.ts's own note)
// @ts-nocheck
// A READ-ONLY ALBUM (v4 handoff §14 `Read-only`, README.md:233, proto 4789):
// "Writing controls are the disabled outline WITH THE REASON, and never fire."
//
// Three things that were false about that surface, one test group each:
//
//   1. THE ALBUM BAR disabled Rename and Delete and said nothing at all. A
//      refusal the member cannot read is a bug, not a state — the reason is
//      stated INLINE under the bar (never a tooltip alone).
//   2. THE TILE'S OWN `Remove` was gated by `inAlbum` alone, so a read-only
//      album refused two writes in its bar and offered a third, working one on
//      every tile below it. It is now disabled AND inert.
//   3. THE APP BAR'S PRIMARY becomes `Download` rather than vanishing
//      (proto 4800-4801) — the copy for it lives in view-copy.ts.
//
// `outcomes.ts` is mocked by string specifier — see photos-faces.test.ts's own
// note on why.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// oxlint-disable-next-line vitest/prefer-import-in-mock -- see header
vi.mock("../apps/photos/outcomes.ts", () => ({
  act: (action: string, input: unknown) => {
    writes.push({ action, input });
    return Promise.resolve({ status: "executed" });
  },
  narrate: () => true,
  notice: () => {},
}));

let writes: Array<{ action: string; input: unknown }> = [];

const load = (relativePath: string) => import(relativePath);
const ALBUM_BAR = "../apps/photos/components/AlbumBar.tsx";
const TIMELINE = "../apps/photos/components/Timeline.tsx";
const VIEW_COPY = "../apps/photos/view-copy.ts";

const REASON = "You can view Tom’s library but not add to it.";

const ASSETS = [
  {
    asset_id: "a1",
    scope_id: "tom",
    title: "On the sea wall",
    taken_at: "2026-07-30T17:42:00.000Z",
    width: 1200,
    height: 800,
  },
];

const NOOP = () => {};
const NOOP_ASYNC = async () => {};

function barProps(overrides = {}) {
  return {
    title: "Cornwall 2024",
    renaming: false,
    canWrite: true,
    onBack: NOOP,
    onStartRename: NOOP,
    onRenameSubmit: NOOP,
    onRenameCancel: NOOP,
    onDelete: NOOP,
    ...overrides,
  };
}

function timelineProps(overrides = {}) {
  return {
    assets: ASSETS,
    containerWidth: 900,
    targetHeight: 200,
    rung: 2,
    phone: false,
    memories: null,
    inAlbum: true,
    albumId: "alb-1",
    canWriteAlbum: true,
    isTrash: false,
    refresh: NOOP_ASYNC,
    selectMode: false,
    selectedIds: new Set(),
    onEnterSelectMode: NOOP,
    onToggleSelect: NOOP,
    onOpen: NOOP,
    vaultOf: () => undefined,
    truncated: false,
    libraryWindow: 1,
    selectedAlbum: "alb-1",
    searchQuery: "",
    onShowMore: NOOP_ASYNC,
    ...overrides,
  };
}

async function renderBar(overrides = {}): Promise<string> {
  const { AlbumBar } = await load(ALBUM_BAR);
  return renderToStaticMarkup(createElement(AlbumBar, barProps(overrides)));
}

/** The `Remove` control on the one tile, live in the DOM. */
async function mountTimeline(overrides = {}) {
  const { TimelineBody } = await load(TIMELINE);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(TimelineBody, timelineProps(overrides)));
  });
  const remove = [...container.querySelectorAll("button")].find((b) =>
    b.textContent.trim().startsWith("Remove")
  );
  return { container, remove };
}

describe("the album bar says WHY it refuses (§14, README:233)", () => {
  it("states the reason inline when the album is read-only", async () => {
    const html = await renderBar({ canWrite: false, reason: REASON });
    expect(html).toContain(REASON);
    // Both writes are the disabled outline.
    expect(html.match(/<button[^>]*disabled[^>]*>/gu) ?? []).toHaveLength(2);
  });

  it("says nothing at all while the album is writable", async () => {
    const html = await renderBar();
    expect(html).not.toContain(REASON);
    expect(html).not.toMatch(/<button[^>]*disabled/u);
  });

  it("never hides the reason in a tooltip alone", async () => {
    const html = await renderBar({ canWrite: false, reason: REASON });
    // The reason is rendered as TEXT, not only as a `title` attribute.
    expect(html).toContain(`>${REASON}</p>`);
  });
});

describe("a read-only album offers no write on the tile either", () => {
  // NO `vi.resetModules()` here: re-evaluating the shared kit re-registers its
  // custom elements, which the registry refuses (see photos-tile.test.ts on the
  // same module-eval side effect).
  beforeEach(() => {
    writes = [];
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("disables Remove and carries the reason on its name", async () => {
    const { remove } = await mountTimeline({
      canWriteAlbum: false,
      albumReason: REASON,
    });
    expect(remove).toBeTruthy();
    expect(remove.disabled).toBe(true);
    expect(remove.getAttribute("aria-label")).toContain(REASON);
  });

  it("fires nothing — the handler itself is inert, not merely disabled", async () => {
    const { remove } = await mountTimeline({
      canWriteAlbum: false,
      albumReason: REASON,
    });
    await act(async () => {
      remove.click();
      remove.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(writes).toStrictEqual([]);
  });

  // The counter-proof: the same click on a WRITABLE album does reach the
  // vault, so the assertion above is not passing because nothing is wired.
  it("still removes from a writable album", async () => {
    const { remove } = await mountTimeline({ canWriteAlbum: true });
    expect(remove.disabled).toBe(false);
    await act(async () => {
      remove.click();
    });
    expect(writes).toStrictEqual([
      {
        action: "remove-from-album",
        input: { album_id: "alb-1", asset_id: "a1" },
      },
    ]);
  });
});

describe("the read-only surface keeps a primary (proto 4800-4801)", () => {
  it("names the scope by its label, never by a storage noun", async () => {
    const { DOWNLOAD_PRIMARY, downloadPrimaryTitle } = await load(VIEW_COPY);
    expect(DOWNLOAD_PRIMARY).toBe("Download");
    expect(downloadPrimaryTitle("Tom’s library")).toBe(
      "You may download from Tom’s library"
    );
  });
});
