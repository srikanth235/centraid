/*
 * Generate `contracts/extension/methods.json` from v0's Companion (#1020 wave 4
 * lane extension, D-1020-X2).
 *
 * The 17 methods are a **closed enum on both sides** — the extension's switch
 * and the native host's method table — and the only way that stays true is for
 * the list to be derived from the pinned oracle rather than typed twice. So
 * this tool reads v0's own two files:
 *
 *   * `apps/extension/src/types.ts` — the `CompanionRequest` discriminated
 *     union, which is where each method's REQUEST FIELDS are declared;
 *   * `apps/extension/src/companion-api.ts` — `handleCompanionRequest`'s
 *     `switch`, which is where the ORDER comes from.
 *
 * Two derived facts are attached per method and neither is invented here:
 *
 *   * `idempotent` — v0's retry classification (`transport-core.ts:33`–`:52`)
 *     keys on the **HTTP method** of the request, and the HTTP method is gone.
 *     What survives is the property the rule was about: *a request that reached
 *     the app and then failed may have been taken*. So the tool reads each
 *     handler's transport calls and asks v0's own question of them —
 *     `appRead`/`appWrite` are `POST` (`transport.ts:198`, `:210`) and
 *     therefore NOT in v0's idempotent set, a bare `companionJson` is `GET` and
 *     is, and `pairOverIroh` enrols a device. Reading it off the call rather
 *     than off "is it a read" matters: `locker:fill` LOOKS like a read and is a
 *     `POST`, and post-wave-4 it writes a reveal receipt — so a rule that
 *     retried it on any failure would reveal a credential three times for one
 *     gesture.
 *   * `writes` — the `appWrite(app, action, …)` pair the handler lands on, or
 *     `null`. That is what the host has to invoke, so it is a contract and not
 *     a comment.
 *
 * Run: `bun contracts/tools/export-extension-methods.ts && bun run format`.
 * Idempotent: a second run with no v0 change leaves the file byte-identical
 * (`git diff --exit-code contracts/extension`).
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const TYPES = path.join(ROOT, "apps/extension/src/types.ts");
const API = path.join(ROOT, "apps/extension/src/companion-api.ts");
const OUT = path.join(ROOT, "contracts/extension/methods.json");
/*
 * THE SHIPPED COPY. The contract is what the native host compiles in and what
 * the lint and the tests read; the extension needs the same data as a MODULE,
 * because a service worker that resolved a JSON import at run time would need a
 * bundler, and this Companion deliberately has none (`extension/scripts/build.mjs`).
 * So the generator writes both from one derivation, `extension/src/methods.ts`
 * re-exports the module, and `methods.test.ts` asserts the two are equal — which
 * is the only thing that could go wrong with two files holding one fact.
 */
const TABLE = path.join(ROOT, "extension/src/methods-table.ts");

interface Field {
  readonly name: string;
  readonly type: string;
  readonly optional: boolean;
}

interface Method {
  readonly name: string;
  readonly idempotent: boolean;
  /** The HTTP methods v0's handler used, which is what `idempotent` reads. */
  readonly http: readonly string[];
  readonly reads_page: boolean;
  readonly stages_bytes: boolean;
  readonly writes: { readonly app: string; readonly action: string } | null;
  readonly fields: readonly Field[];
}

/**
 * The `CompanionRequest` union's members, as `{ type: "x"; … }` object types.
 *
 * Parsed rather than imported: importing it would need v0's build to have run
 * and would give a TYPE, not the field list a fixture needs.
 */
