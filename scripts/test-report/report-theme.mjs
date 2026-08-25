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
  // The Night Watch palette the page's own ground, ink, rules and tints are
  // drawn in. Both halves are checked, because the dark one closes the sheet:
  // a truncated read carries every marker above it and would render the night
  // page on the day ground. Quote-agnostic on the attribute selector — which
  // quote it wears is the emitter's business, not this check's.
  if (
    !css.includes("--nw-ground:") ||
    !/\[data-theme=["']dark["']\][^{]*\{[^}]*--nw-ground:/u.test(css)
  ) {
    throw new Error(
      `test report: ${label} declares no Night Watch palette — re-emit it with \`bun run site:tokens\``
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
 * The report's component layer — the Night Watch frame (issue #862).
 *
 * Read it against the palette in `report-tokens.css`: a rule here says which
 * RUNG it paints (`--nw-sunken`, `--nw-attnbg`) rather than which hue, so the
 * meaning of a colour is settled once, in the emitter, and not eleven times in
 * a selector list. Reduced motion is not honoured here — `toCss()` emits the
 * product's one global rule above, and a second one is how the two drift.
 */
export const REPORT_CSS = `
*{box-sizing:border-box}
body{margin:0;padding:0 20px;background:var(--nw-ground);color:var(--nw-ink);font-family:var(--font-sans);font-size:13px;line-height:1.5}
.page{max-width:1060px;margin:0 auto;padding:34px 0 120px}
a{color:var(--nw-link);text-decoration:none}
a:hover{text-decoration:underline}
button:focus-visible,a:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--nw-ring);outline-offset:2px}
.num{font-variant-numeric:var(--t-mono-numeric)}
code,.path{font-family:var(--font-code);font-size:var(--t-mono-size)}
.muted,small{color:var(--nw-ink3)}
.path{color:var(--nw-ink3);line-height:1.4;overflow-wrap:anywhere}

/* Masthead and verdict bar. The masthead's rule is full ink, not a hairline:
   it is the only line on the page that closes the run's identity. */
.mast{display:flex;flex-wrap:wrap;align-items:baseline;gap:10px 22px;border-bottom:1px solid var(--nw-ink);padding-bottom:18px}
h1{font-size:26px;line-height:30px;font-weight:600;letter-spacing:-.02em;margin:0}
.runmeta{color:var(--nw-ink3);font-size:12px}
.verdictbar{display:flex;flex-wrap:wrap;align-items:center;gap:12px 26px;padding:16px 0;border-bottom:1px solid var(--nw-line)}
.vword{font-size:15px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;padding:6px 16px;border:2px solid currentcolor;color:var(--nw-ink3);background:var(--nw-greybg)}
.verdict-shippable .vword{color:var(--nw-ok);background:var(--nw-okbg)}
.verdict-degraded .vword{color:var(--nw-attn);background:var(--nw-attnbg)}
.verdict-red .vword{color:var(--nw-danger);background:var(--nw-dangerbg)}
.vstat{font-size:12px;color:var(--nw-ink2)}
.vstat b{font-size:17px;font-weight:600;color:var(--nw-ink);margin-inline-end:4px}
.vstat.red b{color:var(--nw-danger)}
.vstat.grey b{color:var(--nw-ink3)}
.delta{font-size:12px;color:var(--nw-ink2);border-inline-start:2px solid var(--nw-line);padding-inline-start:18px}
.delta b{font-weight:600;color:var(--nw-ink)}
.vwhy{flex-basis:100%;margin:0;font-size:12px;color:var(--nw-ink3);max-width:78ch}
.vstat .spark{margin-inline-start:8px}

/* Section scaffolding: a sticky index, a label-sized heading carrying its
   section tag, and one paragraph saying why the section exists. */
nav.toc{display:flex;flex-wrap:wrap;gap:4px 16px;padding:12px 0;font-size:11px;letter-spacing:.05em;text-transform:uppercase;font-weight:600;border-bottom:1px solid var(--nw-lineS);position:sticky;top:0;background:var(--nw-ground);z-index:5}
nav.toc a{color:var(--nw-ink3)}
nav.toc a:hover{color:var(--nw-link);text-decoration:none}
h2{font-size:12px;letter-spacing:.06em;text-transform:uppercase;font-weight:600;margin:44px 0 4px;color:var(--nw-ink)}
h2 .tag{color:var(--nw-ghost);margin-inline-end:8px}
.why{color:var(--nw-ink3);font-size:12px;margin:0 0 14px;max-width:78ch}
.lede{color:var(--nw-ink3);font-size:12px;margin:0 0 8px;max-width:78ch}
.lede.scope{border-inline-start:2px solid var(--nw-link);padding-inline-start:10px}
.lede.attention{color:var(--nw-attn)}
.lede.urgent{color:var(--nw-danger)}
.lede.absent{color:var(--nw-ink3);font-style:italic}

/* §1's queue. Five columns — band, what, owner, age, action — aligned down the
   section so a reader scans one axis at a time. The chip is bordered and
   tinted rather than filled: it sits beside body text, and a solid block of
   colour there would outrank the sentence it labels. */
.queue{border:1px solid var(--nw-line)}
.qrow{display:grid;grid-template-columns:84px 1fr 190px 70px 120px;gap:14px;padding:10px 14px;border-bottom:1px solid var(--nw-lineS);align-items:baseline}
.qrow:last-child{border-bottom:none}
.qrow .what{font-weight:600}
.qrow .what small{display:block;font-weight:400;color:var(--nw-ink2)}
.qband{display:flex;flex-direction:column;align-items:start;gap:3px}
.qband .sev{font-size:10px;letter-spacing:.05em;color:var(--nw-ghost)}
.qrow .age{color:var(--nw-ink3);font-size:12px}
.qrow .act{font-size:12px}
.chip{font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;padding:1px 8px 2px;border-radius:var(--r-pill);border:1px solid;white-space:nowrap;justify-self:start}
.chip.red{color:var(--nw-danger);border-color:var(--nw-danger);background:var(--nw-dangerbg)}
.chip.newgrey{color:var(--nw-attn);border-color:var(--nw-attn);background:var(--nw-attnbg)}
.chip.stale{color:var(--nw-ink2);border-color:var(--nw-ink3);background:var(--nw-greybg)}
.chip.pinned{color:var(--nw-ink2);border-color:var(--nw-ghost);background:var(--nw-surf)}

/* The ledger register: §4, §5, §6 and §7. One row frame, one head-row
   treatment, and a column template per section — the columns differ because
   the registries do, but the rhythm does not. A verdict here is a WORD in its
   tone, never a filled cell: these rows carry prose, and a tinted band behind
   a sentence reads as a highlight rather than as a state. */
.ledger{border:1px solid var(--nw-line)}
.lrow{display:grid;gap:14px;padding:9px 14px;border-bottom:1px solid var(--nw-lineS);align-items:baseline}
.lrow:last-child{border-bottom:none}
.lrow.head{font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;font-weight:600;color:var(--nw-ink3);background:var(--nw-sunken);border-bottom:1px solid var(--nw-ink)}
.consent .lrow{grid-template-columns:170px 1fr 150px 110px 90px}
.joins .lrow,.journeys .lrow{grid-template-columns:240px 1fr 120px 90px}
.adv .lrow{grid-template-columns:200px 90px 90px 110px 1fr}
.lrow small{display:block}
.lrow .quiet{color:var(--nw-ink3);font-size:12px}
/* A ledger verdict speaks the same families the cells do (#864): a flaky law is
   violet here and violet in §8, an unowned layer is the gap family and not the
   grey that means "the evidence is absent". */
.state{font-weight:600;font-size:11.5px}
.state.ok{color:var(--nw-ok)}
.state.red{color:var(--nw-danger)}
.state.warn{color:var(--nw-attn)}
.state.flaky{color:var(--nw-flaky)}
.state.gap{color:var(--nw-gap)}
.state.grey{color:var(--nw-ink3);font-style:italic}
.budget{font-size:11px;color:var(--nw-ink3);margin:14px 0 6px;max-width:100ch}
.budget b{color:var(--nw-ink);font-weight:600}

/* The grid frame. A head row on the sunken rung under a full-ink rule, rows
   hairlined, and the whole thing scrolling inside its own box so a wide axis
   never widens the page. */
.gridwrap{overflow-x:auto;border:1px solid var(--nw-line)}
table.heat{border-collapse:collapse;width:100%}
table.heat thead th{font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;font-weight:600;color:var(--nw-ink3);padding:8px 10px;text-align:start;background:var(--nw-sunken);border-bottom:1px solid var(--nw-ink);white-space:nowrap}
table.heat thead th small{display:block;font-weight:400;letter-spacing:0;text-transform:none}
table.heat td{padding:0;border-bottom:1px solid var(--nw-lineS)}
table.heat tbody th{padding:7px 12px;font-weight:600;text-align:start;white-space:nowrap;border-bottom:1px solid var(--nw-lineS)}
table.heat tbody th small{font-weight:400;color:var(--nw-ink3);margin-inline-start:6px}
table.heat tbody tr:last-child th,table.heat tbody tr:last-child td{border-bottom:none}

/* The cell. A quiet tint carrying the state's WORD — never a saturated fill,
   and never colour alone: the word is the primary carrier and the tint is the
   second reading, so a cell stays legible to a reader who sees no hue. */
.cell{display:block;width:100%;border:none;font:inherit;text-align:center;padding:7px 10px;cursor:pointer;background:transparent;color:var(--nw-ink2);font-size:11.5px;font-weight:600}
.cell:hover{outline:1px solid var(--nw-ink3);outline-offset:-1px}
.cell small{font-weight:400;margin-inline-start:5px;color:inherit}

/* The state register — ONE HUE, ONE MEANING (#864).
   Seven families, and a family answers exactly one question: ok (passed against
   a solid claim), partial (passed, partial claim), danger (tonight's run went
   wrong), flaky (unreliable, not broken), gap (no test exists), attn (the
   report cannot vouch for its own evidence), grey (evidence absent). No tint
   appears in two families, so a reader who has learned one hue has learned one
   fact. Inside a family each state still differs by weight, slope or rule.
   ONE cross-family collapse survives and is asserted by name in
   report-theme.test.mjs: infra-mismatch rides the consequence tint with failed,
   because both mean "the run went wrong tonight" and the word tells them apart.
   Within grey, lane-did-not-run is byte-identical to stale — the legend prints
   them as one entry — and that pair is asserted too. */
.cell.passed{background:var(--nw-okbg);color:var(--nw-ok)}
.cell.passed.assessment-partial{background:var(--nw-partialbg);color:var(--nw-partial)}
.cell.failed,.cell.infra-mismatch{background:var(--nw-dangerbg);color:var(--nw-danger)}
.cell.flaky{background:var(--nw-flakybg);color:var(--nw-flaky)}
.cell.owner-silent{background:var(--nw-attnbg);color:var(--nw-attn);font-style:italic}
.cell.evidence-unmatched{background:var(--nw-attnbg);color:var(--nw-attn);font-style:italic;font-weight:400}
.cell.stale,.cell.lane-did-not-run{background:var(--nw-greybg);color:var(--nw-ink3);font-style:italic}
.cell.missing{background:var(--nw-greybg);color:var(--nw-ink3);font-style:italic;font-weight:400}
.cell.expected-grey{background:var(--nw-greybg);color:var(--nw-ink3);font-style:italic;border-bottom:1px dashed var(--nw-grey)}
.cell.skipped{background:transparent;color:var(--nw-ghost);font-weight:400}

/* The app-axis grids speak DECLARATION, not health, so an owned seat is neutral
   ink on raised paper, never the green that on this page means "evidence ran and
   passed". The other two cells are not a private alphabet: "nobody owns this
   yet" is the SAME fact §8 calls a gap, and it takes the same paint and the same
   word on every grid (#864) — before, the matrix painted it red and the app
   grids painted it grey, so the page contradicted itself about whether a missing
   test was tonight's emergency or nobody's. "n/a" is likewise one treatment. */
.cell.axis-declared{background:var(--nw-surf);color:var(--nw-ink)}
.cell.gap,.cell.axis-unowned{background:var(--nw-gapbg);color:var(--nw-gap);font-weight:400}
.cell.axis-skipped{background:transparent;color:var(--nw-ghost);font-weight:400}

/* The painted legend. The old keyline glossed the register in coloured TEXT
   below one grid, which asked the reader to map a word's ink onto a cell's
   tint — two different treatments for one state. A legend chip now carries the
   cell's own classes, so it is the treatment rather than a description of it,
   and it sits ABOVE every grid that uses the register instead of after one of
   them. Only geometry is overridden here: an inline chip rather than a full
   table cell, and no pointer, because nothing here is pressable. */
.legend{display:flex;gap:6px 18px;flex-wrap:wrap;font-size:11px;color:var(--nw-ink3);margin:0 0 8px;padding:0;list-style:none}
.legend li{display:flex;align-items:baseline;gap:6px;max-width:46ch}
.legend .cell{display:inline-block;width:auto;padding:2px 8px;cursor:default}

/* §1's severity bands: prose about a ladder, not the cell register. */
.keyline{display:flex;gap:16px;flex-wrap:wrap;font-size:11px;color:var(--nw-ink3);margin:8px 0 0}
.keyline i{font-style:normal;font-weight:600}

/* The evidence inspector: a bottom sheet, closed until a cell is chosen.
   It is fixed rather than in-flow because every grid on the page opens it and
   the grids are pages apart — an in-flow panel under §8 means choosing a cell
   in §2 scrolls the answer off screen. Nothing focuses it, nothing traps focus
   in it, and it covers the footer only while it is open. The lift is mixed
   from the ink rung rather than from black, so it separates the sheet from the
   page in BOTH themes instead of vanishing into the night one. */
#inspector{position:fixed;inset-inline:0;bottom:0;z-index:20;display:none;background:var(--nw-ground);border-top:2px solid var(--nw-ink);padding:14px 24px 18px;box-shadow:0 -6px 24px color-mix(in oklab,var(--nw-ink) 14%,transparent)}
#inspector.open{display:block}
#inspector .inwrap{max-width:1060px;margin:0 auto;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 20px;max-height:46vh;overflow:auto}
#inspector .kicker{color:var(--nw-ink3);font-size:11px;letter-spacing:.05em;text-transform:uppercase;font-weight:600}
#inspector h3{margin:2px 0 6px;font-size:14px;font-weight:600}
#inspector button.close{border:1px solid var(--nw-line);border-radius:var(--r-md);background:var(--nw-surf);color:var(--nw-ink);font:inherit;font-weight:600;padding:4px 14px;cursor:pointer;align-self:start}
.flow-list{display:grid;gap:8px}
.flow{display:grid;grid-template-columns:minmax(150px,.45fr) 78px 84px 84px minmax(230px,1fr);gap:12px;align-items:center;padding:6px 0;border-bottom:1px solid var(--nw-lineS)}
.flow:last-child{border-bottom:0}
.tier{color:var(--nw-ink3);font-size:10.5px;letter-spacing:.05em;text-transform:uppercase}
.result{font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;font-weight:600}
.result.passed{color:var(--nw-ok)}
.result.failed,.result.infra-mismatch{color:var(--nw-danger)}
.result.flaky{color:var(--nw-flaky)}
.result.owner-silent,.result.evidence-unmatched{color:var(--nw-attn)}
.result.skipped{color:var(--nw-ghost)}
.result.missing,.result.stale,.result.lane-did-not-run,.result.expected-grey{color:var(--nw-ink3)}

/* The detail shelf: the archive report v1 was, kept whole below the fold. */
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}
.card{border:1px solid var(--nw-line);background:var(--nw-surf);padding:14px 16px;overflow:auto}
.card h2,.card h3{font-size:11px;letter-spacing:.05em;text-transform:uppercase;font-weight:600;margin:0 0 8px;color:var(--nw-ink2)}
.wide{grid-column:1/-1}
.matrix-scroll{overflow-x:auto}
.data{border-collapse:collapse;width:100%}
.data th,.data td{text-align:start;border-bottom:1px solid var(--nw-lineS);padding:6px 8px;font-size:11.5px;vertical-align:top}
.data th{color:var(--nw-ink3);font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;font-weight:600;background:var(--nw-sunken);border-bottom:1px solid var(--nw-ink);white-space:nowrap}
.metric{font-weight:600}
.metric.passed{color:var(--nw-ok)}
.metric.failed{color:var(--nw-danger)}
.metric.missing{color:var(--nw-ink3)}
.metric small{margin-inline-start:4px;font-weight:400;color:var(--nw-ink3)}
.empty{color:var(--nw-ink3);border:1px dashed var(--nw-line);padding:12px;margin:0;font-size:12px}
.trend-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:8px}
.trend{display:flex;justify-content:space-between;gap:12px;align-items:center;background:var(--nw-sunken);border:1px solid var(--nw-line);padding:10px 12px}
.trend strong,.trend small{display:block}
.trend strong{font-variant-numeric:var(--t-mono-numeric)}
/* Sparklines. Stroke and dot are styled here, not on the SVG element: a var()
   inside an SVG presentation attribute is not reliably resolved, so a token
   named there would silently paint black. */
.spark{width:96px;height:22px;vertical-align:middle}
.spark polyline{fill:none;stroke:var(--nw-ink3);stroke-width:1.5;vector-effect:non-scaling-stroke}
.spark circle{fill:var(--nw-ink)}
.foot{margin-top:40px;font-size:11px;color:var(--nw-ghost)}

/* The user-facing qualities panel. */
.qualities-shell{border:1px solid var(--nw-line);background:var(--nw-surf);padding:12px 16px;margin-top:14px}
.qualities-shell h2{font-size:11px;letter-spacing:.05em;text-transform:uppercase;font-weight:600;margin:0 0 6px;color:var(--nw-ink2)}
.quality-row{border-top:1px solid var(--nw-lineS)}
.quality-row summary{display:grid;grid-template-columns:14px 180px minmax(0,1fr) 72px;gap:8px;align-items:center;padding:9px 0;cursor:pointer}
.quality-row summary b{text-align:end;font-variant-numeric:var(--t-mono-numeric)}
.quality-light{width:9px;height:9px;border-radius:var(--r-pill);background:var(--nw-grey)}
.quality-light.passed{background:var(--nw-ok)}
.quality-light.partial{background:var(--nw-attn)}
.quality-light.failed{background:var(--nw-danger)}
.quality-gates{padding:0 0 8px 20px}
.quality-gates>div{display:grid;grid-template-columns:12px minmax(180px,.7fr) minmax(260px,1fr);gap:8px;align-items:center;padding:3px 0}
.quality-gates code{color:var(--nw-ink3);overflow-wrap:anywhere}
.quality-debt{color:var(--nw-ink3);font-size:11px;margin:8px 0 0}
.dot{display:inline-block;width:7px;height:7px;border-radius:var(--r-pill);margin-inline-end:4px;background:var(--nw-grey)}
.dot.passed{background:var(--nw-ok)}
.dot.partial{background:var(--nw-attn)}
.dot.failed{background:var(--nw-danger)}
.dot.missing{background:none;border:2px solid var(--nw-grey)}

@media(max-width:760px){
.page{padding:24px 0 90px}
.delta{border-inline-start:none;padding-inline-start:0}
.qrow{grid-template-columns:80px 1fr}
.qrow .own,.qrow .age,.qrow .act{display:none}
.consent .lrow{grid-template-columns:130px 1fr 90px}
.consent .lrow>:nth-child(3),.consent .lrow>:nth-child(4){display:none}
.joins .lrow,.journeys .lrow{grid-template-columns:1fr 90px}
.joins .lrow>:nth-child(2),.joins .lrow>:nth-child(3),.journeys .lrow>:nth-child(2),.journeys .lrow>:nth-child(3){display:none}
.adv .lrow{grid-template-columns:1fr 80px 80px}
.adv .lrow>:nth-child(4),.adv .lrow>:nth-child(5){display:none}
.grid{grid-template-columns:1fr}
.wide{grid-column:auto}
#inspector .inwrap{grid-template-columns:1fr}
.flow{grid-template-columns:1fr}
.quality-row summary,.quality-gates>div{grid-template-columns:14px 1fr}
.quality-row summary span:nth-of-type(2),.quality-row summary b,.quality-gates code{grid-column:2}
}
`;
