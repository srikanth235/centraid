// @vitest-environment jsdom
// THE PLACES MAP, as markup.
//
// `place-map.test.ts` proves the arithmetic; this proves the drawing renders
// what the arithmetic produced — pins, a graticule, a scale bar — and, more
// importantly, the two things about it that are easy to regress silently:
// every pin is a real focusable BUTTON with an accessible name, and there is
// no request to anywhere in the markup. A map that quietly grows an `<image>`
// pointing at a tile server is the failure this file exists to catch.
//
// A pure-view test in the technique People.test.tsx established:
// `renderToStaticMarkup` over the component's props, because `PlaceMap` holds
// no state of its own.
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
    // The label every place carries until a gazetteer is installed. It must
    // never reach the drawing.
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
    // The scale bar states a real distance, in units a person would say.
    expect(html).toMatch(/\d+ km|\d+ m</u);
    // North, said out loud rather than left to whoever reads graticules.
    expect(html).toContain("N ↑");
  });

  // THE LEGIBILITY REGRESSION THIS FILE EXISTS TO CATCH, alongside the egress
  // one below. The first version of this map printed degrees down both
  // margins; a member does not know where they were from "39.0°N", and the
  // moment a number like that reappears in the drawing the map has gone back
  // to being a chart.
  it("prints no coordinates anywhere — not on the margins, not under a pin", () => {
    const html = render();
    expect(html).not.toMatch(/°[NSEW]/u);
    expect(html).not.toContain("39.0021");
    expect(html).not.toContain("-120.1131");
  });

  it("draws each pin as a photograph taken there", () => {
    const html = render();
    // Same-origin blob route and inline data: URI — both what the app CSP
    // allows, neither a request to anybody else.
    expect(html).toContain('src="/centraid/_vault/blobs/c1?variant=thumb"');
    expect(html).toContain('src="data:image/png;base64,iVBOR"');
    // Decorative: the button around it already announces the place.
    expect(html).toMatch(/<img[^>]*alt=""/u);
  });

  it("names a place only when the name is one a person would recognise", () => {
    const html = render();
    expect(html).toContain(">Palo Alto<");
    // A coordinate-shaped label is not a name in EITHER channel: it is not
    // printed under the pin, and the pin announces itself the same way a
    // place with no name at all does.
    expect(html).not.toContain("39.0021");
    expect(html).toContain("an unnamed place, 2 photographs");
  });

  // The load-bearing one. Every pin has to be reachable and announceable, and
  // a `<circle role="button">` is how a map ends up unusable by keyboard.
  it("gives every pin a real button with an accessible name", () => {
    const html = render();
    const buttons = html.match(/<button[^>]*>/gu) ?? [];
    expect(buttons).toHaveLength(POINTS.length);
    expect(html).toContain('aria-label="Palo Alto, 4 photographs"');
    // A place with no name is still announced as something.
    expect(html).toContain("an unnamed place, 3 photographs");
    // Singular is not "1 photographs".
    expect(render({ points: [{ ...POINTS[0]!, count: 1 }] })).toContain(
      'Palo Alto, 1 photograph"'
    );
  });

  it("says how many places a merged pin stands for", () => {
    // Two rows in the ledger a few metres apart: one dot, and the label has
    // to admit that rather than under-reporting the ground it covers.
    const html = render({
      points: [
        { key: "a", lat: 39.0021, lng: -120.1131, count: 5, name: "Tahoma" },
        { key: "b", lat: 39.0022, lng: -120.1132, count: 2, name: "Also" },
      ],
    });
    expect(html).toContain("Tahoma and 1 more nearby, 7 photographs");
  });

  // The privacy claim, as a test rather than a comment: nothing in this
  // markup reaches off this device. The pins ARE images now, so the assertion
  // is not "no images" — it is that every source is same-origin or inline,
  // which is also exactly what the blueprint CSP admits.
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
    // A blank graticule under an empty shelf would be decoration pretending
    // to be information.
    expect(render({ points: [] })).toBe("");
  });
});