function unionMembers(source: string): Map<string, Field[]> {
  const start = source.indexOf("export type CompanionRequest");
  if (start < 0) throw new Error("v0's CompanionRequest union moved");
  // The union ends at the first `;` outside a brace, not at a `\n}`: its last
  // member is `| { type: "page:capture" };` on one line.
  let depth = 0;
  let end = start;
  for (; end < source.length; end += 1) {
    const char = source[end];
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === ";" && depth === 0) break;
  }
  const body = source.slice(start, end);
  const members = new Map<string, Field[]>();
  // Each member is either `{ type: "x" }` on one line or a braced block.
  for (const block of body.split(/\|\s*\{/u).slice(1)) {
    const text = block.slice(0, block.indexOf("}"));
    const name = /type:\s*"(?<name>[^"]+)"/u.exec(text)?.groups?.["name"];
    if (!name) continue;
    const fields: Field[] = [];
    for (const entry of text.split(";")) {
      const match =
        /^\s*(?<field>[A-Za-z]+)(?<maybe>\?)?:\s*(?<shape>.+?)\s*$/u.exec(
          entry
        );
      if (!match) continue;
      const group = match.groups!;
      if (group["field"] === "type") continue;
      fields.push({
        name: group["field"]!,
        type: group["shape"]!.replace(/\s+/gu, " "),
        optional: group["maybe"] === "?",
      });
    }
    members.set(name, fields);
  }
  return members;
}

/**
 * The module's own function bodies, by name.
 *
 * A switch arm rarely reaches the transport itself — `locker:fill` calls
 * `fill`, which calls `candidates`, which calls `appRead`. So the arm's text
 * alone answers the wrong question, and the tool follows the calls one
 * transitive step at a time rather than pretending the arm is the handler.
 */
