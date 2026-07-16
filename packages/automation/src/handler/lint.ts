/**
 * Static handler lint for automation `handler.js` (issue #167).
 *
 * An automation fire is a chat whose brain is `handler.js`. Its outside effects
 * must go through the `ctx.*` surface (`ctx.tool` / `ctx.agent` / `ctx.state` /
 * `ctx.runs`): those calls are recorded in the run ledger (`run_nodes`) and
 * gated by the manifest's `requires.tools` allowlist. A raw `fetch`/`fs` call is
 * both invisible to the run history and outside the allowlist. The handler
 * should also be deterministic: a crashed fire simply re-runs from the top
 * (there is no resume journal), so a wall-clock read or a random value makes the
 * re-run diverge and re-fire effects with different ids.
 *
 * This module is the *authoring-time* guard: a lexical scan that flags the
 * common offenders (`Date.now()`, `Math.random()`, `randomUUID()`, raw
 * `fetch`/`fs`, ambient `process.*`, …) so the builder sees an authoring error
 * at publish time rather than a surprise at fire time. It is a lint, not a
 * sandbox — it cannot catch every escape (an aliased global, an `eval`), but it
 * catches what a generated/edited handler realistically emits.
 *
 * The deterministic alternatives are watermarks via `ctx.runs.last()` /
 * `ctx.state`, ids derived from the run's inputs, and timestamps returned by a
 * `ctx.tool` call. The rules below only ever match raw globals, so anything on
 * the `ctx.` surface passes untouched.
 */

/** One flagged pattern found in a handler. */
export interface HandlerLintFinding {
  /** Stable rule id (e.g. `no-date-now`). */
  readonly rule: string;
  /** Human-readable reason + the deterministic alternative. */
  readonly message: string;
  /** 1-based line of the match. */
  readonly line: number;
  /** 1-based column of the match. */
  readonly column: number;
  /** The offending source line, trimmed, for context. */
  readonly snippet: string;
}

interface LintRule {
  readonly id: string;
  readonly re: RegExp;
  readonly message: string;
  /**
   * Which masked view the rule scans. `code` (default) masks comments AND
   * string/template literal bodies — for value-nondeterminism calls that must
   * never match a mention inside a string. `withStrings` masks only comments,
   * keeping string literals — for the module-import rule whose target *is* a
   * string specifier (`from 'fs'`).
   */
  readonly target?: 'code' | 'withStrings';
}

/**
 * The flagged patterns. Each `re` is a global regex run over the
 * comment-and-string-masked source, so a match is real code — never a mention
 * inside a comment or a string/template literal (interpolated `${…}` code is
 * still scanned). Keep messages prescriptive: say *why* it is a problem and
 * what to use instead.
 */
