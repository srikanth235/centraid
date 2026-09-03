const ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value) {
  return String(value ?? "").replaceAll(/[&<>"']/gu, (char) => ESCAPES[char]);
}

export const STATE_WORDS = Object.freeze({
  passed: { class: "passed", word: "passed" },
  failed: { class: "failed", word: "failed" },
  parked: { class: "parked", word: "parked" },
  degraded: { class: "degraded", word: "degraded" },
  "no-evidence": { class: "no-evidence", word: "no evidence" },
  "n/a": { class: "na", word: "n/a" },
});

export function pill(state, label) {
  const entry = STATE_WORDS[state] ?? STATE_WORDS["no-evidence"];
  return `<span class="pill ${entry.class}">${escapeHtml(label ?? entry.word)}</span>`;
}

export function sev(severity) {
  const safe = /^S[1-4]$/u.test(String(severity)) ? severity : "S4";
  return `<span class="sev ${safe.toLowerCase()}">${safe}</span>`;
}

export function ms(value) {
  if (!Number.isFinite(value)) return "—";
  const minutes = value / 60_000;
  return minutes >= 60
    ? `${(minutes / 60).toFixed(1)}h`
    : `${minutes.toFixed(1)}m`;
}

export function secs(value) {
  return Number.isFinite(value) ? `${Math.round(value / 1000)}s` : "—";
}

export function sha(value) {
  return value
    ? `<span class="sha">${escapeHtml(String(value).slice(0, 9))}</span>`
    : "—";
}

export function issueLink(number, repoUrl) {
  if (!number) return "—";
  const href = repoUrl ? `${repoUrl}/issues/${number}` : `#${number}`;
  return `<a href="${escapeHtml(href)}">#${escapeHtml(number)}</a>`;
}

export function sparkline(words, label) {
  const width = 3;
  const gap = 1;
  const height = 22;
  const bars = words
    .map((word, index) => {
      const tone =
        word === "passed"
          ? "s-ok"
          : word === "failed"
            ? "s-bad"
            : word === "parked"
              ? "s-park"
              : "s-none";
      const barHeight =
        word === "no-evidence" ? 4 : word === "passed" ? 14 : 20;
      return `<rect class="${tone}" x="${index * (width + gap)}" y="${height - barHeight}" width="${width}" height="${barHeight}"/>`;
    })
    .join("");
  return `<svg class="spark" viewBox="0 0 ${words.length * (width + gap)} ${height}" role="img" aria-label="last ${words.length} candidates for ${escapeHtml(label)}">${bars}</svg>`;
}

export function budgetBar(observed, budget) {
  const ratio = budget > 0 && Number.isFinite(observed) ? observed / budget : 0;
  const tone = ratio > 1 ? "over" : ratio > 0.9 ? "near" : "";
  const width = Math.min(100, ratio * 100).toFixed(0);
  return `<span class="budget"><span class="track"><span class="fill ${tone}" style="width:${width}%"></span></span><span class="lbl">${ms(observed)} / ${ms(budget)}</span></span>`;
}

export function table(head, body, id) {
  return `<div class="tablewrap"><table${id ? ` id="${id}"` : ""}><thead><tr>${head
    .map((cell) => `<th>${cell}</th>`)
    .join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function details(summary, note, body) {
  return `<details class="app"><summary>${escapeHtml(summary)}<span class="sum">${escapeHtml(note)}</span></summary><div class="body">${body}</div></details>`;
}

export function section(id, eyebrow, heading, gloss, lede, body) {
  return `<section id="${id}">
  <div class="eyebrow">${escapeHtml(eyebrow)}</div>
  <h2>${escapeHtml(heading)} <span class="q">— ${escapeHtml(gloss)}</span></h2>
  <p class="sub">${escapeHtml(lede)}</p>
  ${body}
</section>`;
}
