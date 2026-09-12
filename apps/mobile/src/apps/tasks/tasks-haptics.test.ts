// S15 (#1015 Wave 3): three moments, and nowhere else. The audit found
// `expo-haptics` reached for directly in six files, each choosing its own
// feedback for its own reason, so haptics stopped meaning anything. These
// four app trees adopt the kit's channel at exactly the moments the channel
// names, and import the library nowhere.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const TREES = ["agenda", "docs", "notes", "tasks"];
const APPS = path.join(__dirname, "..");

function sourcesOf(tree: string): { file: string; text: string }[] {
  const dir = path.join(APPS, tree);
  return readdirSync(dir)
    .filter(
      (file) =>
        (file.endsWith(".ts") || file.endsWith(".tsx")) &&
        !file.includes(".test.")
    )
    .map((file) => ({
      file: `${tree}/${file}`,
      text: readFileSync(path.join(dir, file), "utf8"),
    }));
}

describe("the four APPS-A trees keep to the one moment channel", () => {
  it("SABOTAGE: no app tree imports expo-haptics", () => {
    for (const tree of TREES)
      for (const { file, text } of sourcesOf(tree))
        expect({ file, direct: text.includes("expo-haptics") }).toStrictEqual({
          file,
          direct: false,
        });
  });

  // The band moving to another place is the selection moment, and the shell's
  // own band gives the same tick — a member feels one product, not five.
  it.each(TREES)("%s's band ticks when it moves", (tree) => {
    const band = sourcesOf(tree).find(({ file }) => file.endsWith("Band.tsx"))!;
    expect(band.text).toContain('from "../../kit/haptics"');
    expect(band.text).toContain("hapticSelect();");
  });

  // Exactly one long-press in these four apps changes a MODE: picking a task
  // up puts the whole board into filing. Docs' long-press opens a menu, which
  // is a presentation, not a mode — so it stays silent.
  it("fires the mode buzz only where a mode actually changes", () => {
    const rows = sourcesOf("tasks").find(({ file }) =>
      file.endsWith("TaskRow.tsx")
    )!;
    expect(rows.text).toContain("hapticMode();");
    const docRow = sourcesOf("docs").find(({ file }) =>
      file.endsWith("DocRow.tsx")
    )!;
    expect(docRow.text).not.toContain("hapticMode");
  });

  // `hapticLanded` belongs to the confirm, not to the app: every destructive
  // write in these trees goes through `useConfirmDestructive`, which fires it
  // when the write is issued rather than when the sheet opened.
  it("leaves the landed buzz to the kit's confirm", () => {
    for (const tree of TREES)
      for (const { file, text } of sourcesOf(tree))
        expect({ file, own: text.includes("hapticLanded") }).toStrictEqual({
          file,
          own: false,
        });
    // The confirm fires it when the write RESOLVES, not on the press — so the
    // claim is that the call lives there, not what its call form is.
    expect(
      readFileSync(
        path.join(APPS, "..", "kit", "components", "ConfirmSheet.tsx"),
        "utf8"
      )
    ).toContain("hapticLanded");
  });
});
