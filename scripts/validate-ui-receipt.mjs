#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const SCREENSHOT_RE = /artifacts\/e2e\/ui-impact\/[^\s)]+\.png/giu;

/*
 * A blueprint app's SUITE is not one of its surfaces (#930). Every other path
 * this gate watches is something a member can see; `queries.test.ts` and the
 * `*.test-fixtures.ts` module it reads are not, and the only exit from this
 * gate is a screenshot emitted by a changed e2e harness — so before this, a
 * change that split an over-long test file (or merely deleted a comment in
 * one) had to photograph a screen that had not moved. The component,
 * stylesheet and handler files beside them are still user-facing, which the
 * cases in validate-ui-receipt.test.mjs pin.
 */
const TEST_FILE_RE = /(?:\.test|\.test-fixtures)\.[^./]+$/u;

/*
 * A DATA CLIENT is not a surface either (#931), the same refinement #930 made
 * one commit earlier for a blueprint app's suite. Watching the whole of
 * `packages/client` meant that escaping a raw NUL in an attachment-URL cache
 * key — two characters, in a module with no DOM — demanded a screenshot of a
 * screen that had not moved, emitted by an e2e harness the change had no reason
 * to touch, in an environment that may have no browser at all.
 *
 * IT IS AN EXCLUSION LIST, NOT AN ALLOWLIST, and that is the whole design. The
 * drawing surface of this package is not `src/react/**`: `home-copy.ts` is the
 * single spelling of every Home string, `icons.ts` is innerHTML'd SVG,
 * `theme-vars.ts` is the token CSS applied before first paint, `index.html` is
 * the shell document, and the eight other `*-copy.ts` modules are the words a
 * member reads. An allowlist would have dropped every one of them silently,
 * which is how a gate stops enforcing. So the default stays what it was —
 * everything under `packages/client` is a surface — and only paths READ and
 * confirmed to render nothing are named below. Adding a path here is a claim
 * about specific files; the surrounding cases in validate-ui-receipt.test.mjs
 * pin what must stay outside it.
 *
 * THE LINE THE SWEEP DREW. Every excluded file was read for prose-shaped string
 * literals, and each hit judged by one question: is this string composed for a
 * member to read, or is it a diagnostic explaining a fault to whoever is
 * debugging? Composed copy makes the file a surface — that is why
 * `replica/rebootstrap-copy.ts`, `gateway-client-edges.ts` and
 * `gateway-client-push.ts` are carved back out below. A diagnostic does not,
 * even though `react/shell/ErrorBoundary.tsx` and several toasts echo
 * `error.message` verbatim when something breaks: every module in the package
 * throws, so "a thrown string can reach a screen" would make the whole package
 * a surface again and no refinement of this shape would be possible for anyone.
 * The per-file verdicts are in receipts/issue-931-gates-that-enforce-nowhere.md.
 *
 * The screenshot requirement itself is untouched: this narrows WHICH files are
 * surfaces, not what a surface change owes.
 */

/**
 * Paths carved BACK IN because they hold composed member copy, even though the
 * broader pattern below would sweep them up. Checked first, so a pattern can
 * never win over one of these.
 */
const CLIENT_COPY_EXCEPTIONS = [
  // "WHAT A MEMBER IS TOLD WHEN THEIR REPLICA STARTS OVER" (#883 C6): the
  // notice headline/detail strings, e.g. "This device is downloading its whole
  // library again — your unsent changes stay queued."
  "packages/client/src/replica/rebootstrap-copy.ts",
  // `RECOVERY_REFUSALS`, commented "the member reads a reason, not a code" —
  // "You already run this shared space." and three siblings, thrown to
  // react/shell/routes/InlineAppRoute.tsx. Carved out by name rather than
  // moved into a `*-copy.ts`: moving it is a product refactor across two files
  // for a gate's benefit, and leaving the module watched is the conservative
  // direction — a false demand is never a hole.
  "packages/client/src/gateway-client-edges.ts",
  // `showNotification(..., { body: "Task reminder" })` — a Web Push body a
  // member reads on a lock screen, which is as member-visible as copy gets.
  "packages/client/src/gateway-client-push.ts",
];

