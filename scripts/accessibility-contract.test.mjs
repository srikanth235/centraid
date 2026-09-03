import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

async function source(relative) {
  return readFile(path.join(root, relative), "utf8");
}

async function filesUnder(relative) {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const next = path.join(relative, entry.name);
      return entry.isDirectory() ? filesUnder(next) : [next];
    })
  );
  return nested.flat();
}

test("shell announcements and destructive confirms keep their accessibility contract", async () => {
  const [statusLine, confirm] = await Promise.all([
    source("packages/client/src/react/shell/StatusLine.tsx"),
    source("packages/client/src/react/shell/confirm.ts"),
  ]);
  assert.match(statusLine, /<output\b/u);
  assert.match(statusLine, /aria-live="polite"/u);
  assert.match(confirm, /createElement\("dialog"\)/u);
  assert.match(confirm, /aria-modal/u);
  assert.match(confirm, /e\.key === "Enter" && !opts\.danger/u);
});

test("the element layer's status line (toast's replacement) keeps its accessibility contract", async () => {
  const statusLine = await source("packages/design/src/elements/feedback.ts");
  assert.match(statusLine, /setAttribute\("role", "status"\)/u);
  assert.match(statusLine, /setAttribute\("aria-live", "polite"\)/u);
  assert.doesNotMatch(
    await source("packages/design/src/elements/index.ts"),
    /kit-toast/u,
    "the element barrel still names the retired kit-toast component"
  );
});

test("blueprint dialogs, keyboard focus, and Photos focus restore stay wired", async () => {
  const [
    grantSheet,
    kitModal,
    modalKit,
    peopleChrome,
    photos,
    dialogs,
    sheets,
  ] = await Promise.all([
    source("packages/blueprints/apps/_shared/GrantSheet.tsx"),
    source("packages/blueprints/apps/_shared/KitModal.tsx"),
    source("packages/blueprints/apps/_shared/modal-kit.ts"),
    source("packages/blueprints/apps/people/Chrome.tsx"),
    source("packages/blueprints/apps/photos/lightbox.tsx"),
    Promise.all(
      [
        "packages/blueprints/apps/agenda/components/EventEditor.tsx",
        "packages/blueprints/apps/notes/components/Overlays.tsx",
        "packages/blueprints/apps/tasks/components/Confirm.tsx",
      ].map(async (file) => [file, await source(file)])
    ),
    Promise.all(
      [
        "packages/blueprints/apps/agenda/Chrome.module.css",
        "packages/blueprints/apps/locker/Chrome.module.css",
        "packages/blueprints/apps/notes/Chrome.module.css",
        "packages/blueprints/apps/photos/Chrome.module.css",
        "packages/blueprints/apps/tasks/Chrome.module.css",
        "packages/blueprints/apps/_shared/ShelfStrip.module.css",
      ].map(async (file) => [file, await source(file)])
    ),
  ]);
  assert.match(grantSheet, /<KitModal/u);
  assert.match(kitModal, /<dialog/u);
  assert.match(kitModal, /openOnTopLayer/u);
  assert.match(modalKit, /dialog\.showModal/u);
  assert.match(modalKit, /opener\.focus\(\)/u);
  assert.match(photos, /priorFocus\?\.focus/u);
  assert.match(photos, /button\[aria-label="Close"\]/u);
  for (const [file, text] of dialogs)
    assert.match(text, /<KitModal/u, `${file} left the shared modal kit`);
  for (const [file, css] of sheets)
    assert.match(css, /:focus-visible/u, `${file} lost its focus ring`);
  assert.match(
    peopleChrome,
    /<ShelfStrip/u,
    "people/Chrome.tsx left the shared strip without bringing back a focus ring"
  );
});

test("every mobile Pressable screen names an accessibility contract and keeps Dynamic Type enabled", async () => {
  const files = (await filesUnder("apps/mobile/src")).filter((file) =>
    file.endsWith(".tsx")
  );
  const sources = await Promise.all(files.map((file) => source(file)));
  for (const [index, file] of files.entries()) {
    const text = sources[index];
    assert.doesNotMatch(
      text,
      /allowFontScaling=\{false\}/u,
      `${file} disables Dynamic Type`
    );
    if (text.includes("<Pressable")) {
      assert.match(
        text,
        /accessibility(?:Label|Role|State)=/u,
        `${file} has Pressable controls but no accessibility annotation`
      );
    }
  }
});