function localFunctions(source: string): Map<string, string> {
  const bodies = new Map<string, string>();
  for (const found of source.matchAll(
    /\n(?:export )?(?:async )?function (?<fn>[A-Za-z]+)\(/gu
  )) {
    let depth = 0;
    let started = false;
    let at = found.index;
    for (; at < source.length; at += 1) {
      const char = source[at];
      if (char === "{") {
        depth += 1;
        started = true;
      } else if (char === "}") {
        depth -= 1;
        if (started && depth === 0) break;
      }
    }
    bodies.set(found.groups!["fn"]!, source.slice(found.index, at));
  }
  return bodies;
}

/** An arm's text plus the bodies of every local function it reaches. */
function reachableBody(arm: string, locals: Map<string, string>): string {
  const seen = new Set<string>();
  let text = arm;
  for (;;) {
    const next = [...text.matchAll(/\b(?<call>[A-Za-z]+)\s*(?:<[^(]*>)?\(/gu)]
      .map((call) => call.groups!["call"]!)
      .find((name) => locals.has(name) && !seen.has(name));
    if (!next) return text;
    seen.add(next);
    text += `\n${locals.get(next)!}`;
  }
}

/** Each `case "x":` arm of `handleCompanionRequest`, in v0's order, with its body. */
function switchArms(source: string): Array<{ name: string; body: string }> {
  const start = source.indexOf("export async function handleCompanionRequest");
  if (start < 0) throw new Error("v0's handleCompanionRequest moved");
  const body = source.slice(start);
  const arms: Array<{ name: string; body: string }> = [];
  const cases = [...body.matchAll(/\n {4}case "(?<method>[^"]+)":/gu)];
  for (const [index, found] of cases.entries()) {
    const from = found.index + found[0].length;
    const to = cases[index + 1]?.index ?? body.length;
    arms.push({ name: found.groups!["method"]!, body: body.slice(from, to) });
  }
  return arms;
}

/**
 * v0's own idempotent set (`transport-core.ts:47`–`:48`). Restated, not
 * widened: `POST` is absent from it and that absence is the whole rule.
 */
const V0_IDEMPOTENT_HTTP = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);

/** The argument text of the call that starts at `from`, paren-balanced. */
function callArguments(body: string, from: number): string {
  let depth = 0;
  for (let at = from; at < body.length; at += 1) {
    const char = body[at];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return body.slice(from, at);
    }
  }
  return body.slice(from);
}

/** Every HTTP method this handler's transport calls would have used in v0. */
function httpMethods(body: string): string[] {
  const methods: string[] = [];
  for (const call of body.matchAll(
    /\b(?<call>appRead|appWrite|companionJson|pairOverIroh)\s*(?:<[^(]*>)?\(/gu
  )) {
    const args = callArguments(body, call.index + call[0].length - 1);
    if (call.groups!["call"] === "companionJson") {
      methods.push(
        /method:\s*"(?<verb>[A-Z]+)"/u.exec(args)?.groups?.["verb"] ?? "GET"
      );
    } else {
      // `appRead` and `appWrite` are both POST; `pairOverIroh` enrols.
      methods.push("POST");
    }
  }
  return methods;
}

function methodFrom(name: string, body: string, fields: Field[]): Method {
  const writeCall = /appWrite\(\s*"(?<app>[^"]+)",\s*"(?<action>[^"]+)"/u.exec(
    body
  );
  const stages = body.includes("ROUTES.vaultBlobs");
  const takesPage = fields.some((field) => field.name === "pageUrl");
  const verbs = httpMethods(body);
  return {
    name,
    idempotent: verbs.every((verb) => V0_IDEMPOTENT_HTTP.has(verb)),
    http: verbs,
    // `page:capture` is answered by the content script rather than the
    // transport (`companion-api.ts:318` returns `undefined`), and
    // `capture:document` carries a screenshot the tab produced.
    reads_page:
      name === "page:capture" || name === "capture:document" || takesPage,
    stages_bytes: stages,
    writes: writeCall
      ? { app: writeCall.groups!["app"]!, action: writeCall.groups!["action"]! }
      : null,
    fields,
  };
}

const types = readFileSync(TYPES, "utf8");
const api = readFileSync(API, "utf8");
const members = unionMembers(types);
const locals = localFunctions(api);
const methods = switchArms(api).map((arm) => {
  const fields = members.get(arm.name);
  if (!fields) {
    throw new Error(`${arm.name} is a switch arm with no union member`);
  }
  return methodFrom(arm.name, reachableBody(arm.body, locals), fields);
});
/*
 * EIGHTEEN, AND THE CENSUS SAYS SEVENTEEN (#1020 wave 4, lane extension
 * finding 1). Census §E2 calls `handleCompanionRequest`'s switch "the 17
 * companion methods" and then lists eighteen names, and the file has eighteen
 * `case` arms. The count is asserted here rather than carried as a comment
 * because the closed-enum claim is the whole point of this fixture: if v0's
 * switch grows or shrinks, the generator fails and both sides' tables are
 * re-derived, instead of a nineteenth method quietly never being served.
 */
export const METHOD_COUNT = 18;
if (methods.length !== METHOD_COUNT) {
  throw new Error(
    `v0's Companion answers ${methods.length} methods, not ${METHOD_COUNT}`
  );
}

const document = {
  version: 1,
  /*
   * WHY THE CEILING IS IN THIS FILE. Both sides need the same number and both
   * sides would otherwise carry their own copy: the extension to decide when to
   * stage, the host to refuse a frame it cannot read. It is the browser's, not
   * the product's (`crates/centraid/src/cmd/native_host.rs`).
   */
  max_frame_bytes: 1024 * 1024,
  source: [
    "apps/extension/src/types.ts",
    "apps/extension/src/companion-api.ts",
  ],
  methods,
};
writeFileSync(OUT, `${JSON.stringify(document, null, 2)}\n`);
writeFileSync(
  TABLE,
  `/*\n * GENERATED — do not edit. \`bun contracts/tools/export-extension-methods.ts\`.\n` +
    ` *\n * The closed Companion method table, derived from v0's own\n` +
    ` * \`apps/extension/src/{types,companion-api}.ts\` and byte-equal in content to\n` +
    ` * \`contracts/extension/methods.json\`, which the native host compiles in\n` +
    ` * (\`crates/centraid/src/cmd/native_host/methods.rs\`). Two files hold this one\n` +
    ` * fact because a service worker cannot resolve a JSON import without a bundler\n` +
    ` * and this Companion has none; \`methods.test.ts\` asserts they agree.\n */\n\n` +
    `export default ${JSON.stringify(document, null, 2)} as const;\n`
);
process.stdout.write(`${OUT}: ${methods.length} methods\n`);
process.stdout.write(`${TABLE}: the shipped copy\n`);
