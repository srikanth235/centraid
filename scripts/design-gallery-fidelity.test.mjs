// The judgment half of the RTL + CJK gallery lanes (#839, gap G13).
//
// Every test here flips ONE input of a passing record and proves the lane goes
// red for it. A gate nobody has watched fail is a gate nobody knows is wired.
import assert from "node:assert/strict";
import test from "node:test";

import {
  BIDI_PROBE_NUMERALS,
  BIDI_PROBE_WORD,
  CJK_SAMPLE,
  alignRenders,
  collectInPage,
  judgeBidiProbe,
  judgeCjkStack,
  judgeIsolatedContainers,
  judgeMirroredBoxes,
  judgeNumericIsolation,
  judgePhysicalAlignment,
  judgeTypeStability,
  localizeInPage,
  normalizeStack,
  probeBidiInPage,
} from "./design-gallery-fidelity.mjs";

const SANS =
  "'Instrument Sans', 'Helvetica Neue', 'Hiragino Sans', 'Noto Sans JP', 'Noto Sans SC', 'Microsoft YaHei', system-ui, sans-serif";

/** A record with every field a judge reads, in its passing state. */
function record(overrides = {}) {
  return {
    ancestorIsolated: false,
    borLeft: "0px",
    borRight: "0px",
    childDisplays: [],
    classes: "row",
    direction: "rtl",
    fontFamily: SANS,
    index: 7,
    marLeft: "0px",
    marRight: "0px",
    ownText: "Records",
    padLeft: "0px",
    padRight: "0px",
    parentTextAlign: "start",
    startOffset: null,
    tag: "div",
    textAlign: "start",
    typeTriple: "400|13px|19px",
    unicodeBidi: "normal",
    variantNumeric: "normal",
    visible: true,
    width: 120,
    ...overrides,
  };
}

// ── Logical boxes ────────────────────────────────────────────────────────

test("an asymmetric box that swaps its sides under RTL is logical", () => {
  const ltr = record({ padLeft: "16px", padRight: "4px" });
  const rtl = record({ padLeft: "4px", padRight: "16px" });
  assert.deepEqual(judgeMirroredBoxes(alignRenders([ltr], [rtl])), []);
});

test("an asymmetric box that keeps its sides under RTL is physical", () => {
  // The sabotage: the same pair, unmoved. This is what a `padding-left` rule
  // renders as, and it is the only difference from the case above.
  const ltr = record({ padLeft: "16px", padRight: "4px" });
  const rtl = record({ padLeft: "16px", padRight: "4px" });
  const findings = judgeMirroredBoxes(alignRenders([ltr], [rtl]));
  assert.equal(findings.length, 1);
  assert.match(findings[0], /padding does not mirror/u);
  assert.match(findings[0], /div\.row\[7\]/u);
});

test("margins and border widths are read on the same terms as padding", () => {
  const cases = [
    ["marLeft", "marRight", /margin does not mirror/u],
    ["borLeft", "borRight", /border-width does not mirror/u],
  ];
  for (const [leftKey, rightKey, pattern] of cases) {
    const stuck = record({ [leftKey]: "12px", [rightKey]: "0px" });
    const findings = judgeMirroredBoxes(alignRenders([stuck], [stuck]));
    assert.equal(findings.length, 1);
    assert.match(findings[0], pattern);
  }
});

test("a symmetric box is never reported, in either direction", () => {
  const even = record({ padLeft: "12px", padRight: "12px" });
  assert.deepEqual(judgeMirroredBoxes(alignRenders([even], [even])), []);
});

test("a positioned box anchored logically keeps its start offset", () => {
  const ltr = record({ startOffset: 81, width: 11 });
  const rtl = record({ startOffset: 81, width: 11 });
  assert.deepEqual(judgeMirroredBoxes(alignRenders([ltr], [rtl])), []);
});

test("a positioned box anchored to a physical edge is caught", () => {
  // `right: -3px` on a 92px-wide parent: 84px from the inline start under
  // LTR, and -3px from it under RTL, because the dot never moved.
  const ltr = record({ classes: "iconDot", startOffset: 84, width: 11 });
  const rtl = record({ classes: "iconDot", startOffset: -3, width: 11 });
  const findings = judgeMirroredBoxes(alignRenders([ltr], [rtl]));
  assert.equal(findings.length, 1);
  assert.match(findings[0], /positioned box does not mirror/u);
});

test("a reflowed box is skipped rather than guessed at", () => {
  const ltr = record({ startOffset: 84, width: 11 });
  const rtl = record({ startOffset: 40, width: 55 });
  assert.deepEqual(judgeMirroredBoxes(alignRenders([ltr], [rtl])), []);
});

test("an invisible element is not measured", () => {
  const hidden = record({ padLeft: "16px", padRight: "0px", visible: false });
  assert.deepEqual(judgeMirroredBoxes(alignRenders([hidden], [hidden])), []);
});

