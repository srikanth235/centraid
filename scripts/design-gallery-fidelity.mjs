#!/usr/bin/env bun
// The RTL and CJK fidelity lanes of `design-gallery.mjs` (issue #839, gap G13).
//
// WHAT THESE LANES CLAIM, AND WHY THEY ARE NOT PHOTOGRAPHED
//
// DESIGN.md § Responsive Behavior binds every component to survive RTL, and
// § Typography binds the one face to carry "mandatory CJK fallbacks". Nothing
// checked either. `lint:logical-insets` reads apps/mobile SOURCE for the one
// dead React Native spelling; the shell's own rendered result — what a member
// in Riyadh or Osaka actually gets — was unfenced.
//
// These lanes re-render the SAME surface the SH lane photographs (the built
// shell's `#ui-preview` gallery, the product's own React blocks under the
// product's own token lowering) with the document direction flipped and with
// the copy replaced by CJK text, then read the RESULT back out of the engine.
// There is no fixture: #799 deleted the hand-written HTML-and-stylesheet
// vocabulary this gate used to photograph, and re-inventing one under a new
// name would be the same defect wearing an `dir="rtl"` attribute.
//
// They take no baseline. A pixel baseline of the mirrored gallery would need
// regenerating on every copy edit and would fence an APPEARANCE, where what
// the rulebook actually binds is a set of invariants — a rule that mirrors, a
// number that keeps its order, a stack that names a CJK face. Those are read
// as values, so they are asserted as values.
//
// THE JUDGMENT IS PURE. Every `judge*` below takes plain records and returns
// findings, so `design-gallery-fidelity.test.mjs` can flip an input and prove
// the lane fails. Only `collect*` and `probe*` touch a page.
//
// The design-system facts this module needs (the sans stack, the legal type
// triples, the face assertion) are PASSED IN rather than imported, the same
// division `design-gallery-lowering.mjs` keeps: the gate script owns the
// contract half, this module owns the rendering half.

/** Japanese copy for the CJK lane. Kana + kanji + a full-width stop, which is
 *  the metric case: none of them exist in Instrument Sans, so every glyph here
 *  is answered by the stack's fallback half or by nothing at all. */
export const CJK_SAMPLE =
  "設定は保存されました。写真と文書はこの端末にあります。同期は待機中です。";

/** The bidi probe. A hyphenated date after an Arabic word is the exact run
 *  DESIGN.md's numeric role exists for: UAX#9's W2 turns the ASCII digits
 *  into Arabic numbers, the hyphens stay neutral, and the groups order
 *  right-to-left — `2026-08-21` renders as `21-08-2026` — unless the role
 *  pins its own direction and isolates. The isolated clone carries the date
 *  alone (the register's honest content); the control carries the word too,
 *  because a bare ASCII date has no reordering pressure to survive (W4 merges
 *  hyphen-joined European digits into one run even in an RTL paragraph). */
export const BIDI_PROBE_WORD = "مساء";
export const BIDI_PROBE_NUMERALS = "2026-08-21";

const PHYSICAL_PAIRS = Object.freeze([
  ["padding", "padLeft", "padRight"],
  ["margin", "marLeft", "marRight"],
  ["border-width", "borLeft", "borRight"],
]);

/** A human-readable name for one collected element. */
export function label(record) {
  const classes = record.classes
    ? `.${record.classes.split(/\s+/u).join(".")}`
    : "";
  const text = record.ownText.trim().slice(0, 32);
  return `${record.tag}${classes}[${record.index}]${text ? ` “${text}”` : ""}`;
}

/** px string → number, or null when the value is not a length. */
function px(value) {
  const parsed = Number(value.replace(/px$/u, ""));
  return value.endsWith("px") && Number.isFinite(parsed) ? parsed : null;
}

function sameLength(a, b, tolerance = 0.5) {
  const left = px(a);
  const right = px(b);
  if (left === null || right === null) return a === b;
  return Math.abs(left - right) <= tolerance;
}

/**
 * Zip two renders of the same tree by element index. The DOM is identical
 * across renders by construction (nothing but `dir`, `lang` and text nodes
 * moves), so a mismatch here means the collector, not the product, is wrong —
 * and a silently misaligned zip would compare one element's padding against
 * another's and call it a mirroring bug.
 */
