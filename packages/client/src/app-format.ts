// Pure formatting + display helpers lifted out of the app.ts shell IIFE.
// Every function here is stateless: it depends only on its arguments and
// ambient globals (Icon, ICON_PALETTE) declared in types.d.ts, so it can be
// imported by app.ts and the route modules split out of it. No closure state,
// no imports — keep it that way so this module stays trivially testable.

// Canonical icon → palette-hue mapping, lifted from the Centraid Redesign
// bold.jsx APPS fixture. Every app type has a fixed colour identity in the
// design (Todos is always indigo, Habits always rose, etc.). Used when minting
// a new app and when hydrating drafts off disk. Sparkle is the default icon for
// drafts and freshly-prompted apps before an icon is inferred — it gets the
// violet sub-accent.
const CANONICAL_ICON_COLOR_KEY: Record<string, ColorKeyType> = {
  Gift: 'violet',
  Habit: 'rose',
  Journal: 'amber',
  Mood: 'violet',
  Plant: 'slate',
  Pomodoro: 'forest',
  Sparkle: 'violet',
  Spend: 'ochre',
  Todo: 'indigo',
  Water: 'teal',
};

export function colorKeyForIcon(iconKey: IconNameType | string): ColorKeyType {
  return CANONICAL_ICON_COLOR_KEY[iconKey] ?? 'violet';
}

export function colorForIcon(iconKey: IconNameType | string): ColorHexType {
  const c = (ICON_PALETTE as unknown as Record<string, ColorHexType>)[colorKeyForIcon(iconKey)];
  return c ?? ('#7C5BD9' as ColorHexType);
}

/**
 * Resolve a home tile's visual identity from a gateway listing row's
 * `app.json` keys (issue #263). Raw pass-through strings from the wire —
 * validate against the Icon registry / palette before trusting them.
 * Returns `null` when neither key resolves, so callers fall back to the
 * legacy stored UserAppMeta / inference chain.
 */
export function tileVisualFromListing(row: {
  iconKey?: string;
  colorKey?: string;
}): { iconKey: IconNameType; colorKey: ColorKeyType; color: ColorHexType } | null {
  const iconOk = !!row.iconKey && !!(Icon as Record<string, unknown>)[row.iconKey];
  const palette = ICON_PALETTE as unknown as Record<string, ColorHexType>;
  const colorOk = !!row.colorKey && !!palette[row.colorKey];
  if (!iconOk && !colorOk) return null;
  const iconKey = (iconOk ? row.iconKey : 'Sparkle') as IconNameType;
  const colorKey = (colorOk ? row.colorKey : colorKeyForIcon(iconKey)) as ColorKeyType;
  return { iconKey, colorKey, color: palette[colorKey] ?? colorForIcon(iconKey) };
}

// Prompt-keyword icon inference for freshly generated apps. The pool is
// the canonical set above; colour follows the icon (never random) so the
// same kind of app always lands with the same identity.
const ICON_KEYS_POOL: IconNameType[] = [
  'Todo',
  'Habit',
  'Journal',
  'Pomodoro',
  'Plant',
  'Water',
  'Gift',
  'Mood',
];

/**
 * Infer a new app's tile identity + short display name from its build
 * prompt. Lifted out of the cards module (issue #263) so the builder's
 * create flow can stamp the same inference into the scaffolded app.json.
 */
