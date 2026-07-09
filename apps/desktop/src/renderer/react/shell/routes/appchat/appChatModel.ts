// Pure model layer for the React per-app chat copilot (issue #325, full-React
// flip). Types + the tool-summary / hydration / formatting helpers ported
// verbatim from the vanilla `window.AppChat.mount` closure (app-chat.ts). Kept
// pure (no DOM, no closure state) so useAppChat stays a thin state container and
// these stay unit-testable.

/** A single tool invocation; adjacent calls fold into one `toolGroup` bubble. */
export interface AppToolCall {
  id: string;
  tool: string;
  sql?: string;
  args?: unknown;
  summary?: string;
  state: 'running' | 'ok' | 'error';
  result?: unknown;
  errorText?: string;
  open?: boolean;
}

export type AppConversationMsg =
  | { kind: 'user'; text: string }
  | { kind: 'ai'; text: string; streaming?: boolean; error?: boolean }
  | { kind: 'toolGroup'; id: string; calls: AppToolCall[]; open: boolean };

// ---- Coupled Agent · Model picker constants/types ----
export type RunnerKey = 'codex' | 'claude-code' | 'openclaw';
export type SwitchableKind = 'codex' | 'claude-code';
export const isSwitchable = (k: RunnerKey): k is SwitchableKind =>
  k === 'codex' || k === 'claude-code';

export const AM_ACCENT: Record<RunnerKey, string> = {
  codex: '#10b981',
  'claude-code': '#a855f7',
  openclaw: '#4950f6',
};
export const AM_TITLE: Record<RunnerKey, string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  openclaw: 'OpenClaw',
};
export const AM_BIN: Record<RunnerKey, string> = {
  codex: 'codex',
  'claude-code': 'claude',
  openclaw: 'openclaw',
};

/** Empty-state starter prompt chips. */
export const STARTER_PROMPTS = [
  'What can this app do?',
  'Show me all the records',
  'Summarize the data',
];

export const escapeHtml = (s: string): string =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function toolVerb(tool: string): string {
  return tool.charAt(0).toUpperCase() + tool.slice(1);
}

export function summarizeToolArgs(sql?: string, args?: unknown): string | undefined {
  // SQL-carrying tools (vault_sql) surface the statement's first line;
  // everything else falls back to a short string arg.
  if (sql) {
    const firstLine = sql.split('\n').find((l) => l.trim().length > 0) ?? sql;
    return firstLine.trim().replace(/\s+/g, ' ').slice(0, 90);
  }
  if (args && typeof args === 'object') {
    for (const k of ['name', 'path', 'query']) {
      const v = (args as Record<string, unknown>)[k];
      if (typeof v === 'string' && v.length > 0) return v.slice(0, 90);
    }
  }
  return undefined;
}

/** Consolidated pill label: adjacent same-verb calls collapse to "Verb ×N". */
export function summarizeGroup(calls: AppToolCall[]): string {
  const segs: { verb: string; count: number }[] = [];
  for (const c of calls) {
    const verb = toolVerb(c.tool);
    const last = segs[segs.length - 1];
    if (last && last.verb === verb) last.count += 1;
    else segs.push({ verb, count: 1 });
  }
  return segs.map((s) => (s.count > 1 ? `${s.verb} ×${s.count}` : s.verb)).join(', ');
}

/**
 * Rebuild the renderer's `AppConversationMsg[]` from the coarse-grained
 * persisted messages: consecutive `tool` rows fold into a single toolGroup so
 * the UI matches what the user saw live.
 */
export function hydrateMessages(
  rows: Array<{ idx: number; payload: CentraidConversationHistoryMessage }>,
): AppConversationMsg[] {
  const out: AppConversationMsg[] = [];
  for (const { payload } of rows) {
    if (payload.kind === 'user') {
      out.push({ kind: 'user', text: payload.text });
    } else if (payload.kind === 'ai') {
      out.push({ kind: 'ai', text: payload.text, error: payload.error });
    } else if (payload.kind === 'tool') {
      const call: AppToolCall = {
        id: payload.id,
        tool: payload.tool,
        sql: payload.sql,
        args: payload.args,
        summary: summarizeToolArgs(payload.sql, payload.args),
        state: payload.state,
        result: payload.result,
        errorText: payload.errorText,
      };
      const last = out[out.length - 1];
      if (last && last.kind === 'toolGroup') {
        out[out.length - 1] = { ...last, calls: [...last.calls, call] };
      } else {
        out.push({ kind: 'toolGroup', id: call.id, calls: [call], open: false });
      }
    }
  }
  return out;
}

export function relativeTime(updatedAt: number, now = Date.now()): string {
  const diff = Math.max(0, now - updatedAt);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  const y = Math.floor(d / 365);
  return `${y}y ago`;
}

export function bucketFor(updatedAt: number, now = Date.now()): string {
  const day = 86_400_000;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTodayMs = startOfToday.getTime();
  if (updatedAt >= startOfTodayMs) return 'Today';
  if (updatedAt >= startOfTodayMs - day) return 'Yesterday';
  if (updatedAt >= startOfTodayMs - 7 * day) return 'This week';
  if (updatedAt >= startOfTodayMs - 30 * day) return 'This month';
  return 'Earlier';
}

export function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v ?? null);
  } catch {
    return String(v);
  }
}

/**
 * Tool results come back as a JSON string in `content[].text` (per the
 * pi-agent-core AgentToolResult shape). Try to recover the rows payload.
 */
export function parseToolPayload(v: unknown): Record<string, unknown> | undefined {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    if ('columns' in obj && 'rows' in obj) return obj;
    if (Array.isArray(obj.content)) {
      const text = (obj.content as Array<{ type?: string; text?: string }>)
        .filter((c) => c?.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text!)
        .join('');
      if (text) {
        try {
          return JSON.parse(text) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      }
    }
  }
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** First-message title: whitespace-collapsed + truncated (was server-side). */
export function deriveTitle(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 60);
}
