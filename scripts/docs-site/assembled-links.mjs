import { access, readFile } from "node:fs/promises";
import path from "node:path";

const { posix } = path;

export function assembledTarget(url, fromPage) {
  const parsed = new URL(url, `https://centraid.dev/${fromPage}`);
  if (parsed.origin !== "https://centraid.dev") return null;

  let pathname = decodeURIComponent(parsed.pathname);
  pathname = pathname.replace(/^\/+/u, "");
  if (!pathname) pathname = "index.html";
  else if (pathname.endsWith("/")) pathname += "index.html";
  else if (!posix.basename(pathname).includes(".")) pathname += "/index.html";

  const target = posix.normalize(pathname);
  if (target === ".." || target.startsWith("../")) return null;
  return { path: target, fragment: decodeURIComponent(parsed.hash.slice(1)) };
}

export function containsFragment(html, fragment) {
  if (!fragment) return true;
  const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`\\bid=["']${escaped}["']`, "u").test(html);
}

export async function checkAssembledReference(url, fromPage, siteDir) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(url)) return null;
  const target = assembledTarget(url, fromPage);
  if (!target) return `unsafe or unresolved path`;
  const absolute = path.join(siteDir, target.path);
  try {
    await access(absolute);
  } catch {
    return `missing ${target.path}`;
  }
  if (target.fragment && target.path.endsWith(".html")) {
    const html = await readFile(absolute, "utf8");
    if (!containsFragment(html, target.fragment)) {
      return `missing #${target.fragment} in ${target.path}`;
    }
  }
  return null;
}
