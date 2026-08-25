// @vitest-environment jsdom
// Places map markup. Silent-regression traps: every pin is a focusable
// button with an accessible name, and there is no request to anywhere.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createElement } from "react";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const app = (rel: string): string =>
  pathToFileURL(path.resolve(import.meta.dirname, "..", rel)).href;

interface Point {
  key: string;
  lat: number;
  lng: number;
  count: number;
  name: string | null;
  thumb?: string | null;
}

interface PlaceMapProps {
  points: readonly Point[];
  width: number;
  height?: number;
  activeKey?: string | null;
  onOpen: (key: string) => void;
}

const { PlaceMap } = (await import(app("components/PlaceMap.tsx"))) as {
  PlaceMap: ComponentType<PlaceMapProps>;
};

const POINTS: Point[] = [
  {
    key: "home",
    lat: 37.4419,
    lng: -122.143,
    count: 4,
    name: "Palo Alto",
    thumb: "/centraid/_vault/blobs/c1?variant=thumb",
  },
  { key: "city", lat: 37.7955, lng: -122.3937, count: 3, name: null },
  {
    key: "ridge",
    lat: 39.0021,
    lng: -120.1131,
    count: 2,
    // Must never reach the drawing.
    name: "39.0021, -120.1131",
    thumb: "data:image/png;base64,iVBOR",
  },
];

const render = (props: Partial<PlaceMapProps> = {}): string =>
  renderToStaticMarkup(
    createElement(PlaceMap, {
      points: POINTS,
      width: 600,
      onOpen: () => undefined,
      ...props,
    })
  );

describe("the Places map", () => {
  it("draws a grid and a scale bar", () => {
    const html = render();
    expect(html).toContain("<line");
    expect(html).toMatch(/\d+ km|\d+ m</u);
    expect(html).toContain("N ↑");
  });

  it("says what a pin stands for at the scale it drew", () => {
    expect(render()).toContain(">Countries<");
    expect(
      render({
        points: [
          { key: "n", lat: 39.0018, lng: -120, count: 2, name: "North" },
          { key: "s", lat: 39, lng: -120, count: 1, name: "South" },
        ],
      })
    ).toContain(">Spots<");
  });

  it("prints no coordinates anywhere — not on the margins, not under a pin", () => {
    const html = render();
    expect(html).not.toMatch(/°[NSEW]/u);
    expect(html).not.toContain("39.0021");
    expect(html).not.toContain("-120.1131");
  });

  it("draws each pin as a photograph taken there", () => {
    const html = render();
    expect(html).toContain('src="/centraid/_vault/blobs/c1?variant=thumb"');
    expect(html).toContain('src="data:image/png;base64,iVBOR"');
    expect(html).toMatch(/<img[^>]*alt=""/u);
  });

  it("names a place only when the name is one a person would recognise", () => {
    const html = render();
    expect(html).toContain(">Palo Alto<");
    expect(html).not.toContain("39.0021");
    expect(html).toContain("an unnamed place, 2 photographs");
  });

  it("gives every pin a real button with an accessible name", () => {
    const html = render();
    const buttons = html.match(/<button[^>]*>/gu) ?? [];
    expect(buttons).toHaveLength(POINTS.length);
    expect(html).toContain('aria-label="Palo Alto, 4 photographs"');
    expect(html).toContain("an unnamed place, 3 photographs");
    expect(render({ points: [{ ...POINTS[0]!, count: 1 }] })).toContain(
      'Palo Alto, 1 photograph"'
    );
  });

  it("says how many places a merged pin stands for", () => {
    const html = render({
      points: [
        { key: "a", lat: 39.0021, lng: -120.1131, count: 5, name: "Tahoma" },
        { key: "b", lat: 39.0022, lng: -120.1132, count: 2, name: "Also" },
      ],
    });
    expect(html).toContain("Tahoma and 1 more nearby, 7 photographs");
  });

  it("fetches nothing from anywhere else — there is no basemap", () => {
    const html = render();
    expect(html).not.toMatch(/https?:\/\//u);
    expect(html).not.toMatch(/url\(/u);
    for (const src of html.match(/src="[^"]*"/gu) ?? []) {
      expect(src).toMatch(/src="(?:\/|data:)/u);
    }
  });

  it("fills exactly one pin — the place being read", () => {
    const html = render({ activeKey: "home" });
    expect(html.match(/aria-current="true"/gu) ?? []).toHaveLength(1);
  });

  it("is not a map at all when nothing carries a place", () => {
    expect(render({ points: [] })).toBe("");
  });
});
