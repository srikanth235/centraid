#!/usr/bin/env bun

export const CJK_SAMPLE =
  "設定は保存されました。写真と文書はこの端末にあります。同期は待機中です。";

export const BIDI_PROBE_WORD = "مساء";
export const BIDI_PROBE_NUMERALS = "2026-08-21";

const PHYSICAL_PAIRS = Object.freeze([
  ["padding", "padLeft", "padRight"],
  ["margin", "marLeft", "marRight"],
  ["border-width", "borLeft", "borRight"],
]);

export function label(record) {
  const classes = record.classes
    ? `.${record.classes.split(/\s+/u).join(".")}`
    : "";
  const text = record.ownText.trim().slice(0, 32);
  return `${record.tag}${classes}[${record.index}]${text ? ` “${text}”` : ""}`;
}

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
    if (Math.abs(ltr.width - rtl.width) > 0.5) continue;
    if (Math.abs(ltr.startOffset - rtl.startOffset) > 1)
      findings.push(
        `${label(ltr)}: positioned box does not mirror — it sits ${ltr.startOffset.toFixed(1)}px from the inline start under ltr and ${rtl.startOffset.toFixed(1)}px under rtl (physical inset)`
      );
  }
  return findings;
}

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

export function judgeBidiProbe(probe) {
  const findings = [];
  if (probe.isolated.year === null || probe.isolated.day === null)
    return ["bidi probe: the probe text did not lay out"];
  if (probe.isolated.day <= probe.isolated.year)
    findings.push(
      `bidi probe: under the numeric register the year rendered at x=${probe.isolated.year.toFixed(1)} and the day at x=${probe.isolated.day.toFixed(1)} — the date did not stay in calendar order`
    );
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

export function normalizeStack(stack) {
  return stack
    .split(",")
    .map((family) => family.trim().replaceAll(/^["']|["']$/gu, ""))
    .filter(Boolean)
    .join(", ");
}

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

export function probeBidiInPage({ host: hostSelector, numerals, word }) {
  const root = document.querySelector(hostSelector);
  const read = (element, property) =>
    getComputedStyle(element).getPropertyValue(property);
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

export function localizeInPage({ host: hostSelector, sample: source }) {
  const root = document.querySelector(hostSelector);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let cursor = 0;
  let node = walker.nextNode();
  while (node !== null) {
    const length = (node.nodeValue ?? "").trim().length;
    if (length > 0) {
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