test("a drifted tree is a lane bug, not a product finding", () => {
  assert.throws(
    () => alignRenders([record()], [record({ tag: "span" })]),
    /drifted between renders/u
  );
  assert.throws(() => alignRenders([record()], []), /different trees/u);
});

// ── Physical alignment ───────────────────────────────────────────────────

test("logical text alignment passes and physical text alignment fails", () => {
  assert.deepEqual(judgePhysicalAlignment([record({ textAlign: "end" })]), []);
  assert.deepEqual(
    judgePhysicalAlignment([record({ textAlign: "center" })]),
    []
  );
  const findings = judgePhysicalAlignment([
    record({ classes: "card", textAlign: "left" }),
  ]);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /text-align: left is physical/u);
});

test("only the rule that introduced the physical value is named", () => {
  // The value inherits; a whole card's subtree would otherwise be reported.
  const heir = record({ parentTextAlign: "left", textAlign: "left" });
  assert.deepEqual(judgePhysicalAlignment([heir]), []);
});

// ── Numeric isolation ────────────────────────────────────────────────────

const numeric = (overrides = {}) =>
  record({
    direction: "ltr",
    ownText: "12 Aug 2026",
    unicodeBidi: "isolate",
    variantNumeric: "tabular-nums",
    ...overrides,
  });

test("the numeric register passes when it carries both halves of the role", () => {
  assert.deepEqual(judgeNumericIsolation([numeric()]), []);
});

test("a numeric element that lost its pinned direction is caught", () => {
  const findings = judgeNumericIsolation([numeric({ direction: "rtl" })]);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /--t-mono-direction is not reaching it/u);
});

test("a numeric element that lost its isolate is caught", () => {
  const findings = judgeNumericIsolation([numeric({ unicodeBidi: "normal" })]);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /the digits reorder against the surrounding run/u);
});

test("a digit-bearing leaf inside an isolated ancestor is already covered", () => {
  assert.deepEqual(
    judgeNumericIsolation([
      numeric({ ancestorIsolated: true, unicodeBidi: "normal" }),
    ]),
    []
  );
});

test("prose in the numeric register carries no digits and is not judged", () => {
  assert.deepEqual(
    judgeNumericIsolation([
      numeric({
        direction: "rtl",
        ownText: "succeeded",
        unicodeBidi: "normal",
      }),
    ]),
    []
  );
});

test("a text leaf may isolate; a layout container may not", () => {
  assert.deepEqual(
    judgeIsolatedContainers([numeric({ childDisplays: ["inline"] })]),
    []
  );
  const findings = judgeIsolatedContainers([
    numeric({ childDisplays: ["inline", "block"] }),
  ]);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /children's inline axis is pinned to ltr/u);
});

test("the UA stylesheet's default isolate on a plain block is not the register's", () => {
  // Chromium computes `unicode-bidi: isolate` on every `div`/`section`; that
  // default follows the page direction (rtl here) and pins nothing.
  assert.deepEqual(
    judgeIsolatedContainers([
      numeric({ childDisplays: ["inline", "block"], direction: "rtl" }),
    ]),
    []
  );
});

// ── The bidi probe ───────────────────────────────────────────────────────

const PASSING_PROBE = {
  // Un-isolated in the RTL paragraph, the date's groups flip: day leftmost.
  control: { day: 10, year: 48 },
  controlDirection: "rtl",
  isolated: { day: 48, year: 10 },
};

test("the probe passes when the isolated date reads in calendar order and the bare one flips", () => {
  assert.deepEqual(judgeBidiProbe(PASSING_PROBE), []);
});

test("the probe fails when the isolated date reorders", () => {
  const findings = judgeBidiProbe({
    ...PASSING_PROBE,
    isolated: { day: 10, year: 48 },
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0], /did not stay in calendar order/u);
});

test("the probe fails when removing the isolation changes nothing", () => {
  const findings = judgeBidiProbe({
    ...PASSING_PROBE,
    control: { day: 48, year: 10 },
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0], /--t-mono-bidi is inert here/u);
});

test("the control says nothing while its own paragraph never became RTL", () => {
  assert.deepEqual(
    judgeBidiProbe({
      ...PASSING_PROBE,
      control: { day: 48, year: 10 },
      controlDirection: "ltr",
    }),
    []
  );
});

test("text that did not lay out is reported rather than passed", () => {
  assert.deepEqual(
    judgeBidiProbe({
      ...PASSING_PROBE,
      isolated: { day: null, year: 10 },
    }),
    ["bidi probe: the probe text did not lay out"]
  );
});

// ── The CJK lane ─────────────────────────────────────────────────────────

test("quoting is not a difference between two font stacks", () => {
  assert.equal(
    normalizeStack(`"Instrument Sans", 'Noto Sans JP', sans-serif`),
    "Instrument Sans, Noto Sans JP, sans-serif"
  );
});

