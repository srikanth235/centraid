import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const packageDir = path.resolve(import.meta.dirname, "..");
const appDir = path.join(packageDir, "apps");
// The system apps that currently DRAW something. Agenda, Notes and Tasks
// returned here with their rebuilt chromes (#834); Tally is still off the list
// because its interface is still removed whole pending a ground-up redesign —
// there is no chrome of its to hold to the shared shell. It returns here the
// same way, with a chrome that composes the shell.
const systemApps = [
  "agenda",
  "docs",
  "locker",
  "notes",
  "people",
  "photos",
  "tasks",
];

/** Every bundled app on disk, drawing or not. The bans below are about what an
 *  app must NEVER carry, so they are asked of the directory listing rather
 *  than the curated list — an app with no chrome yet can still be caught
 *  reintroducing a served entrypoint. */
const allApps = readdirSync(appDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
  .map((entry) => entry.name);

describe("shared blueprint CSS", () => {
  it("composes the canonical app shell in all system blueprints", () => {
    for (const app of systemApps) {
      const css = readFileSync(
        path.join(appDir, app, "Chrome.module.css"),
        "utf8"
      );
      expect(css, `${app}/Chrome.module.css`).toMatch(
        /composes: kit-app-shell(?: [^;]+)? from global;/u
      );
    }
  });

  it("keeps all system-app wall styling in the shared inline layers", () => {
    for (const app of allApps) {
      expect(
        existsSync(path.join(appDir, app, "wall.css")),
        `${app}/wall.css`
      ).toBe(false);
      expect(
        existsSync(path.join(appDir, app, "app.css")),
        `${app}/app.css`
      ).toBe(false);
    }
    expect(existsSync(path.join(packageDir, "kit", "wall.css"))).toBe(false);
    expect(existsSync(path.join(packageDir, "kit", "tokens.css"))).toBe(false);
  });

  it("does not reintroduce retired global chrome selectors", () => {
    // Scanned across each app's WHOLE source tree rather than one chrome file:
    // these three chromes are free to put styling wherever the design asks, so
    // a rule keyed to one file could quietly assert nothing. Reading the tree
    // keeps the ban on these global selectors live wherever the styling ends
    // up living.
    const retiredSelectors = {
      agenda: [".ag-shell", ".ag-side", ".ag-topbar"],
      notes: [".nt-side", ".nt-topbar", ".nt-hamburger"],
      tasks: [".tk-shell", ".tk-side", ".tk-topbar"],
    };

    for (const [app, selectors] of Object.entries(retiredSelectors)) {
      const source = appSource(path.join(appDir, app));
      for (const selector of selectors) {
        expect(source, `${app} source contains ${selector}`).not.toContain(
          selector
        );
      }
    }
  });

  it("does not ship served React, HTML or CSS entrypoints for inline system apps", () => {
    for (const app of allApps) {
      expect(
        existsSync(path.join(appDir, app, "app.tsx")),
        `${app}/app.tsx`
      ).toBe(false);
      // The main client compiles these apps; no bundled app carries a
      // document the gateway could serve (#799).
      expect(
        existsSync(path.join(appDir, app, "index.html")),
        `${app}/index.html`
      ).toBe(false);
    }
  });

  it("gives Docs ViewToggle .track one border — fieldset reset plus hairline, not two declarations", () => {
    const css = readFileSync(
      path.join(appDir, "docs", "components", "ViewToggle.module.css"),
      "utf8"
    );
    const track = cssRuleBody(css, ".track");
    const borders = propertyValues(track, "border");
    expect(
      borders,
      "css:S4656 forbids a second border on .track"
    ).toStrictEqual(["1px solid var(--line)"]);
    expect(propertyValues(track, "margin")).toStrictEqual(["0"]);
    expect(propertyValues(track, "min-inline-size")).toStrictEqual(["0"]);
  });
});

/** Every CSS and component source under one app, concatenated. */
function appSource(root: string): string {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const target = path.join(root, entry.name);
      if (entry.isDirectory()) return [appSource(target)];
      return /\.(?:css|ts|tsx)$/u.test(entry.name)
        ? [readFileSync(target, "utf8")]
        : [];
    })
    .join("\n");
}

function cssRuleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing ${selector} rule`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    const ch = css[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unclosed ${selector} rule`);
}

function propertyValues(block: string, property: string): string[] {
  const uncommented = block.replace(/\/\*[\s\S]*?\*\//gu, " ");
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const matches = uncommented.matchAll(
    new RegExp(`(?:^|[;\\s])${escaped}\\s*:\\s*([^;]+)`, "gu")
  );
  return [...matches].map((match) => match[1]!.trim());
}
