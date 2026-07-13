/*
 * Markdown-lite → HTML for release notes shown in the "What's new" modal.
 *
 * GitHub release notes are simple markdown — headings (### Fixed / ### New),
 * bullet lists, and inline bold/italic/code/links. Rather than pull a full
 * markdown dependency (the desktop keeps deps lean, v0), this renders the
 * subset the notes use. Every raw character is HTML-escaped first, then only
 * our own known tags are re-introduced, so any literal HTML in the notes shows
 * as text — safe to inject even though the notes come from the GitHub API.
 *
 * The output is a string of bare semantic tags (h4/ul/li/p/strong/em/code/a);
 * the modal's CSS module styles them via descendant selectors on the container,
 * so nothing here needs the hashed class names.
 */

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Inline spans: `**bold**`, `*italic*`/`_italic_`, `` `code` ``, `[t](url)`. */
function inline(raw: string): string {
  let s = escapeHtml(raw);
  // Links first — only http(s), rendered as safe external anchors. `escapeHtml`
  // leaves `/ : ( ) [ ]` intact and turns `&` (query separators) into `&#38;`;
  // restore that in the href so the URL works, while the label stays escaped.
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) => {
    const href = url.replace(/&#38;/g, '&');
    return `<a href="${href}" target="_blank" rel="noreferrer noopener">${label}</a>`;
  });
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  return s;
}

/**
 * Render release-notes markdown to an HTML string. Supports ATX headings
 * (`#`..`######`, all collapse to one section-label level), `-`/`*` bullet
 * lists, and paragraphs separated by blank lines, with the inline spans above.
 * Returns `''` for empty/blank input so the caller can show a fallback.
 */
export function changelogNotesToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let list: string[] | null = null;
  const flushList = (): void => {
    if (list && list.length) out.push(`<ul>${list.join('')}</ul>`);
    list = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.trim() === '') {
      flushList();
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      flushList();
      out.push(`<h4>${inline(heading[1] ?? '')}</h4>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      (list ??= []).push(`<li>${inline(bullet[1] ?? '')}</li>`);
      continue;
    }
    flushList();
    out.push(`<p>${inline(line.trim())}</p>`);
  }
  flushList();
  return out.join('');
}
