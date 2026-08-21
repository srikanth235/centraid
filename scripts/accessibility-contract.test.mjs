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
  // #707 Phase 3 retired the shell's `toast.ts`/`undoToast.ts` (a message
  // that "appears somewhere else, covers something, and leaves before it can
  // be re-read") in favour of `StatusLine.tsx`: one persistent `<output>`
  // element that never leaves the DOM. `<output>` carries an IMPLICIT
  // `role="status"` (no `setAttribute` call to grep for), so the pin moves
  // from a runtime call to the element choice + the explicit `aria-live`.
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
  // #707 Phase 3: the floating `.kit-toast` stack is retired in favour of
  // ONE persistent status line, updated in place — this pins the same
  // role/aria-live contract the retired toast carried, on its replacement, so
  // the CONTRACT strength never lapses across the rename. #799 moved the line
  // off a `<kit-status-line>` custom element onto plain DOM built by
  // feedback.ts; the live region is now the persistent host itself rather
  // than a child the element re-created on every render.
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
  // Tally's shared `<dialog>` wrapper was the second subject here — the one
  // that proved a blueprint modal restores focus to its opener on close — and
  // Tasks and Tally owned two of the focus-ring sheets, until all three web
  // interfaces were removed pending a ground-up redesign. Nothing was softened
  // to a conditional read while they were gone: a check that skips itself when
  // its subject is missing passes for the wrong reason. Agenda, Notes and
  // Tasks paid their dialog and their focus ring back with their rebuilds
  // (#834); Tally still owes both.
  const [grantSheet, photos, dialogs, sheets] = await Promise.all([
    source("packages/blueprints/apps/_shared/GrantSheet.tsx"),
    source("packages/blueprints/apps/photos/lightbox.tsx"),
    Promise.all(
      [
        // Every destructive confirm and every modal editor these three draw is
        // a REAL `<dialog>` opened with `showModal()` — which is what makes
        // Escape, the top layer and the focus trap the platform's rather than
        // a div's imitation of them.
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
        "packages/blueprints/apps/people/Chrome.module.css",
        "packages/blueprints/apps/photos/Chrome.module.css",
        "packages/blueprints/apps/tasks/Chrome.module.css",
      ].map(async (file) => [file, await source(file)])
    ),
  ]);
  assert.match(grantSheet, /<dialog/u);
  assert.match(grantSheet, /showModal/u);
  assert.match(photos, /priorFocus\?\.focus/u);
  assert.match(photos, /button\[aria-label="Close"\]/u);
  for (const [file, text] of dialogs) {
    assert.match(text, /<dialog/u, `${file} lost its real dialog element`);
    assert.match(text, /showModal/u, `${file} opens a dialog non-modally`);
  }
  // The two that MOVE focus on open — Agenda into the title field, Tasks onto
  // the confirm — put it back on the opener themselves. Notes' overlays never
  // take focus off what opened them, so the platform's own modal restore is
  // the whole of their contract and there is nothing to pin.
  for (const [file, text] of dialogs.filter(
    ([name]) => !name.endsWith("Overlays.tsx")
  ))
    assert.match(text, /priorFocus/u, `${file} lost its focus restore`);
  for (const [file, css] of sheets)
    assert.match(css, /:focus-visible/u, `${file} lost its focus ring`);
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
  // Docs' native drive was the fourth surface here until it was removed
  // pending the v11 design handoff (apps/mobile/src/apps/docs/DocsHome.tsx is
  // now a wall). Agenda's native cover left the same way and came back with
  // its rebuild (#834), which also brought Notes' and Tasks' covers — every
  // one of them draws a list of unbounded length, which is what makes this
  // gate meaningful over them. Notes recycles through FlashList rather than
  // FlatList; both virtualize, and the assertion names which one the screen
  // is expected to keep so a silent swap to a plain `map` cannot pass.
  const files = [
    ["apps/mobile/src/apps/photos/FaceReview.tsx", /<FlatList/u],
    ["apps/mobile/src/apps/assistant/Assistant.tsx", /<FlatList/u],
    ["apps/mobile/src/apps/agenda/AgendaHome.tsx", /<FlatList/u],
    ["apps/mobile/src/apps/tasks/TasksHome.tsx", /<FlatList/u],
    ["apps/mobile/src/apps/notes/NotesHome.tsx", /<FlashList/u],
  ];
  const sources = await Promise.all(files.map(([file]) => source(file)));
  for (const [index, [file, expected]] of files.entries()) {
    assert.match(sources[index], expected, `${file} lost virtualization`);
  }
  // The decode/cache contract for a grid cell used to be inline props on the
  // timeline's <Image>, so a grep for the literal was the whole check. It now
  // lives in one module (#659), which a source grep cannot follow through a
  // spread — so the check is in two halves, and BOTH are needed:
  //
  //   1. the contract still names a bounded cache tier where it now lives, and
  //   2. every grid surface actually reaches it.
  //
  // Deleting the policy fails (1); dropping the spread at a call site fails (2).
  // The per-tier *values* (device-addressed bytes stay out of the disk cache,
  // gateway thumbnails keep it) are pinned by behaviour in
  // apps/mobile/src/kit/media/grid-image.test.ts, which can assert on the
  // returned object rather than on source text. (Moved under kit/media for the
  // Home springboard shared media path in #708.)
  const gridImage = await source("apps/mobile/src/kit/media/grid-image.ts");
  assert.match(
    gridImage,
    /cachePolicy: .*"memory-disk"/u,
    "grid cells lost their bounded image cache tier"
  );
  const grids = [
    // The timeline's image cell lives in PhotoTile since the Photos v4
    // rewrite — PhotoTimeline renders rows of PhotoTile, so the decode/cache
    // contract is asserted where the <Image> actually is.
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
    // FlashList recycles these views; without an explicit key a cell shows the
    // previous asset until the new one decodes.
    assert.match(
      gridSources[index],
      /recyclingKey=/u,
      `${file} lost its image recycling key`
    );
  }
});
