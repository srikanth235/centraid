import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { AutomationEditorBridgeProps } from '../screen-contracts.js';
import AutomationEditorScreen from './AutomationEditorScreen.js';

function props(onSearchEntities: AutomationEditorBridgeProps['onSearchEntities']) {
  return {
    loadData: vi.fn().mockResolvedValue({
      automationId: null,
      consent: { grants: [], outbox: [], parked: [] },
      enabled: false,
      instructions: '',
      mode: 'create',
      name: '',
      triggers: [],
      webhook: null,
    }),
    onCancel: vi.fn(),
    onCompile: vi.fn().mockResolvedValue(null),
    onCopyWebhook: vi.fn(),
    onDecideConsent: vi.fn().mockResolvedValue(true),
    onDelete: vi.fn().mockResolvedValue(false),
    onOpenRun: vi.fn(),
    onOpenRuns: vi.fn(),
    loadCompileAttempts: vi.fn().mockResolvedValue([]),
    loadTurnSteps: vi.fn().mockResolvedValue([]),
    watchTurnSteps: vi.fn().mockResolvedValue({ settled: true, ok: true }),
    onTestRun: vi.fn().mockResolvedValue(null),
    onReadSource: vi.fn().mockResolvedValue({ handler: null, manifest: null }),
    onRotateWebhook: vi.fn().mockResolvedValue(true),
    onSave: vi.fn().mockResolvedValue(true),
    onToggleEnabled: vi.fn().mockResolvedValue(true),
    onSearchEntities,
  } satisfies AutomationEditorBridgeProps;
}

it('inserts an anchor-grade row/field/span token', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSearchEntities = vi.fn().mockResolvedValue([
    {
      id: 'anchor-1',
      subtitle: 'schedule.task · title · anchored span',
      title: 'quarterly report',
      type: 'core.link_anchor',
    },
  ]);
  await act(async () => root.render(<AutomationEditorScreen {...props(onSearchEntities)} />));
  const instructions = container.querySelector('textarea') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(
    globalThis.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  act(() => {
    setter?.call(instructions, 'Notify me about @quarterly');
    instructions.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  await act(async () => {
    (container.querySelector('[role="option"]') as HTMLButtonElement).click();
  });
  expect(instructions.value).toBe('Notify me about @[core.link_anchor/anchor-1]');
  expect(container.querySelector('[aria-label="Tagged data"]')?.textContent).toContain(
    '@anchorrow · field · span',
  );
  act(() => root.unmount());
  container.remove();
});
