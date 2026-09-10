// The route-title table plus a call-site scan (#1015, audit docs/findings#1).
// The scan is the part that stays true: thirteen heads each typed their return
// target by hand and all thirteen typed "All", so the label and the chevron
// disagreed on every pushed screen in the app. A name a screen types about
// ANOTHER screen is the defect; the test forbids typing one.

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { STAGE_PROPS } from "@centraid/blueprints/apps/docs/document-copy";

import { DOCS_ROOT_TITLE, docsRouteTitle } from "./docs-places";

const DOCS_DIR = import.meta.dirname;
const NOTES_DIR = path.resolve(import.meta.dirname, "../notes");
const TASKS_DIR = path.resolve(import.meta.dirname, "../tasks");

/** The header components DEFINE the prop — they are what a call site must not
 *  feed a literal. */
const HEADERS = new Set(["DocsShelfHeader.tsx", "TasksPlaceHeader.tsx"]);

function sources(root: string, acc: string[] = []): string[] {
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, item.name);
    if (item.isDirectory()) sources(full, acc);
    else if (
      /\.tsx?$/u.test(item.name) &&
      !/\.test\.tsx?$/u.test(item.name) &&
      !HEADERS.has(item.name)
    )
      acc.push(full);
  }
  return acc;
}

describe("docs route titles", () => {
  it("names each pushed route with the head that route draws", () => {
    expect(docsRouteTitle({ name: "DocsTrash" })).toBe("Trash");
    expect(docsRouteTitle({ name: "DocsStorage" })).toBe("Storage");
    expect(docsRouteTitle({ name: "DocsRecent" })).toBe("Recently changed");
    expect(docsRouteTitle({ name: "DocsCapabilities" })).toBe(
      "What Docs may read"
    );
    expect(docsRouteTitle({ name: "DocumentProperties" })).toBe(
      STAGE_PROPS.head
    );
  });

  it("reads the name a param carries, and degrades to the noun without it", () => {
    expect(
      docsRouteTitle({ name: "DocsFolder", params: { folderName: "Taxes" } })
    ).toBe("Taxes");
    expect(docsRouteTitle({ name: "DocsFolder", params: {} })).toBe("Folder");
    expect(
      docsRouteTitle({ name: "DocumentRead", params: { title: "Lease.pdf" } })
    ).toBe("Lease.pdf");
    expect(docsRouteTitle({ name: "DocumentRead", params: {} })).toBe(
      "Document"
    );
    // A blank title is not a name: it would render an empty back label.
    expect(
      docsRouteTitle({ name: "DocumentRead", params: { title: "  " } })
    ).toBe("Document");
  });

  it("titles the home by the shelf it is showing, not by the route", () => {
    expect(
      docsRouteTitle({ name: "DocsHome", params: { destination: "due" } })
    ).toBe("Coming due");
    expect(
      docsRouteTitle({ name: "DocsHome", params: { destination: "shared" } })
    ).toBe("Shared with you");
    expect(docsRouteTitle({ name: "DocsHome" })).toBe(
      docsRouteTitle({ name: "DocsHome", params: { destination: "all" } })
    );
  });

  it("falls back to the app's own name off the stack", () => {
    expect(docsRouteTitle(undefined)).toBe(DOCS_ROOT_TITLE);
    expect(docsRouteTitle({ name: "NotARoute" })).toBe(DOCS_ROOT_TITLE);
  });
});

describe("back-target call sites", () => {
  it.each([
    ["docs", DOCS_DIR],
    ["notes", NOTES_DIR],
    ["tasks", TASKS_DIR],
  ])("never types a return target as a literal in %s", (_app, dir) => {
    const offenders = sources(dir).filter((file) =>
      /backTo=["'`]/u.test(fs.readFileSync(file, "utf8"))
    );
    expect(offenders).toStrictEqual([]);
  });
});
