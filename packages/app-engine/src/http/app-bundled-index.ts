import { promises as fs } from "node:fs";

import { resolveStaticPath, SHARED_ASSET_FILES } from "./security.js";

type BundleForEntry = (
  appDir: string,
  entryRel: string,
  sharedAssetsDir?: string
) => Promise<{ hash: string } | null>;

const SCRIPT_TAG_RE = /<script\b[^>]*>/giu;
const LINK_TAG_RE = /<link\b[^>]*>/giu;

async function statOrNull(
  file: string
): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.stat(file);
  } catch {
    return null;
  }
}

function attrOf(tag: string, name: string): string | null {
  const m = new RegExp(
    `\\b${name}\\s*=\\s*(?:"(?<dq>[^"]*)"|'(?<sq>[^']*)')`,
    "iu"
  ).exec(tag);
  return m ? (m.groups?.["dq"] ?? m.groups?.["sq"] ?? "") : null;
}

function rootLevelRel(url: string | null): string | null {
  if (!url) return null;
  if (/^[a-z][a-z0-9+.-]*:|^\/\//iu.test(url) || url.startsWith("/"))
    return null;
  const stripped = url.replace(/^\.\//u, "");
  if (
    stripped.includes("/") ||
    stripped.includes("?") ||
    stripped.includes("#")
  )
    return null;
  return stripped;
}

/** Rewrite live app HTML to use cached JS bundles and inline root-level CSS. */
export async function prepareBundledIndex(
  html: string,
  appDir: string,
  sharedAssetsDir: string | undefined,
  bundleForEntry: BundleForEntry
): Promise<string> {
  let out = html;
  const scripts = [...out.matchAll(SCRIPT_TAG_RE)];
  async function rewriteNextScript(index: number): Promise<void> {
    const m = scripts[index];
    if (!m) return;
    const tag = m[0];
    const type = attrOf(tag, "type");
    if (!type || type.toLowerCase() !== "module")
      return rewriteNextScript(index + 1);
    const src = attrOf(tag, "src");
    const entryRel = rootLevelRel(src);
    if (!entryRel || !/\.(?:js|jsx|ts|tsx|mjs)$/iu.test(entryRel)) {
      return rewriteNextScript(index + 1);
    }
    const bundle = await bundleForEntry(appDir, entryRel, sharedAssetsDir);
    if (bundle)
      out = out.replace(tag, tag.replace(src!, `./_bundle.${bundle.hash}.js`));
    return rewriteNextScript(index + 1);
  }
  await rewriteNextScript(0);

  const links = [...out.matchAll(LINK_TAG_RE)];
  const inlined = (
    await Promise.all(
      links.map(
        async (m): Promise<{ tag: string; css: string } | undefined> => {
          const tag = m[0];
          const relAttr = attrOf(tag, "rel");
          if (!relAttr || relAttr.toLowerCase() !== "stylesheet")
            return undefined;
          const name = rootLevelRel(attrOf(tag, "href"));
          if (!name || !name.endsWith(".css")) return undefined;
          let file = resolveStaticPath(appDir, name);
          if (!file || !(await statOrNull(file))) {
            const shared =
              sharedAssetsDir && SHARED_ASSET_FILES.has(name)
                ? resolveStaticPath(sharedAssetsDir, name)
                : null;
            file = shared && (await statOrNull(shared)) ? shared : null;
          }
          if (!file) return undefined;
          const css = (await fs.readFile(file)).toString("utf8");
          if (/<\/style/iu.test(css)) return undefined;
          return { tag, css: `/* inlined: ${name} */\n${css}` };
        }
      )
    )
  ).filter(
    (entry): entry is { tag: string; css: string } => entry !== undefined
  );
  if (inlined.length > 0) {
    const block = `<style data-centraid-inlined-css>\n${inlined
      .map((entry) => entry.css)
      .join("\n")}\n</style>`;
    out = out.replace(inlined[0]!.tag, block);
    for (const { tag } of inlined.slice(1)) out = out.replace(tag, "");
  }
  return out;
}
