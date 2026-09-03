import { readFileSync } from "node:fs";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import Button, { IconButton } from "./Button.js";

describe(Button, () => {
  it("emits the module classes for the variant", () => {
    const html = renderToStaticMarkup(
      <Button label="Save" variant="primary" />
    );
    expect(html).toContain('class="btn primary"');
    expect(html).toContain("Save");
    expect(html).toContain('type="button"');
  });

  it("supports the four canonical recipe variants", () => {
    expect(
      renderToStaticMarkup(<Button label="x" variant="secondary" />)
    ).toContain("secondary");
    expect(
      renderToStaticMarkup(<Button label="x" variant="quiet" />)
    ).toContain("quiet");
    expect(
      renderToStaticMarkup(<Button label="x" variant="destructive" />)
    ).toContain("destructive");
  });

  it("defaults to the secondary variant", () => {
    expect(renderToStaticMarkup(<Button label="x" />)).toContain("secondary");
  });

  it("supports the compact and chrome sizes", () => {
    expect(renderToStaticMarkup(<Button label="x" size="sm" />)).toContain(
      "btn sm"
    );
    expect(renderToStaticMarkup(<Button label="x" size="chrome" />)).toContain(
      "btn chrome secondary"
    );
  });

  it("keeps the filled ink on a commit control at titlebar scale", () => {
    expect(
      renderToStaticMarkup(
        <Button label="Save" size="chrome" variant="primary" />
      )
    ).toContain("btn chrome primary");

    const css = readFileSync(
      path.join(import.meta.dirname, "Button.module.css"),
      "utf8"
    );
    for (const size of ["chrome", "sm"]) {
      const rule = new RegExp(
        `\\n\\.${size}\\s*\\{(?<body>[^}]*)\\}`,
        "u"
      ).exec(css);
      expect(rule?.groups?.body, `.${size} rule not found`).toBeTypeOf(
        "string"
      );
      expect(rule!.groups!.body).not.toMatch(/(?:^|\s)background\s*:/u);
    }
    expect(css.indexOf("\n.chrome {")).toBeLessThan(
      css.indexOf("\n.primary {")
    );
    expect(css.indexOf("\n.sm {")).toBeLessThan(css.indexOf("\n.primary {"));
  });

  it("renders a leading icon svg when an icon is given", () => {
    const html = renderToStaticMarkup(<Button label="Run" icon="Bolt" />);
    expect(html).toContain("<svg");
  });

  it("reflects the disabled attribute", () => {
    expect(renderToStaticMarkup(<Button label="x" disabled />)).toContain(
      "disabled"
    );
  });

  it("appends a caller className", () => {
    expect(
      renderToStaticMarkup(<Button label="x" className="wide" />)
    ).toContain('class="btn secondary wide"');
  });

  it("prefers children over label", () => {
    expect(renderToStaticMarkup(<Button label="a">b</Button>)).toContain(">b<");
  });
});

describe(IconButton, () => {
  it("renders an icon-only square with an aria-label", () => {
    const html = renderToStaticMarkup(
      <IconButton icon="Bolt" ariaLabel="Run" />
    );
    expect(html).toContain('class="icon"');
    expect(html).toContain('aria-label="Run"');
    expect(html).toContain("<svg");
  });
});
