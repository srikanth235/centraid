// governance: allow-repo-hygiene file-size-limit one cohesive chat surface — thread list, streaming transcript, markdown-lite + typed-block renderer, and composer are one view with heavy shared state; pending split of the block renderers into a sibling module
// Assistant route — the vault's shell-level Q&A surface ("ask your vault").
// ChatGPT-shaped: past conversations down the left, the active thread on
// the right, streaming answers inline. Answers are markdown-lite prose with
// three typed fenced blocks the renderer draws itself (table / chart /
// stat — inline SVG, no libraries) plus @[label](ref:type/id) entity chips
// resolved to live cards through the owner-side resolve endpoint. Every
// turn's vault_sql calls surface as a collapsible "queries" pill — the
// how-I-got-this transparency drawer.
//
// Self-contained like the other extracted routes: reaches the shell only
// through ShellContext primitives and the gateway client.

import {
  ASSISTANT_APP_ID,
  createConversation,
  deleteConversation,
  listConversations,
  loadConversation,
  resolveAssistantRefs,
  streamAssistantTurn,
  type TurnStreamEvent,
} from './gateway-client.js';
import { relativeTime } from './app-format.js';
import { requireReactBridge } from './react/bridge.js';
import type { AssistantSnapshot, AsstMsgDTO } from './react/bridge.js';
import type { ShellContext } from './app-shell-context.js';

interface AsstToolCall {
  id: string;
  tool: string;
  sql?: string;
  state: 'run' | 'ok' | 'error';
  totalRows?: number;
  durationMs?: number;
  errorText?: string;
}

type AsstMsg =
  | { kind: 'user'; text: string }
  | { kind: 'ai'; text: string; error?: boolean; streaming?: boolean }
  | { kind: 'tools'; calls: AsstToolCall[] };

export interface AssistantModule {
  renderAssistant(): void;
}

const SUGGESTIONS = [
  'What did I spend the most on last month?',
  'Who have I not talked to in a while?',
  'What tasks are due this week?',
  'Which notes mention travel plans?',
];

