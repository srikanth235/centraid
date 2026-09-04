/**
 * The destructive-projection tripwire (#922 G6) — pure half.
 *
 * A destructive action whose pending projection is a plain patch leaves the
 * row ON SCREEN while the intent is queued: the member taps delete, the row
 * stays, and the only evidence anything happened is a badge. So every
 * destructive action a blueprint declares must project a DELETE or a
 * tombstone (`deleted_at` and its siblings) — or be excluded IN WRITING, with
 * a reason, in the app's `pending-projection.ts`.
 *
 * No filesystem here on purpose, matching `app-entity-tripwire.ts`: the caller
 * supplies action names and projection text, so a seeded violation is provable
 * red against a synthetic app without touching the tree.
 *
 * A TRIPWIRE, NOT A PROOF. It reads the `actions:` map of a projection module
 * as text and asks one question per destructive entry, following ONE HOP into
 * a helper the same module defines — which is how most of these projections
 * are written. A projection assembled in another file is out of reach; what
 * the tripwire CAN do is refuse the silent case — a destructive action whose
 * projection neither deletes nor tombstones and carries no written exclusion.
 */

/**
 * Names that mean A ROW STOPS BEING THERE. A status change is not one of
 * them: `cancel-event` leaves the event on the calendar marked cancelled, and
 * demanding a delete projection for it would be wrong. `detach` and `untag`
 * ARE here — they remove an attachment or a tag row.
 */
const DESTRUCTIVE =
  /^(?:delete|remove|discard|trash|purge|destroy|unlink|detach|untag)(?:-|$)/u;

/** Text that counts as projecting the row away. */
const PROJECTS_DELETE = /op:\s*"delete"|pendingDelete\s*\(/u;
const PROJECTS_TOMBSTONE =
  /pendingTombstone\s*\(|\b\w*deleted_at\b|\bdiscarded_at\b/u;

export interface AppProjectionInput {
  appId: string;
  /** Every `app.json#actions[].name` the app declares. */
  actionNames: readonly string[];
  /** The text of the app's `pending-projection.ts`. */
  source: string;
}

export type ProjectionVerdict =
  | "delete"
  | "tombstone"
  | "excluded"
  | "missing"
  | "unhandled";

export interface DestructiveAction {
  appId: string;
  action: string;
  verdict: ProjectionVerdict;
}

export interface AppProjectionCounts {
  appId: string;
  actions: number;
  destructive: number;
  delete: number;
  tombstone: number;
  excluded: number;
}

export interface PendingProjectionAudit {
  /** Destructive actions that project neither a delete nor a tombstone. */
  findings: DestructiveAction[];
  destructive: DestructiveAction[];
  counts: AppProjectionCounts[];
}

export function isDestructiveAction(name: string): boolean {
  return DESTRUCTIVE.test(name);
}

/** The `actions: { … }` object of a projection module, body text only. */
function actionsBlock(source: string): string | undefined {
  const start = source.indexOf("actions: {");
  if (start < 0) return undefined;
  let depth = 0;
  for (let index = start + "actions: ".length; index < source.length; index++) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0)
        return source.slice(start + "actions: ".length + 1, index);
    }
  }
  return undefined;
}

/**
 * Comments out, strings kept. A `//` line explaining a projection routinely
 * holds a comma, and a comma is how the entry splitter finds the next key —
 * without this pass a commented entry silently reads as `unhandled`.
 */
function stripComments(text: string): string {
  let out = "";
  let quote = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? "";
    if (quote) {
      out += char;
      if (char === "\\") {
        out += text[index + 1] ?? "";
        index += 1;
      } else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      const end = text.indexOf("\n", index);
      if (end < 0) break;
      index = end - 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end < 0) break;
      index = end + 1;
      continue;
    }
    out += char;
  }
  return out;
}

/** Top-level `key: value` entries of an object body, by brace/paren depth. */
function entries(block: string): Map<string, string> {
  const found = new Map<string, string>();
  let depth = 0;
  let start = 0;
  const push = (chunk: string): void => {
    const trimmed = chunk.trim();
    if (!trimmed) return;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) return;
    const key = trimmed
      .slice(0, colon)
      .trim()
      .replaceAll(/^["']|["']$/gu, "");
    found.set(key, trimmed.slice(colon + 1));
  };
  for (let index = 0; index < block.length; index++) {
    const char = block[index];
    if (char === "{" || char === "(" || char === "[") depth += 1;
    else if (char === "}" || char === ")" || char === "]") depth -= 1;
    else if (char === "," && depth === 0) {
      push(block.slice(start, index));
      start = index + 1;
    }
  }
  push(block.slice(start));
  return found;
}

/**
 * The module-level definitions a body may delegate to, by name. One hop is
 * enough for the shape these modules actually take: an entry either projects
 * inline or calls a helper declared beside it.
 */
function definitions(source: string): Map<string, string> {
  const found = new Map<string, string>();
  const declaration =
    /^(?:export\s+)?(?:const|function)\s+(?<name>[A-Za-z_$][\w$]*)/gmu;
  const starts: { name: string; at: number }[] = [];
  for (const match of source.matchAll(declaration)) {
    if (match.index !== undefined)
      starts.push({ name: match.groups?.name ?? "", at: match.index });
  }
  for (const [index, start] of starts.entries()) {
    const end = starts[index + 1]?.at ?? source.length;
    found.set(start.name, source.slice(start.at, end));
  }
  return found;
}

function projects(text: string): ProjectionVerdict | undefined {
  if (PROJECTS_DELETE.test(text)) return "delete";
  if (PROJECTS_TOMBSTONE.test(text)) return "tombstone";
  return undefined;
}

function verdictFor(
  body: string | undefined,
  helpers: Map<string, string>
): ProjectionVerdict {
  if (body === undefined) return "unhandled";
  if (/excluded:\s*true/u.test(body)) {
    return /reason:\s*["'`]/u.test(body) ? "excluded" : "missing";
  }
  const direct = projects(body);
  if (direct) return direct;
  for (const name of new Set(body.match(/[A-Za-z_$][\w$]*/gu))) {
    const helper = helpers.get(name);
    if (!helper) continue;
    const indirect = projects(helper);
    if (indirect) return indirect;
  }
  return "missing";
}

/**
 * Judge every destructive action of every app. `unhandled` and `missing` are
 * both findings: an action the projection map never mentions projects nothing
 * at all, which is the same silence by a different route.
 */
export function auditPendingProjections(
  apps: readonly AppProjectionInput[]
): PendingProjectionAudit {
  const destructive: DestructiveAction[] = [];
  const counts: AppProjectionCounts[] = [];
  for (const app of apps) {
    const block = actionsBlock(stripComments(app.source));
    const bodies = block ? entries(block) : new Map<string, string>();
    const helpers = definitions(stripComments(app.source));
    const tally: AppProjectionCounts = {
      appId: app.appId,
      actions: app.actionNames.length,
      destructive: 0,
      delete: 0,
      tombstone: 0,
      excluded: 0,
    };
    for (const action of app.actionNames) {
      if (!isDestructiveAction(action)) continue;
      const verdict = verdictFor(bodies.get(action), helpers);
      tally.destructive += 1;
      if (verdict === "delete") tally.delete += 1;
      else if (verdict === "tombstone") tally.tombstone += 1;
      else if (verdict === "excluded") tally.excluded += 1;
      destructive.push({ appId: app.appId, action, verdict });
    }
    counts.push(tally);
  }
  return {
    destructive,
    counts,
    findings: destructive.filter(
      (each) => each.verdict === "missing" || each.verdict === "unhandled"
    ),
  };
}
