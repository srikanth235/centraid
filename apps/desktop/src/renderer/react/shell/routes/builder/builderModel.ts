// Pure model layer for the React builder (issue #325, R5-B). Types + the
// tool-summary and snapshot-derivation helpers ported verbatim from the vanilla
// openBuilder closure (builder.ts). Kept pure (no DOM, no closure state passed
// in explicitly) so useBuilder stays a thin state container and these are unit
// testable.

import type { BuilderChatSnapshot, BuilderMsgDTO } from '../../../bridge.js';

/** A single tool invocation; several fold into one `toolGroup` chat bubble. */
export interface ToolCall {
  id: string;
  tool: string;
  summary?: string;
  state: 'running' | 'ok' | 'error';
}

export type ConversationMsg =
  | { kind: 'divider'; text: string }
  | { kind: 'status'; text: string; spinning?: boolean }
  | { kind: 'user'; text: string }
  | { kind: 'ai'; text: string; streaming?: boolean }
  | { kind: 'thinking'; text: string; streaming?: boolean }
  | { kind: 'toolGroup'; id: string; calls: ToolCall[]; open: boolean };

export type Tab = 'preview' | 'code' | 'cloud' | 'config' | 'runs' | 'flow';
export type ChatView = 'chat' | 'history';
export type DeviceKey = 'mobile' | 'tablet' | 'desktop';

export const FILE_WRITING_TOOLS = new Set(['write', 'edit', 'multi_edit']);

export const BUILDER_SUGGESTIONS = [
  'Improve the layout',
  'Add saved data',
  'Polish the visual style',
  'Prepare to publish',
];

/** Verb form of a tool name — the pill label and per-row name. */
export function toolVerb(tool: string): string {
  switch (tool) {
    case 'read':
      return 'Reading';
    case 'write':
      return 'Writing';
    case 'edit':
    case 'multi_edit':
      return 'Editing';
    case 'bash':
      return 'Running';
    case 'glob':
      return 'Listing';
    case 'grep':
      return 'Searching';
    default:
      return tool.charAt(0).toUpperCase() + tool.slice(1);
  }
}

/** Consolidated pill label: adjacent same-verb calls collapse to "Verb ×N". */
export function summarizeGroup(calls: ToolCall[]): string {
  const segs: { verb: string; count: number }[] = [];
  for (const c of calls) {
    const verb = toolVerb(c.tool);
    const last = segs[segs.length - 1];
    if (last && last.verb === verb) last.count += 1;
    else segs.push({ verb, count: 1 });
  }
  return segs.map((s) => (s.count > 1 ? `${s.verb} ×${s.count}` : s.verb)).join(', ');
}

/** One-line, human-readable summary of a tool call's args. */
export function summarizeToolArgs(tool: string, args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  const pickStr = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = a[k];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return undefined;
  };
  const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  switch (tool) {
    case 'read':
    case 'write':
    case 'edit':
    case 'multi_edit':
      return pickStr('path', 'file_path');
    case 'bash': {
      const cmd = pickStr('command');
      return cmd ? truncate(cmd.replace(/\s+/g, ' ').trim(), 90) : undefined;
    }
    case 'glob':
    case 'grep': {
      const pattern = pickStr('pattern', 'query');
      const path = pickStr('path');
      if (pattern && path) return `${pattern}  in  ${path}`;
      return pattern ?? path;
    }
    default:
      for (const k of ['path', 'file_path', 'command', 'pattern', 'query', 'name', 'id']) {
        const v = a[k];
        if (typeof v === 'string' && v.length > 0) return truncate(v, 90);
      }
      return undefined;
  }
}

/** Map an internal message to the wire DTO the React chat pane renders. */
export function toBuilderMsg(m: ConversationMsg, appVersionCount: number): BuilderMsgDTO {
  if (m.kind === 'divider') return { kind: 'divider', text: m.text };
  if (m.kind === 'status') return { kind: 'status', text: m.text, spinning: !!m.spinning };
  if (m.kind === 'user') return { kind: 'user', text: m.text };
  if (m.kind === 'thinking') {
    return {
      kind: 'thinking',
      text: m.text || (m.streaming ? '…' : ''),
      streaming: !!m.streaming,
      header: m.streaming ? 'Thinking…' : 'Thought',
    };
  }
  if (m.kind === 'toolGroup') {
    const running = m.calls.some((c) => c.state === 'running');
    const error = m.calls.some((c) => c.state === 'error');
    const writes = m.calls.filter(
      (c) => FILE_WRITING_TOOLS.has(c.tool) && c.state === 'ok' && c.summary,
    );
    let change: { count: number; subtitle: string; version: string } | null = null;
    if (writes.length > 0) {
      const basenames = writes.map((c) => (c.summary ?? '').split('/').pop() ?? '');
      const shown = basenames.slice(0, 3);
      const moreCount = basenames.length - shown.length;
      const subtitle = shown.join(' · ') + (moreCount > 0 ? ` · +${moreCount} more` : '');
      const version = appVersionCount > 0 ? `v${appVersionCount + 1}` : 'draft';
      change = { count: writes.length, subtitle, version };
    }
    return {
      kind: 'toolGroup',
      id: m.id,
      label: summarizeGroup(m.calls),
      open: m.open,
      running,
      error,
      rows: m.open
        ? m.calls.map((c) => ({ state: c.state, verb: toolVerb(c.tool), target: c.summary ?? '' }))
        : [],
      change,
    };
  }
  const text = m.text || (m.streaming ? '…' : '');
  return { kind: 'ai', paras: text.split('\n\n') };
}

/** Live state of the current turn for the determinate progress strip. */
export function turnProgress(
  chat: ConversationMsg[],
  currentAiMsgIndex: number,
): BuilderChatSnapshot['progress'] {
  let userIdx = -1;
  for (let i = chat.length - 1; i >= 0; i -= 1) {
    if (chat[i]!.kind === 'user') {
      userIdx = i;
      break;
    }
  }
  let completed = 0;
  let running: ToolCall | null = null;
  let group: Extract<ConversationMsg, { kind: 'toolGroup' }> | null = null;
  for (let i = userIdx + 1; i < chat.length; i += 1) {
    const m = chat[i]!;
    if (m.kind !== 'toolGroup') continue;
    group = m;
    for (const c of m.calls) {
      if (c.state === 'running') running = c;
      else completed += 1;
    }
  }
  if (running) {
    return {
      verb: toolVerb(running.tool),
      file: running.summary ?? '',
      sub: group ? summarizeGroup(group.calls) : 'Working through your request',
      filled: Math.max(1, Math.min(4, completed + 1)),
    };
  }
  if (currentAiMsgIndex >= 0) {
    return { verb: 'Writing', file: '', sub: 'Composing the reply', filled: 4 };
  }
  if (group) {
    return {
      verb: 'Working',
      file: '',
      sub: summarizeGroup(group.calls),
      filled: Math.max(1, Math.min(4, completed)),
    };
  }
  return { verb: 'Thinking', file: '', sub: 'Reading your request', filled: 1 };
}

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Coarse relative time for the header edit-stamp ("just now" / "3h ago"). */
export function relTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < MIN) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MIN)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  return `${Math.floor(diff / DAY)}d ago`;
}

/** Parse the ISO timestamp embedded in a gateway version id, if present. */
export function parseVersionTime(versionId: string): number | undefined {
  const m = versionId.match(/^v_(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})/);
  if (!m) return undefined;
  return Date.parse(`${m[1]}T${m[2]}:${m[3]}:00Z`);
}
