// Pure formatting helpers: no DOM, `window`, network, or IPC — deterministic transforms only.

import { formatBytes as sharedFormatBytes } from "@centraid/design";

export type CodeLang = "html" | "js" | "ts" | "css" | "json" | "md" | "other";

/** Escape &, <, > so source text renders inert. */
export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export interface TokenClasses {
  tag: string;
  attr: string;
  str: string;
  key: string;
  com: string;
}

/** Unscoped `tok-*` defaults, kept for tests/plain hosts. */
export const DEFAULT_TOKEN_CLASSES: TokenClasses = {
  attr: "tok-attr",
  com: "tok-com",
  key: "tok-key",
  str: "tok-str",
  tag: "tok-tag",
};

/**
 * Dependency-free syntax highlighter; emits HTML with per-kind span classes
 * (`classes`, defaulting to `tok-*`). Tokens wrap placeholder control chars
 * first so a later regex can't match injected text; spans swap in at the end.
 */
export function tokenize(
  src: string,
  lang: CodeLang,
  classes: TokenClasses = DEFAULT_TOKEN_CLASSES
): string {
  const TAG = "\x01";
  const ATTR = "\x02";
  const STR = "\x03";
  const KEY = "\x04";
  const COM = "\x05";
  const END = "\x06";
  let html = escapeHtml(src);
  if (lang === "html") {
    html = html
      .replaceAll(/(?<tag>&lt;\/?[\w-]+)/gu, `${TAG}$<tag>${END}`)
      .replaceAll(/(?<attr>\s[\w-]+)=/gu, `${ATTR}$<attr>${END}=`)
      .replaceAll(/(?<str>"[^"]*")/gu, `${STR}$<str>${END}`);
  } else if (lang === "js" || lang === "ts") {
    html = html
      .replaceAll(/\/\/[^\n]*/gu, (m) => `${COM}${m}${END}`)
      .replaceAll(
        /\b(?<keyword>const|let|var|function|return|if|else|for|new|try|catch|throw|async|await|export|import|from|type|interface|class|extends|implements|satisfies)\b/gu,
        `${KEY}$<keyword>${END}`
      )
      .replaceAll(/(?<str>'[^']*'|"[^"]*"|`[^`]*`)/gu, `${STR}$<str>${END}`);
  } else if (lang === "css") {
    html = html
      .replaceAll(/(?<comment>\/\*[\s\S]*?\*\/)/gu, `${COM}$<comment>${END}`)
      .replaceAll(/(?<customProp>--[\w-]+)/gu, `${KEY}$<customProp>${END}`)
      .replaceAll(
        /(?<value>#[0-9a-f]{3,8}|\d+px|\d+%)/gu,
        `${STR}$<value>${END}`
      );
  } else if (lang === "json") {
    html = html
      .replaceAll(
        /(?<key>"[^"]*")(?<colon>\s*:)/gu,
        `${ATTR}$<key>${END}$<colon>`
      )
      .replaceAll(/:\s*(?<value>"[^"]*")/gu, `: ${STR}$<value>${END}`)
      .replaceAll(
        /\b(?<literal>true|false|null)\b/gu,
        `${KEY}$<literal>${END}`
      );
  }
  return html
    .replaceAll(TAG, `<span class="${classes.tag}">`)
    .replaceAll(ATTR, `<span class="${classes.attr}">`)
    .replaceAll(STR, `<span class="${classes.str}">`)
    .replaceAll(KEY, `<span class="${classes.key}">`)
    .replaceAll(COM, `<span class="${classes.com}">`)
    .replaceAll(END, "</span>");
}

export function languageHint(p: string): CodeLang {
  if (p.endsWith(".ts")) return "ts";
  if (p.endsWith(".js") || p.endsWith(".mjs")) return "js";
  if (p.endsWith(".html") || p.endsWith(".htm")) return "html";
  if (p.endsWith(".css")) return "css";
  if (p.endsWith(".json")) return "json";
  if (p.endsWith(".md")) return "md";
  return "other";
}

export const LANG_DISPLAY: Record<CodeLang, string> = {
  html: "HTML",
  js: "JS",
  ts: "TS",
  css: "CSS",
  json: "JSON",
  md: "MD",
  other: "TXT",
};

/** App-id slug grammar: lowercase, hyphenated, capped at 40 chars. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
}

/** Slug seed + short random suffix, e.g. `morning-digest-a1b2c3`. */
export function generateAppId(seed: string): string {
  const slug = slugify(seed) || "app";
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${slug}-${suffix}`;
}

export function relativeWhen(iso: string): string {
  try {
    const t = new Date(iso).getTime();
    const ms = Date.now() - t;
    const s = Math.floor(ms / 1000);
    if (s < 60) return "Just now";
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d ago`;
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

/** One decimal KB→TB; integer bytes below 1 KiB (#367). */
export function formatBytes(n: number): string {
  return sharedFormatBytes(n);
}

/** Declared semver, else datetime from `v_<iso>_<sha>`, else a prefix. */
export function shortVersionTitle(v: {
  versionId: string;
  declaredVersion?: string;
}): string {
  if (v.declaredVersion) return v.declaredVersion;
  const stamp = /v_(?<stamp>\d{4}-\d{2}-\d{2}T\d{2}-\d{2})-/u.exec(v.versionId)
    ?.groups?.stamp;
  return stamp ? stamp.replace("T", " ") : v.versionId.slice(0, 24);
}
