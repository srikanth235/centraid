/*
 * Conversation export (issue #420, Wave 3). Serializes an already-loaded
 * transcript (the shape `loadConversation` returns) to Markdown or JSON, then
 * triggers a browser download. Client-side by design: the transcript
 * reconstruction already exists on `GET .../sessions/<id>`, so export is a pure
 * serializer over data the shell has in hand — no new route, no attachment
 * bytes to stream (attachments are referenced by hash + URL, which the JSON
 * form preserves and the Markdown form notes inline).
 *
 * The two `*To*` functions are pure and unit-tested; `downloadConversation`
 * is the thin DOM side-effect that wraps them.
 */

/** The transcript shape handed to the serializers (what `loadConversation` returns). */
export interface ExportableConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  messages: Array<{
    idx: number;
    payload: CentraidConversationHistoryMessage;
    createdAt: number;
  }>;
}

export type ExportFormat = 'markdown' | 'json';

function isoDate(ms: number): string {
  try {
    return new Date(ms).toISOString();
  } catch {
    return String(ms);
  }
}

/** A filesystem-safe slug for the download filename, derived from the title. */
export function exportFilename(conv: ExportableConversation, format: ExportFormat): string {
  const base = (conv.title || 'conversation')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const stamp = isoDate(conv.updatedAt).slice(0, 10);
  return `${base || 'conversation'}-${stamp}.${format === 'markdown' ? 'md' : 'json'}`;
}

function fence(lang: string, body: string): string {
  // Escape a would-be closing fence in the body so the code block stays intact.
  const safe = body.replace(/```/g, '​```');
  return `\`\`\`${lang}\n${safe}\n\`\`\``;
}

/** Human-readable Markdown: role headings, timestamps, code fences for tools. */
export function conversationToMarkdown(conv: ExportableConversation): string {
  const lines: string[] = [];
  lines.push(`# ${conv.title || 'Untitled conversation'}`);
  lines.push('');
  lines.push(`_Exported ${isoDate(Date.now())} · started ${isoDate(conv.createdAt)}_`);
  lines.push('');
  for (const m of conv.messages) {
    const when = isoDate(m.createdAt);
    const p = m.payload;
    if (p.kind === 'user') {
      lines.push(`## 🧑 User · ${when}`);
      lines.push('');
      lines.push(p.text || '');
      if (p.attachments && p.attachments.length > 0) {
        lines.push('');
        for (const a of p.attachments) {
          lines.push(`- 📎 ${a.filename ?? a.hash} (${a.mime}, ${a.sizeBytes} bytes)`);
        }
      }
    } else if (p.kind === 'ai') {
      lines.push(`## 🤖 Assistant · ${when}${p.error ? ' · error' : ''}`);
      lines.push('');
      lines.push(p.text || '');
      if (p.usage) {
        const u = p.usage;
        const bits = [
          u.model ? `model ${u.model}` : '',
          u.inputTokens !== undefined ? `${u.inputTokens} in` : '',
          u.outputTokens !== undefined ? `${u.outputTokens} out` : '',
          u.costUsd !== undefined ? `$${u.costUsd.toFixed(4)}` : '',
        ].filter(Boolean);
        if (bits.length > 0) {
          lines.push('');
          lines.push(`_${bits.join(' · ')}_`);
        }
      }
    } else if (p.kind === 'notice') {
      lines.push(`## ⚠️ Notice · ${when}`);
      lines.push('');
      lines.push(`> ${p.text}`);
    } else if (p.kind === 'tool') {
      lines.push(`## 🔧 Tool · ${p.tool} · ${when} · ${p.state}`);
      lines.push('');
      if (p.sql) lines.push(fence('sql', p.sql));
      else if (p.args !== undefined) lines.push(fence('json', JSON.stringify(p.args, null, 2)));
      if (p.result !== undefined) {
        lines.push('');
        lines.push(fence('json', JSON.stringify(p.result, null, 2)));
      }
      if (p.errorText) {
        lines.push('');
        lines.push(`> ${p.errorText}`);
      }
    }
    lines.push('');
  }
  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

/** Structured JSON: the transcript DTO, wrapped with a small export envelope. */
export function conversationToJson(conv: ExportableConversation): string {
  return `${JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      conversation: {
        id: conv.id,
        title: conv.title,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        messageCount: conv.messageCount,
      },
      messages: conv.messages,
    },
    null,
    2,
  )}\n`;
}

export function serializeConversation(conv: ExportableConversation, format: ExportFormat): string {
  return format === 'markdown' ? conversationToMarkdown(conv) : conversationToJson(conv);
}

/**
 * Serialize + trigger a browser download. Kept thin over the pure serializers
 * so the DOM dependency stays isolated. The object URL is revoked on the next
 * tick, after the click has been dispatched.
 */
export function downloadConversation(conv: ExportableConversation, format: ExportFormat): void {
  const text = serializeConversation(conv, format);
  const mime = format === 'markdown' ? 'text/markdown' : 'application/json';
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = exportFilename(conv, format);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