export function alignRenders(first, second) {
  if (first.length !== second.length)
    throw new Error(
      `fidelity: the two renders saw different trees (${first.length} vs ${second.length} elements)`
    );
  return first.map((a, index) => {
    const b = second[index];
    if (a.tag !== b.tag || a.classes !== b.classes)
      throw new Error(
        `fidelity: element ${index} drifted between renders (${a.tag}.${a.classes} vs ${b.tag}.${b.classes})`
      );
    return { first: a, second: b };
  });
}

/**
 * DESIGN.md § Responsive Behavior — "Under RTL the stem mirrors, which is only
 * true while every rule uses logical properties", and § Do's and Don'ts — "Do
 * not … write a physical direction property where a logical one exists".
 *
 * A logical rule SWAPS its physical sides when the inline axis flips; a
 * physical one does not move at all. So the test is not "is this value
 * asymmetric" (source lint's question) but "did the asymmetry follow the
 * reader" — which is a fact about the rendered result and needs no access to
 * the stylesheet that produced it.
 */
export function judgeMirroredBoxes(pairs) {
  const findings = [];
  for (const { first: ltr, second: rtl } of pairs) {
    if (!ltr.visible || !rtl.visible) continue;
    for (const [name, leftKey, rightKey] of PHYSICAL_PAIRS) {
      if (sameLength(ltr[leftKey], ltr[rightKey])) continue;
      if (
        sameLength(ltr[leftKey], rtl[rightKey]) &&
        sameLength(ltr[rightKey], rtl[leftKey])
      )
        continue;
      findings.push(
        `${label(ltr)}: ${name} does not mirror — ltr ${ltr[leftKey]}/${ltr[rightKey]}, rtl ${rtl[leftKey]}/${rtl[rightKey]} (physical side, not a logical one)`
      );
    }
    if (ltr.startOffset === null || rtl.startOffset === null) continue;
    // A box whose own width changed cannot be compared by its start offset:
    // an inline-end anchor resolves through the width, so a reflowed box moves
    // for a reason that is not a direction bug. Skipped rather than guessed.
    if (Math.abs(ltr.width - rtl.width) > 0.5) continue;
    if (Math.abs(ltr.startOffset - rtl.startOffset) > 1)
      findings.push(
        `${label(ltr)}: positioned box does not mirror — it sits ${ltr.startOffset.toFixed(1)}px from the inline start under ltr and ${rtl.startOffset.toFixed(1)}px under rtl (physical inset)`
      );
  }
  return findings;
}

/**
 * The same rule, read off `text-align`. `start`/`end` compute to themselves
 * and follow the reader; `left`/`right` compute to themselves and do not.
 *
 * Only the element that INTRODUCES the physical value is named — the value
 * inherits, so reporting every descendant would bury the one rule at fault
 * under its own subtree.
 */
export function judgePhysicalAlignment(records) {
  const findings = [];
  for (const record of records) {
    if (!record.visible) continue;
    if (record.textAlign !== "left" && record.textAlign !== "right") continue;
    if (record.textAlign === record.parentTextAlign) continue;
    findings.push(
      `${label(record)}: text-align: ${record.textAlign} is physical — it points at the same edge in both directions`
    );
  }
  return findings;
}

/**
 * DESIGN.md § Typography — "The numeric role also declares its own reading
 * direction: `--t-mono-direction` `ltr` and `--t-mono-bidi` `isolate`, set
 * once on the role, never per span. A number is not a word."
 *
 * The register announces itself with `font-variant-numeric: tabular-nums`
 * (`--t-mono-numeric`), which is the only place the registry spends that
 * property. `direction` inherits and `unicode-bidi` does not, so a digit-
 * bearing leaf inside an isolated mono element is correctly covered by its
 * ancestor and is not reported twice.
 */
export function judgeNumericIsolation(records) {
  const findings = [];
  for (const record of records) {
    if (!record.visible) continue;
    if (!record.variantNumeric.includes("tabular-nums")) continue;
    if (!/\d/u.test(record.ownText)) continue;
    if (record.direction !== "ltr")
      findings.push(
        `${label(record)}: numeric register renders direction: ${record.direction} under RTL — --t-mono-direction is not reaching it`
      );
    if (!record.unicodeBidi.includes("isolate") && !record.ancestorIsolated)
      findings.push(
        `${label(record)}: numeric register renders unicode-bidi: ${record.unicodeBidi} under RTL and sits in no isolate — the digits reorder against the surrounding run`
      );
  }
  return findings;
}