test("the mandated stack passes however the engine quotes it back", () => {
  const engineSpelling = SANS.replaceAll("'", '"');
  assert.deepEqual(
    judgeCjkStack([record({ fontFamily: engineSpelling })], SANS),
    []
  );
});

test("a latin-only stack under CJK copy is caught", () => {
  const findings = judgeCjkStack(
    [record({ fontFamily: "'Instrument Sans', sans-serif" })],
    SANS
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0], /mandatory CJK fallbacks are not in the stack/u);
});

test("the code stack is a finding wherever it reaches rendered copy", () => {
  const findings = judgeCjkStack(
    [record({ fontFamily: "ui-monospace, Menlo, monospace" })],
    SANS
  );
  assert.equal(findings.length, 1);
});

test("an element with no copy of its own carries no CJK claim", () => {
  assert.deepEqual(
    judgeCjkStack([record({ fontFamily: "Arial", ownText: "  " })], SANS),
    []
  );
});

test("a role that holds its rung under CJK copy passes", () => {
  const latin = record();
  const cjk = record({ ownText: "設定は保存" });
  assert.deepEqual(judgeTypeStability(alignRenders([latin], [cjk])), []);
});

test("a role that reads its leading off the glyphs is caught", () => {
  // `line-height: normal` is the usual way in: the rung follows the face that
  // answered the CJK run instead of the token.
  const latin = record();
  const cjk = record({ ownText: "設定は保存", typeTriple: "400|13px|21px" });
  const findings = judgeTypeStability(alignRenders([latin], [cjk]));
  assert.equal(findings.length, 1);
  assert.match(findings[0], /type moved under CJK copy/u);
});

// ── The page half, smoked ────────────────────────────────────────────────
//
// `collectInPage`, `probeBidiInPage` and `localizeInPage` are shipped to the
// browser by source text, so they close over nothing — which is what lets them
// run here against a jsdom document. jsdom does no layout, so this proves the
// SHAPE and not the geometry: every element indexed once, in document order,
// carrying the fields the judges read. The geometry is the browser's to
// answer, and `design:gallery` is where it answers it.

async function mount(html) {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(`<body><main id="host">${html}</main></body>`);
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle;
  globalThis.NodeFilter = dom.window.NodeFilter;
  return dom.window.document;
}

test("the collector indexes the host subtree once, in document order", async () => {
  await mount(
    `<p class="a" style="unicode-bidi: isolate">12 Aug</p><span class="b">x<i>y</i></span>`
  );
  const records = collectInPage({ dir: "ltr", host: "#host" });
  assert.deepEqual(
    records.map((entry) => `${entry.index}:${entry.tag}.${entry.classes}`),
    ["0:main.", "1:p.a", "2:span.b", "3:i."]
  );
  // Own text, not the subtree's: the span contributes "x" and not "xy".
  assert.equal(records[2].ownText, "x");
  assert.equal(records[1].ownText, "12 Aug");
  // Whether an ANCESTOR isolates is answered by the cascade, which jsdom does
  // not implement faithfully (it reports the child's inline `unicode-bidi` on
  // the parent). The walk is smoked for shape only; what the flag MEANS is
  // pinned on the judge above, where it is a plain input.
  assert.equal(typeof records[3].ancestorIsolated, "boolean");
  assert.equal(records[0].startOffset, null);
  assert.equal(records[2].childDisplays.length, 1);
  for (const entry of records)
    for (const key of [
      "direction",
      "textAlign",
      "unicodeBidi",
      "variantNumeric",
    ])
      assert.equal(
        typeof entry[key],
        "string",
        `${key} must always be a string`
      );
});

test("both renders of the same tree align by index", async () => {
  const document_ = await mount(`<p>a</p><p>b</p>`);
  const first = collectInPage({ dir: "ltr", host: "#host" });
  document_.documentElement.dir = "rtl";
  const second = collectInPage({ dir: "rtl", host: "#host" });
  assert.equal(alignRenders(first, second).length, 3);
});

test("the CJK localizer swaps copy and leaves the structure alone", async () => {
  const document_ = await mount(
    `<p>Waiting on you</p><span> </span><b>Records</b>`
  );
  localizeInPage({ host: "#host", sample: CJK_SAMPLE });
  const host = document_.querySelector("#host");
  assert.equal(host.querySelectorAll("p, span, b").length, 3);
  assert.equal(host.querySelector("p").textContent.includes(" "), false);
  assert.equal(
    CJK_SAMPLE.includes(host.querySelector("b").textContent[0]),
    true
  );
  // A whitespace-only node carries no copy to swap and is left alone.
  assert.equal(host.querySelector("span").textContent, " ");
  assert.equal(document_.documentElement.lang, "ja");
});

test("the bidi probe says so rather than throwing when no register is on screen", async () => {
  await mount(`<p>no numbers here</p>`);
  assert.equal(
    probeBidiInPage({
      host: "#host",
      numerals: BIDI_PROBE_NUMERALS,
      word: BIDI_PROBE_WORD,
    }),
    null
  );
});