export function inferAppVisual(prompt: string): {
  iconKey: IconNameType;
  colorKey: ColorKeyType;
  color: ColorHexType;
  name: string;
} {
  const p = prompt.toLowerCase();
  const map: [IconNameType, RegExp][] = [
    ['Todo', /\b(todo|to-do|task|grocery|list|shopping)\b/],
    ['Habit', /\b(habit|streak|daily)\b/],
    ['Journal', /\b(journal|diary|note|writing|log|read|reading)\b/],
    ['Pomodoro', /\b(pomodoro|timer|focus|work\s*block)\b/],
    ['Plant', /\b(plant|water|garden)\b/],
    ['Water', /\b(hydrate|water|cup|drink)\b/],
    ['Gift', /\b(gift|present|idea|wish)\b/],
    ['Mood', /\b(mood|feel|emotion|check[- ]?in)\b/],
  ];
  let iconKey: IconNameType =
    ICON_KEYS_POOL[Math.floor(Math.random() * ICON_KEYS_POOL.length)] ?? 'Todo';
  for (const [k, re] of map) {
    if (re.test(p)) {
      iconKey = k;
      break;
    }
  }
  // Colour is derived from the icon, not random — matches the design's
  // fixture (Todos always indigo, Habits always rose, etc.). If no prompt
  // keywords hit, `iconKey` falls back to a random pool entry; that entry
  // still has a canonical colour via colorKeyForIcon().
  const colorKey = colorKeyForIcon(iconKey);
  const cleaned = prompt.replace(/^\s*(a|an)\s+/i, '').trim();
  const words = cleaned.split(/\s+/).slice(0, 3).join(' ');
  const name = words.charAt(0).toUpperCase() + words.slice(1);
  return { iconKey, colorKey, color: colorForIcon(iconKey), name: name || 'New app' };
}