const CLIENT_NOT_A_SURFACE = [
  // The replica store and its transport: no DOM, no copy, no markup. Its
  // remaining prose-shaped strings are thrown diagnostics
  // (`shell-session.ts`'s admission reasons reach no UI — `ShellReplicaWriteResult`
  // has no consumer outside that module and its tests) or invariant messages.
  /^packages\/client\/src\/replica\//u,
  // The renderer-side HTTP client hub and its per-surface modules, plus the
  // credential handover, the SSE/turn streams, the change feeds, the protocol
  // handshake and the device compute/blob sources beside them.
  /^packages\/client\/src\/gateway-client[\w.-]*\.ts$/u,
  /^packages\/client\/src\/(?:gateway-auth|turn-stream|vault-change-feed|vault-change-sse|version-handshake|device-blob-source|device-enrichment-worker|device-roster)\.ts$/u,
  // The inline query ENGINE under react/blueprints/ (#922 wave 1's ctx-core
  // refactor is the case: it moves query planning between modules that render
  // nothing and was made to photograph a screen that had not changed). BY FILE
  // NAME, never the folder — `centraid-inline.ts` posts status a member reads,
  // and `kit-ask-inline.ts` beside it holds "Ask your <app>".
  //
  // ONE NAME, NOT A PREFIX. An earlier form also matched
  // `inline-query-ctx-core*.ts`, which no file in the tree is: a wildcard over
  // unwritten modules pre-exempts code nobody can read, which is the exact
  // class this issue exists to close. The ctx-core modules get their exact
  // names here on the day #922 lands them and someone can check them.
  /^packages\/client\/src\/react\/blueprints\/inlineQueryCtx\.ts$/u,
];

/** Does this path draw something a member can see? */
function isClientSurface(file) {
  if (!file.startsWith("packages/client/")) return false;
  if (CLIENT_COPY_EXCEPTIONS.includes(file)) return true;
  return !CLIENT_NOT_A_SURFACE.some((pattern) => pattern.test(file));
}

/*
 * A file that is on NO import edge and draws nothing is not a surface (#988).
 *
 * The path rule below fires on everything under `packages/blueprints/apps/`,
 * which includes each app's `app.json` manifest. Editing two strings in
 * `packages/blueprints/apps/people/app.json` — a dead `dpv:` purpose and a
 * description sentence — therefore demanded `## User impact`, a `First-run:`
 * note and a fresh screenshot emitted by a changed e2e harness, and then
 * re-validated every screenshot every receipt in the change set already named.
 *
 * A manifest is data: no module imports it as code, it imports nothing itself,
 * and nothing in it is painted. The same holds for the docs, ledgers and lock
 * files that live beside a surface. Stylesheets, HTML documents and SVG are the
 * opposite case and stay surfaces — they ARE the drawing, which is why this is
 * keyed on the import graph rather than on "is it source".
 */
const NOT_ON_AN_IMPORT_EDGE_RE = /\.(?:json|md|ya?ml|txt|lock|snap)$/iu;

/** Does this changed path draw something a member can see? */
export function isSurface(file) {
  if (TEST_FILE_RE.test(file) || NOT_ON_AN_IMPORT_EDGE_RE.test(file))
    return false;
  return (
    isClientSurface(file) ||
    /^apps\/[^/]+\/.*\.(?:tsx|css)$/u.test(file) ||
    file.startsWith("packages/blueprints/apps/")
  );
}

export function validateUiReceipt({ changed, readText }) {
  const touchesUi = changed.some((file) => isSurface(file));
  if (!touchesUi) return [];
  const errors = [];
  const receipts = changed.filter((file) =>
    /^receipts\/issue-\d+-.*\.md$/u.test(file)
  );
  for (const file of receipts) {
    const text = readText(file);
    if (!/^## User impact\s*$/mu.test(text) || !/first[- ]run:/iu.test(text))
      continue;
    for (const screenshot of text.match(SCREENSHOT_RE) ?? []) {
      const filename = path.basename(screenshot);
      const emitter = changed.find((candidate) => {
        if (!/(?:e2e|agent-e2e).*(?:spec\.ts|\.mjs)$/u.test(candidate))
          return false;
        const source = readText(candidate);
        return (
          source.includes("artifacts/e2e/ui-impact") &&
          source.includes(filename) &&
          /(?:page\.)?screenshot\s*\(/u.test(source)
        );
      });
      if (emitter) return [];
      errors.push(
        `${screenshot} has no changed e2e harness emitter (the harness must name the ui-impact directory, filename, and screenshot call)`
      );
    }
  }
  if (!errors.length)
    errors.push(
      "user-facing changes require `## User impact`, a `First-run:` note, and a screenshot path emitted by a changed e2e harness under artifacts/e2e/ui-impact/"
    );
  return errors;
}

if (process.argv[1] === import.meta.filename) {
  const changed = [
    ...execFileSync("git", ["diff", "--name-only", "origin/main", "--"], {
      cwd: root,
      encoding: "utf8",
    }).split("\n"),
    ...execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
    }).split("\n"),
  ].filter(Boolean);
  // `git diff --name-only` lists deletions too; a receipt renamed away (a
  // waived doc-integrity migration) must not crash the gate — the surviving
  // receipt is the one that carries the evidence.
  const present = changed.filter((file) => existsSync(path.join(root, file)));
  const errors = validateUiReceipt({
    changed: present,
    readText: (file) => readFileSync(path.join(root, file), "utf8"),
  });
  if (errors.length) {
    for (const error of errors) console.error(`UI receipt gate: ${error}`);
    process.exit(1);
  }
  console.log("UI receipt gate: evidence verified");
}