test("long native surfaces remain virtualized and photo cells keep bounded image caches", async () => {
  const files = [
    ["apps/mobile/src/apps/photos/FaceReview.tsx", /<FlatList/u],
    ["apps/mobile/src/apps/assistant/Assistant.tsx", /<FlatList/u],
    ["apps/mobile/src/apps/agenda/AgendaHome.tsx", /<FlatList/u],
    ["apps/mobile/src/apps/locker/LockerItemsView.tsx", /<FlatList/u],
    ["apps/mobile/src/apps/locker/LockerAccessView.tsx", /<FlatList/u],
    ["apps/mobile/src/apps/locker/LockerSearchView.tsx", /<FlatList/u],
    ["apps/mobile/src/apps/locker/LockerTrashScreen.tsx", /<FlatList/u],
    ["apps/mobile/src/apps/locker/LockerReviewView.tsx", /<FlatList/u],
    ["apps/mobile/src/apps/tasks/TasksRows.tsx", /<FlatList/u],
    ["apps/mobile/src/apps/tasks/TasksProject.tsx", /<FlatList/u],
    ["apps/mobile/src/apps/tasks/TasksProjects.tsx", /<FlatList/u],
    ["apps/mobile/src/apps/tasks/TasksSearch.tsx", /<FlatList/u],
    ["apps/mobile/src/apps/tasks/TasksCatchUp.tsx", /<FlatList/u],
    ["apps/mobile/src/apps/tasks/TasksReminders.tsx", /<FlatList/u],
    ["apps/mobile/src/apps/tasks/TaskDetail.tsx", /<FlatList/u],
    ["apps/mobile/src/apps/notes/NotesHome.tsx", /<FlashList/u],
  ];
  const sources = await Promise.all(files.map(([file]) => source(file)));
  for (const [index, [file, expected]] of files.entries()) {
    assert.match(sources[index], expected, `${file} lost virtualization`);
  }
  const gridImage = await source("apps/mobile/src/kit/media/grid-image.ts");
  assert.match(
    gridImage,
    /cachePolicy: .*"memory-disk"/u,
    "grid cells lost their bounded image cache tier"
  );
  const grids = [
    "apps/mobile/src/apps/photos/PhotoTile.tsx",
    "apps/mobile/src/apps/photos/PhotosLibrary.tsx",
  ];
  const gridSources = await Promise.all(grids.map((file) => source(file)));
  for (const [index, file] of grids.entries()) {
    assert.match(
      gridSources[index],
      /\{\.\.\.gridImageProps\(/u,
      `${file} renders image cells without the shared decode/cache contract`
    );
    assert.match(
      gridSources[index],
      /recyclingKey=/u,
      `${file} lost its image recycling key`
    );
  }
});

test("long browser surfaces stay windowed and keep their focus and set-size contract", async () => {
  const [chrome, windowed, rowGrammar] = await Promise.all([
    source("packages/blueprints/apps/_shared/AppChrome.tsx"),
    source("packages/blueprints/apps/locker/components/Windowed.tsx"),
    source("packages/blueprints/apps/locker/components/Rows.tsx"),
  ]);
  assert.match(
    chrome,
    /data-scroll-host=""/u,
    "the shared chrome no longer declares its scroll pane"
  );
  assert.match(windowed, /useVirtualWindow\(/u);
  assert.match(windowed, /VirtualSpacer/u);
  assert.match(
    rowGrammar,
    /virtualItemAria\(/u,
    "Locker's row no longer states the true size of its set"
  );
  const lists = [
    "packages/blueprints/apps/locker/components/List.tsx",
    "packages/blueprints/apps/locker/components/Search.tsx",
    "packages/blueprints/apps/locker/components/Review.tsx",
    "packages/blueprints/apps/locker/components/Trash.tsx",
    "packages/blueprints/apps/locker/components/Access.tsx",
  ];
  const listSources = await Promise.all(lists.map((file) => source(file)));
  for (const [index, file] of lists.entries()) {
    assert.match(
      listSources[index],
      /<WindowedRows\b/u,
      `${file} draws its rows unwindowed`
    );
  }
});
