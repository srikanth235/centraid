// Centraid — the nightly test report's stylesheet.
//
// Two halves. `designSystemCss()` returns the GENERATED sheet — the product's
// `toCss()` lowering, the site layer, the matrix status ramp, and the four
// bundled faces inlined as `data:` URIs — read from `report-tokens.css` beside
// this file. `REPORT_CSS` is the report's own component layer, authored here,
// and it declares no colour, no face and no type scale of its own: every value
// in it names a token the generated sheet above it declares.
//
// The split matters because the two run under different engines. The sheet is
// emitted by `scripts/site-tokens.mjs` under **bun**, which can import
// `packages/design`'s TypeScript; the report generator runs under **node**,
// which cannot. So the sheet is committed and gated by bytes
// (`bun run lint:site-tokens`), exactly as the two public sites take theirs,
// and this module only reads it. See issue #853.

import { readFileSync } from "node:fs";
import path from "node:path";

const SHEET = path.join(import.meta.dirname, "report-tokens.css");

/**
 * Two things the report cannot render without, checked at read time rather
 * than trusted. A truncated or hand-edited sheet does not throw in a browser —
 * it silently drops every declaration that names a missing token and the page
 * renders as unstyled text, which is exactly the failure this whole pass
 * exists to stop being invisible.
 */
const REQUIRED = ["--font-sans:", "--st-solid:"];

/**
 * What a usable sheet has to contain, as a pure check so the failure modes are
 * reachable from a test rather than only from a broken checkout.
 * @param {string} css The sheet's text.
 * @param {string} [label] What to name in the error.
 * @returns {string} `css`, unchanged.
 */
