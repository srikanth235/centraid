const MAX_PAGE_CONTEXT = 12_000;
const BLOCK_ELEMENTS = new Set([
  "ARTICLE",
  "BUTTON",
  "DD",
  "DIV",
  "DT",
  "H1",
  "H2",
  "H3",
  "H4",
  "LI",
  "P",
  "SECTION",
  "TD",
  "TH",
  "TR",
]);
const EXCLUDED_ELEMENTS = new Set([
  "DIALOG",
  "NOSCRIPT",
  "SCRIPT",
  "STYLE",
  "TEMPLATE",
]);

function collectReadableText(node: Node, parts: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    parts.push(node.textContent ?? "");
    return;
  }
  if (!(node instanceof HTMLElement)) return;
  if (
    EXCLUDED_ELEMENTS.has(node.tagName) ||
    node.hidden ||
    node.getAttribute("aria-hidden") === "true" ||
    node.dataset.assistantChrome === "true"
  )
    return;
  const block = BLOCK_ELEMENTS.has(node.tagName);
  if (block) parts.push("\n");
  for (const child of node.childNodes) collectReadableText(child, parts);
  if (block) parts.push("\n");
}

/** Snapshot the rendered route, rather than merely naming it, for a page chip. */
export function readAssistantPageText(root: ParentNode = document): string {
  const source =
    root.querySelector<HTMLElement>('[data-assistant-page="true"]') ??
    root.querySelector<HTMLElement>('[data-assistant-main="true"]');
  if (!source) return "";
  const parts: string[] = [];
  collectReadableText(source, parts);
  return parts
    .join("")
    .split("\n")
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_PAGE_CONTEXT);
}