/**
 * The other half of the same sentence — "a layout container must never carry
 * the numeric face … it would flip its own inline axis along with it"
 * (`packages/design/src/typography.ts`, `typeModifiers`). A text leaf that
 * isolates is the mechanism working; a flex or grid box that isolates has
 * pinned the arrangement of its CHILDREN to `ltr`, which is the mirroring bug
 * the isolate was supposed to prevent.
 *
 * `isolate` alone does not identify the register: the HTML standard's UA
 * stylesheet computes `unicode-bidi: isolate` on every plain block element
 * (`div`, `section`, …), and that default follows the page direction and is
 * harmless. The register's signature is the PAIR — an isolate whose
 * `direction` computes `ltr` while the page renders RTL is one the register
 * (or a hand-written pin) put there, and only that one freezes the children.
 */
export function judgeIsolatedContainers(records) {
  const findings = [];
  const boxy = new Set(["block", "flex", "grid", "list-item", "table"]);
  for (const record of records) {
    if (!record.visible) continue;
    if (!record.unicodeBidi.includes("isolate")) continue;
    if (record.direction !== "ltr") continue;
    if (!record.childDisplays.some((display) => boxy.has(display))) continue;
    findings.push(
      `${label(record)}: a layout container carries the numeric register's isolate — its children's inline axis is pinned to ltr`
    );
  }
  return findings;
}

/**
 * The mechanism, exercised rather than read. Both clones carry the same real
 * element's computed style; the control has its isolation removed. If the
 * isolated date does not read year-first as written, or if removing the
 * isolation changes nothing, then the tokens are present and inert — which is
 * the failure a value assertion cannot see.
 */
export function judgeBidiProbe(probe) {
  const findings = [];
  if (probe.isolated.year === null || probe.isolated.day === null)
    return ["bidi probe: the probe text did not lay out"];
  if (probe.isolated.day <= probe.isolated.year)
    findings.push(
      `bidi probe: under the numeric register the year rendered at x=${probe.isolated.year.toFixed(1)} and the day at x=${probe.isolated.day.toFixed(1)} — the date did not stay in calendar order`
    );
  // The control only says something while it is genuinely un-isolated. If the
  // clone's own paragraph never became RTL there is no reordering pressure to
  // survive, and claiming the isolate is inert would be the lane inventing a
  // failure rather than reading one.
  if (probe.controlDirection !== "rtl") return findings;
  if (
    probe.control.year !== null &&
    probe.control.day !== null &&
    probe.control.day > probe.control.year
  )
    findings.push(
      "bidi probe: the date reads the same way with the isolation removed — --t-mono-bidi is inert here, so nothing proves it is what holds the order"
    );
  return findings;
}

/** Compare two font-family lists as the registry writes them, not as the
 *  engine quotes them. */