const RULES: readonly LintRule[] = [
  {
    id: 'no-date-now',
    re: /\bDate\.now\s*\(/g,
    message:
      'Date.now() reads the wall clock, so a re-run produces a different value. Use the fixed ctx.now fire instant, derive time windows from ctx.runs.last() / ctx.state, or read a timestamp from a ctx.tool result.',
  },
  {
    id: 'no-new-date',
    re: /\bnew\s+Date\s*\(\s*\)/g,
    message:
      'new Date() (no args) reads the wall clock — nondeterministic across re-runs. Use the fixed ctx.now fire instant or pass an explicit ms/ISO argument. (new Date(value) with an argument is fine.)',
  },
  {
    id: 'no-math-random',
    re: /\bMath\.random\s*\(/g,
    message:
      'Math.random() is nondeterministic — each run produces a different value. Derive any needed variation from the run inputs (ctx.input, ctx.state, a ctx.tool result).',
  },
  {
    id: 'no-random-uuid',
    re: /\brandomUUID\s*\(/g,
    message:
      'randomUUID() mints a fresh id on every run, so a re-run after a crash duplicates work under a new id. Derive ids deterministically from the run inputs, or have a ctx.tool mint and return the id.',
  },
  {
    id: 'no-random-bytes',
    re: /\b(?:getRandomValues|randomBytes|randomFillSync|randomInt)\s*\(/g,
    message:
      'crypto randomness is nondeterministic — re-runs diverge. Use values derived from the run inputs instead.',
  },
  {
    id: 'no-performance-now',
    re: /\bperformance\.now\s*\(/g,
    message:
      'performance.now() reads a monotonic wall clock — nondeterministic across runs. Measure via ctx.runs timestamps instead.',
  },
  {
    id: 'no-raw-fetch',
    // `ctx.fetch(...)` is exempt: it is the audited connector rail (ledgered,
    // broker-injected, host-pinned, read-only) — the very thing this rule
    // steers toward. Everything else spelling `fetch(` is ambient I/O.
    re: /(?<!ctx\.)\bfetch\s*\(/g,
    message:
      'A raw fetch() is network I/O that bypasses the run ledger and the requires.tools allowlist. READS ride ctx.fetch (connector fires, broker-injected and host-pinned) or a declared ctx.tool(...); an external WRITE (send an email, call a mutating API) is staged, never sent: ctx.vault.invoke({ command: "outbox.stage", … }) parks it for the owner and the gateway executor performs the send (issue #306).',
  },
  {
    id: 'no-node-io-import',
    re: /\b(?:from|require\s*\(\s*)\s*['"](?:node:)?(?:fs(?:\/promises)?|child_process|net|http|https|dns|dgram|tls|cluster)['"]/g,
    message:
      'Direct node I/O modules (fs, child_process, net, http, …) bypass the run ledger and the requires.tools allowlist — their effects are unrecorded and undeclared. All I/O must go through ctx.tool(...).',
    target: 'withStrings',
  },
  {
    id: 'no-process-ambient',
    re: /\bprocess\.(?:env|hrtime|cwd|uptime|argv|pid|platform)\b/g,
    message:
      'Reading ambient process state (env, hrtime, cwd, argv, …) makes the handler depend on the host environment, not its run inputs. Pass configuration through the manifest / ctx.state instead.',
  },
];

/**
 * Sentinel that masked (non-code) characters collapse to — a NUL, which no
 * rule regex matches and which `\s` / `\b` treat as a non-word, non-space char.
 * Using a sentinel rather than a space is what lets `new Date('x')` stay
 * distinguishable from the argless `new Date()`: the masked argument becomes
 * `\0\0\0`, not whitespace that would read as empty parens.
 */
const MASK = '\0';

/**
 * Mask comments — and, when `maskStrings`, string/template literal bodies and
 * their delimiters — to the {@link MASK} sentinel (newlines preserved so
 * line/column math stays exact), leaving real code — including interpolated
 * `${…}` expressions inside template literals — intact. A small hand-written
 * scanner rather than a full parser: handlers are tiny `.js` modules and this
 * keeps the lint dependency-free, but it is sound for the literal/comment
 * shapes a handler actually contains. The scanner always *tracks* string state
 * (so a `//` inside a string is not mistaken for a comment); `maskStrings` only
 * decides whether string content is blanked.
 */
function maskNonCode(src: string, maskStrings: boolean): string {
  const out = src.split('');
  const mask = (k: number): void => {
    if (out[k] !== '\n') out[k] = MASK;
  };
  const maskStr = (k: number): void => {
    if (maskStrings) mask(k);
  };
  const n = src.length;
  // Saved brace depths for each open template-literal interpolation. Entering
  // `${` pushes the outer depth and resets; the matching `}` pops it.
  const tplStack: number[] = [];
  let mode: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' = 'code';
  let braceDepth = 0;
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : '';
    if (mode === 'code') {
      if (c === '/' && d === '/') {
        mask(i);
        mask(i + 1);
        mode = 'line';
        i += 2;
      } else if (c === '/' && d === '*') {
        mask(i);
        mask(i + 1);
        mode = 'block';
        i += 2;
      } else if (c === "'") {
        maskStr(i);
        mode = 'sq';
        i++;
      } else if (c === '"') {
        maskStr(i);
        mode = 'dq';
        i++;
      } else if (c === '`') {
        maskStr(i);
        mode = 'tpl';
        i++;
      } else if (c === '{') {
        braceDepth++;
        i++;
      } else if (c === '}') {
        if (braceDepth === 0 && tplStack.length > 0) {
          // Closes a template interpolation — the brace is template syntax.
          braceDepth = tplStack.pop()!;
          mask(i);
          mode = 'tpl';
          i++;
        } else {
          if (braceDepth > 0) braceDepth--;
          i++;
        }
      } else {
        i++;
      }
    } else if (mode === 'line') {
      if (c === '\n') mode = 'code';
      else mask(i);
      i++;
    } else if (mode === 'block') {
      if (c === '*' && d === '/') {
        mask(i);
        mask(i + 1);
        mode = 'code';
        i += 2;
      } else {
        mask(i);
        i++;
      }
    } else if (mode === 'sq' || mode === 'dq') {
      const quote = mode === 'sq' ? "'" : '"';
      if (c === '\\') {
        maskStr(i);
        if (i + 1 < n) maskStr(i + 1);
        i += 2;
      } else if (c === quote) {
        maskStr(i);
        mode = 'code';
        i++;
      } else {
        maskStr(i);
        i++;
      }
    } else {
      // template literal body
      if (c === '\\') {
        maskStr(i);
        if (i + 1 < n) maskStr(i + 1);
        i += 2;
      } else if (c === '`') {
        maskStr(i);
        mode = 'code';
        i++;
      } else if (c === '$' && d === '{') {
        // Enter an interpolation: the `${` is template syntax, the body is code.
        maskStr(i);
        maskStr(i + 1);
        tplStack.push(braceDepth);
        braceDepth = 0;
        mode = 'code';
        i += 2;
      } else {
        maskStr(i);
        i++;
      }
    }
  }
  return out.join('');
}

/** Map a character offset to a 1-based {line, column}. */
function offsetToPosition(src: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let k = 0; k < offset; k++) {
    if (src[k] === '\n') {
      line++;
      lineStart = k + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

/**
 * Scan a handler's source for ambient-I/O and nondeterminism patterns. Returns
 * one finding per match, sorted by position. An empty array means the handler
 * is, lexically, clean. Pure — no I/O, no throw.
 */
export function lintHandlerSource(source: string): HandlerLintFinding[] {
  const codeOnly = maskNonCode(source, true);
  const withStrings = maskNonCode(source, false);
  const lines = source.split('\n');
  const findings: HandlerLintFinding[] = [];
  for (const rule of RULES) {
    const masked = rule.target === 'withStrings' ? withStrings : codeOnly;
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(masked)) !== null) {
      const { line, column } = offsetToPosition(masked, m.index);
      findings.push({
        rule: rule.id,
        message: rule.message,
        line,
        column,
        snippet: (lines[line - 1] ?? '').trim(),
      });
      // Guard against a zero-width match looping forever.
      if (m.index === rule.re.lastIndex) rule.re.lastIndex++;
    }
  }
  findings.sort((a, b) => a.line - b.line || a.column - b.column);
  return findings;
}

/**
 * Format lint findings as a single multi-line authoring error — the shape the
 * gateway publish gate surfaces back to the builder. Returns `undefined` when
 * there are no findings.
 */
export function formatHandlerLintError(
  findings: readonly HandlerLintFinding[],
  file = 'handler.js',
): string | undefined {
  if (findings.length === 0) return undefined;
  const lines = findings.map(
    (f) => `  ${file}:${f.line}:${f.column} [${f.rule}] ${f.message}\n    → ${f.snippet}`,
  );
  const count = findings.length === 1 ? '1 unsafe pattern' : `${findings.length} unsafe patterns`;
  return (
    `${file} has ${count} — an automation handler's effects must go through the audited ctx.* ` +
    `rails, and it must stay deterministic so a re-run does not diverge. Route all I/O and ` +
    `nondeterminism through ctx.*:\n` +
    lines.join('\n')
  );
}
