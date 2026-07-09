import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShellActions, ShellActionsProvider, useShellActions } from './actions.js';

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function renderWith(actions: ShellActions | null, Child: React.FC): void {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      actions ? (
        <ShellActionsProvider value={actions}>
          <Child />
        </ShellActionsProvider>
      ) : (
        <Child />
      ),
    );
  });
}

describe('ShellActions context', () => {
  it('exposes the provided actions to a consumer', () => {
    const showToast = vi.fn();
    const actions = { showToast } as unknown as ShellActions;
    const Consumer: React.FC = () => {
      useShellActions().showToast('hi');
      return null;
    };
    renderWith(actions, Consumer);
    expect(showToast).toHaveBeenCalledWith('hi');
  });

  it('throws when used outside a provider', () => {
    const Bad: React.FC = () => {
      useShellActions();
      return null;
    };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderWith(null, Bad)).toThrow(/ShellActionsProvider/);
    spy.mockRestore();
  });
});