// "X ago" relative-time formatter. Mirrors builder.ts:relativeWhen, but
// co-located here so app.ts doesn't need to reach into the builder IIFE.
export function relativeTime(iso?: string): string {
  if (!iso) return 'Recently';
  try {
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return 'Recently';
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d ago`;
    return new Date(iso).toLocaleDateString();
  } catch {
    return 'Recently';
  }
}

// Compact token count for the standing-order list / run rail.
export function fmtTokens(n: number): string {
  if (n <= 0) return '—';
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

// A cron next-run pill label: "Today, 6:00 PM" / "Tomorrow, 6:00 PM" /
// "Thu, 6:00 PM" (weekday within the week, else "Mon 9").
export function relativeRunLabel(d: Date): string {
  const startOfDay = (x: Date): number =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(d) - startOfDay(new Date())) / 86_400_000);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const day =
    dayDiff === 0
      ? 'Today'
      : dayDiff === 1
        ? 'Tomorrow'
        : dayDiff > 1 && dayDiff < 7
          ? d.toLocaleDateString(undefined, { weekday: 'short' })
          : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${day}, ${time}`;
}

// Trigger-origin/kind → human label for a run row.
export function runTriggerLabel(run: CentraidAutomationRunRecord): string {
  if (run.triggerOrigin === 'webhook') return 'Webhook trigger';
  const byKind: Record<string, string> = {
    scheduled: 'Scheduled run',
    manual: 'Manual run',
    replay: 'Replayed run',
    on_failure: 'Failure-triggered run',
    interactive: 'Interactive run',
  };
  return byKind[run.triggerKind] ?? 'Run';
}

// A node is still in flight when it has started but not ended (and hasn't
// errored). Drives the pulsing accent spinner on its rail circle.
export function nodeRunStatus(node: CentraidAutomationRunNode): 'ok' | 'running' | 'fail' {
  if (node.endedAt === undefined && !node.error) return 'running';
  return node.ok ? 'ok' : 'fail';
}

/**
 * Translate a 5-field cron expression into a small-caps display
 * string. Covers the patterns the builder agent actually emits
 * (`0 20 * * 0`, `0 17 * * 1-5`, `*[asterisk-slash]N * * * *`, …);
 * unrecognized expressions fall back to the raw text so the
 * end-user at least sees something stable.
 *
 * Time zone is the user's local — the cron expression runs in UTC
 * server-side, but for the in-app surface we show what they'll
 * actually feel.
 */
export function cronToHuman(expr: string): string {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return expr;
  const [min, hour, dom, month, dow] = fields as [string, string, string, string, string];

  // The cron digits are UTC; anchor them with the UTC setter so
  // toLocaleTimeString performs the actual UTC→local conversion.
  const utcAnchor = (h: number, m: number): Date => {
    const date = new Date();
    date.setUTCHours(h, m, 0, 0);
    return date;
  };
  const fmtTime = (h: number, m: number): string =>
    utcAnchor(h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  // When the conversion crosses midnight, day-of-week labels shift too:
  // -1, 0, or +1 days relative to the UTC day.
  const dayShift = (h: number, m: number): number => {
    const date = utcAnchor(h, m);
    const diff = (date.getDay() - date.getUTCDay() + 7) % 7;
    return diff === 6 ? -1 : diff;
  };

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // Every N minutes
  const stepMin = min.match(/^\*\/(\d+)$/);
  if (stepMin && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    const n = Number(stepMin[1]);
    return n === 1 ? 'Every minute' : `Every ${n} minutes`;
  }

  // Hourly on the dot
  if (min === '0' && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return 'Hourly';
  }

  const minNum = Number(min);
  const hourNum = Number(hour);
  const isExactTime = !Number.isNaN(minNum) && !Number.isNaN(hourNum);

  if (isExactTime && dom === '*' && month === '*') {
    const time = fmtTime(hourNum, minNum);
    if (dow === '*') return `Daily at ${time}`;
    const shift = dayShift(hourNum, minNum);
    if (shift === 0) {
      if (dow === '1-5') return `Weekdays at ${time}`;
      if (dow === '0,6' || dow === '6,0') return `Weekends at ${time}`;
    }
    // Crossing midnight turns "weekdays"/"weekends" into an off-by-one set
    // with no honest compact label — fall through to the raw-expr fallback.
    const single = Number(dow);
    if (!Number.isNaN(single) && single >= 0 && single <= 6) {
      return `${dayNames[(single + shift + 7) % 7]}s at ${time}`;
    }
  }

  return expr;
}

// Human-readable summary of an automation's trigger list. One cron → its
// `cronToHuman` form; many crons → a count; webhook/data/condition triggers
// each add a tag; an empty list reads "Manual only".
export function triggersSummary(triggers: ReadonlyArray<{ kind: string; expr?: string }>): string {
  const crons = triggers.filter((t) => t.kind === 'cron');
  const hasWebhook = triggers.some((t) => t.kind === 'webhook');
  const hasData = triggers.some((t) => t.kind === 'data');
  const hasCondition = triggers.some((t) => t.kind === 'condition');
  const parts: string[] = [];
  if (crons.length === 1 && crons[0]!.expr) parts.push(cronToHuman(crons[0]!.expr));
  else if (crons.length > 1) parts.push(`${crons.length} schedules`);
  if (hasWebhook) parts.push('Webhook');
  if (hasData) parts.push('On data changes');
  if (hasCondition) parts.push('On condition');
  return parts.join(' · ') || 'Manual only';
}

/**
 * Render a condition trigger's `where` clauses compactly: one
 * `column op value` line per clause — the builder's authoring form
 * (BuilderAutomationTriggers) and the automation view screen
 * (automationsData) both read a condition trigger's `where`, so this lives
 * here rather than duplicated per layer. Returns `null` for an absent/empty
 * `where` (the caller decides what "no clause" renders as); falls back to
 * raw pretty-printed JSON for any shape that isn't a structured
 * `{column, op, value?}` array.
 */
export function formatWhereClauses(where: unknown): string | null {
  if (!Array.isArray(where) || where.length === 0) return null;
  const lines: string[] = [];
  for (const raw of where) {
    if (!raw || typeof raw !== 'object') return JSON.stringify(where, null, 2);
    const c = raw as Record<string, unknown>;
    if (typeof c.column !== 'string' || typeof c.op !== 'string') {
      return JSON.stringify(where, null, 2);
    }
    lines.push(`${c.column} ${c.op}${c.value !== undefined ? ` ${JSON.stringify(c.value)}` : ''}`);
  }
  return lines.join('\n');
}

// Duration in ms → "950ms" / "1.4s" / "2m 5s".
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return secs ? `${mins}m ${secs}s` : `${mins}m`;
}

// Pretty-print a JSON string, passing it through unchanged when it doesn't
// parse (e.g. an already-formatted blob or a non-JSON value).
export function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** True when the template is an automation app (`kind: 'automation'`). */
export function isAutomationTemplate(t: { kind?: 'app' | 'automation' }): boolean {
  return t.kind === 'automation';
}