export function normalizeStack(stack) {
  return stack
    .split(",")
    .map((family) => family.trim().replaceAll(/^["']|["']$/gu, ""))
    .filter(Boolean)
    .join(", ");
}

/**
 * DESIGN.md § Typography — "display, reading, UI, and numerics all draw from
 * the same stack with mandatory CJK fallbacks", and `--font-code` "is reached
 * only by fenced code, inline literals, file paths, keyboard chips, and
 * secrets".
 *
 * The claim stops at the STACK, deliberately. The product ships no CJK bytes
 * (`fonts.ts` bundles Instrument Sans and fetches nothing), so which physical
 * face answers `'Hiragino Sans'` is the host's business and a headless Linux
 * runner has none of them. What the product owes a CJK reader is that the
 * stack asks for the right faces in the registry's order before it reaches a
 * generic — and that is exactly what is read back here.
 */
export function judgeCjkStack(records, sansStack) {
  const findings = [];
  const expected = normalizeStack(sansStack);
  for (const record of records) {
    if (!record.visible || !record.ownText.trim()) continue;
    const seen = normalizeStack(record.fontFamily);
    if (seen === expected) continue;
    findings.push(
      `${label(record)}: renders CJK copy on \`${seen}\` — the one face's mandatory CJK fallbacks are not in the stack that reached it`
    );
  }
  return findings;
}

/**
 * Invariant 2 — "One ramp, one face." A role's size and leading are the
 * token's, so swapping Latin copy for CJK may change how many LINES a block
 * takes and must change nothing about the rungs themselves. An element that
 * moved rung under CJK is reading its metrics off the glyphs (`line-height:
 * normal` is the usual way in), which is the ramp quietly becoming two ramps.
 */
export function judgeTypeStability(pairs) {
  const findings = [];
  for (const { first: latin, second: cjk } of pairs) {
    if (!latin.visible || !cjk.visible) continue;
    if (!latin.ownText.trim() || !cjk.ownText.trim()) continue;
    if (latin.typeTriple === cjk.typeTriple) continue;
    findings.push(
      `${label(latin)}: type moved under CJK copy — ${latin.typeTriple} became ${cjk.typeTriple}`
    );
  }
  return findings;
}

// ---------------------------------------------------------------------------
// The page half
// ---------------------------------------------------------------------------

// The three functions below run INSIDE the page. Playwright ships them by
// source text, so they close over nothing and read every value through
// `getPropertyValue` — the one accessor every engine spells the same way, and
// the reason `design-gallery-fidelity.test.mjs` can smoke them against a jsdom
// document instead of trusting a browser nobody has watched run them.

/** One record per element in the host subtree, in document order. Invisible
 *  elements are kept (and flagged) so both renders index identically. */
export function collectInPage({ dir: direction, host: hostSelector }) {
  const root = document.querySelector(hostSelector);
  const read = (element, property) =>
    getComputedStyle(element).getPropertyValue(property);
  const elements = [root, ...root.querySelectorAll("*")];
  return elements.map((element, index) => {
    const style = getComputedStyle(element);
    const parent = element.parentElement;
    const box = element.getBoundingClientRect();
    const anchorBox = (
      element.offsetParent ?? document.documentElement
    ).getBoundingClientRect();
    const position = read(element, "position");
    let startOffset = null;
    if (position === "absolute" || position === "fixed")
      startOffset =
        direction === "rtl"
          ? anchorBox.right - box.right
          : box.left - anchorBox.left;
    let ownText = "";
    for (const node of element.childNodes)
      if (node.nodeType === 3) ownText += node.nodeValue ?? "";
    // Only the register's pair counts as cover: the UA stylesheet isolates
    // every plain block element, so a bare `isolate` ancestor proves nothing
    // about the digits' reading direction.
    let ancestorIsolated = false;
    for (let node = parent; node !== null; node = node.parentElement) {
      if (
        read(node, "unicode-bidi").includes("isolate") &&
        read(node, "direction") === "ltr"
      ) {
        ancestorIsolated = true;
        break;
      }
      if (node === root) break;
    }
    return {
      ancestorIsolated,
      borLeft: read(element, "border-left-width"),
      borRight: read(element, "border-right-width"),
      childDisplays: [...element.children].map((child) =>
        read(child, "display")
      ),
      classes: element.getAttribute("class") ?? "",
      direction: read(element, "direction"),
      fontFamily: read(element, "font-family"),
      index,
      marLeft: read(element, "margin-left"),
      marRight: read(element, "margin-right"),
      ownText,
      padLeft: read(element, "padding-left"),
      padRight: read(element, "padding-right"),
      parentTextAlign: parent ? read(parent, "text-align") : "",
      startOffset,
      tag: element.tagName.toLowerCase(),
      textAlign: read(element, "text-align"),
      typeTriple: `${read(element, "font-weight")}|${read(element, "font-size")}|${read(element, "line-height")}`,
      unicodeBidi: read(element, "unicode-bidi"),
      variantNumeric: read(element, "font-variant-numeric"),
      visible:
        style.display !== "none" && read(element, "visibility") !== "hidden",
      width: box.width,
    };
  });
}

/** Clone one real numeric-register element twice — once as it is, once with
 *  its isolation removed — and read back where each run landed. */
export function probeBidiInPage({ host: hostSelector, numerals, word }) {
  const root = document.querySelector(hostSelector);
  const read = (element, property) =>
    getComputedStyle(element).getPropertyValue(property);
  // The register's full signature, not just the isolate: the UA stylesheet
  // isolates plain block elements, and `font-variant-numeric` inherits, so
  // without the `direction: ltr` half this would clone some page-direction
  // container instead of a mono leaf.
  const source = [...root.querySelectorAll("*")].find(
    (element) =>
      read(element, "font-variant-numeric").includes("tabular-nums") &&
      read(element, "unicode-bidi").includes("isolate") &&
      read(element, "direction") === "ltr"
  );
  if (!source) return null;
  const runX = (clone, dateStart) => {
    const text = clone.firstChild;
    const at = (start, end) => {
      const range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, end);
      const rect = range.getBoundingClientRect();
      return rect.width === 0 && rect.height === 0 ? null : rect.left;
    };
    return {
      day: at(dateStart + numerals.lastIndexOf("-") + 1, text.length),
      year: at(dateStart, dateStart + numerals.indexOf("-")),
    };
  };
  const build = (bare) => {
    const clone = source.cloneNode(false);
    clone.textContent = bare ? `${word} ${numerals}` : numerals;
    if (bare) {
      clone.style.unicodeBidi = "normal";
      clone.style.direction = "inherit";
    }
    source.parentElement.append(clone);
    const measured = runX(clone, bare ? word.length + 1 : 0);
    const direction = read(clone, "direction");
    clone.remove();
    return { direction, measured };
  };
  const control = build(true);
  return {
    control: control.measured,
    controlDirection: control.direction,
    isolated: build(false).measured,
  };
}

/** Swap every text node in the surface for CJK copy of its own length. The
 *  STRUCTURE is untouched: this is the product's own gallery reading in
 *  Japanese, not a second gallery. */
export function localizeInPage({ host: hostSelector, sample: source }) {
  const root = document.querySelector(hostSelector);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let cursor = 0;
  let node = walker.nextNode();
  while (node !== null) {
    const length = (node.nodeValue ?? "").trim().length;
    if (length > 0) {
      // Half the Latin length: a CJK glyph is about twice as wide, so the
      // block keeps its measure instead of doubling and re-wrapping the whole
      // surface into a shape no locale produces.
      const take = Math.max(1, Math.ceil(length / 2));
      let text = "";
      while (text.length < take) {
        text += source[cursor % source.length];
        cursor += 1;
      }
      node.nodeValue = text;
    }
    node = walker.nextNode();
  }
  document.documentElement.lang = "ja";
}

async function settle(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => resolve(null));
      })
  );
}

