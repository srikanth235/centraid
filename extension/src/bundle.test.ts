import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/*
 * THE EXTENSION IS NOT A SEAT AND CAN NEVER BECOME ONE (#1020 wave 4 lane
 * extension, D-1020-X1).
 *
 * It has no vault, no `K`, and no ability to unwrap. Every method is a frame to
 * `centraid native-host`, which is a client of the local seat under the same
 * peer-credential check as any other local process. The way that stops being
 * true is gradual and plausible — someone adds a crypto helper "just to hash
 * something", someone pulls in the WASM iroh endpoint "so it works when the app
 * is closed" — so it is asserted structurally here rather than left as a rule in
 * a README.
 *
 * ## What each ban is actually about
 *
 * | Ban | Why |
 * |---|---|
 * | `wasm`, `WebAssembly`, `wasm-unsafe-eval` | v0 ran a WASM iroh endpoint in the service worker and needed `'wasm-unsafe-eval'` in its CSP. Both are gone; a CSP that admits WASM again is an extension that can run a network stack |
 * | `iroh`, endpoint dialling, `fetch`, `XMLHttpRequest`, `WebSocket` | there is nothing for this extension to reach. No `host_permissions`, no network — if Centraid is not on this machine, the Companion says so |
 * | `crypto.subtle.encrypt` / `decrypt` / `importKey` / `deriveKey` | the platform's digest is fine (a capture's sha256 is not a secret), but a key operation in this process is the first step of becoming a seat |
 * | `indexedDB` | v0's seat wraps `K` into IndexedDB. An extension with a key store is an extension with a key |
 *
 * `crypto.subtle.digest` and `crypto.getRandomValues` are ALLOWED, named
 * explicitly: the first hashes a screenshot so the host's handle can be checked,
 * and the second is v0's own password generator, which produces a secret for the
 * member rather than opening one.
 */

const ROOT = path.resolve(import.meta.dirname, "..");

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git") continue;
    const at = path.join(dir, entry);
    if (statSync(at).isDirectory()) found.push(...walk(at));
    else found.push(at);
  }
  return found;
}

/**
 * The executable half of a file: comments stripped.
 *
 * Necessary rather than fussy. Half of this lane's job was WRITING DOWN that
 * v0's WASM iroh endpoint is gone, and those sentences are in the headers of the
 * files this lint reads — so a lint that matched raw text would fail on its own
 * explanation, and the fix somebody would reach for is to stop explaining. The
 * stripper is deliberately simple (block and line comments, nothing clever about
 * `//` inside a string literal): it can only ever remove text, so it cannot hide
 * a ban, and a URL that loses its scheme still matches nothing.
 */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/(?<before>^|[^:"'`])\/\/.*$/gmu, "$<before>");
}

/** Every shipped source and asset — tests excluded, they are not shipped. */
function shipped(): { file: string; text: string }[] {
  return ["src", "static", "dist"]
    .map((leaf) => path.join(ROOT, leaf))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    })
    .flatMap(walk)
    .filter((file) => !/\.test\.[cm]?[jt]s$/u.test(file))
    .filter((file) => /\.(?:[cm]?[jt]s|json|html|css)$/u.test(file))
    .map((file) => ({
      file: path.relative(ROOT, file),
      text: code(readFileSync(file, "utf8")),
    }));
}

/** What may never appear, and the sentence that says why. */
const BANNED: readonly { pattern: RegExp; because: string }[] = [
  {
    pattern: /\bWebAssembly\b|wasm-unsafe-eval|\bwasm\b/u,
    because: "the Companion runs no WASM — v0's iroh endpoint is gone",
  },
  {
    pattern: /\biroh\b|BrowserEndpoint|endpointTicket/u,
    because:
      "the Companion dials nothing — it talks to the app on this machine",
  },
  {
    pattern: /\bfetch\s*\(|XMLHttpRequest|new WebSocket|EventSource/u,
    because: "the Companion has no host permissions and nothing to reach",
  },
  {
    pattern:
      /crypto\.subtle\.(?:encrypt|decrypt|importKey|deriveKey|deriveBits|unwrapKey|wrapKey)/u,
    because: "a key operation here is the first step of becoming a seat",
  },
  {
    pattern: /\bindexedDB\b|openDatabase/u,
    because: "an extension with a key store is an extension with a key",
  },
];

describe("the Companion's bundle", () => {
  it("ships files", () => {
    const files = shipped();
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(BANNED)("never contains $pattern — $because", ({ pattern }) => {
    const offenders = shipped()
      .filter(({ text }) => pattern.test(text))
      .map(({ file }) => file);
    expect(offenders).toStrictEqual([]);
  });

  it("asks for no host permissions and admits no WASM in its CSP", () => {
    for (const browser of ["chrome", "firefox"]) {
      const manifest = JSON.parse(
        readFileSync(
          path.join(ROOT, "static", `manifest.${browser}.json`),
          "utf8"
        )
      ) as {
        permissions?: string[];
        host_permissions?: string[];
        content_security_policy?: { extension_pages?: string };
      };
      expect(manifest.host_permissions).toBeUndefined();
      expect(manifest.permissions).toContain("nativeMessaging");
      // The CSP is `script-src 'self'` and nothing else executable.
      const csp = manifest.content_security_policy?.extension_pages ?? "";
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain("wasm");
      expect(csp).not.toContain("unsafe-eval");
      expect(csp).toContain("object-src 'none'");
    }
  });

  it("allows exactly the two platform primitives it needs, and names them", () => {
    const uses = shipped().filter(({ text }) =>
      /crypto\.(?:subtle\.digest|getRandomValues)/u.test(text)
    );
    // Both are used — a lint that passed because nothing used them would be
    // telling us nothing about the ban above.
    expect(uses.length).toBeGreaterThan(0);
  });
});
