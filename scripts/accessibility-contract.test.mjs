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
  const [toast, undo, confirm] = await Promise.all([
    source("packages/client/src/react/shell/toast.ts"),
    source("packages/client/src/react/shell/undoToast.ts"),
    source("packages/client/src/react/shell/confirm.ts"),
  ]);
  for (const announcer of [toast, undo]) {
    assert.match(announcer, /setAttribute\("role", "status"\)/u);
    assert.match(announcer, /setAttribute\("aria-live", "polite"\)/u);
  }
  assert.match(confirm, /createElement\("dialog"\)/u);
  assert.match(confirm, /aria-modal/u);
  assert.match(confirm, /e\.key === "Enter" && !opts\.danger/u);
});

test("blueprint dialogs, keyboard focus, and Photos focus restore stay wired", async () => {
  const [tallyModal, photos, tasksCss, tallyCss, lockerCss] = await Promise.all(
    [
      source("packages/blueprints/apps/tally/components/Shared.tsx"),
      source("packages/blueprints/apps/photos/lightbox.tsx"),
      source("packages/blueprints/apps/tasks/Chrome.module.css"),
      source("packages/blueprints/apps/tally/Chrome.module.css"),
      source("packages/blueprints/apps/locker/Chrome.module.css"),
    ]
  );
  assert.match(tallyModal, /<dialog/u);
  assert.match(tallyModal, /showModal/u);
  assert.match(tallyModal, /prior\?\.focus/u);
  assert.match(photos, /priorFocus\?\.focus/u);
  assert.match(photos, /button\[aria-label="Close"\]/u);
  for (const css of [tasksCss, tallyCss, lockerCss])
    assert.match(css, /:focus-visible/u);
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
    "apps/mobile/src/apps/docs/DocsHome.tsx",
    "apps/mobile/src/apps/agenda/AgendaHome.tsx",
    "apps/mobile/src/apps/photos/FaceReview.tsx",
    "apps/mobile/src/apps/assistant/Assistant.tsx",
  ];
  const sources = await Promise.all(files.map((file) => source(file)));
  for (const [index, file] of files.entries()) {
    assert.match(sources[index], /<FlatList/u, `${file} lost virtualization`);
  }
  const timeline = await source(
    "apps/mobile/src/apps/photos/PhotoTimeline.tsx"
  );
  assert.match(timeline, /cachePolicy="memory-disk"/u);
  assert.match(timeline, /recyclingKey=/u);
});
