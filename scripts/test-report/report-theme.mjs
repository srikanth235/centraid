import { readFileSync } from "node:fs";
import path from "node:path";

const SHEET = path.join(import.meta.dirname, "report-tokens.css");

const REQUIRED = ["--font-sans:", "--st-solid:"];

export function verifySheet(css, label = path.basename(SHEET)) {
  for (const marker of REQUIRED) {
    if (!css.includes(marker)) {
      throw new Error(
        `test report: ${label} declares no ${marker.slice(0, -1)} — re-emit it with \`bun run site:tokens\``
      );
    }
  }
  if (/src:\s*url\((?!data:)/u.test(css)) {
    throw new Error(
      `test report: ${label} links a face instead of inlining it — the run archives would render unstyled`
    );
  }
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

export const REPORT_CSS = `
*{box-sizing:border-box}
body{margin:0;background:var(--nw-ground);color:var(--nw-ink);font-family:var(--font-sans);font-size:var(--t-body-size);line-height:1.5}
.page{position:relative;max-width:1380px;margin:0 auto;padding:28px 28px 120px;display:grid;grid-template-columns:minmax(0,1fr);gap:0 36px}
@media(min-width:1180px){.page{grid-template-columns:minmax(0,1fr) 250px}}
main{grid-column:1;min-width:0}
section{margin-top:var(--sp-band);scroll-margin-top:24px}
a{color:var(--nw-link);text-decoration:none;border-bottom:1px solid transparent}
a:hover,a:focus-visible{border-bottom-color:currentcolor}
button:focus-visible,a:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--nw-ring);outline-offset:2px}
.mono,.sha,.num,.eyebrow,kbd,.plat,.lbl,pre,code{font-family:var(--font-code)}
.num{font-variant-numeric:var(--t-mono-numeric);text-align:right;white-space:nowrap}
.eyebrow{font-size:var(--t-eyebrow-size);letter-spacing:var(--t-eyebrow-tracking);text-transform:var(--t-eyebrow-transform);color:var(--nw-ink3)}
h2{font:var(--t-display);letter-spacing:var(--t-display-tracking);margin:0 0 4px;text-wrap:balance}
h2 .q{font-style:italic;font-weight:400;color:var(--nw-ink2)}
h3{font-size:var(--t-band-size);font-weight:600;letter-spacing:var(--t-eyebrow-tracking);text-transform:uppercase;color:var(--nw-ink3);margin:0 0 10px}
h4{font-size:var(--t-body-size);font-weight:600;margin:0 0 8px}
p{max-width:var(--measure-reading);margin:0 0 10px}
.small,small{font-size:var(--t-small-size);color:var(--nw-ink3)}
.sub{color:var(--nw-ink2);font-size:var(--t-body-size);margin:0 0 18px;max-width:var(--measure-lede)}

/* Masthead + verdict lamp (S0). The masthead's rule is full ink: it is the
   one line on the page that closes the run's identity. */
header.mast{grid-column:1 / -1;display:grid;grid-template-columns:auto 1fr;gap:20px 28px;align-items:end;padding-bottom:22px;border-bottom:1px solid var(--nw-ink)}
.brand{font:var(--t-display);font-size:calc(var(--t-display-size) * 1.6);line-height:1;letter-spacing:var(--t-display-tracking)}
.mastmeta{display:flex;flex-wrap:wrap;gap:8px 22px;font-family:var(--font-code);font-size:var(--t-mono-size);color:var(--nw-ink3);align-items:baseline}
.mastmeta .k{color:var(--nw-ghost)}
.mastmeta .v{color:var(--nw-ink2)}
.verdict{grid-column:1;display:grid;grid-template-columns:auto minmax(0,1fr);gap:0 24px;align-items:center;margin-top:22px;padding:22px 26px;background:var(--nw-surf);border:1px solid var(--nw-line);border-radius:10px}
.lamp{width:96px;height:96px;border-radius:50%;display:grid;place-items:center;background:var(--nw-greybg);border:1px solid var(--nw-grey)}
.lamp::before{content:"";width:68px;height:68px;border-radius:50%;background:var(--nw-grey)}
.verdict.hold .lamp{background:var(--nw-dangerbg);border-color:var(--nw-danger)}
.verdict.hold .lamp::before{background:var(--nw-danger)}
.verdict.hold .vword{color:var(--nw-danger)}
.verdict.degraded .lamp{background:var(--nw-attnbg);border-color:var(--nw-attn)}
.verdict.degraded .lamp::before{background:var(--nw-attn)}
.verdict.degraded .vword{color:var(--nw-attn)}
.verdict.shippable .lamp{background:var(--nw-okbg);border-color:var(--nw-ok)}
.verdict.shippable .lamp::before{background:var(--nw-ok)}
.verdict.shippable .vword{color:var(--nw-ok)}
.vword{font:var(--t-display);font-size:var(--t-hero-size);line-height:1;letter-spacing:var(--t-display-tracking);margin:0}
.vwhy{font-size:var(--t-reading-size);color:var(--nw-ink);margin:10px 0 0;max-width:var(--measure-lede)}
.vdelta{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:12px;font-family:var(--font-code);font-size:var(--t-mono-size);color:var(--nw-ink3)}
.vdelta b{color:var(--nw-ink2);font-weight:500}

/* The rail: sections, the state legend, the keys. */
.rail{display:none}
@media(min-width:1180px){.rail{display:block;position:sticky;top:20px;align-self:start;grid-column:2;grid-row:2 / span 40}}
.rail nav ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.rail nav a{display:flex;justify-content:space-between;gap:8px;padding:6px 10px;border-radius:6px;color:var(--nw-ink3);font-size:var(--t-small-size);border:0}
.rail nav a:hover,.rail nav a:focus-visible{background:var(--nw-surf);color:var(--nw-ink)}
.rail nav a .cnt{font-family:var(--font-code);font-size:var(--t-mono-size);color:var(--nw-ghost)}
.rail .box{margin-top:22px;padding:14px;border:1px solid var(--nw-line);border-radius:8px;background:var(--nw-surf)}
.legend{display:grid;grid-template-columns:auto 1fr;gap:6px 10px;font-size:var(--t-small-size);color:var(--nw-ink2);align-items:center}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block;background:var(--nw-grey)}
.dot.d-ok{background:var(--nw-ok)}
.dot.d-bad{background:var(--nw-danger)}
.dot.d-park{background:var(--nw-park)}
.dot.d-attn{background:var(--nw-attn)}
kbd{font-family:var(--font-code);font-size:var(--t-mono-size);border:1px solid var(--nw-line);border-bottom-width:2px;border-radius:4px;padding:0 5px;color:var(--nw-ink2)}

/* Pills, severities, chips. */
.pill{display:inline-flex;align-items:center;gap:6px;font-family:var(--font-code);font-size:var(--t-mono-size);font-weight:600;letter-spacing:var(--t-eyebrow-tracking);text-transform:uppercase;padding:2px 8px;border-radius:4px;white-space:nowrap;background:var(--nw-greybg);color:var(--nw-grey)}
.pill.passed{background:var(--nw-okbg);color:var(--nw-ok)}
.pill.failed{background:var(--nw-dangerbg);color:var(--nw-danger)}
.pill.parked{background:var(--nw-parkbg);color:var(--nw-park)}
.pill.degraded{background:var(--nw-attnbg);color:var(--nw-attn)}
.pill.no-evidence{background:var(--nw-greybg);color:var(--nw-grey)}
.pill.na{background:transparent;color:var(--nw-ink3)}
.pill.gating{background:var(--nw-attnbg);color:var(--nw-attn)}
.pill.advisory{background:var(--nw-greybg);color:var(--nw-grey)}
.sev{display:inline-grid;place-items:center;min-width:28px;height:22px;border-radius:4px;font-family:var(--font-code);font-size:var(--t-mono-size);font-weight:600;border:1px solid currentcolor}
.sev.s1{background:var(--nw-danger);color:var(--nw-ground);border-color:var(--nw-danger)}
.sev.s2{background:var(--nw-dangerbg);color:var(--nw-danger)}
.sev.s3{background:var(--nw-attnbg);color:var(--nw-attn)}
.sev.s4{background:var(--nw-greybg);color:var(--nw-ink3)}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 14px}
.chip{font-family:var(--font-code);font-size:var(--t-mono-size);padding:4px 10px;border:1px solid var(--nw-line);border-radius:999px;background:var(--nw-surf);color:var(--nw-ink2);cursor:pointer}
.chip[aria-pressed="true"]{background:var(--nw-attnbg);border-color:var(--nw-attn);color:var(--nw-attn)}
.gapchip{display:inline-block;width:12px}

/* Cards and tables. */
.card{background:var(--nw-surf);border:1px solid var(--nw-line);border-radius:10px}
.tablewrap{overflow-x:auto;border:1px solid var(--nw-line);border-radius:10px;background:var(--nw-surf)}
table{border-collapse:collapse;width:100%;font-size:var(--t-small-size)}
th,td{text-align:start;vertical-align:middle;padding:10px 12px;border-bottom:1px solid var(--nw-lineS)}
th{position:sticky;top:0;background:var(--nw-sunken);font-family:var(--font-code);font-size:var(--t-mono-size);letter-spacing:var(--t-eyebrow-tracking);text-transform:uppercase;color:var(--nw-ink3);font-weight:500;z-index:1}
tbody tr:last-child td{border-bottom:none}
td .lane{font-family:var(--font-code);color:var(--nw-ink);font-weight:500}
td .desc{display:block;font-size:var(--t-small-size);color:var(--nw-ink3);margin-top:2px}
.sha{font-size:var(--t-mono-size);color:var(--nw-ink2);background:var(--nw-sunken);padding:1px 6px;border-radius:4px}
.age.over{color:var(--nw-danger);font-weight:600}
.age.ok{color:var(--nw-ink3)}
.owner.none{color:var(--nw-danger);font-style:italic}
.plat{font-size:var(--t-mono-size);color:var(--nw-ink3);letter-spacing:var(--t-eyebrow-tracking);text-transform:uppercase}
tr.detail td{background:var(--nw-sunken);padding:10px 12px 14px 44px}
.cases{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:6px 18px;font-family:var(--font-code);font-size:var(--t-mono-size)}
.cases .c{display:flex;justify-content:space-between;gap:12px}
.cases .c span:last-child{color:var(--nw-ink3)}
tr.suite td{background:var(--nw-sunken);font-family:var(--font-code);font-size:var(--t-mono-size);letter-spacing:var(--t-eyebrow-tracking);text-transform:uppercase;color:var(--nw-ink3)}
tr.suite td b{color:var(--nw-ink);font-weight:600;letter-spacing:normal;text-transform:none;font-family:var(--font-sans)}
tr.suite td .sb{float:right;letter-spacing:normal;text-transform:none}
.alarm{display:inline-flex;gap:8px;align-items:center;padding:8px 12px;border:1px solid var(--nw-line);border-radius:8px;background:var(--nw-surf);font-size:var(--t-small-size);margin-bottom:12px}
.alarm .bell{width:10px;height:10px;border-radius:50%;background:var(--nw-ok)}

/* Since-yesterday columns. */
.changes{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.changes .col{padding:14px 16px}
.changes .col h4{display:flex;justify-content:space-between;align-items:center;font-family:var(--font-code);font-size:var(--t-mono-size);letter-spacing:var(--t-eyebrow-tracking);text-transform:uppercase}
.changes .col h4 .n{font:var(--t-title)}
.changes ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.changes li{font-size:var(--t-small-size);display:flex;flex-direction:column;gap:2px}
.changes li .lane{font-family:var(--font-code)}
.changes li .why{color:var(--nw-ink3)}
.changes .col.red h4{color:var(--nw-danger)}
.changes .col.green h4{color:var(--nw-ok)}
.changes .col.parkedcol h4{color:var(--nw-park)}
.changes .col.expiring h4{color:var(--nw-attn)}
.changes .empty{color:var(--nw-ghost);font-style:italic}

/* Sparklines and budget bars. */
.spark{width:120px;height:22px;display:block}
.spark .s-ok{fill:var(--nw-ok)}
.spark .s-bad{fill:var(--nw-danger)}
.spark .s-park{fill:var(--nw-park)}
.spark .s-none{fill:var(--nw-greybg)}
.budget{display:inline-flex;align-items:center;gap:8px;min-width:170px}
.budget .track{flex:1;height:6px;border-radius:3px;background:var(--nw-sunken);position:relative;overflow:hidden;min-width:60px}
.budget .fill{position:absolute;inset:0 auto 0 0;border-radius:3px;background:var(--nw-ok)}
.budget .fill.near{background:var(--nw-attn)}
.budget .fill.over{background:var(--nw-danger)}
.budget .lbl{font-size:var(--t-mono-size);color:var(--nw-ink3);white-space:nowrap}
.rate.low{color:var(--nw-danger)}

/* The cell register — four states plus n/a, one family each. */
.cell{display:flex;flex-direction:column;gap:2px;padding:8px;background:transparent;color:var(--nw-ink2)}
.cell.passed{background:var(--nw-okbg);color:var(--nw-ok)}
.cell.failed{background:var(--nw-dangerbg);color:var(--nw-danger);font-weight:600}
.cell.parked{background:var(--nw-parkbg);color:var(--nw-park)}
.cell.degraded{background:var(--nw-attnbg);color:var(--nw-attn)}
/* Absence is a grey TINT with the page's quiet ink on it, not the grey mark
   rung: --nw-grey is a mark colour and reads at 3.0:1 on its own tint in
   light, which is a word a reader has to squint at to learn that nothing
   reported. The tint still carries the family; the ink carries the word. */
.cell.no-evidence{background:var(--nw-greybg);color:var(--nw-ink3)}
.cell.na{background:transparent;color:var(--nw-ink3);font-style:italic}
.cell .st{font-family:var(--font-code);font-size:var(--t-mono-size);font-weight:600}
.cell .ln{font-family:var(--font-code);font-size:var(--t-mono-size);color:var(--nw-ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* Coverage grid and promises heat grid. */
.pgrid{display:grid;grid-template-columns:150px repeat(4,minmax(120px,1fr));border:1px solid var(--nw-line);border-radius:10px;overflow:hidden;background:var(--nw-surf);font-size:var(--t-small-size)}
.pgrid>div{border-bottom:1px solid var(--nw-lineS);border-inline-end:1px solid var(--nw-lineS)}
.pgrid>div:nth-child(5n){border-inline-end:none}
.pgrid .h,.heat .h{background:var(--nw-sunken);font-family:var(--font-code);font-size:var(--t-mono-size);letter-spacing:var(--t-eyebrow-tracking);text-transform:uppercase;color:var(--nw-ink3);padding:8px}
.pgrid .app,.heat .qn{font-weight:600;padding:8px}
.pgrid .rung{font-family:var(--font-code);font-size:var(--t-mono-size);font-weight:600}
.pgrid .states{display:flex;gap:3px;flex-wrap:wrap}
.pgrid .st-box{width:14px;height:14px;border-radius:3px;background:var(--nw-sunken);display:grid;place-items:center;font-family:var(--font-code);font-size:var(--t-mono-size);color:var(--nw-ghost)}
.pgrid .st-box.on{background:var(--nw-okbg);color:var(--nw-ok)}
.pgrid .foot,.heat .foot{grid-column:1 / -1;font-size:var(--t-small-size);color:var(--nw-ink3);border-bottom:none;padding:8px}
.heatwrap{overflow-x:auto}
.heat{display:grid;grid-template-columns:150px repeat(10,minmax(64px,1fr));border:1px solid var(--nw-line);border-radius:10px;overflow:hidden;background:var(--nw-surf);font-size:var(--t-mono-size)}
.heat>div{border-bottom:1px solid var(--nw-lineS);border-inline-end:1px solid var(--nw-lineS);min-height:38px}
.heat>div:nth-child(11n){border-inline-end:none}
.verbs{display:flex;gap:6px;flex-wrap:wrap}
.verb{font-family:var(--font-code);font-size:var(--t-mono-size);padding:2px 7px;border-radius:4px;background:var(--nw-sunken);color:var(--nw-ink2)}
.verb.zero{color:var(--nw-danger);background:var(--nw-dangerbg)}

/* Adversaries and trends. */
.adv{display:grid;grid-template-columns:1fr;gap:12px}
@media(min-width:900px){.adv{grid-template-columns:1fr 1fr}}
.adv .card{padding:14px 16px}
.adv .card.wide{grid-column:1 / -1}
.adv .card .tablewrap{margin-top:8px}
.bar{display:inline-block;height:6px;border-radius:3px;background:var(--nw-ok);vertical-align:middle;margin-inline-end:6px}
.bar.low{background:var(--nw-attn)}
.trends{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.trend{padding:14px 16px}
.trend .t{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:6px}
.trend .last.out-bad{color:var(--nw-danger)}
.trend .last.out-ok{color:var(--nw-ok)}
.trend svg{width:100%;height:70px;display:block}
.trend .band{fill:var(--nw-attnbg)}
.trend .line{fill:none;stroke:var(--nw-ink2);stroke-width:1.5}
.trend .quart{stroke:var(--nw-line);stroke-dasharray:2 3}
.trend .end{fill:var(--nw-attn)}
.trend .end.out-bad{fill:var(--nw-danger)}
.trend .end.out-ok{fill:var(--nw-ok)}
.trend .foot{display:flex;justify-content:space-between;font-family:var(--font-code);font-size:var(--t-mono-size);color:var(--nw-ghost);margin-top:4px}

/* Evidence appendix and the glossary. */
details.app{border:1px solid var(--nw-line);border-radius:10px;background:var(--nw-surf);margin-bottom:10px}
details.app summary{cursor:pointer;padding:12px 16px;font-weight:600;display:flex;justify-content:space-between;align-items:center;gap:12px}
details.app summary .sum{font-family:var(--font-code);font-size:var(--t-mono-size);color:var(--nw-ink3);font-weight:400}
details.app .body{padding:0 16px 14px}
.gloss{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px 24px;font-size:var(--t-small-size)}
.gloss dt{font-family:var(--font-code);font-size:var(--t-mono-size);font-weight:600;color:var(--nw-ink)}
.gloss dd{margin:2px 0 0;color:var(--nw-ink2)}
pre{font-size:var(--t-mono-size);line-height:1.5;background:var(--nw-sunken);border:1px solid var(--nw-line);padding:12px 14px;border-radius:8px;overflow-x:auto;color:var(--nw-ink2)}
.errors{border:1px solid var(--nw-danger);background:var(--nw-dangerbg);color:var(--nw-danger);border-radius:8px;padding:12px 16px;margin-top:18px}
.errors ul{margin:6px 0 0;padding-inline-start:18px}
.obs li{margin:0 0 8px}
.obs .age{color:var(--nw-ink3);margin-inline-start:6px}
footer{margin-top:var(--sp-band);padding-top:18px;border-top:1px solid var(--nw-line);font-size:var(--t-small-size);color:var(--nw-ink3);display:flex;flex-wrap:wrap;gap:6px 24px}

@media(max-width:720px){
.page{padding:18px 14px 80px}
.verdict{grid-template-columns:minmax(0,1fr)}
.lamp{display:none}
.pgrid{grid-template-columns:110px repeat(4,minmax(90px,1fr))}
}
`;