export function createAssistantModule(ctx: ShellContext): AssistantModule {
  const { el, clear, mountShellPage, recordRoute, registerCleanup, showToast } = ctx;

  const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  // ── Markdown-lite + typed blocks ─────────────────────────────────────
  // Escape-first, then a small allowlist of inline markup. Fenced blocks
  // are split out beforehand, so prose segments never contain backtick
  // fences. Anything malformed renders as visible text — never as markup.

  function inlineHtml(raw: string): string {
    let s = escapeHtml(raw);
    // Entity refs: @[Label](ref:type/id) → chip (resolved after mount).
    s = s.replace(
      /@\[([^\]]+)\]\(ref:([a-z_]+\.[a-z_]+)\/([A-Za-z0-9_-]+)\)/g,
      (_m, label: string, type: string, id: string) =>
        `<button type="button" class="cd-asst-ref" data-ref-type="${type}" data-ref-id="${id}">${label}</button>`,
    );
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    return s;
  }

  /** Prose → paragraphs / headings / bullet lists, inline-formatted. */
  function proseNodes(text: string): HTMLElement[] {
    const out: HTMLElement[] = [];
    let list: HTMLElement | null = null;
    const flushList = (): void => {
      if (list) out.push(list);
      list = null;
    };
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trimEnd();
      if (line.trim() === '') {
        flushList();
        continue;
      }
      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      if (bullet) {
        list ??= el('ul', { class: 'cd-asst-ul' });
        list.append(el('li', { trustedHtml: inlineHtml(bullet[1] ?? '') }));
        continue;
      }
      flushList();
      const heading = line.match(/^(#{1,3})\s+(.*)$/);
      if (heading) {
        out.push(
          el(`h${Math.min(heading[1]!.length + 2, 5)}`, {
            class: 'cd-asst-h',
            trustedHtml: inlineHtml(heading[2] ?? ''),
          }),
        );
        continue;
      }
      out.push(el('p', { class: 'cd-asst-p', trustedHtml: inlineHtml(line) }));
    }
    flushList();
    return out;
  }

  function tableBlock(spec: unknown): HTMLElement | null {
    const s = spec as { columns?: unknown; rows?: unknown; caption?: unknown };
    if (!Array.isArray(s.columns) || !Array.isArray(s.rows)) return null;
    const table = el('table', { class: 'cd-asst-table' });
    table.append(
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          s.columns.map((c) => el('th', {}, String(c))),
        ),
      ),
    );
    const body = el('tbody');
    for (const row of (s.rows as unknown[]).slice(0, 100)) {
      if (!Array.isArray(row)) continue;
      body.append(
        el(
          'tr',
          {},
          row.map((v) => el('td', {}, v === null || v === undefined ? '—' : String(v))),
        ),
      );
    }
    table.append(body);
    const wrap = el('div', { class: 'cd-asst-block cd-asst-table-wrap' }, table);
    if (typeof s.caption === 'string' && s.caption) {
      wrap.append(el('div', { class: 'cd-asst-caption' }, s.caption));
    }
    return wrap;
  }

  function statBlock(spec: unknown): HTMLElement | null {
    const s = spec as { value?: unknown; label?: unknown; sub?: unknown };
    if (typeof s.value !== 'string' && typeof s.value !== 'number') return null;
    return el('div', { class: 'cd-asst-block cd-asst-stat' }, [
      el('div', { class: 'cd-asst-stat-value' }, String(s.value)),
      typeof s.label === 'string' ? el('div', { class: 'cd-asst-stat-label' }, s.label) : false,
      typeof s.sub === 'string' ? el('div', { class: 'cd-asst-stat-sub' }, s.sub) : false,
    ] as ElChild[]);
  }

  interface ChartSpec {
    type: 'bar' | 'line';
    x: string[];
    series: { label?: string; values: number[] }[];
    title?: string;
  }

  function chartBlock(spec: unknown): HTMLElement | null {
    const s = spec as Partial<ChartSpec>;
    if ((s.type !== 'bar' && s.type !== 'line') || !Array.isArray(s.x)) return null;
    const series = (Array.isArray(s.series) ? s.series : [])
      .filter((r) => r && Array.isArray(r.values))
      .slice(0, 3);
    if (series.length === 0) return null;
    const W = 640;
    const H = 220;
    const PADX = 6;
    const PADY = 18;
    const n = s.x.length;
    const all = series.flatMap((r) => r.values.filter((v) => Number.isFinite(v)));
    const max = Math.max(...all, 0);
    const min = Math.min(...all, 0);
    const span = max - min || 1;
    const py = (v: number): number => H - PADY - ((v - min) / span) * (H - PADY * 2);
    const parts: string[] = [];
    if (s.type === 'bar') {
      const group = (W - PADX * 2) / Math.max(n, 1);
      const bw = Math.max(4, (group * 0.7) / series.length);
      series.forEach((r, si) => {
        r.values.slice(0, n).forEach((v, i) => {
          if (!Number.isFinite(v)) return;
          const x = PADX + i * group + group * 0.15 + si * bw;
          const y = Math.min(py(v), py(0));
          const h = Math.abs(py(v) - py(0));
          parts.push(
            `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h, 1).toFixed(1)}" rx="2" fill="var(--accent)" opacity="${1 - si * 0.35}"/>`,
          );
        });
      });
    } else {
      const px = (i: number): number => (n <= 1 ? W / 2 : PADX + (i / (n - 1)) * (W - PADX * 2));
      series.forEach((r, si) => {
        const pts = r.values
          .slice(0, n)
          .map((v, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)} ${py(v).toFixed(1)}`)
          .join(' ');
        parts.push(
          `<path d="${pts}" fill="none" stroke="var(--accent)" stroke-width="2" opacity="${1 - si * 0.35}" stroke-linecap="round" stroke-linejoin="round"/>`,
        );
      });
    }
    const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="cd-asst-chart-svg">${parts.join('')}</svg>`;
    const labels = el(
      'div',
      { class: 'cd-asst-chart-x' },
      s.x.slice(0, 12).map((v) => el('span', {}, String(v))),
    );
    const wrap = el('div', { class: 'cd-asst-block cd-asst-chart' });
    if (typeof s.title === 'string' && s.title)
      wrap.append(el('div', { class: 'cd-asst-caption' }, s.title));
    wrap.append(el('div', { class: 'cd-asst-chart-plot', trustedHtml: svg }), labels);
    if (series.some((r) => r.label)) {
      wrap.append(
        el(
          'div',
          { class: 'cd-asst-chart-legend' },
          series.map((r, si) =>
            el(
              'span',
              { style: { opacity: String(1 - si * 0.35) } },
              r.label ?? `Series ${si + 1}`,
            ),
          ),
        ),
      );
    }
    return wrap;
  }

  /** Full answer → prose + typed blocks + plain code fences, in order. */
  function richAnswer(text: string): HTMLElement {
    const host = el('div', { class: 'cd-asst-rich' });
    const fence = /```(block:table|block:chart|block:stat|[a-z]*)\n([\s\S]*?)```/g;
    let last = 0;
    let m: RegExpExecArray | null;
    const pushProse = (seg: string): void => {
      for (const node of proseNodes(seg)) host.append(node);
    };
    while ((m = fence.exec(text)) !== null) {
      pushProse(text.slice(last, m.index));
      last = m.index + m[0].length;
      const tag = m[1] ?? '';
      const payload = m[2] ?? '';
      if (tag.startsWith('block:')) {
        let node: HTMLElement | null = null;
        try {
          const spec: unknown = JSON.parse(payload);
          node =
            tag === 'block:table'
              ? tableBlock(spec)
              : tag === 'block:chart'
                ? chartBlock(spec)
                : statBlock(spec);
        } catch {
          node = null;
        }
        // Malformed block → visible payload, never silent loss.
        host.append(node ?? el('pre', { class: 'cd-asst-pre' }, payload.trim()));
      } else {
        host.append(el('pre', { class: 'cd-asst-pre' }, payload.replace(/\n$/, '')));
      }
    }
    pushProse(text.slice(last));
    return host;
  }

  /** Resolve every ref chip under `host` to a live card title, batched. */
  function hydrateRefs(host: HTMLElement): void {
    const chips = [...host.querySelectorAll<HTMLElement>('.cd-asst-ref:not([data-resolved])')];
    if (chips.length === 0) return;
    const refs = chips.map((c) => ({
      type: c.dataset.refType ?? '',
      id: c.dataset.refId ?? '',
    }));
    void resolveAssistantRefs(refs)
      .then((cards) => {
        chips.forEach((chip, i) => {
          const card = cards[i];
          chip.dataset.resolved = 'true';
          if (!card || card.status !== 'live') {
            chip.dataset.state = 'missing';
            chip.title = 'Not found in the vault';
            return;
          }
          if (card.title) chip.textContent = card.title;
          chip.title = [card.title, card.subtitle].filter(Boolean).join(' — ');
        });
      })
      .catch(() => undefined);
  }

  // ── The route ────────────────────────────────────────────────────────

  function renderAssistant(): void {
    recordRoute({ kind: 'assistant' });
    clear();

    let threads: CentraidConversationSummary[] = [];
    let currentId: string | null = null;
    let msgs: AsstMsg[] = [];
    let busy = false;
    let abort: AbortController | null = null;
    let disposed = false;

    // This route owns the SSE stream, the message model, and the `richAnswer`
    // renderer, and pushes a derived snapshot into the React AssistantScreen on
    // every change.
    let reactUpdate: ((s: AssistantSnapshot) => void) | null = null;

    registerCleanup(() => {
      disposed = true;
      abort?.abort();
    });

    const main = el('div', { class: 'has-wall' });

    // ── React snapshot derivation ────────────────────────────────────────

    const toMsgDTO = (m: AsstMsg): AsstMsgDTO => {
      if (m.kind === 'user') return { kind: 'user', text: m.text };
      if (m.kind === 'tools') {
        const n = m.calls.length;
        const running = m.calls.some((c) => c.state === 'run');
        const failed = m.calls.filter((c) => c.state === 'error').length;
        const ms = m.calls.reduce((a, c) => a + (c.durationMs ?? 0), 0);
        const label = running
          ? 'querying the vault…'
          : `${n} ${n === 1 ? 'query' : 'queries'}${ms ? ` · ${ms}ms` : ''}${failed ? ` · ${failed} failed` : ''}`;
        return {
          kind: 'tools',
          label,
          calls: m.calls.map((c) => ({
            tool: c.tool,
            ...(c.sql ? { sql: c.sql } : {}),
            state: c.state,
            meta:
              c.state === 'error'
                ? (c.errorText ?? 'failed')
                : c.state === 'ok'
                  ? `${c.totalRows ?? '?'} rows${c.durationMs ? ` · ${c.durationMs}ms` : ''}`
                  : 'running…',
          })),
        };
      }
      if (m.streaming) return { kind: 'ai', streaming: true, text: m.text };
      return {
        kind: 'ai',
        streaming: false,
        html: richAnswer(m.text).outerHTML,
        error: Boolean(m.error),
      };
    };

    const buildSnapshot = (): AssistantSnapshot => ({
      threads: threads.map((t) => ({
        id: t.id,
        title: t.title || 'New conversation',
        timeLabel: relativeTime(new Date(t.updatedAt).toISOString()),
        active: t.id === currentId,
      })),
      empty: msgs.length === 0,
      busy,
      messages: msgs.map(toMsgDTO),
    });

    const pushReact = (): void => {
      if (reactUpdate) reactUpdate(buildSnapshot());
    };

    const setBusy = (b: boolean): void => {
      busy = b;
      pushReact();
    };

    async function deleteThread(id: string): Promise<void> {
      const t = threads.find((x) => x.id === id);
      const yes = await ctx.openConfirm({
        title: 'Delete conversation?',
        message: `“${t?.title || 'New conversation'}” will be removed from this vault's history.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!yes) return;
      await deleteConversation(ASSISTANT_APP_ID, id).catch(() => undefined);
      threads = threads.filter((x) => x.id !== id);
      if (currentId === id) await selectThread(null);
      else renderThreads();
    }

    function renderThreads(): void {
      pushReact();
    }

    function renderChat(): void {
      pushReact();
    }

    async function loadThreads(): Promise<void> {
      try {
        threads = await listConversations(ASSISTANT_APP_ID);
      } catch {
        threads = [];
      }
      if (!disposed) renderThreads();
    }

    async function selectThread(id: string | null): Promise<void> {
      abort?.abort();
      setBusy(false);
      currentId = id;
      msgs = [];
      renderThreads();
      if (!id) {
        renderChat();
        return;
      }
      try {
        const loaded = await loadConversation(ASSISTANT_APP_ID, id);
        if (disposed || currentId !== id) return;
        msgs = hydrate(loaded.messages);
      } catch (err) {
        if (disposed) return;
        msgs = [{ kind: 'ai', text: `Failed to load: ${String(err)}`, error: true }];
      }
      renderChat();
    }

    function hydrate(rows: Array<{ payload: CentraidConversationHistoryMessage }>): AsstMsg[] {
      const out: AsstMsg[] = [];
      for (const { payload } of rows) {
        if (payload.kind === 'user') out.push({ kind: 'user', text: payload.text ?? '' });
        else if (payload.kind === 'ai') {
          out.push({
            kind: 'ai',
            text: payload.text ?? '',
            ...(payload.error ? { error: true } : {}),
          });
        } else if (payload.kind === 'tool') {
          const call: AsstToolCall = {
            id: payload.id ?? String(out.length),
            tool: payload.tool ?? 'vault_sql',
            ...(payload.sql ? { sql: payload.sql } : {}),
            state: payload.state === 'ok' ? 'ok' : 'error',
            ...(payload.state !== 'ok' && payload.errorText
              ? { errorText: payload.errorText }
              : {}),
          };
          const result = payload.result as { totalRows?: number; durationMs?: number } | undefined;
          if (result && typeof result.totalRows === 'number') call.totalRows = result.totalRows;
          if (result && typeof result.durationMs === 'number') call.durationMs = result.durationMs;
          const last = out.at(-1);
          if (last?.kind === 'tools') last.calls.push(call);
          else out.push({ kind: 'tools', calls: [call] });
        }
      }
      return out;
    }

    async function submit(textArg?: string): Promise<void> {
      const text = (textArg ?? '').trim();
      if (!text || busy) return;
      if (!currentId) {
        try {
          const created = await createConversation(ASSISTANT_APP_ID, '');
          currentId = created.id;
        } catch (err) {
          showToast(err instanceof Error ? err.message : 'Could not start a conversation');
          return;
        }
      }
      const conversationId = currentId;
      msgs.push({ kind: 'user', text });
      renderChat();
      setBusy(true);
      abort = new AbortController();

      let ai: Extract<AsstMsg, { kind: 'ai' }> | null = null;
      const ensureAi = (): Extract<AsstMsg, { kind: 'ai' }> => {
        if (!ai) {
          ai = { kind: 'ai', text: '', streaming: true };
          msgs.push(ai);
          renderChat();
        }
        return ai;
      };
      const byCall = new Map<string, AsstToolCall>();

      const onEvent = (event: TurnStreamEvent): void => {
        if (disposed || currentId !== conversationId) return;
        switch (event.type) {
          case 'assistant.delta': {
            const msg = ensureAi();
            msg.text += event.delta;
            renderChat();
            return;
          }
          case 'tool.start': {
            const call: AsstToolCall = {
              id: event.toolCallId,
              tool: event.toolName,
              ...(event.sql ? { sql: event.sql } : {}),
              state: 'run',
            };
            byCall.set(event.toolCallId, call);
            // Tool activity always groups BEFORE the streaming answer text.
            const anchor = ai ? msgs.indexOf(ai) : msgs.length;
            const prev = msgs[anchor - 1];
            if (prev?.kind === 'tools') prev.calls.push(call);
            else msgs.splice(anchor, 0, { kind: 'tools', calls: [call] });
            renderChat();
            return;
          }
          case 'tool.result': {
            const call = byCall.get(event.toolCallId);
            if (!call) return;
            call.state = event.ok ? 'ok' : 'error';
            if (!event.ok) call.errorText = event.errorText ?? 'failed';
            const result = event.result as { totalRows?: number; durationMs?: number } | undefined;
            if (result && typeof result.totalRows === 'number') call.totalRows = result.totalRows;
            if (result && typeof result.durationMs === 'number')
              call.durationMs = result.durationMs;
            renderChat();
            return;
          }
          case 'final': {
            const msg = ensureAi();
            msg.text = msg.text || event.text;
            msg.streaming = false;
            renderChat();
            return;
          }
          case 'error': {
            msgs.push({ kind: 'ai', text: event.message, error: true });
            renderChat();
            return;
          }
          case 'assistant.start':
          case 'reasoning.delta':
          case 'phase':
          case 'usage':
          case 'webhooks':
          case 'aborted':
            // Stream telemetry the assistant page does not surface —
            // reasoning/usage/phase/webhook signals and the abort marker
            // carry no UI here.
            return;
          default:
            break;
        }
      };

      try {
        await streamAssistantTurn({ conversationId, message: text }, onEvent, abort.signal);
      } catch (err) {
        if (!disposed && !(err instanceof DOMException && err.name === 'AbortError')) {
          msgs.push({
            kind: 'ai',
            text: err instanceof Error ? err.message : String(err),
            error: true,
          });
        }
      } finally {
        if (!disposed && currentId === conversationId) {
          // `ai` is assigned inside the ensureAi closure, which TS's
          // narrowing can't see — read it back through the message list.
          const live = msgs.find(
            (m): m is Extract<AsstMsg, { kind: 'ai' }> => m.kind === 'ai' && m.streaming === true,
          );
          if (live) live.streaming = false;
          setBusy(false);
          renderChat();
          void loadThreads(); // pick up the auto-derived title
        }
      }
    }

    const dispose = requireReactBridge().mountAssistant(main, {
      suggestions: SUGGESTIONS,
      onReady: (update) => {
        reactUpdate = update;
        update(buildSnapshot());
      },
      onSend: (text) => void submit(text),
      onStop: () => {
        abort?.abort();
        setBusy(false);
      },
      onSelectThread: (id) => void selectThread(id),
      onDeleteThread: (id) => void deleteThread(id),
      hydrateRefs: (node) => hydrateRefs(node),
    });
    registerCleanup(dispose);
    mountShellPage('assistant', main);
    void loadThreads();
  }

  return { renderAssistant };
}
