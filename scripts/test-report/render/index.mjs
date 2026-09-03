import { designSystemCss, REPORT_CSS } from "../report-theme.mjs";
import { renderAdversaries, renderTrends } from "./adversaries.mjs";
import { renderEvidence, renderHowToRead } from "./evidence.mjs";
import { renderCoverage, renderPromises } from "./grids.mjs";
import { renderJourneys, renderLaneBoard } from "./lane-board.mjs";
import { renderMasthead, renderRail } from "./masthead.mjs";
import {
  renderAttention,
  renderBlockers,
  renderSinceYesterday,
} from "./questions.mjs";
import { escapeHtml } from "./util.mjs";

const PAGE_SCRIPT = `
(function(){
  var table = document.getElementById('laneTable');
  if(!table) return;
  var state = {rung:'all', plat:null, attention:false, q:''};
  function apply(){
    var rows = table.querySelectorAll('tr.lanerow');
    for(var i=0;i<rows.length;i++){
      var row = rows[i];
      var detail = document.getElementById(row.getAttribute('aria-controls'));
      var ok = (state.rung==='all' || row.dataset.rung===state.rung)
        && (!state.plat || row.dataset.plat===state.plat)
        && (!state.attention || row.dataset.attention==='true')
        && (!state.q || row.dataset.name.toLowerCase().indexOf(state.q)>=0);
      row.hidden = !ok;
      if(detail && !ok) detail.hidden = true;
    }
  }
  var filters = document.getElementById('laneFilters');
  filters.addEventListener('click', function(event){
    var button = event.target.closest('button.chip');
    if(!button) return;
    var parts = button.dataset.f.split(':');
    if(parts[0]==='rung') state.rung = parts[1];
    if(parts[0]==='plat') state.plat = state.plat===parts[1] ? null : parts[1];
    if(parts[0]==='only') state.attention = !state.attention;
    var chips = filters.querySelectorAll('button.chip');
    for(var i=0;i<chips.length;i++){
      var chip = chips[i], own = chip.dataset.f.split(':');
      chip.setAttribute('aria-pressed', String(own[0]==='rung' ? state.rung===own[1] : own[0]==='plat' ? state.plat===own[1] : state.attention));
    }
    apply();
  });
  var search = document.getElementById('laneSearch');
  search.addEventListener('input', function(event){ state.q = event.target.value.toLowerCase(); apply(); });
  table.addEventListener('click', function(event){ toggle(event.target.closest('tr.lanerow')); });
  table.addEventListener('keydown', function(event){
    if(event.key!=='Enter' && event.key!==' ') return;
    event.preventDefault();
    toggle(event.target.closest('tr.lanerow'));
  });
  function toggle(row){
    if(!row) return;
    var detail = document.getElementById(row.getAttribute('aria-controls'));
    if(!detail) return;
    detail.hidden = !detail.hidden;
    row.setAttribute('aria-expanded', String(!detail.hidden));
  }
  document.addEventListener('keydown', function(event){
    if(event.target.matches('input,textarea,select')) return;
    if(event.key==='/'){ event.preventDefault(); search.focus(); }
    if(event.key==='e'){
      var details = table.querySelectorAll('tr.detail');
      for(var i=0;i<details.length;i++) details[i].hidden = false;
    }
    if(event.key==='?'){ document.getElementById('read').scrollIntoView(); }
  });
  var modes = document.querySelectorAll('[data-mode]');
  for(var m=0;m<modes.length;m++){
    modes[m].addEventListener('click', function(event){
      var wanted = event.currentTarget.dataset.mode;
      var buttons = document.querySelectorAll('[data-mode]');
      for(var b=0;b<buttons.length;b++) buttons[b].setAttribute('aria-pressed', String(buttons[b].dataset.mode===wanted));
      var grids = document.querySelectorAll('[data-grid]');
      for(var g=0;g<grids.length;g++) grids[g].hidden = grids[g].dataset.grid!==wanted;
    });
  }
})();
`;

export function renderReport(model) {
  const title = `Night Watch — ${model.night} — ${model.verdict.verdict}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${designSystemCss()}
${REPORT_CSS}</style>
</head>
<body>
<div class="page">
${renderMasthead(model)}
${renderRail(model)}
<main>
${renderBlockers(model)}
${renderSinceYesterday(model)}
${renderAttention(model)}
${renderLaneBoard(model)}
${renderJourneys(model)}
${renderCoverage(model)}
${renderPromises(model)}
${renderAdversaries(model)}
${renderTrends(model)}
${renderEvidence(model)}
${renderHowToRead(model)}
<footer>
  <span>Night Watch · report generated ${escapeHtml(model.generatedAt)} from ${model.lanes.length} registered lanes</span>
  ${model.links?.permalink ? `<span>immutable copy: <span class="mono">${escapeHtml(model.links.permalink)}</span></span>` : ""}
  <span>cite the dated copy, never the alias</span>
</footer>
</main>
</div>
<script>${PAGE_SCRIPT}</script>
</body>
</html>
`;
}
