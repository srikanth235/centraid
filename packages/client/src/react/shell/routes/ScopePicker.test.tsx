import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MemberScope } from '../memberScope.js';
import ScopePicker from './ScopePicker.js';

// The picker is what let the space switcher go (#599, Decision 14): the target
// is named at the point of creation instead of being inherited from an ambient
// "you are in this space" mode.

let root: Root | null = null;
let host: HTMLElement | null = null;
describe('ScopePicker suite', () => {
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  function scope(over: Partial<MemberScope> = {}): MemberScope {
    return {
      id: 'v1',
      label: 'Personal',
      role: 'admin',
      canWrite: true,
      ...over,
    };
  }

  function render(el: React.ReactElement): HTMLElement {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(el));
    return host;
  }

  const MANY: MemberScope[] = [
    scope(),
    scope({ id: 'v2', label: 'Family', role: 'write' }),
    scope({ id: 'v3', label: 'Neighbours', role: 'read', canWrite: false }),
  ];

  describe(ScopePicker, () => {
    it('offers only spaces this member can write to — a read-only space is not a target', () => {
      const el = render(
        <ScopePicker scopes={MANY} value="v1" onChange={() => {}} label="New conversation in" />,
      );
      const options = [...el.querySelectorAll('option')].map((o) => o.textContent);
      expect(options).toHaveLength(2);
      expect(options.join(' ')).toContain('Personal');
      expect(options.join(' ')).toContain('Family');
      expect(options.join(' ')).not.toContain('Neighbours');
    });

    it('labels each option with ownership words, not the wire role', () => {
      const el = render(<ScopePicker scopes={MANY} value="v1" onChange={() => {}} label="In" />);
      const text = el.textContent ?? '';
      expect(text).toContain('Owner');
      expect(text).toContain('Member');
      expect(text).not.toMatch(/\badmin\b/u);
      expect(text).not.toMatch(/\bvault\b/iu);
    });

    it('collapses to a plain statement when there is only one writable space', () => {
      const el = render(
        <ScopePicker
          scopes={[
            scope(),
            scope({
              id: 'v3',
              label: 'Neighbours',
              role: 'read',
              canWrite: false,
            }),
          ]}
          value="v1"
          onChange={() => {}}
          label="Install into"
        />,
      );
      expect(el.querySelector('select')).toBeNull();
      expect(el.textContent).toContain('Install into');
      expect(el.textContent).toContain('Personal');
    });

    it('locks to a statement once the choice is made, however many spaces exist', () => {
      const el = render(
        <ScopePicker scopes={MANY} value="v2" onChange={() => {}} label="Reading" locked />,
      );
      expect(el.querySelector('select')).toBeNull();
      expect(el.textContent).toContain('Family');
    });

    it('reports a pick by scope id', () => {
      const onChange = vi.fn<React.ComponentProps<typeof ScopePicker>['onChange']>();
      const el = render(<ScopePicker scopes={MANY} value="v1" onChange={onChange} label="In" />);
      const select = el.querySelector('select')!;
      act(() => {
        select.value = 'v2';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(onChange).toHaveBeenCalledWith('v2');
    });

    it('renders nothing at all when no space is known', () => {
      const el = render(
        <ScopePicker scopes={[]} value={undefined} onChange={() => {}} label="In" />,
      );
      expect(el.textContent).toBe('');
    });
  });
});
