import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import Logo from "./Logo.js";

describe(Logo, () => {
  it("draws the orbit mark at the given size", () => {
    const html = renderToStaticMarkup(<Logo size={48} />);
    expect(html).toContain('viewBox="0 0 240 240"');
    expect(html).toContain('width="48"');
    expect(html.match(/<circle/gu)?.length).toBe(5);
  });

  it("spends no colour of its own — the mark is ink", () => {
    // #707 invariant 3: the shell owns no hue, so every colour on screen
    // provably belongs to an app. A brand-teal product mark would be the one
    // exception, and the exception is what makes the rule unreadable — so the
    // mark inherits the surrounding ink instead of carrying a literal.
    const html = renderToStaticMarkup(<Logo />);
    expect(html).not.toMatch(/#[0-9a-f]{3,8}/iu);
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('fill="currentColor"');
  });

  it("defaults to size 32", () => {
    expect(renderToStaticMarkup(<Logo />)).toContain('width="32"');
  });
});