/**
 * Run both lanes on their own page and return every finding. The page is the
 * caller's to close; nothing here writes a baseline, so a finding is the only
 * output.
 */
export async function runFidelityLanes(page, origin, options) {
  const {
    host,
    sansStack,
    freezeMotion,
    legalTypeTriples,
    productFaceResolved,
  } = options;
  const findings = [];
  await page.goto(`${origin}/#ui-preview`, { waitUntil: "load" });
  await page.locator(`${host} > *`).waitFor();
  await productFaceResolved(page, "fidelity");
  await page.addStyleTag({ content: freezeMotion });
  await settle(page);

  const latin = await page.evaluate(collectInPage, { dir: "ltr", host });

  await page.evaluate(() => {
    document.documentElement.dir = "rtl";
    document.documentElement.lang = "ar";
  });
  await settle(page);
  const flipped = await page.evaluate(
    (selector) => getComputedStyle(document.querySelector(selector)).direction,
    host
  );
  if (flipped !== "rtl")
    return [
      `rtl: the surface stayed ${flipped} after the direction switch — the lane would have asserted nothing`,
    ];
  const mirrored = await page.evaluate(collectInPage, { dir: "rtl", host });
  const probe = await page.evaluate(probeBidiInPage, {
    host,
    numerals: BIDI_PROBE_NUMERALS,
    word: BIDI_PROBE_WORD,
  });

  const rtlPairs = alignRenders(latin, mirrored);
  findings.push(
    ...judgeMirroredBoxes(rtlPairs).map((finding) => `rtl: ${finding}`),
    ...judgePhysicalAlignment(mirrored).map((finding) => `rtl: ${finding}`),
    ...judgeNumericIsolation(mirrored).map((finding) => `rtl: ${finding}`),
    ...judgeIsolatedContainers(mirrored).map((finding) => `rtl: ${finding}`),
    ...(probe === null
      ? [
          "rtl: no element on the surface carries the numeric register — the bidi claim went unexercised",
        ]
      : judgeBidiProbe(probe).map((finding) => `rtl: ${finding}`))
  );

  await page.evaluate(() => {
    document.documentElement.dir = "ltr";
  });
  await page.evaluate(localizeInPage, { host, sample: CJK_SAMPLE });
  await settle(page);
  const cjk = await page.evaluate(collectInPage, { dir: "ltr", host });
  findings.push(
    ...judgeCjkStack(cjk, sansStack).map((finding) => `cjk: ${finding}`),
    ...judgeTypeStability(alignRenders(latin, cjk)).map(
      (finding) => `cjk: ${finding}`
    )
  );
  try {
    await legalTypeTriples(page, host, "cjk");
  } catch (error) {
    findings.push(`cjk: ${error.message}`);
  }
  return findings;
}
