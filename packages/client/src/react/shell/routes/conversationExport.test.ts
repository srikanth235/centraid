import { describe, expect, it } from 'vitest';
import {
  conversationToJson,
  conversationToMarkdown,
  exportFilename,
  type ExportableConversation,
} from './conversationExport.js';

const CONV: ExportableConversation = {
  id: 'c1',
  title: 'Quarterly budget review',
  createdAt: Date.UTC(2026, 6, 1),
  updatedAt: Date.UTC(2026, 6, 2),
  messageCount: 3,
  messages: [
    {
      idx: 0,
      createdAt: Date.UTC(2026, 6, 1, 9),
      payload: {
        kind: 'user',
        text: 'plan the budget',
        attachments: [{ hash: 'abc', mime: 'image/png', filename: 'chart.png', sizeBytes: 42 }],
      },
    },
    {
      idx: 1,
      createdAt: Date.UTC(2026, 6, 1, 9, 1),
      payload: {
        kind: 'tool',
        id: 't1',
        tool: 'vault_sql',
        sql: 'SELECT * FROM core_transaction',
        state: 'ok',
        result: { rows: 2 },
      },
    },
    {
      idx: 2,
      createdAt: Date.UTC(2026, 6, 1, 9, 2),
      payload: {
        kind: 'ai',
        text: 'Here is your budget.',
        turnId: 'turn-1',
        feedback: null,
        usage: { model: 'sonnet', inputTokens: 100, outputTokens: 20, costUsd: 0.0087 },
      },
    },
  ],
};

describe('conversationToMarkdown', () => {
  const md = conversationToMarkdown(CONV);
  it('renders a title header and role sections', () => {
    expect(md.startsWith('# Quarterly budget review\n')).toBe(true);
    expect(md).toContain('## 🧑 User');
    expect(md).toContain('## 🤖 Assistant');
    expect(md).toContain('## 🔧 Tool · vault_sql');
  });
  it('includes message text, tool SQL fence, attachments, and usage line', () => {
    expect(md).toContain('plan the budget');
    expect(md).toContain('```sql\nSELECT * FROM core_transaction\n```');
    expect(md).toContain('📎 chart.png (image/png, 42 bytes)');
    expect(md).toContain('model sonnet · 100 in · 20 out · $0.0087');
  });
});

describe('conversationToJson', () => {
  it('round-trips the structured transcript under an export envelope', () => {
    const parsed = JSON.parse(conversationToJson(CONV)) as {
      conversation: { id: string; title: string };
      messages: unknown[];
    };
    expect(parsed.conversation.id).toBe('c1');
    expect(parsed.conversation.title).toBe('Quarterly budget review');
    expect(parsed.messages).toHaveLength(3);
    expect(typeof (parsed as { exportedAt?: unknown }).exportedAt).toBe('string');
  });
});

describe('exportFilename', () => {
  it('slugs the title and stamps the date with the right extension', () => {
    expect(exportFilename(CONV, 'markdown')).toBe('quarterly-budget-review-2026-07-02.md');
    expect(exportFilename(CONV, 'json')).toBe('quarterly-budget-review-2026-07-02.json');
    expect(exportFilename({ ...CONV, title: '' }, 'markdown')).toMatch(/^conversation-.*\.md$/);
  });
});
