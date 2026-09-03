const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);

function inline(raw: string): string {
  let s = escapeHtml(raw);
  s = s.replace(
    /\[(?<label>[^\]]+)\]\((?<url>https?:\/\/[^\s)]+)\)/gu,
    (_m, label: string, url: string) => {
      const href = url.replace(/&#38;/gu, "&");
      return `<a href="${href}" target="_blank" rel="noreferrer noopener">${label}</a>`;
    }
  );
  s = s.replace(/`(?<text>[^`]+)`/gu, "<code>$<text></code>");
  s = s.replace(/\*\*(?<text>[^*]+)\*\*/gu, "<strong>$<text></strong>");
  s = s.replace(
    /(?<prefix>^|[^*])\*(?<text>[^*\n]+)\*/gu,
    "$<prefix><em>$<text></em>"
  );
  s = s.replace(
    /(?<prefix>^|[^_])_(?<text>[^_\n]+)_/gu,
    "$<prefix><em>$<text></em>"
  );
  return s;
}

export function changelogNotesToHtml(md: string): string {
  const lines = md.replace(/\r\n/gu, "\n").split("\n");
  const out: string[] = [];
  let list: string[] | null = null;
  const flushList = (): void => {
    if (list && list.length) out.push(`<ul>${list.join("")}</ul>`);
    list = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.trim() === "") {
      flushList();
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(?<text>.*)$/u);
    if (heading) {
      flushList();
      out.push(`<h4>${inline(heading.groups?.text ?? "")}</h4>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(?<text>.*)$/u);
    if (bullet) {
      (list ??= []).push(`<li>${inline(bullet.groups?.text ?? "")}</li>`);
      continue;
    }
    flushList();
    out.push(`<p>${inline(line.trim())}</p>`);
  }
  flushList();
  return out.join("");
}