export function verifySheet(css, label = path.basename(SHEET)) {
  for (const marker of REQUIRED) {
    if (!css.includes(marker)) {
      throw new Error(
        `test report: ${label} declares no ${marker.slice(0, -1)} — re-emit it with \`bun run site:tokens\``
      );
    }
  }
  // The faces are inlined precisely so an archived run keeps rendering with no
  // network and no sibling assets. A relative `url()` here means the emitter
  // stopped inlining and every archive published afterwards would fetch a path
  // that does not exist at either depth it is published to.
  if (/src:\s*url\((?!data:)/u.test(css)) {
    throw new Error(
      `test report: ${label} links a face instead of inlining it — the run archives would render unstyled`
    );
  }
  return css;
}

/** The generated design-system sheet, verified. */
export function designSystemCss() {
  let css;
  try {
    css = readFileSync(SHEET, "utf8");
  } catch (error) {
    throw new Error(
      `test report: ${path.basename(SHEET)} is missing — run \`bun run site:tokens\``,
      { cause: error }
    );
  }
  return verifySheet(css);
}

/**
 * The report's component layer.
 *
 * Read it against the ramp in `report-tokens.css`: a rule here says which
 * STATE it paints (`--st-gap`) rather than which hue, so the meaning of a
 * colour is settled once, in the emitter, and not eleven times in a selector
 * list. Reduced motion is not honoured here — `toCss()` emits the product's
 * one global rule above, and a second one is how the two drift.
 */
export const REPORT_CSS = `
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:var(--t-body)}
main{width:min(1480px,calc(100% - var(--sp-6) * 2));margin:auto;padding:var(--sp-band) 0 var(--sp-band-lg)}

/* Hero. The display role scaled by the site layer's one sanctioned step; the
   eyebrow is a label, so it takes the ink ramp rather than a hue. */
.hero{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--sp-6);align-items:end;margin-bottom:var(--sp-band)}
.eyebrow{color:var(--text-soft);font:var(--t-eyebrow);letter-spacing:var(--t-eyebrow-tracking);text-transform:var(--t-eyebrow-transform)}
h1{font-family:var(--font-sans);font-weight:600;font-size:var(--t-hero-size);line-height:1.06;letter-spacing:var(--t-display-tracking);margin:var(--sp-3) 0 var(--sp-4);max-width:20ch}
.lede{color:var(--text-soft);font:var(--t-reading);max-width:var(--measure-lede);margin:0}
.lede.scope{border-left:3px solid var(--link);padding-left:var(--sp-3)}
.lede.attention{color:var(--st-silent-text)}
.lede.urgent{color:var(--st-failed-text)}
.lede.absent{color:var(--st-absent-text)}
.summary{display:grid;grid-template-columns:repeat(3,108px);gap:var(--sp-2)}
.stat{background:var(--bg-elev);border:1px solid var(--line);border-radius:var(--r-sm);padding:var(--sp-3) var(--sp-3)}
.stat b{display:block;font:var(--t-title);letter-spacing:var(--t-title-tracking);font-variant-numeric:var(--t-mono-numeric)}
.stat small,.muted,small{color:var(--text-soft)}

/* Containers. Raised paper, hairline bounded — darker than the page in light,
   lighter in dark, because a card is a sheet laid on the page. */
.matrix-shell,.card{background:var(--bg-elev);border:1px solid var(--line);border-radius:var(--r-lg)}
.matrix-head{display:flex;justify-content:space-between;gap:var(--sp-5);align-items:center;padding:var(--sp-4) var(--sp-5);border-bottom:1px solid var(--line)}
.matrix-head h2,.card h2{font:var(--t-small-strong);margin:0}
.legend{display:flex;gap:var(--sp-3);flex-wrap:wrap;color:var(--text-soft);font:var(--t-annot-label)}
.dot{display:inline-block;width:7px;height:7px;border-radius:var(--r-pill);margin-right:var(--sp-1)}
.matrix-scroll{overflow:auto;padding:var(--sp-2)}
table{border-collapse:separate;border-spacing:var(--sp-1);width:100%}
.heatmap th{font:var(--t-annot-label);color:var(--text-soft);text-align:left;min-width:68px}
.heatmap thead th:not(:first-child){height:98px;vertical-align:bottom}
.heatmap thead th span{display:block;writing-mode:vertical-rl;transform:rotate(180deg);height:74px}
.heatmap thead th small{display:none}
.heatmap tbody th{min-width:230px;color:var(--text)}

/* The matrix cell. A data mark that is also a target — the one fill departure
   this page takes, bounded in docs/design-divergences.md. State is carried as
   text as well as colour: every cell's class, its title and the inspector
   below name it, so nothing here is legible only to a reader who sees hue. */
.cell{width:100%;min-width:52px;height:40px;border:1px solid transparent;border-radius:var(--r-sm);color:var(--st-on-fill);display:flex;justify-content:space-between;align-items:center;padding:0 var(--sp-2);font:var(--t-body-strong);font-variant-numeric:var(--t-mono-numeric);cursor:pointer;transition:transform var(--dur-1) var(--ease),border-color var(--dur-1) var(--ease);animation:rise var(--dur-2) var(--ease-entry) both;animation-delay:calc(var(--row) * 28ms)}
.cell small{color:inherit}
.cell:hover{transform:translateY(-2px);border-block-color:var(--text);border-inline-end-color:var(--text)}
.cell:focus-visible{outline:none;box-shadow:var(--focus-ring)}

/* Two registers, and the split is the report's own thesis rather than a
   graphic choice.

   A lane RAN and returned a result — passed, partial, failed, flaky — so the
   cell is a filled mark: the evidence is the loud thing on this page.

   Nothing ran, or nothing owns it — n/a by design, a tracked gap, unmatched
   evidence, a silent owner, an unproven cell, a stale one, a named absence —
   so the cell is a recessed trough carrying its tone as a 3px rule and as its
   own numerals. Absence stays fully visible and stays classified; what it
   stops doing is out-shouting the proof. It is also what DESIGN.md already
   requires: --warning, --seam and --attention may be type, a border or a 2px
   rule, and never a fill.

   The legend teaches the same split — a filled dot for measured, a ring for
   absent — so the key and the grid cannot say different things. */
.dot.passed{background:var(--st-solid)}
.dot.partial{background:var(--st-partial)}
.dot.failed,.dot.infra-mismatch{background:var(--st-failed)}
.dot.flaky{background:var(--st-flaky)}
.dot.skipped,.dot.gap,.dot.evidence-unmatched,.dot.owner-silent,.dot.missing,.dot.lane-did-not-run,.dot.stale,.dot.expected-grey{background:none;border:2px solid currentcolor}
.dot.skipped{color:var(--st-na)}
.dot.gap{color:var(--st-gap)}
.dot.evidence-unmatched{color:var(--st-unmatched)}
.dot.owner-silent{color:var(--st-silent)}
.dot.missing{color:var(--st-missing)}
.dot.lane-did-not-run,.dot.stale{color:var(--st-absent)}
.dot.expected-grey{color:var(--st-absent);border-style:dashed}

.cell.passed{background:var(--st-solid)}
.cell.passed.assessment-partial{background:var(--st-partial)}
.cell.failed,.cell.infra-mismatch{background:var(--st-failed)}
.cell.flaky{background:var(--st-flaky)}
.cell.skipped,.cell.gap,.cell.evidence-unmatched,.cell.owner-silent,.cell.missing,.cell.stale,.cell.lane-did-not-run,.cell.expected-grey{background:var(--bg-app);border-color:var(--line-strong);border-inline-start-width:3px}
.cell.skipped{color:var(--st-na-text);border-inline-start-color:var(--st-na)}
.cell.gap{color:var(--st-gap-text);border-inline-start-color:var(--st-gap)}
.cell.evidence-unmatched{color:var(--st-unmatched-text);border-inline-start-color:var(--st-unmatched)}
.cell.owner-silent{color:var(--st-silent-text);border-inline-start-color:var(--st-silent)}
.cell.missing{color:var(--st-missing-text);border-inline-start-color:var(--st-missing)}
.cell.stale,.cell.lane-did-not-run{color:var(--st-absent-text);border-inline-start-color:var(--st-absent)}
.cell.expected-grey{color:var(--st-absent-text);border-inline-start-color:var(--st-absent);border-style:dashed}

/* The inspector under the matrix. */
.inspector{display:grid;grid-template-columns:220px minmax(0,1fr);gap:var(--sp-5);padding:var(--sp-5);border-top:1px solid var(--line);min-height:126px}
.inspector .kicker{color:var(--text-soft);font:var(--t-annot-label)}
.inspector h3{margin:var(--sp-1) 0 0;font:var(--t-title);letter-spacing:var(--t-title-tracking)}
.flow-list{display:grid;gap:var(--sp-2)}
.flow{display:grid;grid-template-columns:minmax(150px,.45fr) 78px 84px 84px minmax(230px,1fr);gap:var(--sp-3);align-items:center;padding:var(--sp-2) 0;border-bottom:1px solid var(--line)}
.flow:last-child{border-bottom:0}
.tier{color:var(--text-soft);font:var(--t-eyebrow);letter-spacing:var(--t-eyebrow-tracking);text-transform:var(--t-eyebrow-transform)}
.result{font:var(--t-eyebrow);letter-spacing:var(--t-eyebrow-tracking);text-transform:var(--t-eyebrow-transform)}
.result.passed{color:var(--st-solid-text)}
.result.failed,.result.infra-mismatch{color:var(--st-failed-text)}
.result.flaky{color:var(--st-flaky-text)}
.result.skipped{color:var(--st-na-text)}
.result.evidence-unmatched{color:var(--st-unmatched-text)}
.result.owner-silent{color:var(--st-silent-text)}
.result.missing{color:var(--st-missing-text)}
.result.stale,.result.lane-did-not-run,.result.expected-grey{color:var(--st-absent-text)}
.path{color:var(--text-soft);font-family:var(--font-code);font-size:var(--t-mono-size);line-height:1.4;overflow-wrap:anywhere}
a{color:var(--link)}

/* Grids and data tables. */
.grid{display:grid;grid-template-columns:1fr 1fr;gap:var(--sp-3);margin-top:var(--sp-3)}
.card{padding:var(--sp-5);overflow:auto}
.card h2{margin-bottom:var(--sp-3)}
.data{border-spacing:0;width:100%}
.data th,.data td{text-align:left;border-bottom:1px solid var(--line);padding:var(--sp-2) 7px;font:var(--t-annot-label);font-variant-numeric:var(--t-mono-numeric)}
.data th{color:var(--text-soft);font:var(--t-annot-label-on)}
.metric.passed{color:var(--st-solid-text)}
.metric.failed{color:var(--st-failed-text)}
.metric.missing{color:var(--st-missing-text)}
.metric.axis-declared{color:var(--st-solid-text)}
.metric.axis-unowned{color:var(--st-absent-text)}
.metric.axis-skipped{color:var(--st-na-text)}
.metric small{margin-left:var(--sp-1);color:var(--text-soft)}
.axis-note{font:var(--t-annot-label);margin:0 0 var(--sp-3)}
.wide{grid-column:1/-1}
.trend-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:var(--sp-2)}
.trend{display:flex;justify-content:space-between;gap:var(--sp-3);align-items:center;background:var(--bg-sunken);border:1px solid var(--line);padding:var(--sp-3)}
.trend strong,.trend small{display:block}
.trend strong{font-variant-numeric:var(--t-mono-numeric)}
.spark{width:120px;height:40px}
.spark polyline{fill:none;stroke:var(--st-solid);stroke-width:2;vector-effect:non-scaling-stroke}
.empty{color:var(--text-soft);border:1px dashed var(--line-strong);padding:var(--sp-5);margin:0}
.foot{margin-top:var(--sp-5);color:var(--text-soft);font:var(--t-annot-label)}

/* The user-facing qualities panel. */
.qualities-shell{margin-bottom:var(--sp-3);padding:var(--sp-3) var(--sp-5);background:var(--bg-elev);border:1px solid var(--line);border-radius:var(--r-lg)}
.qualities-shell h2{font:var(--t-small-strong);margin:0 0 var(--sp-2)}
.quality-row{border-top:1px solid var(--line)}
.quality-row summary{display:grid;grid-template-columns:14px 180px minmax(0,1fr) 72px;gap:var(--sp-2);align-items:center;padding:11px 0;cursor:pointer}
.quality-row summary b{text-align:right;font-variant-numeric:var(--t-mono-numeric)}
.quality-light{width:9px;height:9px;border-radius:var(--r-pill);background:var(--st-absent)}
.quality-light.passed{background:var(--st-solid)}
.quality-light.partial{background:var(--st-partial)}
.quality-light.failed{background:var(--st-failed)}
.quality-gates{padding:0 0 var(--sp-2) var(--sp-5)}
.quality-gates>div{display:grid;grid-template-columns:12px minmax(180px,.7fr) minmax(260px,1fr);gap:var(--sp-2);align-items:center;padding:var(--sp-1) 0}
.quality-gates code{color:var(--text-soft);font-family:var(--font-code);font-size:var(--t-mono-size);overflow-wrap:anywhere}
.quality-debt{color:var(--text-soft);font:var(--t-annot-label);margin:var(--sp-2) 0 0}

@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@media(max-width:900px){
main{width:min(100% - var(--page-margin) * 2,1480px);padding-top:var(--sp-6)}
.hero{grid-template-columns:1fr}
.summary{grid-template-columns:repeat(3,1fr)}
.grid{grid-template-columns:1fr}
.wide{grid-column:auto}
.inspector{grid-template-columns:1fr}
.flow{grid-template-columns:1fr}
.matrix-head{align-items:flex-start;flex-direction:column}
.quality-row summary,.quality-gates>div{grid-template-columns:14px 1fr}
.quality-row summary span:nth-of-type(2),.quality-row summary b,.quality-gates code{grid-column:2}
}
`;
