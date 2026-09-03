const RESOURCE_ID = /^(?:[\w.]+:id\/)?(?<handle>.+)$/u;

const DIGEST_LIMIT = 60;

const MAX_TEXT = 48;

function attributesOf(node) {
  if (!node || typeof node !== "object") return {};
  const { attributes } = node;
  return attributes && typeof attributes === "object" ? attributes : node;
}

function handleOf(attributes) {
  const raw = attributes["resource-id"] ?? attributes.resourceId;
  if (typeof raw !== "string" || raw === "") return undefined;
  return RESOURCE_ID.exec(raw)?.groups?.handle;
}

function labelOf(attributes) {
  for (const key of ["text", "accessibilityText", "hintText"]) {
    const value = attributes[key];
    if (typeof value === "string" && value !== "" && value.length <= MAX_TEXT)
      return value;
  }
  return undefined;
}

function childrenOf(node) {
  if (Array.isArray(node)) return node;
  const { children } = node ?? {};
  return Array.isArray(children) ? children : [];
}

export function digestHierarchy(root, { limit = DIGEST_LIMIT } = {}) {
  const seen = new Set();
  const stack = [root];
  while (stack.length > 0 && seen.size < limit) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    const attributes = attributesOf(node);
    const handle = handleOf(attributes);
    if (handle !== undefined) seen.add(`id:${handle}`);
    const label = labelOf(attributes);
    if (label !== undefined) seen.add(JSON.stringify(label));
    const children = childrenOf(node);
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
  }
  return [...seen].slice(0, limit);
}

export function digestLines(json, { limit = DIGEST_LIMIT } = {}) {
  let parsed;
  try {
    parsed = typeof json === "string" ? JSON.parse(sliceJson(json)) : json;
  } catch {
    return [];
  }
  const entries = digestHierarchy(parsed, { limit });
  return entries.length === 0 ? [] : entries;
}

function sliceJson(text) {
  const start = Math.min(
    ...["{", "["].map((c) => text.indexOf(c)).filter((i) => i >= 0)
  );
  const end = Math.max(...["}", "]"].map((c) => text.lastIndexOf(c)));
  return Number.isFinite(start) && end > start
    ? text.slice(start, end + 1)
    : text;
}
