// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import type { Project } from "../types.ts";
import { ProjectsRoute } from "./Screens.tsx";

function project(id: string, area: string): Project {
  return { project_id: id, name: id, area, sort_order: 0 };
}

describe(ProjectsRoute, () => {
  test("groups by area in lexical order, not insertion order", () => {
    const html = renderToStaticMarkup(
      createElement(ProjectsRoute, {
        projects: [project("zoo", "Later"), project("alpha", "Earlier")],
        counts: { zoo: 1, alpha: 2 },
        projectHue: () => null,
        onOpen: () => undefined,
        onNewProject: () => undefined,
      })
    );
    expect(html.indexOf("Earlier")).toBeGreaterThan(-1);
    expect(html.indexOf("Later")).toBeGreaterThan(-1);
    expect(html.indexOf("Earlier")).toBeLessThan(html.indexOf("Later"));
  });
});
