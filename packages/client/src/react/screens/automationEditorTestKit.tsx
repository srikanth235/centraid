/**
 * Shared fixtures for the AutomationEditorScreen suites.
 *
 * `makeData` / `makeProps` and the `+ Add Trigger` driver were duplicated
 * verbatim across AutomationEditorScreen.test.tsx and
 * AutomationEditorTriggers.test.tsx. Two copies of a props factory drift as
 * the bridge contract grows, and the copy that is not updated keeps passing
 * against a shape the screen no longer receives.
 */

import { act } from 'react';
import { vi } from 'vitest';
import { button } from './domTestKit.js';
import type { AutomationEditorBridgeProps, AutomationEditorData } from '../screen-contracts.js';

export function makeData(over: Partial<AutomationEditorData> = {}): AutomationEditorData {
  return {
    automationId: null,
    consent: { grants: [], outbox: [], parked: [] },
    enabled: false,
    instructions: '',
    mode: 'create',
    name: '',
    triggers: [],
    webhook: null,
    ...over,
  };
}

export function makeProps(
  over: Partial<AutomationEditorBridgeProps> = {},
): AutomationEditorBridgeProps {
  return {
    loadData: vi.fn<AutomationEditorBridgeProps['loadData']>().mockResolvedValue(makeData()),
    onCancel: vi.fn<AutomationEditorBridgeProps['onCancel']>(),
    onCompile: vi.fn<AutomationEditorBridgeProps['onCompile']>().mockResolvedValue(null),
    onCopyWebhook: vi.fn<AutomationEditorBridgeProps['onCopyWebhook']>(),
    onDecideConsent: vi
      .fn<AutomationEditorBridgeProps['onDecideConsent']>()
      .mockResolvedValue(true),
    onDelete: vi.fn<AutomationEditorBridgeProps['onDelete']>().mockResolvedValue(false),
    onOpenRun: vi.fn<AutomationEditorBridgeProps['onOpenRun']>(),
    onOpenRuns: vi.fn<AutomationEditorBridgeProps['onOpenRuns']>(),
    loadCompileAttempts: vi
      .fn<AutomationEditorBridgeProps['loadCompileAttempts']>()
      .mockResolvedValue([]),
    loadTurnSteps: vi.fn<AutomationEditorBridgeProps['loadTurnSteps']>().mockResolvedValue([]),
    watchTurnSteps: vi
      .fn<AutomationEditorBridgeProps['watchTurnSteps']>()
      .mockResolvedValue({ settled: true, ok: true }),
    onTestRun: vi.fn<AutomationEditorBridgeProps['onTestRun']>().mockResolvedValue(null),
    onReadSource: vi
      .fn<AutomationEditorBridgeProps['onReadSource']>()
      .mockResolvedValue({ handler: null, manifest: null }),
    onRotateWebhook: vi
      .fn<AutomationEditorBridgeProps['onRotateWebhook']>()
      .mockResolvedValue(true),
    onSearchEntities: vi
      .fn<AutomationEditorBridgeProps['onSearchEntities']>()
      .mockResolvedValue([]),
    onSave: vi.fn<AutomationEditorBridgeProps['onSave']>().mockResolvedValue(true),
    onToggleEnabled: vi
      .fn<AutomationEditorBridgeProps['onToggleEnabled']>()
      .mockResolvedValue(true),
    ...over,
  };
}

/** Create layout: dashed "+ Add Trigger" then a menu item. */
export async function addTrigger(
  el: HTMLElement,
  kind: 'Schedule' | 'Data change' | 'Connector event',
): Promise<void> {
  await act(async () => {
    button(el, '+ Add Trigger').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await act(async () => {
    const item = [...el.querySelectorAll('[role="menuitem"]')].find(
      (b) => b.textContent === kind,
    ) as HTMLButtonElement;
    item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}
