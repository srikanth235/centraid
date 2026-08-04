import { readFileSync } from "node:fs";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import Button, { IconButton } from "./Button.js";

// Vitest's `classNameStrategy: 'non-scoped'` returns the module-local names
// (`styles.btn` → 'btn'), so these assertions match the authored classes.

describe(Button, () => {
  it("emits the module classes for the variant", () => {
    const html = renderToStaticMarkup(
      <Button label="Save" variant="primary" />
    );
    expect(html).toContain('class="btn primary"');
    expect(html).toContain("Save");
    expect(html).toContain('type="button"');
  });

  it("supports the five recipe variants", () => {
    expect(
      renderToStaticMarkup(<Button label="x" variant="secondary" />)
    ).toContain("secondary");
    expect(
      renderToStaticMarkup(<Button label="x" variant="quiet" />)
    ).toContain("quiet");
    expect(
      renderToStaticMarkup(<Button label="x" variant="destructive" />)
    ).toContain("destructive");
    expect(
      renderToStaticMarkup(<Button label="x" variant="destructiveFilled" />)
    ).toContain("destructiveFilled");
  });

  it("defaults to the secondary variant", () => {
    expect(renderToStaticMarkup(<Button label="x" />)).toContain("secondary");
  });

  it("supports the compact and chrome sizes", () => {
    expect(renderToStaticMarkup(<Button label="x" size="sm" />)).toContain(
      "btn sm"
    );
    // `.btn` is the base at every size — chrome is a size modifier on top of
    // it, not a replacement, so the shared hover/press/focus rules apply.
    expect(renderToStaticMarkup(<Button label="x" size="chrome" />)).toContain(
      "btn chrome secondary"
    );
  });

  it("keeps the filled ink on a commit control at titlebar scale", () => {
    // The bug this pins: `size` and `variant` are independent props, so the
    // type system cannot catch a size class that paints. A chrome-size
    // primary that renders unfilled is a commit control the eye cannot find
    // (issue #708, invariant 3 — the shell owns no colour, commit is filled
    // ink), and it fails silently in exactly the place it matters most.
    expect(
      renderToStaticMarkup(
        <Button label="Save" size="chrome" variant="primary" />
      )
    ).toContain("btn chrome primary");

    const css = readFileSync(
      path.join(import.meta.dirname, "Button.module.css"),
      "utf8"
    );
    // Sizes carry geometry only. A `background` in one of them wins over the
    // variant declared after it, whatever the markup says.
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
    // …and the colour they must not fight is declared after them.
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
