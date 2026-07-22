import { describe, expect, it } from 'vitest';
import { blockingSummary, pausedModuleStatuses } from './popup-state.js';

describe('popup connection state', () => {
  it('shows selected modules as paused and unselected modules as revoked', () => {
    const modules = pausedModuleStatuses(['locker', 'notes']);
    expect(modules.find((module) => module.id === 'locker')?.state).toBe('paused');
    expect(modules.find((module) => module.id === 'notes')?.state).toBe('paused');
    expect(modules.find((module) => module.id === 'tasks')?.state).toBe('revoked');
  });

  it('renders the one-line blocking approval count', () => {
    expect(blockingSummary(0)).toBe('No approvals waiting.');
    expect(blockingSummary(1)).toBe('1 approval waiting in Centraid.');
    expect(blockingSummary(3)).toBe('3 approvals waiting in Centraid.');
  });
});
